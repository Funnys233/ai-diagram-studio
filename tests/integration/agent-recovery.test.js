'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-recovery-api-'));
Object.assign(process.env, {
  APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://diagram.example', CLOUD_DATA_DIR: directory,
  CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin',
  CLOUD_ADMIN_PASSWORD: 'fixture-password-123', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: '', DEEPSEEK_API_KEY: '',
});
const { createServer, cloudRuntime: cloud } = require('../../server');
const { DshClient } = require('../../lib/dsh-client');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'bridge.token');
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
const receipts = path.join(directory, 'sdk-receipts'); fs.mkdirSync(receipts);
let app, base, bridge, proxy, bridgePort, client, directClient, admin, second, ordinary, mode = 'complete', dropNextSubmission = false;
const adapter = {
  calls: 0, recoveries: 0, lastSession: null,
  supportsContinuation: true,
  canResume({ sessionId }) { return this.lastSession === sessionId || fs.existsSync(path.join(receipts, sessionId + '.json')); },
  async run({ sessionId, onProgress }) {
    this.calls++; this.lastSession = sessionId;
    if (mode === 'complete') return { status: 'completed', output: 'new task completed' };
    onProgress('网站和执行端都已保存的部分正文');
    fs.writeFileSync(path.join(receipts, sessionId + '.json'), JSON.stringify(mode === 'failed'
      ? { status: 'failed', output: '', stopped: true }
      : { status: 'unknown', output: '', stopped: false }), { mode: 0o600 });
    throw Error('simulated SDK transport loss after durable receipt');
  },
  async cancel() { return { stopped: true }; },
  async recover({ sessionId }) {
    this.recoveries++;
    return JSON.parse(fs.readFileSync(path.join(receipts, sessionId + '.json'), 'utf8'));
  },
};
function api(user, route, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(base + route, { method, agent: false, headers: {
      Host: 'diagram.example', Origin: 'https://diagram.example', 'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf } : {}), ...extra,
    } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(payload);
  });
}
const job = () => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'integration recovery test, no real model' });
const get = async id => (await api(admin, '/api/agent/tasks/' + id)).body.task;
async function until(predicate) {
  for (let attempt = 0; attempt < 320; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error('recovery integration timed out');
}
async function login(username) {
  const result = await api(null, '/api/auth/login', { username, password: 'fixture-password-123' });
  assert.equal(result.status, 200);
  return { cookie: result.headers['set-cookie'][0].split(';')[0], ...result.body };
}
async function startApp() {
  app = createServer({ agentClient: client, agentEnabled: true });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + app.address().port;
}
async function stopApp() {
  await app.agentTasks.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
}
test.before(async () => {
  bridge = createBridge({ stateDir: path.join(directory, 'bridge'), token, adapter, timeoutMs: 1000 });
  bridgePort = (await bridge.listen()).port;
  // A loopback transport fault fixture can lose a submit before delivery. Every
  // other request uses the real authenticated DshClient and bridge protocol.
  proxy = http.createServer((req, res) => {
    if (dropNextSubmission && req.method === 'POST' && req.url === '/v1/jobs') {
      dropNextSubmission = false; req.resume();
      res.writeHead(202, { 'Content-Type': 'application/json' }); res.end('lost submit response'); return;
    }
    const forwarded = http.request({ host: '127.0.0.1', port: bridgePort, method: req.method, path: req.url, headers: req.headers, agent: false }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
    forwarded.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('{}'); }); req.pipe(forwarded);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  client = new DshClient({ url: 'http://127.0.0.1:' + proxy.address().port, tokenFile });
  directClient = new DshClient({ url: 'http://127.0.0.1:' + bridgePort, tokenFile });
  await startApp(); admin = await login('admin');
  const actor = { identity: { user: cloud.data.users[0] } };
  await cloud.createUser(actor, { username: 'second', password: 'fixture-password-123' });
  await cloud.createUser(actor, { username: 'ordinary', password: 'fixture-password-123' });
  cloud.change(data => { data.users.find(user => user.username === 'second').role = 'admin'; });
  second = await login('second'); ordinary = await login('ordinary');
});
test.after(async () => {
  await stopApp(); proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve));
  await bridge.close(); fs.rmSync(directory, { recursive: true, force: true });
});

test('automatic receipt recovery preserves partial output and releases the website lease without another run', async () => {
  mode = 'failed'; const body = job(), before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202);
  await until(async () => (await get(body.id)).status === 'failed');
  const result = await get(body.id);
  assert.equal(result.output, '网站和执行端都已保存的部分正文');
  assert.equal(result.recoveryReason, 'execution-recovered'); assert.equal(adapter.calls, before + 1);
  assert.equal(cloud.active.get(admin.user.id), 0);
  mode = 'complete'; const next = job(); assert.equal((await api(admin, '/api/agent/tasks', next)).status, 202);
  await until(async () => (await get(next.id)).status === 'completed'); assert.equal(adapter.calls, before + 2);
});

