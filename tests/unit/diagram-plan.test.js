const test = require('node:test');
const assert = require('node:assert/strict');
const Xml = require('../../lib/xml');
const Model = require('../../lib/graphmodel');
const { validatePlan, parsePlan, compilePlan } = require('../../lib/diagram-plan');
const { validateStage } = require('../../lib/staged-generation');
const { flowPlan: sample, designedFlowPlan } = require('../helpers/fixtures');
const { organizeLayout } = require('../../lib/auto-layout');
const cells = xml => Model.collectCells(Xml.firstChild(Xml.parse(xml).root,'root'));
test('JSON 方案只编译一次节点，框架和完整图 ID、文字、样式、位置一致，反馈关系保留', () => {
  const {plan,framework,connected}=compilePlan(sample());
  assert.equal(Model.validateGraphModel(framework).stats.edges,0);
  assert.equal(validateStage(connected,'connections',framework),null);
  assert.equal(Model.validateGraphModel(connected).stats.edges,4);
  assert.deepEqual(cells(connected).filter(e=>e.cell.attributes.edge==='1').map(e=>[
    e.cell.attributes.source,e.cell.attributes.target,e.cell.attributes.value]), plan.edges.map(e=>[e.source,e.target,e.label]));
  assert.ok(connected.includes('<Array as="points">'));
  assert.equal(compilePlan(plan).connected,connected,'复用缺省方案时反馈路线保持一致');
});
test('方案拒绝断开的节点、悬空关系、封闭循环、缺失和重复的判断条件', () => {
  let p=sample(); p.edges[0].target='missing'; assert.throws(()=>validatePlan(p),/不存在/);
  p=sample(); p.nodes.push({id:'isolated',label:'孤立',type:'process'}); assert.throws(()=>validatePlan(p),/无法从开始到达/);
  p=sample(); p.edges[1].target='p'; assert.throws(()=>validatePlan(p),/无法到达结束/);
  p=sample(); p.edges[1].label=''; assert.throws(()=>validatePlan(p),/条件/);
  p=sample(); p.edges[2].label='是'; assert.throws(()=>validatePlan(p),/条件/);
  p=sample(); p.nodes[3].id='0'; assert.throws(()=>validatePlan(p),/保留/);
  p=sample(); p.nodes[0].parent='lane'; assert.throws(()=>validatePlan(p),/通用图表/);
});

test('模型位置、尺寸、配色、端口和路径在三个阶段保持一致，缓存重编译不改变设计', () => {
  const input=designedFlowPlan(), compiled=compilePlan(input);
  assert.equal(compiled.layoutInfo.source,'model');
  assert.deepEqual(compiled.layoutInfo.adjustedNodes,[]);
  assert.equal(compilePlan(compiled.plan).connected,compiled.connected);
  const entries=cells(compiled.connected);
  for(const n of input.nodes) {
    const cell=entries.find(e=>e.cell.attributes.id===n.id).cell;
    const g=Xml.firstChild(cell,'mxGeometry').attributes;
    for(const k of ['x','y','width','height'])assert.equal(Number(g[k]),n[k]);
    for(const k of ['fillColor','fontFamily','fontSize'])assert.ok(cell.attributes.style.includes(`${k}=${n.style[k]};`));
  }
  const edge=entries.find(e=>e.cell.attributes.source==='p'&&e.cell.attributes.target==='d').cell;
  for(const field of ['exitX=1;','entryX=1;','dashed=1;','strokeColor=#b86f36;','strokeWidth=2;'])assert.ok(edge.attributes.style.includes(field));
  assert.ok(compiled.connected.includes('<mxPoint x="810" y="426"/>'));
  const layout=organizeLayout(compiled.connected,{preserveLayout:true});
  assert.equal(layout.moved,0);assert.equal(layout.routed,0);
  assert.deepEqual(cells(layout.xml).map(e=>Model.serializeNode(e.cell)),cells(compiled.connected).map(e=>Model.serializeNode(e.cell)));
});

test('局部重叠只修正冲突节点及其路径，缺省位置不挤走已有设计', () => {
  const p=designedFlowPlan();p.nodes[2].x=p.nodes[1].x;p.nodes[2].y=p.nodes[1].y;
  const compiled=compilePlan(p);
  assert.deepEqual(compiled.layoutInfo.adjustedNodes,['p']);
  const geometry=xml=>new Map(cells(xml).filter(e=>e.cell.attributes.vertex==='1').map(e=>[e.cell.attributes.id,Xml.firstChild(e.cell,'mxGeometry').attributes]));
  const boxes=geometry(compiled.framework);
  for(const n of p.nodes.filter(n=>n.id!=='p'))for(const k of ['x','y','width','height'])assert.equal(Number(boxes.get(n.id)[k]),n[k]);
  assert.equal(compiled.connected.includes('<mxPoint x="810" y="426"/>'),false,'端点移动后舍弃过期路线');
  assert.equal(compilePlan(compiled.plan).connected,compiled.connected);
  const mixed=designedFlowPlan();delete mixed.nodes[2].x;delete mixed.nodes[2].y;
  const partial=compilePlan(mixed);assert.equal(partial.layoutInfo.source,'mixed');
  for(const n of mixed.nodes.filter(n=>n.x!==undefined))assert.equal(Number(geometry(partial.framework).get(n.id).x),n.x);
});

