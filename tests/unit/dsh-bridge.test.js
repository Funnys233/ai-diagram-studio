'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const token = 'ab'.repeat(32);

function controlledAdapter() {
  const calls = []; const pending = new Map();
  return { calls, pending, supportsContinuation: true, canResume() { return true; }, run(args) { calls.push(args); return new Promise((resolve) => pending.set(args.sessionId, resolve)); }, async cancel() {} };
}
async function fixture(t, adapter = controlledAdapter(), dir, options = {}) {
  dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
  const bridge = createBridge({ stateDir: dir, token, adapter, timeoutMs: 1000, ...options });
  const addr = await bridge.listen();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(method, route, owner = 'alice', body, auth = token) {
    const response = await fetch(`http://127.0.0.1:${addr.port}${route}`, { method, headers: { authorization: `Bearer ${auth}`, 'x-site-owner': owner, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  }
  return { adapter, request, dir, bridge };
}
const post = (request, id = 'job-1', conversationId = 'conversation-1', prompt = 'hello', parentTaskId) => request('POST', '/v1/jobs', 'alice', { id, conversationId, prompt, ...(parentTaskId ? { parentTaskId } : {}) });
const waitFor = async (predicate) => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 5)); } throw Error('timed out'); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const recoveryBody = (conversationId = 'conversation-1', prompt = 'hello', owner = 'alice') => ({ conversationId, fingerprint: digest(JSON.stringify([digest(owner), conversationId, prompt])) });
function interruptedState(output = 'saved partial') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-'));
  const job = { id: 'job-1', ownerHash: digest('alice'), fingerprint: recoveryBody().fingerprint, conversationId: 'conversation-1', sessionId: crypto.randomUUID(), status: 'running', output, updatedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, jobs: [job] }));
  return { dir, job };
}

test('file tasks bind reference contents, transport more than 64KiB and persist actual artifacts only after termination', async t => {
  const adapter = controlledAdapter(); adapter.supportsFiles = true;
  const { request, dir } = await fixture(t, adapter);
  assert.equal((await request('GET', '/v1/health')).body.filesAvailable, true);
  const body = { id: 'file-task', conversationId: 'file-conversation', prompt: 'save a CSV', documents: [{ id: crypto.randomUUID(), name: 'reference.txt', text: '文'.repeat(50000) }] };
  assert.equal((await request('POST', '/v1/jobs', 'alice', body)).status, 202);
  assert.deepEqual(adapter.calls[0].documents, body.documents);
  assert.equal((await request('POST', '/v1/jobs', 'alice', body)).status, 200); assert.equal(adapter.calls.length, 1);
  assert.equal((await request('POST', '/v1/jobs', 'alice', { ...body, documents: [{ ...body.documents[0], text: 'changed' }] })).status, 409);
  assert.equal((await request('GET', '/v1/jobs/file-task', 'bob')).status, 404);
  const artifact = { id: crypto.randomUUID(), name: 'budget.csv', text: 'name,value\nproject,73021\n' };
  assert.equal((await request('GET', '/v1/jobs/file-task')).body.artifacts, undefined);
  adapter.pending.get(adapter.calls[0].sessionId)({ status: 'completed', output: '', artifacts: [artifact] });
  await new Promise(resolve => setImmediate(resolve));
  const final = (await request('GET', '/v1/jobs/file-task')).body;
  assert.equal(final.status, 'completed'); assert.deepEqual(final.artifacts, [artifact]);
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  assert.deepEqual(disk.jobs[0].artifacts, [artifact]); assert.ok(!JSON.stringify(disk).includes(body.documents[0].text));
  assert.equal((await request('POST', '/v1/jobs/file-task/release', 'alice', {})).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs[0].artifacts, []);
});

test('file recovery publishes task-bound durable files without starting another execution', async t => {
  const { dir, job } = interruptedState('partial');
  const artifact = { id: crypto.randomUUID(), name: 'recovered.md', text: '# Durable result\n' }; let calls = 0, inspections = 0;
  const adapter = { supportsFiles: true, run() { calls++; throw Error('Recovery cannot call a model'); }, async cancel() {}, async recover({ sessionId }) { inspections++; assert.equal(sessionId, job.sessionId); return { stopped: true, status: 'completed', output: '', artifacts: [artifact] }; } };
  const { request } = await fixture(t, adapter, dir);
  await new Promise(resolve => setImmediate(resolve));
  const recovered = (await request('GET', '/v1/jobs/job-1')).body;
  assert.equal(recovered.status, 'completed'); assert.deepEqual(recovered.artifacts, [artifact]);
  assert.equal(recovered.recoveryReason, 'execution-recovered'); assert.equal(calls, 0); assert.equal(inspections, 1);
});

