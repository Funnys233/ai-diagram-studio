// 层级布局（ACCEPTANCE_REPORT.md 的 F 与 G）+ 不支持结构的明确拒绝
const test = require('node:test');
const assert = require('node:assert/strict');
const Xml = require('../../lib/xml.js');
const Model = require('../../lib/graphmodel.js');
const { mockGenerate } = require('../../lib/mock-engine.js');

const HEAD = '<mxGraphModel dx="900" dy="650" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">';
const V = (id, value, x, y, extra) => `<mxCell id="${id}" value="${value}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="${(extra && extra.parent) || '1'}"><mxGeometry x="${x}" y="${y}" width="${(extra && extra.w) || 160}" height="${(extra && extra.h) || 60}" as="geometry"/></mxCell>`;
const SWIM = (id, name, x, y, h) => `<mxCell id="${id}" value="${name}" style="swimlane;whiteSpace=wrap;html=1;startSize=28;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="640" height="${h}" as="geometry"/></mxCell>`;
const E = (id, s, t) => `<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const build = (cells) => `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;

/** 读取 id → {x,y,w,h,parent,value} 映射 */
function geometryMap(xml) {
  const parsed = Xml.parse(xml);
  const rootEls = Xml.childElements(parsed.root, 'root');
  const map = new Map();
  for (const { cell } of Model.collectCells(rootEls[0])) {
    if (!cell) continue;
    const g = Xml.firstChild(cell, 'mxGeometry');
    map.set(cell.attributes.id, {
      value: cell.attributes.value,
      parent: cell.attributes.parent,
      vertex: cell.attributes.vertex,
      edge: cell.attributes.edge,
      x: g && g.attributes.x !== undefined ? Number(g.attributes.x) : null,
      y: g && g.attributes.y !== undefined ? Number(g.attributes.y) : null,
      w: g && g.attributes.width !== undefined ? Number(g.attributes.width) : null,
      h: g && g.attributes.height !== undefined ? Number(g.attributes.height) : null,
    });
  }
  return map;
}

test('布局变换保留多行 / 制表符标签的解析值（F）', () => {
  const xml = build([`<mxCell id="2" value="第一行&#xa;第二行&#x9;末尾" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>`]);
  const before = geometryMap(xml).get('2').value;
  assert.equal(before, '第一行\n第二行\t末尾');
  const out = Model.applyLayout(xml, 'horizontal').xml;
  assert.equal(geometryMap(out).get('2').value, before, '布局后标签解析值必须完全相等');
});

test('布局变换保留扩展属性与 UserObject 包装', () => {
  const xml = build([
    '<UserObject label="带属性节点" myAttr="v1" id="2"><mxCell style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></UserObject>',
    V('3', '普通节点', 240, 40),
    E('4', '2', '3'),
  ]);
  const out = Model.applyLayout(xml, 'vertical').xml;
  assert.ok(out.includes('myAttr="v1"'), '扩展属性必须保留');
  assert.ok(out.includes('UserObject'), 'UserObject 包装必须保留');
  assert.ok(out.includes('label="带属性节点"'));
  assert.ok(Model.validateGraphModel(out).ok);
});

test('四层架构图（泳道容器）：子节点留在容器内、容器尺寸随子节点调整（G）', () => {
  const arch = mockGenerate('画一个电商系统的微服务架构图，分前端层、网关层、服务层和数据层', { modelXml: null }).xml;
  const before = geometryMap(arch);
  const out = Model.applyLayout(arch, 'horizontal').xml;
  const after = geometryMap(out);

  assert.ok(Model.validateGraphModel(out).ok, '布局结果必须仍然通过结构校验');
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), '所有单元格 id 必须保留');

  const children = [...after.entries()].filter(([, g]) => g.vertex === '1' && g.parent !== '1' && g.parent !== '0');
  assert.ok(children.length >= 8, `应当有子节点，实际 ${children.length}`);
  for (const [id, g] of children) {
    const parent = after.get(g.parent);
    assert.ok(parent, `子节点 ${id} 的父容器 ${g.parent} 必须存在`);
    assert.ok(g.x >= 0 && g.y >= 28, `子节点 ${id} 必须落在容器可视区（避开泳道标题）：x=${g.x} y=${g.y}`);
    assert.ok(g.x + g.w <= parent.w, `子节点 ${id} 超出容器右边界：${g.x}+${g.w} > ${parent.w}`);
    assert.ok(g.y + g.h <= parent.h, `子节点 ${id} 超出容器下边界：${g.y}+${g.h} > ${parent.h}`);
    assert.equal(g.value, before.get(id).value, `子节点 ${id} 的文字必须保留`);
  }
  // 容器被放大到足以容纳子节点
  for (const [id, g] of after.entries()) {
    if (g.vertex !== '1' || g.parent !== '1') continue;
    const kids = [...after.values()].filter((c) => c.parent === id);
    if (kids.length === 0) continue;
    const maxRight = Math.max(...kids.map((c) => c.x + c.w));
    const maxBottom = Math.max(...kids.map((c) => c.y + c.h));
    assert.ok(g.w >= maxRight, `容器 ${id} 宽度不足：${g.w} < ${maxRight}`);
    assert.ok(g.h >= maxBottom, `容器 ${id} 高度不足：${g.h} < ${maxBottom}`);
  }
  // 连线仍然引用原有节点
  assert.ok(out.includes('source="L0i0"') && out.includes('target="L1i0"'), '连线必须保留');
});

