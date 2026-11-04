// 普通流程图：一次规划节点与关系，程序生成三个阶段共用的 XML。
const Xml = require('./xml');
const Model = require('./graphmodel');
const { separateOverlaps } = require('./layout-repair');

class PlanError extends Error {
  constructor(message) { super(message); this.code = 'invalid-diagram-plan'; }
}
const TYPES = new Set(['start', 'process', 'decision', 'end']);
function fail(message) { throw new PlanError(message); }
function text(value, name, limit, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > limit) fail(`${name} 必须是${empty ? '' : '非空'}文本，最多 ${limit} 字符`);
  return value.trim();
}
function number(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} 必须是 ${min}–${max} 的有限数值`);
  return value;
}
function point(value, name, port = false) {
  if (!value || typeof value !== 'object') fail(`${name} 必须包含 x、y`);
  return { x: number(value.x, `${name}.x`, port ? 0 : -20000, port ? 1 : 20000),
    y: number(value.y, `${name}.y`, port ? 0 : -20000, port ? 1 : 20000) };
}
function style(value, edge = false) {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail('style 必须是样式对象');
  const out = {};
  const colors = new Set(edge ? ['strokeColor', 'fontColor', 'labelBackgroundColor'] : ['fillColor', 'strokeColor', 'fontColor']);
  for (const [key, v] of Object.entries(value)) {
    if (colors.has(key)) {
      if (typeof v !== 'string' || !/^(#[0-9a-f]{3}(?:[0-9a-f]{3})?|none)$/i.test(v)) fail(`${key} 必须是十六进制颜色或 none`);
      out[key] = v;
    } else if (['rounded', 'dashed'].includes(key)) {
      if (![true, false, 0, 1].includes(v)) fail(`${key} 必须是 true/false 或 0/1`);
      out[key] = Number(v);
    } else if (key === 'fontSize') out[key] = number(v, key, 8, 36);
    else if (key === 'strokeWidth') out[key] = number(v, key, 0.5, 6);
    else if (key === 'fontStyle') {
      out[key] = number(v, key, 0, 7);
      if (!Number.isInteger(v)) fail('fontStyle 必须为 0–7 的整数');
    }
    else if (key === 'opacity') out[key] = number(v, key, 20, 100);
    else if (key === 'align' && ['left', 'center', 'right'].includes(v)) out[key] = v;
    else if (key === 'verticalAlign' && ['top', 'middle', 'bottom'].includes(v)) out[key] = v;
    else if (key === 'fontFamily' && typeof v === 'string' && v.length > 0 && v.length <= 60 && !/[;=<>\r\n]/.test(v)) out[key] = v;
    else fail(`不支持的样式字段或值：${key}，请使用颜色、字号、字体、对齐、线宽、rounded 或 dashed 等支持字段`);
  }
  return out;
}
function validatePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('绘图方案必须是 JSON 对象');
  if (input.version !== 1 || input.type !== 'flowchart') fail('第一版只支持 version=1、type=flowchart 的普通流程图');
  if (!['TB', 'LR'].includes(input.direction)) fail('direction 必须为 TB（从上到下）或 LR（从左到右）');
  if (!Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 100) fail('流程图需要 2–100 个节点');
  if (!Array.isArray(input.edges) || input.edges.length < 1 || input.edges.length > 300) fail('流程图需要 1–300 条关系');
  if (input.groups?.length || input.nodes.some(n => n?.parent || n?.group)) fail('此模式暂不支持分区或泳道，请选择通用图表');
  const ids = new Set(['0', '1']);
  const nodes = input.nodes.map(n => {
    if (!n || typeof n !== 'object') fail('节点必须是对象');
    const id = text(n.id, '节点 ID', 80);
    if (ids.has(id)) fail(`节点 ID 重复或保留：${id}`);
    ids.add(id);
    if (!TYPES.has(n.type)) fail(`节点 ${id} 的 type 必须为 start/process/decision/end`);
    const node = { id, label: text(n.label, `节点 ${id} 名称`, 160), type: n.type };
    if (n.x !== undefined || n.y !== undefined) Object.assign(node, point(n, `节点 ${id} 位置`));
    if (n.width !== undefined) node.width = number(n.width, `节点 ${id} 宽度`, 32, 2000);
    if (n.height !== undefined) node.height = number(n.height, `节点 ${id} 高度`, 32, 2000);
    if (n.style != null) node.style = style(n.style);
    return node;
  });
  const byId = new Map(nodes.map(n => [n.id, n]));
  const seen = new Set();
  const edges = input.edges.map((e, i) => {
    if (!e || typeof e !== 'object') fail('关系必须是对象');
    if (!byId.has(e.source) || !byId.has(e.target)) fail(`第 ${i + 1} 条关系引用了不存在的节点`);
    if (e.source === e.target) fail(`节点 ${e.source} 不应连接自己，请使用明确的循环步骤`);
    const label = text(e.label ?? '', '关系标签', 120, true);
    const key = JSON.stringify([e.source, e.target, label]);
    if (seen.has(key)) fail(`重复关系：${e.source} → ${e.target}`);
    seen.add(key);
    let id = `plan_edge_${i + 1}`;
    while (ids.has(id)) id = '_' + id;
    ids.add(id);
    const edge = { id, source: e.source, target: e.target, label };
    if (e.points !== undefined) {
      if (!Array.isArray(e.points) || e.points.length > 20) fail('连线路径 points 最多 20 个坐标点');
      edge.points = e.points.map(p => point(p, '路径点'));
    }
    if (e.sourcePort !== undefined) edge.sourcePort = point(e.sourcePort, 'sourcePort', true);
    if (e.targetPort !== undefined) edge.targetPort = point(e.targetPort, 'targetPort', true);
    if (e.style != null) edge.style = style(e.style, true);
    if (e.routing !== undefined) {
      if (!['orthogonal', 'straight', 'curved'].includes(e.routing)) fail('routing 必须为 orthogonal/straight/curved');
      edge.routing = e.routing;
    }
    return edge;
  });
  const outgoing = new Map(nodes.map(n => [n.id, []])), incoming = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) { outgoing.get(e.source).push(e); incoming.get(e.target).push(e); }
  const starts = nodes.filter(n => n.type === 'start'), ends = nodes.filter(n => n.type === 'end');
  if (!starts.length || !ends.length) fail('流程图必须有开始和结束节点');
  for (const n of nodes) {
    const out = outgoing.get(n.id);
    if (n.type === 'start' && incoming.get(n.id).length) fail(`开始节点 ${n.id} 不应有入边`);
    if (n.type === 'end' && out.length) fail(`结束节点 ${n.id} 不应有出边`);
    if (n.type === 'decision') {
      if (out.length < 2) fail(`判断节点 ${n.id} 至少需要两个分支`);
      if (out.some(e => !e.label) || new Set(out.map(e => e.label)).size !== out.length) fail(`判断节点 ${n.id} 的分支条件必须非空且互不重复`);
    }
  }
  function reachable(seeds, links, nextKey) {
    const found = new Set(seeds.map(n => n.id)), queue = [...found];
    for (let i = 0; i < queue.length; i++) for (const e of links.get(queue[i])) {
      if (!found.has(e[nextKey])) { found.add(e[nextKey]); queue.push(e[nextKey]); }
    }
    return found;
  }
  const fromStart = reachable(starts, outgoing, 'target'), toEnd = reachable(ends, incoming, 'source');
  for (const n of nodes) {
    if (!fromStart.has(n.id)) fail(`节点 ${n.id} 无法从开始到达，可能遗漏关系`);
    if (!toEnd.has(n.id)) fail(`节点 ${n.id} 无法到达结束，可能遗漏出口或形成封闭循环`);
  }
  return { version: 1, type: 'flowchart', direction: input.direction,
    title: text(input.title ?? '流程图', '标题', 120), nodes, edges };
}

function parsePlan(content) {
  const fenced = String(content).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  let input;
  try { input = JSON.parse(fenced ? fenced[1] : content); }
  catch { fail('绘图方案不是完整 JSON，请只输出 JSON 对象，不输出 XML 或说明'); }
  return validatePlan(input);
}

function compilePlan(input) {
  const plan = validatePlan(input), horizontal = plan.direction === 'LR';
  const links = new Map(plan.nodes.map(n => [n.id, new Set()]));
  for (const e of plan.edges) links.get(e.source).add(e.target);
  // 标记 DFS 反馈边，主流程使用 DAG 分层；反馈关系保留并通过外侧通道绕行。
  const color = new Map(), feedback = new Set();
  function visit(id) {
    color.set(id, 1);
    for (const target of links.get(id)) {
      if (color.get(target) === 1) feedback.add(JSON.stringify([id, target]));
      else if (!color.has(target)) visit(target);
    }
    color.set(id, 2);
  }
  for (const n of plan.nodes.filter(n => n.type === 'start')) visit(n.id);
  const rank = new Map(plan.nodes.map(n => [n.id, 0])), indegree = new Map(plan.nodes.map(n => [n.id, 0]));
  for (const [s, targets] of links) for (const t of targets) if (!feedback.has(JSON.stringify([s, t]))) indegree.set(t, indegree.get(t) + 1);
  const queue = plan.nodes.filter(n => !indegree.get(n.id)).map(n => n.id);
  for (let i = 0; i < queue.length; i++) for (const t of links.get(queue[i])) {
    if (feedback.has(JSON.stringify([queue[i], t]))) continue;
    rank.set(t, Math.max(rank.get(t), rank.get(queue[i]) + 1));
    indegree.set(t, indegree.get(t) - 1);
    if (!indegree.get(t)) queue.push(t);
  }
  const sizes = new Map(plan.nodes.map(n => {
    const width = n.width ?? (n.type === 'decision' ? 200 : Math.min(240, Math.max(160, n.label.length * 12 + 40)));
    const fontSize = n.style?.fontSize ?? 13;
    const lineWidth = n.type === 'decision' ? width / 2 : width - 24;
    const lines = n.label.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length * fontSize / lineWidth)), 0);
    const height = n.height ?? Math.max(n.type === 'decision' ? 100 : n.type === 'start' || n.type === 'end' ? 48 : 68,
      lines * (fontSize + 7) + (n.type === 'decision' ? 48 : 24));
    return [n.id, { width, height }];
  }));
  const layers = new Map();
  for (const n of plan.nodes) { const r = rank.get(n.id); if (!layers.has(r)) layers.set(r, []); layers.get(r).push(n); }
  const span = layer => layer.reduce((sum, n) => sum + sizes.get(n.id)[horizontal ? 'height' : 'width'], 0) + (layer.length - 1) * 80;
  const maxSpan = Math.max(...[...layers.values()].map(span)), positions = new Map();
  let main = 60;
  for (const r of [...layers.keys()].sort((a, b) => a - b)) {
    const layer = layers.get(r), thickness = Math.max(...layer.map(n => sizes.get(n.id)[horizontal ? 'width' : 'height']));
    let cross = 60 + (maxSpan - span(layer)) / 2;
    for (const n of layer) {
      const size = sizes.get(n.id);
      positions.set(n.id, { ...size, x: horizontal ? main + (thickness - size.width) / 2 : cross,
        y: horizontal ? cross : main + (thickness - size.height) / 2 });
      cross += size[horizontal ? 'height' : 'width'] + 80;
    }
    main += thickness + 100;
  }
  const supplied = new Set(plan.nodes.filter(n => n.x !== undefined).map(n => n.id));
  for (const n of plan.nodes) if (supplied.has(n.id)) Object.assign(positions.get(n.id), { x: n.x, y: n.y });
  // 模型给定的位置优先固定；缺省节点使用旧布局兜底，碰撞仅移动发生冲突的节点。
  const boxes = [...plan.nodes].sort((a, b) => Number(supplied.has(b.id)) - Number(supplied.has(a.id)))
    .map(n => ({ id: n.id, ...positions.get(n.id) }));
  const adjusted = separateOverlaps(boxes, plan.direction);
  for (const box of boxes) { const { id, ...geometry } = box; positions.set(id, geometry); }
  // 保留原方案的缺省字段，后续本地编译才能得到相同布局和反馈路线。
  const styles = {
    start: 'rounded=1;arcSize=50;fillColor=#edf3ed;strokeColor=#6f816f;',
    end: 'rounded=1;arcSize=50;fillColor=#edf3ed;strokeColor=#6f816f;',
    process: 'rounded=1;arcSize=12;fillColor=#ffffff;strokeColor=#879087;',
    decision: 'rhombus;fillColor=#faf6e9;strokeColor=#a49469;',
  };
  const esc = Xml.escapeAttr;
  const styleText = (defaults, overrides) => {
    const parts = defaults.split(';').filter(Boolean);
    const fields = new Map(parts.filter(p => p.includes('=')).map(p => { const i=p.indexOf('='); return [p.slice(0,i), p.slice(i+1)]; }));
    for (const [k,v] of Object.entries(overrides || {})) fields.set(k,String(v));
    return parts.filter(p => !p.includes('=')).concat([...fields].map(([k,v])=>`${k}=${v}`)).join(';') + ';';
  };
  const vertices = plan.nodes.map(n => {
    const p = positions.get(n.id);
    const visual = styleText(styles[n.type] + 'whiteSpace=wrap;html=0;fontColor=#273128;fontSize=13;', n.style);
    return `<mxCell id="${esc(n.id)}" value="${esc(n.label)}" style="${esc(visual)}" vertex="1" parent="1"><mxGeometry x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" as="geometry"/></mxCell>`;
  }).join('');
  const outside = Math.max(...[...positions.values()].map(p => horizontal ? p.y + p.height : p.x + p.width)) + 60;
  const insideMin = Math.min(...[...positions.values()].map(p => horizontal ? p.y : p.x));
  const crossCenter = (insideMin + outside - 60) / 2;
  let channel = 0;
  const edgeXml = plan.edges.map(e => {
    const s = positions.get(e.source), t = positions.get(e.target);
    let ports = horizontal ? 'exitX=1;exitY=0.5;entryX=0;entryY=0.5;' : 'exitX=0.5;exitY=1;entryX=0.5;entryY=0;';
    let points = '';
    const backward = rank.get(e.target) <= rank.get(e.source);
    // 跨越中间层的边也绕到外侧，避免穿过中间节点。
    if (backward || rank.get(e.target) - rank.get(e.source) > 1) {
      const nearStart = (horizontal ? s.y+s.height/2 : s.x+s.width/2) < crossCenter;
      const lane = nearStart ? insideMin - 60 - channel++ * 28 : outside + channel++ * 28;
      // 先沿主轴进入层间空白，再横向进入外侧通道，不能从节点侧面穿过同层邻居。
      const layer = layers.get(rank.get(e.source));
      const clearance = Math.max(...layer.map(n => { const p=positions.get(n.id); return horizontal ? p.x+p.width : p.y+p.height; })) + 40;
      const approach = Math.min(...layers.get(rank.get(e.target)).map(n => { const p=positions.get(n.id); return horizontal ? p.x : p.y; })) - 40;
      points = horizontal
        ? `<Array as="points"><mxPoint x="${clearance}" y="${s.y+s.height/2}"/><mxPoint x="${clearance}" y="${lane}"/><mxPoint x="${approach}" y="${lane}"/><mxPoint x="${approach}" y="${t.y+t.height/2}"/></Array>`
        : `<Array as="points"><mxPoint x="${s.x+s.width/2}" y="${clearance}"/><mxPoint x="${lane}" y="${clearance}"/><mxPoint x="${lane}" y="${approach}"/><mxPoint x="${t.x+t.width/2}" y="${approach}"/></Array>`;
    } else if (plan.nodes.find(n => n.id === e.source).type === 'decision') {
      const delta = horizontal ? t.y+t.height/2-s.y-s.height/2 : t.x+t.width/2-s.x-s.width/2;
      if (Math.abs(delta) > 1) ports = horizontal ? `exitX=0.5;exitY=${delta > 0 ? 1 : 0};entryX=0;entryY=0.5;`
        : `exitX=${delta > 0 ? 1 : 0};exitY=0.5;entryX=0.5;entryY=0;`;
    }
    if (supplied.has(e.source) || supplied.has(e.target)) {
      const dx=t.x+t.width/2-s.x-s.width/2, dy=t.y+t.height/2-s.y-s.height/2;
      ports = Math.abs(dx) > Math.abs(dy) ? `exitX=${dx>=0?1:0};exitY=0.5;entryX=${dx>=0?0:1};entryY=0.5;`
        : `exitX=0.5;exitY=${dy>=0?1:0};entryX=0.5;entryY=${dy>=0?0:1};`;
      // 任意模型布局不能假定每层坐标相同，缺省交给编辑器按相对位置路由。
      points = '';
    }
    if (e.points !== undefined && !adjusted.has(e.source) && !adjusted.has(e.target)) {
      points = e.points.length ? '<Array as="points">' + e.points.map(p => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('') + '</Array>' : '';
    }
    const overrides = { ...e.style };
    if (e.sourcePort) { overrides.exitX=e.sourcePort.x; overrides.exitY=e.sourcePort.y; }
    if (e.targetPort) { overrides.entryX=e.targetPort.x; overrides.entryY=e.targetPort.y; }
    if (e.routing) {
      overrides.edgeStyle=e.routing==='straight'?'none':'orthogonalEdgeStyle';
      overrides.curved=e.routing==='curved'?1:0;
    }
    const visual = styleText('edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=0;endArrow=block;endFill=1;strokeColor=#788477;fontSize=12;labelBackgroundColor=#ffffff;' + ports, overrides);
    return `<mxCell id="${esc(e.id)}" value="${esc(e.label)}" style="${esc(visual)}" edge="1" parent="1" source="${esc(e.source)}" target="${esc(e.target)}"><mxGeometry relative="1" as="geometry">${points}</mxGeometry></mxCell>`;
  }).join('');
  const wrap = content => `<mxGraphModel grid="1" gridSize="10" guides="1" connect="1" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>${vertices}${content}</root></mxGraphModel>`;
  const framework = wrap(''), connected = wrap(edgeXml);
  const checked = Model.validateGraphModel(connected);
  if (!checked.ok || connected.length > 200000) fail(checked.error?.message || '生成图表过大，请拆分流程');
  return { plan, framework, connected, stats: checked.stats,
    layoutInfo: { source: supplied.size === plan.nodes.length ? 'model' : supplied.size ? 'mixed' : 'fallback', adjustedNodes: [...adjusted] } };
}

