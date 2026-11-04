'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { AgentTasks } = require('../../lib/agent-tasks');
const { TaskError } = require('../../lib/conversation-tasks');
const { codec } = require('../../lib/cloud-runtime');
const job = () => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'private task prompt' });
function remote() {
  const records = new Map();
  return { configured: true, submits: 0, gets: 0, cancels: 0, records,
    async health() { return { status: 'ready', mode: 'adapter', version: 1, jobsAvailable: true }; },
    async submit(owner, body) { this.submits++; const record = { ...body, status: 'running', output: 'first partial', owner }; records.set(body.id, record); return record; },
    async get(owner, id) { this.gets++; const record = records.get(id); if (!record || record.owner !== owner) throw Error('missing'); return record; },
    async cancel(owner, id) { this.cancels++; const record = await this.get(owner, id); return { ...record, status: 'cancelling' }; },
    async release(owner, id) { const record = await this.get(owner, id); record.status = 'released'; record.output = ''; },
  };
}
async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-test-')), client = options.client || remote(), storage = codec(crypto.randomBytes(32));
  const manager = new AgentTasks({ directory, client, enabled: true, codec: storage, pollMs: 60000, ...options });
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, client, directory, storage };
}
const settle = async manager => { await Promise.all([...manager.operations.values()]); };
test('stable task identity, per-owner visibility, concurrency, and encrypted persistence', async t => {
  const { manager, client, directory, storage } = await setup(t); const body = job(); let held = 0;
  const acquire = () => { held++; return { release() { held--; } }; };
  assert.equal((await manager.create('alice', body, acquire)).created, true); await settle(manager);
  assert.equal(client.submits, 1); assert.equal(held, 1);
  assert.equal((await manager.create('alice', body, acquire)).created, false); assert.equal(client.submits, 1);
  await assert.rejects(manager.create('alice', { ...body, prompt: 'different' }), { status: 409 });
  await assert.rejects(manager.create('bob', body), { status: 409 });
  await assert.rejects(manager.create('alice', job()), { status: 429 });
  assert.throws(() => manager.get('bob', body.id), { status: 404 }); assert.deepEqual(manager.list('bob'), []);
  const disk = fs.readFileSync(path.join(directory, body.id + '.enc'), 'utf8'); assert.ok(!disk.includes(body.prompt)); assert.ok(!disk.includes('first partial')); assert.equal(storage.decode(disk).ownerId, 'alice');
  client.records.get(body.id).status = 'completed'; await manager.reconcile(manager.jobs.get(body.id)); assert.equal(held, 0);
  await manager.remove('alice', body.id); assert.throws(() => manager.get('alice', body.id), { status: 410 });
  const tombstone = storage.decode(fs.readFileSync(path.join(directory, body.id + '.enc'), 'utf8')); assert.equal(tombstone.output, ''); assert.equal(tombstone.prompt, '');
  await assert.rejects(manager.create('alice', body), { status: 410 }); assert.equal(client.submits, 1);
});
test('lost submit reply and app restart reconcile the original job without replay', async t => {
  const { manager, client, directory, storage } = await setup(t); const body = job(); const original = client.submit;
  client.submit = async function(owner, input) { await original.call(this, owner, input); throw Error('connection dropped after acceptance'); };
  await manager.create('alice', body); await settle(manager); assert.equal(manager.get('alice', body.id).status, 'unknown');
  await assert.rejects(manager.remove('alice', body.id), { status: 409 });
  await manager.close(); let held = 0;
  const resumed = new AgentTasks({ directory, client, enabled: true, codec: storage, pollMs: 60000, restoreLease() { held++; return { release() { held--; } }; } }); t.after(() => resumed.close());
  assert.equal(held, 1); assert.equal(resumed.get('alice', body.id).status, 'unknown');
  client.records.get(body.id).status = 'completed'; client.records.get(body.id).output = 'final persisted result';
  await resumed.reconcile(resumed.jobs.get(body.id)); assert.equal(resumed.get('alice', body.id).output, 'final persisted result'); assert.equal(resumed.get('alice', body.id).status, 'completed'); assert.equal(client.submits, 1); assert.equal(held, 0);
});
test('uncertain missing remote job stays unresolved and cannot silently start over', async t => {
  const { manager, client } = await setup(t); const body = job();
  client.submit = async function() { this.submits++; throw Error('timeout'); };
  await manager.create('alice', body); await settle(manager);
  await manager.reconcile(manager.jobs.get(body.id)); assert.equal(manager.get('alice', body.id).status, 'unknown');
  await manager.create('alice', body); assert.equal(client.submits, 1); await assert.rejects(manager.create('alice', job()), { status: 429 });
});
test('cancel is a request, and only confirmed cancellation becomes terminal', async t => {
  const { manager, client } = await setup(t); const body = job();
  await manager.create('alice', body); await settle(manager);
  assert.equal((await manager.cancel('alice', body.id)).status, 'cancelling');
  await assert.rejects(manager.remove('alice', body.id), { status: 409 });
  client.records.get(body.id).status = 'cancelled'; await manager.reconcile(manager.jobs.get(body.id));
  assert.equal(manager.get('alice', body.id).status, 'cancelled'); assert.equal(client.submits, 1);
});
test('readiness, strict fields, global capacity and explicit rejection', async t => {
  const { manager, client } = await setup(t);
  client.health = async () => ({ status: 'ready', version: 1, mode: 'diagnostic', jobsAvailable: false });
  assert.equal((await manager.status('alice')).available, false); await assert.rejects(manager.create('alice', job()), { status: 503 }); assert.equal(client.submits, 0);
  client.health = async () => ({ status: 'ready', version: 1, mode: 'adapter', jobsAvailable: true });
  await assert.rejects(manager.create('alice', { ...job(), ownerId: 'admin' }), { status: 400 });
  for (const key of ['id', 'conversationId', 'parentTaskId']) {
    const input = job(); input[key] = [crypto.randomUUID()]; await assert.rejects(manager.create('alice', input), { status: 400 });
  }
  await assert.rejects(manager.create('alice', { ...job(), attachmentIds: [[crypto.randomUUID()]] }), { status: 400 });
  await Promise.all(['alice', 'bob'].map(owner => manager.create(owner, job()))); await settle(manager);
  await assert.rejects(manager.create('charlie', job()), { status: 429 }); assert.equal(client.submits, 2);
  for (const record of client.records.values()) record.status = 'completed';
  for (const record of manager.jobs.values()) await manager.reconcile(record);
  client.submit = async () => { throw new TaskError(429, 'agent-upstream-429', 'busy'); };
  const rejected = job(); await manager.create('charlie', rejected); await settle(manager); assert.equal(manager.get('charlie', rejected.id).status, 'rejected');
});
test('confirmed interruption recovery preserves saved text and releases the task slot without replay', async t => {
  const { manager, client } = await setup(t); const body = job(); let held = 0, recovered = 0;
  await manager.create('alice', body, () => { held++; return { release() { held--; } }; }); await settle(manager);
  manager.update(manager.jobs.get(body.id), { status: 'unknown' });
  client.recover = async (owner, input) => { recovered++; assert.equal(owner, 'alice'); assert.equal(input.id, body.id); return { id: input.id, conversationId: input.conversationId, status: 'failed', output: '', recoveryReason: 'execution-recovered' }; };
  await assert.rejects(manager.recover('bob', body.id), { status: 404 });
  const [first, duplicate] = await Promise.all([manager.recover('alice', body.id), manager.recover('alice', body.id)]);
  assert.equal(first.status, 'failed'); assert.equal(duplicate.status, 'failed'); assert.equal(first.output, 'first partial'); assert.equal(held, 0); assert.equal(recovered, 1); assert.equal(client.submits, 1);
  assert.match(first.message, /解除占用/);
  await manager.create('alice', job()); await settle(manager); assert.equal(client.submits, 2);
});
test('recovering a completed receipt returns its result, and failed verification keeps the lease', async t => {
  const { manager, client } = await setup(t); const body = job(); let held = 0;
  await manager.create('alice', body, () => { held++; return { release() { held--; } }; }); await settle(manager);
  manager.update(manager.jobs.get(body.id), { status: 'unknown' });
  client.recover = async () => { throw Error('cannot verify process'); };
  assert.equal((await manager.recover('alice', body.id)).status, 'unknown'); assert.equal(held, 1);
  await assert.rejects(manager.create('alice', job()), { status: 429 });
  client.recover = async () => ({ id: body.id, conversationId: body.conversationId, status: 'completed', output: 'saved completed response', recoveryReason: 'execution-recovered' });
  const result = await manager.recover('alice', body.id);
  assert.equal(result.status, 'completed'); assert.equal(result.output, 'saved completed response'); assert.match(result.message, /恢复完成/); assert.equal(held, 0); assert.equal(client.submits, 1);
});
test('a missing remote task only releases after the bridge fences its late submission', async t => {
  const { manager, client } = await setup(t); const body = job(); let fenced = false, held = 0;
  client.submit = async function () { this.submits++; throw Error('lost request'); };
  client.get = async () => { throw new TaskError(404, 'agent-upstream-404', 'missing'); };
  client.recover = async (owner, input) => { assert.equal(owner, 'alice'); assert.equal(input.prompt, body.prompt); fenced = true; return { id: body.id, conversationId: body.conversationId, status: 'failed', output: '', recoveryReason: 'not-accepted' }; };
  await manager.create('alice', body, () => { held++; return { release() { held--; } }; }); await settle(manager);
  assert.equal(held, 1); await manager.reconcile(manager.jobs.get(body.id));
  assert.equal(fenced, true); assert.equal(manager.get('alice', body.id).status, 'failed'); assert.equal(held, 0); assert.equal(client.submits, 1);
});

