(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const active = new Set(['queued', 'submitting', 'running', 'cancelling', 'unknown']);
  const labels = { queued: '排队中', submitting: '正在提交', running: '执行中', cancelling: '正在停止', unknown: '正在核对', completed: '已完成', failed: '执行失败', cancelled: '已停止', rejected: '未开始' };
  const fileId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const fileTypes = /\.(pdf|docx|txt|md|markdown|csv|json|js|ts|tsx|jsx|py|html|css|svg|drawio|xml|yaml|yml|sql|log)$/i;
  let session, owner = '', tasks = [], selected = null, service = { available: false }, busy = false, fileBusy = false, attachments = [], syncing = false, pending = null, timer, lastHealth = 0, initialized = false, selectionVersion = 0, conversationReadVersion = 0;
  const conversations = new Map();
  let modelCatalog = [], chosenModel = null, modelCatalogReady = false;
  let historyAvailable = false, libraryAvailable = false, historyRecords = null, historyCursor = null, historyFilter = 'all', historyRead = 0, historyLoading = false, historyTimer;
  let libraryRows = [], libraryCursor = null, libraryRead = 0, libraryLoading = false, libraryTimer;
  const recentConversations = new Set();
  const validSelection = value => value && typeof value === 'object' && typeof value.providerId === 'string' && typeof value.modelId === 'string' && value.providerId.length <= 200 && value.modelId.length <= 300;
  const sameModel = (a, b) => validSelection(a) && validSelection(b) && a.providerId === b.providerId && a.modelId === b.modelId;
  const modelKey = value => JSON.stringify([value.providerId, value.modelId]);
  const sourceLabel = value => ({ platform: '平台模型', chatgpt: '共享 GPT', personal: '个人 API' })[value?.source] || '';
  const numberLabel = value => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  const modelLabel = value => [value.name || value.modelId, value.quotaPool === 'personal' ? '个人 API' : Number.isFinite(value.multiplier) ? 'x' + numberLabel(value.multiplier) : ''].filter(Boolean).join(' · ');
  function activeModel() {
    const task = currentTask(), selection = task ? task.modelSelection : pending?.modelSelection || chosenModel;
    if (!validSelection(selection)) return null;
    return { ...modelCatalog.find(model => sameModel(model, selection)), ...selection };
  }
  async function loadModels() {
    try {
      const data = await api('/api/agent/models');
      const models = (Array.isArray(data.models) ? data.models : []).filter(model => validSelection(model) && typeof model.name === 'string');
      modelCatalog = models; modelCatalogReady = true;
      if (!chosenModel || !models.some(model => sameModel(model, chosenModel))) {
        let saved; try { saved = JSON.parse(storage('localStorage', 'getItem', 'model') || 'null'); } catch {}
        chosenModel = models.find(model => sameModel(model, saved)) || models.find(model => sameModel(model, data.defaultSelection)) || models[0] || null;
      }
    } catch (error) {
      // Old pilot/demo servers have no model endpoint. The new quota mode must
      // fail closed until its authorized model list is available.
      if (service.billing === 'site-quota') { modelCatalogReady = false; throw error; }
      if (![404, 405].includes(error.status)) throw error;
    }
  }
  function renderModels(task, running) {
    const host = $('agentModelControl'), select = $('agentModelSelect'), model = activeModel();
    const enabled = service.billing === 'site-quota' || modelCatalog.length > 0;
    host.hidden = !enabled;
    if (!enabled) return;
    const choices = task || pending ? model ? [model] : [] : modelCatalog;
    const signature = JSON.stringify(choices.map(item => [item.providerId, item.modelId, item.name, item.multiplier, item.quotaPool, item.source]));
    if (select.dataset.content !== signature) {
      select.replaceChildren(); select.dataset.content = signature;
      for (const item of choices) {
        const option = document.createElement('option'); option.value = modelKey(item); option.textContent = modelLabel(item); select.append(option);
      }
      if (!choices.length) { const option = document.createElement('option'); option.value = ''; option.textContent = task ? '旧任务未记录模型' : modelCatalogReady ? '暂无可用模型' : '正在读取模型…'; select.append(option); }
    }
    if (model) select.value = modelKey(model);
    select.disabled = Boolean(task) || Boolean(pending) || busy || fileBusy || running || !modelCatalogReady;
    select.title = task ? '本次会话固定使用此模型。需要更换时，请点击“新任务”。' : '与对话页使用相同的模型权限和倍率';
    $('agentModelLock').hidden = !task;
    $('agentModelNote').textContent = task ? !model ? '旧任务未记录模型，请新建任务继续。' : service.billing === 'site-quota' && modelCatalogReady && !modelCatalog.some(item => sameModel(item, model)) ? '此会话模型目前不可用，请新建任务选择其他模型。' : '会话模型已固定，换模型请新建任务。' : !choices.length && modelCatalogReady ? '当前账号没有可用于智能任务的模型。' : '';
    $('agentModelNote').hidden = !$('agentModelNote').textContent;
  }
  function renderUsage(host, task) {
    const model = task.modelSelection, usage = task.usage, quota = task.quota;
    host.replaceChildren(); host.hidden = task.status !== 'queued' && !validSelection(model) && !usage && !quota;
    if (host.hidden) return;
    if (validSelection(model)) {
      const origin = document.createElement('div'); origin.className = 'agent-usage-source'; origin.textContent = [sourceLabel(model), modelLabel(model)].filter(Boolean).join(' · '); host.append(origin);
    }
    const charge = document.createElement('div'); charge.className = 'agent-usage-charge';
    if (task.status === 'queued') charge.textContent = '排队尚未开始，不消耗模型额度。';
    else if (!quota && task.status === 'cancelled' && usage?.complete === true && usage.calls === 0) charge.textContent = '未调用模型，不扣额度。';
    else if (quota?.status === 'pending') charge.textContent = '本轮用量核算中…';
    else if (quota?.pool === 'personal') charge.textContent = '本轮使用个人 API，不扣本站周额度。';
    else if (quota?.pool === 'free') charge.textContent = '本轮消耗：免费额度' + (Number.isFinite(quota.calls) ? ' ' + numberLabel(quota.calls) + ' 次' : '');
    else if (Number.isFinite(quota?.points)) charge.textContent = '本轮消耗：' + numberLabel(quota.points) + ' 点' + (quota.estimated ? '（含估算）' : '');
    else if (quota && quota.points === null) charge.textContent = '本轮用量核算中…';
    else if (active.has(task.status) && model) charge.textContent = '本轮用量核算中…';
    if (charge.textContent) host.append(charge);
    if (usage) {
      const details = [];
      if (Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0) details.push('输入 ' + numberLabel(usage.inputTokens));
      if (Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0) details.push('输出 ' + numberLabel(usage.outputTokens));
      if (Number.isSafeInteger(usage.cachedInputTokens) && usage.cachedInputTokens >= 0) details.push('缓存命中 ' + numberLabel(usage.cachedInputTokens));
      if (details.length) {
        const tokens = document.createElement('div'); tokens.className = 'agent-usage-tokens'; tokens.textContent = details.join(' · ') + ' token' + (usage.cachedInputTokens === undefined || usage.cachedInputTokens === null ? ' · 缓存数据未提供' : ''); host.append(tokens);
      }
      if (Number.isSafeInteger(usage.calls) && usage.calls > 0) {
        const calls = document.createElement('div'); calls.className = 'agent-usage-calls'; calls.textContent = '本轮累计 ' + numberLabel(usage.calls) + ' 次模型调用' + (usage.complete === false ? ' · 用量未完整返回' : ''); host.append(calls);
      }
    }
  }
  const storage = (kind, method, key, value) => { try { return window[kind][method]('diagram.agent.' + owner + '.' + key, value); } catch { return null; } };
  const turnsFor = conversationId => tasks.filter(task => task.conversationId === conversationId).sort((a, b) => (a.turnIndex || 1) - (b.turnIndex || 1) || a.createdAt - b.createdAt);
  const currentTurns = () => turnsFor(tasks.find(task => task.id === selected)?.conversationId);
  const currentTask = () => currentTurns().at(-1);
  const draftKey = () => 'draft.' + (currentTask()?.conversationId || 'new');
  const fileDraftKey = () => 'files.' + (currentTask()?.conversationId || 'new');
  function saveDraft() {
    if (!pending) {
      storage('sessionStorage', 'setItem', draftKey(), $('agentPrompt').value);
      storage('sessionStorage', 'setItem', fileDraftKey(), JSON.stringify(attachments));
    }
  }
  function restoreDraft() {
    $('agentPrompt').value = pending?.prompt || storage('sessionStorage', 'getItem', draftKey()) || '';
    const key = pending ? 'files.' + (pending.parentTaskId ? pending.conversationId : 'new') : fileDraftKey();
    try { attachments = JSON.parse(storage('sessionStorage', 'getItem', key) || '[]'); } catch { attachments = []; }
    if (!Array.isArray(attachments)) attachments = [];
    attachments = attachments.filter(file => file && fileId.test(file.id) && typeof file.name === 'string' && Number.isFinite(file.size)).slice(0, 5);
    if (pending) attachments = attachments.filter(file => pending.attachmentIds?.includes(file.id));
    else if (attachments.length) void verifyAttachments();
  }
  async function verifyAttachments() {
    const version = selectionVersion;
    fileBusy = true; $('agentUploadStatus').hidden = false; $('agentUploadStatus').textContent = '正在核对已添加的资料…'; render();
    try {
      const results = await Promise.all(attachments.map(async file => {
        try {
          const result = await api('/api/agent/files/' + file.id);
          if (result.file?.id !== file.id || typeof result.file.name !== 'string') throw Error('资料信息暂时无法确认。');
          return { file: result.file };
        } catch (error) { return [404, 410].includes(error.status) ? { expired: true } : { file, uncertain: true }; }
      }));
      if (version !== selectionVersion || pending) return;
      attachments = results.filter(result => result.file).map(result => result.file); saveDraft();
      if (results.some(result => result.expired)) $('agentNotice').textContent = '部分未发送资料已过期，请重新添加需要的文件。';
      else if (results.some(result => result.uncertain)) $('agentNotice').textContent = '暂时无法核对资料，已保留选择；恢复连接后再发送。';
    } finally { fileBusy = false; $('agentUploadStatus').hidden = true; $('agentUploadStatus').textContent = ''; render(); }
  }
  function clearSentDraft(body) {
    const suffix = body.parentTaskId ? body.conversationId : 'new';
    storage('sessionStorage', 'removeItem', 'draft.' + suffix); storage('sessionStorage', 'removeItem', 'files.' + suffix);
    attachments = [];
  }
  const sizeLabel = size => size >= 1024 * 1024 ? (size / 1024 / 1024).toFixed(1) + ' MB' : size >= 1024 ? Math.ceil(size / 1024) + ' KB' : size + ' B';
  function renderFiles(host, files = [], { taskId, removable = false, output = false } = {}) {
    const valid = (Array.isArray(files) ? files : []).filter(file => file && fileId.test(file.id) && typeof file.name === 'string');
    const signature = JSON.stringify([valid, removable && (busy || fileBusy || Boolean(pending))]);
    if (host.dataset.content === signature) return;
    host.replaceChildren(); host.dataset.content = signature;
    for (const file of valid) {
      const downloadable = !removable && (!output || fileId.test(taskId || ''));
      const card = document.createElement(downloadable ? 'a' : 'div'); card.className = 'agent-file-card' + (output ? ' output-file' : '');
      if (downloadable) { card.href = output ? '/api/agent/tasks/' + taskId + '/artifacts/' + file.id + '/download' : '/api/agent/files/' + file.id + '/download'; card.download = file.name; card.setAttribute('aria-label', (output ? '下载 ' : '下载原件 ') + file.name); }
      const icon = document.createElement('span'); icon.className = 'agent-file-icon'; icon.textContent = file.name.split('.').at(-1).slice(0, 6).toUpperCase(); icon.setAttribute('aria-hidden', 'true');
      const detail = document.createElement('span'); detail.className = 'agent-file-detail';
      const name = document.createElement('strong'); name.textContent = file.name; name.title = file.name;
      const meta = document.createElement('small'); meta.textContent = [Number.isFinite(file.size) ? sizeLabel(file.size) : '', file.pages ? file.pages + ' 页' : '', file.chars ? file.chars.toLocaleString('zh-CN') + ' 字符' : '', output ? '下载文件 ↓' : ''].filter(Boolean).join(' · ');
      detail.append(name, meta); card.append(icon, detail);
      if (removable) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'remove-file'; remove.textContent = '×'; remove.setAttribute('aria-label', '移除 ' + file.name); remove.disabled = busy || fileBusy || Boolean(pending); remove.onclick = () => removeAttachment(file.id); card.append(remove);
      }
      host.append(card);
    }
  }
  async function removeAttachment(id) {
    if (busy || fileBusy || pending) return;
    fileBusy = true; render();
    try {
      await api('/api/agent/files/' + id, { method: 'DELETE', body: '{}' });
      attachments = attachments.filter(file => file.id !== id); saveDraft(); $('agentNotice').textContent = '';
    } catch (error) {
      if ([404, 410].includes(error.status)) { attachments = attachments.filter(file => file.id !== id); saveDraft(); }
      else $('agentNotice').textContent = error.message;
    } finally { fileBusy = false; render(); }
  }
  function fileData(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(Error('未能读取“' + file.name + '”，请重新选择。')); reader.readAsDataURL(file);
    });
  }
  async function uploadFiles(files) {
    if (busy || fileBusy || pending || !service.filesAvailable || $('attachAgentFiles').disabled) return;
    const selectedFiles = [...files]; if (!selectedFiles.length) return;
    if (attachments.length + selectedFiles.length > 5) { $('agentNotice').textContent = '每次最多添加 5 份资料，请先移除部分文件。'; return; }
    if (selectedFiles.some(file => file.size > 5 * 1024 * 1024)) { $('agentNotice').textContent = '每份资料最多 5 MB，请缩小文件后再试。'; return; }
    if (selectedFiles.some(file => !fileTypes.test(file.name))) { $('agentNotice').textContent = '请选择 PDF、Word（.docx）或文本文件，暂不支持图片和其他格式。'; return; }
    fileBusy = true; selectionVersion++; $('agentNotice').textContent = ''; $('agentUploadStatus').hidden = false; render();
    try {
      for (const [index, file] of selectedFiles.entries()) {
        $('agentUploadStatus').textContent = '正在上传并读取 ' + (index + 1) + '/' + selectedFiles.length + '：' + file.name;
        const data = await fileData(file);
        const result = await api('/api/agent/files', { method: 'POST', body: JSON.stringify({ name: file.name, data }), timeoutMs: 90000 });
        if (!result.file || !fileId.test(result.file.id) || typeof result.file.name !== 'string') throw Error('资料上传结果无法确认，请刷新后重试。');
        attachments.push(result.file); saveDraft(); render();
      }
      $('agentNotice').textContent = attachments.reduce((total, file) => total + (file.chars || 0), 0) > 200000 ? '资料合计超过 20 万字符，请移除部分文件后发送。' : '资料已就绪，发送任务后助手即可读取。';
    } catch (error) { $('agentNotice').textContent = error.message || '资料未能上传，请稍后重试。'; }
    finally { fileBusy = false; $('agentUploadStatus').hidden = true; $('agentUploadStatus').textContent = ''; $('agentFileInput').value = ''; render(); void refresh(); }
  }
  async function loadConversation(conversationId, version = selectionVersion) {
    const readVersion = ++conversationReadVersion;
    const data = await api('/api/agent/conversations/' + conversationId);
    if (busy || fileBusy || readVersion !== conversationReadVersion || version !== selectionVersion || currentTask()?.conversationId !== conversationId) return;
    tasks = [...tasks.filter(task => task.conversationId !== conversationId), ...data.tasks];
    conversations.set(conversationId, data);
    const latest = data.tasks.at(-1);
    selected = latest?.id || null; storage('localStorage', 'setItem', 'selection', selected || '');
    render();
  }
  function select(id, rememberDraft = true) {
    if (rememberDraft) saveDraft(); selected = id; selectionVersion++;
    storage('localStorage', 'setItem', 'selection', id || ''); $('agentRemoveConfirm').hidden = true; $('agentRenameForm').hidden = true; restoreDraft(); render();
    const conversationId = currentTask()?.conversationId, version = selectionVersion;
    if (conversationId) void loadConversation(conversationId, version).catch(error => { if (version === selectionVersion) $('agentNotice').textContent = error.message; });
  }
  function rememberPending(body) { pending = body; if (body) storage('sessionStorage', 'setItem', 'pending', JSON.stringify(body)); else storage('sessionStorage', 'removeItem', 'pending'); }
  async function request(url, options = {}) {
    const { timeoutMs = 12000, ...fetchOptions } = options;
    const response = await fetch(url, { ...fetchOptions, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), headers: { 'Content-Type': 'application/json', ...(session?.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...fetchOptions.headers } });
    if (response.status === 401) { location.replace('/login.html?next=%2Fagent.html'); throw Error('登录已过期。'); }
    return response;
  }
  async function api(url, options) {
    const response = await request(url, options); const data = await response.json();
    if (!response.ok) { const error = Error(data.error?.message || '操作未完成，请稍后再试。'); error.status = response.status; throw error; }
    return data;
  }
  function taskGroups() {
    const groups = new Map();
    for (const task of tasks) { const group = groups.get(task.conversationId) || []; group.push(task); groups.set(task.conversationId, group); }
    return [...groups.values()].map(group => group.sort((a, b) => (a.turnIndex || 1) - (b.turnIndex || 1) || a.createdAt - b.createdAt));
  }
  function sidebarConversations() {
    const groups = taskGroups(), current = new Map(groups.map(group => [group[0].conversationId, group]));
    if (!historyAvailable || historyRecords === null) return groups.sort((a, b) => b.at(-1).createdAt - a.at(-1).createdAt).map(group => ({
      conversationId: group[0].conversationId, title: group[0].prompt, latestTaskId: group.at(-1).id, turns: group.length, status: group.at(-1).status, queuePosition: group.at(-1).queuePosition, updatedAt: group.at(-1).createdAt,
    }));
    const entries = [...historyRecords];
    if (!$('agentHistorySearch').value.trim() && historyFilter === 'all') for (const id of recentConversations) {
      const group = current.get(id);
      if (group && !entries.some(item => item.conversationId === id)) entries.unshift({ conversationId: id, title: group[0].prompt, latestTaskId: group.at(-1).id, turns: group.length, status: group.at(-1).status, updatedAt: group.at(-1).createdAt });
    }
    return entries.map(item => {
      const latest = current.get(item.conversationId)?.at(-1);
      return latest ? { ...item, latestTaskId: latest.id, status: latest.status, queuePosition: latest.queuePosition } : item;
    });
  }
  async function loadHistory({ append = false } = {}) {
    if (!historyAvailable) return;
    clearTimeout(historyTimer);
    const version = ++historyRead, params = new URLSearchParams({ limit: '20' });
    const query = $('agentHistorySearch').value.trim(); if (query) params.set('search', query);
    if (historyFilter === 'pinned') params.set('pinned', 'true');
    if (append && historyCursor) params.set('cursor', historyCursor);
    historyLoading = true; if (!append) historyCursor = null; $('agentHistoryMore').disabled = true;
    try {
      const data = await api('/api/agent/history?' + params);
      if (version !== historyRead) return;
      const rows = (Array.isArray(data.conversations) ? data.conversations : []).filter(item => fileId.test(item?.conversationId || '') && fileId.test(item?.latestTaskId || '') && typeof item.title === 'string');
      historyRecords = append ? [...(historyRecords || []), ...rows.filter(row => !historyRecords?.some(item => item.conversationId === row.conversationId))] : rows;
      historyCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      $('agentHistoryNotice').hidden = true; $('agentHistoryNotice').textContent = ''; render();
    } catch (error) {
      if (version !== historyRead) return;
      if ([404, 405].includes(error.status)) { historyAvailable = false; historyRecords = null; render(); }
      else { $('agentHistoryNotice').textContent = error.message || '历史暂时读取失败，请稍后刷新。'; $('agentHistoryNotice').hidden = false; }
    } finally { if (version === historyRead) { historyLoading = false; $('agentHistoryMore').disabled = false; } }
  }
  async function openConversation(conversationId) {
    if (busy || fileBusy || pending || !fileId.test(conversationId || '')) return;
    saveDraft(); const version = ++selectionVersion;
    try {
      const payload = await api('/api/agent/conversations/' + conversationId), data = payload.conversation || payload;
      if (version !== selectionVersion || busy || fileBusy || pending) return;
      tasks = [...tasks.filter(task => task.conversationId !== conversationId), ...data.tasks]; conversations.set(conversationId, data);
      selected = data.tasks.at(-1)?.id || null; storage('localStorage', 'setItem', 'selection', selected || ''); restoreDraft(); $('agentRemoveConfirm').hidden = true; $('agentRenameForm').hidden = true; render();
    } catch (error) { if (version === selectionVersion) $('agentNotice').textContent = error.message; }
  }
  async function changeConversation(patch) {
    const task = currentTask(); if (!task || busy || fileBusy || pending) return;
    const id = task.conversationId; selectionVersion++; busy = true; render();
    try {
      const payload = await api('/api/agent/conversations/' + id, { method: 'PATCH', body: JSON.stringify(patch) }), data = payload.conversation || payload;
      conversations.set(id, { ...(conversations.get(id) || {}), ...data });
      if (Array.isArray(data.tasks)) tasks = [...tasks.filter(item => item.conversationId !== id), ...data.tasks];
      if (historyRecords) historyRecords = historyRecords.map(item => item.conversationId === id ? { ...item, ...patch } : item);
      $('agentRenameForm').hidden = true; $('agentNotice').textContent = patch.pinned === true ? '这段对话及文件已长期保留。' : patch.pinned === false ? '已取消长期保留，将按普通历史保留时间清理。' : '对话名称已保存。';
      await loadHistory();
    } catch (error) { $('agentNotice').textContent = error.message; }
    finally { busy = false; render(); void refresh(); }
  }
  function renderLibrary() {
    const list = $('agentLibraryList'); list.replaceChildren();
    $('agentLibraryMore').hidden = !libraryCursor; $('agentLibraryMore').disabled = libraryLoading;
    if (!libraryRows.length) { const empty = document.createElement('p'); empty.className = 'library-empty'; empty.textContent = libraryLoading ? '正在读取文件…' : '没有找到文件。'; list.append(empty); return; }
    for (const file of libraryRows) {
      const row = document.createElement('div'); row.className = 'managed-file-row'; row.dataset.file = file.id;
      const icon = document.createElement('span'); icon.className = 'agent-file-icon'; icon.textContent = file.name.split('.').at(-1).slice(0, 6).toUpperCase();
      const detail = document.createElement('div'); detail.className = 'managed-file-detail';
      const name = document.createElement('strong'); name.textContent = file.name; name.title = file.name;
      const note = document.createElement('small'); note.textContent = [file.kind === 'artifact' ? '生成文件' : file.conversationId ? '上传资料' : '未发送资料', sizeLabel(file.size || 0), file.pinned || file.expiresAt === null && file.conversationId ? '长期保留' : file.expiresAt ? '保留至 ' + new Date(file.expiresAt).toLocaleDateString('zh-CN') : ''].filter(Boolean).join(' · ');
      detail.append(name, note); const actions = document.createElement('div'); actions.className = 'managed-file-actions';
      const route = file.kind === 'artifact' ? fileId.test(file.taskId || '') ? '/api/agent/tasks/' + file.taskId + '/artifacts/' + file.id + '/download' : null : '/api/agent/files/' + file.id + '/download';
      if (route) { const link = document.createElement('a'); link.href = route; link.download = file.name; link.textContent = '下载'; actions.append(link); }
      if (fileId.test(file.conversationId || '')) {
        const view = document.createElement('button'); view.type = 'button'; view.textContent = '查看对话'; view.onclick = () => { $('agentFilesDialog').close(); void openConversation(file.conversationId); }; actions.append(view);
      } else if (file.kind === 'upload') {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-draft'; remove.textContent = '删除'; remove.disabled = libraryLoading; remove.onclick = async () => {
          if (libraryLoading) return; remove.disabled = true;
          try { await api('/api/agent/files/' + file.id, { method: 'DELETE', body: '{}' }); attachments = attachments.filter(item => item.id !== file.id); saveDraft(); render(); await loadLibrary(); }
          catch (error) { $('agentLibraryNotice').textContent = error.message; remove.disabled = false; }
        }; actions.append(remove);
      }
      row.append(icon, detail, actions); list.append(row);
    }
  }
  async function loadLibrary({ append = false } = {}) {
    clearTimeout(libraryTimer);
    const version = ++libraryRead, params = new URLSearchParams({ limit: '20' }), query = $('agentLibrarySearch').value.trim(), kind = $('agentLibraryKind').value;
    if (query) params.set('search', query); if (kind) params.set('kind', kind); if (append && libraryCursor) params.set('cursor', libraryCursor);
    libraryLoading = true; if (!append) { libraryRows = []; libraryCursor = null; } $('agentLibraryNotice').textContent = ''; renderLibrary();
    try {
      const data = await api('/api/agent/files?' + params);
      if (version !== libraryRead || !$('agentFilesDialog').open) return;
      const rows = (Array.isArray(data.files) ? data.files : []).filter(item => fileId.test(item?.id || '') && typeof item.name === 'string' && ['upload', 'artifact'].includes(item.kind));
      libraryRows = append ? [...libraryRows, ...rows.filter(row => !libraryRows.some(item => item.id === row.id))] : rows;
      libraryCursor = typeof data.nextCursor === 'string' ? data.nextCursor : null;
      $('agentStorageUsage').textContent = Number.isFinite(data.usage?.usedBytes) && Number.isFinite(data.usage?.limitBytes) ? '已用 ' + sizeLabel(data.usage.usedBytes) + ' / ' + sizeLabel(data.usage.limitBytes) : '';
    } catch (error) { if (version === libraryRead) $('agentLibraryNotice').textContent = error.message || '文件暂时读取失败，请稍后重试。'; }
    finally { if (version === libraryRead) { libraryLoading = false; renderLibrary(); } }
  }
  function render() {
    const turns = currentTurns(), task = turns.at(-1);
    const conversation = conversations.get(task?.conversationId);
    const canContinue = Boolean(task && !task.summary && !active.has(task.status) && (task.output || task.artifacts?.length) && task.status !== 'rejected' && service.continuationAvailable && conversation?.canContinue && turns.length < 20);
    const running = tasks.some(item => active.has(item.status));
    const list = $('agentTaskList');
    const focused = document.activeElement?.dataset.task;
    list.replaceChildren();
    const entries = sidebarConversations();
    for (const item of entries) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'task-list-item'; button.dataset.task = item.latestTaskId;
      button.disabled = busy || fileBusy || Boolean(pending);
      button.setAttribute('aria-current', String(item.conversationId === task?.conversationId));
      const title = document.createElement('strong'); title.textContent = (item.title || '未命名对话').slice(0, 60);
      if (item.pinned) { const mark = document.createElement('i'); mark.className = 'pinned-mark'; mark.textContent = '◇'; title.prepend(mark); }
      const detail = document.createElement('small'); detail.textContent = (labels[item.status] || '历史对话') + (item.status === 'queued' && Number.isInteger(item.queuePosition) ? ' · 第 ' + item.queuePosition + ' 位' : '') + ' · ' + item.turns + ' 轮 · ' + new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
      button.append(title, detail); button.onclick = () => historyAvailable ? void openConversation(item.conversationId) : select(item.latestTaskId); list.append(button);
      if (focused === item.latestTaskId) button.focus({ preventScroll: true });
    }
    $('emptyTasks').hidden = entries.length > 0;
    $('emptyTasks').textContent = historyAvailable && ($('agentHistorySearch').value.trim() || historyFilter === 'pinned') ? historyFilter === 'pinned' ? '没有找到长期保留的对话。' : '没有找到匹配的对话。' : '完成一个想法，从这里开始。';
    $('agentHistoryControls').hidden = !historyAvailable;
    $('agentHistoryMore').hidden = !historyAvailable || !historyCursor;
    $('agentHistoryMore').disabled = historyLoading;
    $('manageAgentFiles').hidden = !libraryAvailable;
    $('manageAgentFiles').disabled = busy || fileBusy || Boolean(pending);
    $('agentHistoryAll').setAttribute('aria-pressed', String(historyFilter === 'all')); $('agentHistoryPinned').setAttribute('aria-pressed', String(historyFilter === 'pinned'));
    $('agentWelcome').hidden = Boolean(task); $('agentDetail').hidden = !task;
    if (task) {
      $('agentTaskTitle').textContent = conversation?.title || historyRecords?.find(item => item.conversationId === task.conversationId)?.title || turns[0].prompt.split('\n')[0].slice(0, 60);
      $('agentTurnCount').textContent = turns.length > 1 ? '连续对话 · ' + turns.length + ' 轮' : '支持接着结果继续追问';
      $('agentCurrentTurnLabel').textContent = '你 · 第 ' + turns.length + ' 轮';
      const previous = $('agentPreviousTurns'), history = turns.slice(0, -1);
      const signature = JSON.stringify(history.map(item => [item.id, item.prompt, item.output, item.status, item.attachments, item.artifacts, item.modelSelection, item.usage, item.quota]));
      if (previous.dataset.content !== signature) {
        previous.replaceChildren();
        history.forEach((item, index) => {
          const turn = document.createElement('section'); turn.className = 'agent-previous-turn';
          const label = document.createElement('div'); label.className = 'turn-label'; label.textContent = '你 · 第 ' + (index + 1) + ' 轮';
          const prompt = document.createElement('p'); prompt.className = 'task-prompt'; prompt.textContent = item.prompt;
          const documents = document.createElement('div'); documents.className = 'agent-file-list'; renderFiles(documents, item.attachments);
          const replyLabel = document.createElement('div'); replyLabel.className = 'turn-label'; replyLabel.textContent = '助手' + (item.status === 'completed' ? '' : ' · ' + labels[item.status]);
          const output = document.createElement('div'); output.className = 'agent-output'; output.innerHTML = window.DiagramMarkdown.render(item.output || '这一轮未生成正文。');
          const artifacts = document.createElement('div'); artifacts.className = 'agent-file-list agent-artifacts'; renderFiles(artifacts, item.artifacts, { taskId: item.id, output: true });
          const usage = document.createElement('div'); usage.className = 'agent-turn-usage'; renderUsage(usage, item);
          turn.append(label, prompt, documents, replyLabel, output, artifacts, usage); previous.append(turn);
        });
        previous.dataset.content = signature;
      }
      $('agentTaskPrompt').textContent = task.prompt;
      renderFiles($('agentTaskAttachments'), task.attachments);
      renderFiles($('agentArtifacts'), task.artifacts, { taskId: task.id, output: true });
      renderUsage($('agentTurnUsage'), task);
      $('agentTaskState').textContent = labels[task.status]; $('agentTaskState').dataset.state = task.status;
      $('agentTaskMessage').textContent = task.status === 'queued' ? '排队中' + (Number.isInteger(task.queuePosition) ? ' · 第 ' + task.queuePosition + ' 位' : '') + '，开始后会自动更新。' : task.summary && !task.output ? '正在读取任务内容…' : task.message; $('agentProgress').dataset.active = String(active.has(task.status));
      const output = $('agentOutput');
      if (output.dataset.content !== (task.output || '')) { output.innerHTML = window.DiagramMarkdown.render(task.output || ''); output.dataset.content = task.output || ''; }
      const expiresAt = conversation?.expiresAt || task.expiresAt;
      $('agentRetention').textContent = conversation?.pinned ? '这段对话及文件已长期保留，直到你主动清理。' : expiresAt ? (historyAvailable ? '历史及文件保留至 ' : '正文暂存至 ') + new Date(expiresAt).toLocaleString('zh-CN') + (historyAvailable ? '，也可选择长期保留。' : '，需要长期保留请下载。') : '任务由服务器持续处理，刷新页面后可继续查看。';
      $('cancelAgentTask').hidden = !active.has(task.status) || task.status === 'unknown'; $('cancelAgentTask').disabled = busy || task.status === 'cancelling';
      $('cancelAgentTask').textContent = task.status === 'queued' ? '取消排队' : '停止任务';
      $('recoverAgentTask').hidden = task.status !== 'unknown'; $('recoverAgentTask').disabled = busy;
      $('agentRecoveryHint').hidden = task.status !== 'unknown';
      $('copyAgentResult').hidden = !task.output; $('downloadAgentResult').hidden = !task.output; $('removeAgentTask').hidden = active.has(task.status);
      $('continueAgentTask').hidden = !canContinue; $('continueAgentTask').disabled = busy || fileBusy || Boolean(pending);
      $('downloadAgentResult').textContent = turns.length > 1 ? '下载对话' : '下载结果';
      $('pinAgentConversation').hidden = !historyAvailable || task.summary; $('renameAgentConversation').hidden = !historyAvailable || task.summary;
      $('pinAgentConversation').disabled = busy || fileBusy || Boolean(pending); $('renameAgentConversation').disabled = busy || fileBusy || Boolean(pending);
      $('pinAgentConversation').textContent = conversation?.pinned ? '取消长期保留' : '长期保留';
    }
    renderFiles($('agentDraftAttachments'), attachments, { removable: true });
    $('attachAgentFiles').hidden = !service.filesAvailable; $('agentFileHint').hidden = !service.filesAvailable;
    $('agentFileHint').textContent = attachments.reduce((total, file) => total + (file.chars || 0), 0) > 200000 ? '资料合计超过 20 万字符，请移除部分文件后发送。' : '支持 PDF、Word 和文本 · 最多 5 份，每份 5 MB · PDF 最多 50 页';
    $('attachAgentFiles').disabled = busy || fileBusy || Boolean(pending) || running || Boolean(task && !canContinue) || attachments.length >= 5;
    $('agentPrompt').disabled = Boolean(pending) || busy;
    renderModels(task, running);
    const modelUnavailable = service.billing === 'site-quota' && (!modelCatalogReady || !activeModel() || !modelCatalog.some(model => sameModel(model, activeModel())));
    $('submitAgentTask').disabled = busy || fileBusy || (!pending && (!service.available || modelUnavailable || running || Boolean(task && !canContinue) || !$('agentPrompt').value.trim() || attachments.length && (!service.filesAvailable || attachments.reduce((total, file) => total + (file.chars || 0), 0) > 200000)));
    $('submitAgentTask').textContent = pending ? '核对上次提交 ↻' : running ? '等待当前任务结束' : task ? '发送追问 ↑' : '提交任务 ↑';
    $('newAgentTask').disabled = busy || fileBusy || Boolean(pending);
    $('agentPrompt').placeholder = task ? '接着这段对话继续提问，或说明想修改的地方…' : '描述你的任务，说明希望得到什么结果…';
    $('agentConversationHint').textContent = !task ? '新任务 · 独立上下文' : task.status === 'queued' ? '正在等待执行，尚未调用模型，不消耗模型额度。' : active.has(task.status) ? '当前任务结束后，可在这里继续追问。' : task.summary ? '正在读取对话…' : canContinue ? '继续当前对话 · 将保留前面的上下文' : conversation?.continuationBlockedReason || (turns.length >= 20 ? '这段对话已达到 20 轮，请点击“新任务”继续。' : '当前对话暂不能继续追问，请点击“新任务”。');
    $('agentComposeHint').textContent = service.simulation ? '本地演示 · 不调用模型' : service.billing === 'site-quota' ? '与对话页共用额度' : service.billing === 'chatgpt-plan' ? 'ChatGPT 订阅 · Luna' : running ? '任务正在服务器处理中' : 'DSH · 独立执行';
  }
  async function refresh(force = false) {
    if (syncing || busy || fileBusy) return;
    syncing = true;
    const version = selectionVersion;
    try {
      const data = await api('/api/agent/tasks');
      if (busy || fileBusy || version !== selectionVersion) return;
      const loaded = new Map(tasks.map(task => [task.id, task]));
      tasks = data.tasks.map(summary => {
        const detail = loaded.get(summary.id);
        return detail && !detail.summary ? { ...detail, ...summary, prompt: detail.prompt, output: detail.output, summary: detail.updatedAt !== summary.updatedAt } : summary;
      });
      if (pending && tasks.some(item => item.id === pending.id)) {
        clearSentDraft(pending);
        selected = pending.id; selectionVersion++; storage('localStorage', 'setItem', 'selection', selected); rememberPending(null); $('agentPrompt').value = ''; $('agentNotice').textContent = '';
      }
      if (!initialized) {
        const saved = storage('localStorage', 'getItem', 'selection');
        selected = saved === null ? tasks[0]?.id || null : saved || null;
        if (selected && !tasks.some(task => task.id === selected)) selected = null;
        initialized = true; restoreDraft();
      }
      const conversationId = currentTask()?.conversationId;
      if (conversationId) await loadConversation(conversationId);
      if (force || Date.now() - lastHealth > 10000) {
        service = await api('/api/agent/status'); lastHealth = Date.now();
        historyAvailable = service.historyAvailable === true || Number.isFinite(service.historyRetentionDays);
        libraryAvailable = service.libraryAvailable === true || historyAvailable;
        await loadModels();
        $('agentConnection').textContent = service.simulation ? '本地演示环境：回复由本机模拟生成，可测试提交、刷新恢复与停止。' : service.message;
        $('connectionLabel').textContent = service.available ? '执行服务就绪' : service.connected ? '通信已连接' : '等待连接';
        $('connectionDot').dataset.ready = String(service.available);
        $('previewBadge').textContent = service.simulation ? '本地演示' : service.access === 'member-preview' ? '会员预览' : service.billing === 'chatgpt-plan' ? '本人专用' : '管理员预览';
        const retention = historyAvailable ? '历史默认保留 ' + (service.historyRetentionDays || 30) + ' 天，可选择长期保留。' : '会话结束后保留 24 小时。';
        $('agentFootnote').textContent = service.billing === 'site-quota' ? '模型权限和倍率与对话页一致，按本轮多步调用的累计用量计算。' + retention : service.billing === 'chatgpt-plan' ? '仅站长本人可用，使用你的 ChatGPT 订阅额度。' + retention : historyAvailable ? '任务与文件按账号独立保存。' + retention : '预览阶段仅供管理员测试，普通用户暂未开放。任务正文保留 24 小时。';
        $('agentCapacity').hidden = !service.queueAvailable;
        $('agentCapacity').textContent = service.queueAvailable ? (Number.isInteger(service.parallelLimit) ? '最多 ' + service.parallelLimit + ' 个任务同时处理' : '任务按顺序排队处理') + (service.queueSize > 0 ? ' · 当前 ' + service.queueSize + ' 个等待' : '') : '';
        if (historyAvailable && (force || historyRecords === null || historyRecords.length <= 20)) await loadHistory();
      }
      render();
    } catch (error) { $('agentNotice').textContent = error.message || '连接中断，正在尝试恢复；已有任务不会重复提交。'; }
    finally { syncing = false; clearTimeout(timer); const idle = historyAvailable && !pending && !tasks.some(task => active.has(task.status)); timer = setTimeout(() => refresh(), document.hidden || idle ? 8000 : 1500); }
  }
  $('agentForm').onsubmit = async event => {
    event.preventDefault(); if (busy || $('submitAgentTask').disabled) return;
    busy = true; $('agentNotice').textContent = '';
    if (!pending) {
      const parent = currentTask();
      const model = activeModel();
      rememberPending({ id: crypto.randomUUID(), conversationId: parent?.conversationId || crypto.randomUUID(), prompt: $('agentPrompt').value.trim(), ...(parent ? { parentTaskId: parent.id } : {}), ...(attachments.length ? { attachmentIds: attachments.map(file => file.id) } : {}), ...(model && (service.billing === 'site-quota' || modelCatalog.length) ? { modelSelection: { providerId: model.providerId, modelId: model.modelId } } : {}) });
    }
    render();
    try {
      const result = await api('/api/agent/tasks', { method: 'POST', body: JSON.stringify(pending) });
      clearSentDraft(pending);
      rememberPending(null); $('agentPrompt').value = '';
      tasks = [result.task, ...tasks.filter(item => item.id !== result.task.id)]; recentConversations.add(result.task.conversationId); select(result.task.id);
    } catch (error) {
      if ([400, 403, 404, 409, 410, 429, 503].includes(error.status)) rememberPending(null);
      $('agentNotice').textContent = pending ? '提交结果尚未确认。点击“核对上次提交”会沿用同一任务编号，不会重复执行。' : error.message;
    } finally { busy = false; render(); void refresh(); }
  };
  $('agentPrompt').addEventListener('input', () => { saveDraft(); render(); });
  $('agentModelSelect').onchange = () => {
    if (currentTask() || pending || busy || fileBusy) return;
    chosenModel = modelCatalog.find(model => modelKey(model) === $('agentModelSelect').value) || null;
    storage('localStorage', 'setItem', 'model', JSON.stringify(chosenModel ? { providerId: chosenModel.providerId, modelId: chosenModel.modelId } : null)); render();
  };
  $('attachAgentFiles').onclick = () => $('agentFileInput').click();
  $('agentFileInput').addEventListener('change', () => void uploadFiles($('agentFileInput').files));
  $('agentForm').addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); if (!$('attachAgentFiles').disabled && service.filesAvailable) $('agentForm').classList.add('files-dragover'); } });
  $('agentForm').addEventListener('dragleave', event => { if (!$('agentForm').contains(event.relatedTarget)) $('agentForm').classList.remove('files-dragover'); });
  $('agentForm').addEventListener('drop', event => { event.preventDefault(); $('agentForm').classList.remove('files-dragover'); if (event.dataTransfer?.files.length) void uploadFiles(event.dataTransfer.files); });
  $('agentPrompt').addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); $('agentForm').requestSubmit(); } });
  $('newAgentTask').onclick = () => { select(null); $('agentNotice').textContent = ''; $('agentPrompt').focus(); };
  $('continueAgentTask').onclick = () => { $('agentPrompt').focus(); $('agentPrompt').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); };
  $('refreshAgent').onclick = () => refresh(true);
  $('agentHistorySearch').addEventListener('input', () => { clearTimeout(historyTimer); historyRead++; historyCursor = null; historyLoading = true; render(); historyTimer = setTimeout(() => void loadHistory(), 250); });
  $('agentHistoryAll').onclick = () => { historyFilter = 'all'; render(); void loadHistory(); };
  $('agentHistoryPinned').onclick = () => { historyFilter = 'pinned'; render(); void loadHistory(); };
  $('agentHistoryMore').onclick = () => { if (!historyLoading && historyCursor) void loadHistory({ append: true }); };
  $('pinAgentConversation').onclick = () => { const task = currentTask(); if (task) void changeConversation({ pinned: !conversations.get(task.conversationId)?.pinned }); };
  $('renameAgentConversation').onclick = () => { $('agentConversationTitle').value = $('agentTaskTitle').textContent; $('agentRenameForm').hidden = false; $('agentConversationTitle').focus(); $('agentConversationTitle').select(); };
  $('dismissAgentTitle').onclick = () => { $('agentRenameForm').hidden = true; };
  $('saveAgentTitle').onclick = () => { const title = $('agentConversationTitle').value.trim(); if (!title) { $('agentNotice').textContent = '请输入对话名称。'; return; } void changeConversation({ title }); };
  $('agentConversationTitle').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('saveAgentTitle').click(); } else if (event.key === 'Escape') $('agentRenameForm').hidden = true; });
  $('manageAgentFiles').onclick = () => { if (!$('agentFilesDialog').open) $('agentFilesDialog').showModal(); void loadLibrary(); };
  $('closeAgentFiles').onclick = () => $('agentFilesDialog').close();
  $('agentFilesDialog').addEventListener('close', () => { libraryRead++; libraryLoading = false; clearTimeout(libraryTimer); });
  $('agentLibrarySearch').addEventListener('input', () => { clearTimeout(libraryTimer); libraryRead++; libraryCursor = null; libraryRows = []; libraryLoading = true; renderLibrary(); libraryTimer = setTimeout(() => void loadLibrary(), 250); });
  $('agentLibraryKind').onchange = () => void loadLibrary();
  $('agentLibraryMore').onclick = () => { if (!libraryLoading && libraryCursor) void loadLibrary({ append: true }); };
  document.querySelectorAll('[data-prompt]').forEach(button => button.onclick = () => { if (busy || pending) return; $('agentPrompt').value = button.dataset.prompt; $('agentPrompt').focus(); render(); });
  $('cancelAgentTask').onclick = async () => {
    const id = currentTask()?.id; selectionVersion++; busy = true; render();
    try { const data = await api('/api/agent/tasks/' + id + '/cancel', { method: 'POST', body: '{}' }); tasks = tasks.map(task => task.id === id ? data.task : task); $('agentNotice').textContent = ''; }
    catch (error) { $('agentNotice').textContent = error.message || '停止请求未获确认，请等待状态核对。'; }
    finally { busy = false; render(); void refresh(); }
  };
  $('recoverAgentTask').onclick = async () => {
    const id = currentTask()?.id; selectionVersion++; busy = true; $('agentNotice').textContent = '正在核对并恢复任务状态…'; render();
    try {
      const data = await api('/api/agent/tasks/' + id + '/recover', { method: 'POST', body: '{}', timeoutMs: 35000 });
      tasks = tasks.map(task => task.id === id ? data.task : task);
      $('agentNotice').textContent = data.task.status === 'unknown' ? '暂未确认任务已经停止，系统会继续核对。' : '状态已恢复，可以继续使用。';
    } catch (error) { $('agentNotice').textContent = error.message || '状态核对尚未完成，请稍后再试。'; }
    finally { busy = false; render(); void refresh(); }
  };
  $('copyAgentResult').onclick = async () => { try { await navigator.clipboard.writeText(currentTask()?.output || ''); $('agentNotice').textContent = '结果已复制。'; } catch { $('agentNotice').textContent = '浏览器未允许复制，请使用下载结果。'; } };
  $('downloadAgentResult').onclick = () => {
    const turns = currentTurns(), task = turns.at(-1); if (!task) return;
    const content = turns.length > 1 ? turns.map((item, index) => '## 第 ' + (index + 1) + ' 轮\n\n### 你\n\n' + item.prompt + '\n\n### 助手\n\n' + item.output).join('\n\n---\n\n') : task.output;
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = '任务结果-' + task.id.slice(0, 8) + '.md'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('removeAgentTask').onclick = () => { $('agentRemoveConfirm').hidden = false; $('confirmRemoveAgent').focus(); };
  $('dismissRemoveAgent').onclick = () => { $('agentRemoveConfirm').hidden = true; };
  $('confirmRemoveAgent').onclick = async () => {
    const conversationId = currentTask()?.conversationId; busy = true; $('confirmRemoveAgent').disabled = true;
    try {
      await api('/api/agent/conversations/' + conversationId, { method: 'DELETE', body: '{}' });
      storage('sessionStorage', 'removeItem', 'draft.' + conversationId); storage('sessionStorage', 'removeItem', 'files.' + conversationId); conversations.delete(conversationId);
      recentConversations.delete(conversationId); if (historyRecords) historyRecords = historyRecords.filter(item => item.conversationId !== conversationId);
      $('agentPrompt').value = ''; attachments = []; tasks = tasks.filter(task => task.conversationId !== conversationId); select(null, false); $('agentNotice').textContent = '整段对话、资料及生成文件已清理。';
    }
    catch (error) { $('agentNotice').textContent = error.message; }
    finally { busy = false; $('confirmRemoveAgent').disabled = false; render(); }
  };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(true); });
  (async () => {
    try {
      session = await (await request('/api/auth/session')).json();
      if (session.mode !== 'local' && !session.user) { location.replace('/login.html?next=%2Fagent.html'); return; }
      owner = session.user?.id || 'local';
      try { pending = JSON.parse(storage('sessionStorage', 'getItem', 'pending') || 'null'); } catch { rememberPending(null); }
      if (pending && (!pending.id || !pending.conversationId || typeof pending.prompt !== 'string' || pending.parentTaskId !== undefined && typeof pending.parentTaskId !== 'string' || pending.attachmentIds !== undefined && (!Array.isArray(pending.attachmentIds) || pending.attachmentIds.length > 5 || pending.attachmentIds.some(id => !fileId.test(id))) || pending.modelSelection !== undefined && !validSelection(pending.modelSelection))) rememberPending(null);
      if (pending) $('agentPrompt').value = pending.prompt;
      if (session.user) window.DiagramAccountMenu?.mount({ host: $('agentAccountMount'), session, request });
      if (!session.user || session.user.role !== 'admin') document.querySelector('.agent-topbar a[href="/admin.html"]').hidden = true;
      await refresh(true);
    } catch (error) { $('agentNotice').textContent = error.message || '页面初始化失败，请刷新重试。'; }
  })();
})();
