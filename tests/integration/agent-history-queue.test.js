'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');

// Every HTTP request, user, ledger and encrypted file in this suite is local.
// The fake bridge never calls a model or opens a model gateway connection.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-queue-api-'));
const tokenFile = path.join(directory, 'bridge-token');
fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
Object.assign(process.env, {
  APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://fixture.example', CLOUD_DATA_DIR: directory,
  CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'fixture-password',
  CLOUD_CHATGPT_OWNER: '', CLOUD_TOTAL_CONCURRENCY: '6', DSH_MODEL_SOURCE: 'site', DSH_BRIDGE_TOKEN_FILE: tokenFile,
  DSH_MAX_CONCURRENT: '6', DSH_HISTORY_DAYS: '30', DEEPSEEK_API_KEY: '',
});
const { createServer, cloudRuntime: cloud } = require('../../server');
const { TaskError } = require('../../lib/conversation-tasks');
const RUNNING = new Set(['running', 'unknown', 'cancelling']);
const records = new Map(), submissions = [], releases = [], users = {};
let app, base, externalActive = 0, peak = 0;
function remote(owner, id) {
  const value = records.get(id);
  if (!value || value.owner !== owner) throw new TaskError(404, 'agent-upstream-404', 'fixture not found');
  return value;
}
const client = {
  configured: true,
  async health() { return { version: 1, status: 'ready', mode: 'adapter', jobsAvailable: true, filesAvailable: true, continuationAvailable: true, modelSelectionAvailable: true, usageAvailable: true, maxConcurrent: 6, activeJobs: externalActive + [...records.values()].filter(job => RUNNING.has(job.status)).length }; },
  async submit(owner, body) {
    assert.ok(!records.has(body.id), 'accepted task IDs must never be submitted twice');
    const value = { ...body, owner, status: 'running', output: '', continuationAvailable: true };
    submissions.push({ owner, ...body }); records.set(body.id, value);
    peak = Math.max(peak, [...records.values()].filter(job => RUNNING.has(job.status)).length);
    assert.ok(peak <= 6, 'the website must not exceed the bridge capacity');
    return value;
  },
  async get(owner, id) { return remote(owner, id); },
  async cancel(owner, id) { return Object.assign(remote(owner, id), { status: 'cancelled', usage: { calls: 0, complete: true, inputTokens: 0, outputTokens: 0 } }); },
  async release(owner, id) { remote(owner, id); releases.push(id); records.delete(id); },
};
function raw(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, bytes, text: bytes.toString('utf8'), json() { return JSON.parse(bytes.toString('utf8')); } }); });
    });
    req.on('error', reject); req.end(data);
  });
}
const api = (user, route, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => raw(base + route, { method, body, headers: {
  Host: 'fixture.example', Origin: 'https://fixture.example', ...(user ? { Cookie: user.cookie, 'X-CSRF-Token': user.csrf } : {}), ...headers,
} });
async function login(name) {
  const response = await api(null, '/api/auth/login', { username: name, password: 'fixture-password' });
  assert.equal(response.status, 200, response.text);
  return { cookie: response.headers['set-cookie'][0].split(';')[0], ...response.json() };
}
const task = (patch = {}) => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'queue integration fixture', modelSelection: { providerId: 'platform:relay', modelId: 'gpt-6-luna' }, ...patch });
async function pump() {
  for (let i = 0; i < 3; i++) { await app.agentTasks.schedule(); await Promise.all([...app.agentTasks.operations.values()]); }
  assert.equal(app.agentTasks.storageFailed, undefined, 'task persistence must remain healthy');
}
async function finish(user, body, patch = {}) {
  await pump();
  Object.assign(remote(user.user.id, body.id), { status: 'completed', output: '完整回复：' + body.prompt,
    usage: { calls: 1, complete: true, inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 }, ...patch });
  await app.agentTasks.reconcile(app.agentTasks.jobs.get(body.id)); await pump();
  const response = await api(user, '/api/agent/tasks/' + body.id);
  assert.equal(response.status, 200, response.text); return response.json().task;
}
async function start() {
  // Queue and history intentionally use the production site defaults here.
  app = createServer({ agentClient: client, agentEnabled: true });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + app.address().port;
  await pump();
}
async function stop() {
  if (!app) return;
  await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]);
  if (app.agentModelGateway?.listening) { app.agentModelGateway.closeAllConnections(); await new Promise(resolve => app.agentModelGateway.close(resolve)); }
  app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); app = null;
}
const noCharge = user => {
  const snapshot = cloud.weeklySnapshot(user.user.id);
  assert.equal(snapshot.usedPoints, 0); assert.equal(snapshot.reservedPoints, 0);
  assert.equal(cloud.active.get(user.user.id) || 0, 0);
};
test.before(async () => {
  await cloud.platform.createProvider({ providerId: 'relay', name: '平台中转', baseUrl: 'https://models.example/v1', apiKey: 'fixture-platform-secret', protocol: 'openai-chat-completions', models: [{ modelId: 'gpt-6-luna', displayName: 'Luna' }, { modelId: 'gpt-6.1-sol', displayName: 'Sol' }] });
  const actor = { identity: { user: cloud.data.users[0] } };
  for (const name of [...Array.from({ length: 9 }, (_, i) => 'member' + (i + 1)), 'trialuser']) await cloud.createUser(actor, { username: name, password: 'fixture-password' });
  cloud.change(data => { for (const user of data.users) if (user.username !== 'admin') user.membership = { plan: user.username === 'trialuser' ? 'trial' : user.username === 'member9' ? 'pro' : 'free', expiresAt: Date.now() + 86400000 }; });
  await start();
  for (const name of ['admin', ...Array.from({ length: 9 }, (_, i) => 'member' + (i + 1)), 'trialuser']) users[name] = await login(name);
});
test.after(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });

