const test = require('node:test'), assert = require('node:assert/strict');
const Workflow = require('../../lib/requirements-workflow');
const Xml = require('../../lib/xml'), Model = require('../../lib/graphmodel'), File = require('../../lib/drawio-format');
function outline() {
  return { version: 1, title: '图书借阅', summary: '检索图书并办理借阅。',
    flowchart: { nodes: [{ id: 'start', label: '开始', type: 'start' }, { id: 'borrow', label: '办理借阅', type: 'process' }, { id: 'end', label: '结束', type: 'end' }], edges: [{ source: 'start', target: 'borrow', label: '' }, { source: 'borrow', target: 'end', label: '' }] },
    architecture: { layers: [{ id: 'client', label: '用户层', nodes: [{ id: 'reader', label: '读者端', description: '发起借阅' }] }, { id: 'business', label: '业务层', nodes: [{ id: 'library', label: '借阅服务', description: '校验借阅资格' }] }], edges: [{ source: 'reader', target: 'library', label: '借阅申请' }] }, assumptions: ['借阅期限待确认'] };
}
test('确认后的结构生成两个可编辑页面及安全SVG，节点关系计数和原文均保留', () => {
  const value = outline(), result = Workflow.generate(value, ['flowchart', 'architecture']);
  assert.deepEqual(result.outline, value); assert.equal(File.parseFile(result.payload).pageCount, 2);
  assert.deepEqual(result.diagrams.map(d => d.checks), [{ nodes: 3, edges: 2, issues: [] }, { nodes: 2, edges: 1, issues: [] }]);
  for (const diagram of result.diagrams) { assert.equal(Model.validateGraphModel(diagram.xml).ok, true); assert.equal(Xml.parse(diagram.svg).root.name, 'svg'); assert.match(diagram.svg, /width="\d+" height="\d+"/); assert.ok(!/<(?:script|foreignObject|image)\b/.test(diagram.svg)); }
  const single = Workflow.generate(value, ['architecture']); assert.equal(File.parseFile(single.payload).pageCount, 1);
  assert.equal(single.diagrams[0].type, 'architecture');
});
test('不完整JSON和非法模型结果明确失败，支持完整json代码块', () => {
  assert.deepEqual(Workflow.parseOutline('```json\n'+JSON.stringify(outline())+'\n```'), outline());
  for (const value of ['文字说明', '{"version":', JSON.stringify({ ...outline(), unexpected: true }), 'x'.repeat(50001)]) assert.throws(() => Workflow.parseOutline(value), e => e.code === 'invalid-requirements-result' && e.status === 502);
});
test('拒绝重复、悬空引用、过大结构和无出口流程，保留用户原始对象', () => {
  const patches = [
    o => o.flowchart.nodes[1].id = 'start',
    o => o.flowchart.edges[0].target = 'missing',
    o => o.flowchart.nodes[1].id = '0',
    o => o.flowchart.nodes[1].label = 'x'.repeat(161),
    o => o.flowchart.edges.pop(),
    o => o.flowchart.nodes[1].type = 'decision',
    o => o.architecture.layers[1].nodes[0].id = 'reader',
    o => o.architecture.edges[0].target = 'business',
    o => o.architecture.edges.push({ ...o.architecture.edges[0] }),
    o => o.architecture.layers[0].nodes = Array.from({ length: 31 }, (_, i) => ({ id: 'n_'+i, label: '节点', description: '' })),
    o => o.summary = '\u0000',
    o => o.architecture.layers[0].nodes[0].description = '\ud800',
  ];
  for (const patch of patches) { const value = outline(); patch(value); const before = JSON.stringify(value); assert.throws(() => Workflow.generate(value, ['flowchart']), e => e.code === 'invalid-requirements-outline'); assert.equal(JSON.stringify(value), before); }
  for (const types of [[], ['bogus'], ['flowchart', 'flowchart'], 'architecture']) assert.throws(() => Workflow.generate(outline(), types), /请选择/);
});
test('标签中的脚本与XML特殊字符只作为文字显示，不污染SVG或draw.io结构', () => {
  const value = outline(), label = '<script>alert("x")</script> & \'安全\'';
  value.title = label; value.flowchart.nodes[1].label = label; value.architecture.layers[0].nodes[0].label = label;
  const result = Workflow.generate(value, ['flowchart', 'architecture']);
  for (const diagram of result.diagrams) { assert.ok(!diagram.svg.includes('<script>')); assert.ok(diagram.svg.includes('&lt;script&gt;')); assert.equal(Model.validateGraphModel(diagram.xml).ok, true); }
  assert.equal(File.parseFile(result.payload).pageCount, 2);
});
test('未连接的架构模块报告待确认问题，不虚称需求完整或自动造连线', () => {
  const value = outline(); value.architecture.edges = [];
  const result = Workflow.generate(value, ['architecture']); assert.equal(result.diagrams[0].checks.edges, 0); assert.equal(result.checks.issues.length, 2); assert.match(result.checks.issues[0], /读者端/);
});
test('长标签扩展模块高度，预览文本不超过节点下边界，分层名不挤压模块', () => {
  const value = outline(); value.architecture.layers[0].nodes[0].label = '长'.repeat(120); value.architecture.layers[0].label = '层'.repeat(80);
  const diagram = Workflow.generate(value, ['architecture']).diagrams[0], parsed = Xml.parse(diagram.xml);
  const cells = Xml.childElements(Xml.firstChild(parsed.root, 'root'), 'mxCell');
  const moduleObject = Xml.childElements(Xml.firstChild(parsed.root, 'root'), 'UserObject').find(c => c.attributes.id === 'module_reader'), module = Xml.firstChild(moduleObject, 'mxCell'), layer = cells.find(c => c.attributes.id === 'layer_0');
  const mg = Xml.firstChild(module, 'mxGeometry').attributes, lg = Xml.firstChild(layer, 'mxGeometry').attributes;
  assert.ok(Number(mg.height) >= 190); assert.ok(Number(mg.y) >= Number(lg.y) + 100);
});

test('模块职责保存在可编辑UserObject，SVG悬停信息安全转义，跨层连线避开中间模块', () => {
  const value = outline();
  value.architecture.layers.push({ id: 'data', label: '数据层', nodes: [{ id: 'database', label: '借阅数据库', description: '保存记录' }] });
  value.architecture.layers[0].nodes[0].description = '<img src=x onerror=alert(1)> & 职责';
  value.architecture.edges.push({ source: 'reader', target: 'database', label: '跨层连接' });
  const diagram = Workflow.generate(value, ['architecture']).diagrams[0], parsed = Xml.parse(diagram.xml), root = Xml.firstChild(parsed.root, 'root');
  const node = Xml.childElements(root, 'UserObject').find(n => n.attributes.id === 'module_reader');
  assert.equal(node.attributes.description, value.architecture.layers[0].nodes[0].description);
  assert.ok(node.attributes.tooltip.includes('&lt;img'));
  assert.ok(diagram.svg.includes('<title>&lt;img')); assert.ok(!diagram.svg.includes('<img'));
  const edge = Xml.childElements(root, 'mxCell').find(n => n.attributes.id === 'arch_edge_1');
  assert.ok(Xml.childElements(Xml.firstChild(Xml.firstChild(edge, 'mxGeometry'), 'Array'), 'mxPoint').length >= 4);
  assert.ok(diagram.checks.issues.every(issue => !issue.includes('穿过其他节点')));
});
