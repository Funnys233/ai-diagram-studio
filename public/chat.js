(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const feed = $('chatFeed');
  const input = $('chatInput');
  const form = $('chatForm');
  const sendButton = $('sendBtn');
  const modelSelect = $('modelSelect');
  const welcomeHtml = $('welcome').innerHTML;
  const Vision = window.DiagramVision;
  const Capabilities = window.DiagramCapabilities;
  const Documents = window.DiagramDocuments;
  const TurnUsage = window.DiagramTurnUsage;
  const History = window.DiagramChatHistory;
  const storagePrefix = 'diagramai.pureChat.v1.';
  let csrf = '';
  let localMode = false;
  let account = null;
  let chats = [];
  let current = null;
  let activeController = null;
  let activeReply = null;
  let replySaveTimer = null;
  let pageLeaving = false;
  let selected = null;
  let accountMenu = null;
  let quotaTimer = null;
  let multimodal = false;
  let attachments = [];
  let documentAttachments = [];
  let importingDocuments = false;
  let documentController = null;
  let importingImages = false;
  let savingPreference = false;
  let pendingReasoningEffort;
  let detectController = null;
  let attachmentVersion = 0;
  let historyDb = null;
  let saveQueue = Promise.resolve();
  let deletedChats = {};
  const acknowledgedTasks = new Set(), acknowledgingTasks = new Set();

  function setStatus(text = '', kind = '') { $('composerStatus').textContent = text; $('composerStatus').hidden = !text; $('composerStatus').classList.toggle('success', kind === 'success'); $('composerStatus').classList.toggle('info', kind === 'info'); }
  function openHistoryDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('diagramai.pureChat', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('accounts');
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('对话存储暂不可用'));
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); historyDb = null; }; resolve(db); };
    });
  }
  function saveChats() {
    const key = account.id; const snapshot = structuredClone(chats);
    const deletionKey = storagePrefix + 'deleted.' + key, deletions = { ...deletedChats };
    let committed;
    const merge = (stored = [], storedDeleted = {}) => {
      for (const row of stored) if (deletions[row.id] && !storedDeleted[row.id] && row.messages?.some(item => item.pending && item.taskId)) {
        throw Object.assign(new Error('此对话正在另一个页面生成，请先取消或等待完成，再删除。'), { code: 'chat-running' });
      }
      const deleted = History.mergeDeleted(storedDeleted, deletions);
      return { rows: History.merge(snapshot, stored, deleted), deleted };
    };
    const write = () => new Promise((resolve, reject) => {
      if (!historyDb) {
        try {
          committed = merge(JSON.parse(localStorage.getItem(storagePrefix + key) || '[]'), JSON.parse(localStorage.getItem(deletionKey) || '{}'));
          localStorage.setItem(deletionKey, JSON.stringify(committed.deleted));
          localStorage.setItem(storagePrefix + key, JSON.stringify(committed.rows)); resolve(true);
        } catch (error) { reject(error); }
        return;
      }
      const transaction = historyDb.transaction('accounts', 'readwrite');
      const store = transaction.objectStore('accounts'), previous = store.get(key), previousDeleted = store.get(deletionKey);
      previousDeleted.onsuccess = () => {
        try { committed = merge(previous.result, previousDeleted.result); store.put(committed.rows, key); store.put(committed.deleted, deletionKey); }
        catch (error) { transaction.abort(); reject(error); }
      };
      transaction.oncomplete = () => { try { localStorage.removeItem(storagePrefix + key); } catch { /* 已保存在 IndexedDB */ } resolve(true); };
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    saveQueue = saveQueue.catch(() => {}).then(() => !historyDb && typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('diagramai.chat-history.' + key, write) : write())
    .catch(error => { setStatus(error?.code === 'chat-running' ? error.message : '浏览器无法保存对话，本次仍可继续；刷新后可能无法恢复。'); return false; }).then(saved => {
      if (saved) { deletedChats = History.mergeDeleted(deletedChats, committed.deleted); releaseSavedTasks(committed.rows); }
      return saved;
    });
    return saveQueue;
  }
  function releaseSavedTasks(rows) {
    for (const item of rows.flatMap(thread => thread.messages || [])) {
      const id = item.taskId;
      if (!id || item.pending || !item.taskAccepted || acknowledgedTasks.has(id) || acknowledgingTasks.has(id)) continue;
      acknowledgingTasks.add(id);
      void taskJson('/api/conversation/tasks/' + id + '/ack', {}, AbortSignal.timeout(10000))
        .then(() => acknowledgedTasks.add(id)).catch(error => { if ([404,410].includes(error.httpStatus)) acknowledgedTasks.add(id); })
        .finally(() => acknowledgingTasks.delete(id));
    }
  }

  // A small synchronous journal covers navigation before an IndexedDB write commits.
  function checkpointReply() {
    if (!account || !activeReply || !chats.includes(activeReply.thread)) return;
    try { localStorage.setItem(storagePrefix + 'reply.' + account.id, JSON.stringify({ threadId: activeReply.thread.id, item: activeReply.item })); }
    catch { setStatus('浏览器无法保存最新回复，离开前请复制需要的内容。'); }
  }
  function scheduleReplySave() {
    if (replySaveTimer !== null) return;
    replySaveTimer = setTimeout(() => { replySaveTimer = null; checkpointReply(); if (activeReply) persist(activeReply.thread); }, 200);
  }
  function finishReplySave(assistant) {
    clearTimeout(replySaveTimer); replySaveTimer = null;
    checkpointReply(); persist(assistant.thread);
    const key = storagePrefix + 'reply.' + account.id, id = assistant.item.id, updatedAt = assistant.item.updatedAt;
    void saveQueue.then(savedOk => {
      if (!savedOk) return;
      try { const saved = JSON.parse(localStorage.getItem(key) || 'null'); if (saved?.item?.id === id && saved.item.updatedAt === updatedAt) localStorage.removeItem(key); } catch { /* 保留可恢复的记录 */ }
    });
    return saveQueue;
  }

  const markdown = window.DiagramMarkdown.render;
  const interruptedEmptyNotice = '上次请求已中断，没有可恢复的回复正文。请重新发送原问题。';
  const isContinuation = text => /^(?:继续(?:生成|回答|输出|写)?|接着(?:写|说)?|续写)[。.!！\s]*$/u.test(text.trim());
  function originalQuestion(thread, assistant) {
    const index = thread?.messages.indexOf(assistant) ?? -1;
    return index < 0 ? null : thread.messages.slice(0, index).findLast(item => item.role === 'user' && typeof item.content === 'string' && !isContinuation(item.content)) || null;
  }
  function unansweredQuestion(thread) {
    const last = thread?.messages.findLast(item => item.role === 'assistant');
    return last && !last.content?.trim() ? originalQuestion(thread, last) : null;
  }
  function historyFor(thread, includeImages) {
    return thread.messages.filter(item => (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim()).slice(-20).map(item => {
      const suffix = item.role === 'assistant' && (item.failed || item.pending) ? '\n[以上是中断前的部分回复，尚未完成。]' : '';
      const limit = 4000 - suffix.length;
      const marker = '\n[中间内容已省略，保留开头和末尾以供继续。]\n';
      const content = item.content.length <= limit ? item.content : item.content.slice(0, 1000) + marker + item.content.slice(-(limit - 1000 - marker.length));
      return { role: item.role, content: content + suffix, ...(includeImages && item.images?.length ? { images: item.images } : {}) };
    });
  }
  function recoverThread(thread) {
    // Older interrupted first turns saved the upload on the user message only.
    // An explicit [] means the user removed reference context; never re-add it.
    if (!Array.isArray(thread.documents)) {
      const documents = thread.messages.filter(item => item.role === 'user').flatMap(item => item.documents || []);
      if (documents.length) try { thread.documents = mergedDocuments([], documents); } catch { /* Invalid legacy attachments are not sent. */ }
    }
    for (const item of thread.messages) {
      if (item.role === 'assistant' && item.pending && /^[a-f0-9-]{36}$/.test(item.taskId || '')) continue;
      if (item.role === 'assistant' && (item.pending || !item.content?.trim() && !item.notice)) {
        item.pending = false; item.failed = true;
        item.notice = item.content?.trim() ? '上次生成已中断，以上是已保存的回复。' : interruptedEmptyNotice;
      } else if (item.role === 'assistant' && !item.content?.trim() && item.notice === '上次回复未保存到内容，请重新发送。') item.notice = interruptedEmptyNotice;
    }
  }
  function fillOriginalQuestion(question) {
    input.value = question.content; resizeInput(); input.focus();
    setStatus('上一轮没有生成回复正文，已恢复原问题。请核对问题、参考文档和模型后发送；重新请求会重新计算用量。', 'info');
  }
  function addRecoveryAction(node, item, thread) {
    const question = originalQuestion(thread, item);
    if (!question || item.content?.trim()) return;
    const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'quiet-button'; restore.textContent = '恢复原问题'; restore.style.alignSelf = 'flex-start';
    restore.onclick = () => {
      if (activeController || importingDocuments || importingImages) { setStatus('请先结束当前操作，再恢复原问题。'); return; }
      if (input.value.trim() && !isContinuation(input.value) && input.value !== question.content) { setStatus('输入框中已有新内容，请先保留或清空，再恢复原问题。'); return; }
      fillOriginalQuestion(question);
    };
    node.appendChild(restore);
  }
  function persist(target = current) {
    if (!account) return;
    try {
      if (target?.messages?.length && !chats.some(chat => chat.id === target.id)) chats.push(target);
      const existing = new Map(chats.map(thread => [thread.id, thread]));
      chats = History.merge(chats, [], deletedChats).map(row => {
        const live = existing.get(row.id), messages = new Map(live.messages.filter(item => item.id).map(item => [item.id, item]));
        return Object.assign(live, row, { messages: row.messages.map(item => messages.get(item.id) || item) });
      });
      saveChats();
    } catch { /* 浏览器存储不可用时仍可继续本次对话 */ }
    renderList();
  }
  async function loadChats() {
    try {
      try { historyDb = await openHistoryDb(); } catch { historyDb = null; }
      let parsed, storedDeleted;
      if (historyDb) parsed = await new Promise((resolve, reject) => {
        const store = historyDb.transaction('accounts').objectStore('accounts'), request = store.get(account.id), removed = store.get(storagePrefix + 'deleted.' + account.id);
        removed.onsuccess = () => { storedDeleted = removed.result; resolve(request.result); };
        request.onerror = removed.onerror = () => reject(request.error || removed.error);
      });
      if (parsed === undefined) parsed = JSON.parse(localStorage.getItem(storagePrefix + account.id) || '[]');
      deletedChats = History.mergeDeleted(storedDeleted, JSON.parse(localStorage.getItem(storagePrefix + 'deleted.' + account.id) || '{}'));
      chats = History.merge(Array.isArray(parsed) ? parsed : [], [], deletedChats);
      try {
        const checkpoint = JSON.parse(localStorage.getItem(storagePrefix + 'reply.' + account.id) || 'null');
        const thread = chats.find(chat => chat.id === checkpoint?.threadId), saved = checkpoint?.item;
        const item = thread?.messages.find(message => message.id && message.id === saved?.id);
        if (item?.role === 'assistant' && saved?.role === 'assistant' && typeof saved.content === 'string' && (item.pending || (saved.updatedAt || 0) > (item.updatedAt || 0))) Object.assign(item, saved);
      } catch { /* 旧版或不可用的应急记录不影响正常历史 */ }
      for (const thread of chats) recoverThread(thread);
    } catch { chats = []; }
  }
  function newThread() {
    documentController?.abort(); documentAttachments = [];
    attachments = []; attachmentVersion++; renderAttachments(); setStatus();
    input.value = ''; resizeInput();
    current = { id: crypto.randomUUID(), title: '', updatedAt: Date.now(), metadataUpdatedAt: Date.now(), messages: [] };
    renderConversation(); renderList(); renderDocumentContext(); input.focus(); closeMobileHistory();
  }
  function setCurrent(id) {
    documentController?.abort(); documentAttachments = [];
    attachments = []; attachmentVersion++; renderAttachments(); setStatus();
    current = chats.find(chat => chat.id === id) || null;
    renderConversation(); renderList(); renderDocumentContext(); closeMobileHistory();
  }
  function renderList() {
    const list = $('conversationList'); list.replaceChildren();
    const recent = chats.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    if (!recent.length) {
      const empty = document.createElement('div'); empty.className = 'empty-history'; empty.textContent = '新对话会保存在这里'; list.appendChild(empty); return;
    }
    for (const chat of recent) {
      const row = document.createElement('div'); row.className = 'conversation-item' + (current?.id === chat.id ? ' active' : '');
      const open = document.createElement('button'); open.type = 'button'; open.className = 'conversation-open'; open.textContent = chat.title || '新对话'; open.title = open.textContent; open.onclick = () => setCurrent(chat.id);
      const del = document.createElement('button'); del.type = 'button'; del.className = 'conversation-delete'; del.textContent = '×'; del.title = '删除对话'; del.setAttribute('aria-label', '删除对话：' + (chat.title || '新对话')); del.onclick = async () => {
        if (chat.messages.some(item => item.pending && item.taskId)) { setStatus('请先取消或等待此对话生成完成，再删除。', 'info'); return; }
        del.disabled = true; const previous = deletedChats[chat.id]; deletedChats[chat.id] = Date.now();
        if (!await saveChats()) { if (previous) deletedChats[chat.id] = previous; else delete deletedChats[chat.id]; del.disabled = false; return; }
        chats = chats.filter(item => !deletedChats[item.id]); if (current && deletedChats[current.id]) current = null;
        renderList(); renderConversation(); renderDocumentContext();
      };
      row.append(open, del); list.appendChild(row);
    }
  }
  function renderConversation() {
    feed.replaceChildren();
    if (!current || !current.messages.length) {
      const welcome = document.createElement('div'); welcome.className = 'welcome';
      welcome.innerHTML = welcomeHtml;
      feed.appendChild(welcome); return;
    }
    const inner = document.createElement('div'); inner.className = 'feed-inner';
    for (const item of current.messages) {
      const node = makeMessage(item.role, item.content, item.source, item.images, item.documents, item.turnUsage, item);
      if (activeReply?.item === item) {
        activeReply.progress.stop(); activeReply.node = node; activeReply.body = node.querySelector('.message-body');
        activeReply.progress = renderProgress(node); if (activeReply.phase) activeReply.progress.phase(activeReply.phase);
      }
      inner.appendChild(node); reconcileTurnUsage(item, node, current);
    }
    feed.appendChild(inner); feed.scrollTop = feed.scrollHeight;
  }
  function makeMessage(role, text, source, images = [], documents = [], turnUsage = null, item = null) {
    const wrap = document.createElement('article'); wrap.className = `message ${role}`;
    if (item?.id) wrap.dataset.messageId = item.id;
    const label = document.createElement('div'); label.className = 'message-role'; label.textContent = role === 'user' ? '你' : '助手';
    const body = document.createElement('div'); body.className = 'message-body';
    if (role === 'assistant') body.innerHTML = markdown(text); else body.textContent = text;
    wrap.append(label, body);
    if (item?.notice) { const note = document.createElement('div'); note.className = 'message-error'; note.textContent = item.notice; wrap.appendChild(note); addRecoveryAction(wrap, item, current); }
    if (role === 'user' && images.length) {
      const row = document.createElement('div'); row.className = 'message-images';
      for (const [index, data] of images.entries()) {
        if (typeof data !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(data)) continue;
        const image = document.createElement('img'); image.src = data; image.alt = `发送的图片 ${index + 1}`; window.DiagramImageViewer?.bind(image); row.appendChild(image);
      }
      wrap.appendChild(row);
    }
    if (role === 'user' && documents.length) {
      const row = document.createElement('div'); row.className = 'message-documents';
      for (const document of documents) row.appendChild(documentCard(document));
      wrap.appendChild(row);
    }
    if (source) { const tag = document.createElement('div'); tag.className = 'message-source'; tag.textContent = source; wrap.appendChild(tag); }
    if (role === 'assistant' && TurnUsage.normalize(turnUsage)) TurnUsage.paint(wrap, turnUsage);
    return wrap;
  }
  function setTurnUsage(item, node, thread, value) {
    const receipt = TurnUsage.normalize(value); if (!receipt) return false;
    const previous = TurnUsage.normalize(item.turnUsage), rank = { unknown: 0, pending: 1, settled: 2 };
    if (item.taskId && receipt.turnId !== item.taskId) return false;
    if (previous?.turnId === receipt.turnId && (rank[previous.status] > rank[receipt.status] || previous.calls > receipt.calls)) return false;
    item.turnUsage = receipt; TurnUsage.paint(node, receipt); persist(thread);
    if (current?.id === thread.id && node === feed.querySelector('.message.assistant:last-child')) {
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'instant' });
    }
    return true;
  }
  function reconcileTurnUsage(item, node, thread) {
    const receipt = TurnUsage.normalize(item.turnUsage);
    if (localMode || !receipt || receipt.status === 'settled') return;
    void TurnUsage.settle(sessionRequest, receipt.turnId, value => {
      if (current?.id !== thread.id && !chats.some(chat => chat.id === thread.id)) return;
      if (setTurnUsage(item, node, thread, value) && value.status === 'settled') void refreshQuota();
    });
  }
  function addMessage(role, text, source, target = current, images = [], documents = []) {
    if (!target) target = current = { id: crypto.randomUUID(), title: '', updatedAt: Date.now(), messages: [] };
    const item = { id: crypto.randomUUID(), role, content: text, createdAt: Date.now(), updatedAt: Date.now(), ...(role === 'assistant' ? { pending: true } : {}), ...(source ? { source } : {}), ...(images.length ? { images } : {}), ...(documents.length ? { documents } : {}) };
    target.messages.push(item); target.updatedAt = Date.now();
    if (role === 'user' && !target.title) { target.title = text.replace(/\s+/g, ' ').slice(0, 34) || documents[0]?.name || '新对话'; target.metadataUpdatedAt = Date.now(); }
    persist(target);
    const empty = feed.querySelector('.welcome');
    if (empty) feed.replaceChildren();
    let inner = feed.querySelector('.feed-inner');
    if (!inner) { inner = document.createElement('div'); inner.className = 'feed-inner'; feed.appendChild(inner); }
    const node = makeMessage(role, text, source, images, documents, null, item); inner.appendChild(node); feed.scrollTop = feed.scrollHeight;
    return { item, node, body: node.querySelector('.message-body') };
  }
  function renderProgress(node) {
    const old = node.querySelector('.assistant-progress'); if (old) old.remove();
    const row = document.createElement('div'); row.className = 'assistant-progress';
    row.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(36 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(72 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(108 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(144 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(180 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(216 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(252 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(288 12 12)"/><ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(324 12 12)"/></svg><div class="phase-window"><div class="phase-track"><div class="phase-item" aria-hidden="true"></div><div class="phase-item" role="status" aria-live="polite">正在连接共享模型</div></div></div><span class="elapsed">0 秒</span>';
    node.insertBefore(row, node.querySelector('.message-body'));
    const track = row.querySelector('.phase-track'); const previous = row.querySelector('.phase-item[aria-hidden]'); const currentPhase = row.querySelector('.phase-item[role=status]'); const elapsed = row.querySelector('.elapsed');
    const started = Date.now(); let animation = null; let timer;
    const labels = { waiting: '等待模型首段回复', thinking: '深度思考中', generating: '正在生成', buffered: '正在整理完整回复' };
    function phase(label) {
      if (!label || currentPhase.textContent === label) return;
      previous.textContent = currentPhase.textContent; currentPhase.textContent = label;
      animation?.cancel(); animation = track.animate?.([{ transform: 'translateY(0)' }, { transform: 'translateY(-50%)' }], { duration: 260, easing: 'ease-out' });
    }
    function tick() { const s = Math.floor((Date.now() - started) / 1000); elapsed.textContent = s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; timer = setTimeout(tick, 1000); }
    tick();
    return { phase(data) { phase(labels[data.phase] || data.phase); }, stop() { clearTimeout(timer); animation?.cancel(); row.remove(); } };
  }
  async function sessionRequest(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.method && options.method !== 'GET') headers.set('X-CSRF-Token', csrf);
    return fetch(url, { ...options, headers });
  }
  async function loadModels() {
    const response = await sessionRequest('/api/conversation/models', { signal: AbortSignal.timeout(15000) }); const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '无法读取共享模型');
    const choices = [];
    for (const provider of data.providers || []) for (const model of provider.models || []) {
      const source = provider.source || (provider.providerId.startsWith('platform:') ? 'platform' : 'personal');
      const rate = Number.isFinite(model.quotaMultiplier) && model.quotaMultiplier > 0 ? ` ×${model.quotaMultiplier}` : '';
      choices.push({ providerId: provider.providerId, providerName: provider.name, modelId: model.modelId, model, source, rate, delegated: provider.delegated === true, label: `${model.displayName || model.modelId}${rate} · ${source === 'chatgpt' ? (provider.delegated ? '授权订阅' : '我的 ChatGPT') : source === 'platform' ? '平台共享' : '我的 API'}` });
    }
    modelSelect.replaceChildren();
    for (const item of choices) { const option = document.createElement('option'); option.value = `${item.providerId}/${item.modelId}`; option.textContent = item.label; option.dataset.name = (item.model.displayName || item.modelId).split('/').pop() + item.rate; option.dataset.modelId = item.modelId; option.dataset.source = item.label.split(' · ').pop(); option.dataset.providerName = item.providerName || option.dataset.source; option.dataset.group = item.model.quotaPool === 'free' ? '免费模型' : '其他模型'; modelSelect.appendChild(option); }
    if (!choices.length) throw new Error('还没有可用模型，请先在模型设置中配置平台共享模型或个人 API');
    let preferred = null;
    try { preferred = localStorage.getItem(storagePrefix + 'model.' + account.id); } catch { /* 可继续使用默认模型 */ }
    selected = choices.find(item => `${item.providerId}/${item.modelId}` === preferred)
      || choices.find(item => item.providerId === data.defaultSelection?.providerId && item.modelId === data.defaultSelection?.modelId)
      || choices[0];
    modelSelect.value = `${selected.providerId}/${selected.modelId}`;
    renderQuota();
    updateOptions();
    modelSelect.onchange = () => {
      selected = choices.find(item => `${item.providerId}/${item.modelId}` === modelSelect.value) || choices[0];
      try { localStorage.setItem(storagePrefix + 'model.' + account.id, `${selected.providerId}/${selected.modelId}`); } catch { /* 本次选择仍有效 */ }
      setStatus(); renderQuota();
      updateOptions();
    };
  }
  function updateOptions() {
    const locked = Boolean(activeController) || savingPreference || importingImages || importingDocuments || Boolean(detectController);
    const model = selected?.model;
    const family = model?.thinkingFamily;
    const on = Boolean(model?.thinkingMode?.endsWith('-on') || family === 'responses' && (!model?.thinkingMode || model.thinkingMode === 'default') && model?.capabilities?.defaultEffort !== 'none');
    const thinking = $('thinkingToggle');
    thinking.disabled = locked || !family;
    thinking.classList.toggle('on', on); thinking.setAttribute('aria-checked', String(on));
    $('thinkingLabel').textContent = !model?.thinkingMode || model.thinkingMode === 'default' ? '思考·默认' : on ? '思考·开' : '思考·关';
    thinking.title = family ? '保存当前账号的思考偏好，下次发送生效' : '当前模型未配置受支持的思考开关，请在绘图页模型设置中配置';
    const vision = $('multimodalToggle');
    vision.disabled = locked || !selected || (!multimodal && !model?.visionInput);
    vision.classList.toggle('on', multimodal); vision.setAttribute('aria-checked', String(multimodal));
    vision.title = model?.visionInput ? '开启后可识别图片和新添加 PDF 的页面画面，并继续追问' : '当前模型未声明支持图片输入，请在绘图页模型设置中配置';
    const effort = $('reasoningEffortSelect'); effort.replaceChildren(new Option('强度：默认' + (model?.capabilities?.defaultEffort ? '·' + Capabilities.LABELS[model.capabilities.defaultEffort] : ''), ''));
    for (const level of model?.capabilities?.reasoningLevels || []) effort.appendChild(new Option('强度：' + Capabilities.LABELS[level], level));
    effort.value = (pendingReasoningEffort === undefined ? model?.reasoningEffort : pendingReasoningEffort) || '';
    effort.disabled = locked || !(model?.capabilities?.reasoningLevels?.length) || Boolean(model?.thinkingMode?.endsWith('-off'));
    effort.dataset.thinkingOff = String(Boolean(model?.thinkingMode?.endsWith('-off')));
    effort.title = effort.disabled ? '当前模型未配置思考强度，或思考已关闭' : '仅修改当前账号的思考强度';
    window.DiagramReasoningSlider?.sync(effort);
    const detect = $('detectReasoningBtn');
    const authorized = selected?.source !== 'platform' || account?.role === 'admin';
    const hasLevels = Boolean(model?.capabilities?.reasoningLevels?.length);
    detect.disabled = !detectController && (locked || !selected);
    detect.textContent = detectController ? '检测中 · 取消' : !model?.reasoningDetectable ? (hasLevels ? '查看强度' : '检测说明') : !authorized ? '检测说明' : model?.reasoningProbe ? '重新检测' : '检测强度';
    detect.title = !model?.reasoningDetectable && hasLevels ? '已有可用档位，点击查看来源；可直接在左侧选择强度，不额外发送请求' : !authorized ? '点击查看平台共享模型的检测权限说明' : !model?.reasoningDetectable ? '点击查看当前协议的检测说明' : '最多 7 次真实 API 请求，可能消耗费用和额度，只确认参数被接受';
    modelSelect.disabled = locked;
    window.DiagramModelPicker?.sync(modelSelect);
    $('attachImageBtn').disabled = locked || !multimodal || !model?.visionInput;
    $('chatImageInput').disabled = $('attachImageBtn').disabled;
    $('attachDocumentBtn').disabled = locked;
    $('chatDocumentInput').disabled = locked;
    $('attachDocumentBtn').title = importingDocuments ? '正在读取文档…' : '添加 PDF、Word、TXT、Markdown 或 CSV（每份 5 MB）' + (multimodal ? `；PDF 将读取文字与画面，最多 ${Documents.MAX_PDF_PAGES} 页` : '；PDF 仅读取文字，最多 100 页');
    $('attachImageBtn').title = multimodal ? '添加图片（PNG / JPEG，最多 3 张，可粘贴或拖入）' : '开启多模态后添加图片';
    input.placeholder = multimodal ? '输入消息，或添加图片、文档…' : '输入消息，或添加文档…';
    renderAttachments(); renderDocumentContext(); resizeInput();
  }
  async function savePreference(patch) {
    if (!selected || activeController || savingPreference || importingImages || importingDocuments || detectController) return;
    const choice = selected; pendingReasoningEffort = patch.reasoningEffort; savingPreference = true; updateOptions(); setStatus();
    try {
      const response = await sessionRequest('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerId: choice.providerId, modelId: choice.modelId, ...patch }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '保存失败');
      Object.assign(choice.model, data.preferences);
    } catch (error) { setStatus('思考设置未保存：' + error.message); }
    finally { pendingReasoningEffort = undefined; savingPreference = false; updateOptions(); }
  }
  function renderAttachments() {
    const tray = $('chatAttachments'); tray.replaceChildren(); tray.hidden = !attachments.length && !documentAttachments.length;
    tray.classList.toggle('off', !multimodal && attachments.length > 0 && !documentAttachments.length);
    for (const item of attachments) {
      const tile = document.createElement('div'); tile.className = 'chat-image-tile';
      const image = document.createElement('img'); image.src = item.data; image.alt = item.name;
      window.DiagramImageViewer?.bind(image);
      const name = document.createElement('span'); name.textContent = item.name; name.title = item.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'chat-image-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', '移除 ' + item.name);
      remove.disabled = Boolean(activeController) || importingImages || importingDocuments;
      remove.onclick = () => { attachments = attachments.filter(value => value !== item); renderAttachments(); renderDocumentContext(); resizeInput(); };
      tile.append(image, name, remove); tray.appendChild(tile);
    }
    for (const document of documentAttachments) tray.appendChild(documentCard(document, () => {
      documentAttachments = documentAttachments.filter(item => item.id !== document.id); renderAttachments(); resizeInput();
    }));
  }
  function previewDocument(doc) {
    $('documentPreviewTitle').textContent = doc.name;
    $('documentPreviewMeta').textContent = `${doc.type.toUpperCase()} · ${doc.text.length.toLocaleString()} 字符${doc.pages ? ' · ' + doc.pages + ' 页' : ''} · ${doc.pageImages?.length ? '文字与页面画面' : '已提取文字'}`;
    $('documentPreviewText').textContent = doc.text || '此 PDF 没有文字层，将通过页面图片识别。';
    const gallery = $('documentPreviewPages'); gallery.replaceChildren(); gallery.hidden = !doc.pageImages?.length;
    for (const [index, data] of (doc.pageImages || []).entries()) {
      const figure = document.createElement('figure');
      const image = document.createElement('img'); image.src = data; image.alt = `${doc.name} · 第 ${index + 1} 页`; image.loading = 'lazy';
      window.DiagramImageViewer?.bind(image);
      const caption = document.createElement('figcaption'); caption.textContent = `第 ${index + 1} 页`;
      figure.append(image, caption); gallery.appendChild(figure);
    }
    if (!$('documentPreview').open) $('documentPreview').showModal();
  }
  function documentCard(doc, remove) {
    const card = document.createElement('div'); card.className = 'document-card';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'document-open';
    open.setAttribute('aria-label', '预览文档：' + doc.name); open.title = doc.pageImages?.length ? '查看文字与页面画面' : '查看已提取的文字';
    const icon = document.createElement('span'); icon.className = 'document-type'; icon.textContent = doc.type.toUpperCase();
    const info = document.createElement('span'); info.className = 'document-info';
    const name = document.createElement('strong'); name.textContent = doc.name;
    const size = document.createElement('small'); size.textContent = `${doc.text.length.toLocaleString()} 字符${doc.pages ? ' · ' + doc.pages + ' 页' : ''}${doc.type === 'pdf' ? doc.pageImages?.length && multimodal ? ' · 含画面' : ' · 仅读文字' : ''}`;
    info.append(name, size); open.append(icon, info); open.onclick = () => previewDocument(doc); card.appendChild(open);
    if (remove) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'document-remove'; button.textContent = '×';
      button.setAttribute('aria-label', '移除文档：' + doc.name);
      button.disabled = Boolean(activeController) || importingDocuments; button.onclick = remove; card.appendChild(button);
    }
    return card;
  }
  function renderDocumentContext() {
    const documents = current?.documents || [];
    const box = $('documentContext'); box.hidden = !documents.length;
    $('documentContextSummary').textContent = `参考文档 ${documents.length} 份 · 后续追问会继续使用`;
    const list = $('documentContextList'); list.replaceChildren();
    for (const document of documents) list.appendChild(documentCard(document, () => {
      current.documents = current.documents.filter(item => item.id !== document.id); current.metadataUpdatedAt = Date.now(); persist(); renderDocumentContext();
      setStatus('已从后续参考上下文移除此文档，原消息中的预览仍保留。', 'info');
    }));
  }
  function mergedDocuments(existing, added) {
    return Documents.normalizeDocuments(Array.from(new Map([...existing, ...added].map(item => [item.id, item])).values()));
  }
  async function addDocuments(files) {
    if (activeController || savingPreference || importingImages || importingDocuments || detectController) return;
    const list = Array.from(files || []); if (!list.length) return;
    const version = attachmentVersion, controller = new AbortController();
    importingDocuments = true; documentController = controller; updateOptions(); setStatus('正在读取文档…', 'info');
    try {
      if (list.length + documentAttachments.length > Documents.MAX_DRAFT_DOCUMENTS) throw Error('每条消息最多新增 3 份文档。');
      for (const file of list) {
        if (!Documents.typeForName(file.name)) throw Error('支持 PDF、Word（.docx）、TXT、Markdown 和 CSV。旧版 .doc 请另存为 .docx。');
        if (!file.size || file.size > Documents.MAX_FILE_BYTES) throw Error('每份文档须大于 0 字节，且不能超过 5 MB。');
      }
      const parsed = [];
      for (const file of list) {
        setStatus((multimodal && Documents.typeForName(file.name) === 'pdf' ? '正在读取文字与页面画面：' : '正在读取：') + file.name, 'info');
        const encoded = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(Error('文档读取失败')); reader.readAsDataURL(file); });
        controller.signal.throwIfAborted();
        const response = await sessionRequest('/api/conversation/documents', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, data: encoded, multimodal }) });
        const data = await response.json(); if (!response.ok) throw Error(data.error?.message || '文档读取失败');
        parsed.push(Documents.normalizeDocuments([data.document])[0]);
      }
      if (version !== attachmentVersion) throw new DOMException('Conversation changed', 'AbortError');
      mergedDocuments(current?.documents || [], [...documentAttachments, ...parsed]);
      documentAttachments.push(...parsed); setStatus('文档已就绪，可点击预览后发送。', 'info');
    } catch (error) { if (version === attachmentVersion) setStatus(controller.signal.aborted ? '文档读取已取消。' : error.message); }
    finally { if (documentController === controller) documentController = null; importingDocuments = false; updateOptions(); }
  }
  async function addFiles(files) {
    const list = Array.from(files || []), images = list.filter(file => file.type.startsWith('image/')), documents = list.filter(file => !file.type.startsWith('image/'));
    if (images.length && !multimodal) { setStatus('附件中有图片，请先开启「多模态」再添加。文档可以单独添加。'); return; }
    if (images.length) await addImages(images);
    if (documents.length) await addDocuments(documents);
  }
  async function addImages(files) {
    if (!multimodal) { setStatus('请先开启「多模态」，再添加图片。'); return; }
    if (!selected?.model.visionInput) { setStatus('请选择支持图片输入的模型。'); return; }
    if (activeController || savingPreference || importingImages || importingDocuments || detectController) return;
    const list = Array.from(files || []); if (!list.length) return;
    const version = attachmentVersion; importingImages = true; updateOptions(); setStatus();
    try {
      if (list.length + attachments.length > 3) throw new Error('每条消息最多添加 3 张图片');
      const added = [];
      for (const file of list) {
        if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > Vision.MAX_IMAGE_BYTES) throw new Error('图片仅支持 3 MB 以内的 PNG / JPEG');
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
        const checked = Vision.validateImage(data);
        await new Promise((resolve, reject) => { const image = new Image(); image.onload = resolve; image.onerror = () => reject(new Error('图片无法解码')); image.src = checked.data; });
        added.push({ data: checked.data, name: file.name || '粘贴图片' });
      }
      if (version !== attachmentVersion || !multimodal) throw new Error('当前对话已变化，请重新添加图片');
      Vision.validateImages([...attachments, ...added].map(item => item.data)); attachments.push(...added);
    } catch (error) { setStatus(error.message); }
    finally { importingImages = false; updateOptions(); }
  }
  function renderQuota() {
    if (localMode) return;
    accountMenu?.select(selected);
  }
  async function detectReasoning() {
    if (detectController) { detectController.abort(); return; }
    if ($('detectReasoningBtn').disabled || !selected) return;
    const model = selected.model, caps = model.capabilities;
    if (!model.reasoningDetectable) {
      if (caps?.reasoningLevels?.length) {
        const source = { remote: '模型接口返回', official: '官方模型说明', manual: '手动配置', probe: '接口检测' }[caps.source] || '当前模型配置';
        setStatus(`档位来源：${source}。支持${caps.reasoningLevels.map(level => Capabilities.LABELS[level] || level).join('、')}；直接在左侧「强度」选择即可，本次未发送检测请求。`, 'info');
      } else setStatus('当前模型协议未提供自动强度检测。可在绘图页模型设置查看能力配置，或切换到支持检测的个人 API 模型。', 'info');
      return;
    }
    if (selected.source === 'platform' && account?.role !== 'admin') {
      setStatus('平台共享模型需由管理员检测；你仍可直接使用模型。个人 API 可以自行检测。', 'info'); return;
    }
    if (!window.confirm('检测最多发送 7 次真实 API 请求，可能消耗 API 费用和网站额度。结果只证明接口接受档位，不保证改变推理效果。开始检测？')) return;
    const choice = selected; detectController = new AbortController(); const controller = detectController;
    setStatus('正在检测接口参数，请等待；可点击「检测中 · 取消」停止。'); updateOptions();
    try {
      const response = await sessionRequest(`/api/providers/${encodeURIComponent(choice.providerId)}/models/${encodeURIComponent(choice.modelId)}/reasoning-detect`, {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
      });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '检测失败');
      const result = data.outcome;
      try { await loadModels(); } catch (error) { selected = null; modelSelect.replaceChildren(new Option('请连接 ChatGPT 或配置 API', '')); setStatus(error.message); updateOptions(); }
      setStatus(`${result.reason} 本次请求 ${result.requests} 次。`, result.validation === 'validating' ? 'success' : '');
    } catch (error) { setStatus(controller.signal.aborted ? '检测已取消，未保存本次结果。' : '检测失败：' + error.message); }
    finally { detectController = null; updateOptions(); await refreshQuota(); }
  }
  async function refreshQuota() {
    try {
      const response = await sessionRequest('/api/usage', { signal: AbortSignal.timeout(10000) }); const data = await response.json(); if (!response.ok || !data.usage) throw new Error('额度读取失败');
      accountMenu?.renderUsage(data.usage);
    } catch { accountMenu?.error(); }
  }
  async function readStream(response, onDelta, onProgress, onSnapshot = () => {}) {
    if (!/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
      const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || '请求失败'), { turnUsage: data.turnUsage, code: data.error?.code, httpStatus: response.status, taskTerminal: data.taskTerminal === true || [404,410].includes(response.status) }); onDelta(data.reply || ''); return data;
    }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let result = null; let failure = null;
    let idleTimer = null, idleError = null;
    const watchConnection = () => {
      clearTimeout(idleTimer);
      // The server sends a heartbeat every 15 seconds, including while thinking.
      // A silent network break must not leave the composer generating forever.
      idleTimer = setTimeout(() => {
        idleError = new Error('连接长时间未收到数据，已保留生成内容。请检查网络后重试。');
        void reader.cancel().catch(() => {});
      }, 120000);
    };
    const parser = window.DiagramSse.createParser(event => {
      const data = JSON.parse(event.data);
      if (event.event === 'delta') onDelta(data.text || '');
      else if (event.event === 'snapshot') onSnapshot(data);
      else if (event.event === 'progress') onProgress(data);
      else if (event.event === 'result') result = data;
      else if (event.event === 'error') failure = data;
    });
    try {
      watchConnection();
      while (true) {
        const { value, done } = await reader.read();
        if (idleError) throw idleError;
        if (done) break;
        watchConnection();
        parser.push(decoder.decode(value, { stream: true }));
        // A terminal event settles this request even if HTTP stays open.
        if (result || failure) break;
      }
      parser.push(decoder.decode());
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { clearTimeout(idleTimer); void reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (failure) throw Object.assign(new Error(failure.error?.message || '模型请求失败'), { turnUsage: failure.turnUsage, code: failure.error?.code, taskTerminal: failure.taskTerminal === true });
    if (!result) throw new Error('连接中断，未收到完整回复，请重试');
    return result;
  }
  async function taskJson(route, body, signal) {
    const request = new AbortController(), abort = () => request.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(() => request.abort(new DOMException('任务连接超时', 'TimeoutError')), 15000);
    try {
      const response = await sessionRequest(route, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error?.message || '任务请求失败'), { httpStatus: response.status, code: data.error?.code, taskTerminal: [400,403,404,409,410,429].includes(response.status) });
      return data;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function cancelServerReply(assistant = activeReply) {
    if (!assistant?.item.taskId) return;
    assistant.cancelRequested = true;
    try {
      await taskJson('/api/conversation/tasks/' + assistant.item.taskId + '/cancel', {}, AbortSignal.timeout(10000));
      assistant.creationController?.abort();
    }
    catch (error) { if (error.httpStatus !== 404) setStatus('尚未确认取消，任务可能仍在服务器运行。可以稍后再次取消。'); }
  }
  async function watchServerReply(assistant, controller, paint) {
    while (!controller.signal.aborted) {
      const connection = new AbortController(), abort = () => connection.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      const connectTimer = setTimeout(abort, 15000);
      try {
        const response = await sessionRequest('/api/conversation/tasks/' + assistant.item.taskId + '/events', { signal: connection.signal });
        clearTimeout(connectTimer);
        return await readStream(response, text => paint({ reply: assistant.item.content + text }), phase => assistant.progress.phase(phase), paint);
      } catch (error) {
        if (error.httpStatus === 410) {
          const saved = await savedTaskReply(assistant.item.taskId);
          if (saved) {
            paint({reply:saved.content,status:saved.taskStatus});
            if (saved.failed) throw Object.assign(new Error(saved.notice || '本轮已结束，以上是已保存的内容。'), {taskTerminal:true,code:saved.taskStatus==='cancelled'?'task-cancelled':'task-failed',turnUsage:saved.turnUsage});
            return {reply:saved.content,turnUsage:saved.turnUsage,savedSource:saved.source};
          }
        }
        if (controller.signal.aborted || error.taskTerminal || error.httpStatus === 401) throw error;
        if (current?.id === assistant.thread.id) setStatus('连接已断开，服务器继续生成，正在重新连接同一任务…', 'info');
        await new Promise(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 1500); controller.signal.addEventListener('abort', done, { once: true });
          if (controller.signal.aborted) done();
        });
      } finally { clearTimeout(connectTimer); controller.signal.removeEventListener('abort', abort); }
    }
    throw new DOMException('View disconnected', 'AbortError');
  }
  async function savedTaskReply(taskId) {
    // Another tab may have durably saved and acknowledged this same task.
    try {
      const rows = historyDb ? await new Promise((resolve, reject) => {
        const request = historyDb.transaction('accounts').objectStore('accounts').get(account.id);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      }) : JSON.parse(localStorage.getItem(storagePrefix + account.id) || '[]');
      return rows?.flatMap(thread => thread.messages || []).find(item => item.taskId === taskId && !item.pending && typeof item.content === 'string') || null;
    } catch { return null; }
  }
  async function followServerReply(assistant, createBody = null, sentImages = [], sentDocuments = []) {
    const thread = assistant.thread, item = assistant.item;
    const controller = new AbortController(); activeController = controller; activeReply = assistant;
    sendButton.disabled = false; sendButton.setAttribute('aria-label', '取消生成'); sendButton.classList.add('stop'); sendButton.innerHTML = '<span aria-hidden="true">■</span>'; input.disabled = true; updateOptions();
    let terminal = false, receipt = null;
    const paint = snapshot => {
      item.taskAccepted = true; item.taskStatus = snapshot.status || 'running';
      if (typeof snapshot.reply === 'string') { item.content = snapshot.reply; assistant.body.innerHTML = markdown(item.content); item.updatedAt = Date.now(); scheduleReplySave(); }
      if (snapshot.phase) { assistant.phase = snapshot.phase; assistant.progress.phase(snapshot.phase); }
      if (current?.id === thread.id) {
        if (item.content) setStatus();
        else setStatus('服务器正在生成；刷新或关闭页面后也会继续，返回时自动恢复。', 'info');
        feed.scrollTop = feed.scrollHeight;
      }
    };
    try {
      renderDocumentContext(); await saveQueue;
      if (createBody) {
        const creation = new AbortController(), detach = () => creation.abort();
        assistant.creationController = creation; controller.signal.addEventListener('abort', detach, { once: true }); if (controller.signal.aborted) detach();
        try {
          const data = await taskJson('/api/conversation/tasks', { ...createBody, taskId: item.taskId, threadId: thread.id, assistantId: item.id }, creation.signal);
          paint(data.task);
        } catch (error) {
          if (controller.signal.aborted || error.taskTerminal || error.httpStatus === 401) throw error;
          // Ambiguous POST outcome: look up the same ID, never issue another model call.
          for (let attempt = 0; attempt < 4; attempt++) {
            try { const data = await taskJson('/api/conversation/tasks/' + item.taskId, undefined, controller.signal); paint(data.task); break; }
            catch (lookupError) {
              if (lookupError.httpStatus !== 404 || controller.signal.aborted) throw lookupError;
              if (attempt === 3) throw Object.assign(new Error('尚未确认服务器是否接受本轮请求，已保留任务编号。刷新后会继续查询，请勿重复发送。'), { code: 'task-unconfirmed' });
              await new Promise(resolve => {
                const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
                const timer = setTimeout(done, 750); controller.signal.addEventListener('abort', done, { once: true }); if (controller.signal.aborted) done();
              });
            }
          }
        } finally { assistant.creationController = null; controller.signal.removeEventListener('abort', detach); }
        if (assistant.cancelRequested) void cancelServerReply(assistant);
      }
      const data = await watchServerReply(assistant, controller, paint);
      terminal = true; receipt = TurnUsage.normalize(data.turnUsage); item.content = data.reply;
      item.pending = false; item.failed = false; item.taskStatus = 'succeeded'; delete item.notice;
      assistant.body.innerHTML = markdown(item.content);
      const source = data.savedSource || `${data.provider?.name || '所选模型'} / ${data.model?.displayName || data.model?.modelId || '模型'}`;
      item.source = source; assistant.node.querySelector('.message-source')?.remove();
      const tag = document.createElement('div'); tag.className = 'message-source'; tag.textContent = `来源：${source}`; assistant.node.appendChild(tag);
      thread.updatedAt = Date.now(); void refreshQuota();
    } catch (error) {
      terminal = error.taskTerminal === true;
      receipt = TurnUsage.normalize(error.turnUsage);
      if (terminal) {
        item.pending = false; item.failed = true; item.taskStatus = error.code === 'task-cancelled' ? 'cancelled' : 'failed';
        item.notice = error.message;
        const question = thread.messages.slice(0, thread.messages.indexOf(item)).reverse().find(message => message.role === 'user');
        if (question) question.failed = true;
        if (current?.id === thread.id && !input.value.trim()) { input.value = question?.content || ''; attachments = sentImages; documentAttachments = sentDocuments; }
        const note = document.createElement('div'); note.className = 'message-error'; note.textContent = item.notice; assistant.node.appendChild(note); addRecoveryAction(assistant.node, item, thread);
        void refreshQuota();
      } else {
        item.pending = true;
        if (!pageLeaving) setStatus(error.httpStatus === 401 ? '请重新登录；登录后会恢复服务器任务。' : error.code === 'task-unconfirmed' ? error.message : '页面已断开，服务器任务不会因此取消，返回后会继续恢复。', 'info');
      }
    } finally {
      item.updatedAt = Date.now();
      if (terminal && item.taskId && !localMode) {
        setTurnUsage(item, assistant.node, thread, receipt || TurnUsage.unknown(item.taskId)); reconcileTurnUsage(item, assistant.node, thread);
      }
      finishReplySave(assistant);
      assistant.progress.stop(); activeReply = null; activeController = null; input.disabled = false;
      sendButton.setAttribute('aria-label', '发送消息'); sendButton.classList.remove('stop'); sendButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6"/></svg>';
      updateOptions(); if (terminal) { setStatus(); input.focus(); }
      if (!pageLeaving && (terminal || controller.signal.aborted)) setTimeout(resumeServerReply, 0);
    }
  }
  function resumeServerReply() {
    if (activeController || !account || pageLeaving) return;
    for (const thread of chats) {
      const item = thread.messages.find(message => message.role === 'assistant' && message.pending && /^[a-f0-9-]{36}$/.test(message.taskId || ''));
      if (!item) continue;
      const node = current?.id === thread.id ? feed.querySelector(`[data-message-id="${item.id}"]`) : null;
      const target = node || makeMessage(item.role, item.content, item.source, [], [], item.turnUsage, item);
      const assistant = { item, thread, node: target, body: target.querySelector('.message-body'), progress: renderProgress(target) };
      void followServerReply(assistant); return;
    }
  }
  async function submit(event) {
    event?.preventDefault();
    if (activeController) { void cancelServerReply(); return; }
    if (savingPreference || importingImages || importingDocuments || detectController) { setStatus('请等待附件读取、设置保存或检测完成。'); return; }
    const text = input.value.trim() || (documentAttachments.length ? '请阅读参考文档并概括主要内容。' : attachments.length ? '请看看这些图片。' : ''); if (!text || !selected) return;
    const unanswered = isContinuation(text) && unansweredQuestion(current);
    if (unanswered) { fillOriginalQuestion(unanswered); return; }
    if (attachments.length && !multimodal) { setStatus('请开启「多模态」后发送附件，或先移除附件。'); return; }
    if (multimodal && !selected.model.visionInput) { setStatus('当前模型未声明支持图片输入，请更换模型或关闭多模态。'); return; }
    const choice = selected, sentImages = attachments.slice(), sentDocuments = documentAttachments.slice();
    const thread = current || { id: crypto.randomUUID(), title: '', updatedAt: Date.now(), messages: [] }; current = thread;
    let referenceDocuments, body;
    try {
      referenceDocuments = mergedDocuments(thread.documents || [], sentDocuments);
      body = { message: text, history: historyFor(thread, multimodal), ...(referenceDocuments.length ? { documents: Documents.forMode(referenceDocuments, multimodal) } : {}), providerId: choice.providerId, modelId: choice.modelId, stream: true, multimodal, ...(sentImages.length ? { images: sentImages.map(item => item.data) } : {}) };
      Vision.validateImages(body.images); for (const item of body.history) if (item.images) Vision.validateImages(item.images);
      if (new Blob([JSON.stringify(body)]).size > Vision.MAX_BODY_BYTES - 512) throw Error('附件与上下文超过 10 MB，请新建对话或减少本次附件后发送。');
    } catch (error) { setStatus(error.message); return; }
    if (sentDocuments.length || !Array.isArray(thread.documents)) thread.metadataUpdatedAt = Date.now();
    thread.documents = referenceDocuments; setStatus();
    addMessage('user', text, undefined, thread, sentImages.map(item => item.data), sentDocuments);
    attachments = []; documentAttachments = []; attachmentVersion++; input.value = ''; resizeInput();
    const assistant = addMessage('assistant', '', undefined, thread); assistant.thread = thread; assistant.progress = renderProgress(assistant.node);
    assistant.item.taskId = crypto.randomUUID(); assistant.item.taskStatus = 'running';
    if (!localMode) assistant.item.turnUsage = TurnUsage.unknown(assistant.item.taskId);
    persist(thread);
    await followServerReply(assistant, body, sentImages, sentDocuments);
  }
  function resizeInput() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; sendButton.disabled = activeController ? false : savingPreference || importingImages || importingDocuments || Boolean(detectController) || !selected || (!input.value.trim() && !attachments.length && !documentAttachments.length); }
  function closeMobileHistory() { document.body.classList.remove('history-open'); }
  async function boot() {
    try {
      const response = await fetch('/api/auth/session'); const info = await response.json();
      if (!response.ok || info.mode !== 'local' && !info.user) { window.location.replace('/login.html?next=%2Fchat.html'); return; }
      localMode = info.mode === 'local';
      csrf = info.csrf || ''; account = localMode ? { id: 'local', username: '本地个人版' } : info.user;
      if (!localMode) accountMenu = window.DiagramAccountMenu.mount({ host: $('chatAccountMount'), session: info, request: sessionRequest, currentSelection: () => selected, autoRefresh: false });
      else $('chatAccountMount').textContent = '本地个人版';
      if(info.user?.membership?.plan==='trial'){document.querySelector('.shared-note').textContent='可体验 DeepSeek、Qwen、Flash 三个全站免费模型';document.querySelector('.rail-footer span:last-child').textContent='三个全站免费模型';modelSelect.setAttribute('aria-label','选择免费共享模型');document.querySelector('.composer-hint').textContent='体验用户仅可使用三个免费模型，全站共用每日次数。';document.querySelector('.chat-model-settings').hidden=true;document.querySelector('.chat-model-settings').style.display='none';}
      if (localMode) { document.querySelector('.shared-note').textContent = '可使用我的 ChatGPT 或自己配置的 API'; document.querySelector('.rail-footer span:last-child').textContent = 'ChatGPT 订阅或个人 API'; document.querySelector('.composer-hint').textContent = '我的 ChatGPT 使用订阅额度；个人 API 使用自己的 API 额度。'; }
      await loadChats();
      try { multimodal = localStorage.getItem(storagePrefix + 'multimodal.' + account.id) === 'true'; } catch { /* 默认关闭 */ }
      renderList();
      const recent = chats.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]; if (recent) setCurrent(recent.id);
      // Commit recovered synchronous checkpoints before acknowledging their server copies.
      saveChats();
      if (!localMode) { void refreshQuota(); quotaTimer = setInterval(refreshQuota, 60000); }
      resumeServerReply(); input.focus();
      // Reading saved conversations and following accepted tasks do not require a model catalog.
      void loadModels().catch(error => {
        selected = null; modelSelect.replaceChildren(new Option('共享模型暂不可用', '')); updateOptions();
        if (!activeController) setStatus(error.name === 'TimeoutError' ? '模型列表连接超时；已保存对话仍可查看。' : error.message);
      });
    } catch (error) {
      $('modelSelect').replaceChildren(new Option('共享模型暂不可用', ''));
      const message = document.createElement('div'); message.className = 'model-error'; message.textContent = error.message;
      accountMenu?.error(); setStatus(message.textContent);
    }
  }
  window.addEventListener('chatgpt-models-changed', () => { if (account) loadModels().catch(error => { selected = null; modelSelect.replaceChildren(new Option('请连接 ChatGPT 或配置 API', '')); updateOptions(); setStatus(error.message); }); });
  $('newChatBtn').onclick = newThread;
  $('historyToggle').onclick = () => document.body.classList.toggle('history-open');
  $('mobileScrim').onclick = closeMobileHistory;
  form.addEventListener('submit', submit);
  $('multimodalToggle').onclick = () => {
    if ($('multimodalToggle').disabled) return;
    multimodal = !multimodal; attachmentVersion++;
    try { localStorage.setItem(storagePrefix + 'multimodal.' + account.id, String(multimodal)); } catch { /* 本次设置仍有效 */ }
    const documents = [...(current?.documents || []), ...documentAttachments];
    setStatus(!multimodal && attachments.length ? '图片已保留，重新开启多模态后可发送。'
      : !multimodal && documents.some(doc => !doc.text.trim()) ? '部分 PDF 没有文字层，请重新开启多模态读取画面，或移除这些文档。'
      : multimodal && documents.some(doc => doc.type === 'pdf' && !doc.pageImages?.length) ? '已有 PDF 仅读取了文字；如需识别其画面，请移除后重新添加。'
      : '', 'info'); updateOptions();
  };
  $('thinkingToggle').onclick = () => { if (!$('thinkingToggle').disabled) savePreference({ thinkingMode: `${selected.model.thinkingFamily}-${$('thinkingToggle').getAttribute('aria-checked') === 'true' ? 'off' : 'on'}` }); };
  $('reasoningEffortSelect').onchange = () => { if (!$('reasoningEffortSelect').disabled) savePreference({ reasoningEffort: $('reasoningEffortSelect').value || null }); };
  $('detectReasoningBtn').onclick = detectReasoning;
  $('attachDocumentBtn').onclick = () => $('chatDocumentInput').click();
  $('chatDocumentInput').onchange = event => { const files = Array.from(event.target.files || []); event.target.value = ''; addDocuments(files); };
  $('documentPreviewClose').onclick = () => $('documentPreview').close();
  $('attachImageBtn').onclick = () => $('chatImageInput').click();
  $('chatImageInput').onchange = event => { const files = Array.from(event.target.files || []); event.target.value = ''; addImages(files); };
  input.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  form.addEventListener('dragover', event => { if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); form.classList.add('drag-over'); } });
  form.addEventListener('dragleave', event => { if (!form.contains(event.relatedTarget)) form.classList.remove('drag-over'); });
  form.addEventListener('drop', event => { event.preventDefault(); form.classList.remove('drag-over'); addFiles(event.dataTransfer?.files); });
  input.addEventListener('input', resizeInput);
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(event); } });
  document.addEventListener('visibilitychange', () => { if (document.hidden && activeReply) { checkpointReply(); persist(activeReply.thread); } });
  window.addEventListener('pagehide', () => { pageLeaving = true; checkpointReply(); clearTimeout(replySaveTimer); clearInterval(quotaTimer); activeController?.abort(); detectController?.abort(); documentController?.abort(); });
  window.addEventListener('pageshow', () => { pageLeaving = false; resumeServerReply(); });
  boot();
})();
