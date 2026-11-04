import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const require = createRequire(import.meta.url), { sampleModel, modelWithManualNode } = require('../helpers/fixtures.js');
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const origin = 'http://127.0.0.1:' + port;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-drawing-recovery-'));
const out = path.join(ROOT, process.env.DRAWING_ACCEPTANCE_DIR || 'acceptance/drawing-recovery/browser'); fs.mkdirSync(out, { recursive: true });
const app = spawn(process.execPath, ['tests/helpers/drawing-recovery-browser-fixture.cjs'], { cwd: ROOT, env: { ...process.env, APP_MODE: 'cloud', PUBLIC_ORIGIN: origin, CLOUD_ALLOW_HTTP_LOOPBACK: 'true', CLOUD_DATA_DIR: directory, CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'fixture-password-123', CLOUD_CHATGPT_OWNER: '', CLOUD_FREE_MODELS: '[]', CLOUD_TOTAL_CONCURRENCY: '6', CLOUD_USER_CONCURRENCY: '1', PORT: String(port), DEEPSEEK_API_KEY: '', DRAWIO_EMBED_URL: origin + '/fixture-editor' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; app.stderr.on('data', chunk => serverLog += chunk);
await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('绘图 fixture 启动超时 ' + serverLog)), 15000); app.stdout.on('data', chunk => { if (chunk.toString().includes('DRAWING_RECOVERY_FIXTURE_READY')) { clearTimeout(timer); resolve(); } }); app.once('exit', () => { clearTimeout(timer); reject(Error('绘图 fixture 退出 ' + serverLog)); }); });
const browser = makeBrowser('drawing-recovery-' + Date.now()), { ab, evalRaw, evalJson, waitFor } = browser, { check, results, failures } = makeChecker();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(label, predicate) { const end = Date.now() + 20000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await pause(40); } throw Error('超时：' + label); }
const stats = async () => (await fetch(origin + '/fixture-drawing/stats')).json();
const control = (action, marker) => fetch(origin + '/fixture-drawing/control/' + action + (marker ? '?marker=' + marker : ''));
async function api(client, route, body) { return fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
async function login(username) { const response = await api(null, '/api/auth/login', { username, password: 'fixture-password-123' }); if (response.status !== 200) throw Error('登录失败 ' + username); return { cookie: response.headers.get('set-cookie').split(';')[0], ...(await response.json()) }; }
const request = marker => ({ taskId: crypto.randomUUID(), threadId: crypto.randomUUID(), assistantId: crypto.randomUUID(), mode: 'chat', message: marker, currentFile: sampleModel(), currentPage: 0, clientRevision: 0, providerId: 'platform:drawing', modelId: 'drawing-open-model', stream: true });
const conversationRequest = marker => { const { mode, currentFile, currentPage, clientRevision, ...body } = request(marker); return body; };
const task = async (client, id, kind = 'drawing') => (await (await api(client, '/api/' + kind + '/tasks/' + id)).json()).task;
const terminal = (client, id, kind = 'drawing') => wait('任务完成 ' + id, async () => { const value = await task(client, id, kind); return value?.status !== 'running' && value; });
const click = selector => { evalRaw(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});true`); ab(['click', selector]); };
async function run(code) { evalRaw(`window.drawingTestOperation=null;(async()=>{${code}})().then(value=>window.drawingTestOperation={value}).catch(error=>window.drawingTestOperation={error:error.message});true`); const result = await waitFor('浏览器异步操作', 'JSON.stringify(window.drawingTestOperation)', value => value !== null); if (result.error) throw Error(result.error); return result.value; }
const ready = () => waitFor('绘图编辑器就绪', 'Boolean(window.__DIAGRAM_AI_TEST__?.state.ready&&!window.__DIAGRAM_AI_TEST__.state.pendingLoad&&!window.__DIAGRAM_AI_TEST__.state.sessionBusy)', Boolean);
const idle = () => waitFor('绘图任务完成', '!window.__DIAGRAM_AI_TEST__.state.busy', Boolean);
async function browserTask(marker) { const value = await wait('任务创建并调用一次上游 ' + marker, async () => { const s = await stats(); return s.streams.some(row => row.marker === marker) && s.creations.at(-1); }); return value.taskId; }
async function send(marker) { await idle(); ab(['fill', '#chatInput', marker]); click('#sendBtn'); return browserTask(marker); }
async function savedTask(id) { return run(`const db=await window.DiagramSessions.open(indexedDB,'diagramai.sessions.'+window.DiagramCloud.user.id);try{const record=await db.read();return JSON.stringify(record?.data||{}).includes(${JSON.stringify(id)});}finally{db.close();}`); }
async function released(id) { return wait('结果保存后 ACK 清理临时数据', async () => run(`const response=await fetch('/api/drawing/tasks/${id}');return response.status===410;`)); }
try {
  const clients = []; for (const name of ['alice', 'bob', 'carol', 'david', 'erica', 'frank', 'grace']) clients.push(await login(name));
  const jobs = await Promise.all(clients.slice(0, 6).map(async (client, i) => {
    const kind = i < 3 ? 'drawing' : 'conversation', body = kind === 'drawing' ? request('DR-parallel-' + i) : conversationRequest('DR-parallel-' + i);
    const response = await api(client, '/api/' + kind + '/tasks', body);
    return { client, body, kind, status: response.status, data: await response.json() };
  }));
  check('三个绘图和三个聊天任务共享六个并发名额', jobs.every(row => row.status === 202), JSON.stringify(jobs.map(row => ({ kind: row.kind, status: row.status, error: row.data.error }))));
  if (!jobs.every(row => row.status === 202)) throw Error('基础混合并发创建失败');
  await wait('六个独立上游连接', async () => (await stats()).streams.length === 6);
  check('第七个账号被拒绝且不会增加模型调用', (await api(clients[6], '/api/drawing/tasks', request('DR-seventh'))).status === 429 && (await stats()).calls === 6);
  check('同账号跨绘图和聊天也只能一个任务', (await api(clients[0], '/api/conversation/tasks', conversationRequest('DR-same-account'))).status === 429 && (await api(clients[3], '/api/drawing/tasks', request('DR-same-drawing'))).status === 429);
  const first = jobs[0], route = '/api/drawing/tasks/' + first.body.taskId;
  check('其他用户无法读取、订阅、取消或确认任务', (await Promise.all(['', '/events', '/cancel', '/ack'].map(suffix => api(clients[6], route + suffix, ['/cancel', '/ack'].includes(suffix) ? {} : undefined)))).every(response => response.status === 404));
  const response = await api(first.client, route + '/events'), reader = response.body.getReader(); await reader.read(); await reader.cancel();
  check('浏览器连接断开不占第二份名额也不中止后台任务', (await stats()).globalActive === 6 && (await api(first.client, '/api/drawing/tasks', first.body)).status === 200 && (await stats()).calls === 6);
  await api(first.client, route + '/cancel', {}); const cancelled = await terminal(first.client, first.body.taskId);
  check('明确取消绘图后释放名额让新用户进入', cancelled.status === 'cancelled' && (await api(clients[6], '/api/drawing/tasks', request('DR-replacement'))).status === 202);
  await wait('替补任务开始', async () => (await stats()).calls === 7);
  await control('finish');
  const finished = await Promise.all(jobs.slice(1).map(job => terminal(job.client, job.body.taskId, job.kind)));
  check('多人结果独立且每个任务只结算一次', finished.every((value, i) => value.status === 'succeeded' && (value.xml || value.reply).includes('DR-parallel-' + (i + 1)) && value.turnUsage?.calls === 1));
  await wait('全部并发名额释放', async () => (await stats()).globalActive === 0);
  for (const job of jobs) await api(job.client, '/api/' + job.kind + '/tasks/' + job.body.taskId + '/ack', {});
  const beforeBrowser = (await stats()).calls;
  ab(['set', 'viewport', '1280', '920']); ab(['open', origin + '/login.html?next=%2F%3Ftest%3D1']); ab(['fill', '#loginUsername', 'alice']); ab(['fill', '#loginPassword', 'fixture-password-123']); click('#loginBtn');
  await waitFor('登录完成并跳转', 'location.pathname', value => value !== '/login.html');
  // Auth redirect implementations may choose chat; explicitly open the drawing route.
  ab(['open', origin + '/?test=1']); await ready();
  await waitFor('模型目录可用', 'Boolean(window.__DIAGRAM_AI_TEST__.modelCatalog())', Boolean);
  evalRaw(`window.__DIAGRAM_AI_TEST__.setModelSelection({providerId:'platform:drawing',modelId:'drawing-open-model'});true`);
  const firstId = await send('DR-first-refresh');
  check('首字前已持久保存任务标识', await savedTask(firstId));
  await control('fail-models');
  ab(['reload']); await ready(); await waitFor('首字前刷新后重新订阅', 'window.__DIAGRAM_AI_TEST__.state.busy', Boolean);
  check('模型目录故障仍恢复任务，禁止新请求静默换成示例模型', evalJson('window.__DIAGRAM_AI_TEST__.state.modelCatalog===null&&window.__DIAGRAM_AI_TEST__.state.busy'));
  check('首字前刷新仍是同一个任务且没有再次调用模型', (await stats()).calls === beforeBrowser + 1 && (await stats()).creations.filter(row => row.taskId === firstId).length === 1);
  await control('finish', 'DR-first-refresh'); await idle();
  check('首字前刷新后取回完整 XML 并自动应用', evalJson(`window.__DIAGRAM_AI_TEST__.state.modelXml.includes('DR-first-refresh')`)); await released(firstId);
  await control('restore-models'); ab(['reload']); await ready();
  await waitFor('模型目录恢复','Boolean(window.__DIAGRAM_AI_TEST__.modelCatalog())',Boolean);
  const partialId = await send('DR-partial-refresh'); await control('chunk', 'DR-partial-refresh');
  await waitFor('生成进度可见（不显示尚未校验的XML）', 'document.getElementById("chatList").textContent', text => text.includes('正在生成'));
  ab(['reload']); await ready(); await waitFor('部分输出后恢复', 'window.__DIAGRAM_AI_TEST__.state.busy', Boolean);
  await control('finish', 'DR-partial-refresh'); await idle();
  check('部分生成后刷新保留任务与完整结果', evalJson(`window.__DIAGRAM_AI_TEST__.state.modelXml.includes('DR-partial-refresh')`) && (await stats()).calls === beforeBrowser + 2); await released(partialId);
  const offlineId = await send('DR-offline-finish'); ab(['open', 'about:blank']); await control('finish', 'DR-offline-finish');
  await wait('离线完成释放并发', async () => (await stats()).globalActive === 0);
  ab(['open', origin + '/?test=1']); await ready(); await idle();
  await waitFor('离线结果恢复应用', 'window.__DIAGRAM_AI_TEST__.state.modelXml', text => text.includes('DR-offline-finish'));
  check('离开页面后服务器独立完成，返回取回同一结果', (await stats()).calls === beforeBrowser + 3); await released(offlineId);
  const conflictId = await send('DR-canvas-conflict');
  await run(`document.getElementById('drawioFrame').contentWindow.fixtureSetXml(${JSON.stringify(modelWithManualNode())});await new Promise(resolve=>setTimeout(resolve,100));return await window.__DIAGRAM_AI_TEST__.flushSession();`);
  ab(['reload']); await ready(); await control('finish', 'DR-canvas-conflict'); await idle();
  check('刷新期间手工改画布后结果暂存不覆盖原图', evalJson(`window.__DIAGRAM_AI_TEST__.state.modelXml.includes('keep-me')&&window.__DIAGRAM_AI_TEST__.pendingResult()?.xml.includes('DR-canvas-conflict')&&!document.getElementById('conflictBanner').classList.contains('hidden')`)); await released(conflictId);
  await run(`window.__DIAGRAM_AI_TEST__.discardPending();return await window.__DIAGRAM_AI_TEST__.flushSession();`);
  const cancelId = await send('DR-explicit-cancel'); click('#cancelBtn'); await idle();
  check('只有明确点击取消才终止生成且不改画布', evalJson(`window.__DIAGRAM_AI_TEST__.state.modelXml.includes('keep-me')&&document.getElementById('chatList').textContent.includes('已取消')`) && (await stats()).globalActive === 0); await released(cancelId);
  const unsavedId = await send('DR-save-failure');
  evalRaw(`window.normalTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(store,mode,...rest){if(mode==='readwrite')throw Error('fixture storage unavailable');return window.normalTransaction.call(this,store,mode,...rest);};true`);
  await control('finish', 'DR-save-failure'); await idle();
  check('结果未持久保存时不 ACK，服务器保留完整 XML', await run(`const response=await fetch('/api/drawing/tasks/${unsavedId}');const data=await response.json();return response.status===200&&data.task.xml?.includes('DR-save-failure');`));
  ab(['reload']); await ready(); await idle(); await waitFor('保存失败后刷新重新取回结果', 'window.__DIAGRAM_AI_TEST__.state.modelXml', text => text.includes('DR-save-failure'));
  check('本地保存恢复后取回同一任务，不再次扣费', (await stats()).calls === beforeBrowser + 6); await released(unsavedId);
  const final = await stats();
  check('所有任务无遗留并发及未结算消费', final.globalActive === 0 && final.streams.length === 0 && final.events.length === final.calls && final.events.every(event => event.status !== 'started'));
  ab(['screenshot', path.join(out, 'drawing-recovered-desktop.png')]);
  ab(['set', 'viewport', '390', '844']); check('手机恢复界面不撑宽', evalJson('document.documentElement.scrollWidth<=innerWidth')); ab(['screenshot', path.join(out, 'drawing-recovered-mobile.png')]);
} catch (error) {
  check('绘图后台恢复与多人并行流程', false, error.stack);
  try { ab(['screenshot', path.join(out, 'failure.png')]); fs.writeFileSync(path.join(out, 'failure.txt'), ab(['snapshot']).out); } catch {}
} finally {
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ runtimeRoot: process.env.DRAWING_APP_ROOT || ROOT, localGateway: true, externalModelCalls: 0, results }, null, 2));
  fs.writeFileSync(path.join(out, 'server.log'), serverLog);
  ab(['close'], { allowFail: true }); app.kill('SIGTERM'); await new Promise(resolve => { if (app.exitCode !== null) return resolve(); app.once('exit', resolve); }); fs.rmSync(directory, { recursive: true, force: true });
}
console.log(`${results.length - failures()}/${results.length} passed; ${out}`); if (failures()) process.exitCode = 1;
