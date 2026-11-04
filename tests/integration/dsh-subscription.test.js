'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-dsh-subscription-'));
const token = crypto.randomBytes(32).toString('hex');
const tokenFile = path.join(directory, 'bridge.token');
fs.writeFileSync(tokenFile, token, { mode: 0o600 });
Object.assign(process.env, {
  APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://diagram.example', CLOUD_DATA_DIR: directory,
  CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin',
  CLOUD_ADMIN_PASSWORD: 'fixture-password-123', CLOUD_CHATGPT_OWNER: 'admin',
  DSH_MODEL_SOURCE: 'chatgpt', DSH_BRIDGE_TOKEN_FILE: tokenFile,
  PROVIDERS_CONFIG_PATH: path.join(directory, 'providers.json'), DEEPSEEK_API_KEY: '',
});
const { createServer, cloudRuntime: cloud, chatgptCloud } = require('../../server');
const remoteJobs = new Map(), modelCalls = [], submissions = [];
const client = {
  configured: true,
  async health() { return { jobsAvailable: true, mode: 'adapter' }; },
  async submit(ownerId, body) {
    submissions.push({ ownerId, ...body });
    const job = { ...body, status: 'running', output: '' };
    remoteJobs.set(body.id, job); return job;
  },
  async get(ownerId, id) { return remoteJobs.get(id); },
  async cancel(ownerId, id) { const job = remoteJobs.get(id); job.status = 'cancelled'; return job; },
  async release(ownerId, id) { remoteJobs.delete(id); },
};
let app, base, gatewayBase, owner, second, ordinary;
const accountId = crypto.randomUUID();
const fixtureAccount = {
  id: accountId, clientId: 'oaiapp_fixture', email: 'owner@example.test',
  accessToken: 'fixture-not-a-real-access-token', refreshToken: 'fixture-not-a-real-refresh-token',
  scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000,
  models: [{ modelId: 'gpt-6-luna', displayName: 'Luna fixture', enabled: true, reasoningLevels: [], defaultEffort: null }],
  preferences: {},
};
function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request(url, { method, headers: {
      ...headers, ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
    } }, response => {
      let text = ''; response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text,
        json() { return JSON.parse(text); } }));
    });
    request.setTimeout(5000, () => request.destroy(Error('Fixture request timed out')));
    request.once('error', reject); request.end(payload);
  });
}
function api(user, route, body, method = body === undefined ? 'GET' : 'POST') {
  return rawRequest(base + route, { method, body, headers: {
    Host: 'diagram.example', Origin: 'https://diagram.example', 'Content-Type': 'application/json',
    ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf } : {}),
  } });
}
function gateway(body, route = '/v1/chat/completions', method = 'POST') {
  return rawRequest(gatewayBase + route, { method, body, headers: {
    'Content-Type': 'application/json', Authorization: 'Bearer ' + token,
  } });
}
async function login(username) {
  const response = await api(null, '/api/auth/login', { username, password: 'fixture-password-123' });
  assert.equal(response.status, 200);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], ...response.json() };
}
async function settle() { await Promise.all([...app.agentTasks.operations.values()]); }
const task = () => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'private subscription fixture task' });
const requestBody = () => ({ model: 'gpt-6-luna', stream: true, store: false,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello owner' }] }],
  max_completion_tokens: 2048, stream_options: { include_usage: true } });

