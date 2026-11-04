// DiagramAI 前端：draw.io embed 协议 + AI Agent 对话
//
// 设计要点（每条都对应一个已修复的具体缺陷）：
//   A. 提交 AI 请求前，用 viewbox / getDiff 查询编辑器「当前页 + 最新文档」；
//      请求携带**稳定页面 id**，响应后再次同步，切页/增删页/重排都会被判定为冲突，
//      写回时也按页面 id 定位，绝不把结果写进别的页面。
//   B. 画布版本号 + 请求版本号：等待期间的手工编辑绝不覆盖，改为暂存结果 + 应用/丢弃入口。
//   C. 加载事务收敛：新加载会显式结束旧的待处理加载（不留悬空 resolver）；
//      回执必须与本次操作的载荷逐字节匹配才确认，超时/过期回执都收敛到确定状态。
//   D. 写回画布前用严格 XML 校验（与服务端同一份实现）。
//   E. 失败文本存入独立的重试状态；错误响应与重试都不会覆盖用户新写的草稿。
//   F. 消息按配置的编辑器 origin 收发与校验。
(async function () {
  'use strict';
  if (window.location.protocol === 'file:') return;
  await window.DiagramCloud?.ready;
  if(window.DiagramCloud?.enabled&&!window.DiagramCloud.user)return;
  const storageScope=window.DiagramCloud?.user?.id||'';

  const Xml = window.DiagramXml;
  const Model = window.DiagramModel;
  const File = window.DiagramFile;
  const Edit = window.DiagramEdit;
  const Vision = window.DiagramVision;
  const VisualRepair = window.DiagramVisualRepair;
  const Capabilities = window.DiagramCapabilities;
  const TurnUsage = window.DiagramTurnUsage;

  const EMPTY_MODEL = '<mxGraphModel dx="900" dy="650" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
  const DRAFT_KEY = 'diagramai.draft'+(storageScope?'.'+storageScope:'');
  const MULTIMODAL_KEY = 'diagramai.multimodalEnabled'+(storageScope?'.'+storageScope:'');
  const SELECTION_KEY = 'diagramai.modelSelection'+(storageScope?'.'+storageScope:''); // 只保存选择（providerId/modelId），绝不保存密钥
  const SNAPSHOT_LIMIT = 10;
  const DEFAULT_LOAD_TIMEOUT_MS = 10000;
  const SYNC_TIMEOUT_MS = 3000;
  const EXPORT_TIMEOUT_MS = 20000;
  // 数字字符串兼容格式：完整的十进制非负整数（无符号、无空白、无前导零）
  const PAGE_INDEX_STRING_RE = /^(?:0|[1-9][0-9]*)$/;
  const TEST_MODE = /(?:^|[?&])test=1(?:&|$)/.test(window.location.search);

  const el = (id) => document.getElementById(id);
  const frame = el('drawioFrame');
  const editorLoading = el('editorLoading');
  const aiStatus = el('aiStatus');
  const aiStatusText = el('aiStatusText');
  const canvasStatusText = el('canvasStatusText');
  const chatList = el('chatList');
  const chatForm = el('chatForm');
  const chatInput = el('chatInput');
  const sendBtn = el('sendBtn');
  const cancelBtn = el('cancelBtn');
  const conflictBanner = el('conflictBanner');
  const hintBar = el('hintBar');
  const toast = el('toast');

  const state = {
    ready: false,
    multimodalEnabled: false,
    visionReference: null,
    visionRefVersion: 0,
    visionPhase: '',
    config: { embedUrl: 'https://embed.diagrams.net/', embedOrigin: null, model: '-', aiEnabled: false, limits: {} },
    payload: null,          // 编辑器最新载荷（mxfile 或裸 mxGraphModel 原文）
    payloadKind: null,
    pageIndex: 0,
    pageId: null,           // 当前页的稳定标识（<diagram id>，缺失时退化为页名）
    pageCount: 1,
    revision: 0,            // 画布版本：每次真实改动 +1
    history: [],
    attachments: [],
    attachmentVersion: 0,
    attachmentsImporting: false,
    sessionBusy: false,
    editCapturing: false,
    editContext: null,
    busy: false,
    activeRequest: null,
    drawingTask: null, // Server job + original canvas baseline, scoped to this account session.
    thinkingSaving: false,
    reasoningDetection: null,
    requestSeq: 0,
    pendingLoad: null,      // 唯一待确认的加载事务
    pendingResult: null,    // 冲突时暂存的 AI 结果
    retry: null,            // 失败请求的独立重试状态（不污染草稿）
    snapshots: [],
    modelXml: null,         // 当前页明文模型（可读时）
    originWarning: false,
    loadCount: 0,
    staleReceipts: 0,       // 与当前操作不匹配（过期）的加载回执数
    lastLoadInfo: null,
    exportWaiter: null,
    exportWaiters: new Map(),
    exportSeq: 0,
    queryWaiters: new Map(), // token → {resolve, timer, action}
    loadSeq: 0,
    querySeq: 0,
    syncFailures: 0,
    staleQueryReceipts: 0,  // 与请求动作不匹配的查询回执数（不得用来确认操作）
    modelCatalog: null,     // /api/models/catalog 的目录（不含密钥）
    providers: null,        // /api/providers 完整列表（仅 hasKey 状态）
    providerRevision: null, // 服务端配置编辑版本（R6：保存时携带做过期检测）
    providerFormRevision: null, // 当前打开表单读取配置时的版本（只在打开/自己保存成功时更新）
    selection: null,        // 当前生效选择 { providerId, modelId }
    selectionInfo: null,    // 校验后的选择详情 { valid, providerName, modelName, reason }
  };

  let loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS;
  const chatBubbles = [];
  const welcomeMarkup = chatList.innerHTML;
  const session = { repository: null, initialized: false, dirty: false, epoch: 0, storeRevision: 0,
    timer: null, saving: null, suspended: false, blocked: false, name: '未命名图表', savedAt: null };
  let editorStartPage = 0;
  let navigationLoad = null;
  let requirementsHandoff = null;

  // ---------- 基础 UI ----------
  let toastTimer = null;
  function showToast(text, kind) {
    toast.textContent = text;
    toast.className = 'toast' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 4200);
  }

  function setHint(text) {
    if (!text) { hintBar.className = 'hint hidden'; hintBar.textContent = ''; return; }
    hintBar.className = 'hint';
    hintBar.textContent = text;
  }

  function setBusyUi(busy) {
    if (el('requirementsHandoffOpenBtn')) el('requirementsHandoffOpenBtn').disabled = !requirementsHandoff || !state.ready || busy || state.sessionBusy || state.editCapturing || Boolean(state.pendingLoad);
    sendBtn.disabled = !state.modelCatalog || busy || state.thinkingSaving || Boolean(state.reasoningDetection) || state.sessionBusy || state.editCapturing || Boolean(state.pendingResult?.edit||state.pendingResult?.visual);
    el('modifySelectionBtn').disabled = busy || state.sessionBusy || state.editCapturing || !state.ready || Boolean(state.pendingResult);
    el('clearEditBtn').disabled = busy || state.editCapturing;
    el('modifySelectionBtn').textContent = state.editCapturing ? '正在读取选区…' : '修改选中';
    const canCancel = busy && state.activeRequest?.canCancel;
    sendBtn.classList.toggle('hidden', Boolean(canCancel));
    cancelBtn.classList.toggle('hidden', !canCancel);
    cancelBtn.disabled = Boolean(state.activeRequest?.controller.signal.aborted);
    for (const id of ['newDiagramBtn', 'importDiagramBtn', 'recoverSessionBtn']) {
      if (el(id)) el(id).disabled = busy || state.sessionBusy || state.editCapturing || Boolean(state.pendingLoad);
    }
    for (const id of ['undoBtn', 'exportPngBtn', 'downloadBtn', 'applyPendingBtn', 'discardPendingBtn']) {
      if (el(id)) el(id).disabled = state.sessionBusy || state.editCapturing;
    }
    chatForm.classList.toggle('busy', busy);
    updateThinkingSwitch();
    updateVisionControls();
    renderAttachments();
  }

  function setCanvasStatus() {
    const parts = [`画布 v${state.revision}`];
    if (state.pageCount > 1) parts.push(`${state.pageCount}页`, `第${state.pageIndex + 1}页`);
    canvasStatusText.textContent = parts.join(' · ');
  }

  function addBubble(role, text, extraClass) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'bubble' + (extraClass ? ' ' + extraClass : '');
    bubble.textContent = text;
    wrap.appendChild(bubble);
    chatList.appendChild(wrap);
    chatList.scrollTop = chatList.scrollHeight;
    bubble.sessionRole = role;
    chatBubbles.push(bubble);
    markSessionDirty();
    return bubble;
  }
  function setTurnUsage(bubble, value) {
    const receipt = TurnUsage?.normalize(value);
    if (!receipt || !chatBubbles.includes(bubble)) return;
    const follow = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
    bubble.sessionTurnUsage = receipt; TurnUsage.paint(bubble, receipt); markSessionDirty();
    if (follow) chatList.scrollTop = chatList.scrollHeight;
  }
  function reconcileTurnUsage(bubble) {
    const receipt = bubble.sessionTurnUsage;
    if (!window.DiagramCloud?.enabled || !receipt || receipt.status === 'settled') return;
    void TurnUsage.settle(fetch, receipt.turnId, value => {
      setTurnUsage(bubble, value);
      if (value.status === 'settled') window.DiagramCloud?.refreshUsage();
    });
  }

  /** 在助手气泡上标注本次回复实际使用的来源（用响应里的真实信息，不用当前下拉的值） */
  function tagSource(bubble, data) {
    if (!bubble || !data) return;
    let text = null;
    if (data.source === 'mock') {
      text = '来源：示例引擎';
    } else if (data.provider && data.model) {
      const name = data.model.displayName && data.model.displayName !== data.model.modelId
        ? `${data.model.displayName}（${data.model.modelId}）`
        : data.model.modelId;
      text = `来源：${data.provider.name} / ${name}`;
    }
    if (!text) return;
    bubble.sessionSource = text;
    const tag = document.createElement('div');
    tag.className = 'bubble-source';
    tag.textContent = text;
    bubble.appendChild(tag);
  }

  /**
   * 重试入口：使用调用方传入的失败文本与**原请求锁定的模型选择**，
   * 不改动输入框里用户新写的内容，也不偷偷换成当前下拉选择的模型。
   */
  function addRetryButton(bubble, requestText, lockedSelection, editContext = null) {
    bubble.sessionRetry = { text: requestText, selection: lockedSelection, editContext };
    const row = document.createElement('div');
    row.className = 'retry-row';
    const btn = document.createElement('button');
    btn.className = 'retry-btn';
    btn.textContent = '重试这次请求';
    btn.onclick = async () => {
      const res = await sendMessage(requestText, { selection: lockedSelection, editContext });
      // 模型失效被阻止时保留按钮：用户主动重选模型后可再次点击重试
      if (!res || res.reason !== 'model-invalid') { row.remove(); bubble.sessionRetry = null; markSessionDirty(); }
    };
    row.appendChild(btn);
    bubble.parentNode.appendChild(row);
    chatList.scrollTop = chatList.scrollHeight;
  }

  // ---------- 草稿 ----------
  function setDraft(text) {
    chatInput.value = text || '';
    saveDraft();
  }
  function saveDraft() {
    try {
      localStorage.setItem(DRAFT_KEY, chatInput.value);
    } catch (e) { /* 忽略 */ }
  }
  function restoreDraft() {
    try {
      const draft = localStorage.getItem(DRAFT_KEY);
      if (draft) chatInput.value = draft;
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 本地会话 ----------
  function setSaveStatus(text, error) {
    const status = el('saveStatus');
    if (!status) return;
    status.textContent = text;
    status.className = 'save-status' + (error ? ' error' : '');
    status.title = error ? text : '自动保存到此浏览器；下载 .drawio 可另存文件备份';
    if (el('sessionName')) el('sessionName').textContent = session.name;
  }

  function captureSession() {
    const messages = chatBubbles.slice(-200).map(b => {
      const recovering = b.sessionTaskId && state.drawingTask?.taskId === b.sessionTaskId && state.drawingTask.status === 'pending';
      const interrupted = b.classList.contains('typing') && state.busy && !recovering;
      const text = b.childNodes
        ? Array.from(b.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join('')
        : b.textContent;
      return { role: b.sessionRole, text: recovering ? '服务器正在生成，返回页面后会自动恢复。' : interrupted ? '上次生成在关闭页面时中断，请重新发送。' : text,
        kind: interrupted || b.classList.contains('error') ? 'error' : b.classList.contains('conflict') ? 'conflict' : '',
        ...(b.sessionImages?.length?{images:b.sessionImages}:{}),
        ...(b.sessionTaskId?{taskId:b.sessionTaskId}:{}),
        source: b.sessionSource || '', retry: b.sessionRetry || null,
        ...(b.sessionTurnUsage ? { turnUsage: b.sessionTurnUsage } : {}) };
    });
    return { version: 1, payload: state.payload, pageIndex: state.pageIndex, pageId: state.pageId,
      revision: state.revision, name: session.name, draft: chatInput.value, attachments:state.attachments.map(i=>i.data),
      history: state.history, messages, snapshots: state.snapshots,
      pendingResult: state.pendingResult, retry: state.retry, editContext: state.editContext, drawingTask: state.drawingTask };
  }

  function markSessionDirty() {
    if (!session.initialized || session.suspended || !state.payload) return;
    session.dirty = true;
    session.epoch += 1;
    if (!session.repository) { setSaveStatus('未保存 · 本地存储不可用，请下载图表', true); return; }
    setSaveStatus(session.blocked ? '保存冲突 · 请下载备份并恢复会话' : '尚未保存', session.blocked);
    clearTimeout(session.timer);
    if (!session.blocked) session.timer = setTimeout(() => flushSession(), 350);
  }

  async function flushSession(options = {}) {
    clearTimeout(session.timer);
    if (session.suspended || session.blocked || !session.repository) return false;
    if (session.saving) { await session.saving; return flushSession(options); }
    if (!session.dirty && !options.backup) return true;
    const epoch = session.epoch;
    const data = captureSession();
    setSaveStatus('正在保存…');
    session.saving = (async () => {
      try {
        const saved = await session.repository.save(data, session.storeRevision, options);
        session.storeRevision = saved.revision;
        session.savedAt = saved.savedAt;
        session.dirty = epoch !== session.epoch;
        setSaveStatus(session.dirty ? '尚未保存' : '已自动保存');
        // ACK uses the exact committed checkpoint, never an in-memory result.
        if (data.drawingTask?.status === 'settled') void acknowledgeDrawingTask(data.drawingTask.taskId);
        return true;
      } catch (e) {
        session.dirty = true;
        if (e.name === 'SessionConflictError') session.blocked = true;
        setSaveStatus('保存失败 · ' + e.message, true);
        return false;
      }
    })();
    const saved = await session.saving;
    session.saving = null;
    // A change during the transaction must get its own checkpoint.
    if (saved && session.dirty && !session.suspended) session.timer = setTimeout(() => flushSession(), 350);
    return saved;
  }

  function installSession(data) {
    state.attachmentVersion++;state.attachments=(data.attachments||[]).map((data,index)=>({data,name:`图片 ${index+1}`}));renderAttachments();
    state.visionPreview=null;state.visionPhase='';renderVision();
    state.editContext = data.editContext || null; renderEditContext();
    session.name = data.name;
    syncFromPayload(data.payload, { currentPage: data.pageIndex });
    state.revision = data.revision;
    state.history = data.history;
    state.snapshots = data.snapshots;
    state.pendingResult = data.pendingResult;
    state.retry = data.retry;
    state.drawingTask = data.drawingTask || null;
    setDraft(data.draft);
    chatList.innerHTML = '';
    chatBubbles.length = 0;
    if (!data.messages.length) chatList.innerHTML = welcomeMarkup;
    for (const m of data.messages) {
      const bubble = addBubble(m.role, m.text, m.kind);
      if (m.taskId) bubble.sessionTaskId = m.taskId;
      if(m.images?.length)appendBubbleImages(bubble,m.images);
      if (m.source) {
        bubble.sessionSource = m.source;
        const tag = document.createElement('div');
        tag.className = 'bubble-source'; tag.textContent = m.source; bubble.appendChild(tag);
      }
      if (m.retry) addRetryButton(bubble, m.retry.text, m.retry.selection, m.retry.editContext);
      if (m.turnUsage) { setTurnUsage(bubble, m.turnUsage); reconcileTurnUsage(bubble); }
    }
    if(state.pendingResult)showConflictBanner();else conflictBanner.classList.add('hidden');
    setCanvasStatus();
  }

  async function validateDocumentForLoad(payload) {
    const info = File.parseFile(payload);
    // Persisted plain XML has already been validated by the shared parser.
    // Compressed pages still require bounded server-side decompression.
    if (info.pages.some(p => p.encoding === 'encoded' || p.encoding === 'empty')) {
      const resp = await fetch('/api/diagrams/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }) });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error?.message || '文件校验失败');
      return data.payload;
    }
    window.DiagramSessions.documentData(payload, 0, null);
    return payload;
  }

  async function initSession() {
    if (!window.DiagramSessions) return; // Legacy test harnesses lack persistence.
    session.suspended = true;
    let latestDraft = null;
    try { latestDraft = localStorage.getItem(DRAFT_KEY); } catch (e) { /* IndexedDB can still work. */ }
    try {
      session.repository = await window.DiagramSessions.open(window.indexedDB,storageScope?'diagramai.sessions.'+storageScope:undefined);
      const record = await session.repository.read();
      if (record) {
        record.data.payload = await validateDocumentForLoad(record.data.payload);
        installSession(record.data);
        // The synchronous draft checkpoint may be newer than an interrupted
        // IndexedDB transaction, including an intentionally cleared draft.
        if (latestDraft !== null) setDraft(latestDraft);
        session.storeRevision = record.revision;
        session.savedAt = record.savedAt;
        setSaveStatus('已恢复上次会话');
      } else setSaveStatus('新会话 · 等待编辑');
      session.initialized = true;
    } catch (e) {
      session.blocked = Boolean(session.repository);
      session.initialized = true;
      setSaveStatus('恢复失败 · ' + e.message + '（原备份保留）', true);
    } finally { session.suspended = false; }
  }

  async function reconnectSessionStorage() {
    if (state.sessionBusy || state.busy) return;
    try {
      session.repository = await window.DiagramSessions.open(window.indexedDB,storageScope?'diagramai.sessions.'+storageScope:undefined);
      session.initialized = true;
      const revision = await session.repository.revision();
      session.blocked = revision !== 0;
      if (session.blocked) {
        setSaveStatus('本地存储已连接 · 请恢复会话或先下载当前图表', true);
      } else { session.storeRevision = 0; markSessionDirty(); await flushSession(); }
    } catch (e) { setSaveStatus('保存失败 · ' + e.message, true); }
  }

  function editorUrl(pageIndex) {
    const base = state.config.embedUrl;
    return base + (base.includes('?') ? '&' : '?') +
      'embed=1&proto=json&spin=1&libraries=1&noSaveBtn=1&noExitBtn=1&saveAndExit=0&returnbounds=1&modified=0&page=' + pageIndex;
  }

  function loadSessionDocument(payload, pageIndex) {
    if (pageIndex === editorStartPage) return loadIntoEditor(payload, { label: '打开会话' });
    // The embed protocol selects the initial page through its URL. Reload it
    // with the requested index; never reorder the document to select a page.
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        if (navigationLoad?.timer !== timer) return;
        navigationLoad = null;
        resolve({ ok: false, error: '编辑器重新加载超时，请恢复已保存会话' });
      }, 20000);
      navigationLoad = { payload, resolve, timer };
      state.ready = false;
      editorStartPage = pageIndex;
      frame.src = editorUrl(pageIndex);
    });
  }

  function hasSessionWork() {
    return state.history.length > 0 || chatInput.value.trim() || state.pendingResult ||
      state.pageCount > 1 || docFingerprint(state.payload) !== docFingerprint(EMPTY_MODEL);
  }

  async function replaceSession(data, options = {}) {
    if (state.busy || state.sessionBusy || state.editCapturing || state.pendingLoad || !state.ready) return { ok: false, error: '请等待当前操作完成' };
    state.sessionBusy = true; setBusyUi(state.busy);
    try {
      const sync = await syncWithEditor({ timeout: SYNC_TIMEOUT_MS });
      if (!sync.docOk || sync.pageInvalid || (state.pageCount > 1 && !sync.pageOk)) throw new Error(sync.error || '无法确认当前画布，请稍后重试');
      const normalized = window.DiagramSessions.normalize(data);
      if (!options.confirmed && hasSessionWork() && !window.confirm('打开“' + normalized.name + '”将替换当前图表、聊天和草稿。当前会话会保留为上一份备份。继续吗？')) return { ok: false, cancelled: true };
      // Preserve current work before loading; no replacement if its backup fails.
      if (!options.recoveringConflict) markSessionDirty();
      if (!options.recoveringConflict && hasSessionWork() && !await flushSession()) throw new Error('当前会话无法备份，请先下载图表，排除保存错误后再打开新会话');
      const payload = await validateDocumentForLoad(normalized.payload);
      session.suspended = true;
      const previousPayload = state.payload;
      const previousPage = state.pageIndex;
      const loaded = await loadSessionDocument(payload, normalized.pageIndex);
      if (!loaded.ok) {
        if (state.ready) await loadSessionDocument(previousPayload, previousPage);
        throw new Error(loaded.error + '；原会话备份可通过“恢复会话”找回');
      }
      // load receipts are authoritative for the visible page.
      normalized.payload = payload;
      normalized.pageIndex = state.pageIndex;
      normalized.pageId = state.pageId;
      installSession(normalized);
      session.suspended = false;
      markSessionDirty();
      const saved = await flushSession({ backup: !options.recoveringConflict });
      showToast(saved ? '已打开并保存会话；可恢复上一份备份' : '图表已打开，但自动保存失败，请下载备份', saved ? null : 'error');
      return { ok: true, saved };
    } catch (e) {
      showToast('打开失败：' + e.message, 'error');
      return { ok: false, error: e.message };
    } finally {
      session.suspended = false;
      state.sessionBusy = false; setBusyUi(state.busy);
    }
  }

  function emptySession(payload = EMPTY_MODEL, name = '未命名图表') {
    return { version: 1, payload, pageIndex: 0, pageId: null, name, revision: 0,
      draft: '', history: [], messages: [], snapshots: [], pendingResult: null, retry: null };
  }

  function prepareRequirementsHandoff() {
    if (!/(?:^|[?&])requirements=1(?:&|$)/.test(window.location.search)) return;
    const key = 'diagramai.requirements.handoff';
    const banner = el('requirementsHandoffBanner'), text = el('requirementsHandoffText');
    if (!banner || !text) return;
    try {
      const raw = sessionStorage.getItem(key), candidate = JSON.parse(raw || 'null');
      if (!candidate || candidate.version !== 1 || candidate.ownerId !== (storageScope || 'local')) throw Error('未找到当前账号的需求图表，请返回文档成图页面重新打开。');
      if (!Number.isSafeInteger(candidate.createdAt) || Date.now() - candidate.createdAt > 86400000 || candidate.createdAt > Date.now() + 60000) throw Error('本次打开记录已过期，请返回文档成图页面重新打开。');
      if (typeof candidate.title !== 'string' || !candidate.title.trim() || candidate.title.length > 200 || typeof candidate.payload !== 'string' || candidate.payload.length > (state.config.limits.maxFileChars || 200000)) throw Error('需求图表内容不完整，请返回重新生成。');
      // Validate every page before asking to replace anything in this workspace.
      window.DiagramSessions.normalize(emptySession(candidate.payload, candidate.title));
      requirementsHandoff = { ...candidate, raw };
      text.textContent = '已准备“' + candidate.title + '”。打开后可继续编辑；当前工作会按现有规则先备份。';
    } catch (error) { text.textContent = error.message || '读取需求图表失败，请返回重试。'; }
    banner.classList.remove('hidden');
    const clearQuery = () => { const url = new URL(location.href); url.searchParams.delete('requirements'); history.replaceState(null, '', url.pathname + url.search + url.hash); };
    el('requirementsHandoffDismissBtn').onclick = () => { banner.classList.add('hidden'); clearQuery(); };
    el('requirementsHandoffOpenBtn').onclick = async () => {
      if (!requirementsHandoff || !state.ready || state.busy || state.sessionBusy || state.pendingLoad) return;
      const candidate = requirementsHandoff;
      const result = await replaceSession(emptySession(candidate.payload, candidate.title));
      if (result.ok && result.saved) {
        try { if (sessionStorage.getItem(key) === candidate.raw) sessionStorage.removeItem(key); } catch { /* The imported editor session remains saved. */ }
        requirementsHandoff = null; banner.classList.add('hidden'); clearQuery();
      } else if (result.ok) {
        text.textContent = '图表已打开，但浏览器尚未保存成功。导入副本仍保留，请先下载图表；排除保存错误后可再次打开。';
      } else if (!result.cancelled) text.textContent = '打开未完成：' + (result.error || '请等待当前操作完成后重试') + '。原图表与生成结果均保留。';
    };
    setBusyUi(state.busy);
  }

  async function importDiagram(file) {
    if (!file || state.busy || state.sessionBusy) return;
    try {
      const limit = state.config.limits.maxFileChars || 200000;
      if (file.size > limit * 4) throw new Error('文件过大，请先拆分图表');
      const payload = (await file.text()).replace(/^\uFEFF/, '');
      const resp = await fetch('/api/diagrams/validate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload }) });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error?.message || '文件校验失败');
      return await replaceSession(emptySession(result.payload, file.name.replace(/\.(drawio|xml)$/i, '')));
    } catch (e) { showToast('导入失败：' + e.message, 'error'); return { ok: false, error: e.message }; }
  }

  async function recoverSession(key = 'current', options = {}) {
    if (!session.repository) await reconnectSessionStorage();
    if (!session.repository) return { ok: false, error: '本地存储不可用' };
    if (state.busy || state.sessionBusy || state.pendingLoad) return { ok: false, error: '请等待当前操作完成' };
    try {
      const record = await session.repository.read(key);
      if (!record) throw new Error(key === 'previous' ? '尚无上一份会话备份' : '尚无已保存会话');
      if (session.blocked) {
        if (!options.confirmed && !window.confirm('本页存在保存冲突。请先下载当前图表。继续将恢复已保存会话并替换本页内容。')) return { ok: false, cancelled: true };
        session.storeRevision = await session.repository.revision();
        session.blocked = false;
        session.dirty = false;
        session.suspended = true;
        // Do not publish the stale local copy over the other tab's checkpoint.
        options = { ...options, confirmed: true, recoveringConflict: true };
      }
      const recovered = await replaceSession(record.data, options);
      if (!recovered.ok && options.recoveringConflict) {
        session.blocked = true;
        session.suspended = false;
        setSaveStatus('恢复失败 · 原存储记录保留，请重试恢复', true);
      }
      return recovered;
    } catch (e) { showToast('恢复失败：' + e.message + '；原备份保留', 'error'); return { ok: false, error: e.message }; }
  }

  // ---------- draw.io embed 协议 ----------
  function postToEditor(msg) {
    if (!frame.contentWindow) return;
    const target = state.config.embedOrigin || '*';
    frame.contentWindow.postMessage(JSON.stringify(msg), target);
  }

  function onWindowMessage(evt) {
    if (!frame.contentWindow || evt.source !== frame.contentWindow) return;
    if (typeof evt.data !== 'string') return;
    const expected = state.config.embedOrigin;
    if (expected && evt.origin && evt.origin !== expected) {
      if (!state.originWarning) {
        state.originWarning = true;
        console.warn('[DiagramAI] 忽略了来源不匹配的编辑器消息:', evt.origin, '期望:', expected);
      }
      return;
    }
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    handleEditorMessage(msg, { origin: evt.origin });
  }

  /** 从载荷里取出当前页的明文 mxGraphModel（压缩页返回 null，交给服务端解压） */
  function deriveModel(payload, pageIndex) {
    const info = File.parseFile(payload);
    if (info.kind === 'model') return payload;
    if (info.kind !== 'mxfile' || info.pages.length === 0) return null;
    const index = File.clampPageIndex(Number.isInteger(pageIndex) ? pageIndex : 0, info.pages.length);
    const page = info.pages[index];
    if (!page || page.encoding !== 'xml' || !page.modelNode) return null;
    return Xml.sliceNode(payload, page.modelNode);
  }

  /** 页面结构签名：页面数量或顺序/身份发生变化时签名变化（用于冲突检测） */
  function pagesSignature(payload) {
    const info = File.parseFile(payload || '');
    if (info.kind !== 'mxfile') return 'model';
    return info.pages.map((p) => (p.id !== null && p.id !== undefined ? p.id : p.name)).join('|');
  }

  /**
   * 比较图表语义，排除编辑器重排属性、缩进、视图尺寸与保存元数据。
   * 节点属性、几何、连线和页面身份仍完整参与比较。
   */
  function canonical(text) {
    const source = String(text == null ? '' : text);
    try {
      const viewAttrs = new Set(['dx', 'dy']);
      const saveAttrs = new Set(['modified', 'agent', 'version', 'host', 'etag']);
      function visit(node) {
        const ignored = node.name === 'mxGraphModel' ? viewAttrs : node.name === 'mxfile' ? saveAttrs : null;
        return [node.name,
          Object.entries(node.attributes).filter(([name]) => !ignored?.has(name)).sort(([a], [b]) => a.localeCompare(b)),
          node.textParts.map((p) => p.value).filter((value) => value.trim() !== ''),
          node.children.map(visit)];
      }
      return JSON.stringify(visit(Xml.parse(source).root));
    } catch (e) {
      return source.replace(/\r\n?/g, '\n').trim();
    }
  }

  /**
   * 「目标页内容」指纹。这是 R1 的关键：draw.io 的 autosave 可能晚于 getDiff 到达，
   * 因此不能只用 revision（autosave 驱动）判断有没有手工编辑 —— 必须把请求提交时
   * 查询到的目标页内容记下来，响应后重新查询并比较实际内容。
   * 压缩页无法在浏览器侧读明文 → 用密文文本比较（内容变化时密文必然变化）。
   */
  function pageContentFingerprint(payload, pageId) {
    const info = File.parseFile(payload || '');
    if (info.kind === 'model') return canonical(payload);
    if (info.kind !== 'mxfile') return 'unreadable';
    const index = (pageId !== null && pageId !== undefined)
      ? File.findPageIndexById(info, pageId)
      : state.pageIndex;
    const page = info.pages[index];
    if (!page) return 'missing-page';
    if (page.encoding === 'empty') return 'empty';
    if (page.encoding === 'encoded') return 'encoded:' + (page.encodedText || '');
    if (!page.modelNode) return 'unknown-page';
    return canonical(Xml.sliceNode(payload, page.modelNode));
  }

  /** 文档指纹：整份载荷的内容比较（覆盖「等待期间改了别的页」） */
  function docFingerprint(payload) {
    return canonical(payload);
  }

  function syncFromPayload(payload, meta) {
    const options = meta || {};
    const previous = state.payload;
    const previousPage = state.pageIndex;
    state.payload = payload;
    const info = File.parseFile(payload);
    state.payloadKind = info.kind;
    state.pageCount = info.kind === 'mxfile' ? (info.pageCount || 1) : 1;
    if (Number.isInteger(options.currentPage) && options.currentPage >= 0) {
      state.pageIndex = Math.min(options.currentPage, Math.max(0, state.pageCount - 1));
    } else if (state.pageIndex >= state.pageCount) {
      state.pageIndex = 0;
    }
    if (info.kind === 'mxfile' && info.pages[state.pageIndex]) {
      const page = info.pages[state.pageIndex];
      state.pageId = page.id !== null && page.id !== undefined ? String(page.id) : (page.name || null);
    } else {
      state.pageId = null;
    }
    state.modelXml = deriveModel(payload, state.pageIndex);
    setCanvasStatus();
    
    if (previousPage !== state.pageIndex || docFingerprint(previous) !== docFingerprint(payload)) markSessionDirty();
  }

  /** 向编辑器发一个「会回显 message.token」的查询，返回该查询的完整消息体 */
  function queryEditor(action, payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!state.ready || !frame.contentWindow) {
        resolve({ ok: false, error: '编辑器尚未就绪' });
        return;
      }
      const token = 'q-' + (++state.querySeq);
      const timer = setTimeout(() => {
        if (state.queryWaiters.has(token)) {
          state.queryWaiters.delete(token);
          resolve({ ok: false, error: '编辑器未响应查询' });
        }
      }, timeoutMs || SYNC_TIMEOUT_MS);
      state.queryWaiters.set(token, { resolve, timer, action });
      postToEditor(Object.assign({ action }, payload || {}, { token }));
    });
  }

  /**
   * 严格解析 viewbox 回执里的 currentPage。
   *
   * 真实 embed 回发的是 number；为了兼容某些封装层，只额外接受
   * 「完整的十进制非负整数字符串」（`/^(?:0|[1-9][0-9]*)$/`）。
   * **绝不能用 `Number()` 做归一化**：`Number(null)===0`、`Number('')===0`、
   * `Number(false)===0`、`Number(' 1 ')===1`、`Number('1e0')===1`，会把异常回执
   * 伪装成「第 0 页」，进而把 AI 结果写到错误的页面。
   * 明确拒绝：null / undefined / '' / 布尔值 / 负数 / 小数 / NaN / 非数字字符串 /
   * 带符号或空白或前导零的字符串。
   * @returns {{ok: true, value: number} | {ok: false}}
   */
  function parsePageIndex(raw) {
    if (typeof raw === 'number') {
      return (Number.isInteger(raw) && raw >= 0) ? { ok: true, value: raw } : { ok: false };
    }
    if (typeof raw === 'string') {
      return PAGE_INDEX_STRING_RE.test(raw) ? { ok: true, value: Number(raw) } : { ok: false };
    }
    return { ok: false };
  }

  /**
   * 提交前 / 响应后的状态同步。
   *
   * R2 的关键：两个查询**分别判定**，并且必须校验回执「内容」——
   *   - pageOk：viewbox 回执里必须有合法的 currentPage（严格类型 + 范围）
   *   - docOk ：getDiff 回执里必须有非空的 xml
   * 只收到「任意匹配 token 的回执」不算成功（旧实现用 `viewbox || getDiff`，
   * 导致多页文档只拿到 getDiff 时仍拿缓存的页索引继续提交，可能改错页）。
   *
   * 页索引的处理顺序（不可颠倒）：
   *   1. 严格校验原始类型（不得让 null/''/false 经 Number 变成 0）
   *   2. 先用 getDiff 落文档 → 得到**真实页数**
   *   3. 再校验范围 `0 <= currentPage < pageCount`，**绝不 clamp / Math.min**
   * 异常回执（类型不合法或越界）一律判为定位失败：它不提供可靠的页面信息，
   * 客户端不能猜出目标页。
   */
  async function syncWithEditor(options) {
    const opts = options || {};
    if (!state.ready) {
      return { ok: false, pageOk: false, docOk: false, pageProblem: 'not-ready', error: '编辑器尚未就绪' };
    }
    const timeout = opts.timeout || SYNC_TIMEOUT_MS;
    const [pageReply, docReply] = await Promise.all([
      queryEditor('viewbox', { viewbox: null }, timeout),
      queryEditor('getDiff', {}, timeout),
    ]);

    // ① 回执与原始值。缺回执 = 查询超时；有回执但值不合法 = 类型错误
    const hasPageReply = Boolean(pageReply && pageReply.ok === true && pageReply.body != null);
    const parsed = parsePageIndex(hasPageReply ? pageReply.body.currentPage : undefined);

    const docXml = (docReply.ok && docReply.body && typeof docReply.body.xml === 'string')
      ? docReply.body.xml
      : '';
    const docOk = docXml.trim() !== '';

    // ② 先落文档（页数以最新文档为准），再做范围校验
    if (docOk) syncFromPayload(docXml, { currentPage: null });
    const pageCount = Math.max(1, Number(state.pageCount) || 1);

    let pageProblem = null; // 'timeout' | 'type' | 'range' | null
    if (!hasPageReply) pageProblem = 'timeout';
    else if (!parsed.ok) pageProblem = 'type';
    else if (parsed.value >= pageCount) pageProblem = 'range';
    const pageOk = pageProblem === null;
    const pageInvalid = pageProblem === 'type' || pageProblem === 'range';

    // ③ 只有通过类型 + 范围校验的索引才会被用来定位目标页（不 clamp）
    if (pageOk) {
      const previousPage = state.pageIndex;
      state.pageIndex = parsed.value;
      const info = File.parseFile(state.payload || '');
      if (info.kind === 'mxfile' && info.pages[state.pageIndex]) {
        const page = info.pages[state.pageIndex];
        state.pageId = page.id !== null && page.id !== undefined ? String(page.id) : (page.name || null);
      } else if (info.kind === 'model') {
        state.pageId = null;
      }
      state.modelXml = deriveModel(state.payload, state.pageIndex);
      setCanvasStatus();
        
      if (previousPage !== state.pageIndex) markSessionDirty();
    }

    const pageMessage = {
      timeout: '当前页查询超时或没有回执',
      type: 'viewbox 回执的 currentPage 不是合法的非负整数（类型不合法）',
      range: `viewbox 回执的 currentPage 超出文档页数范围（要求 0 ≤ index < ${pageCount}）`,
    }[pageProblem] || null;

    let error = null;
    if (!docOk && !pageOk) error = `编辑器未返回有效的当前页与最新文档（${pageMessage || '文档内容为空'}）`;
    else if (!docOk) error = '编辑器未返回有效的文档内容（getDiff 回执缺少 xml）';
    else if (!pageOk) error = `编辑器未返回有效的当前页：${pageMessage}`;
    if (error) state.syncFailures += 1;

    return {
      ok: pageOk && docOk,
      pageOk,
      docOk,
      pageProblem,
      pageInvalid,
      pageCount,
      pageIndex: state.pageIndex,
      pageId: state.pageId,
      error,
    };
  }

  /** 同步不可用时的可操作提示（区分「页定位失败」（含类型/越界/超时）与「文档获取失败」） */
  function syncBlockMessage(sync, needPage, phase) {
    if (!sync.docOk && (!needPage || !sync.pageOk)) {
      return `${phase}无法获取编辑器的最新文档（getDiff 无有效回执）。无法确认画布在等待期间是否被改动，为避免覆盖你的手工编辑，本次请求已停止，画布与原图保持不变，请稍后重试。`;
    }
    if (!sync.docOk) {
      return `${phase}无法获取编辑器的最新文档（getDiff 无有效回执），本次请求已停止，请稍后重试。`;
    }
    const reason = sync.error || 'viewbox 没有返回有效的当前页';
    return `${phase}${reason}。文档共 ${sync.pageCount || state.pageCount} 页，为避免把结果写到错误的页面，本次请求已停止，请稍后重试。`;
  }


  function handleEditorMessage(msg, meta) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.event === 'init') {
      state.ready = true;
      // 编辑器已就绪，停掉加载看门狗，避免它稍后再把提示区改成失败态
      clearTimeout(editorWatchdog);
      clearTimeout(editorRetryTimer);
      editorLoading.classList.add('hidden');
      setBusyUi(state.busy);
      if (navigationLoad) {
        const operation = navigationLoad;
        navigationLoad = null; clearTimeout(operation.timer);
        loadIntoEditor(operation.payload).then(operation.resolve);
        return;
      }
      const initial = state.payload || EMPTY_MODEL;
      loadIntoEditor(initial).then((res) => {
        if (!res.ok && !res.cancelled) showToast('编辑器初始化加载失败：' + res.error, 'error');
        setBusyUi(state.busy);
        if (res.ok) void resumeDrawingTask();
      });
      return;
    }

    if (msg.event === 'load') {
      state.loadCount += 1;
      state.lastLoadInfo = {
        bounds: msg.bounds || null,
        scale: msg.scale,
        pageVisible: msg.pageVisible,
        currentPage: msg.currentPage,
        at: Date.now(),
      };
      const pending = state.pendingLoad;
      const echo = typeof msg.xml === 'string' ? msg.xml : null;
      if (pending && echo !== null && echo === pending.payload) {
        // 回执与本次操作逐字节匹配 → 确认成功
        state.pendingLoad = null;
        clearTimeout(pending.timer);
        syncFromPayload(msg.xml, msg);
        pending.resolve({ ok: true });
      } else {
        // 过期 / 不匹配 / 无人等待的回执：既不确认任何操作，也不改动当前状态
        state.staleReceipts += 1;
        console.warn('[DiagramAI] 忽略过期或不匹配的加载回执（待确认操作：' + (pending ? pending.token : '无') + '）');
      }
      return;
    }

    if (msg.event === 'autosave') {
      if (session.suspended || state.sessionBusy || navigationLoad) return;
      // 加载后可能收到仅重排 XML / 更新视图与元数据的 autosave，不计为手工修改。
      if (typeof msg.xml === 'string' && msg.xml) {
        const previous = state.payload;
        const changed = docFingerprint(msg.xml) !== docFingerprint(previous);
        syncFromPayload(msg.xml, msg);
        if (changed) {
          state.revision += 1;
          setCanvasStatus();
          markSessionDirty();
        }
      }
      return;
    }

    if (msg.event === 'export') {
      const token = msg.message?.token;
      const pending = token ? state.exportWaiters.get(token) : null;
      if (pending && msg.format === pending.format) {
        pending.finish(msg.error ? {ok:false,error:msg.error} : {ok:true,data:msg.data,format:msg.format,body:msg});
      }
      return;
    }

    // 查询类回执（viewbox / getDiff / fit）：必须同时匹配 token 与动作类型
    if (msg.event === 'viewbox' || msg.event === 'getDiff' || msg.event === 'fit') {
      const token = msg.message && msg.message.token;
      const waiter = token ? state.queryWaiters.get(token) : null;
      if (waiter && waiter.action === msg.event) {
        state.queryWaiters.delete(token);
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: true, body: msg });
      } else if (waiter) {
        // 回执类型与请求的动作不一致：不确认任何操作
        state.staleQueryReceipts += 1;
        console.warn('[DiagramAI] 忽略与请求动作不匹配的查询回执：期望 ' + waiter.action + '，收到 ' + msg.event);
      }
      return;
    }
  }

  /** 显式结束当前待处理的加载事务（不允许留下悬空 resolver） */
  function settlePendingLoad(result) {
    const pending = state.pendingLoad;
    if (!pending) return false;
    state.pendingLoad = null;
    clearTimeout(pending.timer);
    pending.resolve(result);
    return true;
  }

  /**
   * 把载荷写入画布并等待编辑器确认。
   * 事务语义：同一时刻只允许一个待确认加载；新的加载会先显式结束旧的（cancelled），
   * 回执必须与本次载荷逐字节一致才会确认。
   * options.dryRun 仅用于测试：不真正向编辑器发送，由测试注入回执。
   */
  function loadIntoEditor(payload, options) {
    const opts = options || {};
    return new Promise((resolve) => {
      if (!state.ready || !frame.contentWindow) {
        resolve({ ok: false, error: '编辑器尚未就绪' });
        return;
      }
      if (state.pendingLoad) {
        settlePendingLoad({ ok: false, cancelled: true, error: '被新的加载操作取代' });
      }
      const token = 'load-' + (++state.loadSeq);
      const timer = setTimeout(() => {
        if (state.pendingLoad && state.pendingLoad.token === token) {
          state.pendingLoad = null;
          resolve({ ok: false, timeout: true, error: `编辑器在 ${Math.round(loadTimeoutMs / 1000)} 秒内没有确认加载` });
        }
      }, loadTimeoutMs);
      state.pendingLoad = { token, payload, resolve, timer, at: Date.now(), label: opts.label || '' };
      if (opts.dryRun) return;
      postToEditor({ action: 'load', xml: payload, autosave: 1 });
    });
  }

  function requestExport(options = {}) {
    return new Promise(resolve => {
      if (!state.ready) { resolve({ok:false,error:'编辑器尚未就绪'}); return; }
      const { signal, timeout = EXPORT_TIMEOUT_MS, ...payload } = options;
      if (signal?.aborted) { resolve({ok:false,cancelled:true,error:'导出已取消'}); return; }
      const token='export-'+(++state.exportSeq);
      const record={format:payload.format || 'svg',finish:result=>{
        clearTimeout(record.timer); signal?.removeEventListener('abort',abort);
        state.exportWaiters.delete(token);resolve(result);
      }};
      const abort=()=>record.finish({ok:false,cancelled:true,error:'导出已取消'});
      record.timer=setTimeout(()=>record.finish({ok:false,error:'导出超时，请重试或检查编辑器是否支持此导出格式'}),timeout);
      signal?.addEventListener('abort',abort,{once:true});
      state.exportWaiters.set(token,record);
      postToEditor({...payload,action:'export',token});
    });
  }

  function renderEditContext() {
    updateVisionControls();
    const context=state.editContext;
    el('clearEditBtn').classList.toggle('hidden',!context);
    el('editScopeText').textContent=context
      ? context.invalid ? '选区未锁定，请重新选择' : `已锁定 ${context.targetIds.length} 个元素：${context.labels.join('、')}`
      : '当前整页';
    el('editScopeText').title=el('editScopeText').textContent;
  }
  function clearEditContext() { state.editContext=null;renderEditContext();markSessionDirty(); }
  function refreshEditContext(context) {
    try {
      const scope=Edit.resolveScope(state.modelXml,context.targetIds);
      state.editContext={baseXml:state.modelXml,targetIds:scope.targetIds,pageId:state.pageId,pageIndex:state.pageIndex,labels:scope.cells.map(c=>c.label||c.id)};
      renderEditContext();markSessionDirty();
    } catch {clearEditContext();}
  }
  el('clearEditBtn').addEventListener('click',clearEditContext);
  async function captureEditSelection() {
    if(state.busy||state.sessionBusy||state.pendingLoad||state.editCapturing)return {ok:false,error:'请等待当前操作完成'};
    state.editCapturing=true;state.editContext={invalid:true};renderEditContext();markSessionDirty();setBusyUi(state.busy);
    try {
      const pre=await syncWithEditor();
      if(!pre.docOk||pre.pageInvalid||(state.pageCount>1&&!pre.pageOk)||!state.modelXml)throw new Error('无法读取当前页，请重试');
      const pageId=state.pageId,pageIndex=state.pageIndex,baseline=docFingerprint(state.payload);
      const result=await requestExport({format:'json',selection:true,allPages:false,timeout:SYNC_TIMEOUT_MS});
      if(!result.ok)throw new Error(result.error);
      const pages=result.data?.pages;
      if(!Array.isArray(pages)||pages.length!==1||!Array.isArray(pages[0].cells))throw new Error('编辑器未返回有效选区，请检查是否支持 JSON 选区导出');
      const post=await syncWithEditor();
      if(!post.docOk||post.pageInvalid||(state.pageCount>1&&!post.pageOk)||state.pageId!==pageId||state.pageIndex!==pageIndex||docFingerprint(state.payload)!==baseline)throw new Error('读取选区期间图表或页面发生变化，请重新选择');
      if(result.body.currentPage!==pageIndex||pageId!==null&&pages[0].id!==pageId)throw new Error('选区不属于当前页，请重新选择');
      const ids=pages[0].cells.filter(c=>['node','group','edge'].includes(c.type)).map(c=>c.id);
      if(!ids.length)throw new Error('没有选中节点或连线，请在画布中选择后再点「修改选中」');
      const scope=Edit.resolveScope(state.modelXml,Edit.minimizeTargets(state.modelXml,ids));
      state.editContext={targetIds:scope.targetIds,pageId,pageIndex,baseXml:state.modelXml,labels:scope.cells.map(c=>c.label||c.id)};
      renderEditContext();markSessionDirty();setHint('已锁定选区。输入修改要求后发送；要修改整页请点「退出局部」。');
      chatInput.focus();return {ok:true,targetIds:scope.targetIds};
    } catch(e) { setHint(e.message);showToast(e.message,'error');return {ok:false,error:e.message}; }
    finally {state.editCapturing=false;setBusyUi(state.busy);}
  }
  el('modifySelectionBtn').addEventListener('click',captureEditSelection);

  // ---------- 多模态对话：每次发送获取当前画面 ----------
  function visionModel(selection=state.selection) {
    if(!selection||selection.providerId==='mock'||!validateSelection(selection).valid)return null;
    const provider=state.modelCatalog?.providers?.find(p=>p.providerId===selection.providerId);
    const model=provider?.models?.find(m=>m.modelId===selection.modelId);
    return model?.visionInput===true?{provider,model}:null;
  }
  function visionFingerprint(){return JSON.stringify([state.pageId,state.pageIndex,canonical(state.modelXml||''),state.visionRefVersion]);}
  function updateVisionControls(){
    const locked=state.busy||state.sessionBusy||state.editCapturing||Boolean(state.pendingLoad)||!state.ready||Boolean(state.pendingResult)||Boolean(state.visionImporting);
    el('multimodalToggle').disabled=state.busy||state.sessionBusy||state.editCapturing||state.thinkingSaving||Boolean(state.reasoningDetection)||(!state.multimodalEnabled&&!visionModel());
    el('multimodalToggle').setAttribute?.('aria-checked',String(state.multimodalEnabled));
    el('multimodalToggle').classList.toggle('on',state.multimodalEnabled);
    el('multimodalToggle').title=visionModel()?'开启后，每次发送附上当前画面，结合对话上下文识图和修改。':'多模态需要支持图片输入的模型；请在模型设置中声明能力或关闭多模态。';
    el('visionPrompt').disabled=locked;
    el('visionReferenceInput').disabled=locked;
    el('clearVisionReferenceBtn').disabled=locked;
    {
      const config=visionModel(state.selection);
      el('visionStatus').textContent=config?(state.visionPhase||`将使用 ${config.provider.name} / ${config.model.displayName}；${state.multimodalEnabled?'每次发送附上最新画面，支持继续追问和修改。':'开启右侧多模态后，每次对话结合当前画面。'}`):'当前模型未声明支持图片输入。请在模型设置中声明，或选择支持图片的模型。';
    }
  }
  function renderVision(){
    el('visionSummary').textContent='参考与补充';
    el('visionPanel').classList.toggle('hidden',!state.multimodalEnabled&&!state.visionReference);
    el('visionStatus').textContent=state.visionPhase;
    el('visionReferenceName').textContent=state.visionReference?.name||'未添加';
    el('clearVisionReferenceBtn').classList.toggle('hidden',!state.visionReference);
    const ref=el('visionReferencePreview');ref.classList.toggle('hidden',!state.visionReference);ref.src=state.visionReference?.data||'';
    el('visionScreenshot').classList.toggle('hidden',!state.visionPreview);el('visionScreenshot').src=state.visionPreview||'';
    updateVisionControls();
    renderAttachments();
  }
  function appendBubbleImages(bubble,images){
    bubble.sessionImages=images.slice();
    const row=document.createElement('div');row.className='bubble-images';
    for(const [index,data] of images.entries()){
      const img=document.createElement('img');img.src=data;img.alt=`发送的图片 ${index+1}`;window.DiagramImageViewer?.bind(img);row.appendChild(img);
    }
    bubble.appendChild(row);markSessionDirty();
  }
  function renderAttachments(){
    const locked=state.busy||state.sessionBusy||state.editCapturing||state.attachmentsImporting;
    el('attachImageBtn').disabled=!state.multimodalEnabled||!visionModel()||locked;
    el('chatImageInput').disabled=el('attachImageBtn').disabled;
    el('attachImageBtn').title=state.multimodalEnabled?'添加图片（PNG / JPEG，最多 3 张，可粘贴或拖入）':'开启多模态后添加图片';
    const tray=el('chatAttachments');tray.innerHTML='';
    tray.classList.toggle('hidden',!state.attachments.length);tray.classList.toggle('off',!state.multimodalEnabled);
    for(const item of state.attachments){
      const tile=document.createElement('div');tile.className='chat-image-tile';
      const image=document.createElement('img');image.src=item.data;image.alt=item.name;
      window.DiagramImageViewer?.bind(image);
      const name=document.createElement('span');name.textContent=item.name;name.title=item.name;
      const remove=document.createElement('button');remove.type='button';remove.className='chat-image-remove';remove.textContent='×';remove.title='移除图片';remove.setAttribute?.('aria-label','移除 '+item.name);remove.disabled=locked;
      remove.onclick=()=>{state.attachments=state.attachments.filter(i=>i!==item);renderAttachments();markSessionDirty();};
      tile.appendChild(image);tile.appendChild(name);tile.appendChild(remove);tray.appendChild(tile);
    }
    if(!state.multimodalEnabled&&state.attachments.length){const note=document.createElement('span');note.textContent='开启多模态后可发送这些图片';tray.appendChild(note);}
  }
  async function addChatImages(files){
    if(!state.multimodalEnabled){setHint('请先开启「多模态」，再添加图片。');return {ok:false,reason:'multimodal-off'};}
    if(!visionModel()){setHint('请选择支持图片输入的模型。');return {ok:false,reason:'vision-unavailable'};}
    if(state.busy||state.sessionBusy||state.editCapturing||state.attachmentsImporting)return {ok:false,reason:'busy'};
    const version=state.attachmentVersion;
    state.attachmentsImporting=true;renderAttachments();
    try{
      const list=Array.from(files||[]);if(!list.length)return {ok:true};
      if(list.length+state.attachments.length>3)throw new Error('每条消息最多添加 3 张图片');
      const added=[];
      for(const file of list){
        if(!['image/png','image/jpeg'].includes(file.type)||file.size>Vision.MAX_IMAGE_BYTES)throw new Error('图片仅支持 3 MB 以内的 PNG / JPEG');
        const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取图片'));reader.readAsDataURL(file);});
        const checked=Vision.validateImage(data);
        await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve();image.onerror=()=>reject(new Error('图片无法解码'));image.src=data;});
        added.push({data:checked.data,name:file.name||'粘贴图片'});
      }
      if(version!==state.attachmentVersion||!state.multimodalEnabled||state.busy||state.sessionBusy)throw new Error('当前操作已变化，请重新添加图片');
      Vision.validateImages([...state.attachments,...added].map(i=>i.data));
      state.attachments.push(...added);markSessionDirty();setHint('');return {ok:true};
    }catch(e){showToast(e.message,'error');return {ok:false,error:e.message};}
    finally{state.attachmentsImporting=false;renderAttachments();}
  }
  async function setVisionReference(file){
    if(state.busy||state.editCapturing||state.sessionBusy)return {ok:false,error:'请等待当前操作完成'};
    if(state.visionImporting)return {ok:false,error:'正在读取参考图'};
    if(!file){state.visionReference=null;state.visionRefVersion++;renderVision();return {ok:true};}
    const version=state.visionRefVersion;state.visionImporting=true;updateVisionControls();
    try{
      if(!['image/png','image/jpeg'].includes(file.type)||file.size>Vision.MAX_IMAGE_BYTES)throw new Error('参考图仅支持 3 MB 以内的 PNG / JPEG');
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取参考图'));reader.readAsDataURL(file);});
      const checked=Vision.validateImage(data);
      await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve();image.onerror=()=>reject(new Error('参考图无法解码'));image.src=data;});
      if(state.busy||state.sessionBusy||version!==state.visionRefVersion)throw new Error('当前操作已变化，请重新添加参考图');
      state.visionReference={data:checked.data,name:file.name,width:checked.width,height:checked.height};state.visionRefVersion++;renderVision();return {ok:true};
    }catch(e){showToast(e.message,'error');return {ok:false,error:e.message};}
    finally{state.visionImporting=false;updateVisionControls();}
  }
  async function prepareVisionSnapshot(signal){
    signal?.throwIfAborted();
    const sync=await syncWithEditor({timeout:SYNC_TIMEOUT_MS});signal?.throwIfAborted();
    if(!sync.ok||!state.modelXml)throw new Error(sync.error||'无法读取当前页 XML');
    const baseline={payload:state.payload,baseXml:state.modelXml,pageId:state.pageId,pageIndex:state.pageIndex,doc:docFingerprint(state.payload),fingerprint:visionFingerprint(),refVersion:state.visionRefVersion};
    const png=await requestExport({format:'png',currentPage:true,scale:1.5,border:20,signal});signal?.throwIfAborted();
    if(!png.ok)throw new Error('截图导出失败：'+png.error);
    const image=Vision.validateImage(png.data);
    // Require an XML echo corresponding to this export and a stable before/after page.
    if(typeof png.body?.xml!=='string')throw new Error('截图导出未返回可核对的 XML，未发送给模型');
    const echoed=deriveModel(png.body.xml,baseline.pageIndex);
    if(!echoed||canonical(echoed)!==canonical(baseline.baseXml))throw new Error('截图回执与当前页不一致，请重新检查');
    const post=await syncWithEditor({timeout:SYNC_TIMEOUT_MS});signal?.throwIfAborted();
    if(!post.ok||baseline.fingerprint!==visionFingerprint()||baseline.doc!==docFingerprint(state.payload))throw new Error('截图期间图表、页面或参考图已变化，请重新检查');
    state.visionPreview=image.data;renderVision();
    return {...baseline,image:image.data,width:image.width,height:image.height,reference:state.visionReference?.data||null};
  }
  function toggleMultimodal(){
    if(state.busy||state.sessionBusy||state.editCapturing||state.thinkingSaving)return {ok:false};
    if(!state.multimodalEnabled&&!visionModel())return {ok:false,error:'请选择支持图片输入的模型'};
    state.multimodalEnabled=!state.multimodalEnabled;
    try{localStorage.setItem(MULTIMODAL_KEY,String(state.multimodalEnabled));}catch(e){}
    renderVision();return {ok:true,enabled:state.multimodalEnabled};
  }
  el('multimodalToggle').addEventListener('click',toggleMultimodal);
  el('visionReferenceInput').addEventListener('change',async e=>{const file=e.target.files?.[0];if(file)await setVisionReference(file);e.target.value='';});
  el('clearVisionReferenceBtn').addEventListener('click',()=>setVisionReference(null));


  // ---------- 快照 ----------
  function takeSnapshot(label) {
    const snapshot = {
      id: 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      label: label || '画布快照',
      payload: state.payload,
      pageIndex: state.pageIndex,
      pageId: state.pageId,
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    };
    if (!snapshot.payload) return null;
    state.snapshots.push(snapshot);
    if (state.snapshots.length > SNAPSHOT_LIMIT) state.snapshots.shift();
    markSessionDirty();
    return snapshot;
  }

  async function restoreSnapshot(id) {
    const snapshot = id
      ? state.snapshots.find((s) => s.id === id)
      : state.snapshots[state.snapshots.length - 1];
    if (state.sessionBusy || state.editCapturing) return { ok: false, error: '请等待当前操作完成' };
    if (!snapshot) { showToast('没有可恢复的快照', 'error'); return { ok: false, error: 'no-snapshot' }; }
    const res = await loadIntoEditor(snapshot.payload, { label: '恢复快照' });
    if (!res.ok) {
      showToast(res.cancelled ? '恢复被新的操作取代' : '恢复失败：' + res.error, res.cancelled ? null : 'error');
      return res;
    }
    state.revision += 1;
    setCanvasStatus();
    markSessionDirty();
    showToast(`已恢复到快照（${snapshot.label}，${snapshot.time}）`);
    return { ok: true };
  }

  // ---------- 校验 ----------
  /** 校验待写入画布的载荷：必须可解析，且目标页模型通过结构校验 */
  function validatePayload(payload, pageIndex) {
    const info = File.parseFile(payload);
    if (info.kind === 'empty') return { ok: false, error: '内容为空' };
    if (info.kind === 'invalid') return { ok: false, error: `XML 非法：${info.error.message}` };
    if (info.kind === 'unknown') return { ok: false, error: info.error.message };
    const index = File.clampPageIndex(Number.isInteger(pageIndex) ? pageIndex : state.pageIndex, info.pages.length);
    const page = info.kind === 'model' ? info.pages[0] : info.pages[index];
    if (!page) return { ok: false, error: '目标页面不存在' };
    if (page.encoding === 'encoded') return { ok: true, skipped: 'compressed' };
    if (page.encoding === 'empty') return { ok: false, error: '目标页面为空' };
    const modelText = Xml.sliceNode(payload, page.modelNode);
    const result = Model.validateGraphModel(modelText);
    if (!result.ok) return { ok: false, error: result.error.message };
    return { ok: true, stats: result.stats };
  }

  // ---------- 应用 AI 结果 ----------
  /**
   * 把 AI 结果写回「目标页」：优先用稳定页面 id 定位；页面已被删除时放弃，绝不写到别的页。
   */
  function buildNextPayload(aiXml, pageIdOrIndex) {
    const info = File.parseFile(state.payload || '');
    if (info.kind !== 'mxfile' || info.pages.length === 0) {
      return { payload: aiXml, pageIndex: 0 };
    }
    let index = -1;
    if (pageIdOrIndex !== null && pageIdOrIndex !== undefined) {
      index = File.findPageIndexById(info, pageIdOrIndex);
    }
    if (index === -1 && Number.isInteger(pageIdOrIndex)) {
      index = (pageIdOrIndex >= 0 && pageIdOrIndex < info.pages.length) ? pageIdOrIndex : -1;
    }
    if (index === -1) {
      return { error: `目标页面（${pageIdOrIndex}）在当前文档中已不存在（可能被删除或改动了页面结构），AI 结果未写入画布` };
    }
    return { payload: File.splicePageContent(state.payload, info.pages[index], aiXml), pageIndex: index };
  }

  async function applyAiResult(result, options) {
    const opts = options || {};
    const snapshot = takeSnapshot(opts.label || 'AI 修改前');
    const target = (result.pageId !== undefined && result.pageId !== null)
      ? result.pageId
      : (Number.isInteger(result.pageIndex) ? result.pageIndex : state.pageIndex);
    const built = buildNextPayload(result.xml, target);
    if (built.error) return { ok: false, error: built.error };
    const check = validatePayload(built.payload, built.pageIndex);
    if (!check.ok) return { ok: false, error: '生成结果未通过本地校验，已保留原画布：' + check.error };
    const loaded = await loadIntoEditor(built.payload, { label: opts.label || '' });
    if (!loaded.ok) {
      return { ok: false, cancelled: loaded.cancelled, error: loaded.error };
    }
    return { ok: true, snapshotId: snapshot ? snapshot.id : null, pageIndex: built.pageIndex };
  }

  function showConflictBanner() {
    const pending=state.pendingResult;
    if(pending?.visual) {
      const label=pending.visual.mode==='multimodal'?'多模态修改':'整页视觉修复';
      el('pendingResultText').textContent=`${label}已暂存：${VisualRepair.summary(pending.visual.changes)}。确认后应用；画布变化后须重新生成。`;
      el('applyPendingBtn').textContent=`应用${label}`;
    } else if(pending?.edit) {
      el('pendingResultText').textContent=`局部修改已暂存：${Edit.summary(pending.edit.changes)}。涉及：${[...pending.edit.changes.updated,...pending.edit.changes.added,...pending.edit.changes.removed].slice(0,12).map(c=>c.label||c.id).join('、')}${pending.edit.changes.total>12?' 等 '+pending.edit.changes.total+' 个元素':''}。确认后应用；已被修改的目标会再次检查。`;
      el('applyPendingBtn').textContent='应用局部修改';
    } else {
      el('pendingResultText').textContent='AI 结果已暂存，未覆盖你的画布。确认后应用或丢弃。';
      el('applyPendingBtn').textContent='应用 AI 结果（会覆盖当前画布）';
    }
    conflictBanner.classList.remove('hidden');
  }

  async function applyPendingResult() {
    if(state.sessionBusy||state.busy||state.pendingLoad||state.editCapturing)return {ok:false,error:'请等待当前操作完成'};
    const local=Boolean(state.pendingResult?.edit||state.pendingResult?.visual);
    if(local){state.editCapturing=true;setBusyUi(state.busy);}
    try{return await applyPendingResultInner();}
    finally{if(local){state.editCapturing=false;setBusyUi(state.busy);}}
  }
  async function applyPendingResultInner() {
    const pending = state.pendingResult;
    if (!pending) return { ok: false, error: 'no-pending' };
    if(state.busy||state.sessionBusy||state.pendingLoad)return {ok:false,error:'请等待当前操作完成'};
    let candidate=pending;
    if(pending.visual) {
      try {
        const sync=await syncWithEditor();
        if(!sync.docOk||sync.pageInvalid||(state.pageCount>1&&!sync.pageOk))throw new Error('无法确认最新图表，请重试');
        if(state.pageId!==pending.pageId)throw new Error('请切回原目标页面后再应用视觉修复');
        if(canonical(state.modelXml)!==canonical(pending.visual.baseXml))throw new Error('画布已变化，请丢弃此结果并重新生成，避免覆盖最新编辑');
        VisualRepair.validateCandidate(pending.visual.baseXml,pending.xml,pending.visual.mode);
      }catch(e){showToast('未应用：'+e.message,'error');return {ok:false,error:e.message};}
    }
    if(pending.edit) {
      try {
        const sync=await syncWithEditor();
        if(!sync.docOk||sync.pageInvalid||(state.pageCount>1&&!sync.pageOk))throw new Error('无法确认最新图表，请重试');
        if(state.pageId!==pending.pageId)throw new Error('请切回原目标页面后再应用局部修改');
        Edit.verifyCandidate(pending.edit.baseXml,{...pending.edit,xml:pending.xml},pending.edit.targetIds);
        const rebased=Edit.rebase(pending.edit.baseXml,state.modelXml,pending.edit.patch,pending.edit.targetIds,pending.edit.idMap);
        candidate={...pending,xml:rebased.xml};
      } catch(e) {showToast('未应用：'+e.message,'error');return {ok:false,error:e.message};}
    }
    conflictBanner.classList.add('hidden');
    const applied = await applyAiResult(candidate, { label: '应用 AI 结果前' });
    if (applied.ok) {
      state.pendingResult = null;
      renderVision();
      if(pending.edit)refreshEditContext(pending.edit);
      else if(pending.visual&&state.editContext&&!state.editContext.invalid)refreshEditContext(state.editContext);
      markSessionDirty();
      showToast(pending.edit?'已应用局部修改，保留了范围之外的最新编辑':'已应用 AI 结果；你的手工编辑可通过「撤销 AI 修改」找回');
    } else {
      state.pendingResult = pending;
      showConflictBanner();
      showToast('应用失败：' + applied.error, 'error');
    }
    return applied;
  }

  // ---------- 聊天 ----------
  /**
   * @param {string} rawText
   * @param {{ selection?: { providerId: string, modelId: string } }} [options]
   *   selection 为请求开始时锁定的模型选择（重试沿用）；缺省时用当前生效选择。
   */
  function cancelRequest() {
    const request = state.activeRequest;
    if (!request || !request.canCancel || request.controller.signal.aborted) return;
    if (request.taskId) { void cancelDrawingTask(request); return; }
    request.controller.abort();
    request.setPhase?.('正在取消');
    setBusyUi(state.busy);
  }
  cancelBtn.addEventListener('click', cancelRequest);

  // ---------- Resumable drawing jobs ----------
  let taskTransport = null;
  const acknowledgedDrawingTasks = new Set();
  function drawingTransport() {
    if (!taskTransport && window.DiagramDrawingTasks) taskTransport = window.DiagramDrawingTasks.create({
      fetch: (...args) => fetch(...args), createParser: window.DiagramSse.createParser,
      onReconnect: () => state.activeRequest?.setPhase?.('正在恢复连接', '服务器继续生成，正在连接同一个任务'),
    });
    return taskTransport;
  }
  async function acknowledgeDrawingTask(id) {
    if (acknowledgedDrawingTasks.has(id) || !drawingTransport()) return;
    acknowledgedDrawingTasks.add(id);
    try { await drawingTransport().acknowledge(id); }
    catch { acknowledgedDrawingTasks.delete(id); /* Retain server copy; retry after the next durable save. */ }
  }
  async function cancelDrawingTask(request) {
    if (request.cancelPending) return;
    request.cancelRequested = true; request.cancelPending = true;
    request.setPhase?.('正在取消', '等待服务器确认取消');
    try { await drawingTransport().cancel(request.taskId); request.cancelConfirmed = true; }
    catch (error) { if (error.httpStatus !== 404) setHint('尚未确认取消，服务器可能仍在生成，请稍后再次取消。'); }
    finally { request.cancelPending = false; }
  }
  function addDrawingRecovery(bubble) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'banner-btn'; button.textContent = '恢复服务器任务';
    button.addEventListener('click', () => { if (!state.busy) void resumeDrawingTask(); }); bubble.appendChild(button);
  }
  async function resumeDrawingTask() {
    const task = state.drawingTask;
    if (!task || !state.ready || state.pendingLoad || state.busy || state.sessionBusy) return;
    if (task.status === 'settled') { void acknowledgeDrawingTask(task.taskId); return; }
    return sendMessage(task.message, { drawingTask: task });
  }

  async function readChatResponse(resp, onProgress) {
    if (!/text\/event-stream/i.test(resp.headers?.get('content-type') || '')) return resp.json();
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let result = null, failure = null, bytes = 0, terminal = false;
    const parser = window.DiagramSse.createParser(event => {
      const data = JSON.parse(event.data);
      if (terminal) throw new Error('响应在结束后继续返回事件');
      if (event.event === 'progress') onProgress(data);
      if (event.event === 'result') { result = data; terminal = true; }
      if (event.event === 'error') { failure = data; terminal = true; }
    });
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4194304) throw new Error('流式响应超过大小限制');
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      if (failure) throw Object.assign(new Error(failure.error?.message || '模型请求失败'), { turnUsage: failure.turnUsage });
      if (!result) throw new Error('生成连接中断，未收到完整结果，画布保持不变');
      return result;
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    } finally { reader.releaseLock(); }
  }

  async function sendMessage(rawText, options) {
    const recoveredTask = options?.drawingTask || null;
    const background = Boolean(recoveredTask || state.config.drawingTasksEnabled && window.DiagramDrawingTasks);
    const attachments=(recoveredTask ? recoveredTask.attachments.map(data=>({data})) : options?.attachments||[]).slice();
    const message = String(rawText == null ? '' : rawText).trim()||(attachments.length?'请看看这些图片。':'');
    if(!recoveredTask&&attachments.length&&!state.multimodalEnabled){setHint('请先开启「多模态」，再发送图片；草稿和附件已保留。');return {ok:false,reason:'multimodal-off'};}
    try{Vision.validateImages(attachments.map(i=>i.data));}catch(e){setHint(e.message);return {ok:false,reason:'invalid-images'};}
    if(state.attachmentsImporting){setHint('正在读取图片，请稍后发送。');return {ok:false,reason:'images-importing'};}
    if (!message) return { ok: false, reason: 'empty' };
    if (!recoveredTask && state.drawingTask?.status === 'pending') { setHint('上一次任务仍在服务器处理，请先恢复任务或取消。'); void resumeDrawingTask(); return {ok:false,reason:'task-pending'}; }
    if (!recoveredTask && !state.modelCatalog) { setHint('模型目录尚未加载，请稍后刷新。已有服务器任务仍会继续恢复。'); return {ok:false,reason:'catalog-loading'}; }
    if (!recoveredTask && (state.pendingResult?.edit||state.pendingResult?.visual)) {setHint('请先应用或丢弃暂存的修改，再继续发送；草稿已保留。');return {ok:false,reason:'edit-review-pending'};}
    if (state.editCapturing) return {ok:false,reason:'edit-capturing'};
    if (state.sessionBusy || state.pendingLoad) return { ok: false, reason: 'session-busy' };
    if (!recoveredTask && state.reasoningDetection) { setHint('正在检测模型档位，请等待完成或取消检测后发送。'); return {ok:false,reason:'reasoning-detection'}; }
    if (!recoveredTask && state.thinkingSaving) {
      setHint('正在保存思考模式，请稍后发送。');
      return { ok: false, reason: 'settings-saving' };
    }
    if (state.busy) {
      setHint('正在生成中：已保留你的草稿，本次发送被忽略，稍后再按 Enter 即可。');
      return { ok: false, reason: 'busy' };
    }

    // 发送即锁定：本次请求（含 XML 纠错重试）固定使用这份选择；等待期间切换只影响下一次。
    // 没有任何选择时回退到内置示例引擎（始终可用，与后端兼容逻辑一致）。
    let lockedSelection = recoveredTask?.selection || (options && options.selection) || state.selection || MOCK_OPTION;
    // R4：选择已失效时阻止发送并提示主动重选，绝不静默换模型。
    // 重试携带的原选择失效时：若用户此后已主动重新选择了其它有效模型，则按当前选择重发。
    if (!recoveredTask && lockedSelection.providerId !== 'mock' && state.modelCatalog) {
      const info = (options && options.selection) ? validateSelection(lockedSelection) : state.selectionInfo;
      if (!info || info.valid === false) {
        const current = state.selection;
        const switched = current && (current.providerId !== lockedSelection.providerId || current.modelId !== lockedSelection.modelId);
        const currentInfo = switched ? validateSelection(current) : null;
        if (currentInfo && currentInfo.valid === true) {
          setHint(`原请求的模型已失效，本次重试改用你当前选择的 ${currentInfo.providerName} / ${currentInfo.modelName}。`);
          lockedSelection = current;
        } else {
          setHint(`本次请求使用的模型已失效（${(info && info.reason) || '目录尚未同步'}）：请在模型选择器中主动重新选择后再发送。`);
          return { ok: false, reason: 'model-invalid' };
        }
      }
    }

    const editContext=recoveredTask ? recoveredTask.editContext : options && Object.prototype.hasOwnProperty.call(options,'editContext') ? options.editContext : state.editContext;
    let visualContext=recoveredTask?.visualContext||options?.visualContext||null;
    let vision=recoveredTask?.mode === 'vision' ? true : options?.vision||null;
    const useMultimodal=!recoveredTask&&state.multimodalEnabled&&!visualContext&&!vision;
    if(useMultimodal&&!visionModel(lockedSelection)){
      setHint('多模态需要支持图片输入的模型；请选择支持的模型或关闭多模态。');return {ok:false,reason:'multimodal-unavailable'};
    }
    if(!recoveredTask&&vision&&((!editContext&&!visualContext)||!visionModel(lockedSelection))){setHint('请选择支持图片输入的模型');return {ok:false,reason:'vision-unavailable'};}
    if(editContext?.invalid) {setHint('选区未锁定，请重新选择或退出局部修改');return {ok:false,reason:'edit-invalid'};}
    const seq = ++state.requestSeq;
    state.busy = true;
    const active = { controller: new AbortController(), canCancel: true, vision:Boolean(vision), taskId: recoveredTask?.taskId || null };
    let taskTerminal = false, taskCreated = Boolean(recoveredTask);
    state.activeRequest = active;
    const checkCancelled = () => active.controller.signal.throwIfAborted();
    setBusyUi(true);
    setHint('');
    const userBubble=recoveredTask ? null : addBubble('user', message);
    if(!recoveredTask&&attachments.length){appendBubbleImages(userBubble,attachments.map(i=>i.data));state.attachments=state.attachments.filter(i=>!attachments.includes(i));renderAttachments();}
    const requestStarted = Date.now();
    const source = validateSelection(lockedSelection);
    const sourceName = `${source.providerName || lockedSelection.providerId} / ${source.modelName || lockedSelection.modelId}`;
    const typing = recoveredTask ? chatBubbles.find(b=>b.sessionRole==='assistant'&&b.sessionTaskId===recoveredTask.taskId)||addBubble('assistant','','typing') : addBubble('assistant', '', 'typing');
    if (recoveredTask) typing.textContent = '';
    const turnId = recoveredTask?.turnId || (window.DiagramCloud?.enabled && TurnUsage ? crypto.randomUUID() : null);
    let turnUsage = turnId ? { ...TurnUsage.unknown(turnId), status: 'settled' } : null;
    if (turnId) typing.sessionTurnUsage = turnUsage;
    typing.classList.remove('error', 'conflict');
    typing.classList.add('typing');
    typing.classList.add('agent-progress');
    function progressElement(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    }
    const progressHeader = progressElement('div', 'agent-progress-header');
    const progressMark = progressElement('span', 'agent-progress-mark');
    progressMark.setAttribute?.('aria-hidden', 'true');
    progressMark.innerHTML = '<svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="12" r="2"/>' +
      Array.from({ length: 10 }, (_, i) => `<ellipse cx="12" cy="5" rx="1.35" ry="3.3" transform="rotate(${i * 36} 12 12)"/>`).join('') + '</svg>';
    const progressWindow = progressElement('div', 'agent-progress-window');
    progressWindow.title = sourceName;
    const progressTrack = progressElement('div', 'agent-progress-track');
    const previousItem = progressElement('div', 'agent-progress-item');
    previousItem.setAttribute?.('aria-hidden', 'true');
    const previousLabel = progressElement('div', 'agent-progress-label');
    const previousNote = progressElement('div', 'agent-progress-note');
    previousItem.appendChild(previousLabel);
    previousItem.appendChild(previousNote);
    const currentItem = progressElement('div', 'agent-progress-item');
    const progressLabel = progressElement('div', 'agent-progress-label');
    progressLabel.setAttribute?.('role', 'status');
    progressLabel.setAttribute?.('aria-live', 'polite');
    const progressNote = progressElement('div', 'agent-progress-note');
    currentItem.appendChild(progressLabel);
    currentItem.appendChild(progressNote);
    progressTrack.appendChild(previousItem);
    progressTrack.appendChild(currentItem);
    progressWindow.appendChild(progressTrack);
    const progressTime = progressElement('span', 'agent-progress-time');
    progressHeader.appendChild(progressMark);
    progressHeader.appendChild(progressWindow);
    progressHeader.appendChild(progressTime);
    typing.appendChild(progressHeader);
    let phase = '';
    let phaseNote = '';
    let progressTimer;
    let progressAnimation;
    let lastRollAt = 0;
    let progressActive = true;
    function renderProgress() {
      if (!progressActive) return;
      const now = Date.now();
      const seconds = Math.floor((now - requestStarted) / 1000);
      progressTime.textContent = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
      const note = phase.includes('等待首段') && seconds >= 30
        ? '仍在等待模型响应，复杂图表可能需要更长时间。'
        : phaseNote;
      const phaseChanged = progressLabel.textContent !== phase;
      const noteChanged = progressNote.textContent !== note;
      // Keep just two frames. Frequent token events update the current count
      // without restarting the rolling animation on every chunk.
      const roll = phaseChanged || (noteChanged && now - lastRollAt >= 1200);
      if (roll) {
        previousLabel.textContent = progressLabel.textContent;
        previousNote.textContent = progressNote.textContent;
        progressAnimation?.cancel();
        lastRollAt = now;
      }
      if (phaseChanged) progressLabel.textContent = phase;
      if (noteChanged) progressNote.textContent = note;
      progressLabel.title = phase;
      progressNote.title = note;
      if (roll && previousLabel.textContent && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
        progressAnimation = progressTrack.animate?.([
          { transform: 'translateY(0)' },
          { transform: 'translateY(-50%)' },
        ], { duration: 320, easing: 'cubic-bezier(.22,.68,0,1)' });
      }
    }
    function tickProgress() {
      renderProgress();
      if (progressActive) progressTimer = setTimeout(tickProgress, 1000);
    }
    function setPhase(text, note = '') {
      const follow = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 64;
      phase = text;
      phaseNote = note;
      renderProgress();
      if (follow) chatList.scrollTop = chatList.scrollHeight;
    }
    setPhase('正在同步画布', '读取当前图表与对话上下文');
    chatList.scrollTop = chatList.scrollHeight;
    active.setPhase = setPhase;
    let attempt = 1;
    function onProgress(progress) {
      if (active.controller.signal.aborted) return;
      if (Number.isInteger(progress.attempt)) attempt = progress.attempt;
      const labels = { waiting: '等待首段', thinking: '正在思考', generating: '正在生成',
        buffered: '已收到完整响应（接口未分段返回）', validating: '正在校验完整 XML' };
      const label = labels[progress.phase];
      if (!label) return;
      const chars = Number.isFinite(progress.chars) && progress.chars > 0 ? `已收到 ${progress.chars.toLocaleString()} 字符` : '';
      const notes = { waiting: '请求已发送，等待模型响应', thinking: '模型正在推理，输出开始后会继续生成图表', generating: chars || '正在接收模型输出', buffered: '正在处理模型返回的内容', validating: '检查图表结构，完整校验后更新画布' };
      setPhase(`${attempt > 1 ? (visualContext?'正在纠正视觉修复':editContext ? '正在纠正局部修改' : '正在纠正 XML') + '（第 ' + attempt + ' 次） · ' : ''}${progress.phase==='validating'&&visualContext?'正在校验视觉修复':progress.phase==='validating'&&editContext?'正在校验局部修改':label}`, notes[progress.phase]);
    }
    tickProgress();

    try {
      // Recovery uses the persisted request baseline; never replace it with the newly opened canvas.
      if (!recoveredTask) {
      // ① 提交前同步：分别确认「有效当前页」与「有效最新文档」
      const sync = await syncWithEditor({ timeout: SYNC_TIMEOUT_MS });
      checkCancelled();
      const needPage = state.pageCount > 1;
      // 文档拿不到 = 无法建立内容基线；
      // 页回执「存在但不合法」（类型错误 / 越界）= 协议异常，任何页数下都不能拿它定位目标页；
      // 多页且完全没有有效当前页（查询超时）= 不能拿缓存的页索引冒险。
      if (!sync.docOk || sync.pageInvalid || (needPage && !sync.pageOk)) {
        throw new Error(syncBlockMessage(sync, needPage, '提交前同步失败：'));
      }
      if(editContext) {
        if(state.pageId!==editContext.pageId||state.pageIndex!==editContext.pageIndex||canonical(state.modelXml)!==canonical(editContext.baseXml))throw new Error('已锁定的页面或图表发生变化，请重新选择后发送局部修改');
        Edit.resolveScope(state.modelXml,editContext.targetIds);
      }
      if(useMultimodal&&state.modelXml&&[...Edit.indexModel(state.modelXml).cells.values()].some(c=>c.kind!=='layer')){
        setPhase('正在获取当前画面');
        const snapshot=await prepareVisionSnapshot(active.controller.signal);checkCancelled();
        if(editContext&&(snapshot.pageId!==editContext.pageId||snapshot.pageIndex!==editContext.pageIndex||canonical(snapshot.baseXml)!==canonical(editContext.baseXml)))throw new Error('选区基线已变化，请重新选择后发送');
        vision={image:snapshot.image,reference:snapshot.reference,baseXml:snapshot.baseXml};
        if(!editContext)visualContext={baseXml:snapshot.baseXml,pageId:snapshot.pageId,pageIndex:snapshot.pageIndex,mode:'multimodal'};
        active.vision=true;
      }else if(useMultimodal&&state.modelXml){
        vision={...(state.visionReference?{reference:state.visionReference.data}:{}),baseXml:state.modelXml};
        visualContext={baseXml:state.modelXml,pageId:state.pageId,pageIndex:state.pageIndex,mode:'multimodal'};
        active.vision=true;
      }
      if(attachments.length){if(!vision)throw new Error('请开启多模态并等待画布就绪后发送图片');vision.images=attachments.map(i=>i.data);}
      }
      const autoApply=visualContext?.mode==='multimodal';
      if(!recoveredTask&&vision&&canonical(vision.baseXml)!==canonical(state.modelXml))throw new Error('视觉基线已变化，请重新检查');
      if(!recoveredTask&&visualContext&&(state.pageId!==visualContext.pageId||state.pageIndex!==visualContext.pageIndex||canonical(state.modelXml)!==canonical(visualContext.baseXml)))throw new Error('视觉修复的页面或基线已变化，请重新检查');
      const base = recoveredTask?.base || {payload:state.payload,revision:state.revision,pageIndex:state.pageIndex,pageId:state.pageId};
      const requestModel=recoveredTask ? deriveModel(base.payload,base.pageIndex) : state.modelXml;
      const requestRevision = base.revision;
      const requestPageIndex = base.pageIndex;
      const requestPageId = base.pageId;
      const requestPageSignature = pagesSignature(base.payload);
      // R1：把「提交时经过有效同步的目标页内容 / 完整文档」记录为冲突基线
      const requestDoc = docFingerprint(base.payload);
      const requestPageContent = pageContentFingerprint(base.payload, requestPageId);

      // ② 请求（携带稳定页面 id）
      setPhase(lockedSelection.providerId === 'mock' ? '正在生成示例图表' : '等待首段', '请求已发送，等待模型响应');
      const requestBody=recoveredTask ? null : JSON.stringify({
          stream: true,
          ...(vision?{vision}:{}),
          ...(vision&&useMultimodal?{multimodal:{focus:el('visionPrompt').value.trim()}}:{}),
          ...(visualContext?{editMode:visualContext.mode||'visual'}:editContext ? {editMode:'selection',targetIds:editContext.targetIds} : {}),
          message,
          history: visualContext?.mode==='visual'?[]:state.history.map(item=>({role:item.role,content:item.content,...(vision&&item.images?.length&&!attachments.length?{images:item.images}:{})})),
          currentFile: state.payload,
          currentPage: requestPageIndex,
          currentPageId: requestPageId,
          clientRevision: requestRevision,
          providerId: lockedSelection.providerId,
          modelId: lockedSelection.modelId,
        });
      if(!recoveredTask&&vision&&new Blob([requestBody]).size>Vision.MAX_BODY_BYTES)throw new Error('图片请求超过 10 MB，请减少图片或缩小图片后重发');
      if (turnId) { turnUsage = TurnUsage.unknown(turnId); typing.sessionTurnUsage = turnUsage; markSessionDirty(); }
      let resp, data;
      if (background) {
        if (!recoveredTask) {
          const id = () => crypto.randomUUID();
          state.drawingTask = window.DiagramSessions.drawingTask({taskId:turnId||id(),threadId:id(),assistantId:id(),status:'pending',
            mode:vision?'vision':'chat',message,selection:lockedSelection,turnId,base,
            editContext,visualContext,attachments:attachments.map(item=>item.data)});
          typing.sessionTaskId = state.drawingTask.taskId;
          active.taskId = state.drawingTask.taskId;
          markSessionDirty();
          if (!await flushSession() || session.dirty || session.blocked) { state.drawingTask = null; active.taskId = null; throw new Error('任务恢复信息未保存，请修复本地存储后再发送'); }
        }
        taskCreated = true;
        const descriptor = state.drawingTask;
        data = await drawingTransport().follow(descriptor, { signal:active.controller.signal,
          body:recoveredTask?null:{...JSON.parse(requestBody),taskId:descriptor.taskId,threadId:descriptor.threadId,assistantId:descriptor.assistantId,mode:descriptor.mode},
          paint: snapshot => { if (snapshot.phase) onProgress(snapshot.phase); if (active.cancelRequested && !active.cancelConfirmed) void cancelDrawingTask(active); },
        });
        resp = {ok:true};
        // A different tab may already own a newer session checkpoint. Do not
        // apply its result to this stale tab, and never ACK an unsaved branch.
        if (session.blocked || await session.repository.revision() !== session.storeRevision) throw Object.assign(new Error('会话已在其他标签页更新，请先恢复已保存会话再接收任务'), { taskDetached:true });
      } else {
        resp=await fetch(vision?'/api/vision/edit':'/api/chat',{method:'POST',signal:active.controller.signal,headers:{'Content-Type':'application/json',...(turnId?{'X-Quota-Turn-Id':turnId}:{})},body:requestBody});
        data = await readChatResponse(resp, onProgress);
      }
      turnUsage = TurnUsage?.normalize(data.turnUsage);
      checkCancelled();
      if (seq !== state.requestSeq) return { ok: true, stale: true };
      if (!resp.ok) {
        const err = (data.error && data.error.message) || `HTTP ${resp.status}`;
        throw new Error(err);
      }
      if(editContext) {
        if(data.kind!=='local-edit')throw new Error('局部请求未返回可校验的局部修改，原图保持不变');
        Edit.verifyCandidate(requestModel,data,editContext.targetIds);
      }
      if(visualContext){
        if(data.pageId!==requestPageId||data.pageIndex!==requestPageIndex)throw new Error('多模态结果未匹配当前页');
        if(visualContext.mode==='multimodal'&&data.kind==='multimodal-chat'){
          if(data.xml!=null||data.changes!=null||typeof data.reply!=='string'||!data.reply.trim()||data.requiresReview!==false)throw new Error('多模态对话结果不合法');
        }else{
          if(data.kind!==(visualContext.mode==='multimodal'?'multimodal-edit':'visual-edit'))throw new Error('视觉请求未返回匹配当前页的完整结果');
          const changes=VisualRepair.validateCandidate(requestModel,data.xml,visualContext.mode);
          if(JSON.stringify(changes)!==JSON.stringify(data.changes)||data.requiresReview!==true)throw new Error('视觉修改摘要校验失败');
        }
      }
      function recordReply() {
        // Keep the latest uploaded batch available for follow-up questions.
        if(attachments.length)state.history=state.history.map(({images,...item})=>item);
        state.history.push({ role: 'user', content: message, ...(attachments.length?{images:attachments.map(i=>i.data)}:{}) });
        state.history.push({ role: 'assistant', content: data.reply || '' });
        if (state.history.length > 16) state.history = state.history.slice(-16);
        state.retry = null;
      }

      if (!data.xml || (editContext||visualContext) && data.changes.total===0 && !data.changes.pageChanged) {
        recordReply();
        typing.textContent = data.reply || '本次没有生成图表。';
        tagSource(typing, data);
        taskTerminal = background;
        return { ok: true, applied: false, kind: data.kind || null };
      }

      // ③ 响应后再次同步：既看版本号，也比对**内容基线**。
      //    draw.io 的 autosave 可能晚于 getDiff 到达，只查 revision 会漏掉「手工编辑已
      //    写入编辑器文档、但 autosave 还没发出来」的窗口（R1）。
      setPhase('图表已返回，正在确认画布状态');
      const post = await syncWithEditor({ timeout: SYNC_TIMEOUT_MS });
      checkCancelled();
      const postNeedPage = state.pageCount > 1;
      const syncBroken = !post.docOk || post.pageInvalid || (postNeedPage && !post.pageOk);
      const canvasChanged = state.revision !== requestRevision;
      const docChanged = docFingerprint(state.payload) !== requestDoc;
      const contentChanged = pageContentFingerprint(state.payload, requestPageId) !== requestPageContent;
      const pageChanged = state.pageId !== requestPageId
        || state.pageIndex !== requestPageIndex
        || pagesSignature(state.payload) !== requestPageSignature;

      if (background && active.cancelRequested || syncBroken || canvasChanged || docChanged || contentChanged || pageChanged || visualContext&&!autoApply || editContext && data.requiresReview) {
        recordReply();
        state.pendingResult = {
          xml: data.xml,
          reply: data.reply,
          pageId: data.pageId !== undefined && data.pageId !== null ? data.pageId : requestPageId,
          pageIndex: Number.isInteger(data.pageIndex) ? data.pageIndex : requestPageIndex,
          requestRevision,
          ...(visualContext?{visual:{baseXml:requestModel,changes:data.changes,...(visualContext.mode?{mode:visualContext.mode}:{})}}:{}),
          ...(editContext ? {edit:{baseXml:requestModel,targetIds:editContext.targetIds,patch:data.patch,idMap:data.idMap,changes:data.changes,requiresReview:data.requiresReview}} : {}),
        };
        let tail;
        if (background && active.cancelRequested) {
          tail = '取消时模型已完成，结果已暂存，未修改画布';
          setHint('已停止自动应用。完成的结果已保留，可选择应用或丢弃。');
        } else if(visualContext&&!syncBroken&&!canvasChanged&&!docChanged&&!contentChanged&&!pageChanged){
          tail='整页视觉修复已暂存，请查看变更摘要后确认应用';setHint('视觉修复已暂存，确认后应用。');
        } else if(editContext&&(data.requiresReview||vision)&&!syncBroken&&!canvasChanged&&!docChanged&&!contentChanged&&!pageChanged) {
          tail=vision?'视觉建议的局部修改已暂存；当前不提供候选截图，请查看变更摘要后应用':'包含新增、删除或较多元素变更，请查看摘要后应用';
          setHint('局部修改已暂存，确认后应用。');
        } else if (syncBroken) {
          // R2：同步不可用时不写回 —— 保留画布与 AI 结果，给出可操作入口
          tail = `无法确认画布最新状态（${post.error}），结果已暂存、未写入画布`;
          setHint('同步失败：AI 结果已暂存，画布保持不变。请确认画布内容后选择「应用 AI 结果」或「丢弃」。');
        } else {
          const reasons = [];
          if (canvasChanged || docChanged || contentChanged) reasons.push('画布内容被修改');
          if (pageChanged) reasons.push('文档页面结构或当前页发生了变化');
          tail = `检测到${reasons.join('、')}，结果已暂存，未覆盖你的编辑`;
          setHint('');
        }
        typing.textContent = `${data.reply || '已生成结果'}（${tail}）`;
        typing.classList.add('conflict');
        tagSource(typing, data);
        showConflictBanner();
        if(editContext)clearEditContext();
        taskTerminal = background;
        return { ok: true, applied: false, conflict: true, review:Boolean(data.requiresReview||vision), syncBroken };
      }

      checkCancelled();
      active.canCancel = false;
      setBusyUi(true);
      recordReply();
      setPhase('正在将图表加载到画布');
      const applied = await applyAiResult(
        { xml: data.xml, pageId: data.pageId, pageIndex: data.pageIndex },
        { label: 'AI 修改前' },
      );
      if (applied.ok) {
        typing.textContent = `${data.reply || '已完成。'} 图表已更新到画布。`;
        tagSource(typing, data);
        if(editContext)refreshEditContext(editContext);
        else if(visualContext&&state.editContext&&!state.editContext.invalid)refreshEditContext(state.editContext);
        showToast('已应用 AI 结果；可用「撤销 AI 修改」回到应用前的画布');
      } else if (applied.cancelled) {
        typing.textContent = `${data.reply || ''} 结果未应用：加载被你的新操作取代（画布以你最新的操作为准）。`;
        tagSource(typing, data);
      } else {
        typing.classList.add('error');
        typing.textContent = `${data.reply || ''} 但结果没有进入画布：${applied.error}（已保留原画布）`;
        tagSource(typing, data);
        if(!vision&&!attachments.length)addRetryButton(typing, message, lockedSelection, editContext);
        else setHint('结果未应用，请重新发送本次要求。');
      }
      if (background && !applied.ok) {
        state.pendingResult = {xml:data.xml,reply:data.reply,pageId:data.pageId ?? requestPageId,pageIndex:Number.isInteger(data.pageIndex)?data.pageIndex:requestPageIndex,requestRevision,
          ...(visualContext?{visual:{baseXml:requestModel,changes:data.changes,mode:visualContext.mode}}:{}),
          ...(editContext?{edit:{baseXml:requestModel,targetIds:editContext.targetIds,patch:data.patch,idMap:data.idMap,changes:data.changes,requiresReview:data.requiresReview}}:{})};
        showConflictBanner(); setHint('图表加载未完成，生成结果已暂存，可以稍后应用。');
      }
      taskTerminal = background;
      return { ok: autoApply?applied.ok:true, applied: applied.ok, error:applied.error };
    } catch (e) {
      if (background && e.httpStatus === 410) e.taskDetached = true;
      if (background && taskCreated && (!e.taskTerminal || e.taskDetached) && (!taskTerminal || e.taskDetached || active.detached)) {
        taskTerminal = false;
        typing.textContent = e.taskDetached ? e.message : '页面连接已断开，服务器继续生成。可以刷新页面或恢复同一任务。';
        if (!active.detached) addDrawingRecovery(typing);
        return {ok:false,pending:true,error:e.message};
      }
      if (background && e.taskTerminal) taskTerminal = true;
      turnUsage = TurnUsage?.normalize(e.turnUsage) || turnUsage;
      if(attachments.length){state.attachments=[...attachments,...state.attachments.filter(i=>!attachments.includes(i))];renderAttachments();}
      if (active.controller.signal.aborted) {
        typing.textContent = '已取消本次生成，未应用 AI 结果。';
        if (!chatInput.value.trim()) setDraft(message);
        return { ok: false, cancelled: true };
      }
      typing.classList.remove('typing');
      typing.classList.add('error');
      typing.textContent = '生成失败：' + e.message;
      // 失败文本存入独立的重试状态；只有输入框为空时才回填，绝不覆盖用户新写的草稿
      state.retry = vision||attachments.length?null:{ text: message, selection: lockedSelection, editContext };
      if (!chatInput.value.trim()) setDraft(message);
      if(!vision&&!attachments.length)addRetryButton(typing, message, lockedSelection, editContext);
      else {state.retry=null;setHint('请重新发送本次要求，多模态会获取最新画面。');}
      showToast('请求失败：' + e.message, 'error');
      return { ok: false, error: e.message };
    } finally {
      progressActive = false;
      clearTimeout(progressTimer);
      progressAnimation?.cancel();
      typing.classList.remove('typing', 'agent-progress');
      if (turnId) { setTurnUsage(typing, turnUsage || TurnUsage.unknown(turnId)); reconcileTurnUsage(typing); }
      state.busy = false;
      state.activeRequest = null;
      if (background && taskCreated && taskTerminal && state.drawingTask?.taskId === active.taskId) {
        const {taskId,threadId,assistantId} = state.drawingTask;
        state.drawingTask = {taskId,threadId,assistantId,status:'settled'};
      }
      markSessionDirty();
      if (background && taskTerminal) await flushSession();
      setBusyUi(false);
      window.DiagramCloud?.refreshUsage();
      chatInput.focus();
    }
  }

  // ---------- 导出 / 下载 ----------
  function downloadDataUri(uri, filename) {
    const a = document.createElement('a');
    a.href = uri;
    a.download = filename;
    a.click();
  }

  function downloadText(text, filename, mime) {
    const blob = new Blob([text], { type: mime || 'application/xml' });
    const url = URL.createObjectURL(blob);
    downloadDataUri(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /** 构造下载内容：完整 mxfile 直接保存（只替换当前页），裸模型才包裹一次 */
  function buildDownloadContent() {
    const info = File.parseFile(state.payload || '');
    const modelXml = state.modelXml;
    const built = File.buildDownloadContent({
      payload: state.payload,
      pageIndex: state.pageIndex,
      modelXml: info.kind === 'mxfile' ? modelXml : (modelXml || state.payload),
      name: currentPageName(),
    });
    if (!built.ok) return built;
    const check = validatePayload(built.content, state.pageIndex);
    if (!check.ok) return { ok: false, error: '下载内容未通过校验：' + check.error };
    return built;
  }

  function currentPageName() {
    const info = File.parseFile(state.payload || '');
    if (info.kind === 'mxfile' && info.pages[state.pageIndex]) return info.pages[state.pageIndex].name;
    return 'Page-1';
  }

  async function exportPng() {
    const result = await requestExport({ format: 'png', scale: 2, border: 10 });
    if (!result.ok) { showToast('PNG 导出失败：' + result.error, 'error'); return result; }
    const data = result.data || '';
    if (!/^data:image\/png;base64,/.test(data) || data.length < 200) {
      showToast('PNG 导出返回的数据不合法（未收到图片数据）', 'error');
      return { ok: false, error: 'invalid-png-data' };
    }
    downloadDataUri(data, 'diagram.png');
    const kb = Math.round((data.length - 'data:image/png;base64,'.length) * 3 / 4 / 1024);
    showToast(`已导出 PNG（${kb} KB）`);
    if (TEST_MODE && typeof testHooks.onExport === 'function') testHooks.onExport(result);
    return result;
  }

  // ---------- 模型选择与管理 ----------
  // 常用模板只预填可修改的初值，不限制网关地址与模型名称
  const PROVIDER_TEMPLATES = [
    { name: 'DeepSeek', providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', protocol: 'openai-chat-completions', apiKey: '', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { name: 'OpenAI 兼容', providerId: 'openai', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-chat-completions', apiKey: '', models: ['gpt-4o-mini', 'gpt-4o'] },
    { name: 'Anthropic', providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', protocol: 'anthropic-messages', apiKey: '', models: ['claude-sonnet-4-5', 'claude-haiku-4-5'] },
  ];

  const modelSelectBtn = el('modelSelectBtn');
  const modelSelectLabel = el('modelSelectLabel');
  const thinkingToggle = el('thinkingToggle');
  const thinkingToggleLabel = el('thinkingToggleLabel');
  const reasoningEffortSelect = el('reasoningEffortSelect');
  let pendingReasoningEffort;
  const modelDropdown = el('modelDropdown');
  const modelSearch = el('modelSearch');
  const modelGroups = el('modelGroups');
  const drawerOverlay = el('drawerOverlay');
  const providerList = el('providerList');
  const providerForm = el('providerForm');
  const providerEmpty = el('providerEmpty');
  const tplOverlay = el('tplOverlay');
  const templateGrid = el('templateGrid');
  let editingProviderId = null; // null = 新建模式
  let editingModelId = null;    // 正在编辑参数的模型 ID（R7；null = 没有展开的编辑器）
  let draftProviderModels = [];
  let providerFetchVersion = 0;

  function resetProviderDraft() {
    draftProviderModels = [];
    providerFetchVersion++;
    el('fetchModelsBtn').disabled = false;
    el('fetchResult').textContent = '';
    el('fetchResult').classList.add('hidden');
  }

  function renderDraftModels() {
    const box = el('providerModels');
    box.textContent = '';
    for (const model of draftProviderModels) {
      const row = document.createElement('div');
      row.className = 'provider-model-row';
      const name = document.createElement('span');
      name.textContent = (model.displayName || model.modelId) + ' · 待保存';
      const remove = document.createElement('button');
      remove.type = 'button'; remove.className = 'banner-btn subtle'; remove.textContent = '移除';
      remove.onclick = () => {
        draftProviderModels = draftProviderModels.filter(m => m.modelId !== model.modelId);
        renderDraftModels();
        for (const button of el('fetchResult').querySelectorAll('button[data-model-id]')) {
          if (button.dataset.modelId === model.modelId) { button.disabled = false; button.textContent = '添加'; }
        }
      };
      row.append(name, remove); box.appendChild(row);
    }
  }

  const MOCK_OPTION = { providerId: 'mock', modelId: 'mock' };

  function currentSelectionKey() {
    return state.selection ? `${state.selection.providerId}/${state.selection.modelId}` : '';
  }

  /** 用目录校验选择是否仍然有效（提供商/模型存在且启用）；失效时给出原因并阻止发送 */
  function validateSelection(sel) {
    if (!sel) return { valid: false, reason: '未选择模型' };
    if (sel.providerId === 'mock') {
      return { valid: true, providerId: 'mock', modelId: 'mock', providerName: '示例引擎', modelName: '内置示例引擎' };
    }
    const catalog = state.modelCatalog;
    if (!catalog) return { valid: false, reason: '模型目录尚未加载' };
    const p = (catalog.providers || []).find((x) => x.providerId === sel.providerId);
    if (!p) return { valid: false, reason: '提供商不存在（可能已被删除）', providerId: sel.providerId, modelId: sel.modelId };
    if (!p.enabled) return { valid: false, reason: `提供商「${p.name}」已停用`, providerId: sel.providerId, modelId: sel.modelId };
    const m = (p.models || []).find((x) => x.modelId === sel.modelId);
    if (!m) return { valid: false, reason: '模型不存在（可能已被删除）', providerName: p.name, providerId: sel.providerId, modelId: sel.modelId };
    if (!m.enabled) return { valid: false, reason: `模型「${m.displayName}」已停用`, providerName: p.name, providerId: sel.providerId, modelId: sel.modelId };
    return { valid: true, providerName: p.name, modelName: m.displayName, quotaMultiplier: m.quotaMultiplier, providerId: sel.providerId, modelId: sel.modelId };
  }

  function saveSelectionToStorage() {
    try {
      if (state.selection) localStorage.setItem(SELECTION_KEY, JSON.stringify(state.selection));
      else localStorage.removeItem(SELECTION_KEY);
    } catch (e) { /* 忽略 */ }
  }

  function loadSelectionFromStorage() {
    try {
      const raw = localStorage.getItem(SELECTION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.providerId === 'string' && typeof parsed.modelId === 'string') {
        return { providerId: parsed.providerId, modelId: parsed.modelId };
      }
    } catch (e) { /* 忽略 */ }
    return null;
  }

  /**
   * 目录刷新后重算生效选择（R4）：
   *   - 用户已有选择（本地保存过）：无论是否失效都**保留原 providerId/modelId**；
   *     失效时标记失效（阻止下一次发送、提示主动重选），绝不自动切换到
   *     默认模型或其它提供商的模型 —— 静默换路由等于替用户做付费决策。
   *   - 首次没有任何选择：才用服务端默认初始化；无默认配置时回展示例引擎。
   */
  function reconcileSelection() {
    const catalog = state.modelCatalog;
    if (!catalog) return;
    const saved = loadSelectionFromStorage();
    if (saved) {
      state.selection = saved;
      state.selectionInfo = validateSelection(saved);
      saveSelectionToStorage();
      updateModelSelectorLabel();
      return;
    }
    let candidate = null;
    if (catalog.defaultSelection) {
      candidate = { providerId: catalog.defaultSelection.providerId, modelId: catalog.defaultSelection.modelId };
    }
    let info = candidate ? validateSelection(candidate) : { valid: false };
    if (!info.valid) {
      candidate = MOCK_OPTION;
      info = validateSelection(candidate);
    }
    state.selection = candidate;
    state.selectionInfo = info;
    saveSelectionToStorage();
    updateModelSelectorLabel();
  }

  function updateModelSelectorLabel() {
    modelSelectLabel.dataset.providerId = state.selection?.providerId || '';
    modelSelectLabel.dataset.modelId = state.selection?.modelId || '';
    document.dispatchEvent(new CustomEvent('diagram:model-selection', { detail: { providerId: state.selection?.providerId || null, modelId: state.selection?.modelId || null } }));
    updateVisionControls();
    updateThinkingSwitch();
    const info = state.selectionInfo;
    modelSelectBtn.classList.toggle('invalid', Boolean(info && info.valid === false));
    if (!info) { modelSelectLabel.textContent = '选择模型'; return; }
    if (info.valid === false) {
      modelSelectLabel.textContent = `⚠ ${info.providerName || info.providerId || ''} / ${info.modelId}（已失效）`;
      return;
    }
    const rate = Number.isFinite(info.quotaMultiplier) && info.quotaMultiplier > 0 ? ` ×${info.quotaMultiplier}` : '';
    modelSelectLabel.textContent = (info.modelName || info.modelId).split('/').pop() + rate;
    el('modelSelectSource').textContent = info.providerName;
    modelSelectBtn.title = `${info.providerName} / ${info.modelName}`;
    window.DiagramComposerSummary?.sync();
  }

  function selectedThinkingConfig() {
    const sel = state.selection;
    const provider = (window.DiagramCloud?.enabled ? state.modelCatalog?.providers || [] : [...(state.providers || []), ...(state.modelCatalog?.providers || []).filter(p => p.protocol === 'chatgpt-responses')]).find((p) => p.providerId === sel?.providerId);
    const model = provider?.models.find((m) => m.modelId === sel.modelId);
    if (!model || state.selectionInfo?.valid !== true) return null;
    if (provider.protocol === 'chatgpt-responses') return model.supportsNone && model.reasoningLevels?.length ? { provider, model, family: 'responses', mode: model.thinkingMode || 'default' } : null;
    if (provider.protocol !== 'openai-chat-completions') return null;
    const mode = model.thinkingMode || 'default';
    let family = mode.startsWith('deepseek-') ? 'deepseek' : mode.startsWith('enable-thinking-') ? 'enable-thinking' : null;
    if (!family && /(^|\.)deepseek\.com$/i.test(new URL(provider.baseUrl).hostname)) family = 'deepseek';
    if (!family && /(^|\.)modelscope\.cn$/i.test(new URL(provider.baseUrl).hostname) && /qwen/i.test(model.modelId)) family = 'enable-thinking';
    return family ? { provider, model, family, mode } : null;
  }

  function selectedModelConfig() {
    const sel = state.selection;
    const provider = (window.DiagramCloud?.enabled ? state.modelCatalog?.providers || [] : [...(state.providers || []), ...(state.modelCatalog?.providers || []).filter(p => p.protocol === 'chatgpt-responses')]).find(p => p.providerId === sel?.providerId);
    const model = provider?.models.find(m => m.modelId === sel.modelId);
    return model && state.selectionInfo?.valid === true ? { provider, model } : null;
  }

  function fillEffortOptions(select, caps, value) {
    select.textContent = '';
    for (const level of ['', ...caps.reasoningLevels]) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level ? `强度·${Capabilities.LABELS[level]}` : caps.defaultEffort ? `默认·${Capabilities.LABELS[caps.defaultEffort]}` : '强度·默认';
      select.appendChild(option);
    }
    select.value = caps.reasoningLevels.includes(value) ? value : '';
  }

  function updateThinkingSwitch() {
    const config = selectedThinkingConfig();
    const on = Boolean(config && (config.mode.endsWith('-on') || config.family === 'responses' && config.mode === 'default' && config.model.defaultEffort !== 'none'));
    thinkingToggle.ariaChecked = String(on);
    thinkingToggle.classList.toggle('on', on);
    thinkingToggle.disabled = !config || state.busy || state.thinkingSaving || Boolean(state.reasoningDetection);
    modelSelectBtn.disabled = state.thinkingSaving || Boolean(state.reasoningDetection);
    thinkingToggleLabel.textContent = state.thinkingSaving ? '保存中' : !config ? '思考' : config.mode === 'default' ? '思考·默认' : on ? '思考·开' : '思考·关';
    thinkingToggle.title = !config ? '该模型尚未配置受支持的思考开关；兼容接口可在模型设置中选择思考协议。' : state.busy ? '模型工作期间暂不能修改思考模式。' : config.mode === 'default' ? (on ? '当前遵循接口默认，思考已开启；点击关闭。' : '当前遵循接口默认；点击开启思考。') : '切换并保存当前模型的思考模式，下次发送生效。';
    const selected = selectedModelConfig();
    const caps = selected ? Capabilities.resolve(selected.provider, selected.model) : { reasoningLevels: [] };
    fillEffortOptions(reasoningEffortSelect, caps, pendingReasoningEffort === undefined ? selected?.model.reasoningEffort : pendingReasoningEffort);
    const off = selected?.model.thinkingMode?.endsWith('-off');
    reasoningEffortSelect.dataset.thinkingOff = String(Boolean(off));
    reasoningEffortSelect.disabled = !caps.reasoningLevels.length || off || state.busy || state.thinkingSaving || Boolean(state.reasoningDetection);
    reasoningEffortSelect.title = !caps.reasoningLevels.length ? '尚未配置思考强度；可在模型设置中查看能力来源并手动配置。' : off ? '开启思考后可调整强度；当前强度选择会保留。' : '保存当前模型的 reasoning_effort 参数，下次请求生效；默认遵循供应商设置。';
    window.DiagramReasoningSlider?.sync(reasoningEffortSelect);
  }

  async function saveReasoningEffort() {
    const config = selectedModelConfig();
    const effort = reasoningEffortSelect.value || null;
    if (!config || reasoningEffortSelect.disabled || state.busy || state.thinkingSaving) return;
    pendingReasoningEffort = effort;
    state.thinkingSaving = true;
    setBusyUi(state.busy);
    try {
      const res = await apiFetch(`/api/providers/${encodeURIComponent(config.provider.providerId)}/models/${encodeURIComponent(config.model.modelId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasoningEffort: effort, revision: state.providerRevision }),
      });
      if (!res.ok) throw new Error(res.data?.detail?.fields?.reasoningEffort || res.data?.error?.message || `保存失败（HTTP ${res.status}）`);
      await refreshModelData();
      showToast(effort ? `思考强度已设为${Capabilities.LABELS[effort]}` : '思考强度已恢复供应商默认');
    } catch (e) {
      await refreshModelData();
      showToast('思考强度未保存：' + e.message, 'error');
    } finally {
      pendingReasoningEffort = undefined;
      state.thinkingSaving = false;
      setBusyUi(state.busy);
    }
  }

  async function toggleThinking() {
    const config = selectedThinkingConfig();
    if (!config || state.busy || state.thinkingSaving) return;
    const wasOn = thinkingToggle.ariaChecked === 'true';
    state.thinkingSaving = true;
    setBusyUi(state.busy);
    try {
      const mode = `${config.family}-${wasOn ? 'off' : 'on'}`;
      const res = await apiFetch(`/api/providers/${encodeURIComponent(config.provider.providerId)}/models/${encodeURIComponent(config.model.modelId)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thinkingMode: mode, revision: state.providerRevision }),
      });
      if (!res.ok) throw new Error(res.data?.error?.message || `保存失败（HTTP ${res.status}）`);
      await refreshModelData();
      showToast(mode.endsWith('-on') ? '思考已开启，可能增加生成耗时' : '思考已关闭');
    } catch (e) {
      await refreshModelData();
      showToast('思考模式未保存：' + e.message, 'error');
    } finally {
      state.thinkingSaving = false;
      setBusyUi(state.busy);
    }
  }

  function modelOptionRows() {
    const catalog = state.modelCatalog;
    if (!catalog) return [];
    const rows = [];
    for (const p of catalog.providers || []) {
      if (!p.enabled) continue;
      for (const m of p.models || []) {
        if (!m.enabled) continue;
        rows.push({ providerId: p.providerId, providerName: p.name, modelId: m.modelId, modelName: m.displayName, quotaMultiplier: m.quotaMultiplier, group: m.quotaPool === 'free' ? '免费模型' : '其他模型', isDefault: m.isDefault, isMock: false });
      }
    }
    rows.push({ providerId: 'mock', providerName: '示例引擎', modelId: 'mock', modelName: '内置示例引擎（确定性布局修改）', group: '其他模型', isDefault: false, isMock: true });
    return rows;
  }

  function renderModelDropdown() {
    const filter = (modelSearch.value || '').trim().toLowerCase();
    const rows = modelOptionRows().filter((r) => {
      if (!filter) return true;
      return r.providerName.toLowerCase().includes(filter)
        || r.modelName.toLowerCase().includes(filter)
        || r.modelId.toLowerCase().includes(filter)
        || r.group.includes(filter);
    }).sort((a, b) => Number(b.group === '免费模型') - Number(a.group === '免费模型'));
    modelGroups.textContent = '';
    const groups = new Map();
    for (const r of rows) {
      if (!groups.has(r.group)) groups.set(r.group, []);
      groups.get(r.group).push(r);
    }
    const current = currentSelectionKey();
    for (const [groupName, items] of groups) {
      const g = document.createElement('div');
      g.className = 'model-group';
      const h = document.createElement('div');
      h.className = 'model-group-title';
      h.textContent = groupName;
      g.appendChild(h);
      for (const r of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'model-option' + (current === `${r.providerId}/${r.modelId}` ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'model-option-name';
        name.textContent = r.modelName + (Number.isFinite(r.quotaMultiplier) && r.quotaMultiplier > 0 ? ` ×${r.quotaMultiplier}` : '');
        row.setAttribute('aria-pressed', String(current === `${r.providerId}/${r.modelId}`));
        const copy = document.createElement('span'); copy.className = 'model-option-copy'; copy.appendChild(name); row.appendChild(copy);
        const id = document.createElement('span');
        id.className = 'model-option-id';
        id.textContent = `${r.modelId} · ${r.providerName}`;
        copy.appendChild(id); row.title = id.textContent;
        if (r.isDefault) {
          const badge = document.createElement('span');
          badge.className = 'model-default-badge';
          badge.textContent = '默认';
          row.appendChild(badge);
        }
        const check = document.createElement('span');
        check.className = 'model-check';
        check.textContent = current === `${r.providerId}/${r.modelId}` ? '✓' : '';
        row.appendChild(check);
        row.onclick = () => {
          state.selection = { providerId: r.providerId, modelId: r.modelId };
          state.selectionInfo = validateSelection(state.selection);
          saveSelectionToStorage();
          updateModelSelectorLabel();
          closeModelDropdown(); modelSelectBtn.focus();
          setHint(`下一次发送将使用 ${r.providerName} / ${r.modelName}（本次对话与画布保持不变）。`);
        };
        g.appendChild(row);
      }
      modelGroups.appendChild(g);
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-empty';
      empty.textContent = '没有匹配的模型';
      modelGroups.appendChild(empty);
    }
  }

  function openModelDropdown() {
    modelSearch.value = '';
    renderModelDropdown();
    modelDropdown.classList.remove('hidden');
    modelSelectBtn.setAttribute('aria-expanded', 'true');
    modelSearch.focus();
  }

  function closeModelDropdown() {
    modelDropdown.classList.add('hidden');
    modelSelectBtn.setAttribute('aria-expanded', 'false');
  }

  async function apiFetch(pathname, options) {
    const resp = await fetch(pathname, options);
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  }

  async function refreshModelData() {
    try {
      const [catalogRes, providersRes] = await Promise.all([
        fetch('/api/models/catalog').then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch('/api/providers').then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      if (catalogRes) state.modelCatalog = catalogRes;
      if (providersRes && Array.isArray(providersRes.providers)) {
        state.providers = providersRes.providers;
        // 记录服务端编辑版本（R6）；表单的版本不跟着变——那是打开表单时钉住的
        if (Number.isInteger(providersRes.revision)) state.providerRevision = providersRes.revision;
      }
      reconcileSelection();
    } catch (e) { /* 目录加载失败时保留现状 */ }
    finally { setBusyUi(state.busy); }
  }

  window.addEventListener('chatgpt-models-changed', () => refreshModelData());

  // ---------- 设置抽屉 ----------
  function openDrawer() {
    drawerOverlay.classList.remove('hidden');
    renderProviderList();
    showProviderForm(null);
  }

  function closeDrawer() {
    drawerOverlay.classList.add('hidden');
  }

  /** R6：服务端编辑版本冲突（409 stale-config）判定 */
  function isStaleConflict(res) {
    return res && res.status === 409 && res.data && res.data.error && res.data.error.code === 'stale-config';
  }

  function showStaleBanner() {
    const banner = el('staleBanner');
    if (banner) banner.classList.remove('hidden');
    showToast('保存被拒绝：配置已在其他窗口被修改（编辑冲突），未覆盖新配置。请核对后重新编辑。', 'error');
  }

  function hideStaleBanner() {
    const banner = el('staleBanner');
    if (banner) banner.classList.add('hidden');
  }

  /** 重新加载最新配置：拉取服务端当前数据并重开表单（重新钉住编辑版本），保留抽屉打开状态 */
  async function reloadProviderForm() {
    await refreshModelData();
    renderProviderList();
    hideStaleBanner();
    showProviderForm(editingProviderId);
    showToast('已重新加载最新配置，请基于新内容重新编辑后保存。');
  }

  /** 只刷新当前表单的模型列表（不重置提供商输入框，避免吞掉未保存的编辑） */
  function refreshOpenFormModels() {
    if (!editingProviderId) return;
    const p = (state.providers || []).find((x) => x.providerId === editingProviderId);
    if (!p) { showProviderForm(null); return; }
    renderProviderModels(p);
  }

  function renderProviderList() {
    providerList.textContent = '';
    const providers = state.providers || [];
    if (providers.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'provider-empty-note';
      empty.textContent = '还没有提供商。点击右上角「＋ 添加提供商」开始配置。';
      providerList.appendChild(empty);
    }
    for (const p of providers) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'provider-item' + (p.providerId === editingProviderId ? ' active' : '');
      const main = document.createElement('div');
      main.className = 'provider-item-main';
      const name = document.createElement('span');
      name.className = 'provider-item-name';
      name.textContent = p.name;
      main.appendChild(name);
      const proto = document.createElement('span');
      proto.className = 'provider-item-proto';
      proto.textContent = p.protocol === 'anthropic-messages' ? 'Anthropic' : 'OpenAI 兼容';
      main.appendChild(proto);
      item.appendChild(main);
      const meta = document.createElement('div');
      meta.className = 'provider-item-meta';
      const enabled = document.createElement('span');
      enabled.className = 'provider-item-state ' + (p.enabled ? 'on' : 'off');
      enabled.textContent = p.enabled ? '启用' : '停用';
      meta.appendChild(enabled);
      if (p.isDefault) {
        const d = document.createElement('span');
        d.className = 'model-default-badge';
        d.textContent = '默认';
        meta.appendChild(d);
      }
      item.appendChild(meta);
      item.onclick = () => showProviderForm(p.providerId);
      providerList.appendChild(item);
    }
  }

  function setFieldError(id, msg) {
    const node = el(id);
    if (node) node.textContent = msg || '';
  }

  function clearFieldErrors() {
    for (const id of ['errProviderId', 'errName', 'errBaseUrl', 'errProtocol', 'errApiKey', 'errModel']) setFieldError(id, '');
  }

  /** 打开（或重开）提供商表单：钉住当前服务端编辑版本（R6），后续保存都携带它做过期检测 */
  function showProviderForm(providerId) {
    resetProviderDraft();
    editingProviderId = providerId;
    state.providerFormRevision = state.providerRevision;
    hideStaleBanner();
    clearFieldErrors();
    renderProviderList();
    const p = providerId ? (state.providers || []).find((x) => x.providerId === providerId) : null;
    providerForm.classList.toggle('hidden', false);
    providerEmpty.classList.add('hidden');
    el('pfProviderId').disabled = Boolean(p);
    el('pfProviderId').value = p ? p.providerId : '';
    el('pfName').value = p ? p.name : '';
    el('pfBaseUrl').value = p ? p.baseUrl : '';
    el('pfProtocol').value = p ? p.protocol : 'openai-chat-completions';
    el('pfApiKey').value = '';
    el('pfApiKey').placeholder = p ? (p.hasKey ? '已保存密钥（留空保留，不会显示）' : '未设置密钥') : '可留空（无密钥本地服务）';
    el('pfEnabled').checked = p ? p.enabled : true;
    el('authKindBadge').textContent = p ? (p.hasKey ? '认证：Bearer API Key' : '认证：无密钥') : '';
    el('clearKeyBtn').classList.toggle('hidden', !(p && p.hasKey));
    el('deleteProviderBtn').classList.toggle('hidden', !p);
    editingModelId = null;
    renderProviderModels(p);
  }

  function testStatusBadge(m) {
    const map = {
      untested: ['未测试', ''],
      testing: ['测试中…', 'busy'],
      success: ['连通', 'ok'],
      fail: ['失败', 'err'],
    };
    return map[m.testStatus] || map.untested;
  }

  /** 构建单个模型的内联参数编辑器（R7）：显示名 / maxTokens / temperature，留空=清空回协议默认 */
  function buildModelEditor(p, m) {
    const editor = document.createElement('div');
    editor.className = 'model-edit-form';
    editor.setAttribute('data-editing-model', m.modelId);

    const title = document.createElement('div');
    title.className = 'model-edit-title';
    title.textContent = `编辑模型参数（ID ${m.modelId} 不可修改；保存后下一次请求生效，在途请求仍用原参数）`;
    editor.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'model-edit-grid';

    const mkField = (labelText, input, errEl, container = false) => {
      const field = document.createElement(container ? 'div' : 'label');
      field.className = 'field';
      const label = document.createElement('span');
      label.className = 'field-label';
      label.textContent = labelText;
      field.appendChild(label);
      field.appendChild(input);
      field.appendChild(errEl);
      return field;
    };

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = m.displayName || '';
    nameInput.autocomplete = 'off';
    const nameErr = document.createElement('span');
    nameErr.className = 'field-error';
    grid.appendChild(mkField('显示名称', nameInput, nameErr));

    const mtInput = document.createElement('input');
    mtInput.type = 'number';
    mtInput.min = '1';
    mtInput.max = '200000';
    mtInput.value = Number.isInteger(m.maxTokens) ? String(m.maxTokens) : '';
    mtInput.placeholder = p.protocol === 'anthropic-messages' ? '留空 = 32768；可按模型调整' : '建议 32768；留空 = 供应商默认';
    const mtErr = document.createElement('span');
    mtErr.className = 'field-error';
    grid.appendChild(mkField('输出上限（tokens）', mtInput, mtErr));

    const visionInput=document.createElement('input');visionInput.type='checkbox';visionInput.className='vision-capability';visionInput.checked=m.visionInput===true;visionInput.setAttribute?.('aria-label','支持图片输入');
    const visionNote=document.createElement('span');visionNote.className='form-note';visionNote.textContent='按模型与网关实际支持声明，不根据模型名称自动判断';
    grid.appendChild(mkField('支持图片输入（多模态）',visionInput,visionNote));

    const thinkingInput = document.createElement('select');
    for (const [value, label] of [
      ['default', '供应商默认'], ['deepseek-off', '关闭思考（DeepSeek 参数）'],
      ['deepseek-on', '开启思考（DeepSeek 参数）'],
      ['enable-thinking-off', '关闭思考（魔搭 / Qwen 参数）'],
      ['enable-thinking-on', '开启思考（魔搭 / Qwen 参数）'],
    ]) {
      const option = document.createElement('option');
      option.value = value; option.textContent = label; thinkingInput.appendChild(option);
    }
    thinkingInput.value = m.thinkingMode || 'default';
    const thinkingErr = document.createElement('span');
    thinkingErr.className = 'field-error';
    grid.appendChild(mkField('思考模式（按接口支持选择）', thinkingInput, thinkingErr));

    const profileInput = document.createElement('select');
    for (const [value, label] of [['auto', '自动识别'], ['custom', '手动配置 reasoning_effort'], ['none', '不支持强度参数']]) {
      const option = document.createElement('option');
      option.value = value; option.textContent = label; profileInput.appendChild(option);
    }
    profileInput.value = m.capabilityProfile || 'auto';
    profileInput.disabled = p.protocol !== 'openai-chat-completions';
    const capabilityErr = document.createElement('span'); capabilityErr.className = 'field-error';
    grid.appendChild(mkField('模型能力', profileInput, capabilityErr));

    const levelsBox = document.createElement('div'); levelsBox.className = 'capability-levels';
    const levelInputs = Capabilities.EFFORTS.map(level => {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'checkbox';
      input.checked = (m.reasoningLevels || []).includes(level);
      const text = document.createElement('span'); text.textContent = `${Capabilities.LABELS[level]} (${level})`;
      label.appendChild(input); label.appendChild(text); levelsBox.appendChild(label);
      return { level, input };
    });
    const capsNote = document.createElement('div'); capsNote.className = 'form-note';
    grid.appendChild(mkField('手动声明接口支持的级别', levelsBox, capsNote, true));
    const effortInput = document.createElement('select');
    const effortErr = document.createElement('span'); effortErr.className = 'field-error';
    grid.appendChild(mkField('思考强度', effortInput, effortErr));
    let capsInitialized = false;
    const refreshCapabilities = () => {
      const configured = { ...m, capabilityProfile: profileInput.value, reasoningLevels: levelInputs.filter(x => x.input.checked).map(x => x.level) };
      const caps = Capabilities.resolve(p, configured);
      const previous = capsInitialized ? effortInput.value : m.reasoningEffort;
      fillEffortOptions(effortInput, caps, previous);
      capsInitialized = true;
      effortInput.disabled = !caps.reasoningLevels.length;
      for (const x of levelInputs) x.input.disabled = profileInput.value !== 'custom' || profileInput.disabled;
      const source = { official: '模型官方文档', manual: '手动配置', remote: '接口元数据', probe: '接口请求检测', unknown: '未识别' }[caps.source];
      capsNote.textContent = `来源：${source}。${caps.reasoningLevels.length ? (caps.source === 'probe' ? '接口接受 ' : '支持 ') + caps.reasoningLevels.join(' / ') + '。' : '未声明可用的强度级别。'}${m.reasoningProbe?.reason || '手动配置请按接口文档勾选；模型能力不代表网关已验证。'}`;
    };
    profileInput.onchange = refreshCapabilities;
    for (const x of levelInputs) x.input.onchange = refreshCapabilities;
    refreshCapabilities();

    const tempInput = document.createElement('input');
    tempInput.type = 'number';
    tempInput.min = '0';
    tempInput.max = '2';
    tempInput.step = '0.1';
    tempInput.value = typeof m.temperature === 'number' ? String(m.temperature) : '';
    tempInput.placeholder = '留空 = 协议默认';
    const tempErr = document.createElement('span');
    tempErr.className = 'field-error';
    grid.appendChild(mkField('temperature', tempInput, tempErr));

    editor.appendChild(grid);

    const generalErr = document.createElement('div');
    generalErr.className = 'field-error';
    editor.appendChild(generalErr);

    const actions = document.createElement('div');
    actions.className = 'model-edit-actions';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'banner-btn primary';
    saveBtn.textContent = '保存';
    saveBtn.onclick = async () => {
      nameErr.textContent = '';
      mtErr.textContent = '';
      tempErr.textContent = '';
      thinkingErr.textContent = '';
      capabilityErr.textContent = '';
      effortErr.textContent = '';
      generalErr.textContent = '';
      // 留空 = 显式 null：OpenAI 使用供应商默认，Anthropic 使用绘图默认 32768。
      const payload = {
        displayName: nameInput.value.trim(),
        maxTokens: mtInput.value === '' ? null : Number(mtInput.value),
        temperature: tempInput.value === '' ? null : Number(tempInput.value),
        visionInput: visionInput.checked,
        thinkingMode: thinkingInput.value,
        capabilityProfile: profileInput.value,
        reasoningLevels: levelInputs.filter(x => x.input.checked).map(x => x.level),
        reasoningEffort: effortInput.value || null,
      };
      const body = Object.assign({}, payload);
      if (state.providerFormRevision !== null) body.revision = state.providerFormRevision;
      saveBtn.disabled = true;
      let res;
      try {
        res = await apiFetch(`/api/providers/${encodeURIComponent(p.providerId)}/models/${encodeURIComponent(m.modelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        saveBtn.disabled = false;
        generalErr.textContent = '保存失败：' + e.message;
        return;
      }
      if (isStaleConflict(res)) { showStaleBanner(); saveBtn.disabled = false; return; }
      if (!res.ok) {
        saveBtn.disabled = false;
        const fields = res.data && res.data.detail && res.data.detail.fields;
        if (fields) {
          if (fields.displayName) nameErr.textContent = fields.displayName;
          if (fields.maxTokens) mtErr.textContent = fields.maxTokens;
          if (fields.temperature) tempErr.textContent = fields.temperature;
          if (fields.thinkingMode) thinkingErr.textContent = fields.thinkingMode;
          if (fields.capabilityProfile || fields.reasoningLevels) capabilityErr.textContent = fields.capabilityProfile || fields.reasoningLevels;
          if (fields.reasoningEffort) effortErr.textContent = fields.reasoningEffort;
        }
        generalErr.textContent = (res.data && res.data.error && res.data.error.message) || `保存失败（HTTP ${res.status}）`;
        return;
      }
      if (res.data && Number.isInteger(res.data.revision)) state.providerFormRevision = res.data.revision;
      editingModelId = null;
      await refreshModelData();
      renderProviderList();
      refreshOpenFormModels();
      showToast('模型参数已更新：下一次请求使用新参数（在途请求仍用原参数）');
    };
    actions.appendChild(saveBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'banner-btn subtle';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = () => {
      editingModelId = null;
      refreshOpenFormModels();
    };
    actions.appendChild(cancelBtn);
    editor.appendChild(actions);
    return editor;
  }

  function renderProviderModels(p) {
    const box = el('providerModels');
    box.textContent = '';
    if (!p) return;
    if (p.models.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'provider-empty-note';
      empty.textContent = '尚无模型：手动输入模型 ID 添加，或点击「获取模型列表」。';
      box.appendChild(empty);
      return;
    }
    for (const m of p.models) {
      const row = document.createElement('div');
      row.className = 'provider-model-row' + (m.enabled ? '' : ' disabled');
      const info = document.createElement('div');
      info.className = 'provider-model-info';
      const name = document.createElement('span');
      name.className = 'provider-model-name';
      name.textContent = m.displayName;
      info.appendChild(name);
      const idSpan = document.createElement('span');
      idSpan.className = 'model-option-id';
      idSpan.textContent = m.modelId;
      info.appendChild(idSpan);
      if (m.maxTokens !== null && m.maxTokens !== undefined || p.protocol === 'anthropic-messages') {
        const mt = document.createElement('span');
        mt.className = 'model-option-id';
        mt.textContent = `输出上限：${m.maxTokens ?? 32768} tokens${m.maxTokens == null ? '（默认）' : ''}`;
        info.appendChild(mt);
      }
      if (typeof m.temperature === 'number') {
        const tp = document.createElement('span');
        tp.className = 'model-option-id';
        tp.textContent = `temperature=${m.temperature}`;
        info.appendChild(tp);
      }
      if (m.thinkingMode && m.thinkingMode !== 'default') {
        const mode = document.createElement('span');
        mode.className = 'model-option-id';
        mode.textContent = m.thinkingMode.endsWith('-off') ? '思考关闭' : '思考开启';
        info.appendChild(mode);
      }
      const caps = Capabilities.resolve(p, m);
      if (caps.reasoningLevels.length) {
        const strength = document.createElement('span'); strength.className = 'model-option-id';
        strength.textContent = `强度：${m.reasoningEffort ? Capabilities.LABELS[m.reasoningEffort] : '默认'} · ${caps.reasoningLevels.join('/')}`;
        info.appendChild(strength);
      }
      if (m.reasoningProbe) {
        const note = document.createElement('span'); note.className = 'model-option-id';
        note.textContent = m.reasoningProbe.validation === 'validating' ? '已检测接口档位' : m.reasoningProbe.validation === 'non-validating' ? '接口未校验档位' : '档位检测未确认';
        note.title = m.reasoningProbe.reason + (m.reasoningProbe.probedAt ? ' · ' + new Date(m.reasoningProbe.probedAt).toLocaleString('zh-CN') : ''); info.appendChild(note);
      }
      row.appendChild(info);

      const [statusText, statusKind] = testStatusBadge(m);
      const status = document.createElement('span');
      status.className = 'test-status ' + statusKind;
      status.textContent = statusText + (m.lastTestAt ? ' · ' + new Date(m.lastTestAt).toLocaleString('zh-CN', { hour12: false }) : '');
      status.title = m.lastTestError || '';
      row.appendChild(status);

      if (m.isDefault) {
        const badge = document.createElement('span');
        badge.className = 'model-default-badge';
        badge.textContent = '默认';
        row.appendChild(badge);
      } else {
        const setDef = document.createElement('button');
        setDef.type = 'button';
        setDef.className = 'banner-btn subtle';
        setDef.textContent = '设为默认';
        setDef.onclick = () => modelAction(`/api/providers/${encodeURIComponent(p.providerId)}/models/${encodeURIComponent(m.modelId)}/default`, { method: 'POST' });
        row.appendChild(setDef);
      }

      const enableLabel = document.createElement('label');
      enableLabel.className = 'switch small';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = m.enabled;
      cb.onchange = async () => {
        const res = await modelAction(`/api/providers/${encodeURIComponent(p.providerId)}/models/${encodeURIComponent(m.modelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: cb.checked }),
        });
        if (isStaleConflict(res)) cb.checked = !cb.checked; // 编辑冲突被拒：恢复显示
      };
      enableLabel.appendChild(cb);
      enableLabel.appendChild(document.createTextNode('启用'));
      row.appendChild(enableLabel);

      // R7：已有模型的参数编辑入口（不靠删除重建；modelId 定位键不可改）
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'banner-btn subtle';
      editBtn.textContent = '编辑';
      editBtn.onclick = () => {
        editingModelId = editingModelId === m.modelId ? null : m.modelId;
        refreshOpenFormModels();
      };
      row.appendChild(editBtn);

      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'banner-btn';
      testBtn.title = '会真实发起一次最小 API 调用';
      testBtn.textContent = '测试';
      testBtn.onclick = async () => {
        testBtn.disabled = true;
        testBtn.textContent = '测试中…';
        // 测试是状态更新而非配置变更：不携带编辑版本、不递增 revision（R6），
        // 不会把其他窗口正在编辑的表单顶成编辑冲突
        await modelAction(`/api/providers/${encodeURIComponent(p.providerId)}/models/${encodeURIComponent(m.modelId)}/test`, { method: 'POST' }, { silent: true, carryRevision: false });
      };
      row.appendChild(testBtn);

      if (p.protocol === 'openai-chat-completions') {
        const detect = document.createElement('button'); detect.type = 'button'; detect.className = 'banner-btn subtle';
        const runningHere = state.reasoningDetection?.providerId === p.providerId && state.reasoningDetection?.modelId === m.modelId;
        detect.textContent = runningHere ? '检测中 · 取消' : !Capabilities.canProbe(p, m) ? (caps.reasoningLevels.length ? '查看强度' : '检测说明') : m.reasoningProbe ? '重新检测强度' : '检测强度';
        detect.title = !Capabilities.canProbe(p, m) ? '点击查看当前档位及来源；不会发送检测请求' : '最多 7 次真实 API 请求，只验证接口接受的档位，可能消耗额度';
        detect.onclick = async () => {
          if (state.reasoningDetection?.providerId === p.providerId && state.reasoningDetection?.modelId === m.modelId) { state.reasoningDetection.controller.abort(); return; }
          if (!Capabilities.canProbe(p, m)) {
            const source = { remote: '模型接口返回', official: '官方模型说明', manual: '手动配置', probe: '接口检测' }[caps.source] || '当前模型配置';
            showToast(caps.reasoningLevels.length ? `档位来源：${source}。支持${caps.reasoningLevels.map(level => Capabilities.LABELS[level] || level).join('、')}；可直接选择强度，无需检测。` : '当前能力配置未启用自动检测；可在编辑中切换到自动能力配置。'); return;
          }
          if (state.busy || state.reasoningDetection) { showToast('请等待当前生成或检测结束', 'error'); return; }
          if (!window.confirm('检测最多会发送 7 次真实 API 请求，可能消耗 API 费用和网站额度。只验证接口接受哪些档位，不保证推理效果改变。开始检测？')) return;
          const controller = new AbortController();
          state.reasoningDetection = { providerId: p.providerId, modelId: m.modelId, controller };
          setBusyUi(state.busy); detect.textContent = '检测中 · 取消';
          try {
            const res = await modelAction(`/api/providers/${encodeURIComponent(p.providerId)}/models/${encodeURIComponent(m.modelId)}/reasoning-detect`, {
              method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
            }, { silent: true, carryRevision: false });
            if (!res.ok) throw new Error(res.data?.error?.message || '检测失败');
            const outcome = res.data.outcome;
            showToast(`${outcome.reason} 本次请求 ${outcome.requests} 次。`, outcome.validation === 'validating' ? undefined : 'error');
          } catch (error) {
            showToast(controller.signal.aborted ? '检测已取消，未保存本次结果' : error.message, 'error');
          } finally { state.reasoningDetection = null; setBusyUi(state.busy); refreshOpenFormModels(); window.DiagramCloud?.refreshUsage(); }
        };
        row.appendChild(detect);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'banner-btn subtle';
      del.textContent = '删除';
      del.onclick = () => {
        if (!window.confirm(`确定删除模型「${m.displayName}」？已发出的历史回复不受影响。`)) return;
        modelAction(`/api/providers/${encodeURIComponent(p.providerId)}/models/${encodeURIComponent(m.modelId)}`, { method: 'DELETE' });
      };
      row.appendChild(del);
      box.appendChild(row);
      if (editingModelId === m.modelId) box.appendChild(buildModelEditor(p, m));
    }
  }

  /**
   * 管理操作统一入口（R6）：
   *   - 配置变更自动携带「表单打开时钉住的编辑版本」，服务端版本不一致 → 409，这里
   *     弹出编辑冲突横幅并保留用户当前输入（不刷新表单、不覆盖新配置）
   *   - 自己保存成功后用响应里的 revision 前进表单版本（后台刷新不会前进——
   *     否则另一窗口的修改会被静默吞掉）
   *   - 测试状态更新（carryRevision:false）不参与版本比较
   */
  async function modelAction(pathname, options, opts) {
    const conf = opts || {};
    const init = Object.assign({}, options);
    if (conf.carryRevision !== false && init.method && init.method !== 'GET' && state.providerFormRevision !== null) {
      let payload = {};
      if (typeof init.body === 'string') {
        try { payload = JSON.parse(init.body); } catch { payload = {}; }
      } else if (init.body && typeof init.body === 'object') {
        payload = init.body;
      }
      payload.revision = state.providerFormRevision;
      init.body = JSON.stringify(payload);
      init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers);
    }
    const res = await apiFetch(pathname, init);
    if (isStaleConflict(res)) {
      showStaleBanner();
      return res;
    }
    if (res.ok && res.data && Number.isInteger(res.data.revision)) {
      state.providerFormRevision = res.data.revision;
    }
    await refreshModelData();
    if (drawerOverlay && !drawerOverlay.classList.contains('hidden')) {
      renderProviderList();
      refreshOpenFormModels();
    }
    if (!conf.silent && res.data && res.data.error && res.data.error.message) {
      showToast('操作失败：' + res.data.error.message, 'error');
    }
    return res;
  }

  function collectProviderForm() {
    return {
      providerId: el('pfProviderId').value.trim(),
      name: el('pfName').value.trim(),
      baseUrl: el('pfBaseUrl').value.trim(),
      protocol: el('pfProtocol').value,
      apiKey: el('pfApiKey').value, // '' = 保留原密钥（服务端语义）
      enabled: el('pfEnabled').checked,
    };
  }

  function renderTemplates() {
    templateGrid.textContent = '';
    for (const t of PROVIDER_TEMPLATES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'tpl-card';
      const name = document.createElement('div');
      name.className = 'tpl-card-name';
      name.textContent = t.name;
      card.appendChild(name);
      const proto = document.createElement('div');
      proto.className = 'tpl-card-proto';
      proto.textContent = t.protocol === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat Completions';
      card.appendChild(proto);
      card.onclick = () => {
        tplOverlay.classList.add('hidden');
        openDrawer();
        editingProviderId = null;
        resetProviderDraft();
        editingModelId = null;
        state.providerFormRevision = state.providerRevision;
        hideStaleBanner();
        clearFieldErrors();
        renderProviderList();
        providerForm.classList.remove('hidden');
        providerEmpty.classList.add('hidden');
        el('pfProviderId').disabled = false;
        el('pfProviderId').value = t.providerId;
        el('pfName').value = t.name;
        el('pfBaseUrl').value = t.baseUrl;
        el('pfProtocol').value = t.protocol;
        el('pfApiKey').value = t.apiKey;
        el('pfApiKey').placeholder = '输入 API 密钥';
        el('pfEnabled').checked = true;
        el('authKindBadge').textContent = '';
        el('clearKeyBtn').classList.add('hidden');
        el('deleteProviderBtn').classList.add('hidden');
        el('pfProviderId').focus();
      };
      templateGrid.appendChild(card);
    }
  }

  // ---------- 初始化 ----------
  async function init() {
    if (!Xml || !Model || !File) {
      showToast('共享解析模块加载失败，请刷新页面', 'error');
      return;
    }
    restoreDraft();
    try{state.multimodalEnabled=localStorage.getItem(MULTIMODAL_KEY)==='true';}catch(e){}
    renderVision();
    try {
      const resp = await fetch('/api/config');
      if (resp.ok) state.config = Object.assign(state.config, await resp.json());
    } catch (e) { /* 使用默认值 */ }

    await initSession();

    // Recover an existing server job independently of the model directory.
    const modelRefresh = refreshModelData().catch(() => {});

    prepareRequirementsHandoff();

    editorStartPage = state.pageIndex;
    frame.src = editorUrl(editorStartPage);

    aiStatus.classList.add(state.config.aiEnabled ? 'ok' : 'err');
    const selInfo = state.selectionInfo;
    aiStatusText.textContent = (selInfo && selInfo.valid)
      ? `已配置 · ${selInfo.providerName} / ${selInfo.modelName}`
      : '示例引擎（未配置模型）';

    if (!state.payload) {
      state.payload = EMPTY_MODEL;
      state.payloadKind = 'model';
      state.modelXml = EMPTY_MODEL;
      setCanvasStatus();
    }

    armEditorLoadingWatchdog();
    await modelRefresh;
  }

  // draw.io 来自在线 embed，网络受限时既不报错也不 load，只会一直转圈。
  // 分两级处理：15 秒改成「较慢」文案，30 秒还没 init 就给出可点的重试/跳过入口，
  // 否则用户只能刷新整页，连本地已保存的会话也会被一起丢掉。
  let editorWatchdog = null;
  let editorRetryTimer = null;

  function armEditorLoadingWatchdog() {
    clearTimeout(editorWatchdog);
    clearTimeout(editorRetryTimer);
    const slowHint = 'draw.io 编辑器加载较慢，请检查网络（需要访问 ' + state.config.embedUrl + '）…';
    editorWatchdog = setTimeout(() => {
      if (state.ready) return;
      const p = editorLoading.querySelector('p');
      if (p) p.textContent = slowHint;
      editorRetryTimer = setTimeout(() => {
        // 期间用户可能已经手动成功，或页面被切走；只在仍然没就绪时接管提示区
        if (state.ready || !editorLoading.isConnected) return;
        showEditorLoadingFailure();
      }, 15000);
    }, 15000);
  }

  function showEditorLoadingFailure() {
    if (editorLoading.querySelector('.editor-loading-actions')) return; // 已经渲染过
    const p = editorLoading.querySelector('p');
    if (p) {
      p.textContent = '未能加载 draw.io 编辑器。检查网络后可以重试；也可以先下载图表文件，'
        + '或打开纯对话页继续使用。';
    }
    const spinner = editorLoading.querySelector('.spinner');
    if (spinner) spinner.classList.add('hidden'); // 失败态不该继续转圈
    const actions = document.createElement('div');
    actions.className = 'editor-loading-actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'banner-btn primary';
    retry.textContent = '重新加载编辑器';
    retry.addEventListener('click', retryEditorLoad);
    const chat = document.createElement('a');
    chat.className = 'banner-btn';
    chat.href = '/chat.html';
    chat.textContent = '先打开纯对话';
    actions.append(retry, chat);
    editorLoading.appendChild(actions);
    // 样式随逻辑一起注入：这块 UI 只在这里出现，放进主样式表反而会让人找不到它
    injectEditorLoadingStyles();
  }

  /** 失败兜底界面的样式（幂等，只在首次需要时插入一次） */
  function injectEditorLoadingStyles() {
    if (document.getElementById('editorLoadingStyles')) return;
    const style = document.createElement('style');
    style.id = 'editorLoadingStyles';
    style.textContent = `
      .editor-loading p { max-width: 34em; text-align: center; line-height: 1.7; }
      .editor-loading-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 4px; }
      .editor-loading-actions .banner-btn { display: inline-flex; align-items: center; justify-content: center;
        min-height: 40px; min-width: 96px; padding: 9px 16px; font-size: 13px; font-family: inherit;
        line-height: 1.2; text-decoration: none; border-radius: 7px; }
      @media (max-width: 480px) {
        .editor-loading-actions { flex-direction: column; width: min(100%, 260px); }
        .editor-loading-actions .banner-btn { width: 100%; }
      }
    `;
    document.head.appendChild(style);
  }

  function retryEditorLoad() {
    clearTimeout(editorWatchdog);
    clearTimeout(editorRetryTimer);
    // 重置提示区，重新走一遍加载流程
    editorLoading.replaceChildren();
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    const text = document.createElement('p');
    text.textContent = '正在重新加载 draw.io 编辑器…';
    editorLoading.append(spinner, text);
    editorStartPage = state.pageIndex;
    // 加时间戳绕过缓存/旧连接，确保拿到新的一次 init
    frame.src = editorUrl(editorStartPage) + '&_r=' + Date.now();
    armEditorLoadingWatchdog();
  }

  // ---------- 事件绑定 ----------
  window.addEventListener('message', onWindowMessage);

  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = chatInput.value;
    if (!text.trim()&&!state.attachments.length) return;
    if(state.attachmentsImporting){setHint('正在读取图片，请稍后发送；草稿已保留。');return;}
    if(state.attachments.length&&!state.multimodalEnabled){setHint('请先开启「多模态」，再发送图片；草稿和附件已保留。');return;}
    if(state.multimodalEnabled&&!visionModel()){setHint('请选择支持图片输入的模型；草稿已保留。');return;}
    if (state.busy || state.sessionBusy || state.editCapturing || state.pendingLoad) {
      // 忙碌时不接收这次发送，但绝不清空草稿
      setHint('正在生成中：草稿已保留，本次发送被忽略，稍后再按 Enter 即可。');
      return;
    }
    if(state.pendingResult?.edit||state.pendingResult?.visual){setHint('请先应用或丢弃暂存的修改；草稿已保留。');return;}
    if(state.editContext?.invalid){setHint('选区未锁定，请重新选择或退出局部修改；草稿已保留。');return;}
    chatInput.value = '';
    saveDraft();
    sendMessage(text,{attachments:state.attachments}).then(result=>{if(!result.ok&&!chatInput.value.trim())setDraft(text);});
  });

  el('attachImageBtn').addEventListener('click',()=>el('chatImageInput').click());
  el('chatImageInput').addEventListener('change',async e=>{await addChatImages(e.target.files);e.target.value='';});
  chatInput.addEventListener('paste',e=>{
    const files=Array.from(e.clipboardData?.files||[]).filter(f=>f.type.startsWith('image/'));
    if(files.length){e.preventDefault();addChatImages(files);}
  });
  chatForm.addEventListener('dragover',e=>{if(Array.from(e.dataTransfer?.types||[]).includes('Files')){e.preventDefault();if(state.multimodalEnabled)chatForm.classList.add('drag-over');}});
  chatForm.addEventListener('dragleave',()=>chatForm.classList.remove('drag-over'));
  chatForm.addEventListener('drop',e=>{e.preventDefault();chatForm.classList.remove('drag-over');const files=Array.from(e.dataTransfer?.files||[]);if(files.length)addChatImages(files);});
  chatInput.addEventListener('input', () => { saveDraft(); markSessionDirty(); });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      chatForm.requestSubmit();
    }
  });

  el('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip || state.busy || state.sessionBusy || state.editCapturing) return;
    clearEditContext();
    // A style replaces the previous style instruction without replacing the user's diagram request.
    const draft = chip.dataset.style
      ? chatInput.value.replace(/^【绘图风格：[^\r\n]*】[^\r\n]*(?:\r?\n|$)/gm, '').trim()
      : chatInput.value.trim();
    setDraft([draft,chip.dataset.prompt].filter(Boolean).join('\n'));
    el('chips').open=false;markSessionDirty();chatInput.focus();
  });

  window.addEventListener('click',e=>{
    for(const id of ['chips','visionPanel']){const menu=el(id);if(menu.open&&!menu.contains?.(e.target))menu.open=false;}
  });
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape')for(const id of ['chips','visionPanel']){const menu=el(id);if(menu.open){menu.open=false;menu.querySelector('summary')?.focus();}}
  });
  el('applyPendingBtn').addEventListener('click', applyPendingResult);
  el('discardPendingBtn').addEventListener('click', () => {
    state.pendingResult = null;
    renderVision();setBusyUi(state.busy);
    markSessionDirty();
    conflictBanner.classList.add('hidden');
    showToast('已丢弃暂存的 AI 结果，画布保持你的编辑');
  });

  el('undoBtn').addEventListener('click', async () => {
    const snapshot = state.snapshots[state.snapshots.length - 1];
    if (!snapshot) { showToast('还没有可撤销的 AI 修改', 'error'); return; }
    await restoreSnapshot(snapshot.id);
  });

  el('exportPngBtn').addEventListener('click', exportPng);
  el('newDiagramBtn')?.addEventListener('click', () => replaceSession(emptySession()));
  el('importDiagramBtn')?.addEventListener('click', () => el('diagramFileInput').click());
  el('diagramFileInput')?.addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''; await importDiagram(file);
  });
  el('recoverSessionBtn')?.addEventListener('click', () => el('recoveryDialog').classList.remove('hidden'));
  el('recoverCurrentBtn')?.addEventListener('click', async () => {
    el('recoveryDialog').classList.add('hidden'); await recoverSession('current');
  });
  el('recoverPreviousBtn')?.addEventListener('click', async () => {
    el('recoveryDialog').classList.add('hidden'); await recoverSession('previous');
  });
  el('closeRecoveryBtn')?.addEventListener('click', () => el('recoveryDialog').classList.add('hidden'));
  el('saveStatus')?.addEventListener('click', async () => {
    if (!session.repository) await reconnectSessionStorage();
    else if (!session.blocked) { markSessionDirty(); await flushSession(); }
  });
  window.addEventListener('beforeunload', e => {
    if (session.dirty || state.busy || state.sessionBusy || state.pendingLoad) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => {
    saveDraft(); void flushSession();
    if (state.activeRequest?.taskId) { state.activeRequest.detached = true; state.activeRequest.controller.abort(); }
  });
  window.addEventListener('pageshow', event => { if (event.persisted) void resumeDrawingTask(); });
  document.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { saveDraft(); flushSession(); }
  });
  // Page switches do not always emit autosave. Periodic full sync also catches
  // edits which the iframe has not autosaved yet; stop work while it is hidden.
  function pollSession() {
    setTimeout(async () => {
      if (session.repository && !session.blocked && state.ready && !state.busy && !state.sessionBusy && !state.pendingLoad && document.visibilityState !== 'hidden') {
        const synced = await syncWithEditor({ timeout: SYNC_TIMEOUT_MS });
        if (synced.ok) await flushSession();
        else setSaveStatus('画布同步失败 · 请稍后重试保存', true);
      }
      pollSession();
    }, 5000);
  }
  if (window.DiagramSessions && window.indexedDB) pollSession();

  // ---------- 模型选择器与设置抽屉事件 ----------
  thinkingToggle.addEventListener('click', toggleThinking);
  reasoningEffortSelect.addEventListener('change', saveReasoningEffort);
  modelSelectBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (modelDropdown.classList.contains('hidden')) openModelDropdown();
    else closeModelDropdown();
  });
  modelDropdown.addEventListener('click', (e) => e.stopPropagation());
  modelDropdown.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === modelSearch) { event.preventDefault(); modelGroups.querySelector('.model-option')?.focus(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Escape') { event.stopPropagation(); closeModelDropdown(); modelSelectBtn.focus(); return; }
    const rows = [...modelGroups.querySelectorAll('.model-option')], index = rows.indexOf(document.activeElement);
    if (rows.length) rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
  });
  // 测试 VM 桩可能没有 document.addEventListener，防御性调用
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      if (!modelDropdown.classList.contains('hidden') && !e.target.closest('.model-select-wrap')) closeModelDropdown();
      if (!tplOverlay.classList.contains('hidden') && !e.target.closest('.tpl-dialog')) tplOverlay.classList.add('hidden');
    });
  }
  modelSearch.addEventListener('input', renderModelDropdown);

  el('modelSettingsBtn').addEventListener('click', () => {
    renderTemplates();
    openDrawer();
  });
  el('drawerCloseBtn').addEventListener('click', closeDrawer);
  drawerOverlay.addEventListener('click', (e) => { if (e.target === drawerOverlay) closeDrawer(); });
  el('addTemplateBtn').addEventListener('click', (e) => {
    // 阻止冒泡：同一点击事件到达 document 监听器会把刚打开的弹窗立即关掉
    e.stopPropagation();
    renderTemplates();
    tplOverlay.classList.remove('hidden');
  });
  el('tplCloseBtn').addEventListener('click', () => tplOverlay.classList.add('hidden'));
  el('customProviderBtn').addEventListener('click', () => {
    tplOverlay.classList.add('hidden');
    openDrawer();
    showProviderForm(null);
  });

  el('clearKeyBtn').addEventListener('click', async () => {
    if (!editingProviderId) return;
    if (!window.confirm('确定清除该提供商的 API 密钥？')) return;
    const res = await modelAction(`/api/providers/${encodeURIComponent(editingProviderId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearKey: true }),
    });
    if (res.ok) showToast('已清除密钥');
  });

  providerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearFieldErrors();
    const form = collectProviderForm();
    if (!editingProviderId) form.models = draftProviderModels;
    // R6：携带表单打开时钉住的编辑版本；过期写入会被服务端以 409 拒绝
    if (state.providerFormRevision !== null) form.revision = state.providerFormRevision;
    let res;
    if (editingProviderId) {
      res = await apiFetch(`/api/providers/${encodeURIComponent(editingProviderId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
    } else {
      res = await apiFetch('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
    }
    if (isStaleConflict(res)) {
      // 编辑冲突：不覆盖新配置，也不清掉用户当前输入；横幅提供「重新加载」入口
      showStaleBanner();
      return;
    }
    if (!res.ok) {
      const fields = res.data && res.data.detail && res.data.detail.fields;
      if (fields) {
        for (const [key, msg] of Object.entries(fields)) {
          const map = { providerId: 'errProviderId', name: 'errName', baseUrl: 'errBaseUrl', protocol: 'errProtocol', apiKey: 'errApiKey' };
          if (map[key]) setFieldError(map[key], msg);
        }
      }
      showToast('保存失败：' + ((res.data && res.data.error && res.data.error.message) || `HTTP ${res.status}`), 'error');
      return;
    }
    if (res.data && Number.isInteger(res.data.revision)) state.providerFormRevision = res.data.revision;
    const savedId = editingProviderId || (res.data.provider && res.data.provider.providerId);
    await refreshModelData();
    renderProviderList();
    if (savedId) showProviderForm(savedId);
    showToast('已保存并立即生效（无需重启）');
  });

  el('reloadConfigBtn').addEventListener('click', reloadProviderForm);

  el('deleteProviderBtn').addEventListener('click', async () => {
    if (!editingProviderId) return;
    if (!window.confirm(`确定删除提供商「${el('pfName').value}」及其全部模型配置？历史回复的来源标记不受影响。`)) return;
    const res = await modelAction(`/api/providers/${encodeURIComponent(editingProviderId)}`, { method: 'DELETE' });
    if (res.ok) {
      editingProviderId = null;
      showProviderForm(null);
      showToast('已删除提供商');
    }
  });

  el('addModelBtn').addEventListener('click', async () => {
    setFieldError('errModel', '');
    const maxTokensRaw = el('nmMaxTokens').value;
    const tempRaw = el('nmTemperature').value;
    const payload = {
      modelId: el('nmModelId').value,
      displayName: el('nmDisplayName').value || undefined,
      maxTokens: maxTokensRaw === '' ? undefined : Number(maxTokensRaw),
      temperature: tempRaw === '' ? undefined : Number(tempRaw),
      thinkingMode: el('nmThinkingMode').value || 'default',
    };
    if (!editingProviderId) {
      if (!payload.modelId.trim() || draftProviderModels.some(m => m.modelId === payload.modelId)) {
        setFieldError('errModel', '请输入模型 ID，且不要重复添加'); return;
      }
      draftProviderModels.push(payload);
      renderDraftModels();
      el('nmModelId').value = ''; el('nmDisplayName').value = '';
      el('nmMaxTokens').value = ''; el('nmTemperature').value = '';
      el('nmThinkingMode').value = 'default';
      return;
    }
    const res = await modelAction(`/api/providers/${encodeURIComponent(editingProviderId)}/models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      el('nmModelId').value = '';
      el('nmDisplayName').value = '';
      el('nmMaxTokens').value = '';
      el('nmTemperature').value = '';
      el('nmThinkingMode').value = 'default';
    } else if (!isStaleConflict(res)) {
      const fields = res.data && res.data.detail && res.data.detail.fields;
      setFieldError('errModel', (fields && (fields.modelId || fields.maxTokens || fields.temperature || fields.thinkingMode)) || (res.data.error && res.data.error.message) || '添加失败');
    }
  });

  el('fetchModelsBtn').addEventListener('click', async () => {
    const box = el('fetchResult');
    const version = ++providerFetchVersion;
    const scope = window.DiagramCloud?.scope;
    const providerId = editingProviderId;
    const form = collectProviderForm();
    const signature = JSON.stringify([form.baseUrl, form.protocol, form.apiKey]);
    const current = () => version === providerFetchVersion && scope === window.DiagramCloud?.scope
      && providerId === editingProviderId && signature === JSON.stringify([el('pfBaseUrl').value.trim(), el('pfProtocol').value, el('pfApiKey').value]);
    el('fetchModelsBtn').disabled = true;
    box.classList.remove('hidden');
    box.textContent = '正在从该提供商获取模型列表…';
    let res;
    try {
      res = await apiFetch('/api/providers/models/fetch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: form.baseUrl, protocol: form.protocol, apiKey: form.apiKey,
          ...(providerId ? { savedProviderId: providerId } : {}) }),
      });
    } catch (e) {
      if (current()) box.textContent = '获取失败，请检查网络后重试。';
      return;
    } finally {
      if (version === providerFetchVersion) el('fetchModelsBtn').disabled = false;
    }
    if (!current()) {
      if (version === providerFetchVersion) box.textContent = '表单已变化，请重新获取模型列表。';
      return;
    }
    box.textContent = '';
    if (!res.ok || !res.data.ok) {
      const error = typeof res.data.error === 'string' ? res.data.error : res.data.error?.message;
      box.textContent = '获取失败：' + (error || `HTTP ${res.status}`) + '（不影响手动添加模型。）';
      return;
    }
    const ids = res.data.models || [];
    if (ids.length === 0) {
      box.textContent = '该提供商没有返回任何模型。';
      return;
    }
    const note = document.createElement('div');
    note.className = 'fetch-note';
    note.textContent = `获取到 ${ids.length} 个模型，点击添加${providerId ? '：' : '，最后保存提供商：'}`;
    box.appendChild(note);
    for (const id of ids) {
      const row = document.createElement('div');
      row.className = 'fetch-row';
      const span = document.createElement('span');
      span.textContent = id;
      row.appendChild(span);
      const existing = (state.providers || []).find((p) => p.providerId === editingProviderId);
      const already = existing?.models.some((m) => m.modelId === id) || draftProviderModels.some(m => m.modelId === id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'banner-btn subtle';
      btn.textContent = already ? '已添加' : '添加';
      btn.disabled = Boolean(already);
      btn.dataset.modelId = id;
      btn.onclick = async () => {
        if (!current()) { showToast('表单已变化，请重新获取模型列表', 'error'); return; }
        if (!providerId) {
          if (!draftProviderModels.some(m => m.modelId === id)) draftProviderModels.push({ modelId: id,
            remoteCapabilities: (res.data.modelDetails || []).find(m => m.modelId === id)?.remoteCapabilities });
          renderDraftModels(); btn.textContent = '已添加'; btn.disabled = true;
          return;
        }
        const addRes = await modelAction(`/api/providers/${encodeURIComponent(editingProviderId)}/models`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: id, remoteCapabilities: (res.data.modelDetails || []).find(m => m.modelId === id)?.remoteCapabilities }),
        });
        if (addRes.ok) { btn.textContent = '已添加'; btn.disabled = true; }
      };
      row.appendChild(btn);
      box.appendChild(row);
    }
  });

  el('downloadBtn').addEventListener('click', async () => {
    if (!state.ready || state.sessionBusy || state.pendingLoad) { showToast('请等待编辑器完成加载', 'error'); return; }
    const sync = await syncWithEditor({ timeout: SYNC_TIMEOUT_MS });
    if (!sync.docOk) { showToast('无法获取最新图表，请稍后重试下载', 'error'); return; }
    const built = buildDownloadContent();
    if (!built.ok) { showToast('无法下载：' + built.error, 'error'); return; }
    downloadText(built.content, session.name.replace(/[\\/:*?"<>|]/g, '-') + '.drawio', 'application/xml');
    if (TEST_MODE && typeof testHooks.onDownload === 'function') testHooks.onDownload(built.content);
    showToast(built.wrapped ? '已下载单页 .drawio（已包裹为完整文件）' : '已下载完整 .drawio（多页内容已保留）');
  });

  // ---------- 测试钩子（仅在 ?test=1 时暴露） ----------
  const testHooks = {
    state,
    sessionState: () => ({ dirty: session.dirty, blocked: session.blocked, storeRevision: session.storeRevision, name: session.name }),
    captureSession, flushSession, replaceSession, emptySession, recoverSession, importDiagram,
    useSessionRepository: repository => { session.repository = repository; session.initialized = true; session.blocked = false; },
    config: () => state.config,
    ingest: (msg, meta) => handleEditorMessage(msg, meta || { currentPage: 0 }),
    sendMessage, resumeDrawingTask,
    captureEditSelection,
    toggleMultimodal, setVisionReference, prepareVisionSnapshot, addChatImages, renderAttachments,
    clearEditContext,
    cancelRequest,
    readChatResponse,
    syncWithEditor,
    parsePageIndex,
    queryEditor,
    buildDownloadContent,
    validatePayload,
    pagesSignature: () => pagesSignature(state.payload),
    docFingerprint: () => docFingerprint(state.payload),
    pageContentFingerprint: (pageId) => pageContentFingerprint(state.payload, pageId === undefined ? state.pageId : pageId),
    pendingResult: () => state.pendingResult,
    applyPendingResult,
    discardPending: () => { state.pendingResult = null; conflictBanner.classList.add('hidden');renderVision();setBusyUi(state.busy); },
    snapshots: () => state.snapshots.slice(),
    restoreSnapshot,
    loadPayload: (payload, options) => loadIntoEditor(payload, options),
    settlePendingLoad,
    setLoadTimeout: (ms) => { loadTimeoutMs = ms; return loadTimeoutMs; },
    syncFromPayload,
    requestExport,
    exportPng,
    draftValue: () => chatInput.value,
    setDraft,
    isReady: () => state.ready,
    onDownload: null,
    onExport: null,
    // 模型管理测试钩子
    modelSelection: () => ({ selection: state.selection, info: state.selectionInfo }),
    setModelSelection: (sel) => {
      state.selection = sel;
      state.selectionInfo = validateSelection(sel);
      saveSelectionToStorage();
      updateModelSelectorLabel();
      return state.selectionInfo;
    },
    refreshModelData,
    modelCatalog: () => state.modelCatalog,
    openModelDropdown,
    closeModelDropdown,
    renderModelDropdown,
    // 提供商设置（R6/R7）：编辑版本、冲突横幅与模型编辑器
    settingsState: () => ({
      providerRevision: state.providerRevision,
      providerFormRevision: state.providerFormRevision,
      editingProviderId,
      editingModelId,
      staleBannerVisible: !(el('staleBanner') && el('staleBanner').classList.contains('hidden')),
    }),
    showProviderForm,
    renderProviderModels,
    buildModelEditor,
    reloadProviderForm,
    setEditingModelId: (id) => { editingModelId = id; return editingModelId; },
    validateSelection,
  };
  if (TEST_MODE) window.__DIAGRAM_AI_TEST__ = testHooks;

  if(window.DiagramCloud){window.DiagramCloud.onScopeChange=async()=>{editingProviderId=null;editingModelId=null;await refreshModelData();renderProviderList();showProviderForm(null);};}
  init();
})();