test('site defaults expose six parallel workers, durable queues and 30-day history to ordinary members', async () => {
  assert.equal((await api(null, '/api/agent/history')).status, 401);
  assert.equal((await api(null, '/api/agent/files')).status, 401);
  assert.equal((await api(users.trialuser, '/api/agent/status')).status, 403);
  const response = await api(users.member1, '/api/agent/status'); assert.equal(response.status, 200, response.text);
  const status = response.json();
  assert.equal(status.available, true); assert.equal(status.queueAvailable, true); assert.equal(status.queue.enabled, true);
  assert.equal(status.parallelLimit, 6); assert.equal(status.queue.maxConcurrent, 6); assert.equal(status.queue.maxQueued, 50);
  assert.equal(status.historyAvailable, true); assert.equal(status.libraryAvailable, true); assert.equal(status.historyRetentionDays, 30);
  assert.equal(status.access, 'member-preview'); assert.equal(status.billing, 'site-quota');
  assert.equal((await api(users.member1, '/agent.html')).status, 200);
  assert.equal((await api(users.member1, '/admin.html')).status, 403);
});

test('six users run together while waiting tasks survive restart, reserve nothing, cancel locally and dispatch FIFO', async () => {
  const running = Array.from({ length: 6 }, () => task());
  const admitted = await Promise.all(running.map((body, i) => api(users['member' + (i + 1)], '/api/agent/tasks', body)));
  for (const result of admitted) assert.equal(result.status, 202, result.text);
  await pump(); assert.equal(submissions.length, 6); assert.equal(cloud.globalActive, 6);
  for (const [i, body] of running.entries()) {
    assert.equal((await api(users['member' + (i + 1)], '/api/agent/tasks/' + body.id)).json().task.status, 'running');
    assert.ok(cloud.weeklySnapshot(users['member' + (i + 1)].user.id).reservedPoints > 0);
  }
  const cancelled = task(), waiting = task();
  assert.equal((await api(users.member7, '/api/agent/tasks', cancelled)).status, 202);
  assert.equal((await api(users.member8, '/api/agent/tasks', waiting)).status, 202);
  await pump();
  assert.equal((await api(users.member7, '/api/agent/tasks/' + cancelled.id)).json().task.queuePosition, 1);
  assert.equal((await api(users.member8, '/api/agent/tasks/' + waiting.id)).json().task.queuePosition, 2);
  noCharge(users.member7); noCharge(users.member8);
  assert.equal(cloud.data.events.some(event => event.turnId === waiting.id), false);
  assert.equal((await api(users.member7, '/api/agent/tasks', task())).status, 429);
  assert.equal((await api(users.member7, '/api/agent/tasks', cancelled)).status, 200);
  assert.equal((await api(users.member8, '/api/agent/tasks/' + cancelled.id)).status, 404);
  await stop(); await start();
  assert.equal(submissions.length, 6, 'restart must not replay accepted work');
  assert.equal(cloud.globalActive, 6); noCharge(users.member7); noCharge(users.member8);
  assert.equal((await api(users.member8, '/api/agent/tasks/' + waiting.id)).json().task.queuePosition, 2);
  const count = submissions.length, stopped = await api(users.member7, '/api/agent/tasks/' + cancelled.id + '/cancel', {});
  assert.equal(stopped.status, 200, stopped.text); assert.equal(stopped.json().task.status, 'cancelled'); assert.equal(stopped.json().task.usage.calls, 0);
  noCharge(users.member7); assert.equal(submissions.length, count); assert.ok(!releases.includes(cancelled.id));
  const waitingView = (await api(users.member8, '/api/agent/tasks/' + waiting.id)).json().task;
  assert.equal(waitingView.status, 'queued'); assert.equal(waitingView.queuePosition, 1);
  assert.ok(waitingView.queueExpiresAt > waitingView.createdAt);
  await finish(users.member1, running[0]);
  assert.equal(submissions.at(-1).id, waiting.id); assert.equal(submissions.at(-1).owner, users.member8.user.id);
  assert.ok(cloud.weeklySnapshot(users.member8.user.id).reservedPoints > 0);
  for (let i = 1; i < running.length; i++) await finish(users['member' + (i + 1)], running[i]);
  const completed = await finish(users.member8, waiting);
  assert.equal(completed.quota.points, 0.1); assert.equal(completed.quota.reservedPoints, 0); assert.equal(cloud.globalActive, 0);
  assert.equal(peak, 6); assert.equal(new Set(submissions.map(row => row.id)).size, submissions.length);
});