test('requires a valid token and an explicit adapter', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
  assert.throws(() => createBridge({ stateDir: dir, token, adapter: {} }), /adapter/);
  assert.throws(() => createBridge({ stateDir: dir, token: 'weak', adapter: controlledAdapter() }), /token/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isolates owners, disallows extra fields, and idempotently submits one job', async (t) => {
  const { request, adapter } = await fixture(t);
  assert.equal((await request('GET', '/v1/health', 'alice', null, 'wrong')).status, 401);
  assert.equal((await request('POST', '/v1/jobs', 'alice', { id: 'x', conversationId: 'y', prompt: 'a', cwd: '/' })).status, 400);
  assert.equal((await post(request)).status, 202);
  assert.equal((await post(request)).status, 200);
  assert.equal(adapter.calls.length, 1);
  assert.equal((await post(request, 'job-1', 'conversation-1', 'changed')).status, 409);
  assert.equal((await request('GET', '/v1/jobs/job-1', 'bob')).status, 404);
  assert.equal((await request('POST', '/v1/jobs/job-1/cancel', 'bob')).status, 404);
  assert.equal((await post(request, 'job-2')).status, 409);
  adapter.calls[0].onProgress('partial');
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.output, 'partial');
  adapter.pending.get(adapter.calls[0].sessionId)({ status: 'completed', output: 'answer' });
  await waitFor(() => adapter.pending.size === 1); // flush completion in following GET
  await new Promise((r) => setImmediate(r));
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.status, 'completed');
  assert.equal((await post(request, 'job-2', 'conversation-1', 'followup', 'job-1')).status, 202);
  assert.equal(adapter.calls[1].sessionId, adapter.calls[0].sessionId);
});

test('cancel request is not falsely reported as a completed cancellation', async (t) => {
  const { request, adapter } = await fixture(t);
  await post(request);
  assert.equal((await request('POST', '/v1/jobs/job-1/cancel')).body.status, 'cancelling');
  adapter.pending.get(adapter.calls[0].sessionId)({ status: 'cancelled', output: 'partial' });
  await new Promise((r) => setImmediate(r));
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.status, 'cancelled');
});

test('a restart retains task identity and never reruns an uncertain job', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
  const adapter = controlledAdapter();
  const first = createBridge({ stateDir: dir, token, adapter, timeoutMs: 1000 });
  const addr = await first.listen();
  const response = await fetch(`http://127.0.0.1:${addr.port}/v1/jobs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-site-owner': 'alice', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'job-1', conversationId: 'conversation-1', prompt: 'hello' }) });
  assert.equal(response.status, 202);
  await first.close();
  const next = await fixture(t, adapter, dir);
  const again = await post(next.request);
  assert.equal(again.body.status, 'unknown');
  assert.equal(adapter.calls.length, 1);
  assert.equal((await post(next.request, 'job-2')).status, 409);
  assert.equal((await next.request('POST', '/v1/jobs/job-1/cancel')).status, 409);
});


test('diagnostic mode authenticates health and refuses model jobs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bridge-'));
  const bridge = createBridge({ stateDir: dir, token });
  const addr = await bridge.listen();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${addr.port}`;
  const headers = { authorization: `Bearer ${token}`, 'x-site-owner': 'diagnostic', 'content-type': 'application/json' };
  const health = await fetch(`${base}/v1/health`, { headers });
  assert.deepEqual(await health.json(), { status: 'ready', mode: 'diagnostic', version: 1, jobsAvailable: false, recoveryAvailable: false, continuationAvailable: false, filesAvailable: false, usageAvailable: false, modelSelectionAvailable: false, maxConcurrent: 2, activeJobs: 0 });
  const job = await fetch(`${base}/v1/jobs`, { method: 'POST', headers, body: '{}' });
  assert.equal(job.status, 503);
});

