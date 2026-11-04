const Xml = require('./xml');
const Model = require('./graphmodel');

function canonical(node) {
  return JSON.stringify({ name: node.name,
    attributes: Object.fromEntries(Object.entries(node.attributes).sort(([a], [b]) => a.localeCompare(b))),
    children: Xml.childElements(node).map(canonical), text: Xml.textOf(node).trim() });
}
function cells(xml) {
  return Model.collectCells(Xml.firstChild(Xml.parse(xml).root, 'root'));
}
function idOf({ cell, wrapper }) { return cell.attributes.id ?? wrapper?.attributes.id; }

// 连线阶段的模型输出是增量；框架始终从原 XML 取，模型无法替换节点。
function mergeConnections(output, previous) {
  const parsed = Xml.parse(output).root;
  if (parsed.name !== 'mxGraphModel' || Xml.childElements(parsed, 'root').length !== 1) {
    throw new Error('连线输出必须包含一个 mxGraphModel 和唯一 root');
  }
  const original = Xml.parse(previous).root;
  const root = Xml.firstChild(original, 'root');
  const baseEntries = Model.collectCells(root);
  const base = new Map(baseEntries.filter(e => e.cell.attributes.edge !== '1').map(e => [idOf(e), e]));
  const generated = Model.collectCells(Xml.firstChild(parsed, 'root'));
  if (generated.some(e => !e.cell)) throw new Error('连线输出包含不支持的单元格结构');
  const edges = generated.filter(e => e.cell.attributes.edge === '1');
  const ids = new Set(base.keys()), relations = new Set();
  for (const e of edges) {
    const a = e.cell.attributes, id = idOf(e);
    if (!id || ids.has(id)) throw new Error(`连线 ID 无效或与框架冲突：${id || '(空)'}`);
    ids.add(id);
    for (const endpoint of ['source', 'target']) {
      if (base.get(a[endpoint])?.cell.attributes.vertex !== '1') {
        throw new Error(`连线 ${id} 的 ${endpoint} 必须使用已给定框架的节点 ID：${a[endpoint] || '(空)'}`);
      }
    }
    if (!base.has(a.parent)) throw new Error(`连线 ${id} 的 parent 必须引用框架中已有图层或容器`);
    const label = e.wrapper?.attributes.label ?? a.value ?? '';
    const relation = JSON.stringify([a.source, a.target, label]);
    if (relations.has(relation)) throw new Error(`重复连线：${a.source} → ${a.target}（${label}）`);
    relations.add(relation);
  }
  // 兼容模型仍返回完整 XML 的情况：只提取边，所有模型输出的节点都忽略。
  // 按原文切片保留根、图层、节点、包装对象和元数据，不重新序列化框架。
  let inner = previous.slice(root.innerStart, root.innerEnd);
  const oldEdges = baseEntries.filter(e => e.cell.attributes.edge === '1').map(e => e.wrapper || e.cell);
  for (const n of oldEdges.sort((a, b) => b.start - a.start)) {
    inner = inner.slice(0, n.start - root.innerStart) + inner.slice(n.end - root.innerStart);
  }
  const additions = edges.map(e => { const n = e.wrapper || e.cell; return output.slice(n.start, n.end); }).join('\n');
  return previous.slice(0, root.innerStart) + inner + additions + previous.slice(root.innerEnd);
}
function validateStage(xml, stage, previous) {
  if (!stage) return null;
  const next = cells(xml);
  if (stage === 'framework') {
    if (next.some(({ cell }) => cell.attributes.edge === '1')) return '框架阶段只能输出分区和节点，不得添加连线';
    if (!next.some(({ cell }) => cell.attributes.vertex === '1')) return '框架必须包含节点';
    return null;
  }
  const base = new Map(cells(previous).filter(({ cell }) => cell.attributes.edge !== '1')
    .map(e => [idOf(e), canonical(e.wrapper || e.cell)]));
  const nodes = next.filter(({ cell }) => cell.attributes.edge !== '1');
  if (nodes.length !== base.size || nodes.some(e => base.get(idOf(e)) !== canonical(e.wrapper || e.cell))) {
    return '连线阶段必须原样保留全部已有节点（ID、文字、分区、样式和位置），只能添加或调整连线';
  }
  return null;
}
const prompts = {
  framework: '【阶段 1/3：生成框架】根据用户需求生成完整的分区、泳道、节点与文字，规划好位置和唯一 ID。此阶段禁止输出任何 edge="1" 连线。返回完整 mxGraphModel。',
  connections: '【阶段 2/3：仅生成连线增量】本阶段覆盖一般完整 XML 输出规则：当前 XML 是已确认框架，只以它的节点 ID、名称和位置为依据。输出 <mxGraphModel><root>...</root></mxGraphModel>，root 内只放 edge="1" 的 mxCell（包含 mxGeometry），不要输出根单元格、图层、节点或分区。输出当前图需要的全部连线，需要保留的已有连线也要输出。宿主程序会把这些边合并到原框架。source/target 必须是框架中已有 vertex 的 ID，parent 必须引用框架中的已有图层或容器；边 ID 不得与框架冲突。按用户业务关系连线，不按 XML 中节点排列顺序逐个串联，不添加没有依据的全连接或重复边。使用正交连线，根据节点位置选择出入口；分支标注是/否等，必要时添加绕开节点的路径点。',
};
module.exports = { validateStage, prompts, mergeConnections };
