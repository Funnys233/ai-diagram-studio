'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { AgentTasks } = require('../../lib/agent-tasks'), { AgentHistory } = require('../../lib/agent-history'), { codec } = require('../../lib/cloud-runtime'), { TaskError } = require('../../lib/conversation-tasks');
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-')), storage = codec(crypto.randomBytes(32)), records = new Map();
  let now = Date.now(), submissions = 0;
  const client = { configured: true, async health() { return { version: 1, status: 'ready', mode: 'adapter', jobsAvailable: true, continuationAvailable: true, filesAvailable: true }; },
    async submit(owner, job) { submissions++; const value = { ...job, status: 'completed', output: '完整历史正文73021\n' + '历史内容'.repeat(10000), continuationAvailable: true, artifacts: [{ id: crypto.randomUUID(), name: 'result.csv', text: 'name,value\npine,73021\n' }] }; records.set(job.id, value); return value; },
    async get(owner, id) { const value = records.get(id); if (!value) throw new TaskError(410, 'agent-upstream-410', 'expired'); return value; },
    async release(owner, id) { records.delete(id); }, async cancel(owner, id) { return records.get(id); } };
  const options = { directory, client, codec: storage, enabled: true, historyEnabled: true, retentionMs: 30 * 86400000, pollMs: 60000, now: () => now };
  const manager = new AgentTasks(options); t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const create = async (owner = 'alice', patch = {}) => { const body = { id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: '测试历史', ...patch }; await manager.create(owner, body); await Promise.all([...manager.operations.values()]); return body; };
  return { manager, create, options, directory, storage, records, client, now: () => now, advance: value => now += value, submissions: () => submissions };
}
test('long history reads full encrypted results lazily, without keeping result bodies in the task index', async t => {
  const { manager, create, directory } = await setup(t), body = await create();
  assert.equal(manager.jobs.get(body.id).output, ''); assert.equal(manager.jobs.get(body.id).hasOutput, true);
  assert.match(manager.get('alice', body.id).output, /完整历史正文73021/);
  assert.ok(!fs.readFileSync(path.join(directory, body.id + '.enc'), 'utf8').includes('73021'));
  assert.equal(manager.list('alice')[0].output, undefined);
  const detail = await manager.readConversation('alice', body.conversationId); assert.equal(detail.title, '测试历史'); assert.equal(detail.canContinue, true);
});
test('pin and rename survive restart, retain files indefinitely, and unpin renews the normal 30-day window', async t => {
  const { manager, create, options, advance, now } = await setup(t), body = await create();
  const file = manager.get('alice', body.id).artifacts[0];
  const pinned = manager.patchConversation('alice', body.conversationId, { pinned: true, title: '我的长期计划' }); assert.equal(pinned.expiresAt, null);
  advance(60 * 86400000); manager.sweep(); assert.ok(manager.get('alice', body.id).output);
  await manager.close(); const restarted = new AgentTasks(options); t.after(() => restarted.close());
  const restored = restarted.conversation('alice', body.conversationId); assert.equal(restored.pinned, true); assert.equal(restored.title, '我的长期计划');
  assert.match(restarted.files.download('alice', file.id, { taskId: body.id, kind: 'artifact' }).bytes.toString(), /73021/);
  assert.equal(restarted.patchConversation('alice', body.conversationId, { pinned: false }).expiresAt, now() + 30 * 86400000);
  advance(30 * 86400000 + 1); restarted.sweep(); assert.throws(() => restarted.get('alice', body.id), { status: 404 }); assert.throws(() => restarted.files.lookup('alice', file.id), { status: 404 });
});
test('a crash after only the pin metadata commit cannot delete old turn or file payloads on restart', async t => {
  const { manager, create, options, advance } = await setup(t), body = await create();
  const file = manager.get('alice', body.id).artifacts[0];
  manager.history.patch('alice', body.conversationId, { pinned: true });
  advance(31 * 86400000); await manager.close();
  const restarted = new AgentTasks(options); t.after(() => restarted.close());
  assert.ok(restarted.get('alice', body.id).output); assert.equal(restarted.files.lookup('alice', file.id).expiresAt, null);
});
test('history search, pinned filters and cursor pagination stay owner-bound even with the same conversation UUID', async t => {
  const { manager, create, advance } = await setup(t);
  const first = await create(); manager.patchConversation('alice', first.conversationId, { title: '苹果计划', pinned: true }); advance(1);
  const second = await create('alice', { prompt: '香蕉计划' });
  await create('bob', { conversationId: first.conversationId, prompt: '他人的秘密' });
  const page = manager.historyList('alice', new URLSearchParams('limit=1')); assert.equal(page.conversations.length, 1); assert.ok(page.nextCursor);
  const next = manager.historyList('alice', new URLSearchParams({ limit: '1', cursor: page.nextCursor })); assert.equal(next.conversations.length, 1); assert.notEqual(page.conversations[0].conversationId, next.conversations[0].conversationId);
  assert.equal(manager.historyList('alice', new URLSearchParams('search=苹果&pinned=true')).conversations[0].title, '苹果计划');
  assert.equal(manager.historyList('alice', new URLSearchParams('search=秘密')).conversations.length, 0);
  assert.throws(() => manager.patchConversation('bob', second.conversationId, { pinned: true }), { status: 404 });
  assert.throws(() => manager.historyList('alice', new URLSearchParams('cursor=bad')), { status: 400 });
});
test('execution-context expiry only disables continuation; long history and generated downloads remain available', async t => {
  const { manager, create, records, advance, submissions } = await setup(t), body = await create(), file = manager.get('alice', body.id).artifacts[0];
  records.delete(body.id); advance(2 * 86400000);
  const conversation = await manager.readConversation('alice', body.conversationId);
  assert.equal(conversation.canContinue, false); assert.match(conversation.continuationBlockedReason, /上下文已过期/); assert.match(conversation.tasks[0].output, /73021/);
  assert.match(manager.files.download('alice', file.id, { taskId: body.id, kind: 'artifact' }).bytes.toString(), /73021/); assert.equal(submissions(), 1);
});
test('file library filters, paginates and clears with its archived conversation without leaking content or foreign rows', async t => {
  const { manager, create } = await setup(t), first = await create(), second = await create('bob');
  const library = manager.files.library('alice', new URLSearchParams('kind=artifact&search=result&limit=1'));
  assert.equal(library.files.length, 1); assert.equal(library.files[0].taskId, first.id); assert.equal(library.files[0].text, undefined); assert.ok(!JSON.stringify(library).includes(second.id));
  await manager.removeConversation('alice', first.conversationId);
  assert.equal(manager.files.library('alice', new URLSearchParams()).files.length, 0); assert.equal(manager.historyList('alice', new URLSearchParams()).conversations.length, 0);
  assert.ok(manager.get('bob', second.id).output);
});
test('metadata validates titles and preserves Unicode at the automatic title boundary', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'history-names-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const history = new AgentHistory({ directory }), conversationId = crypto.randomUUID();
  history.ensure({ ownerId: 'alice', conversationId, prompt: 'a'.repeat(79) + '😀', createdAt: Date.now(), updatedAt: Date.now() });
  assert.doesNotThrow(() => new AgentHistory({ directory }));
  for (const patch of [{ title: '' }, { title: 'x'.repeat(81) }, { title: 'x\u202e' }, { pinned: 'true' }, { ownerId: 'bob' }]) assert.throws(() => history.patch('alice', conversationId, patch), { status: 400 });
});