test('expired remote output is cleared while its task ID remains non-replayable', async t => {
  let now = 10000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retention-'));
  const adapter = { async run() { return { status: 'completed', output: 'private final output' }; }, async cancel() {} };
  const bridge = createBridge({ stateDir: dir, token, adapter, retentionMs: 1000, now: () => now }); const address = await bridge.listen();
  t.after(async () => { await bridge.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const headers = { authorization: `Bearer ${token}`, 'x-site-owner': 'alice', 'content-type': 'application/json' }, base = 'http://127.0.0.1:' + address.port;
  const submit = () => fetch(base + '/v1/jobs', { method: 'POST', headers, body: JSON.stringify({ id: 'retained', conversationId: 'thread', prompt: 'hello' }) });
  assert.equal((await submit()).status, 202); await new Promise(resolve => setImmediate(resolve));
  now += 1001;
  assert.equal((await fetch(base + '/v1/jobs/retained', { headers })).status, 410);
  assert.equal((await submit()).status, 410);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs[0].output, '');
  assert.equal((await fetch(base + '/v1/jobs/retained/release', { method: 'POST', headers, body: '{}' })).status, 200);
});

test('startup recovers a proven finished execution without running a prompt again', async t => {
  const { dir, job } = interruptedState();
  const adapter = controlledAdapter(), inspections = [];
  adapter.recover = async input => { inspections.push(input); return { status: 'completed', output: 'recovered answer', stopped: true }; };
  const { request } = await fixture(t, adapter, dir);
  const result = await request('GET', '/v1/jobs/job-1');
  assert.equal(result.body.status, 'completed'); assert.equal(result.body.output, 'recovered answer');
  assert.equal(result.body.recoveryReason, 'execution-recovered');
  assert.deepEqual(inspections, [{ sessionId: job.sessionId }]); assert.equal(adapter.calls.length, 0);
  assert.equal((await post(request)).body.status, 'completed'); assert.equal(adapter.calls.length, 0);
  assert.equal((await post(request, 'job-2', 'conversation-1', 'followup', 'job-1')).status, 202); assert.equal(adapter.calls[0].sessionId, job.sessionId);
});

test('uncertain executions retain their slot and polling is throttled, while explicit recovery checks again', async t => {
  const { dir } = interruptedState(); const adapter = controlledAdapter(); let inspections = 0;
  adapter.recover = async () => { inspections++; return { status: 'failed', output: '', stopped: false }; };
  const { request } = await fixture(t, adapter, dir, { maxConcurrent: 1 });
  assert.equal(inspections, 1);
  for (let i = 0; i < 3; i++) assert.equal((await request('GET', '/v1/jobs/job-1')).body.status, 'unknown');
  assert.equal(inspections, 1);
  assert.equal((await post(request, 'job-2', 'another-conversation')).status, 429);
  assert.equal((await request('POST', '/v1/jobs', 'bob', { id: 'job-3', conversationId: 'bob-thread', prompt: 'hi' })).status, 429);
  const retry = await request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody());
  assert.equal(retry.body.status, 'unknown'); assert.equal(retry.body.output, 'saved partial');
  assert.equal(inspections, 2); assert.equal(adapter.calls.length, 0);
});

test('recovery identity and authentication cannot inspect or change another owner job', async t => {
  const { dir } = interruptedState(); const adapter = controlledAdapter(); let inspections = 0;
  adapter.recover = async () => { inspections++; return { status: 'unknown', output: '', stopped: false }; };
  const { request } = await fixture(t, adapter, dir);
  const before = inspections;
  assert.equal((await request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody(), 'wrong')).status, 401);
  assert.equal((await request('POST', '/v1/jobs/job-1/recover', 'bob', recoveryBody('conversation-1', 'hello', 'bob'))).status, 404);
  assert.equal((await request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody('wrong'))).status, 409);
  assert.equal((await request('POST', '/v1/jobs/job-1/recover', 'alice', {})).status, 400);
  assert.equal((await request('POST', '/v1/jobs/job-1/recover', 'alice', { ...recoveryBody(), prompt: 'must not execute' })).status, 400);
  assert.equal(inspections, before); assert.equal(adapter.calls.length, 0);
});

test('concurrent explicit recovery calls share the same inspection and preserve saved partial output', async t => {
  const { dir } = interruptedState(); const adapter = controlledAdapter(); let resolve, inspections = 0;
  adapter.recover = () => { inspections++; return new Promise(done => resolve = done); };
  const { request } = await fixture(t, adapter, dir);
  const first = request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody());
  const second = request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody());
  await new Promise(done => setTimeout(done, 20)); assert.equal(inspections, 1);
  resolve({ status: 'failed', output: '', stopped: true });
  for (const result of await Promise.all([first, second])) { assert.equal(result.body.status, 'failed'); assert.equal(result.body.output, 'saved partial'); }
  assert.equal(adapter.calls.length, 0);
});