test('manual recovery is protected, restores a completed receipt and allows new work without replay', async () => {
  mode = 'unknown'; const body = job(), before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202);
  await until(async () => (await get(body.id)).status === 'unknown');
  assert.equal(cloud.active.get(admin.user.id), 1);
  const route = '/api/agent/tasks/' + body.id + '/recover', inspections = adapter.recoveries;
  assert.equal((await api(null, route, {})).status, 401);
  assert.equal((await api(ordinary, route, {})).status, 403);
  assert.equal((await api(second, route, {})).status, 404);
  assert.equal((await api(admin, route, {}, 'POST', { 'X-CSRF-Token': 'invalid' })).status, 403);
  assert.equal((await api(admin, route, { force: true })).status, 400);
  assert.equal(adapter.recoveries, inspections); assert.equal(adapter.calls, before + 1);
  fs.writeFileSync(path.join(receipts, adapter.lastSession + '.json'), JSON.stringify({ status: 'completed', output: '恢复得到的完整结果', stopped: true }));
  const recovered = await api(admin, route, {});
  assert.equal(recovered.status, 200); assert.equal(recovered.body.task.status, 'completed');
  assert.equal(recovered.body.task.output, '恢复得到的完整结果'); assert.equal(recovered.body.task.recoveryReason, 'execution-recovered');
  assert.equal(cloud.active.get(admin.user.id), 0); assert.equal(adapter.calls, before + 1);
  assert.equal((await api(admin, route, {})).body.task.status, 'completed'); assert.equal(adapter.calls, before + 1);
  await stopApp(); await startApp();
  assert.equal((await get(body.id)).output, '恢复得到的完整结果'); assert.equal(adapter.calls, before + 1);
  const persisted = fs.readFileSync(path.join(directory, 'agent-tasks', body.id + '.enc'), 'utf8');
  assert.ok(!persisted.includes('恢复得到的完整结果'));
  mode = 'complete'; const next = job(); assert.equal((await api(admin, '/api/agent/tasks', next)).status, 202);
  await until(async () => (await get(next.id)).status === 'completed'); assert.equal(adapter.calls, before + 2);
});

test('a lost submit is fenced through real 404 recovery and a delayed original submission cannot run', async () => {
  mode = 'complete'; dropNextSubmission = true;
  const body = job(), before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202);
  await until(async () => (await get(body.id)).status === 'failed');
  const result = await get(body.id);
  assert.equal(result.recoveryReason, 'not-accepted'); assert.equal(adapter.calls, before);
  assert.equal(cloud.active.get(admin.user.id), 0);
  const stored = JSON.parse(fs.readFileSync(path.join(directory, 'bridge/state.json'), 'utf8')).jobs.find(value => value.id === body.id);
  assert.equal(stored.sessionId, null); assert.equal(stored.status, 'failed');
  const delayed = await directClient.submit(admin.user.id, body);
  assert.equal(delayed.status, 'failed'); assert.equal(delayed.recoveryReason, 'not-accepted'); assert.equal(adapter.calls, before);
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 200); assert.equal(adapter.calls, before);
  const next = job(); assert.equal((await api(admin, '/api/agent/tasks', next)).status, 202);
  await until(async () => (await get(next.id)).status === 'completed'); assert.equal(adapter.calls, before + 1);
});

test('a follow-up lost before delivery recovers after restart without mistaking the parent result or holding a lease', async () => {
  mode = 'complete'; const first = job(), before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', first)).status, 202);
  await until(async () => (await get(first.id)).status === 'completed');
  const next = { id: crypto.randomUUID(), conversationId: first.conversationId, parentTaskId: first.id, prompt: 'This follow-up will not reach the executor' };
  dropNextSubmission = true;
  assert.equal((await api(admin, '/api/agent/tasks', next)).status, 202);
  await until(async () => (await get(next.id)).status === 'unknown');
  await stopApp(); await startApp();
  assert.equal(cloud.active.get(admin.user.id), 1);
  const result = await api(admin, '/api/agent/tasks/' + next.id + '/recover', {});
  assert.equal(result.status, 200); assert.equal(result.body.task.status, 'failed'); assert.equal(result.body.task.recoveryReason, 'not-accepted');
  assert.equal(result.body.task.output, ''); assert.equal(cloud.active.get(admin.user.id), 0); assert.equal(adapter.calls, before + 1);
  const delayed = await directClient.submit(admin.user.id, next);
  assert.equal(delayed.recoveryReason, 'not-accepted'); assert.equal(adapter.calls, before + 1);
});
