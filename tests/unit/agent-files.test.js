'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { AgentFiles } = require('../../lib/agent-files');
const { codec } = require('../../lib/cloud-runtime');
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-file-store-')), storage = codec(crypto.randomBytes(32));
  const files = new AgentFiles({ directory, codec: storage, ...options });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { files, directory, storage };
}
function upload(files, owner = 'alice', text = '中文资料73021', name = 'notes.txt') {
  const document = { id: crypto.randomUUID(), name, type: name.split('.').at(-1), size: Buffer.byteLength(text), text };
  return files.addUpload(owner, document, Buffer.from(text));
}
test('originals and extracted text stay encrypted, lazy-loaded and owner-bound through restart', t => {
  const { files, directory, storage } = setup(t), text = 'private Unicode资料73021', file = upload(files, 'alice', text);
  assert.equal(file.text, undefined); assert.equal(file.data, undefined);
  for (const name of fs.readdirSync(directory)) {
    const encrypted = fs.readFileSync(path.join(directory, name), 'utf8');
    assert.ok(!encrypted.includes(text)); assert.ok(!encrypted.includes('notes.txt'));
  }
  assert.throws(() => files.lookup('bob', file.id), { status: 404 });
  assert.throws(() => files.download('bob', file.id), { status: 404 });
  const restored = new AgentFiles({ directory, codec: storage });
  assert.equal(restored.records.get(file.id).text, undefined); assert.equal(restored.records.get(file.id).data, undefined);
  assert.equal(restored.download('alice', file.id).bytes.toString(), text);
  // Starting up reads only metadata, not encrypted original payloads.
  fs.writeFileSync(path.join(directory, file.id + '.data.enc'), 'corrupt payload');
  assert.doesNotThrow(() => new AgentFiles({ directory, codec: storage }));
  assert.throws(() => restored.download('alice', file.id));
});
test('attachment claims are conversation-bound, immutable and cannot be individually deleted after submission', t => {
  const { files } = setup(t), file = upload(files), conversationId = crypto.randomUUID(), taskId = crypto.randomUUID();
  files.claim('alice', [file.id], conversationId, taskId, Date.now() + 10000);
  assert.equal(files.prepare('alice', [file.id], conversationId)[0].text, '中文资料73021');
  assert.throws(() => files.prepare('alice', [file.id], crypto.randomUUID()), { status: 409 });
  assert.throws(() => files.prepare('alice', [file.id, file.id], conversationId), { status: 400 });
  assert.throws(() => files.removeUpload('alice', file.id), { status: 409 });
  assert.throws(() => files.download('alice', file.id, { taskId: crypto.randomUUID() }), { status: 404 });
  files.claim('alice', [file.id], conversationId, taskId, Date.now() + 10000);
  assert.equal(files.lookup('alice', file.id).taskIds.length, 1);
  files.releaseConversation('alice', conversationId); assert.throws(() => files.lookup('alice', file.id), { status: 404 });
});
test('generated files have stable task identities, bounded formats, and durable binary downloads', t => {
  const { files, directory, storage } = setup(t), conversationId = crypto.randomUUID(), taskId = crypto.randomUUID();
  const item = { id: crypto.randomUUID(), name: '图形.svg', text: '<svg xmlns="http://www.w3.org/2000/svg"><text>73021</text></svg>' };
  const metadata = files.saveArtifacts('alice', conversationId, taskId, [item], Date.now() + 1000);
  assert.equal(metadata[0].text, undefined); assert.equal(metadata[0].size, Buffer.byteLength(item.text));
  const restored = new AgentFiles({ directory, codec: storage });
  assert.equal(restored.download('alice', item.id, { taskId, kind: 'artifact' }).bytes.toString(), item.text);
  assert.deepEqual(files.saveArtifacts('alice', conversationId, taskId, [item], Date.now() + 1000), metadata);
  for (const patch of [{ text: 'changed' }, { name: 'changed.svg' }]) assert.throws(() => files.saveArtifacts('alice', conversationId, taskId, [{ ...item, ...patch }], Date.now()), { status: 502 });
  assert.throws(() => files.saveArtifacts('bob', conversationId, taskId, [item], Date.now()), { status: 502 });
  for (const name of ['../file.txt', 'file.pdf', 'file.docx', 'file.exe', 'CON.txt', 'bad\u202e.txt']) assert.throws(() => files.saveArtifacts('alice', conversationId, taskId, [{ ...item, id: crypto.randomUUID(), name }], Date.now()), { status: 502 });
  assert.throws(() => files.saveArtifacts('alice', conversationId, taskId, [{ ...item, id: crypto.randomUUID(), text: 'a'.repeat(256 * 1024 + 1) }], Date.now()), { status: 502 });
  assert.throws(() => restored.download('bob', item.id, { taskId, kind: 'artifact' }), { status: 404 });
});
test('active conversations pin files, retention renews them together and draft files expire separately', t => {
  let now = 1000; const { files } = setup(t, { now: () => now }), used = upload(files), draft = upload(files), conversationId = crypto.randomUUID();
  files.claim('alice', [used.id], conversationId, crypto.randomUUID(), 2000);
  now = 3000; files.sweep(new Set(['alice:' + conversationId])); assert.ok(files.lookup('alice', used.id));
  files.retain('alice', conversationId, 9000000); now = 8000000; files.sweep();
  assert.ok(files.lookup('alice', used.id)); assert.throws(() => files.lookup('alice', draft.id), { status: 404 });
  now = 9000001; files.sweep(); assert.throws(() => files.lookup('alice', used.id), { status: 404 });
});
test('quota leaves output headroom and terminal file identity conflicts do not overwrite existing content', t => {
  const { files } = setup(t);
  const bytes = Buffer.alloc(5 * 1024 * 1024, 65);
  for (let n = 0; n < 4; n++) files.addUpload('alice', { id: crypto.randomUUID(), name: 'large-' + n + '.txt', type: 'txt', text: 'extracted text' }, bytes);
  assert.throws(() => files.addUpload('alice', { id: crypto.randomUUID(), name: 'last.txt', type: 'txt', text: 'text' }, bytes), { code: 'agent-files-capacity' });
  assert.doesNotThrow(() => files.reserve('alice', 0));
});
