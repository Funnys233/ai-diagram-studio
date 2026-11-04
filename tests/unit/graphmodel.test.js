// mxGraphModel 结构与几何校验
const test = require('node:test');
const assert = require('node:assert/strict');
const Model = require('../../lib/graphmodel.js');
const { buildModel, cellVertex, cellEdge, sampleModel } = require('../helpers/fixtures.js');

test('合法模型通过校验并统计节点 / 连线', () => {
  const result = Model.validateGraphModel(sampleModel());
  assert.equal(result.ok, true);
  assert.equal(result.stats.vertices, 3);
  assert.equal(result.stats.edges, 2);
});

test('拒绝重复 id', () => {
  const xml = buildModel([cellVertex('2', 'A'), cellVertex('2', 'B')]);
  const result = Model.validateGraphModel(xml);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'duplicate-id');
});

test('拒绝缺少 id 与缺少几何的节点', () => {
  const noId = buildModel(['    <mxCell value="x" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell>']);
  assert.equal(Model.validateGraphModel(noId).error.code, 'missing-id');

  const noGeometry = buildModel(['    <mxCell id="2" value="x" vertex="1" parent="1"/>']);
  assert.equal(Model.validateGraphModel(noGeometry).error.code, 'missing-geometry');
});

test('拒绝不存在的 parent / source / target 引用', () => {
  const badParent = buildModel([cellVertex('2', 'A', { parent: '404' })]);
  assert.equal(Model.validateGraphModel(badParent).error.code, 'invalid-parent-ref');

  const badEdge = buildModel([cellVertex('2', 'A'), cellEdge('3', '2', '404')]);
  assert.equal(Model.validateGraphModel(badEdge).error.code, 'invalid-edge-ref');
});

test('几何数据必须合法：宽高不为 0、数值不能是 NaN', () => {
  const zero = buildModel([cellVertex('2', 'A', { w: 0 })]);
  assert.equal(Model.validateGraphModel(zero).error.code, 'zero-size');

  const nan = buildModel([cellVertex('2', 'A', { w: 'abc' })]);
  assert.equal(Model.validateGraphModel(nan).error.code, 'bad-geometry');

  const missingSize = buildModel(['    <mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" as="geometry"/></mxCell>']);
  assert.equal(Model.validateGraphModel(missingSize).error.code, 'missing-size');
});

test('允许 swimlane 容器、子节点相对坐标与 group', () => {
  const xml = buildModel([
    cellVertex('L0', '前端层', { x: 100, y: 60, w: 640, h: 110, style: 'swimlane;whiteSpace=wrap;html=1;fontSize=13;verticalAlign=top;startSize=28;' }),
    cellVertex('L0i0', 'Web 应用', { x: 60, y: 45, w: 200, h: 44, parent: 'L0' }),
    cellVertex('L0i1', '移动端', { x: 360, y: 45, w: 200, h: 44, parent: 'L0', style: 'group;whiteSpace=wrap;html=1;' }),
  ]);
  const result = Model.validateGraphModel(xml);
  assert.equal(result.ok, true);
  assert.equal(result.stats.containers, 2);
});

test('允许 UserObject / object 包装的扩展属性单元格（id 在外层）', () => {
  const xml = buildModel([
    '    <UserObject label="带属性的节点" myAttr="v1" id="2"><mxCell style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></UserObject>',
    '    <object label="另一种包装" id="3"><mxCell style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="240" y="40" width="120" height="60" as="geometry"/></mxCell></object>',
    cellEdge('4', '2', '3'),
  ]);
  const result = Model.validateGraphModel(xml);
  assert.equal(result.ok, true);
  assert.equal(result.stats.vertices, 2);
  assert.equal(result.stats.edges, 1);
});

test('拒绝 <root> 下的非法元素与空包装', () => {
  const unknown = buildModel(['    <mxCellX id="2"/>']);
  assert.equal(Model.validateGraphModel(unknown).error.code, 'unexpected-cell');

  const emptyWrapper = buildModel(['    <UserObject label="x" id="2"/>']);
  assert.equal(Model.validateGraphModel(emptyWrapper).error.code, 'empty-wrapper');
});

test('允许悬空端点的连线（有 mxPoint）', () => {
  const xml = buildModel([
    cellVertex('2', 'A'),
    '    <mxCell id="3" style="edgeStyle=orthogonalEdgeStyle;html=1;" edge="1" parent="1"><mxGeometry relative="1" as="geometry"><mxPoint x="10" y="10" as="sourcePoint"/></mxGeometry></mxCell>',
  ]);
  const result = Model.validateGraphModel(xml);
  assert.equal(result.ok, true);
});

test('按 maxCells 拒绝超大图（不静默丢弃单元格）', () => {
  const cells = [];
  for (let i = 0; i < 20; i++) cells.push(cellVertex('n' + i, 'N' + i));
  const result = Model.validateGraphModel(buildModel(cells), { maxCells: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'too-many-cells');
});

test('applyLayout 只改坐标，保留全部 id 与手工节点', () => {
  const source = buildModel([
    cellVertex('2', '开始', { x: 340, y: 60 }),
    cellVertex('3', '处理', { x: 340, y: 170 }),
    cellVertex('keep-me', '手工加的节点', { x: 600, y: 170 }),
    cellEdge('5', '2', '3'),
  ]);
  const result = Model.applyLayout(source, 'horizontal');
  assert.equal(result.total, 3);
  assert.ok(result.xml.includes('keep-me'));
  assert.ok(result.xml.includes('value="手工加的节点"'));
  assert.ok(result.xml.includes('id="5"')); // 连线保留
  const check = Model.validateGraphModel(result.xml);
  assert.equal(check.ok, true);
  assert.equal(check.stats.vertices, 3);
  // 横向：y 一致、x 递增
  const ys = [...result.xml.matchAll(/<mxGeometry x="(\d+)" y="(\d+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.equal(new Set(ys.map((p) => p[1])).size, 1);
  assert.deepEqual(ys.map((p) => p[0]), [...ys.map((p) => p[0])].sort((a, b) => a - b));
});
