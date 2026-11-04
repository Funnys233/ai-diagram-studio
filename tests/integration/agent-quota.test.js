'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-membership-api-')), token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'token');
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
Object.assign(process.env, { APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://fixture.example', CLOUD_DATA_DIR: directory, CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'fixture-password', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: 'site', DSH_BRIDGE_TOKEN_FILE: tokenFile, DEEPSEEK_API_KEY: '' });
const { createServer, cloudRuntime: cloud } = require('../../server');
const { taskCapability } = require('../../services/dsh-bridge/file-protocol');
const jobs = new Map(), submissions = [], calls = [];
const client = { configured: true,
  async health() { return { status: 'ready', mode: 'adapter', version: 1, jobsAvailable: true, continuationAvailable: true, modelSelectionAvailable: true, usageAvailable: true }; },
  async submit(owner, body) { submissions.push({ owner, ...body }); const job = { ...body, status: 'running', output: '', continuationAvailable: true }; jobs.set(body.id, job); return job; },
  async get(owner, id) { return jobs.get(id); }, async cancel(owner, id) { jobs.get(id).status = 'cancelled'; return jobs.get(id); }, async release(owner, id) { jobs.delete(id); },
};
let app, base, gateway, users = {}, heldCall = false, releaseGateway;
const ids = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra', 'grok-4.7', 'claude-opus-5-5'];
function raw(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, json() { return JSON.parse(text); } }));
    }); req.on('error', reject); req.end(data);
  });
}
const api = (user, route, body, method = body === undefined ? 'GET' : 'POST', headers) => raw(base + route, { method, body, headers: { Host: 'fixture.example', Origin: 'https://fixture.example', ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf } : {}), ...headers } });
async function login(name) { const response = await api(null, '/api/auth/login', { username: name, password: 'fixture-password' }); assert.equal(response.status, 200); return { cookie: response.headers['set-cookie'][0].split(';')[0], ...response.json() }; }
const task = (modelId = 'gpt-6-luna', providerId = 'platform:relay', patch = {}) => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'quota integration fixture', modelSelection: { providerId, modelId }, ...patch });
async function finish(user, body, usage = { calls: 3, complete: true, inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400, reasoningTokens: 50 }) {
  await Promise.all([...app.agentTasks.operations.values()]);
  Object.assign(jobs.get(body.id), { status: 'completed', output: '已完成', usage });
  await app.agentTasks.reconcile(app.agentTasks.jobs.get(body.id));
  return (await api(user, '/api/agent/tasks/' + body.id)).json().task;
}
async function start() {
  app = createServer({ agentClient: client, agentEnabled: true, agentQueueEnabled: false, agentHistoryEnabled: false, agentModelCall: async (lock, body, timeout, options) => {
    calls.push({ model: lock.model.modelId, apiKey: lock.apiKey });
    options.onChunk({ choices: [{ index: 0, delta: { content: 'gateway fixture' }, finish_reason: null }] });
    const held = heldCall;
    if (held) await new Promise(resolve => releaseGateway = resolve);
    const result = { text: 'gateway fixture', finishReason: 'stop', usage: { prompt_tokens: held ? 10000 : 100, completion_tokens: held ? 1000 : 20, total_tokens: held ? 11000 : 120, prompt_tokens_details: { cached_tokens: 30 } } };
    options.afterCall(undefined, result, null); return result;
  } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + app.address().port;
  await new Promise(resolve => app.agentModelGateway.listen(0, '127.0.0.1', resolve)); gateway = 'http://127.0.0.1:' + app.agentModelGateway.address().port;
}
async function stop() {
  await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]);
  app.agentModelGateway.closeAllConnections(); await new Promise(resolve => app.agentModelGateway.close(resolve)); app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
}
test.before(async () => {
  await cloud.platform.createProvider({ providerId: 'relay', name: '平台中转', baseUrl: 'https://models.example/v1', apiKey: 'fixture-platform-secret', protocol: 'openai-chat-completions', models: ids.map(modelId => ({ modelId, displayName: modelId })) });
  const actor = { identity: { user: cloud.data.users[0] } };
  for (const name of ['freeuser', 'prouser', 'maxuser', 'trialuser']) await cloud.createUser(actor, { username: name, password: 'fixture-password' });
  cloud.change(data => { for (const [name, plan] of [['freeuser', 'free'], ['prouser', 'pro'], ['maxuser', 'max'], ['trialuser', 'trial']]) data.users.find(user => user.username === name).membership = { plan, expiresAt: Date.now() + 86400000 }; });
  const free = cloud.data.users.find(user => user.username === 'freeuser');
  await cloud.providerStore(free.id).createProvider({ providerId: 'mine', name: '个人 API', baseUrl: 'https://personal.example/v1', apiKey: 'fixture-personal-secret', protocol: 'openai-chat-completions', models: [{ modelId: 'gpt-6-astra' }] });
  await start(); for (const name of ['admin', 'freeuser', 'prouser', 'maxuser', 'trialuser']) users[name] = await login(name);
});
test.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
test('member access and model multipliers match conversation permissions without exposing provider secrets', async () => {
  assert.equal((await api(null, '/api/agent/models')).status, 401);
  assert.equal((await api(users.trialuser, '/agent.html')).status, 403); assert.equal((await api(users.trialuser, '/api/agent/models')).status, 403);
  assert.equal((await api(users.freeuser, '/agent.html')).status, 200); assert.equal((await api(users.freeuser, '/admin.html')).status, 403);
  const free = (await api(users.freeuser, '/api/agent/models')).json().models;
  assert.ok(free.some(model => model.providerId === 'platform:relay' && model.modelId === 'gpt-6-luna' && model.multiplier === 0.5));
  assert.ok(!free.some(model => model.providerId === 'platform:relay' && model.modelId === 'gpt-6.1-sol'));
  assert.ok(free.some(model => model.providerId === 'personal:mine' && model.modelId === 'gpt-6-astra' && model.multiplier === null));
  const pro = (await api(users.prouser, '/api/agent/models')).json().models;
  assert.equal(pro.find(model => model.modelId === 'gpt-6.1-sol').multiplier, 15); assert.equal(pro.find(model => model.modelId === 'grok-4.7').multiplier, 25);
  assert.ok(!pro.some(model => model.modelId === 'gpt-6-astra'));
  const max = (await api(users.maxuser, '/api/agent/models')).json().models; assert.equal(max.find(model => model.modelId === 'gpt-6-astra').multiplier, 150);
  assert.ok(!JSON.stringify(max).includes('fixture-platform-secret'));
  assert.equal((await api(users.freeuser, '/api/agent/tasks', task('gpt-6.1-sol'))).status, 403);
});
test('one DSH round consumes one aggregated weekly bill, preserving source rate and idempotency through refresh', async () => {
  const user = users.prouser, before = cloud.weeklySnapshot(user.user.id).usedPoints, body = task('gpt-6.1-sol');
  assert.equal((await api(user, '/api/agent/tasks', body)).status, 202);
  assert.equal((await api(user, '/api/agent/tasks', body)).status, 200); assert.equal(submissions.filter(row => row.id === body.id).length, 1);
  const completed = await finish(user, body);
  assert.equal(completed.quota.points, 22.5); assert.equal(completed.usage.calls, 3); assert.equal(completed.modelSelection.multiplier, 15);
  assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, before + 22.5);
  assert.ok(!JSON.stringify(completed).includes('fixture-platform-secret'));
  assert.equal((await api(user, '/api/agent/tasks', { ...body, modelSelection: { ...body.modelSelection, multiplier: 0 } })).status, 400);
  assert.equal((await api(users.freeuser, '/api/agent/tasks/' + body.id)).status, 404);
  for (let n = 0; n < 3; n++) await api(user, '/api/agent/conversations/' + body.conversationId);
  assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, before + 22.5);
  const next = task('gpt-6.1-sol', 'platform:relay', { conversationId: body.conversationId, parentTaskId: body.id });
  assert.equal((await api(user, '/api/agent/tasks', { ...next, modelSelection: { providerId: 'platform:relay', modelId: 'gpt-6-luna' } })).status, 409);
  assert.equal((await api(user, '/api/agent/tasks', next)).status, 202); await finish(user, next);
  assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, before + 45);
});
test('private task gateway uses the owner model snapshot and retains observed usage across web restart', async () => {
  const user = users.freeuser, body = task(), before = cloud.weeklySnapshot(user.user.id).usedPoints;
  assert.equal((await api(user, '/api/agent/tasks', body)).status, 202); await Promise.all([...app.agentTasks.operations.values()]);
  const request = { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hello' }], stream_options: { include_usage: true } };
  const auth = { Authorization: 'Bearer ' + taskCapability(token, body.id) };
  assert.equal((await raw(gateway + '/v1/chat/completions', { method: 'POST', body: request, headers: { Authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await raw(gateway + '/v1/chat/completions', { method: 'POST', body: { ...request, model: 'gpt-6-astra' }, headers: auth })).status, 400);
  assert.equal((await raw(gateway + '/v1/chat/completions', { method: 'POST', body: request, headers: auth })).status, 200);
  assert.equal(calls.at(-1).apiKey, 'fixture-platform-secret');
  await stop(); await start();
  assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, before);
  const completed = await finish(user, body, { calls: 1, complete: false });
  assert.equal(completed.quota.points, 0.1); assert.equal(completed.quota.estimated, false);
  assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, before + 0.1);
  assert.equal((await raw(gateway + '/v1/chat/completions', { method: 'POST', body: request, headers: auth })).status, 403);
});
test('personal API usage never deducts weekly points, and exhausted weekly quota prevents model submission', async () => {
  const user = users.freeuser, before = cloud.weeklySnapshot(user.user.id).usedPoints, body = task('gpt-6-astra', 'personal:mine');
  assert.equal((await api(user, '/api/agent/tasks', body)).status, 202); const result = await finish(user, body);
  assert.equal(result.quota.pool, 'personal'); assert.equal(result.quota.points, 0); assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, before);
  cloud.change(data => { data.users.find(row => row.id === users.prouser.user.id).weeklyLimitPoints = 1; });
  const denied = task('gpt-6.1-sol'), count = submissions.length;
  assert.equal((await api(users.prouser, '/api/agent/tasks', denied)).status, 429); assert.equal(submissions.length, count);
  assert.equal(cloud.active.get(users.prouser.user.id), 0);
});
test('an SDK cancellation waits for the last live gateway receipt before publishing its final charge', async () => {
  const user = users.freeuser, body = task(), before = cloud.weeklySnapshot(user.user.id).usedPoints;
  assert.equal((await api(user, '/api/agent/tasks', body)).status, 202); await Promise.all([...app.agentTasks.operations.values()]);
  heldCall = true;
  const request = raw(gateway + '/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + taskCapability(token, body.id) }, body: { model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'hold the callback' }] } });
  for (let i = 0; i < 100 && !releaseGateway; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(releaseGateway); Object.assign(jobs.get(body.id), { status: 'cancelled', output: '', usage: { calls: 1, complete: false } });
  const local = app.agentTasks.jobs.get(body.id); await app.agentTasks.reconcile(local);
  assert.equal(local.status, 'unknown'); assert.equal(cloud.active.get(user.user.id), 1); assert.equal(app.agentTasks.meter.view(local).status, 'pending');
  releaseGateway(); const response = await request; heldCall = false; releaseGateway = null; assert.equal(response.status, 200);
  await app.agentTasks.reconcile(local);
  assert.equal(local.status, 'cancelled'); assert.equal(app.agentTasks.meter.view(local).points, 7.5); assert.equal(cloud.active.get(user.user.id), 0);
  assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, before + 7.5);
  assert.equal(local.modelLock, null);
});