test('adapter failure is recovered only after stopped confirmation and does not discard partial output', async t => {
  let inspections = 0;
  const adapter = { async run({ onProgress }) { onProgress('received text'); throw Error('connection lost'); }, async cancel() {}, async recover() { inspections++; return { status: 'failed', output: '', stopped: true }; } };
  const { request } = await fixture(t, adapter, undefined, { maxConcurrent: 1 });
  assert.equal((await post(request)).status, 202); await new Promise(done => setImmediate(done));
  const result = await request('GET', '/v1/jobs/job-1');
  assert.equal(result.body.status, 'failed'); assert.equal(result.body.output, 'received text'); assert.equal(inspections, 1);
  assert.equal((await post(request, 'job-2', 'another-thread')).status, 202);
});

test('timeout recovery can confirm cancellation and late run completion cannot overwrite it', async t => {
  const adapter = controlledAdapter(); let inspections = 0;
  adapter.recover = async () => { inspections++; return { status: 'cancelled', output: 'stopped partial', stopped: true }; };
  const { request } = await fixture(t, adapter, undefined, { maxConcurrent: 1 });
  await post(request); const old = adapter.calls[0];
  await new Promise(done => setTimeout(done, 1050));
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.status, 'cancelled'); assert.equal(inspections, 1);
  assert.equal((await post(request, 'job-2', 'other-thread')).status, 202);
  adapter.pending.get(old.sessionId)({ status: 'completed', output: 'late completion' });
  await new Promise(done => setImmediate(done));
  const result = await request('GET', '/v1/jobs/job-1');
  assert.equal(result.body.status, 'cancelled'); assert.equal(result.body.output, 'stopped partial');
});

test('a missing execution is durably rejected before any delayed submission can run', async t => {
  const adapter = controlledAdapter(); let releases = 0;
  adapter.release = async () => { releases++; };
  const { request, dir } = await fixture(t, adapter);
  assert.equal((await request('GET', '/v1/jobs/job-1')).status, 404);
  const recovered = await request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody());
  assert.equal(recovered.body.status, 'failed'); assert.equal(recovered.body.recoveryReason, 'not-accepted');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs[0];
  assert.equal(stored.sessionId, null); assert.ok(stored.expiresAt > Date.now() + 6 * 86400000);
  assert.equal((await post(request)).body.status, 'failed'); assert.equal(adapter.calls.length, 0);
  assert.equal((await post(request, 'job-1', 'conversation-1', 'changed')).status, 409);
  assert.equal((await request('POST', '/v1/jobs/job-1/recover', 'bob', recoveryBody('conversation-1', 'hello', 'bob'))).status, 404);
  assert.equal((await request('POST', '/v1/jobs/job-1/release', 'alice', {})).status, 200); assert.equal(releases, 0);
});

