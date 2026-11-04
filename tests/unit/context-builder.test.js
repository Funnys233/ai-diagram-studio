// 上下文构造：核心是「绝不截断图表」，超限时必须明确拒绝
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildModelContext, composeUserMessage, buildPageDigest } = require('../../lib/context-builder.js');
const { bigModel, sampleModel } = require('../helpers/fixtures.js');

test('常规图表：上下文包含完整 XML，长度与输入一致', () => {
  const model = sampleModel();
  const context = buildModelContext(model, { maxChars: 200000 });
  assert.equal(context.ok, true);
  assert.equal(context.xml, model);
  assert.equal(context.size, model.length);
});

test('31k 字符的大图不会被截断（旧实现会 slice 掉根闭合标签）', () => {
  const model = bigModel(180);
  assert.ok(model.length > 30000, `期望大图 > 30k 字符，实际 ${model.length}`);
  const context = buildModelContext(model, { maxChars: 200000 });
  assert.equal(context.ok, true);
  assert.equal(context.xml.length, model.length);
  assert.ok(context.xml.endsWith('</mxGraphModel>'));
  assert.equal((context.xml.match(/vertex="1"/g) || []).length, 180);
  const message = composeUserMessage('把布局改一下', context);
  assert.ok(message.includes(model));
});

test('超过上限时明确拒绝，而不是截断', () => {
  const model = bigModel(180);
  const context = buildModelContext(model, { maxChars: 5000, pageIndex: 1, pageCount: 2 });
  assert.equal(context.ok, false);
  assert.equal(context.error.code, 'model-too-large');
  assert.equal(context.error.size, model.length);
  assert.equal(context.error.limit, 5000);
  assert.ok(context.error.message.includes('不会截断'));
});

test('多页时明确告知模型只能改当前页', () => {
  const context = buildModelContext(sampleModel(), { pageIndex: 2, pageCount: 4 });
  const message = composeUserMessage('改一下', context);
  assert.ok(message.includes('共 4 页'));
  assert.ok(message.includes('第 3 页'));
});

test('结构摘要包含节点 / 连线 / 几何信息', () => {
  const digest = buildPageDigest(sampleModel());
  assert.ok(digest.includes('节点 id=2'));
  assert.ok(digest.includes('label="开始"'));
  assert.ok(digest.includes('size=120x60'));
  assert.ok(digest.includes('连线 id=5 2 → 3'));
});
