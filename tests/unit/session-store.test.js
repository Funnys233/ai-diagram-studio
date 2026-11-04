const test = require('node:test');
const assert = require('node:assert/strict');
const Sessions = require('../../public/session-store');
const { sampleModel, buildMxfile } = require('../helpers/fixtures');
const session = () => ({ version: 1, payload: sampleModel(), pageIndex: 0, pageId: null, name: '审批',
  history: [], messages: [], snapshots: [], draft: '稍后修改', revision: 3, pendingResult: null, retry: null });
test('会话保存每轮扣点和待结算标识，未知旧记录不补造消耗',()=>{
 const data=session(),turnUsage={turnId:'12345678-1234-1234-1234-123456789abc',status:'pending',calls:1,weeklyPoints:.6,reservedPoints:2,freeCalls:0,personalCalls:0,estimated:false,apiKey:'private'};
 data.messages=[{role:'assistant',text:'回复',turnUsage},{role:'assistant',text:'旧回复'}];
 const saved=Sessions.normalize(data);
 assert.equal(saved.messages[0].turnUsage.weeklyPoints,.6);assert.equal(saved.messages[0].turnUsage.status,'pending');
 assert.equal(saved.messages[1].turnUsage,undefined);assert.ok(!JSON.stringify(saved).includes('private'));
});
test('绘图会话刷新恢复缓存回执，保留零命中而不保存额外上游字段',()=>{
 const data=session(),cache={cachedTokens:0,inputTokens:1000,hitRate:0,knownCalls:1,unknownCalls:0,apiKey:'private'};
 data.messages=[{role:'assistant',text:'回复',turnUsage:{turnId:'12345678-1234-1234-1234-123456789abc',status:'settled',calls:1,weeklyPoints:1.5,reservedPoints:0,freeCalls:0,personalCalls:0,estimated:false,cache}}];
 const saved=Sessions.normalize(JSON.parse(JSON.stringify(data)));assert.equal(saved.messages[0].turnUsage.cache.cachedTokens,0);assert.equal(saved.messages[0].turnUsage.cache.hitRate,0);assert.ok(!JSON.stringify(saved).includes('private'));
});

test('会话：按稳定页 ID 恢复当前页，多页原文完整保存', () => {
  const data = session();
  data.payload = buildMxfile([{ name: 'one', id: 'a', content: sampleModel() }, { name: 'two', id: 'b', content: sampleModel(), compressed: true }]);
  data.pageId = 'b'; data.pageIndex = 0;
  const saved = Sessions.normalize(data);
  assert.equal(saved.pageIndex, 1);
  assert.equal(saved.payload, data.payload);
});

test('会话：只持久化白名单数据，来源、失败重试和撤销均保留，密钥对象不保存', () => {
  const data = session();
  data.apiKey = 'secret'; data.providers = [{ apiKey: 'secret' }];
  data.messages = [{ role: 'assistant', text: '完成', source: '来源：旧名称 / 模型', kind: '', provider: { apiKey: 'secret' },
    retry: { text: '再试', selection: { providerId: 'a', modelId: 'm', apiKey: 'secret' } } }];
  data.snapshots = [{ id: 's', label: '修改前', time: '12:00', payload: sampleModel(), pageIndex: 0 }];
  data.pendingResult = { xml: sampleModel(), reply: '暂存', pageId: null, pageIndex: 0 };
  const saved = Sessions.normalize(data);
  assert.equal(JSON.stringify(saved).includes('secret'), false);
  assert.equal(saved.messages[0].source, data.messages[0].source);
  assert.equal(saved.messages[0].retry.selection.modelId, 'm');
  assert.equal(saved.snapshots.length, 1);
  assert.equal(saved.pendingResult.xml, data.pendingResult.xml);
});

test('会话：未知版本、缺页、非法 XML 和坏聊天记录必须拒绝，不能变成空白会话', () => {
  const data = session();
  for (const invalid of [ { ...data, version: 2 }, { ...data, payload: '<mxGraphModel/>' },
    { ...data, messages: [{ role: 'system', text: 'x' }] },
    { ...data, payload: buildMxfile([{ id: 'a', name: 'a', content: sampleModel() }]), pageId: 'missing' } ]) {
    assert.throws(() => Sessions.normalize(invalid));
  }
});

test('会话：无 IndexedDB 时明确报告不可保存', async () => {
  await assert.rejects(Sessions.open(null), /无法使用本地/);
});
test('局部暂存与失败重试保留原选区，非法或被篡改的暂存结果不能恢复',()=>{
 const Edit=require('../../lib/diagram-edit');const data=session();
 const r=Edit.applyPatch(data.payload,{version:1,operations:[{op:'remove',id:'3'}]},['3']);
 data.pendingResult={xml:r.xml,reply:'删除',pageIndex:0,pageId:null,edit:{baseXml:data.payload,targetIds:['3'],patch:r.patch,idMap:r.idMap,changes:r.changes,requiresReview:r.requiresReview}};
 data.retry={text:'原请求',selection:{providerId:'p',modelId:'m'},editContext:{baseXml:data.payload,targetIds:['3'],pageIndex:0,pageId:null,apiKey:'secret'}};
 const clean=Sessions.normalize(data);assert.deepEqual(clean.retry.editContext.targetIds,['3']);assert.equal(clean.pendingResult.edit.changes.removed.length,3);assert.ok(!JSON.stringify(clean).includes('secret'));
 data.pendingResult.edit.requiresReview=false;assert.throws(()=>Sessions.normalize(data),/不一致/);
});

