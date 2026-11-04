const test = require('node:test');
const assert = require('node:assert/strict');
const { validateStage, mergeConnections } = require('../../lib/staged-generation');
const Model = require('../../lib/graphmodel');
const { buildModel, cellVertex, cellEdge } = require('../helpers/fixtures');
const nodes = [cellVertex('a', '开始'), cellVertex('b', '结束', { y: 160 })];
const framework = buildModel(nodes);
const complete = buildModel([...nodes, cellEdge('e', 'a', 'b')]);
test('阶段校验拒绝框架连线，并确保连线阶段不改动任何节点', () => {
  assert.equal(validateStage(framework, 'framework'), null);
  assert.match(validateStage(complete, 'framework'), /不得添加连线/);
  assert.equal(validateStage(complete, 'connections', framework), null);
  assert.match(validateStage(complete.replace('value="开始"', 'value="改名"'), 'connections', framework), /原样保留/);
  assert.match(validateStage(buildModel([nodes[0]]), 'connections', framework), /原样保留/);
  assert.match(validateStage(buildModel([...nodes, cellVertex('extra', '新增')]), 'connections', framework), /原样保留/);
});
test('连线增量合并时保留原框架字节，兼容完整输出但忽略其中重建的节点', () => {
  const increment = `<mxGraphModel><root>${cellEdge('e', 'a', 'b')}</root></mxGraphModel>`;
  const merged = mergeConnections(increment, framework);
  assert.equal(validateStage(merged, 'connections', framework), null);
  assert.equal(Model.validateGraphModel(merged).ok, true);
  for (const node of nodes) assert.ok(merged.includes(node));
  const rebuilt = complete.replace('value="开始"', 'value="新的开始"').replace('width="160"', 'width="500"');
  assert.equal(mergeConnections(rebuilt, framework), merged);
  assert.equal((mergeConnections(increment, merged).match(/edge="1"/g) || []).length, 1);
});
test('连线不能引用重新生成的节点、根图层或重复关系', () => {
  for (const xml of [buildModel([cellEdge('e','new','b')]), buildModel([cellEdge('e','0','b')]),
    buildModel([cellEdge('a','a','b')]), buildModel([cellEdge('e','a','b'), cellEdge('e2','a','b')])]) {
    assert.throws(() => mergeConnections(xml, framework), /框架|冲突|重复/);
  }
});