test('not-accepted tombstones survive restart and expire after their seven-day proof window', async t => {
  let now = 10000; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-missing-proof-'));
  const adapter = controlledAdapter(); const first = createBridge({ stateDir: dir, token, adapter, now: () => now });
  const address = await first.listen();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/jobs/job-1/recover`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-site-owner': 'alice', 'content-type': 'application/json' }, body: JSON.stringify(recoveryBody()) });
  assert.equal(response.status, 200); await response.json(); await first.close();
  const next = await fixture(t, adapter, dir, { now: () => now });
  assert.equal((await post(next.request)).body.status, 'failed'); assert.equal(adapter.calls.length, 0);
  now += 7 * 86400000 + 1;
  assert.equal((await next.request('GET', '/v1/jobs/job-1')).status, 404);
  assert.equal((await post(next.request)).status, 202); assert.equal(adapter.calls.length, 1);
});

test('a recovery storage failure closes admission rather than reporting an unpersisted terminal state', async t => {
  const { dir } = interruptedState(); const file = path.join(dir, 'state.json');
  const adapter = controlledAdapter(); let resolve;
  adapter.recover = () => new Promise(done => resolve = done);
  const { request } = await fixture(t, adapter, dir);
  const original = fs.readFileSync(file);
  fs.unlinkSync(file); fs.mkdirSync(file);
  try {
    resolve({ status: 'failed', output: '', stopped: true }); await new Promise(done => setImmediate(done));
    assert.equal((await request('GET', '/v1/health')).status, 503);
    assert.equal((await post(request, 'job-2')).status, 503); assert.equal(adapter.calls.length, 0);
  } finally { fs.rmdirSync(file); fs.writeFileSync(file, original); }
});

test('a claimed completion with empty recovered output cannot turn saved partial text into a complete answer', async t => {
  const { dir } = interruptedState(); const adapter = controlledAdapter();
  adapter.recover = async () => ({ status: 'completed', output: '', stopped: true });
  const { request } = await fixture(t, adapter, dir);
  const result = await request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody());
  assert.equal(result.body.status, 'unknown'); assert.equal(result.body.output, 'saved partial');
  assert.equal(adapter.calls.length, 0);
});

test('shutdown during a delayed request body cannot admit a task or write a missing-task proof', async () => {
  for (const route of ['/v1/jobs', '/v1/jobs/job-1/recover']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-delayed-body-')), adapter = controlledAdapter();
    const bridge = createBridge({ stateDir: dir, token, adapter }), address = await bridge.listen();
    const body = JSON.stringify(route.endsWith('/recover') ? recoveryBody() : { id: 'job-1', conversationId: 'conversation-1', prompt: 'hello' });
    let ready, stopping;
    const waiting = new Promise(resolve => ready = resolve);
    const request = http.request({ host: '127.0.0.1', port: address.port, path: route, method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-site-owner': 'alice', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), expect: '100-continue' } });
    const response = new Promise((resolve, reject) => {
      request.on('response', res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) })); });
      request.on('error', reject);
    });
    request.once('continue', () => { request.write(body.slice(0, 1)); ready(); }); request.flushHeaders();
    try {
      await waiting; stopping = bridge.close(); request.end(body.slice(1));
      assert.equal((await response).status, 503); await stopping;
      assert.equal(adapter.calls.length, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs, []);
    } finally { request.destroy(); await (stopping || bridge.close()); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});


test('continuations require the current owner and latest terminal parent and never silently start a new session', async t => {
  const { request, adapter } = await fixture(t);
  assert.equal((await request('GET', '/v1/health')).body.continuationAvailable, true);
  await post(request);
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.continuationAvailable, false);
  assert.equal((await post(request, 'job-2', 'conversation-1', 'followup', 'job-1')).status, 409);
  adapter.pending.get(adapter.calls[0].sessionId)({status:'completed',output:'first'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.continuationAvailable, true);
  assert.equal((await post(request, 'job-2')).status, 409);
  assert.equal((await request('POST', '/v1/jobs', 'bob', {id:'bob-2',conversationId:'conversation-1',prompt:'steal',parentTaskId:'job-1'})).status, 404);
  assert.equal((await post(request, 'bad-conversation', 'other', 'steal', 'job-1')).status, 404);
  const next=await post(request, 'job-2', 'conversation-1', 'followup', 'job-1');
  assert.equal(next.status, 202);assert.equal(next.body.parentTaskId, 'job-1');
  assert.equal(adapter.calls[1].sessionId, adapter.calls[0].sessionId);
  assert.equal(adapter.calls[1].continuation, true);assert.equal(adapter.calls[1].taskId, 'job-2');
  assert.equal((await post(request, 'job-2', 'conversation-1', 'followup', 'job-1')).status, 200);
  assert.equal((await post(request, 'job-2', 'conversation-1', 'followup', 'different-parent')).status, 409);
  adapter.pending.get(adapter.calls[1].sessionId)({status:'completed',output:'second'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.continuationAvailable, false);
  assert.equal((await post(request, 'fork', 'conversation-1', 'fork', 'job-1')).status, 409);
  adapter.canResume=()=>false;
  assert.equal((await post(request, 'job-3', 'conversation-1', 'more', 'job-2')).status, 410);
  assert.equal(adapter.calls.length, 2);
});

test('a completed conversation survives restart and resumes the same execution session', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-followup-restart-'));
  const adapter=controlledAdapter(), first=createBridge({stateDir:dir,token,adapter});
  const address=await first.listen(),headers={authorization:`Bearer ${token}`,'x-site-owner':'alice','content-type':'application/json'};
  await fetch(`http://127.0.0.1:${address.port}/v1/jobs`,{method:'POST',headers,body:JSON.stringify({id:'job-1',conversationId:'conversation-1',prompt:'first'})});
  const sessionId=adapter.calls[0].sessionId;
  adapter.pending.get(sessionId)({status:'completed',output:'first answer'});
  await new Promise(resolve=>setImmediate(resolve));await first.close();
  const next=await fixture(t,adapter,dir);
  assert.equal((await next.request('GET','/v1/jobs/job-1')).body.output,'first answer');
  assert.equal((await post(next.request,'job-2','conversation-1','continue','job-1')).status,202);
  assert.equal(adapter.calls[1].sessionId,sessionId);assert.equal(adapter.calls[1].continuation,true);
});

