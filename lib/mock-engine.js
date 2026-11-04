// 内置示例引擎（无 DEEPSEEK_API_KEY 时的兜底）
//
// 与旧实现的关键区别：旧实现只吃 message，因此「改为横向布局」这类
// 修改指令会把用户已有的图整张重建（手工加的节点直接消失）。
// 现在：
//   - 修改类指令一律基于【当前图表】执行，支持确定性布局变换（横向/纵向）
//   - 不支持的修改明确拒绝，并保留原图，绝不重建
//   - 只有明确要「生成新图」时才走示例模板
const Xml = require('./xml.js');
const Model = require('./graphmodel.js');

// 意图判定：
//   旧实现用「画|生成…」的单字匹配，导致「在当前画**布**增加一个审批节点」命中「画」
//   而被当作新建、整张重建。现在改为：
//     1) 提到「当前/现有/画布上」等 → 一定是修改
//     2) 出现修改动词（增加/删除/连线/改为/布局…）→ 一定是修改
//     3) 只有「创建动词 + 图表名词」同时出现，才认为是新建
const CREATE_VERB = /(画|绘制|生成|创建|新建|做|设计|来个|整一个|搞一个)/;
const DIAGRAM_NOUN = /(流程图|架构图|思维导图|脑图|时序图|状态图|用例图|类图|ER\s*图|组织结构图|甘特图|拓扑图|网络图|关系图|框图|示意图|图表|图形|图例|流程|图)/;
const EDIT_REFERENCE = /(当前|现有|已有|这张|这个图|此图|原图|画布上|画布中|画布里|图中的)/;
const EDIT_VERB = /(增加|添加|加上|新增|补上|加入|删除|删掉|移除|去掉|改为|改成|变成|调整|移动|挪|插入|添加连线|连接|连一|连线|替换|重命名|旋转|布局|排列|排布|对齐|整理|横排|竖排|横向|纵向|从左到右|从上到下|放大|缩小|合并|拆分|展开|收起|改)/;
const HORIZONTAL = /横向|从左到右|水平|左右/;
const VERTICAL = /纵向|从上到下|垂直|上下/;

/** 是否明确要求「新建一张图」 */
function wantsNewDiagram(text) {
  if (EDIT_REFERENCE.test(text)) return false;
  if (EDIT_VERB.test(text)) return false;
  const m = CREATE_VERB.exec(text);
  if (!m) return false;
  const rest = text.slice(m.index + m[0].length);
  return DIAGRAM_NOUN.test(rest);
}

const STYLES = {
  terminal: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;',
  process: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  decision: 'rhombus;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;',
  layer: 'swimlane;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;fontSize=13;verticalAlign=top;startSize=28;',
  layerItem: 'rounded=0;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  mindRoot: 'ellipse;whiteSpace=wrap;html=1;fillColor=#f8cecc;strokeColor=#b85450;fontSize=16;fontStyle=1',
  mindBranch: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;arcSize=30;',
};

const EDGE_STYLE = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;endArrow=block;endFill=1;';

function buildXml(nodes, edges) {
  const cells = nodes.map((n) => {
    const parent = n.parent || '1';
    return `    <mxCell id="${n.id}" value="${Xml.escapeAttr(n.label)}" style="${n.style}" vertex="1" parent="${parent}"><mxGeometry x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" as="geometry"/></mxCell>`;
  }).concat(edges.map((e) =>
    `    <mxCell id="${e.id}" value="${Xml.escapeAttr(e.label || '')}" style="${EDGE_STYLE}" edge="1" parent="1" source="${e.source}" target="${e.target}"><mxGeometry relative="1" as="geometry"/></mxCell>`
  ));
  return `<mxGraphModel dx="900" dy="650" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">\n  <root>\n    <mxCell id="0"/>\n    <mxCell id="1" parent="0"/>\n${cells.join('\n')}\n  </root>\n</mxGraphModel>`;
}

function sampleMindMap(text) {
  const m = text.match(/关于(.{2,12}?)的?思维导图/) || text.match(/思维导图[：:，, ]*(.{2,12})/);
  const root = (m && m[1]) || '主题';
  const branches = ['核心概念', '主要特点', '应用场景', '发展趋势'];
  const nodes = [{ id: 'c0', label: root, style: STYLES.mindRoot, x: 340, y: 260, w: 160, h: 80 }];
  const edges = [];
  const pos = [[120, 80], [540, 80], [120, 460], [540, 460]];
  branches.forEach((label, i) => {
    nodes.push({ id: 'b' + i, label, style: STYLES.mindBranch, x: pos[i][0], y: pos[i][1], w: 140, h: 48 });
    edges.push({ id: 'e' + i, source: 'c0', target: 'b' + i });
  });
  return { xml: buildXml(nodes, edges), reply: `已生成「${root}」思维导图示例：1 个中心节点 + ${branches.length} 个分支。` };
}