const PLAN_PROMPT = `你是业务流程与视觉设计师。根据用户需求一次确定全部节点、关系、位置、尺寸、样式和连线走向，不输出 XML。布局由你设计，程序保留你的安排，只检查引用和修复局部重叠。只输出一个完整 JSON 对象，基础格式为：
{"version":1,"type":"flowchart","title":"审批流程","direction":"TB","nodes":[{"id":"start","label":"开始","type":"start"},{"id":"check","label":"审批通过？","type":"decision"},{"id":"revise","label":"修改申请","type":"process"},{"id":"end","label":"结束","type":"end"}],"edges":[{"source":"start","target":"check","label":""},{"source":"check","target":"end","label":"是"},{"source":"check","target":"revise","label":"否"},{"source":"revise","target":"check","label":"重新提交"}]}
在上述每个节点中必须补充 x、y、width、height（数值，x/y 是左上角，不是中心）以及 style 对象。例如 {"id":"check","label":"审批通过？","type":"decision","x":300,"y":280,"width":200,"height":100,"style":{"fillColor":"#f6f0dd","strokeColor":"#a49469","fontColor":"#273128","fontSize":14}}。
视觉要求：根据业务含义安排主轴、分支、汇合与留白，节点不要重叠，使用协调的克制配色和清晰层级，文字放得下。默认 TB 或 LR，但以你提供的坐标为准。优先以 60–160 的间距保持连线清晰；修改已有图时，未涉及节点尽量保留原位置、尺寸和样式，只有用户明确要求重新布局时整体重排。
支持的节点样式字段：fillColor/strokeColor/fontColor（#RGB/#RRGGBB 或 none）、fontSize（8–36）、fontFamily、fontStyle（0–7）、strokeWidth（0.5–6）、rounded/dashed（布尔）、opacity（20–100）、align（left/center/right）、verticalAlign（top/middle/bottom）。style 必须是对象，不是 draw.io 样式字符串。
边可指定 sourcePort/targetPort（{"x":0到1,"y":0到1}，相对节点边界）和 points（画布绝对坐标数组，如 [{"x":700,"y":460},{"x":700,"y":330}]）。反馈线与跨层线请提供出入口及绕开节点的路径点；避免横穿同层邻居。routing 可为 orthogonal/straight/curved，默认 orthogonal。边 style 可包含 strokeColor/fontColor/labelBackgroundColor、fontSize/fontFamily/fontStyle、strokeWidth、rounded/dashed、opacity、align/verticalAlign。
结构要求：只支持普通流程图，无分区、泳道、架构层或任意形状。direction 为 TB 或 LR。节点 type 为 start/process/decision/end；ID 为唯一字符串，不用 0 或 1。至少有开始和结束，所有节点从开始可达且存在到结束的路径；允许有明确出口的反馈循环。判断节点至少两个分支，每个分支的条件必须非空且互不重复。忠实保留用户要求的步骤、条件、成功与失败路径，不擅自合并或遗漏分支，不按节点数组顺序猜连线。关系的 source/target 只引用 nodes 中的 ID；无需输出边 ID。最多 100 个节点和 300 条关系。只输出最终完整方案，不输出解释或分析。`;

module.exports = { PlanError, validatePlan, parsePlan, compilePlan, PLAN_PROMPT };