test('continued recovery uses the turn fingerprint and task-bound execution identity', async t => {
  const {request,adapter,dir}=await fixture(t);
  await post(request);adapter.pending.get(adapter.calls[0].sessionId)({status:'completed',output:'one'});
  await new Promise(resolve=>setImmediate(resolve));
  await post(request,'job-2','conversation-1','two','job-1');
  const second=adapter.calls[1];
  second.onProgress('second partial');
  let proof;
  adapter.recover=async input=>{proof=input;return {status:'failed',output:'second partial',stopped:true};};
  // Model a worker restart by seeding unknown and reopening, without replay.
  const state=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8'));
  const saved=state.jobs.find(job=>job.id==='job-2');
  assert.equal(saved.executionBound,true);assert.equal(saved.parentTaskId,'job-1');
  assert.equal(saved.fingerprint,digest(JSON.stringify([digest('alice'),'conversation-1','two','job-1'])));
  // The bridge timeout recovers the active turn using its own identity.
  await new Promise(resolve=>setTimeout(resolve,1050));
  assert.deepEqual(proof,{sessionId:second.sessionId,taskId:'job-2'});
  const identity={conversationId:'conversation-1',fingerprint:saved.fingerprint};
  assert.equal((await request('POST','/v1/jobs/job-2/recover','alice',identity)).body.status,'failed');
  assert.equal((await request('POST','/v1/jobs/job-2/recover','alice',recoveryBody('conversation-1','two'))).status,409);
  assert.equal(adapter.calls.length,2);
});

test('conversation history is pinned during a turn and all retained turns get a fresh retention window', async t => {
  let now=10000;const {request,adapter,dir}=await fixture(t,controlledAdapter(),undefined,{now:()=>now,retentionMs:1000});
  await post(request);adapter.pending.get(adapter.calls[0].sessionId)({status:'completed',output:'one'});await new Promise(resolve=>setImmediate(resolve));
  now+=900;await post(request,'job-2','conversation-1','two','job-1');
  now+=1500;
  assert.equal((await request('GET','/v1/jobs/job-1')).status,200);
  adapter.pending.get(adapter.calls[1].sessionId)({status:'completed',output:'two'});await new Promise(resolve=>setImmediate(resolve));
  const saved=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).jobs;
  assert.equal(saved[0].expiresAt,now+1000);assert.equal(saved[1].expiresAt,now+1000);
  now+=1001;assert.equal((await request('GET','/v1/jobs/job-1')).status,410);assert.equal((await request('GET','/v1/jobs/job-2')).status,410);
  assert.equal((await post(request,'job-3','conversation-1','three','job-2')).status,410);
});

test('twenty turns are admitted and a twenty-first cannot call the model', async t => {
  const adapter={supportsContinuation:true,canResume:()=>true,calls:[],async run(args){this.calls.push(args);return {status:'completed',output:'answer'};},async cancel(){}};
  const {request}=await fixture(t,adapter);
  for(let i=1;i<=20;i++){
    assert.equal((await post(request,'job-'+i,'conversation-1','turn '+i,i>1?'job-'+(i-1):undefined)).status,202);
    await new Promise(resolve=>setImmediate(resolve));
  }
  assert.equal((await request('GET','/v1/jobs/job-20')).body.continuationAvailable,false);
  assert.equal((await post(request,'job-21','conversation-1','excess','job-20')).status,409);
  assert.equal(adapter.calls.length,20);
});