test('a membership downgrade after enqueue is checked again before dispatch without a bill or a model call', async () => {
  externalActive = 6;
  const user = users.member9, body = task({ modelSelection: { providerId: 'platform:relay', modelId: 'gpt-6.1-sol' } });
  const response = await api(user, '/api/agent/tasks', body); assert.equal(response.status, 202, response.text); await pump();
  assert.equal((await api(user, '/api/agent/tasks/' + body.id)).json().task.status, 'queued'); noCharge(user);
  cloud.change(data => { data.users.find(row => row.id === user.user.id).membership.plan = 'free'; });
  externalActive = 0; await pump();
  const denied = (await api(user, '/api/agent/tasks/' + body.id)).json().task;
  assert.equal(denied.status, 'rejected'); assert.equal(denied.usage.calls, 0); noCharge(user);
  assert.equal(submissions.some(row => row.id === body.id), false);
  assert.equal(cloud.data.events.some(event => event.turnId === body.id), false);
});

test('history search, rename and pin are CSRF-protected, owner-bound and durable while full replies stay encrypted', async () => {
  const user = users.member1, other = users.member2, body = task({ prompt: 'history-private-marker-73021' });
  assert.equal((await api(user, '/api/agent/tasks', body)).status, 202);
  const completed = await finish(user, body, { output: '完整历史正文73021\n' + '历史内容'.repeat(2000) });
  const route = '/api/agent/conversations/' + body.conversationId;
  assert.equal((await api(other, route)).status, 404);
  assert.equal((await api(other, route, { pinned: true }, 'PATCH')).status, 404);
  assert.equal((await api(user, route, { title: '恶意修改' }, 'PATCH', { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await api(user, route, { pinned: true }, 'PATCH', { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await api(user, route, { title: 'x'.repeat(81) }, 'PATCH')).status, 400);
  const renamed = await api(user, route, { title: '长期研究计划73021', pinned: true }, 'PATCH');
  assert.equal(renamed.status, 200, renamed.text); assert.equal(renamed.json().title, '长期研究计划73021'); assert.equal(renamed.json().pinned, true); assert.equal(renamed.json().expiresAt, null);
  const search = '/api/agent/history?search=' + encodeURIComponent('研究计划73021') + '&pinned=true&limit=1';
  const history = (await api(user, search)).json();
  assert.equal(history.conversations.length, 1); assert.equal(history.conversations[0].conversationId, body.conversationId);
  assert.equal(history.conversations[0].turns, 1); assert.equal(history.conversations[0].expiresAt, null); assert.equal(history.conversations[0].output, undefined);
  assert.equal((await api(other, search)).json().conversations.length, 0);
  assert.equal((await api(user, '/api/agent/history?limit=0')).status, 400);
  assert.equal((await api(user, '/api/agent/history?cursor=bad')).status, 400);
  assert.equal(app.agentTasks.jobs.get(body.id).output, '', 'terminal payloads are loaded on demand');
  assert.equal(fs.readFileSync(path.join(directory, 'agent-tasks', body.id + '.enc'), 'utf8').includes('73021'), false);
  assert.ok(!JSON.stringify(completed).includes('fixture-platform-secret'));
  const quota = cloud.weeklySnapshot(user.user.id).usedPoints, submitted = submissions.length;
  await stop(); await start();
  const restored = await api(user, route); assert.equal(restored.status, 200, restored.text);
  assert.equal(restored.json().title, '长期研究计划73021'); assert.equal(restored.json().pinned, true); assert.match(restored.json().tasks[0].output, /完整历史正文73021/);
  assert.equal(cloud.weeklySnapshot(user.user.id).usedPoints, quota); assert.equal(submissions.length, submitted);
  const unpinned = await api(user, route, { pinned: false }, 'PATCH');
  assert.equal(unpinned.json().pinned, false); assert.ok(unpinned.json().expiresAt > Date.now() + 29 * 86400000);
});

test('the file library lists only owner metadata, serves safe local downloads and cleans up the whole conversation', async () => {
  const user = users.member1, other = users.member2, input = 'private-input-marker-86204\nname,value\npine,7\n';
  const upload = await api(user, '/api/agent/files', { name: 'research-86204.txt', data: Buffer.from(input).toString('base64') });
  assert.equal(upload.status, 201, upload.text); const file = upload.json().file;
  const foreign = await api(other, '/api/agent/files', { name: 'foreign-86204.txt', data: Buffer.from('another owner secret').toString('base64') });
  assert.equal(foreign.status, 201, foreign.text); const foreignFile = foreign.json().file;
  assert.equal((await api(other, '/api/agent/files/' + file.id)).status, 404);
  assert.equal((await api(other, '/api/agent/files/' + file.id + '/download')).status, 404);
  const before = (await api(user, '/api/agent/files?kind=upload&search=86204')).json();
  assert.deepEqual(before.files.map(item => item.id), [file.id]); assert.equal(before.files[0].text, undefined); assert.equal(before.files[0].data, undefined);
  assert.ok(!JSON.stringify(before).includes('private-input-marker')); assert.ok(!JSON.stringify(before).includes(foreignFile.id));
  assert.equal((await api(user, '/api/agent/files?kind=invalid')).status, 400);
  const body = task({ prompt: 'process research files', attachmentIds: [file.id] });
  assert.equal((await api(user, '/api/agent/tasks', body)).status, 202); await pump();
  const sent = submissions.find(row => row.id === body.id);
  assert.equal(sent.documents[0].text, input.trim()); assert.equal(sent.owner, user.user.id);
  assert.deepEqual(sent.modelSelection, { providerId: 'platform:relay', modelId: 'gpt-6-luna' });
  assert.equal((await api(user, '/api/agent/files/' + file.id, {}, 'DELETE')).status, 409);
  const artifact = { id: crypto.randomUUID(), name: 'summary-86204.csv', text: 'name,value\npine,86204\n' };
  const completed = await finish(user, body, { artifacts: [artifact] });
  assert.equal(completed.artifacts.length, 1);
  const pinned = await api(user, '/api/agent/conversations/' + body.conversationId, { pinned: true }, 'PATCH'); assert.equal(pinned.status, 200);
  const library = (await api(user, '/api/agent/files?search=86204')).json();
  assert.equal(library.files.length, 2); assert.ok(library.files.every(row => row.conversationId === body.conversationId && row.expiresAt === null));
  const onlyArtifact = (await api(user, '/api/agent/files?kind=artifact&search=86204&limit=1')).json();
  assert.equal(onlyArtifact.files[0].id, artifact.id); assert.equal(onlyArtifact.files[0].taskId, body.id);
  assert.equal(library.usage.usedBytes, Buffer.byteLength(input) + Buffer.byteLength(artifact.text));
  const artifactRoute = '/api/agent/tasks/' + body.id + '/artifacts/' + artifact.id + '/download';
  assert.equal((await api(null, artifactRoute)).status, 401); assert.equal((await api(other, artifactRoute)).status, 404);
  records.delete(body.id); // Local result/file access remains available after worker expiry.
  const output = await api(user, artifactRoute), original = await api(user, '/api/agent/files/' + file.id + '/download');
  assert.equal(output.status, 200, output.text); assert.equal(output.text, artifact.text); assert.equal(original.text, input);
  assert.equal(output.headers['content-type'], 'application/octet-stream'); assert.equal(output.headers['x-content-type-options'], 'nosniff'); assert.match(output.headers['content-disposition'], /^attachment;/);
  const detail = await api(user, '/api/agent/conversations/' + body.conversationId);
  assert.equal(detail.status, 200); assert.equal(detail.json().canContinue, false); assert.match(detail.json().tasks[0].output, /process research files/);
  const cleanup = '/api/agent/conversations/' + body.conversationId;
  assert.equal((await api(other, cleanup, {}, 'DELETE')).status, 404);
  assert.equal((await api(user, cleanup, {}, 'DELETE', { 'X-CSRF-Token': '' })).status, 403);
  const removed = await api(user, cleanup, {}, 'DELETE'); assert.equal(removed.status, 200, removed.text);
  assert.equal((await api(user, cleanup)).status, 404); assert.equal((await api(user, artifactRoute)).status, 410);
  assert.equal((await api(user, '/api/agent/files/' + file.id + '/download')).status, 404);
  assert.equal((await api(user, '/api/agent/files?search=86204')).json().files.length, 0);
  assert.equal((await api(user, '/api/agent/history?search=process%20research')).json().conversations.length, 0);
  assert.equal(fs.existsSync(path.join(directory, 'agent-tasks', 'files', artifact.id + '.data.enc')), false);
  assert.equal((await api(other, '/api/agent/files/' + foreignFile.id)).status, 200);
  assert.equal((await api(other, '/api/agent/files/' + foreignFile.id, {}, 'DELETE')).status, 200);
});