test('视觉待确认结果刷新保留独立基线与摘要，不能恢复为局部补丁或允许丢元素',()=>{
 const data=session(),base=data.payload;data.pendingResult={xml:base.replace('y="280"','y="350"'),reply:'视觉修复',pageId:null,pageIndex:0,visual:{baseXml:base,changes:{fake:true}}};
 const clean=Sessions.normalize(data);assert.equal(clean.pendingResult.visual.baseXml,base);assert.equal(clean.pendingResult.visual.changes.updated[0].id,'4');assert.equal(clean.pendingResult.edit,undefined);
 data.pendingResult.xml=base.replace('vertex="1"','vertex="0"');assert.throws(()=>Sessions.normalize(data));
});
test('多模态候选恢复保留模式，允许结构调整但不允许非法XML或未知模式',()=>{
 const data=session(),base=data.payload;data.pendingResult={xml:base.replaceAll('="3"','="new3"').replace('source="2"','source="4"'),reply:'连续修改',pageId:null,pageIndex:0,visual:{mode:'multimodal',baseXml:base,changes:{fake:true}}};
 const clean=Sessions.normalize(data);assert.equal(clean.pendingResult.visual.mode,'multimodal');assert.ok(clean.pendingResult.visual.changes.total>0);assert.equal(clean.pendingResult.edit,undefined);
 data.pendingResult.visual.mode='unknown';assert.throws(()=>Sessions.normalize(data),/模式/);data.pendingResult.visual.mode='multimodal';data.pendingResult.xml='<mxGraphModel/>';assert.throws(()=>Sessions.normalize(data));
});

test('上传图片与未发送附件随会话保存，远程地址和损坏图片拒绝恢复',()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
 const data=session();data.attachments=[png];data.messages=[{role:'user',text:'参考',images:[png]}];data.history=[{role:'user',content:'参考',images:[png]}];
 const clean=Sessions.normalize(data);assert.deepEqual(clean.attachments,[png]);assert.deepEqual(clean.history[0].images,[png]);assert.deepEqual(clean.messages[0].images,[png]);
 data.attachments=['https://example.com/remote.png'];assert.throws(()=>Sessions.normalize(data));data.attachments=[png];data.messages[0].images=['data:image/png;base64,abcd'];assert.throws(()=>Sessions.normalize(data));
});

test('绘图任务持久化完整原始页基线与安全选择，消息任务标识保留；settled清除请求内容',()=>{
 const data=session(),taskId='12345678-1234-1234-1234-123456789abc';
 data.drawingTask={taskId,threadId:taskId,assistantId:taskId,status:'pending',mode:'chat',message:'横向布局',turnId:taskId,
  selection:{providerId:'relay',modelId:'sol',apiKey:'secret'},base:{payload:data.payload,pageIndex:0,pageId:null,revision:7},attachments:[],apiKey:'secret'};
 data.messages=[{role:'assistant',text:'正在生成',taskId}];
 const clean=Sessions.normalize(data);assert.equal(clean.drawingTask.base.payload,data.payload);assert.equal(clean.drawingTask.base.revision,7);assert.equal(clean.messages[0].taskId,taskId);assert.equal(clean.drawingTask.message,'横向布局');assert.ok(!JSON.stringify(clean).includes('secret'));
 data.drawingTask.status='settled';const settled=Sessions.normalize(data).drawingTask;assert.deepEqual(Object.keys(settled).sort(),['assistantId','status','taskId','threadId']);
});
test('绘图恢复任务拒绝损坏ID、丢失基线和不安全模式，旧会话向后兼容',()=>{
 const data=session(),id='12345678-1234-1234-1234-123456789abc';assert.equal(Sessions.normalize(data).drawingTask,null);
 const task={taskId:id,threadId:id,assistantId:id,status:'pending',mode:'chat',message:'画图',selection:{providerId:'mock',modelId:'mock'},base:{payload:data.payload,pageIndex:0,pageId:null,revision:0},attachments:[]};
 for(const invalid of [{...task,taskId:'bad'},{...task,base:null},{...task,mode:'external'},{...task,base:{...task.base,payload:'<invalid>'}},{...task,visualContext:{baseXml:data.payload,mode:'unsafe'}}])assert.throws(()=>Sessions.normalize({...data,drawingTask:invalid}));
});
