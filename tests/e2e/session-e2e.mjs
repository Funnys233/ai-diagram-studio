// Real Chromium + real IndexedDB, with a local protocol fixture instead of the
// remote draw.io editor. No user providers, credentials or paid calls are used.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const require = createRequire(import.meta.url);
const { sampleModel, modelWithManualNode, buildMxfile } = require('../helpers/fixtures.js');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'diagramai-session-e2e-'));
const { check, failures, results } = makeChecker();
const fake = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="zh"><body><p id="diagram">协议测试编辑器</p><script>
let payload = '', currentPage = Number(new URL(location.href).searchParams.get('page') || 0);
const send = msg => parent.postMessage(JSON.stringify(msg), '*');
addEventListener('message', e => {
  let m; try { m = JSON.parse(e.data); } catch { return; }
  if (m.action === 'load' || m.action === 'testEdit') {
    payload = m.xml;
    const doc = new DOMParser().parseFromString(payload, 'application/xml');
    const pages = doc.querySelectorAll('diagram');
    currentPage = Math.min(m.currentPage ?? currentPage, Math.max(0, pages.length - 1));
    document.getElementById('diagram').textContent = '第 ' + (currentPage + 1) + ' 页 · ' + (pages[currentPage]?.getAttribute('name') || '单页图表');
    send({event: m.action === 'load' ? 'load' : 'autosave', xml: payload, currentPage, bounds:{width:700,height:500}});
  }
  if (m.action === 'viewbox') send({event:'viewbox', currentPage, message:m});
  if (m.action === 'getDiff') send({event:'getDiff', xml:payload, message:m});
});
send({event:'init'});
</script></body></html>`);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const realEditor = process.env.SESSION_REAL_EDITOR === '1';
const editor = realEditor ? 'https://embed.diagrams.net/' : `http://127.0.0.1:${fake.address().port}/`;
const app = await startServer({ port: Number(process.env.SESSION_E2E_PORT || 8247), env: { DRAWIO_EMBED_URL: editor } });
const sessionId = `diagramai-p0-${Date.now()}`;
const { ab, evalJson, evalRaw, waitFor } = makeBrowser(sessionId);
const hook = 'window.__DIAGRAM_AI_TEST__';
const st = `JSON.stringify({ ready:${hook}?.isReady(), status:document.getElementById('saveStatus').textContent,
  busy:${hook}?.state.busy, payload:${hook}?.state.payload, page:${hook}?.state.pageIndex,
  history:${hook}?.state.history.length, snapshots:${hook}?.state.snapshots.length,
  draft:document.getElementById('chatInput').value, name:${hook}?.sessionState().name })`;
