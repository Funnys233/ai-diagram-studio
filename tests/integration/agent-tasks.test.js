'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-api-'));
Object.assign(process.env, { APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://diagram.example', CLOUD_DATA_DIR: directory, CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'fixture-password-123', DEEPSEEK_API_KEY: '' });
const { createServer, cloudRuntime: cloud } = require('../../server');
const { DshClient } = require('../../lib/dsh-client');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const { createDemoAdapter } = require('../../services/dsh-bridge/demo-adapter');
const token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'bridge.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
let app, base, bridge, client, admin, second, ordinary, adapter;
function api(user, route, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(base + route, { method, headers: { Host: 'diagram.example', Origin: 'https://diagram.example', 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf } : {}), ...extra } }, res => resolve(new Response(require('node:stream').Readable.toWeb(res), { status: res.statusCode, headers: res.headers })));
    req.on('error', reject); req.end(payload);
  });
}
async function login(username) { const response = await api(null, '/api/auth/login', { username, password: 'fixture-password-123' }); assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], ...await response.json() }; }
const job = () => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'private test task' });
async function wait(predicate) { for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw Error('agent fixture timeout'); }
const get = async (user, id) => (await (await api(user, '/api/agent/tasks/' + id)).json()).task;
async function startApp() { app = createServer({ agentClient: client, agentEnabled: true }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + app.address().port; }
async function stopApp() { await app.agentTasks.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
test.before(async () => {
  adapter = createDemoAdapter({ delayMs: 180 }); bridge = createBridge({ stateDir: path.join(directory, 'bridge'), token, adapter }); const address = await bridge.listen();
  client = new DshClient({ url: 'http://127.0.0.1:' + address.port, tokenFile }); await startApp(); admin = await login('admin');
  await cloud.createUser({ identity: { user: cloud.data.users[0] } }, { username: 'second', password: 'fixture-password-123' });
  await cloud.createUser({ identity: { user: cloud.data.users[0] } }, { username: 'ordinary', password: 'fixture-password-123' });
  cloud.change(data => { data.users.find(user => user.username === 'second').role = 'admin'; });
  second = await login('second'); ordinary = await login('ordinary');
});
test.after(async () => { await stopApp(); await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
test('admin-only page and API, CSRF and unknown fields cannot bypass admission', async () => {
  assert.equal((await api(null, '/agent.html')).status, 302); assert.equal((await api(ordinary, '/agent.html')).status, 403);
  for (const route of ['/api/agent/status', '/api/agent/tasks']) { assert.equal((await api(null, route)).status, 401); assert.equal((await api(ordinary, route)).status, 403); }
  assert.equal((await api(admin, '/agent.html')).status, 200);
  assert.equal((await api(admin, '/api/agent/tasks', job(), 'POST', { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await api(admin, '/api/agent/tasks', { ...job(), ownerId: second.user.id })).status, 400);
  assert.equal(adapter.calls, 0);
  const status = await (await api(admin, '/api/agent/status')).json(); assert.equal(status.available, true); assert.ok(!JSON.stringify(status).includes(token));
});
test('two owners run in parallel; refresh, duplicates and lookup never resubmit or cross owners', async () => {
  const first = job(), other = job(); const before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', first)).status, 202); assert.equal((await api(second, '/api/agent/tasks', other)).status, 202);
  assert.equal((await api(admin, '/api/agent/tasks', first)).status, 200); assert.equal((await api(admin, '/api/agent/tasks', { ...first, prompt: 'changed' })).status, 409);
  assert.equal((await api(admin, '/api/agent/tasks', job())).status, 429);
  for (const [method, suffix, body] of [['GET', '', undefined], ['POST', '/cancel', {}], ['DELETE', '', {}]]) assert.equal((await api(second, '/api/agent/tasks/' + first.id + suffix, body, method)).status, 404);
  assert.equal(cloud.active.get(admin.user.id), 1); assert.equal(cloud.active.get(second.user.id), 1);
  await wait(async () => (await get(admin, first.id)).status === 'completed'); await wait(async () => (await get(second, other.id)).status === 'completed');
  const result = await get(admin, first.id); assert.match(result.output, /本地演示结果/); assert.equal(adapter.calls, before + 2); assert.equal(cloud.active.get(admin.user.id), 0);
  const listed = (await (await api(admin, '/api/agent/tasks')).json()).tasks;
  assert.equal(listed.length, 1); assert.equal(listed[0].output, undefined); assert.equal(listed[0].summary, true);
  const encrypted = fs.readFileSync(path.join(directory, 'agent-tasks', first.id + '.enc'), 'utf8'); assert.ok(!encrypted.includes('private test task')); assert.ok(!encrypted.includes('本地演示'));
  assert.equal((await api(admin, '/api/agent/tasks/' + first.id, {}, 'DELETE')).status, 200);
  assert.equal((await api(admin, '/api/agent/tasks/' + first.id)).status, 410); assert.equal((await api(admin, '/api/agent/tasks', first)).status, 410);
  const remoteDisk = JSON.parse(fs.readFileSync(path.join(directory, 'bridge/state.json'), 'utf8')); assert.equal(remoteDisk.jobs.find(record => record.id === first.id).output, '');
});
test('site restart preserves remote execution and recovers result without another call', async () => {
  const body = job(), before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202); await wait(() => adapter.calls === before + 1);
  await stopApp(); await startApp(); assert.equal(cloud.active.get(admin.user.id), 1);
  const initial = await get(admin, body.id); assert.equal(initial.status, 'unknown');
  await wait(async () => (await get(admin, body.id)).status === 'completed'); assert.equal(adapter.calls, before + 1); assert.equal(cloud.active.get(admin.user.id), 0);
});
test('explicit stop keeps partial output and releases concurrency after confirmation', async () => {
  const body = job(); assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202);
  await wait(() => app.agentTasks.jobs.get(body.id).status === 'running');
  const response = await api(admin, '/api/agent/tasks/' + body.id + '/cancel', {}); assert.equal(response.status, 200);
  await wait(async () => (await get(admin, body.id)).status === 'cancelled'); assert.equal(cloud.active.get(admin.user.id), 0);
});
test('follow-ups retain context across page and website restart, remain owner-bound, and clear as a conversation', async () => {
  const first = { ...job(), prompt: '为我的黑白简约网页列个计划' }, before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', first)).status, 202);
  await wait(async () => { await app.agentTasks.reconcile(app.agentTasks.jobs.get(first.id)); return (await get(admin, first.id)).status === 'completed'; });
  const conversationRoute = '/api/agent/conversations/' + first.conversationId;
  const initial = await (await api(admin, conversationRoute)).json(); assert.equal(initial.canContinue, true); assert.equal(initial.tasks.length, 1);
  assert.equal((await api(second, conversationRoute)).status, 404); assert.equal((await api(ordinary, conversationRoute)).status, 403);
  assert.equal((await api(admin, conversationRoute, {}, 'DELETE', { 'X-CSRF-Token': 'wrong' })).status, 403);
  await stopApp(); await startApp();
  const next = { id: crypto.randomUUID(), conversationId: first.conversationId, parentTaskId: first.id, prompt: '把第二步再拆细一些' };
  assert.equal((await api(admin, '/api/agent/tasks', next)).status, 202);
  assert.equal((await api(admin, '/api/agent/tasks', next)).status, 200);
  await wait(async () => { await app.agentTasks.reconcile(app.agentTasks.jobs.get(next.id)); return (await get(admin, next.id)).status === 'completed'; });
  const conversation = await (await api(admin, conversationRoute)).json();
  assert.deepEqual(conversation.tasks.map(turn => turn.id), [first.id, next.id]); assert.match(conversation.tasks[1].output, /黑白简约网页/); assert.match(conversation.tasks[1].output, /第二步再拆细/);
  assert.equal(adapter.calls, before + 2); assert.equal(cloud.active.get(admin.user.id), 0);
  assert.equal((await api(admin, '/api/agent/tasks/' + first.id, {}, 'DELETE')).status, 409);
  assert.equal((await api(admin, '/api/agent/tasks', { ...next, id: crypto.randomUUID() })).status, 409);
  assert.equal((await api(admin, conversationRoute, {}, 'DELETE')).status, 200);
  assert.equal((await api(admin, conversationRoute)).status, 404); assert.equal((await api(admin, '/api/agent/tasks/' + next.id)).status, 410);
});
