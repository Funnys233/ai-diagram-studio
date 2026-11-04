const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDocument } = require('../../lib/diagram-import');
const { sampleModel, buildMxfile, buildModel, cellVertex } = require('../helpers/fixtures');
const { compressDiagram } = require('../../lib/drawio-zlib');
const File = require('../../lib/drawio-format');

test('导入：压缩、明文与空白页全部校验和解压，页顺序、ID 与属性保留', () => {
  const payload = buildMxfile([
    { name: '压缩页', id: 'one', content: sampleModel(), compressed: true },
    { name: '明文页', id: 'two', content: sampleModel() },
    { name: '空白页', id: 'three', content: '' },
  ]).replace('host="DiagramAI"', 'host="DiagramAI" custom="keep"');
  const r = validateDocument(payload);
  assert.equal(r.ok, true);
  const info = File.parseFile(r.payload);
  assert.deepEqual(info.pages.map(p => [p.id, p.name, p.encoding]), [['one', '压缩页', 'xml'], ['two', '明文页', 'xml'], ['three', '空白页', 'xml']]);
  assert.ok(r.payload.includes('custom="keep"'));
});

test('导入：第二页非法也必须整份拒绝，不能只验第一页', () => {
  const bad = buildModel([cellVertex('broken', 'A & B')]);
  assert.equal(validateDocument(buildMxfile([
    { name: 'valid', id: 'one', content: sampleModel() },
    { name: 'bad', id: 'two', content: bad, compressed: true },
  ])).ok, false);
});

test('导入：拒绝重复页 ID、嵌套 mxfile、坏压缩数据、单页中多个模型', () => {
  for (const payload of [
    buildMxfile([{ name: 'one', id: 'same', content: sampleModel() }, { name: 'two', id: 'same', content: sampleModel() }]),
    '<mxfile><diagram id="a"><mxfile/></diagram></mxfile>',
    '<mxfile><diagram id="a">aGVsbG8=</diagram></mxfile>',
    '<mxfile><diagram id="a">' + sampleModel() + sampleModel() + '</diagram></mxfile>',
  ]) assert.equal(validateDocument(payload).ok, false);
});

test('导入：压缩炸弹和解压后超出文件上限明确拒绝', () => {
  const payload = `<mxfile><diagram id="a">${compressDiagram(' '.repeat(40000))}</diagram></mxfile>`;
  assert.equal(validateDocument(payload, { maxModelChars: 100 }).ok, false);
  const encoded = buildMxfile([{ name: 'a', id: 'a', content: sampleModel(), compressed: true }]);
  const r = validateDocument(encoded, { maxFileChars: encoded.length + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'file-too-large');
});