function sampleArchitecture() {
  const layers = [
    { name: '前端层', items: ['Web 应用', '移动端'] },
    { name: '接入层', items: ['API 网关', '负载均衡'] },
    { name: '服务层', items: ['业务服务', 'AI 服务'] },
    { name: '数据层', items: ['数据库', '缓存'] },
  ];
  const nodes = [];
  const edges = [];
  layers.forEach((layer, li) => {
    const y = 60 + li * 140;
    nodes.push({ id: 'L' + li, label: layer.name, style: STYLES.layer, x: 100, y, w: 640, h: 110 });
    layer.items.forEach((item, ii) => {
      nodes.push({
        id: `L${li}i${ii}`, label: item, style: STYLES.layerItem,
        x: 60 + ii * 300, y: 45, w: 200, h: 44, parent: 'L' + li,
      });
    });
    if (li > 0) edges.push({ id: 'le' + li, source: `L${li - 1}i0`, target: `L${li}i0` });
  });
  return { xml: buildXml(nodes, edges), reply: '已生成四层系统架构图示例（前端/接入/服务/数据）。' };
}

function sampleFlow(text) {
  const steps = text
    .split(/[，,、;；\n]|然后|接着|之后|最后/)
    .map((s) => s.replace(/^(请|帮我|画|生成|绘制|创建|一个|一张|流程图[：:]?)\s*/g, '').trim())
    .filter((s) => s.length > 1 && s.length <= 14)
    .slice(0, 5);
  const chain = ['开始'].concat(steps.length ? steps : ['提交信息', '系统处理']).concat(['结束']);
  const nodes = chain.map((label, i) => ({
    id: 'n' + i,
    label,
    style: (i === 0 || i === chain.length - 1) ? STYLES.terminal : STYLES.process,
    x: 340, y: 60 + i * 110, w: 160, h: 52,
  }));
  const edges = chain.slice(0, -1).map((_, i) => ({ id: 'e' + i, source: 'n' + i, target: 'n' + (i + 1) }));
  return { xml: buildXml(nodes, edges), reply: `已生成包含 ${chain.length} 个节点的流程图示例。` };
}

/**
 * @param {string} message
 * @param {{modelXml?: string|null, pageIndex?: number, pageCount?: number}} context
 * @returns {{xml: string|null, reply: string, kind: 'new'|'edited'|'unsupported'|'empty-canvas', preserved: boolean}}
 */
function mockGenerate(message, context) {
  const text = message || '';
  const modelXml = (context && context.modelXml) || null;

  if (!wantsNewDiagram(text)) {
    // 修改意图（含不支持的自由修改）：绝不重建已有图表
    if (!modelXml) {
      return {
        xml: null,
        kind: 'empty-canvas',
        preserved: true,
        reply: '画布上还没有图表，先描述一个要生成的图表吧（例如「画一个用户登录流程图」）。',
      };
    }
    const direction = HORIZONTAL.test(text) ? 'horizontal' : (VERTICAL.test(text) ? 'vertical' : null);
    if (direction) {
      const label = direction === 'horizontal' ? '横向（从左到右）' : '纵向（从上到下）';
      let result;
      try {
        result = Model.applyLayout(modelXml, direction);
      } catch (e) {
        const reason = e instanceof Model.LayoutError ? e.message : (e && e.message ? e.message : String(e));
        return {
          xml: null,
          kind: 'unsupported',
          preserved: true,
          reply: `已保留你当前的图表，未做任何改动：该图表的图形结构暂不支持${label}布局自动重排（${reason}）。配置 DEEPSEEK_API_KEY 后可由大模型处理。`,
        };
      }
      return {
        xml: result.xml,
        kind: 'edited',
        preserved: true,
        reply: `示例引擎已把当前图表整体改为${label}布局：重排了 ${result.moved} 个节点（含 ${result.containers} 个容器及其子节点），保留全部节点 id、文字、样式与连线，你的手工编辑不会被丢弃。`,
      };
    }
    return {
      xml: null,
      kind: 'unsupported',
      preserved: true,
      reply: `已保留你当前的图表，未做任何改动：示例引擎只支持确定性修改（「改为横向布局」「改为纵向布局」），暂不支持「${text.slice(0, 40)}」。若要新建图表，请明确说「画一个…流程图/架构图/思维导图」；配置 DEEPSEEK_API_KEY 后可按任意描述修改。`,
    };
  }

  let sample;
  if (/思维导图|脑图|mind\s*map/i.test(text)) sample = sampleMindMap(text);
  else if (/架构|architecture|部署|系统图/i.test(text)) sample = sampleArchitecture();
  else sample = sampleFlow(text);

  return {
    xml: sample.xml,
    kind: 'new',
    preserved: false,
    reply: `${sample.reply}（当前为内置示例引擎；配置 DEEPSEEK_API_KEY 后将由大模型按你的描述生成。）`,
  };
}

module.exports = { mockGenerate, buildXml, STYLES, wantsNewDiagram, CREATE_VERB, DIAGRAM_NOUN, EDIT_REFERENCE, EDIT_VERB };
