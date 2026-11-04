'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { extractAgentFile, MAX_FILE_BYTES, MAX_TEXT_CHARS, typeForName, validName } = require('../../lib/agent-file-extraction');
const { extractDocument } = require('../../lib/document-extraction');
const { pdfFile, docxFile } = require('../helpers/document-fixtures.cjs');
const upload = (name, bytes) => ({ name, data: Buffer.from(bytes).toString('base64') });

test('agent documents and source files preserve original names, types and literal text without executing it', async () => {
  for (const name of ['中文计划.MD', 'budget.csv', 'notes.txt', 'data.json', 'app.js', 'app.ts', 'app.tsx', 'app.jsx', 'main.py', 'index.html', 'theme.css', 'figure.svg', 'diagram.drawio', 'config.yaml', 'config.yml', 'data.xml', 'query.sql', 'server.log', 'guide.markdown']) {
    const text = '中文资料\n<script>process.exit(99)</script>\nvalue = 73021';
    const result = await extractAgentFile(upload(name, text));
    assert.equal(result.name, name); assert.equal(result.type, typeForName(name)); assert.equal(result.text, text); assert.equal(result.size, Buffer.byteLength(text)); assert.match(result.id, /^[a-f0-9-]{36}$/);
  }
  const word = await extractAgentFile(upload('计划.docx', await docxFile('资料正文：73021')));
  assert.equal(word.type, 'docx'); assert.match(word.text, /73021/);
});
test('agent PDF text accepts every page through 50 and rejects 51 without changing ordinary-chat defaults', async () => {
  const accepted = await extractAgentFile(upload('fifty.pdf', pdfFile('Complete reference', { pages: 50 })));
  assert.equal(accepted.pages, 50); assert.match(accepted.text, /\[第 50 页\]/); assert.equal(accepted.pageImages, undefined);
  const longer = upload('fifty-one.pdf', pdfFile('Ordinary chat retains its existing page limit', { pages: 51 }));
  await assert.rejects(extractAgentFile(longer), error => error.status === 422 && /50 页/.test(error.message));
  assert.equal((await extractDocument(longer)).pages, 51);
});
test('invalid names, unsupported images, unexpected fields and noncanonical base64 fail before admission', async () => {
  assert.equal(validName('a'.repeat(156) + '.txt'), true);
  for (const name of ['../x.txt', 'a\\b.txt', 'new\nline.txt', 'fake\u202egpj.txt', 'hidden\u2066name.txt', 'control\u0085name.txt', 'a'.repeat(157) + '.txt', ' notes.txt', 'notes.txt ', 'notes.txt.', 'bad\ud800.txt', 'name?.txt', 'name:.txt', 'name".txt', 'NUL.txt', 'con.txt', 'COM1.txt', 'lpt9.txt']) {
    assert.equal(validName(name), false); await assert.rejects(extractAgentFile(upload(name, 'text')), { code: 'invalid-agent-file-name' });
  }
  for (const name of ['photo.png', 'photo.jpeg', 'scan.webp']) await assert.rejects(extractAgentFile(upload(name, 'text')), error => error.code === 'unsupported-agent-file' && /图片/.test(error.message));
  for (const name of ['legacy.doc', 'archive.zip', 'program.exe', 'noextension']) await assert.rejects(extractAgentFile(upload(name, 'text')), { code: 'unsupported-agent-file' });
  for (const body of [{ ...upload('notes.txt', 'text'), multimodal: true }, { ...upload('notes.txt', 'text'), ownerId: 'other' }, { name: 'notes.txt' }, [], null]) await assert.rejects(extractAgentFile(body), { code: 'invalid-agent-file' });
  for (const data of ['!!!!', 'dGV4dA', 'dGV4dB==', 'dGV4dA==\n', '']) await assert.rejects(extractAgentFile({ name: 'notes.txt', data }));
});
test('agent parser retains existing byte, text, binary, cancellation and unreadable-file bounds', async () => {
  await assert.rejects(extractAgentFile(upload('huge.txt', Buffer.alloc(MAX_FILE_BYTES + 1, 65))), /5 MB/);
  await assert.rejects(extractAgentFile(upload('long.json', 'x'.repeat(MAX_TEXT_CHARS + 1))), /5 万/);
  await assert.rejects(extractAgentFile(upload('binary.js', Buffer.from([0, 1, 2, 3]))), /不是可读取的文本/);
  await assert.rejects(extractAgentFile(upload('broken.pdf', 'not pdf')), /格式不正确/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractAgentFile(upload('cancelled.py', 'print(1)'), { signal: controller.signal }), { name: 'AbortError' });
});
test('scanned PDFs explain the text-only limitation instead of suggesting a missing multimodal switch', async () => {
  await assert.rejects(extractAgentFile(upload('scan.pdf', pdfFile('', { blank: true }))), error => error.status === 422 && error.code === 'agent-file-text-required' && /文字版文件/.test(error.message) && !/多模态|开启/.test(error.message));
});