test('拒绝非法几何、端口和样式，字体名称正常支持 Inter/Arial', () => {
  for(const mutate of [p=>p.nodes[0].x=NaN,p=>delete p.nodes[0].y,p=>p.nodes[0].width=-1,
    p=>p.nodes[0].style.fillColor='red;html=1',p=>p.nodes[0].style.fontFamily='Inter\nhtml=1',
    p=>p.nodes[0].style.fontStyle=1.5,p=>p.edges[3].sourcePort.x=2,p=>p.edges[3].points[0].x=Infinity]) {
    const p=designedFlowPlan();mutate(p);assert.throws(()=>validatePlan(p),e=>e.code==='invalid-diagram-plan');
  }
  const p=designedFlowPlan();p.nodes[0].style.fontFamily='Arial';assert.equal(validatePlan(p).nodes[0].style.fontFamily,'Arial');
});
test('JSON 解析、XML 转义及程序生成的边 ID 不与节点冲突', () => {
  const p=sample(); p.nodes[2].id='plan_edge_1'; p.nodes[2].label='A & <B> "测试"\n下一行';
  p.edges[2].target='plan_edge_1';p.edges[3].source='plan_edge_1';
  const compiled=compilePlan(parsePlan('```json\n'+JSON.stringify(p)+'\n```'));
  assert.equal(Model.validateGraphModel(compiled.connected).ok,true);
  assert.equal(cells(compiled.connected).find(e=>e.cell.attributes.id==='plan_edge_1').cell.attributes.value,p.nodes[2].label);
  assert.throws(()=>parsePlan('<mxGraphModel/>'),/JSON/);
});
test('两个布局方向中节点不重叠，生成路径点保持合法', () => {
  for(const direction of ['TB','LR']) {
    const p=sample();p.direction=direction;
    p.nodes[2].label='长步骤说明'.repeat(20);
    const {connected}=compilePlan(p);
    const boxes=cells(connected).filter(e=>e.cell.attributes.vertex==='1').map(e=>{
      const a=Xml.firstChild(e.cell,'mxGeometry').attributes;
      return Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(a[k])]));
    });
    for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++) {
      const a=boxes[i],b=boxes[j];
      assert.equal(a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height,false);
    }
  }
});
test('反馈线从层间进入外侧通道，两种节点顺序和方向都不横穿其他节点', () => {
  for(const direction of ['TB','LR'])for(const reverse of [false,true]) {
    const p=sample();p.direction=direction;if(reverse)p.nodes.reverse();
    const entries=cells(compilePlan(p).connected), vertices=new Map(entries.filter(e=>e.cell.attributes.vertex==='1').map(e=>{
      const a=Xml.firstChild(e.cell,'mxGeometry').attributes;
      return [e.cell.attributes.id,Object.fromEntries(['x','y','width','height'].map(k=>[k,Number(a[k])]))];
    }));
    const edge=entries.find(e=>e.cell.attributes.source==='p'&&e.cell.attributes.target==='d').cell;
    const array=Xml.firstChild(Xml.firstChild(edge,'mxGeometry'),'Array');
    const s=vertices.get('p'),t=vertices.get('d');
    const pts=[direction==='TB'?{x:s.x+s.width/2,y:s.y+s.height}:{x:s.x+s.width,y:s.y+s.height/2},
      ...Xml.childElements(array,'mxPoint').map(n=>({x:Number(n.attributes.x),y:Number(n.attributes.y)})),
      direction==='TB'?{x:t.x+t.width/2,y:t.y}:{x:t.x,y:t.y+t.height/2}];
    for(const [id,b] of vertices) {
      if(id==='p'||id==='d')continue;
      for(let i=1;i<pts.length;i++) {
        const a=pts[i-1],z=pts[i];
        const crosses=a.x===z.x?a.x>b.x&&a.x<b.x+b.width&&Math.max(a.y,z.y)>b.y&&Math.min(a.y,z.y)<b.y+b.height
          :a.y>b.y&&a.y<b.y+b.height&&Math.max(a.x,z.x)>b.x&&Math.min(a.x,z.x)<b.x+b.width;
        assert.equal(crosses,false,`反馈线穿过 ${id}`);
      }
    }
  }
});
