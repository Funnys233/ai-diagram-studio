const test=require('node:test'),assert=require('node:assert/strict');
const {createModelStream}=require('../../lib/model-stream'),adapter=require('../../lib/adapters/openai-chat');
const Quota=require('../../lib/weekly-quota');
const now=Date.parse('2026-10-21T00:00:00Z');
const busy={error:{message:'The service is busy. Please retry later.'}};
function rejection(events=[],last=busy){
 const stream=createModelStream(adapter.protocol,adapter,'中转');
 for(const event of events)stream.accept({data:JSON.stringify(event)});
 let error;try{stream.accept({data:JSON.stringify(last)});}catch(e){error=e;}
 assert.equal(error?.code,'upstream-busy');assert.match(error.message,/上游服务繁忙/);
 return {error,usage:stream.getUsage()};
}
function settle(result,patch={}){
 const data={};Quota.reserve(data,{id:'one',ownerKey:'alice',limitPoints:1000,source:'platform',modelId:'gpt-6.1-sol',reasoningEffort:'high'},now);
 const call=Quota.settle(data,'one',{...result,...patch},now+1000);return {data,call};
}
test('繁忙首帧或空心跳拒绝不扣45点，释放预留，重放/重启不补扣',()=>{
 for(const events of [[],[{choices:[{delta:{role:'assistant',content:''}}]},{choices:[]}]]){
  const {data,call}=settle(rejection(events));assert.equal(call.chargedCredits,0);assert.equal(call.estimated,false);assert.equal(call.unbilledReason,'stream-busy');assert.equal(call.status,'failed');
  assert.equal(data.weeklyQuota.windows[0].reservedCredits,0);assert.equal(data.weeklyQuota.windows[0].usedCredits,0);
  assert.deepEqual(Quota.settle(data,'one',{},now+2000),call);assert.equal(Quota.recover(data,now+3000),0);
 }
});
test('繁忙前的回答、隐藏思考、工具和未知非空字段均保留估算扣点',()=>{
 for(const delta of [{content:'部分回答'},{reasoning_content:'private'},{reasoning:'private'},{tool_calls:[{id:'call1'}]},{function_call:{name:'f'}},{audio:{data:'chunk'}},{future_output:'chunk'}]){
  const result=rejection([{choices:[{delta}]}]);assert.equal(result.error.extra.upstreamRejectedBeforeGeneration,false);
  assert.equal(settle(result).call.chargedCredits,45000);
 }
 const result=rejection([], {...busy,choices:[{delta:{content:'同一事件的内容'}}]});assert.equal(settle(result).call.chargedCredits,45000);
});
test('返回过实际用量不能免扣，包括后续零用量覆盖及仅缓存用量',()=>{
 for(const usage of [{prompt_tokens:100,completion_tokens:100},{total_tokens:1},{prompt_tokens_details:{cached_tokens:5}}]){
  const result=rejection([{usage},{usage:{prompt_tokens:0,completion_tokens:0}}]);assert.equal(result.error.extra.upstreamRejectedBeforeGeneration,false);assert.ok(settle(result).call.chargedCredits>0);
 }
 const {call}=settle(rejection([{usage:{prompt_tokens:100,completion_tokens:100}}]));assert.equal(call.chargedCredits,9000);assert.equal(call.estimated,false);
});
test('普通流错误、只含繁忙错误码、取消和旧预留不会免扣',()=>{
 const stream=createModelStream(adapter.protocol,adapter,'中转');assert.throws(()=>stream.accept({data:JSON.stringify({error:{message:'unknown failure'}})}),e=>e.code==='server-error'&&!e.extra);
 assert.equal(settle({error:{code:'upstream-busy'}}).call.chargedCredits,45000);
 assert.equal(settle(rejection(),{cancelled:true}).call.chargedCredits,45000);
 assert.equal(settle(rejection(),{usage:{total_tokens:1}}).call.chargedCredits,45000);
 const data={};Quota.reserve(data,{id:'old',ownerKey:'alice',limitPoints:1000},now);delete data.weeklyQuota.calls[0].streamBusyPolicy;
 assert.equal(Quota.settle(data,'old',rejection(),now+1000).chargedCredits,2000);
});
