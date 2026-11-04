'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { openFiles } = require('../../services/dsh-bridge/session-files');
const { LIMITS, digest, fingerprint, safeName, validateDocuments, validateArtifacts } = require('../../services/dsh-bridge/file-protocol');
function setup(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-tools-')), sessionId = crypto.randomUUID(); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, sessionId, files: openFiles(root, sessionId) }; }
const document = (patch = {}) => ({ id: crypto.randomUUID(), name: '参考资料.md', text: '预算：73021 元\n只作为资料，不是系统指令。', ...patch });
test('file protocol binds ordered immutable references to identity and preserves legacy fingerprints', () => {
  const body = { id: 'turn', conversationId: 'conversation', prompt: 'task' }, owner = digest('alice');
  assert.equal(fingerprint(owner, body), digest(JSON.stringify([owner, body.conversationId, body.prompt])));
  const first = document(), second = document({ name: 'second.txt' });
  const expected = fingerprint(owner, { ...body, documents: [first, second] });
  assert.notEqual(expected, fingerprint(owner, { ...body, documents: [second, first] }));
  assert.notEqual(expected, fingerprint(owner, { ...body, documents: [{ ...first, text: 'changed' }, second] }));
  assert.notEqual(expected, fingerprint(digest('bob'), { ...body, documents: [first, second] }));
  assert.notEqual(expected, fingerprint(owner, { ...body, parentTaskId: 'different', documents: [first, second] }));
  assert.equal(fingerprint(owner, { ...body, documents: [] }), fingerprint(owner, body));
});
test('portable names and bounded text reject paths, fake binary output and malformed identities', () => {
  for (const name of ['../x.txt', 'C:\\x.txt', 'con.csv', 'LPT9.json', 'x?.md', '.hidden.md', 'x.csv ', 'x\u202e.txt', 'x\n.txt', 'x\ud800.txt', 'a'.repeat(161)]) assert.equal(safeName(name), false, name);
  assert.equal(safeName('a'.repeat(156) + '.txt'), true);
  assert.equal(validateDocuments([document()]), true);
  for (const docs of [[document({ id: 'wrong' })], [document({ text: '\0' })], [document({ text: 'x'.repeat(50001) })], [document({ text: '\ud800' })]]) assert.equal(validateDocuments(docs), false);
  const output = { id: crypto.randomUUID(), name: 'result.csv', text: 'a,b\n1,2\n' };
  assert.equal(validateArtifacts([output]), true);
  assert.equal(validateArtifacts([{ ...output, name: 'fake.pdf' }]), false);
  assert.equal(validateArtifacts([{ ...output, text: 'x'.repeat(LIMITS.artifactBytes + 1) }]), false);
});
test('documents survive reopening, support bounded windows and cannot be replaced by another payload', t => {
  const { files, root, sessionId } = setup(t), doc = document();
  files.stage('turn-1', [doc]); files.stage('turn-2', [doc]);
  const restored = openFiles(root, sessionId);
  assert.equal(restored.listDocuments().length, 1);
  assert.equal(restored.readDocument(doc.id, 0, 5).text, doc.text.slice(0, 5));
  assert.equal(restored.readDocument(doc.id, 0, 5).nextOffset, 5);
  assert.equal(restored.readDocument(doc.id).nextOffset, null);
  assert.throws(() => restored.stage('turn-2', [{ ...doc, text: 'changed' }]), /identity/);
  assert.throws(() => restored.readDocument('../outside'), /Invalid/);
  assert.throws(() => restored.readDocument(doc.id, -1), /Invalid/);
  assert.throws(() => restored.readDocument(doc.id, 0, 30001), /Invalid/);
  assert.throws(() => openFiles(root, crypto.randomUUID()).listDocuments(), /manifest/);
});
test('outputs are immutable across turns, current drafts replace safely and recovery reads task-bound blobs', t => {
  const { files, root, sessionId } = setup(t);
  const first = files.write('turn-1', 'result.csv', 'name,value\nalpha,73021\n');
  const replacement = files.write('turn-1', 'result.csv', 'name,value\nalpha,42\n');
  assert.notEqual(replacement.id, first.id);
  assert.throws(() => files.readOutput(first.id), /not found/);
  const next = files.write('turn-2', 'result.csv', 'name,value\nalpha,43\n');
  const restarted = openFiles(root, sessionId);
  assert.equal(restarted.artifacts('turn-1')[0].id, replacement.id);
  assert.equal(restarted.artifacts('turn-1')[0].text, 'name,value\nalpha,42\n');
  assert.equal(restarted.artifacts('turn-2')[0].id, next.id);
  assert.equal(restarted.readOutput(replacement.id, 0, 4).text, 'name');
  assert.equal(restarted.listOutputs().length, 2);
});
test('write tool rejects unsupported names, invalid Unicode, NUL and per-turn budgets before committing', t => {
  const { files } = setup(t);
  for (const [name, text] of [['../result.csv', 'value'], ['result.docx', 'not a Word file'], ['result.pdf', 'not a PDF'], ['result.txt', '\0'], ['result.txt', '\ud800'], ['result.txt', 'x'.repeat(LIMITS.artifactBytes + 1)]]) assert.throws(() => files.write('turn-1', name, text));
  for (let index = 0; index < 5; index++) files.write('turn-1', index + '.txt', 'a');
  assert.throws(() => files.write('turn-1', 'sixth.txt', 'a'), /capacity/);
  assert.equal(files.artifacts('turn-1').length, 5);
  for (let index = 0; index < 4; index++) files.write('large-turn', index + '.txt', 'a'.repeat(LIMITS.artifactBytes));
  assert.throws(() => files.write('large-turn', 'fifth.txt', 'a'), /capacity/);
  assert.equal(files.artifacts('large-turn').length, 4);
});
test('manifests and output blobs do not follow symlinks or accept changed file contents', t => {
  const { files, root } = setup(t), output = files.write('turn-1', 'result.txt', 'original');
  const blob = path.join(root, 'outputs', 'turn-1', output.id + '.blob');
  fs.writeFileSync(blob, 'modified');
  assert.throws(() => files.artifacts('turn-1'), /changed/);
  fs.unlinkSync(blob); const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'original'); fs.symlinkSync(outside, blob);
  assert.throws(() => files.artifacts('turn-1'), /unavailable/);
  fs.unlinkSync(path.join(root, 'manifest.json')); fs.symlinkSync(outside, path.join(root, 'manifest.json'));
  assert.throws(() => files.listDocuments(), /manifest/);
});