test('session cleanup is deduplicated and blocks both continuation and conversation reuse while deleting history', async t => {
  const adapter=controlledAdapter();let finish,releaseCalls=0;
  adapter.release=()=>{releaseCalls++;return new Promise(resolve=>finish=resolve);};
  const {request}=await fixture(t,adapter);
  await post(request);adapter.pending.get(adapter.calls[0].sessionId)({status:'completed',output:'one'});await new Promise(resolve=>setImmediate(resolve));
  const removing=request('POST','/v1/jobs/job-1/release','alice',{});
  await waitFor(()=>releaseCalls===1);
  const again=request('POST','/v1/jobs/job-1/release','alice',{});
  assert.equal((await post(request,'job-2','conversation-1','continue','job-1')).status,409);
  assert.equal((await post(request,'job-2','conversation-1','reuse')).status,409);
  finish();assert.equal((await removing).status,200);assert.equal((await again).status,200);
  assert.equal(releaseCalls,1);assert.equal(adapter.calls.length,1);
});

test('partly cleared conversation history cannot be used for another turn',async t=>{
  const {request,adapter}=await fixture(t);
  await post(request);adapter.pending.get(adapter.calls[0].sessionId)({status:'completed',output:'first'});await new Promise(resolve=>setImmediate(resolve));
  await post(request,'job-2','conversation-1','second','job-1');adapter.pending.get(adapter.calls[1].sessionId)({status:'completed',output:'second'});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await request('POST','/v1/jobs/job-1/release','alice',{})).status,200);
  assert.equal((await request('GET','/v1/jobs/job-2')).body.continuationAvailable,false);
  assert.equal((await post(request,'job-3','conversation-1','third','job-2')).status,410);
  assert.equal(adapter.calls.length,2);
});

test('a missing-turn fence keeps its seven-day proof and blocks an older logical parent',async t=>{
  let now=10000;const {request,adapter,dir}=await fixture(t,controlledAdapter(),undefined,{now:()=>now,retentionMs:1000});
  await post(request);adapter.pending.get(adapter.calls[0].sessionId)({status:'completed',output:'first'});await new Promise(resolve=>setImmediate(resolve));
  const fingerprint=digest(JSON.stringify([digest('alice'),'conversation-1','never delivered','job-1']));
  const missing=await request('POST','/v1/jobs/job-2/recover','alice',{conversationId:'conversation-1',fingerprint});
  assert.equal(missing.body.recoveryReason,'not-accepted');
  const until=JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).jobs.find(j=>j.id==='job-2').expiresAt;
  assert.equal(until,now+7*86400000);
  assert.equal((await request('GET','/v1/jobs/job-1')).body.continuationAvailable,false);
  assert.equal((await post(request,'job-3','conversation-1','fork','job-1')).status,409);
  await request('POST','/v1/jobs/job-1/release','alice',{});
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).jobs.find(j=>j.id==='job-2').expiresAt,until);
});

test('model binding and per-turn accounting survive bridge restart without another execution or cumulative double count', async t => {
  const adapter = controlledAdapter(); adapter.supportsUsage = true; adapter.supportsModelSelection = true;
  const { request, dir } = await fixture(t, adapter);
  const modelSelection = { providerId: 'platform:relay', modelId: 'gpt-6.1-sol' };
  const body = { id: 'usage-job-1', conversationId: 'usage-conversation', prompt: 'first', modelSelection };
  assert.equal((await request('GET', '/v1/health')).body.usageAvailable, true);
  assert.equal((await request('POST', '/v1/jobs', 'alice', body)).status, 202);
  assert.deepEqual(adapter.calls[0].modelSelection, modelSelection);
  adapter.calls[0].onUsage({ calls: 1, complete: false });
  assert.deepEqual((await request('GET', '/v1/jobs/usage-job-1')).body.usage, { calls: 1, complete: false });
  const usage = { calls: 2, complete: true, inputTokens: 125, outputTokens: 25, cachedInputTokens: 30 };
  adapter.pending.get(adapter.calls[0].sessionId)({ status: 'completed', output: 'first result', usage });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual((await request('GET', '/v1/jobs/usage-job-1')).body.usage, usage);
  assert.equal((await request('POST', '/v1/jobs', 'alice', { ...body, modelSelection: { ...modelSelection, modelId: 'gpt-6-astra' } })).status, 409);
  const restartDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-usage-restart-'));
  fs.copyFileSync(path.join(dir, 'state.json'), path.join(restartDirectory, 'state.json'));
  const restarted = await fixture(t, adapter, restartDirectory);
  assert.deepEqual((await restarted.request('GET', '/v1/jobs/usage-job-1')).body.usage, usage);
  assert.equal(adapter.calls.length, 1);
  const next = { ...body, id: 'usage-job-2', parentTaskId: body.id, prompt: 'next' };
  assert.equal((await restarted.request('POST', '/v1/jobs', 'alice', { ...next, modelSelection: { ...modelSelection, providerId: 'platform:other' } })).status, 409);
  assert.equal((await restarted.request('POST', '/v1/jobs', 'alice', next)).status, 202);
  adapter.pending.get(adapter.calls[1].sessionId)({ status: 'completed', output: 'second result', usage: { calls: 1, complete: true, inputTokens: 10, outputTokens: 2 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await restarted.request('GET', '/v1/jobs/usage-job-2')).body.usage.inputTokens, 10);
  assert.equal((await restarted.request('GET', '/v1/jobs/usage-job-1')).body.usage.inputTokens, 125);
});

test('recovery republishes exactly the durable task usage while invalid accounting cannot unlock a task', async t => {
  const { dir, job } = interruptedState();
  const usage = { calls: 3, complete: true, inputTokens: 300, outputTokens: 30 };
  let inspections = 0;
  const adapter = { supportsUsage: true, async run() { throw Error('No replay'); }, async cancel() {}, async recover() { inspections++; return { stopped: true, status: 'completed', output: 'recovered', usage }; } };
  const { request } = await fixture(t, adapter, dir);
  assert.deepEqual((await request('GET', '/v1/jobs/job-1')).body.usage, usage);
  const recovered = await request('POST', '/v1/jobs/job-1/recover', 'alice', recoveryBody());
  assert.deepEqual(recovered.body.usage, usage); assert.equal(inspections, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).jobs[0].sessionId, job.sessionId);
  const invalid = interruptedState();
  const unverified = await fixture(t, { ...adapter, async recover() { return { status: 'completed', stopped: true, output: 'unsafe', usage: { calls: -1, complete: true } }; } }, invalid.dir);
  assert.equal((await unverified.request('GET', '/v1/jobs/job-1')).body.status, 'unknown');
});

