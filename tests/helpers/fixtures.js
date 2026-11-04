// 测试用图表数据构造工具
const { compressDiagram } = require('../../lib/drawio-zlib.js');

const MODEL_HEAD = '<mxGraphModel dx="900" dy="650" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">';

function cellVertex(id, label, options) {
  const o = options || {};
  const x = o.x === undefined ? 40 : o.x;
  const y = o.y === undefined ? 40 : o.y;
  const w = o.w === undefined ? 120 : o.w;
  const h = o.h === undefined ? 60 : o.h;
  const style = o.style || 'rounded=0;whiteSpace=wrap;html=1;';
  const parent = o.parent || '1';
  return `    <mxCell id="${id}" value="${label}" style="${style}" vertex="1" parent="${parent}"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`;
}

function cellEdge(id, source, target, label) {
  return `    <mxCell id="${id}" value="${label || ''}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;" edge="1" parent="1" source="${source}" target="${target}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
}

function buildModel(cells) {
  return `${MODEL_HEAD}\n  <root>\n    <mxCell id="0"/>\n    <mxCell id="1" parent="0"/>\n${cells.join('\n')}\n  </root>\n</mxGraphModel>`;
}

/** 三个节点的纵向流程图 */
function sampleModel() {
  return buildModel([
    cellVertex('2', '开始', { x: 340, y: 60, style: 'rounded=1;whiteSpace=wrap;html=1;' }),
    cellVertex('3', '处理', { x: 340, y: 170 }),
    cellVertex('4', '结束', { x: 340, y: 280, style: 'rounded=1;whiteSpace=wrap;html=1;' }),
    cellEdge('5', '2', '3'),
    cellEdge('6', '3', '4'),
  ]);
}

/** 含手工节点 keep-me 的图（用于「AI 不得丢失手工编辑」类用例） */
function modelWithManualNode() {
  return buildModel([
    cellVertex('2', '开始', { x: 340, y: 60 }),
    cellVertex('3', '处理', { x: 340, y: 170 }),
    cellVertex('keep-me', '手工加的节点', { x: 600, y: 170 }),
    cellEdge('5', '2', '3'),
  ]);
}

/**
 * 完整 mxfile。
 * @param {Array<{name: string, id: string, content: string, compressed?: boolean}>} pages
 */
function buildMxfile(pages) {
  const body = pages.map((p) => `  <diagram name="${p.name}" id="${p.id}">${p.compressed ? compressDiagram(p.content) : p.content}</diagram>`).join('\n');
  return `<mxfile host="DiagramAI" type="device">\n${body}\n</mxfile>`;
}

/** 生成 count 个节点的大图（用于验证「不截断」） */
function bigModel(count) {
  const cells = [];
  for (let i = 0; i < count; i++) {
    cells.push(cellVertex('n' + i, '节点' + i, { x: 40 + (i % 8) * 160, y: 40 + Math.floor(i / 8) * 100 }));
    if (i > 0) cells.push(cellEdge('e' + i, 'n' + (i - 1), 'n' + i));
  }
  return buildModel(cells);
}

function flowPlan() {
  return { version:1,type:'flowchart',title:'审批',direction:'TB',nodes:[
    {id:'s',label:'开始',type:'start'}, {id:'d',label:'通过？',type:'decision'},
    {id:'p',label:'修改申请',type:'process'}, {id:'e',label:'结束',type:'end'}],
    edges:[{source:'s',target:'d'}, {source:'d',target:'e',label:'是'},
      {source:'d',target:'p',label:'否'}, {source:'p',target:'d',label:'重试'}] };
}
function designedFlowPlan() {
  const p = flowPlan();
  const positions = [[320.5,60,160,48],[300,210,200,100],[560,390,180,72],[60,390,160,48]];
  p.nodes.forEach((n,i) => Object.assign(n, {x:positions[i][0],y:positions[i][1],width:positions[i][2],height:positions[i][3],
    style:{fillColor:i===2?'#fff0e5':'#eef5f2',strokeColor:'#538572',fontColor:'#243b33',fontSize:15,fontFamily:'Inter',rounded:i!==1}}));
  Object.assign(p.edges[3], {sourcePort:{x:1,y:0.5},targetPort:{x:1,y:0.5},
    points:[{x:810,y:426},{x:810,y:260}],routing:'orthogonal',style:{strokeColor:'#b86f36',dashed:true,strokeWidth:2}});
  return p;
}
module.exports = { MODEL_HEAD, cellVertex, cellEdge, buildModel, sampleModel, modelWithManualNode, buildMxfile, bigModel, flowPlan, designedFlowPlan };
