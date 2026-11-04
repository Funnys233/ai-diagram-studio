'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { AgentTasks } = require('../../lib/agent-tasks');
const { TaskError } = require('../../lib/conversation-tasks');
const { codec } = require('../../lib/cloud-runtime');
const task = () => ({ id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'queue test, no model' });
const turnUsage = { calls: 1, complete: true, inputTokens: 100, outputTokens: 20 };
function client() {
  const records = new Map(), submitted = [];
  return { configured: true, records, submitted, capacity: undefined, externalActive: 0,
    async health() { return { version: 1, status: 'ready', mode: 'adapter', jobsAvailable: true, continuationAvailable: true, modelSelectionAvailable: true, filesAvailable: false, ...(this.capacity ? { maxConcurrent: this.capacity, activeJobs: this.externalActive + [...records.values()].filter(job => ['running', 'cancelling', 'unknown'].includes(job.status)).length } : {}) }; },
    async submit(owner, body) { submitted.push({ owner, ...body }); const record = { ...body, owner, status: 'running', output: 'partial', continuationAvailable: true }; records.set(body.id, record); return record; },
    async get(owner, id) { const record = records.get(id); if (!record || record.owner !== owner) throw new TaskError(404, 'agent-upstream-404', 'not found'); return record; },
    async cancel(owner, id) { const record = await this.get(owner, id); record.status = 'cancelled'; return record; },
    async recover(owner, body) { return this.get(owner, body.id); },
    async release(owner, id) { const record = await this.get(owner, id); record.status = 'released'; },
  };
}
async function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-queue-')), storage = codec(crypto.randomBytes(32)), remote = options.client || client(), reservations = [], settlements = [], held = new Map();
  const meter = { reserve(job) { reservations.push(job.id); }, settle(job) { settlements.push(job.id); return null; }, view() { return null; }, recover() {} };
  const acquireQueued = owner => { held.set(owner, (held.get(owner) || 0) + 1); let released = false; return { release() { if (!released) { released = true; held.set(owner, held.get(owner) - 1); } } }; };
  const config = { directory, codec: storage, client: remote, enabled: true, queueEnabled: true, maxConcurrent: 2, pollMs: 60000, meter, prepareQueued: async job => job.modelSelection ? { modelSelection: job.modelSelection, modelLock: null } : {}, acquireQueued, ...options };
  const manager = new AgentTasks(config);
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, remote, reservations, settlements, held, directory, storage, config, acquireQueued };
}
async function pump(manager) {
  for (let n = 0; n < 4; n++) { await manager.schedule(); await Promise.all([...manager.operations.values()]); }
}
async function finish(manager, remote, body, status = 'completed') {
  Object.assign(remote.records.get(body.id), { status, output: 'final:' + body.id, usage: turnUsage });
  await manager.reconcile(manager.jobs.get(body.id)); await pump(manager);
}
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('queue fixture timeout'); }
test('FIFO queue is durable, per-account and does not acquire or reserve until an execution slot opens', async t => {
  const { manager, remote, reservations, held } = await setup(t, { maxConcurrent: 1 });
  const first = task(), second = task(), third = task();
  await manager.create('alice', first); await pump(manager);
  assert.equal(manager.get('alice', first.id).status, 'running');
  const queued = await manager.create('bob', second); assert.equal(queued.task.status, 'queued'); assert.equal(queued.task.queuePosition, 1);
  await manager.create('carol', third); await pump(manager);
  assert.equal(manager.get('carol', third.id).queuePosition, 2);
  assert.deepEqual(remote.submitted.map(job => job.id), [first.id]); assert.deepEqual(reservations, [first.id]); assert.equal(held.get('bob'), undefined);
  assert.equal((await manager.create('bob', second)).created, false);
  await assert.rejects(manager.create('bob', task()), { status: 429 });
  assert.throws(() => manager.get('alice', second.id), { status: 404 });
  await finish(manager, remote, first);
  assert.deepEqual(remote.submitted.map(job => job.id), [first.id, second.id]);
  assert.equal(manager.get('carol', third.id).queuePosition, 1); assert.equal(held.get('alice'), 0); assert.equal(held.get('bob'), 1);
  await finish(manager, remote, second); assert.deepEqual(remote.submitted.map(job => job.id), [first.id, second.id, third.id]);
});
test('queued cancellation is local, invokes no model and removes queue-only records without remote release', async t => {
  const { manager, remote, reservations, held } = await setup(t, { maxConcurrent: 1 });
  const first = task(), queued = task(); await manager.create('alice', first); await pump(manager); await manager.create('bob', queued);
  const stopped = await manager.cancel('bob', queued.id);
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.usage.calls, 0);
  assert.deepEqual(reservations, [first.id]); assert.equal(held.get('bob'), undefined); assert.equal(remote.submitted.length, 1);
  await manager.remove('bob', queued.id); assert.throws(() => manager.get('bob', queued.id), { status: 410 });
});
test('cancellation during asynchronous authorization never races into a dispatch', async t => {
  let ready = false, unblock;
  const gate = new Promise(resolve => unblock = resolve);
  const { manager, remote, reservations, held } = await setup(t, { prepareQueued: async () => { ready = true; await gate; return {}; } });
  const body = task(); await manager.create('alice', body); await until(() => ready);
  await manager.cancel('alice', body.id); unblock(); await pump(manager);
  assert.equal(manager.get('alice', body.id).status, 'cancelled'); assert.equal(remote.submitted.length, 0); assert.equal(reservations.length, 0); assert.equal(held.size, 0);
});
test('restart preserves queued order and only restores leases for actual uncertain executions', async t => {
  const { manager, remote, config, directory } = await setup(t, { maxConcurrent: 1 });
  const first = task(), second = task(), third = task();
  await manager.create('alice', first); await pump(manager); await manager.create('bob', second); await manager.create('carol', third); await pump(manager); await manager.close();
  let restored = 0;
  const restarted = new AgentTasks({ ...config, directory, restoreLease() { restored++; return { release() { restored--; } }; } }); t.after(() => restarted.close());
  await pump(restarted);
  assert.equal(restored, 1); assert.equal(restarted.get('alice', first.id).status, 'unknown');
  assert.equal(restarted.get('bob', second.id).status, 'queued'); assert.equal(restarted.get('bob', second.id).queuePosition, 1);
  assert.equal(restarted.get('carol', third.id).queuePosition, 2); assert.equal(remote.submitted.length, 1);
  await finish(restarted, remote, first); assert.equal(restored, 0); assert.equal(remote.submitted.length, 2); assert.equal(remote.submitted[1].id, second.id);
});
test('unknown submit acceptance holds the slot and never resubmits while another account waits', async t => {
  const remote = client(), submit = remote.submit;
  let lose = true; remote.submit = async function(...args) { const value = await submit.apply(this, args); if (lose) { lose = false; throw Error('accepted response lost'); } return value; };
  const { manager } = await setup(t, { client: remote, maxConcurrent: 1 });
  const first = task(), second = task(); await manager.create('alice', first); await pump(manager); await manager.create('bob', second); await pump(manager);
  assert.equal(manager.get('alice', first.id).status, 'unknown'); assert.equal(remote.submitted.length, 1);
  await manager.create('alice', first); await pump(manager); assert.equal(remote.submitted.length, 1);
  Object.assign(remote.records.get(first.id), { status: 'failed' }); await manager.recover('alice', first.id); await pump(manager);
  assert.equal(remote.submitted.length, 2); assert.equal(remote.submitted[1].id, second.id);
});
test('dispatch rechecks membership and skips an account temporarily busy in ordinary chat', async t => {
  let busyAlice = true, denyBob = false;
  const { manager, remote, reservations, acquireQueued } = await setup(t, { maxConcurrent: 1,
    prepareQueued: async job => { if (job.ownerId === 'bob' && denyBob) throw new TaskError(403, 'membership-required', 'membership changed'); return {}; },
    acquireQueued(owner) { if (owner === 'alice' && busyAlice) throw new TaskError(429, 'concurrency-limit', 'ordinary chat active'); return { release() {} }; },
  });
  const first = task(), second = task(); await manager.create('alice', first); await pump(manager); await manager.create('bob', second); await pump(manager);
  assert.equal(manager.get('alice', first.id).status, 'queued'); assert.equal(manager.get('bob', second.id).status, 'running');
  assert.deepEqual(reservations, [second.id]);
  busyAlice = false; await finish(manager, remote, second); assert.equal(manager.get('alice', first.id).status, 'running');
  const blocked = task(); await manager.create('bob', blocked); denyBob = true; await finish(manager, remote, first);
  assert.equal(manager.get('bob', blocked.id).status, 'rejected'); assert.equal(remote.submitted.length, 2); assert.deepEqual(reservations, [second.id, first.id]);
});
test('queue cap and timeout reject only unstarted work without charging it', async t => {
  let now = 1000;
  const { manager, remote, reservations } = await setup(t, { maxConcurrent: 1, maxQueued: 2, maxQueueMs: 1000, now: () => now });
  const first = task(), second = task(), third = task();
  await manager.create('alice', first); await pump(manager); await manager.create('bob', second); await manager.create('carol', third);
  await assert.rejects(manager.create('dave', task()), { code: 'agent-queue-full' });
  now = 2001; manager.expireQueued(); await pump(manager);
  assert.equal(manager.get('bob', second.id).status, 'rejected'); assert.equal(manager.get('carol', third.id).status, 'rejected');
  assert.equal(manager.get('bob', second.id).usage.calls, 0); assert.equal(remote.submitted.length, 1); assert.deepEqual(reservations, [first.id]);
});
test('bridge capacity and independently unresolved bridge jobs reduce dispatch slots', async t => {
  const remote = client(); remote.capacity = 2; remote.externalActive = 1;
  const { manager } = await setup(t, { client: remote, maxConcurrent: 6 });
  const first = task(), second = task(); await manager.create('alice', first); await manager.create('bob', second); await pump(manager);
  assert.equal(remote.submitted.length, 1); assert.equal(manager.get('bob', second.id).status, 'queued');
  assert.equal((await manager.status('alice')).queue.maxConcurrent, 2);
  remote.externalActive = 0; await pump(manager); assert.equal(remote.submitted.length, 2);
});
test('queued documents are claimed and retained without charging or storing an upstream credential', async t => {
  let now = Date.now();
  const remote = client(), health = remote.health; remote.health = async function() { return { ...await health.call(this), filesAvailable: true }; };
  const { manager, storage, directory, reservations } = await setup(t, { client: remote, maxConcurrent: 1, now: () => now });
  const first = task(); await manager.create('alice', first); await pump(manager);
  const document = { id: crypto.randomUUID(), name: 'notes.txt', type: 'txt', text: '持久排队资料73021' };
  manager.files.addUpload('bob', document, Buffer.from(document.text));
  const queued = { ...task(), attachmentIds: [document.id] };
  await manager.create('bob', queued);
  assert.equal(manager.files.lookup('bob', document.id).conversationId, queued.conversationId);
  assert.throws(() => manager.files.removeUpload('bob', document.id), { status: 409 });
  now += 2 * 3600000 + 1; manager.sweep();
  assert.equal(manager.files.download('bob', document.id).bytes.toString(), document.text);
  assert.deepEqual(reservations, [first.id]); assert.equal(remote.submitted.length, 1);
  const stored = storage.decode(fs.readFileSync(path.join(directory, queued.id + '.enc'), 'utf8'));
  assert.equal(stored.modelLock, null); assert.equal(stored.dispatchState, 'prepared');
  await finish(manager, remote, first);
  assert.deepEqual(remote.submitted[1].documents, [{ id: document.id, name: document.name, text: document.text }]);
});
test('queued models are reauthorized at dispatch and only the selected IDs cross the bridge', async t => {
  const selection = { providerId: 'platform:relay', modelId: 'gpt-6.1-sol' };
  const metadata = { ...selection, name: 'Sol', source: 'platform', quotaPool: 'weekly', multiplier: 15 };
  const { manager, remote, storage, directory, reservations } = await setup(t, { maxConcurrent: 1,
    prepareQueued: async job => job.modelSelection ? { modelSelection: { ...metadata, name: 'Current Sol' }, modelLock: { apiKey: 'private-upstream-fixture', model: { modelId: selection.modelId } } } : {},
  });
  const first = task(); await manager.create('alice', first); await pump(manager);
  const queued = { ...task(), modelSelection: selection };
  await manager.create('bob', queued, undefined, { modelSelection: metadata, modelLock: { apiKey: 'must-not-persist-while-queued' } });
  const stored = storage.decode(fs.readFileSync(path.join(directory, queued.id + '.enc'), 'utf8'));
  assert.equal(stored.modelLock, null); assert.ok(!JSON.stringify(stored).includes('must-not-persist')); assert.deepEqual(reservations, [first.id]);
  await finish(manager, remote, first);
  assert.deepEqual(remote.submitted[1].modelSelection, selection); assert.ok(!JSON.stringify(remote.submitted[1]).includes('private-upstream-fixture'));
  assert.equal(manager.get('bob', queued.id).modelSelection.name, 'Current Sol'); assert.deepEqual(reservations, [first.id, queued.id]);
  await finish(manager, remote, queued); assert.equal(manager.jobs.get(queued.id).modelLock, null);
});
test('six execution slots drain a larger multi-owner queue without duplicate or cross-account execution', async t => {
  const { manager, remote } = await setup(t, { maxConcurrent: 6 }), inputs = Array.from({ length: 14 }, task);
  await Promise.all(inputs.map((body, index) => manager.create('user-' + index, body))); await pump(manager);
  assert.equal(remote.submitted.length, 6); assert.equal(manager.queued().length, 8);
  let peak = 0;
  while (manager.queued().length || [...manager.jobs.values()].some(job => ['running', 'unknown', 'submitting'].includes(job.status))) {
    const running = [...manager.jobs.values()].filter(job => job.status === 'running'); peak = Math.max(peak, running.length); assert.ok(running.length <= 6);
    for (const job of running) { Object.assign(remote.records.get(job.id), { status: 'completed', output: job.ownerId }); await manager.reconcile(job); }
    await pump(manager);
  }
  assert.equal(peak, 6); assert.equal(remote.submitted.length, inputs.length); assert.equal(new Set(remote.submitted.map(job => job.id)).size, inputs.length);
  for (let index = 0; index < inputs.length; index++) assert.equal(manager.get('user-' + index, inputs[index].id).output, 'user-' + index);
});
