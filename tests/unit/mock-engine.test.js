// 示例引擎：修改类指令必须基于当前图表执行，不支持的修改要保留原图
const test = require('node:test');
const assert = require('node:assert/strict');
const { mockGenerate } = require('../../lib/mock-engine.js');
const Model = require('../../lib/graphmodel.js');
const { modelWithManualNode, sampleModel } = require('../helpers/fixtures.js');

test('「改为横向布局」保留手工节点与全部 id（旧实现会整张重建）', () => {
  const current = modelWithManualNode();
  const result = mockGenerate('把当前图表整体改成从左到右布局', { modelXml: current });
  assert.equal(result.kind, 'edited');
  assert.ok(result.xml);
  assert.ok(result.xml.includes('keep-me'));
  assert.ok(result.xml.includes('value="手工加的节点"'));
  assert.ok(result.xml.includes('id="2"'));
  assert.ok(result.xml.includes('id="5"'));
  const check = Model.validateGraphModel(result.xml);
  assert.equal(check.ok, true);
  assert.equal(check.stats.vertices, 3);
});

test('「改为纵向布局」也基于当前图表', () => {
  const current = modelWithManualNode();
  const result = mockGenerate('改成从上到下排列', { modelXml: current });
  assert.equal(result.kind, 'edited');
  assert.ok(result.xml.includes('keep-me'));
});

test('不支持的修改：明确提示且不返回新图（原图保留）', () => {
  const result = mockGenerate('删掉开始节点并加一个超时分支', { modelXml: sampleModel() });
  assert.equal(result.kind, 'unsupported');
  assert.equal(result.xml, null);
  assert.equal(result.preserved, true);
  assert.ok(result.reply.includes('已保留'));
});

test('画布为空时的修改指令：提示先生成，不返回图', () => {
  const result = mockGenerate('改为横向布局', { modelXml: null });
  assert.equal(result.kind, 'empty-canvas');
  assert.equal(result.xml, null);
  assert.equal(result.preserved, true);
});

test('生成新图的请求仍然可用，且三类图都通过结构校验', () => {
  const cases = [
    ['画一个用户登录注册的流程图，包含验证码校验和失败重试', 'new'],
    ['画一个电商系统的微服务架构图，分前端层、网关层、服务层和数据层', 'new'],
    ['生成一个关于机器学习的思维导图，包含监督学习、无监督学习、强化学习三个分支', 'new'],
  ];
  for (const [message] of cases) {
    const result = mockGenerate(message, { modelXml: null });
    assert.equal(result.kind, 'new', message);
    const check = Model.validateGraphModel(result.xml);
    assert.equal(check.ok, true, `${message} → ${check.error && check.error.message}`);
    assert.ok(check.stats.vertices >= 3);
  }
});

test('已有图表时「画一个…」仍按新图处理（用户明确要新图）', () => {
  const result = mockGenerate('画一个订单处理流程图', { modelXml: sampleModel() });
  assert.equal(result.kind, 'new');
  assert.ok(result.xml);
});
