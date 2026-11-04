'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-files-api-'));
Object.assign(process.env, { APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://diagram.example', CLOUD_DATA_DIR: directory, CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'fixture-password-123', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: '', DEEPSEEK_API_KEY: '' });
const { createServer, cloudRuntime: cloud } = require('../../server');
const { DshClient } = require('../../lib/dsh-client');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const { createDemoAdapter } = require('../../services/dsh-bridge/demo-adapter');
const token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'bridge.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
let app, base, bridge, client, admin, second, ordinary, adapter, dropNext = false;
function api(user, route, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(base + route, { method, headers: { Host: 'diagram.example', Origin: 'https://diagram.example', 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}), ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf } : {}), ...extra } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, json() { return JSON.parse(bytes); } });
      });
    });
    req.on('error', reject); req.end(payload);
  });
}
const task = patch => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: '阅读资料并生成文件', ...patch });
const upload = async (name, text, owner = admin) => {
  const result = await api(owner, '/api/agent/files', { name, data: Buffer.from(text).toString('base64') });
  assert.equal(result.status, 201, result.bytes.toString()); return result.json().file;
};
async function complete(id) {
  for (let i = 0; i < 200; i++) {
    await app.agentTasks.reconcile(app.agentTasks.jobs.get(id));
    const value = (await api(admin, '/api/agent/tasks/' + id)).json().task;
    if (['completed', 'failed', 'rejected'].includes(value.status)) { assert.equal(value.status, 'completed', value.message); return value; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error('file task timeout');
}
async function login(username) { const response = await api(null, '/api/auth/login', { username, password: 'fixture-password-123' }); assert.equal(response.status, 200); return { cookie: response.headers['set-cookie'][0].split(';')[0], ...response.json() }; }
async function start() { app = createServer({ agentClient: client, agentEnabled: true }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + app.address().port; }
async function stop() { await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); }
test.before(async () => {
  adapter = createDemoAdapter({ delayMs: 5 }); bridge = createBridge({ stateDir: path.join(directory, 'bridge'), token, adapter }); const address = await bridge.listen();
  client = new DshClient({ url: 'http://127.0.0.1:' + address.port, tokenFile });
  const submit = client.submit.bind(client);
  client.submit = async (...args) => { if (dropNext) { dropNext = false; throw Error('fixture lost before delivery'); } return submit(...args); };
  await start(); admin = await login('admin');
  const actor = { identity: { user: cloud.data.users[0] } };
  await cloud.createUser(actor, { username: 'second', password: 'fixture-password-123' }); await cloud.createUser(actor, { username: 'ordinary', password: 'fixture-password-123' });
  cloud.change(data => { data.users.find(user => user.username === 'second').role = 'admin'; });
  second = await login('second'); ordinary = await login('ordinary');
});
test.after(async () => { await stop(); await bridge.close(); fs.rmSync(directory, { recursive: true, force: true }); });
test('file upload, lookup, original download and deletion enforce authentication, owner and CSRF', async () => {
  const body = { name: '预算.txt', data: Buffer.from('仅属于admin的资料73021').toString('base64') };
  assert.equal((await api(null, '/api/agent/files', body)).status, 401);
  assert.equal((await api(ordinary, '/api/agent/files', body)).status, 403);
  assert.equal((await api(admin, '/api/agent/files', body, 'POST', { 'X-CSRF-Token': 'wrong' })).status, 403);
  const file = await upload(body.name, '仅属于admin的资料73021');
  const route = '/api/agent/files/' + file.id;
  assert.equal((await api(second, route)).status, 404); assert.equal((await api(second, route + '/download')).status, 404);
  assert.equal((await api(second, route, {}, 'DELETE')).status, 404);
  const data = await api(admin, route + '/download'); assert.equal(data.bytes.toString(), '仅属于admin的资料73021');
  assert.match(data.headers['content-disposition'], /^attachment/); assert.equal(data.headers['x-content-type-options'], 'nosniff');
  const meta = (await api(admin, route)).json().file; assert.equal(meta.text, undefined); assert.equal(meta.data, undefined);
  assert.equal((await api(admin, route, {}, 'DELETE')).status, 200); assert.equal((await api(admin, route)).status, 404);
  for (const invalid of [{ name: 'bad.exe', data: 'dGV4dA==' }, { name: 'bad.txt', data: '!!!!' }, { name: '../bad.txt', data: 'dGV4dA==' }]) {
    const rejected = await api(admin, '/api/agent/files', invalid); assert.equal(rejected.status, 400); assert.notEqual(rejected.json().error.code, 'internal-error');
  }
});
test('documents produce real downloadable files, retain encrypted copies through restart and continue in the same conversation', async () => {
  const secret = '资料内容：项目 松林，预算73021。', file = await upload('项目资料.md', secret);
  const body = task({ attachmentIds: [file.id] }), before = adapter.calls;
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202);
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 200);
  const first = await complete(body.id); assert.match(first.output, /73021/); assert.equal(first.attachments[0].id, file.id);
  assert.equal(first.artifacts.length, 1); assert.equal(first.artifacts[0].text, undefined);
  const originalRoute = '/api/agent/files/' + file.id + '/download', outputRoute = '/api/agent/tasks/' + body.id + '/artifacts/' + first.artifacts[0].id + '/download';
  assert.equal((await api(admin, originalRoute)).bytes.toString(), secret);
  const csv = await api(admin, outputRoute); assert.equal(csv.status, 200); assert.match(csv.bytes.toString(), /项目资料.md/);
  assert.equal(csv.headers['content-type'], 'application/octet-stream'); assert.match(csv.headers['content-security-policy'], /sandbox/);
  assert.equal((await api(second, outputRoute)).status, 404);
  assert.equal((await api(admin, '/api/agent/files/' + file.id, {}, 'DELETE')).status, 409);
  assert.equal((await api(admin, '/api/agent/tasks', task({ attachmentIds: [file.id] }))).status, 409);
  for (const filename of fs.readdirSync(path.join(directory, 'agent-tasks/files'))) {
    const encrypted = fs.readFileSync(path.join(directory, 'agent-tasks/files', filename), 'utf8'); assert.ok(!encrypted.includes(secret)); assert.ok(!encrypted.includes('项目资料.md'));
  }
  const listed = (await api(admin, '/api/agent/tasks')).json().tasks.find(value => value.id === body.id);
  assert.equal(listed.artifacts[0].text, undefined); assert.equal(listed.attachments[0].text, undefined);
  await stop(); await start();
  assert.equal((await api(admin, originalRoute)).bytes.toString(), secret); assert.deepEqual((await api(admin, outputRoute)).bytes, csv.bytes);
  const next = task({ conversationId: body.conversationId, parentTaskId: body.id, prompt: '把前面的资料清单再整理一份' });
  assert.equal((await api(admin, '/api/agent/tasks', next)).status, 202);
  const continued = await complete(next.id); assert.equal(continued.artifacts.length, 1); assert.equal(adapter.calls, before + 2);
  assert.match((await api(admin, '/api/agent/tasks/' + next.id + '/artifacts/' + continued.artifacts[0].id + '/download')).bytes.toString(), /项目资料.md/);
  assert.equal((await api(admin, '/api/agent/conversations/' + body.conversationId, {}, 'DELETE')).status, 200);
  assert.equal((await api(admin, originalRoute)).status, 404); assert.equal((await api(admin, outputRoute)).status, 410);
});
test('missing, foreign and changed attachments cannot bypass task identity or become inline browser-supplied documents', async () => {
  const foreign = await upload('other.txt', 'other owner document', second);
  assert.equal((await api(admin, '/api/agent/tasks', task({ attachmentIds: [foreign.id] }))).status, 404);
  assert.equal((await api(admin, '/api/agent/tasks', task({ attachmentIds: [crypto.randomUUID()] }))).status, 404);
  assert.equal((await api(admin, '/api/agent/tasks', task({ documents: [{ id: crypto.randomUUID(), name: 'forged.txt', text: 'forged' }] }))).status, 400);
  const file = await upload('one.txt', 'first document'), another = await upload('two.txt', 'second document');
  const body = task({ attachmentIds: [file.id] });
  assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202); await complete(body.id);
  assert.equal((await api(admin, '/api/agent/tasks', { ...body, attachmentIds: [another.id] })).status, 409);
  assert.equal((await api(admin, '/api/agent/tasks', task({ attachmentIds: [another.id, another.id] }))).status, 400);
});
test('a lost document submission is fenced using its saved document fingerprint without model replay', async () => {
  const file = await upload('lost.txt', 'unsubmitted private document'), body = task({ attachmentIds: [file.id] }), before = adapter.calls;
  dropNext = true; assert.equal((await api(admin, '/api/agent/tasks', body)).status, 202);
  await Promise.all([...app.agentTasks.operations.values()]); assert.equal(app.agentTasks.get(admin.user.id, body.id).status, 'unknown');
  await stop(); await start();
  const recovered = await api(admin, '/api/agent/tasks/' + body.id + '/recover', {});
  assert.equal(recovered.status, 200); assert.equal(recovered.json().task.recoveryReason, 'not-accepted'); assert.equal(cloud.active.get(admin.user.id), 0);
  const documents = app.agentTasks.files.prepare(admin.user.id, [file.id], body.conversationId);
  const late = await client.submit(admin.user.id, { id: body.id, conversationId: body.conversationId, prompt: body.prompt, documents });
  assert.equal(late.recoveryReason, 'not-accepted'); assert.equal(adapter.calls, before);
});