test('reports six parallel slots and isolates identical conversation names across owners', async t => {
  const { adapter, request } = await fixture(t, controlledAdapter(), undefined, { maxConcurrent: 6 });
  const idle = (await request('GET', '/v1/health')).body;
  assert.equal(idle.maxConcurrent, 6); assert.equal(idle.activeJobs, 0);
  for (let index = 0; index < 6; index++) {
    assert.equal((await request('POST', '/v1/jobs', 'owner-' + index, { id: 'parallel-' + index, conversationId: 'same-conversation-name', prompt: 'private-' + index })).status, 202);
  }
  assert.equal(new Set(adapter.calls.map(call => call.sessionId)).size, 6);
  assert.equal((await request('GET', '/v1/health')).body.activeJobs, 6);
  assert.equal((await request('POST', '/v1/jobs', 'owner-7', { id: 'parallel-7', conversationId: 'extra-conversation', prompt: 'seventh' })).status, 429);
  for (let index = 0; index < 6; index++) {
    adapter.calls[index].onProgress('private-' + index);
    assert.equal((await request('GET', '/v1/jobs/parallel-' + index, 'owner-' + ((index + 1) % 6))).status, 404);
  }
  adapter.pending.get(adapter.calls[0].sessionId)({ status: 'completed', output: 'private-0' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request('GET', '/v1/health')).body.activeJobs, 5);
  assert.equal((await request('POST', '/v1/jobs', 'owner-7', { id: 'parallel-7', conversationId: 'extra-conversation', prompt: 'seventh' })).status, 202);
  for (let index = 1; index < 6; index++) {
    const task = (await request('GET', '/v1/jobs/parallel-' + index, 'owner-' + index)).body;
    assert.equal(task.output, 'private-' + index); assert.equal(task.status, 'running');
  }
});

test('health occupancy includes unverified executions after their local run promise disappears', async t => {
  const adapter = { async run() { throw Error('execution transport lost'); }, async cancel() {}, async recover() { return { status: 'unknown', output: '', stopped: false }; } };
  const { request } = await fixture(t, adapter, undefined, { maxConcurrent: 1 });
  assert.equal((await post(request)).status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request('GET', '/v1/jobs/job-1')).body.status, 'unknown');
  const health = (await request('GET', '/v1/health')).body;
  assert.equal(health.activeJobs, 1); assert.equal(health.maxConcurrent, 1);
  assert.equal((await request('POST', '/v1/jobs', 'other-owner', { id: 'extra', conversationId: 'extra', prompt: 'do not oversubscribe' })).status, 429);
});
