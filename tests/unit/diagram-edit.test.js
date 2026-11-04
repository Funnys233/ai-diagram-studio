const test=require('node:test');
const assert=require('node:assert/strict');
const Edit=require('../../lib/diagram-edit');
const Xml=require('../../lib/xml');
const {sampleModel,buildModel,cellVertex,cellEdge,modelWithManualNode}=require('../helpers/fixtures');
const patch=operations=>({version:1,operations});
const raw=(xml,id)=>{const e=Edit.indexModel(xml).cells.get(id);return Xml.sliceNode(xml,e.node);};

test('修改文字与单个样式字段只改变目标，原 ID、位置、路由与未涉及 XML 逐字节保留',()=>{
 const original=sampleModel();const result=Edit.applyPatch(original,patch([{op:'update',id:'3',label:'审核 & 处理',style:{fillColor:'#eef5f2'}}]),['3']);
 for(const id of ['0','1','2','4','5','6'])assert.equal(raw(result.xml,id),raw(original,id));
 assert.equal(result.changes.updated.length,1);assert.equal(result.changes.updated[0].id,'3');assert.equal(result.requiresReview,false);
 assert.ok(result.xml.includes('审核 &amp; 处理'));assert.ok(raw(result.xml,'3').includes('whiteSpace=wrap;html=1;fillColor=#eef5f2;'));
 assert.equal(Edit.verifyCandidate(original,result,['3']).xml,result.xml);
});
test('UserObject id、HTML 标签和未知扩展属性/子数据原样保留，字符引用语义不丢失',()=>{
 const original=buildModel(['<UserObject id="wrapped" label="旧名" custom="a&#xa;b" tooltip="备注"><extra data="保留"/><mxCell vertex="1" parent="1" style="html=1;"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell></UserObject>',cellVertex('other','其他')]);
 const result=Edit.applyPatch(original,patch([{op:'update',id:'wrapped',label:'<b>新\n标题</b>'}]),['wrapped']);
 const e=Edit.indexModel(result.xml).cells.get('wrapped');
 assert.equal(e.wrapper.attributes.custom,'a\nb');assert.equal(e.wrapper.attributes.label,'<b>新\n标题</b>');
 assert.ok(result.xml.includes('<extra data="保留"/>'));assert.equal(raw(result.xml,'other'),raw(original,'other'));
});
test('选中容器允许后代，选中子节点不允许修改父容器或邻居',()=>{
 const original=buildModel([cellVertex('g','容器',{w:500,h:200}),cellVertex('child','子节点',{parent:'g'}),cellVertex('neighbor','邻居')]);
 assert.deepEqual([...Edit.resolveScope(original,['g']).allowed],['g','child']);
 assert.equal(Edit.applyPatch(original,patch([{op:'update',id:'child',label:'新'}]),['g']).changes.total,1);
 for(const id of ['g','neighbor'])assert.throws(()=>Edit.applyPatch(original,patch([{op:'update',id,label:'越界'}]),['child']),e=>e.code==='edit-out-of-scope');
});
test('新增由宿主分配唯一 ID，临时引用映射正确，更新已有 ID 不重编号',()=>{
 const result=Edit.applyPatch(sampleModel(),patch([{op:'add',id:'new1',kind:'node',label:'新节点',geometry:{x:500,y:170}}, {op:'add',id:'new2',kind:'edge',source:'3',target:'new1'}]),['3'],{nonce:'test'});
 assert.equal(result.idMap.new1,'ai-edit-test-1');assert.equal(result.idMap.new2,'ai-edit-test-2');assert.equal(result.changes.added.length,2);assert.equal(result.requiresReview,true);
 assert.equal(Edit.indexModel(result.xml).cells.get(result.idMap.new2).cell.attributes.target,result.idMap.new1);
 assert.equal(Edit.verifyCandidate(sampleModel(),result,['3']).xml,result.xml);
});
test('删除节点自动处理后代、关联边及边标签，准确摘要并要求确认',()=>{
 const original=buildModel([cellVertex('g','容器'),cellVertex('child','子',{parent:'g'}),cellVertex('other','其他'),cellEdge('e','child','other'),cellVertex('label','边标签',{parent:'e'})]);
 const result=Edit.applyPatch(original,patch([{op:'remove',id:'g'}]),['g']);
 assert.deepEqual(result.changes.removed.map(x=>x.id),['g','child','e','label']);assert.equal(result.requiresReview,true);assert.equal(raw(result.xml,'other'),raw(original,'other'));
});
test('非法范围、未知字段、重复操作、悬空引用、负宽高、分隔符注入及父子循环都被拒绝',()=>{
 const cases=[ [{op:'update',id:'4',label:'越界'}], [{op:'update',id:'3',idNew:'x',label:'非法'}], [{op:'update',id:'3',label:'a'},{op:'remove',id:'3'}], [{op:'update',id:'3',geometry:{width:-1}}], [{op:'update',id:'3',style:{fillColor:'red;rounded=1'}}], [{op:'add',id:'x',kind:'edge',source:'3',target:'missing'}], [{op:'add',id:'x',kind:'node',parent:'y'},{op:'add',id:'y',kind:'node',parent:'x'}], [{op:'remove',id:'3'},{op:'update',id:'5',label:'已删除关联边'}] ];
 for(const operations of cases)assert.throws(()=>Edit.applyPatch(sampleModel(),patch(operations),['3','5']),Edit.EditError);
 assert.throws(()=>Edit.parsePatch(sampleModel()),/JSON/);
 assert.throws(()=>Edit.resolveScope(sampleModel(),[]),/请选择/);
});
test('未改变语义的更新和空操作保持原始 XML，无额外加载需求',()=>{
 const original=sampleModel();for(const operations of [[],[{op:'update',id:'3',style:{html:'1'}}],[{op:'update',id:'3',geometry:{}}]]){
  const r=Edit.applyPatch(original,patch(operations),['3']);assert.equal(r.changes.total,0);assert.equal(r.xml,original);
 }
});
test('客户端拒绝 XML／摘要／确认标志被篡改的响应',()=>{
 const r=Edit.applyPatch(sampleModel(),patch([{op:'update',id:'3',label:'新'}]),['3']);
 for(const alteration of [{xml:r.xml.replace('value="开始"','value="篡改"')},{changes:{...r.changes,total:99}},{requiresReview:true}])assert.throws(()=>Edit.verifyCandidate(sampleModel(),{...r,...alteration},['3']),/不一致/);
});
test('冲突后重新应用可保留未涉及的手工编辑，目标被改动则拒绝覆盖',()=>{
 const original=sampleModel();const proposed=patch([{op:'update',id:'3',label:'AI 修改'}]);
 const manual=Edit.applyPatch(original,patch([{op:'update',id:'4',label:'手工修改'}]),['4']).xml;
 const result=Edit.rebase(original,manual,proposed,['3'],{});assert.ok(result.xml.includes('AI 修改'));assert.ok(result.xml.includes('手工修改'));
 const changed=Edit.applyPatch(original,patch([{op:'update',id:'3',label:'目标手工修改'}]),['3']).xml;
 assert.throws(()=>Edit.rebase(original,changed,proposed,['3'],{}),/已被修改/);
});
test('删除结果不能删除等待期间新增的关联边，新增 ID 冲突不能覆盖手工节点',()=>{
 const original=sampleModel(),current=original.replace('</root>',cellEdge('manual','3','4')+'</root>');
 assert.throws(()=>Edit.rebase(original,current,patch([{op:'remove',id:'3'}]),['3'],{}),/新加入/);
 const adding=patch([{op:'add',id:'x',kind:'node'}]);const r=Edit.applyPatch(original,adding,['3']);
 const collision=original.replace('</root>',cellVertex(r.idMap.x,'手工')+'</root>');
 assert.throws(()=>Edit.rebase(original,collision,adding,['3'],r.idMap),/冲突/);
});
test('改连线端点保留边 ID，只允许选区或新增端点，拓扑变化先确认',()=>{
 const r=Edit.applyPatch(sampleModel(),patch([{op:'update',id:'5',target:'4'}]),['5','4']);
 assert.equal(Edit.indexModel(r.xml).cells.get('5').cell.attributes.target,'4');assert.equal(r.requiresReview,true);
 assert.throws(()=>Edit.applyPatch(sampleModel(),patch([{op:'update',id:'5',target:'4'}]),['5']),/选中连线/);
 assert.throws(()=>Edit.applyPatch(sampleModel(),patch([{op:'update',id:'3',target:'4'}]),['3','4']),/选中连线/);
});
test('删除只级联真实连线，普通节点的 source/target 扩展属性不会触发误删',()=>{
 const original=sampleModel().replace('</root>',cellVertex('metadata','保留').replace('vertex="1"','vertex="1" source="3" target="3"')+'</root>');
 const result=Edit.applyPatch(original,patch([{op:'remove',id:'3'}]),['3']);
 assert.equal(raw(result.xml,'metadata'),raw(original,'metadata'));assert.equal(result.changes.removed.length,3);
});
test('容器导出包含后代时折叠为根选区，超过 200 个后代仍能锁定容器',()=>{
 const children=Array.from({length:220},(_,i)=>cellVertex('child'+i,'子',{parent:'g'}));
 const original=buildModel([cellVertex('g','容器'),...children]);
 const ids=['g',...children.map((_,i)=>'child'+i)];assert.deepEqual(Edit.minimizeTargets(original,ids),['g']);
 assert.equal(Edit.resolveScope(original,Edit.minimizeTargets(original,ids)).allowed.size,221);
});
