const test = require('node:test');
const assert = require('node:assert/strict');
const Xml = require('../../lib/xml');
const Model = require('../../lib/graphmodel');
const { organizeLayout } = require('../../lib/auto-layout');
const { buildModel, cellVertex: V, cellEdge: E } = require('../helpers/fixtures');
function map(xml) {
  return new Map(Model.collectCells(Xml.firstChild(Xml.parse(xml).root, 'root')).map(({cell}) => [cell.attributes.id, cell]));
}
function box(n) { const g = Xml.firstChild(n, 'mxGeometry').attributes; return Object.fromEntries(['x','y','width','height'].map(k => [k, Number(g[k] || 0)])); }
function overlap(a,b) { return a.x < b.x+b.width && b.x < a.x+a.width && a.y < b.y+b.height && b.y < a.y+a.height; }
test('布局按流程分层，分支无重叠，并保留所有节点和连线业务属性', () => {
  const xml = buildModel([V('end','结束'), V('a','开始'), V('b','通过'), V('c','拒绝'),
    E('e1','a','b','是'),E('e2','a','c','否'),E('e3','b','end'),E('e4','c','end')]);
  const out = organizeLayout(xml);
  const before = map(xml), after = map(out.xml);
  assert.deepEqual([...before.keys()], [...after.keys()]);
  for (const [id,n] of before) {
    for (const k of ['id','value','parent','source','target','vertex','edge']) assert.equal(after.get(id).attributes[k], n.attributes[k]);
  }
  const boxes = ['a','b','c','end'].map(id => box(after.get(id)));
  for (let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++) assert.equal(overlap(boxes[i],boxes[j]),false);
  assert.ok(box(after.get('a')).x < box(after.get('b')).x);
  assert.ok(box(after.get('b')).x < box(after.get('end')).x);
  assert.equal(box(after.get('b')).x, box(after.get('c')).x);
  assert.equal(Model.validateGraphModel(out.xml).ok, true);
});
test('嵌套容器扩展后容纳节点，保留泳道标题与父级', () => {
  const xml = buildModel([V('lane','部门',{w:100,h:60,style:'swimlane;startSize=30;'}),
    V('a','开始',{parent:'lane',x:0,y:0}), V('b','结束',{parent:'lane',x:0,y:0}),E('e','a','b')]);
  const after = map(organizeLayout(xml).xml), parent = box(after.get('lane'));
  for(const id of ['a','b']) {
    const b = box(after.get(id));
    assert.equal(after.get(id).attributes.parent,'lane');
    assert.ok(b.y >= 30 && b.x+b.width <= parent.width && b.y+b.height <= parent.height);
  }
});
test('连线移除失效路径点，保留箭头、分支文字、标签偏移和端点', () => {
  const edge = E('e','a','b','成功').replace('edgeStyle=orthogonalEdgeStyle;', 'edgeStyle=elbowEdgeStyle;endArrow=block;')
    .replace('<mxGeometry relative="1" as="geometry"/>','<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="999" y="888"/></Array><mxPoint x="4" y="5" as="offset"/></mxGeometry>');
  const out = organizeLayout(buildModel([V('a','开始'),V('b','结束'),edge]));
  const e = map(out.xml).get('e');
  assert.ok(e.attributes.style.includes('endArrow=block;'));
  assert.ok(e.attributes.style.includes('edgeStyle=orthogonalEdgeStyle;'));
  assert.equal(e.attributes.value,'成功');
  assert.equal(Xml.firstChild(Xml.firstChild(e,'mxGeometry'),'Array'),null);
  assert.equal(Xml.firstChild(Xml.firstChild(e,'mxGeometry'),'mxPoint').attributes.as,'offset');
});
test('流程反馈环可整理，相对节点明确拒绝', () => {
  const xml = buildModel([V('a','A'),V('b','B'),E('e1','a','b'),E('e2','b','a')]);
  assert.equal(Model.validateGraphModel(organizeLayout(xml).xml).ok,true);
  assert.throws(() => organizeLayout(xml.replace('<mxGeometry x=', '<mxGeometry relative="1" x=')), e => e.code === 'layout-unsupported');
});
test('正常框架不重排，连线保留有效路径点和出入口样式', () => {
  const edge = E('e','a','b','否').replace('edgeStyle=orthogonalEdgeStyle;', 'edgeStyle=elbowEdgeStyle;exitX=0;exitY=0.5;')
    .replace('<mxGeometry relative="1" as="geometry"/>','<mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="20" y="200"/></Array></mxGeometry>');
  const xml = buildModel([V('a','判断',{x:100,y:60}), V('b','返回',{x:100,y:300}),edge]);
  const before=map(xml), out=organizeLayout(xml), after=map(out.xml);
  assert.equal(out.moved,0);
  assert.equal(out.routed,0);
  for (const id of ['a','b']) assert.deepEqual(box(after.get(id)),box(before.get(id)));
  assert.equal(after.get('e').attributes.style,before.get('e').attributes.style);
  assert.ok(out.xml.includes('<mxPoint x="20" y="200"/>'));
});
test('保留设计模式只移动冲突节点，避开后续正常节点，尺寸和无关路线不变', () => {
  const xml=buildModel([V('a','A',{x:100,y:100}),V('b','B',{x:110,y:110}),
    V('c','C',{x:244,y:110}),V('d','D',{x:600,y:600}),E('safe','c','d')]);
  const before=map(xml),result=organizeLayout(xml,{preserveLayout:true}),after=map(result.xml);
  for(const id of ['a','c','d'])assert.deepEqual(box(after.get(id)),box(before.get(id)));
  assert.equal(box(after.get('b')).width,box(before.get('b')).width);
  assert.equal(box(after.get('b')).height,box(before.get('b')).height);
  assert.equal(overlap(box(after.get('a')),box(after.get('b'))),false);
  assert.equal(overlap(box(after.get('b')),box(after.get('c'))),false);
  assert.equal(after.get('safe').attributes.style,before.get('safe').attributes.style);
});
