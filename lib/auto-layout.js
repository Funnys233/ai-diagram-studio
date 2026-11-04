// 本地布局整理：按层级和流程关系排列，不调用模型。
const Xml = require('./xml');
const Model = require('./graphmodel');
const { separateOverlaps } = require('./layout-repair');

function organizeLayout(xml, options = {}) {
  const valid = Model.validateGraphModel(xml);
  if (!valid.ok) throw new Model.LayoutError(valid.error.code, valid.error.message);
  const root = Xml.parse(xml).root;
  const entries = Model.collectCells(Xml.firstChild(root, 'root'));
  const nodes = new Map();
  for (const { cell, wrapper } of entries) {
    const id = cell.attributes.id || wrapper?.attributes.id;
    nodes.set(id, { id, cell, g: Xml.firstChild(cell, 'mxGeometry'), children: [], parent: cell.attributes.parent });
  }
  const vertices = [...nodes.values()].filter(n => n.cell.attributes.vertex === '1');
  const edges = [...nodes.values()].filter(n => n.cell.attributes.edge === '1');
  for (const n of vertices) {
    if (n.g?.attributes.relative === '1' || nodes.get(n.parent)?.cell.attributes.edge === '1') {
      throw new Model.LayoutError('layout-unsupported', '当前图表包含相对定位节点或独立连线标签，已保留连线阶段结果，可手工整理');
    }
    let cursor = n;
    const seen = new Set();
    while (cursor) {
      if (seen.has(cursor.id)) throw new Model.LayoutError('layout-cycle', '节点分组存在循环，无法安全整理布局');
      seen.add(cursor.id);
      if (seen.size > 64) throw new Model.LayoutError('layout-too-deep', '节点分组层级过深，无法安全整理布局');
      cursor = nodes.get(cursor.parent);
    }
    nodes.get(n.parent)?.children.push(n);
  }
  const number = (n, key) => Number(n.g?.attributes[key] || 0);
  function bounds(n) {
    let x = number(n, 'x'), y = number(n, 'y'), p = nodes.get(n.parent);
    while (p) { x += number(p, 'x'); y += number(p, 'y'); p = nodes.get(p.parent); }
    return JSON.stringify([x, y, number(n, 'width'), number(n, 'height')]);
  }
  const originalBounds = new Map(vertices.map(n => [n.id, bounds(n)]));
  let moved = 0;
  function set(n, key, value) {
    value = Math.round(value);
    if (number(n, key) === value) return;
    if (!n.g.attributeOrder.includes(key)) n.g.attributeOrder.push(key);
    n.g.attributes[key] = String(value);
    moved++;
  }
  function ancestor(id, group) {
    let n = nodes.get(id);
    while (n) {
      if (group.has(n.id)) return n.id;
      n = nodes.get(n.parent);
    }
    return null;
  }
  const directions = new Set();
  function arrange(kids, parent) {
    kids = kids.filter(n => n.cell.attributes.visible !== '0');
    if (!kids.length) return;
    const range = axis => Math.max(...kids.map(n => number(n, axis))) - Math.min(...kids.map(n => number(n, axis)));
    const horizontal = range('x') >= range('y');
    directions.add(horizontal ? 'horizontal' : 'vertical');
    if (options.preserveLayout && !parent) {
      const boxes = kids.map(n => ({ id: n.id, x: number(n, 'x'), y: number(n, 'y'),
        width: number(n, 'width'), height: number(n, 'height') }));
      const adjusted = separateOverlaps(boxes, horizontal ? 'LR' : 'TB');
      for (const box of boxes) if (adjusted.has(box.id)) {
        set(nodes.get(box.id), 'x', box.x);
        set(nodes.get(box.id), 'y', box.y);
      }
      return;
    }
    const style = parent?.cell.attributes.style || '';
    const header = Number(/(?:^|;)startSize=([\d.]+)/.exec(style)?.[1] || (/swimlane/.test(style) ? 30 : 0));
    const leftHeader = /(?:^|;)horizontal=0(?:;|$)/.test(style);
    const padX = parent ? 24 + (leftHeader ? header : 0) : 60;
    const padY = parent ? 24 + (leftHeader ? 0 : header) : 60;
    // 正常框架保持原位；仅在重叠或节点侵入容器标题时重新排列。
    const ordered = [...kids].sort((a, b) => number(a, 'x') - number(b, 'x'));
    let overlaps = false;
    for (let i = 0; i < ordered.length && !overlaps; i++) {
      const a = ordered[i];
      for (let j = i + 1; j < ordered.length && number(ordered[j], 'x') < number(a, 'x') + number(a, 'width'); j++) {
        const b = ordered[j];
        if (number(a, 'y') < number(b, 'y') + number(b, 'height') && number(b, 'y') < number(a, 'y') + number(a, 'height')) { overlaps = true; break; }
      }
    }
    const inTitle = parent && kids.some(n => number(n, 'x') < (leftHeader ? header : 0) || number(n, 'y') < (leftHeader ? 0 : header));
    if (!overlaps && !inTitle) {
      if (parent) {
        set(parent, 'width', Math.max(number(parent, 'width'), ...kids.map(n => number(n, 'x') + number(n, 'width') + 24)));
        set(parent, 'height', Math.max(number(parent, 'height'), ...kids.map(n => number(n, 'y') + number(n, 'height') + 24)));
      }
      return;
    }
    const hasContainers = kids.some(n => n.children.length);
    const ids = new Set(kids.map(n => n.id));
    const links = new Map(kids.map(n => [n.id, new Set()]));
    const indegree = new Map(kids.map(n => [n.id, 0]));
    if (!hasContainers) for (const e of edges) {
      const s = ancestor(e.cell.attributes.source, ids), t = ancestor(e.cell.attributes.target, ids);
      if (s && t && s !== t && !links.get(s).has(t)) {
        links.get(s).add(t); indegree.set(t, indegree.get(t) + 1);
      }
    }
    const ranks = new Map(kids.map(n => [n.id, 0]));
    const queue = kids.filter(n => indegree.get(n.id) === 0).map(n => n.id);
    for (let i = 0; i < queue.length; i++) for (const t of links.get(queue[i])) {
      ranks.set(t, Math.max(ranks.get(t), ranks.get(queue[i]) + 1));
      indegree.set(t, indegree.get(t) - 1);
      if (indegree.get(t) === 0) queue.push(t);
    }
    // 分区保持原来的顺序；有反馈环的流程按原有主轴顺序整理。
    if (hasContainers || queue.length !== kids.length) {
      const main = horizontal ? 'x' : 'y';
      kids.sort((a, b) => number(a, main) - number(b, main));
      kids.forEach((n, i) => ranks.set(n.id, i));
    }
    const layers = new Map();
    for (const n of kids) {
      const rank = ranks.get(n.id);
      if (!layers.has(rank)) layers.set(rank, []);
      layers.get(rank).push(n);
    }
    let mainCursor = horizontal ? padX : padY;
    let right = 0, bottom = 0;
    for (const rank of [...layers.keys()].sort((a, b) => a - b)) {
      const layer = layers.get(rank);
      layer.sort((a, b) => number(a, horizontal ? 'y' : 'x') - number(b, horizontal ? 'y' : 'x'));
      const thickness = Math.max(...layer.map(n => number(n, horizontal ? 'width' : 'height')));
      let crossCursor = horizontal ? padY : padX;
      for (const n of layer) {
        const w = number(n, 'width'), h = number(n, 'height');
        set(n, 'x', horizontal ? mainCursor + (thickness - w) / 2 : crossCursor);
        set(n, 'y', horizontal ? crossCursor : mainCursor + (thickness - h) / 2);
        right = Math.max(right, number(n, 'x') + w);
        bottom = Math.max(bottom, number(n, 'y') + h);
        crossCursor += (horizontal ? h : w) + 40;
      }
      mainCursor += thickness + 80;
    }
    if (parent) {
      set(parent, 'width', Math.max(number(parent, 'width'), right + 24));
      set(parent, 'height', Math.max(number(parent, 'height'), bottom + 24));
    }
  }
  function walk(n) { n.children.forEach(walk); if (n.children.length) arrange(n.children, n); }
  const groups = new Map();
  for (const n of vertices) {
    if (nodes.get(n.parent)?.cell.attributes.vertex === '1') continue;
    walk(n);
    if (!groups.has(n.parent)) groups.set(n.parent, []);
    groups.get(n.parent).push(n);
  }
  for (const kids of groups.values()) arrange(kids, null);
  let routed = 0;
  for (const e of edges) {
    if (!nodes.get(e.cell.attributes.source) || !nodes.get(e.cell.attributes.target)) continue;
    const endpointMoved = ['source', 'target'].some(key => {
      const n = nodes.get(e.cell.attributes[key]);
      return originalBounds.get(n.id) !== bounds(n);
    });
    // 端点没有移动时，模型的出入口和绕行路径仍有效，不重置路由。
    if (!endpointMoved && /(?:^|;)edgeStyle=/.test(e.cell.attributes.style || '')) continue;
    // 仅替换路由方式；箭头、文字、端点引用与其余样式均保留。
    const style = e.cell.attributes.style || '';
    const parts = style.split(';').filter(p => p && !p.startsWith('edgeStyle=') && !p.startsWith('curved='));
    e.cell.attributes.style = [...parts, 'edgeStyle=orthogonalEdgeStyle', 'curved=0', ''].join(';');
    if (!e.cell.attributeOrder.includes('style')) e.cell.attributeOrder.push('style');
    if (e.g && endpointMoved) e.g.children = e.g.children.filter(c => !(c.name === 'Array' && c.attributes.as === 'points'));
    routed++;
  }
  const result = Model.serializeNode(root);
  const checked = Model.validateGraphModel(result);
  if (!checked.ok) throw new Model.LayoutError(checked.error.code, checked.error.message);
  return { xml: result, moved, routed, direction: directions.size === 1 ? [...directions][0] : 'mixed', stats: checked.stats };
}
module.exports = { organizeLayout };
