const test=require('node:test'),assert=require('node:assert/strict'),Repair=require('../../lib/vision-repair');
const {sampleModel,bigModel}=require('../helpers/fixtures');
test('视觉整页修复允许自由协调全部节点和连线路径，不受200个选区目标与100条操作限制',()=>{
 const base=bigModel(230),xml=base.replace(/\bx="(\d+)"/g,(_,value)=>'x="'+(Number(value)+20)+'"');const changes=Repair.validateCandidate(base,xml);assert.ok(changes.updated.length>100);assert.equal(changes.removed.length,0);
});
test('视觉修复检测页面背景和纸面调整，忽略编辑器视口属性',()=>{
 const base=sampleModel();assert.equal(Repair.validateCandidate(base,base.replace('dx="900"','dx="33"')).pageChanged,false);
 const changes=Repair.validateCandidate(base,base.replace('pageWidth="850"','pageWidth="1000"'));assert.equal(changes.total,0);assert.equal(changes.pageChanged,true);assert.equal(Repair.summary(changes),'调整页面设置');
});
test('整页视觉校验仍拒绝丢失ID、类型变化、错误XML及业务连线变化',()=>{
 const base=sampleModel();for(const candidate of [base.replace('id="3"','id="renamed"').replaceAll('="3"','="renamed"'),base.replace('vertex="1"','vertex="0"'),base.replace('source="2"','source="4"'),'<mxGraphModel/>'])assert.throws(()=>Repair.validateCandidate(base,candidate));
});
test('多模态允许结构与业务连线改变，仍校验XML和引用并记录差异',()=>{
 const base=sampleModel(),candidate=base.replaceAll('="3"','="new3"').replace('source="2"','source="4"');const changes=Repair.validateCandidate(base,candidate,'multimodal');assert.ok(changes.total>0);assert.ok(changes.added.includes('new3')||changes.added.some(c=>c.id==='new3'));assert.throws(()=>Repair.validateCandidate(base,'<mxGraphModel/>','multimodal'));assert.throws(()=>Repair.validateCandidate(base,base.replace('source="2"','source="missing"'),'multimodal'));
});