function continuationRemote() {
  const client = remote();
  client.health = async () => ({ status: 'ready', mode: 'adapter', version: 1, jobsAvailable: true, continuationAvailable: true });
  const submit = client.submit;
  client.submit = async function (owner, body) { const value = await submit.call(this, owner, body); value.continuationAvailable = true; return value; };
  return client;
}
async function finish(manager, client, body) {
  await settle(manager); Object.assign(client.records.get(body.id), { status: 'completed', continuationAvailable: true });
  await manager.reconcile(manager.jobs.get(body.id));
}
const nextTurn = previous => ({ id: crypto.randomUUID(), conversationId: previous.conversationId, parentTaskId: previous.id, prompt: 'modify the previous result' });
test('follow-ups bind the latest owned turn and persist the full encrypted conversation across restart', async t => {
  const { manager, client, directory, storage } = await setup(t, { client: continuationRemote() });
  const first = job(); await manager.create('alice', first); await finish(manager, client, first);
  const next = nextTurn(first); await manager.create('alice', next); await finish(manager, client, next);
  assert.deepEqual(client.records.get(next.id).parentTaskId, first.id);
  assert.equal(client.records.get(next.id).prompt, next.prompt, 'browser never supplies or replays the history');
  assert.equal((await manager.create('alice', next)).created, false); assert.equal(client.submits, 2);
  await assert.rejects(manager.create('alice', { ...next, parentTaskId: crypto.randomUUID() }), { status: 409 });
  await assert.rejects(manager.create('alice', nextTurn(first)), { status: 409 });
  await assert.rejects(manager.create('alice', { ...job(), conversationId: first.conversationId }), { status: 409 });
  await assert.rejects(manager.create('bob', nextTurn(next)), { status: 404 });
  assert.throws(() => manager.conversation('bob', first.conversationId), { status: 404 });
  const conversation = manager.conversation('alice', first.conversationId);
  assert.equal(conversation.canContinue, true); assert.deepEqual(conversation.tasks.map(turn => turn.id), [first.id, next.id]);
  for (const body of [first, next]) assert.ok(!fs.readFileSync(path.join(directory, body.id + '.enc'), 'utf8').includes(body.prompt));
  await manager.close();
  const restarted = new AgentTasks({ directory, client, codec: storage, enabled: true, pollMs: 60000 }); t.after(() => restarted.close());
  assert.deepEqual(restarted.conversation('alice', first.conversationId).tasks.map(turn => turn.id), [first.id, next.id]);
  const third = nextTurn(next); await restarted.create('alice', third); await finish(restarted, client, third);
  assert.equal(client.submits, 3); assert.equal(restarted.conversation('alice', first.conversationId).tasks.length, 3);
});
test('active or unresolved turns block follow-up, and racing tabs cannot fork a conversation', async t => {
  const { manager, client } = await setup(t, { client: continuationRemote() }); const first = job();
  await manager.create('alice', first); await settle(manager);
  await assert.rejects(manager.create('alice', nextTurn(first)), { status: 409 });
  manager.update(manager.jobs.get(first.id), { status: 'unknown' });
  await assert.rejects(manager.create('alice', nextTurn(first)), { status: 409 });
  await finish(manager, client, first);
  const results = await Promise.allSettled([manager.create('alice', nextTurn(first)), manager.create('alice', nextTurn(first))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); await settle(manager);
  assert.equal(client.submits, 2); assert.equal(manager.conversation('alice', first.conversationId).canContinue, false);
});
test('retention pins the complete history while running and extends all turns together on completion', async t => {
  let now = 1000;
  const { manager, client } = await setup(t, { client: continuationRemote(), retentionMs: 1000, now: () => now });
  const first = job(); await manager.create('alice', first); await finish(manager, client, first);
  now = 1800; const next = nextTurn(first); await manager.create('alice', next); await settle(manager);
  now = 3500; manager.sweep(); assert.equal(manager.conversation('alice', first.conversationId).tasks.length, 2);
  await finish(manager, client, next);
  assert.equal(manager.jobs.get(first.id).expiresAt, 4500); assert.equal(manager.jobs.get(next.id).expiresAt, 4500);
  now = 4499; manager.sweep(); assert.equal(manager.list('alice').length, 2);
  now = 4501; manager.sweep(); assert.equal(manager.list('alice').length, 0);
  await assert.rejects(manager.create('alice', nextTurn(next)), { status: 404 }); assert.equal(client.submits, 2);
});
test('incomplete or removed history never silently starts a new session, and conversations stop at 20 turns', async t => {
  const { manager, client } = await setup(t, { client: continuationRemote() }); let previous = job();
  await manager.create('alice', previous); await finish(manager, client, previous);
  for (let index = 1; index < 20; index++) { previous = nextTurn(previous); await manager.create('alice', previous); await finish(manager, client, previous); }
  assert.equal(manager.conversation('alice', previous.conversationId).canContinue, false);
  await assert.rejects(manager.create('alice', nextTurn(previous)), { code: 'agent-turn-limit' }); assert.equal(client.submits, 20);
  const earliest = manager.turns('alice', previous.conversationId)[0]; manager.jobs.delete(earliest.id);
  assert.match(manager.conversation('alice', previous.conversationId).continuationBlockedReason, /上下文/);
  await assert.rejects(manager.create('alice', nextTurn(previous)), { status: 410 });
});
test('partial conversation cleanup is durable, blocks continuation and can safely be retried after restart', async t => {
  const { manager, client, directory, storage } = await setup(t, { client: continuationRemote() });
  const first = job(); await manager.create('alice', first); await finish(manager, client, first);
  const next = nextTurn(first); await manager.create('alice', next); await finish(manager, client, next);
  await assert.rejects(manager.remove('alice', first.id), { status: 409 });
  const release = client.release; let releases = 0;
  client.release = async function (owner, id) { if (++releases === 2) throw Error('release connection lost'); return release.call(this, owner, id); };
  await assert.rejects(manager.removeConversation('alice', first.conversationId), /connection lost/);
  assert.equal(manager.jobs.get(first.id).status, 'released'); assert.equal(manager.conversation('alice', first.conversationId).canContinue, false);
  await manager.close();
  const restarted = new AgentTasks({ directory, client, codec: storage, enabled: true, pollMs: 60000 }); t.after(() => restarted.close());
  await assert.rejects(restarted.create('alice', nextTurn(next)), { status: 410 });
  await restarted.removeConversation('alice', first.conversationId);
  assert.equal(restarted.list('alice').length, 0); assert.equal(client.submits, 2);
});
test('a completed legacy task can resume only after a read-only execution-server capability check', async t => {
  let now = 1000;
  const { manager, client } = await setup(t, { client: continuationRemote(), now: () => now }); const first = job();
  await manager.create('alice', first); await finish(manager, client, first);
  const saved = manager.jobs.get(first.id), expiresAt = saved.expiresAt; delete saved.continuationAvailable; manager.write(saved);
  assert.equal(manager.conversation('alice', first.conversationId).canContinue, false);
  now = 2000;
  assert.equal((await manager.readConversation('alice', first.conversationId)).canContinue, true);
  assert.equal(saved.expiresAt, expiresAt, 'reading old capability does not extend retention'); assert.equal(client.submits, 1);
  const next = nextTurn(first); await manager.create('alice', next); await finish(manager, client, next); assert.equal(client.submits, 2);
});
for (const event of ['cleanup', 'expiry']) test('legacy capability verification cannot resurrect a conversation after concurrent ' + event, async t => {
  let now = 1000;
  const { manager, client, directory } = await setup(t, { client: continuationRemote(), now: () => now, retentionMs: 1000 }); const first = job();
  await manager.create('alice', first); await finish(manager, client, first);
  const saved = manager.jobs.get(first.id); delete saved.continuationAvailable; manager.write(saved);
  const get = client.get; let unblock, held = false;
  const gate = new Promise(resolve => unblock = resolve);
  client.get = async function (owner, id) { if (!held) { held = true; await gate; } return get.call(this, owner, id); };
  const reading = manager.readConversation('alice', first.conversationId);
  assert.equal(held, true);
  if (event === 'cleanup') await manager.removeConversation('alice', first.conversationId);
  else { now = 2001; manager.sweep(); }
  unblock(); await assert.rejects(reading, { status: 404 });
  assert.equal(manager.list('alice').length, 0); assert.equal(client.submits, 1);
  if (event === 'expiry') assert.equal(fs.existsSync(path.join(directory, first.id + '.enc')), false);
});