test.before(async () => {
  chatgptCloud.data.accounts = [fixtureAccount]; chatgptCloud.data.activeId = accountId;
  // Model and auth HTTP paths are forbidden in this fixture. Only this in-memory
  // completed stream stands in for the owner's authorized subscription call.
  chatgptCloud.request = chatgptCloud.post = async () => { throw Error('External request is forbidden in this fixture'); };
  chatgptCloud.call = async (lock, messages, timeoutMs, options) => {
    modelCalls.push({ lock, messages, timeoutMs });
    options.onText('订阅'); options.onText('测试成功');
    return { text: '订阅测试成功', finishReason: 'stop', usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } };
  };
  app = createServer({ agentClient: client, agentEnabled: true });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + app.address().port;
  assert.ok(app.subscriptionGateway);
  await new Promise(resolve => app.subscriptionGateway.listen(0, '127.0.0.1', resolve));
  gatewayBase = 'http://127.0.0.1:' + app.subscriptionGateway.address().port;
  owner = await login('admin');
  const req = { identity: { user: cloud.data.users.find(user => user.username === 'admin') } };
  await cloud.createUser(req, { username: 'second', password: 'fixture-password-123' });
  await cloud.createUser(req, { username: 'ordinary', password: 'fixture-password-123' });
  cloud.change(data => { data.users.find(user => user.username === 'second').role = 'admin'; });
  second = await login('second'); ordinary = await login('ordinary');
});
test.after(async () => {
  if (app) {
    await Promise.all([app.conversationTasks.close(), app.drawingTasks.close(), app.agentTasks.close()]);
    app.subscriptionGateway.closeAllConnections();
    await new Promise(resolve => app.subscriptionGateway.close(resolve));
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test('subscription pilot page and API admit only the connected owner, including among admins', async () => {
  assert.equal((await api(null, '/agent.html')).status, 302);
  for (const user of [second, ordinary]) {
    for (const route of ['/agent.html', '/agent/', '/api/agent/status', '/api/agent/tasks']) {
      assert.equal((await api(user, route)).status, 403, route);
    }
    assert.equal((await api(user, '/api/agent/tasks', task())).status, 403);
  }
  assert.equal((await api(null, '/api/agent/status')).status, 401);
  assert.equal((await api(owner, '/agent.html')).status, 200);
  const status = await api(owner, '/api/agent/status');
  assert.equal(status.status, 200);
  assert.deepEqual({ available: status.json().available, billing: status.json().billing,
    modelId: status.json().modelId, ownerOnly: status.json().ownerOnly },
  { available: true, billing: 'chatgpt-plan', modelId: 'gpt-6-luna', ownerOnly: true });
  assert.equal(submissions.length, 0); assert.equal(modelCalls.length, 0);
});

test('private gateway requires an active owner task and preserves the subscription source and site quota', async () => {
  const usageBefore = structuredClone(cloud.usage(owner.user.id));
  assert.equal((await gateway(requestBody())).status, 403);
  const health = await gateway(undefined, '/v1/health', 'GET');
  assert.deepEqual(health.json(), { ready: true, billing: 'chatgpt-plan', model: 'gpt-6-luna' });
  assert.equal(modelCalls.length, 0);
  const body = task();
  assert.equal((await api(owner, '/api/agent/tasks', body)).status, 202); await settle();
  assert.equal(app.agentTasks.get(owner.user.id, body.id).status, 'running');
  assert.equal(cloud.active.get(owner.user.id), 1);
  // A bridge poll timeout does not revoke the owner's already-authorized work.
  app.agentTasks.update(app.agentTasks.jobs.get(body.id), { status: 'unknown' });
  const streamed = await gateway(requestBody());
  assert.equal(streamed.status, 200); assert.match(streamed.headers['content-type'], /event-stream/);
  const frames = streamed.text.split('\n\n').filter(part => part.startsWith('data: ') && part !== 'data: [DONE]').map(part => JSON.parse(part.slice(6)));
  assert.equal(frames.map(frame => frame.choices[0]?.delta.content || '').join(''), '订阅测试成功');
  assert.equal(frames.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(frames.at(-1).usage, { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 });
  assert.match(streamed.text, /data: \[DONE\]\n\n$/);
  assert.ok(frames.every(frame => frame.model === 'gpt-6-luna'));
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].lock.accountId, accountId);
  assert.equal(modelCalls[0].lock.protocol, 'chatgpt-responses');
  assert.equal(modelCalls[0].lock.providerId, 'chatgpt:' + accountId);
  assert.deepEqual(modelCalls[0].messages, [{ role: 'user', content: 'Hello owner' }]);
  assert.doesNotMatch(streamed.text, /fixture-not-a-real|oaiapp_fixture/);
  assert.deepEqual(cloud.usage(owner.user.id), usageBefore);
  const remote = remoteJobs.get(body.id); remote.status = 'completed'; remote.output = '订阅测试成功';
  await app.agentTasks.reconcile(app.agentTasks.jobs.get(body.id));
  const completed = await api(owner, '/api/agent/tasks/' + body.id);
  assert.equal(completed.json().task.output, '订阅测试成功');
  assert.equal(cloud.active.get(owner.user.id), 0);
  assert.equal((await gateway(requestBody())).status, 403);
  assert.equal(modelCalls.length, 1);
  assert.deepEqual(cloud.usage(owner.user.id), usageBefore);
});

test('disconnected owner and disabled owner cannot expose a ready subscription path', async () => {
  const accessToken = fixtureAccount.accessToken;
  fixtureAccount.accessToken = '';
  try {
    const submissionsBefore = submissions.length;
    const status = (await api(owner, '/api/agent/status')).json();
    assert.equal(status.available, false); assert.equal(status.billing, 'chatgpt-plan');
    assert.equal((await gateway(undefined, '/v1/health', 'GET')).json().ready, false);
    const rejected = await api(owner, '/api/agent/tasks', task());
    assert.equal(rejected.status, 503);
    assert.equal(rejected.json().error.code, 'agent-subscription-unavailable');
    assert.equal(submissions.length, submissionsBefore);
  } finally { fixtureAccount.accessToken = accessToken; }
  const ownerRecord = cloud.data.users.find(user => user.id === owner.user.id);
  ownerRecord.disabled = true;
  try { assert.equal((await gateway(undefined, '/v1/health', 'GET')).json().ready, false); }
  finally { ownerRecord.disabled = false; }
  assert.equal(modelCalls.length, 1);
});