const runAsync = (code, key = 'operationResult') => {
  evalRaw(`window.${key}=null; (async()=>{${code}})().then(r=>window.${key}=r).catch(e=>window.${key}={ok:false,error:e.message});'started'`);
  return waitFor(key, `JSON.stringify(window.${key})`, r => r !== null, { timeout: 20000 });
};
try {
  ab(['open', `${app.base}/?test=1`]);
  await waitFor('编辑器就绪', st, s => s.ready);
  evalRaw('window.confirm=()=>true; "ok"');
  // A real file upload through the input, including one compressed and one blank page.
  const multi = buildMxfile([{ name: '第一页', id: 'one', content: sampleModel(), compressed: true }, { name: '第二页', id: 'two', content: '' }]);
  const upload = path.join(out, '审批.drawio'); fs.writeFileSync(upload, multi);
  ab(['upload', '#diagramFileInput', upload]);
  await waitFor('导入多页文件', st, s => s.name === '审批' && s.status === '已自动保存');
  check('真实文件输入：压缩页和空白页导入为完整多页文档', evalJson(st).payload.includes('id="two"'));
  // Manual edits and current-page metadata come from the iframe protocol.
  const edited = buildMxfile([{ name: '第一页', id: 'one', content: sampleModel() }, { name: '第二页', id: 'two', content: modelWithManualNode() }]);
  if (realEditor) {
    await runAsync(`return await ${hook}.replaceSession({...${hook}.emptySession(${JSON.stringify(edited)},'审批'),pageIndex:1,pageId:'two'},{confirmed:true});`);
  } else {
    evalRaw(`document.getElementById('drawioFrame').contentWindow.postMessage(JSON.stringify({action:'testEdit',xml:${JSON.stringify(edited)},currentPage:1}),${JSON.stringify(new URL(editor).origin)});'edited'`);
  }
  await waitFor('手工编辑保存', st, s => s.page === 1 && s.payload.includes('keep-me') && s.status === '已自动保存');
  ab(['reload']);
  await waitFor('恢复第二页手工编辑', st, s => s.ready && s.page === 1 && s.payload.includes('keep-me'));
  check(realEditor ? '真实 draw.io 多页导入后刷新恢复到第二页' : '纯切页与手工编辑刷新后恢复到第二页', evalJson(st).page === 1);
  ab(['screenshot', path.join(out, 'restored-second-page.png')]);
  // One safe mock request gives us actual chat bubbles, source metadata and undo.
  await runAsync(`return await ${hook}.sendMessage('改为横向布局');`);
  ab(['fill', '#chatInput', '刷新后继续修改']);
  await waitFor('草稿保存', st, s => s.status === '已自动保存');
  const before = evalJson(st);
  check('聊天和撤销快照已经保存', before.history === 2 && before.snapshots === 1);
  ab(['reload']);
  await waitFor('刷新恢复会话', st, s => s.ready && s.history === 2);
  const restored = evalJson(st);
  check('刷新恢复完整多页文档和当前页', restored.payload === before.payload && restored.page === before.page);
  check('刷新恢复草稿和撤销快照', restored.draft === before.draft && restored.snapshots === 1);
  check('历史来源标记恢复', evalRaw('document.getElementById("chatList").textContent').includes('来源：示例引擎'));
  const undo = await runAsync(`return await ${hook}.restoreSnapshot();`);
  check('刷新后撤销仍能找回手工图形', undo.ok && evalJson(st).payload.includes('keep-me'));
  // New document + recovery through visible UI.
  await runAsync(`return await ${hook}.flushSession();`);
  evalRaw('window.confirm=()=>true; "ok"');
  ab(['click', '#newDiagramBtn']);
  await waitFor('新建会话', st, s => s.name === '未命名图表' && s.history === 0 && s.status === '已自动保存');
  check('新建清空聊天和草稿', evalJson(st).draft === '');
  ab(['click', '#recoverSessionBtn']); ab(['click', '#recoverPreviousBtn']);
  await waitFor('恢复上一份备份', st, s => s.name === '审批' && s.history === 2 && s.status === '已自动保存');
  check('新建前的图表、聊天和草稿可恢复', evalJson(st).payload.includes('keep-me') && evalJson(st).draft === before.draft);
  const exported = path.join(out, 'roundtrip', '审批.drawio');
  fs.mkdirSync(path.dirname(exported));
  ab(['download', '#downloadBtn', exported]);
  const exportedText = fs.readFileSync(exported, 'utf8');
  check('真实下载保存全部页面与手工图形', (exportedText.match(/<diagram /g) || []).length === 2 && exportedText.includes('keep-me'));
  ab(['upload', '#diagramFileInput', exported]);
  await waitFor('导出文件重新导入', st, s => s.name === '审批' && s.history === 0 && s.status === '已自动保存');
  check('下载文件可重新导入并继续编辑', evalJson(st).payload.includes('keep-me'));
  const atomic = await runAsync(`
    const repo=await window.DiagramSessions.open(indexedDB);
    const old=await repo.read();const previous=await repo.read('previous');
    const original=IDBObjectStore.prototype.put;
    let failed=false;
    try {
      IDBObjectStore.prototype.put=function(){throw new DOMException('模拟配额不足','QuotaExceededError');};
      await repo.save({...old.data,name:'不得写入'},old.revision,{backup:true});
    } catch(e) { failed=e.name==='QuotaExceededError'; }
    finally { IDBObjectStore.prototype.put=original; }
    const current=await repo.read();const backup=await repo.read('previous');repo.close();
    return {ok:failed && JSON.stringify(current)===JSON.stringify(old) && JSON.stringify(previous)===JSON.stringify(backup)};
  `);
  check('真实 IndexedDB 写入失败保留当前会话和上一份备份',atomic.ok);
  // Actual IndexedDB CAS: two repository instances read the same revision.
  const cas = await runAsync(`
    const repo = await window.DiagramSessions.open(indexedDB);
    const old = await repo.read();
    await repo.save({...old.data,name:'并发写入'},old.revision);
    let conflict=false; try { await repo.save({...old.data,name:'过期写入'},old.revision); } catch(e) { conflict=e.name==='SessionConflictError'; }
    const current=await repo.read(); repo.close();
    return {ok:conflict && current.data.name==='并发写入'};
  `);
  check('真实 IndexedDB 过期写入事务回滚', cas.ok);
  // Do not let the live page overwrite the controlled DB mutation on unload.
  evalRaw(`${hook}.useSessionRepository({save:async()=>{const e=new Error('stale');e.name='SessionConflictError';throw e;}});document.getElementById('chatInput').dispatchEvent(new Event('input'));'ok'`);
  await runAsync(`return await ${hook}.flushSession();`);
  check('保存冲突明确显示失败', evalJson(st).status.includes('保存失败'));
  ab(['screenshot', path.join(out, 'session-ui.png')]);
  // Exercise malformed data recovery: old record must remain byte-for-byte intact.
  const corrupt = await runAsync(`
    const req=indexedDB.open(window.DiagramSessions.DB_NAME,1);
    const db=await new Promise((r,j)=>{req.onsuccess=()=>r(req.result);req.onerror=()=>j(req.error);});
    const tx=db.transaction('sessions','readwrite');
    tx.objectStore('sessions').put({version:1,revision:100,savedAt:1,data:{version:2}},'current');
    await new Promise((r,j)=>{tx.oncomplete=r;tx.onabort=()=>j(tx.error);});db.close();return {ok:true};
  `);
  check('损坏会话准备成功', corrupt.ok);
  // A fresh second tab avoids a beforeunload prompt from the failed save.
  ab(['tab', 'new', `${app.base}/?test=1`]);
  await waitFor('损坏备份被识别', st, s => s.ready && s.status.includes('恢复失败'));
  const unchanged = await runAsync(`
    const repo=await window.DiagramSessions.open(indexedDB);
    const revision=await repo.revision();repo.close();return {ok:revision===100};
  `);
  check('损坏会话不会被初始化空图覆盖', unchanged.ok);
  evalRaw('window.confirm=()=>true; "ok"');
  const recovered = await runAsync(`return await ${hook}.recoverSession('previous',{confirmed:true});`);
  check('损坏当前记录仍可从上一份备份恢复', recovered.ok);
  ab(['set', 'viewport', '390', '844']);
  ab(['screenshot', path.join(out, 'session-mobile.png')]);
  console.log(`证据目录：${out}`);
} catch (e) {
  check('完整 P0 浏览器流程', false, e.stack);
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  ab(['close'], { allowFail: true });
  app.stop(); fake.closeAllConnections?.(); await new Promise(r => fake.close(r));
}
process.exit(failures() ? 1 : 0);
