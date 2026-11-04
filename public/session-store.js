// Browser-only session persistence. One IndexedDB transaction publishes the
// current session and (when replacing it) its previous-session backup together.
(function (global, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../lib/drawio-format') : global.DiagramFile,
    typeof module === 'object' && module.exports ? require('../lib/graphmodel') : global.DiagramModel,
    typeof module === 'object' && module.exports ? require('../lib/xml') : global.DiagramXml,
    typeof module === 'object' && module.exports ? require('../lib/diagram-edit') : global.DiagramEdit,
    typeof module === 'object' && module.exports ? require('../lib/vision-repair') : global.DiagramVisualRepair,
    typeof module === 'object' && module.exports ? require('../lib/vision-check') : global.DiagramVision,
    typeof module === 'object' && module.exports ? require('./turn-usage') : global.DiagramTurnUsage);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.DiagramSessions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (File, Model, Xml, Edit, VisualRepair, Vision, TurnUsage) {
  'use strict';
  const DB_NAME = 'diagramai.sessions';
  const MAX_PAYLOAD = 2000000;
  const isObject = x => x && typeof x === 'object' && !Array.isArray(x);
  const text = (x, max = 16000) => typeof x === 'string' ? x.slice(0, max) : '';
  function selection(x) {
    return isObject(x) && typeof x.providerId === 'string' && typeof x.modelId === 'string'
      ? { providerId: text(x.providerId, 200), modelId: text(x.modelId, 200) } : null;
  }
  function editContext(x) {
    if (!x) return null;
    if(isObject(x)&&x.invalid===true)return {invalid:true};
    if (!isObject(x) || typeof x.baseXml !== 'string' || x.baseXml.length > MAX_PAYLOAD || !Number.isInteger(x.pageIndex) || x.pageIndex < 0) throw new Error('局部修改重试数据不合法');
    const scope=Edit.resolveScope(x.baseXml,x.targetIds);
    return {baseXml:x.baseXml,targetIds:scope.targetIds,pageIndex:x.pageIndex,pageId:typeof x.pageId==='string'?x.pageId:null,labels:scope.cells.map(c=>c.label||c.id)};
  }
  const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  // Only the recovery baseline and safe selection are persisted, never an API
  // request body (which may contain transient screenshots or credentials).
  function drawingTask(value) {
    if (!value) return null;
    if (!isObject(value) || ![value.taskId,value.threadId,value.assistantId].every(id => typeof id === 'string' && UUID.test(id)) || !['pending','settled'].includes(value.status)) throw new Error('绘图任务恢复信息无效');
    if (value.status === 'settled') return { taskId:value.taskId,threadId:value.threadId,assistantId:value.assistantId,status:'settled' };
    const chosen = selection(value.selection), base = value.base;
    if (!chosen || !isObject(base) || !Number.isSafeInteger(base.revision) || base.revision < 0 || !['chat','vision'].includes(value.mode)) throw new Error('绘图任务基线无效');
    let visualContext = null;
    if (value.visualContext) {
      const visual = value.visualContext;
      if (!['visual','multimodal'].includes(visual.mode) || typeof visual.baseXml !== 'string' || visual.baseXml.length > MAX_PAYLOAD || !Model.validateGraphModel(visual.baseXml).ok) throw new Error('绘图任务视觉基线无效');
      visualContext = { baseXml:visual.baseXml,mode:visual.mode,pageId:typeof visual.pageId === 'string'?visual.pageId:null,pageIndex:visual.pageIndex };
    }
    return { taskId:value.taskId,threadId:value.threadId,assistantId:value.assistantId,status:'pending',mode:value.mode,
      message:text(value.message,4000),selection:chosen,turnId:typeof value.turnId === 'string' && UUID.test(value.turnId)?value.turnId:null,
      base:{...documentData(base.payload,base.pageIndex,base.pageId),revision:base.revision},
      attachments:Vision.validateImages(value.attachments).map(image=>image.data),editContext:editContext(value.editContext),visualContext };
  }
  function documentData(payload, pageIndex, pageId) {
    if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) throw new Error('会话图表为空或超过本地保存上限');
    const info = File.parseFile(payload);
    if (!['model', 'mxfile'].includes(info.kind) || !info.pages.length || info.warning) throw new Error('会话中的图表文件不合法');
    const ids = new Set();
    for (const page of info.pages) {
      if (page.id != null && (!page.id || ids.has(page.id))) throw new Error('会话包含重复或空的页面 ID');
      if (page.id != null) ids.add(page.id);
      if (info.kind === 'mxfile') {
        const diagram = info.doc.root.children[page.index];
        if (page.encoding === 'xml' ? diagram.children.length !== 1 || Xml.textOf(diagram).trim() : diagram.children.length !== 0) throw new Error('会话页面包含多余内容');
      }
      if (page.encoding === 'xml') {
        const r = Model.validateGraphModel(Xml.sliceNode(payload, page.modelNode));
        if (!r.ok) throw new Error(r.error.message);
      } else if (page.encoding === 'encoded' && !/^[A-Za-z0-9+/=\s]+$/.test(page.encodedText)) {
        throw new Error('会话包含无效压缩页面');
      }
    }
    let index = pageId != null ? File.findPageIndexById(info, pageId) : pageIndex;
    if (info.kind === 'model') index = 0;
    if (!Number.isInteger(index) || index < 0 || index >= info.pageCount) throw new Error('会话当前页不存在');
    return { payload, pageIndex: index, pageId: info.kind === 'mxfile' ? (info.pages[index].id ?? info.pages[index].name) : null };
  }
  function normalize(data) {
    if (!isObject(data) || data.version !== 1) throw new Error('无法读取此版本的会话，原备份已保留');
    const doc = documentData(data.payload, data.pageIndex, data.pageId);
    if (!Array.isArray(data.history) || !Array.isArray(data.messages) || !Array.isArray(data.snapshots)) throw new Error('会话数据不完整');
    const history = data.history.slice(-16).map(m => {
      if (!isObject(m) || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new Error('聊天上下文损坏');
      const images=m.role==='user'?Vision.validateImages(m.images).map(i=>i.data):[];
      return { role: m.role, content: text(m.content, 4000), ...(images.length?{images}:{}) };
    });
    const messages = data.messages.slice(-200).map(m => {
      if (!isObject(m) || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string') throw new Error('聊天记录损坏');
      const retry = m.retry && selection(m.retry.selection);
      return { role: m.role, text: text(m.text), kind: ['error', 'conflict'].includes(m.kind) ? m.kind : '',
        ...(m.role==='user'&&m.images?.length?{images:Vision.validateImages(m.images).map(i=>i.data)}:{}),
        ...(typeof m.taskId === 'string' && UUID.test(m.taskId)?{taskId:m.taskId}:{}),
        source: text(m.source, 500), retry: retry ? { text: text(m.retry.text, 4000), selection: retry, editContext: editContext(m.retry.editContext) } : null,
        ...(m.role==='assistant' && TurnUsage?.normalize(m.turnUsage) ? {turnUsage:TurnUsage.normalize(m.turnUsage)} : {}) };
    });
    const snapshots = data.snapshots.slice(-10).map(s => ({ ...documentData(s.payload, s.pageIndex, s.pageId),
      id: text(s.id, 100), label: text(s.label, 200), time: text(s.time, 100) }));
    let pendingResult = null;
    if (data.pendingResult) {
      const p = data.pendingResult;
      documentData(p.xml, 0, null);
      pendingResult = { xml: p.xml, reply: text(p.reply), pageIndex: p.pageIndex,
        pageId: typeof p.pageId === 'string' ? p.pageId : null, requestRevision: p.requestRevision };
      if(p.visual){
        if(p.edit||!isObject(p.visual)||typeof p.visual.baseXml!=='string'||p.visual.baseXml.length>MAX_PAYLOAD)throw new Error('暂存视觉修复的基线不合法');
        if(p.visual.mode!==undefined&&!['visual','multimodal'].includes(p.visual.mode))throw new Error('暂存整页修改模式不合法');
        pendingResult.visual={baseXml:p.visual.baseXml,changes:VisualRepair.validateCandidate(p.visual.baseXml,p.xml,p.visual.mode),...(p.visual.mode?{mode:p.visual.mode}:{})};
      }
      if(p.edit) {
        if(!isObject(p.edit)||typeof p.edit.baseXml!=='string'||p.edit.baseXml.length>MAX_PAYLOAD)throw new Error('暂存局部修改的基线不合法');
        const verified=Edit.verifyCandidate(p.edit.baseXml,{...p.edit,xml:p.xml},p.edit.targetIds);
        pendingResult.edit={baseXml:p.edit.baseXml,targetIds:verified.targetIds,patch:verified.patch,idMap:verified.idMap,changes:verified.changes,requiresReview:verified.requiresReview};
      }
    }
    const retrySelection = data.retry && selection(data.retry.selection);
    return { version: 1, ...doc, name: text(data.name, 200) || '未命名图表', revision: Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0,
      drawingTask:drawingTask(data.drawingTask), draft: text(data.draft, 4000), attachments:Vision.validateImages(data.attachments).map(i=>i.data), history, messages, snapshots, pendingResult, editContext: editContext(data.editContext),
      retry: retrySelection ? { text: text(data.retry.text, 4000), selection: retrySelection, editContext: editContext(data.retry.editContext) } : null };
  }
  function decode(record) {
    if (!record) return null;
    if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1) throw new Error('本地会话版本不合法，原备份已保留');
    return { version: 1, revision: record.revision, savedAt: record.savedAt, data: normalize(record.data) };
  }
  function open(indexedDB, name = DB_NAME) {
    return new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new Error('此浏览器无法使用本地会话存储，请下载图表备份'));
      const request = indexedDB.open(name, 1);
      let settled = false;
      const fail = error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => fail(new Error('打开本地存储超时，请关闭其他旧版本页面后重试')), 4000);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('sessions')) request.result.createObjectStore('sessions');
      };
      request.onerror = () => fail(request.error || new Error('打开本地存储失败'));
      request.onblocked = () => fail(new Error('本地存储被其他页面阻塞，请关闭旧页面后重试'));
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer);
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve({
          revision() {
            return new Promise((res, rej) => {
              const tx = db.transaction('sessions', 'readonly');
              const read = tx.objectStore('sessions').get('current');
              let revision = 0;
              read.onsuccess = () => { revision = read.result?.revision || 0; };
              tx.oncomplete = () => Number.isSafeInteger(revision) && revision >= 0 ? res(revision) : rej(new Error('存储版本损坏，请下载备份后清除网站数据'));
              tx.onabort = () => rej(tx.error || new Error('读取存储版本失败'));
            });
          },
          read(key = 'current') {
            return new Promise((res, rej) => {
              const tx = db.transaction('sessions', 'readonly');
              const read = tx.objectStore('sessions').get(key);
              let value;
              read.onsuccess = () => { value = read.result; };
              tx.oncomplete = () => { try { res(decode(value)); } catch (e) { rej(e); } };
              tx.onabort = () => rej(tx.error || new Error('读取本地会话失败'));
            });
          },
          save(data, expectedRevision, options = {}) {
            const clean = normalize(data);
            return new Promise((res, rej) => {
              const tx = db.transaction('sessions', 'readwrite');
              const store = tx.objectStore('sessions');
              const read = store.get('current');
              let failure;
              let record;
              read.onsuccess = () => {
                try {
                const previous = read.result;
                if ((previous?.revision || 0) !== expectedRevision) {
                  failure = new Error('会话已在其他标签页更新，请先下载当前图表，再恢复已保存会话');
                  failure.name = 'SessionConflictError';
                  tx.abort(); return;
                }
                record = { version: 1, revision: expectedRevision + 1, savedAt: Date.now(), data: clean };
                if (options.backup && previous) store.put(previous, 'previous');
                store.put(record, 'current');
                } catch (e) { failure = e; tx.abort(); }
              };
              tx.oncomplete = () => res(record);
              tx.onabort = () => rej(failure || tx.error || new Error('保存失败，原会话备份已保留'));
            });
          },
          close: () => db.close(),
        });
      };
    });
  }
  return { open, normalize, documentData, drawingTask, DB_NAME };
});