test('纵向布局同样保持子节点在容器内', () => {
  const arch = mockGenerate('画一个电商系统的微服务架构图，分前端层、网关层、服务层和数据层', { modelXml: null }).xml;
  const out = Model.applyLayout(arch, 'vertical').xml;
  const after = geometryMap(out);
  assert.ok(Model.validateGraphModel(out).ok);
  for (const [id, g] of after.entries()) {
    if (g.vertex !== '1' || g.parent === '1' || g.parent === '0') continue;
    const parent = after.get(g.parent);
    assert.ok(g.x >= 0 && g.y >= 28 && g.x + g.w <= parent.w && g.y + g.h <= parent.h,
      `子节点 ${id} 越出容器：(${g.x},${g.y},${g.w}x${g.h}) vs 容器 ${parent.w}x${parent.h}`);
  }
});

test('嵌套分组：子节点在各自父容器的坐标系内', () => {
  const xml = build([
    SWIM('L0', '外层泳道', 100, 60, 200),
    '<mxCell id="G1" value="分组" style="group;whiteSpace=wrap;html=1;" vertex="1" parent="L0"><mxGeometry x="40" y="40" width="200" height="100" as="geometry"/></mxCell>',
    V('g1', '组内 A', 10, 10, { parent: 'G1', w: 80, h: 40 }),
    V('g2', '组内 B', 10, 60, { parent: 'G1', w: 80, h: 40 }),
  ]);
  const out = Model.applyLayout(xml, 'horizontal').xml;
  const after = geometryMap(out);
  assert.ok(Model.validateGraphModel(out).ok);
  for (const id of ['g1', 'g2']) {
    const g = after.get(id);
    const group = after.get('G1');
    assert.ok(g.x >= 0 && g.y >= 0 && g.x + g.w <= group.w && g.y + g.h <= group.h,
      `${id} 应在分组内：(${g.x},${g.y},${g.w}x${g.h}) vs 分组 ${group.w}x${group.h}`);
  }
  const group = after.get('G1');
  const lane = after.get('L0');
  assert.ok(group.x >= 0 && group.y >= 28 && group.x + group.w <= lane.w && group.y + group.h <= lane.h,
    `分组应在外层泳道内：(${group.x},${group.y},${group.w}x${group.h}) vs ${lane.w}x${lane.h}`);
});

test('不支持的图形结构被明确拒绝（保留原图由调用方负责）', () => {
  // 挂在连线上的子单元格（draw.io 的连线标签结构）
  const edgeChild = build([
    V('2', 'A', 40, 40),
    V('3', 'B', 240, 40),
    E('4', '2', '3'),
    V('label1', '连线标签', 10, 10, { parent: '4', w: 60, h: 20 }),
  ]);
  assert.throws(() => Model.applyLayout(edgeChild, 'horizontal'),
    (e) => e instanceof Model.LayoutError && e.code === 'layout-edge-child');

  // 父子成环
  const cyclic = build([
    '<mxCell id="a" value="A" style="group;html=1;" vertex="1" parent="b"><mxGeometry x="10" y="10" width="100" height="80" as="geometry"/></mxCell>',
    '<mxCell id="b" value="B" style="group;html=1;" vertex="1" parent="a"><mxGeometry x="10" y="10" width="100" height="80" as="geometry"/></mxCell>',
  ]);
  assert.throws(() => Model.applyLayout(cyclic, 'horizontal'),
    (e) => e instanceof Model.LayoutError && e.code === 'layout-cycle');

  // 相对几何的顶点
  const relativeVertex = build([
    '<mxCell id="2" value="相对" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="0.5" y="0.5" width="120" height="60" relative="1" as="geometry"/></mxCell>',
  ]);
  assert.throws(() => Model.applyLayout(relativeVertex, 'horizontal'),
    (e) => e instanceof Model.LayoutError && e.code === 'layout-relative-vertex');
});

test('示例引擎遇到不支持的布局结构：返回 xml:null 并保留原图', () => {
  const edgeChild = build([
    V('2', 'A', 40, 40),
    V('3', 'B', 240, 40),
    E('4', '2', '3'),
    V('label1', '连线标签', 10, 10, { parent: '4', w: 60, h: 20 }),
  ]);
  const result = mockGenerate('改为横向布局', { modelXml: edgeChild });
  assert.equal(result.kind, 'unsupported');
  assert.equal(result.xml, null);
  assert.equal(result.preserved, true);
  assert.ok(result.reply.includes('已保留'));
});
