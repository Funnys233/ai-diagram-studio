const test=require('node:test'),assert=require('node:assert/strict');
const {probe,rejectsEffort,declaredEfforts}=require('../../lib/reasoning-probe');
const Cap=require('../../lib/model-capabilities');
const accepted={status:200,accepted:true};
const refused={status:400,accepted:false,data:{error:{code:'invalid_value',param:'reasoning_effort',message:'Unsupported value'}}};
test('先验证基础请求和随机非法值，再逐个检测；包含max但不检测off',async()=>{
 const seen=[];const result=await probe({send:async effort=>{seen.push(effort);return effort===undefined||['low','high','max'].includes(effort)?accepted:refused;}});
 assert.equal(seen.length,7);assert.equal(seen[0],undefined);assert.match(seen[1],/^diagram_probe_[a-f0-9]{24}$/);
 assert.deepEqual(seen.slice(2),['low','medium','high','xhigh','max']);assert.deepEqual(result.reasoningLevels,['low','high','max']);assert.equal(result.validation,'validating');
});
test('接受非法档位不得启用档位，基础失败只发送一次',async()=>{
 let calls=0;let result=await probe({send:async()=>{calls++;return accepted;}});assert.equal(calls,2);assert.equal(result.validation,'non-validating');assert.deepEqual(result.reasoningLevels,[]);
 calls=0;result=await probe({send:async()=>{calls++;return {status:401,accepted:false};}});assert.equal(calls,1);assert.equal(result.validation,'unknown');
});
test('基础限流与超时准确说明原因，不声称模型不支持，不继续探测',async()=>{
 for(const [failure,pattern]of [[{status:429},/上游限流.*HTTP 429/],[{status:0,errorCode:'timeout'},/请求超时/]]){
  let calls=0;const result=await probe({send:async()=>{calls++;return failure;}});
  assert.equal(calls,1);assert.equal(result.validation,'unknown');assert.deepEqual(result.reasoningLevels,[]);assert.match(result.reason,pattern);
 }
});
test('任一档位限流或不明错误都不能保存部分成功结果',async()=>{
 let n=0;const result=await probe({send:async()=>[accepted,refused,accepted,{status:429,accepted:false}][n++]});assert.equal(result.requests,4);assert.equal(result.validation,'unknown');assert.deepEqual(result.reasoningLevels,[]);
 assert.equal(rejectsEffort({status:400,data:{error:{code:'model_param_invalid',param:'max_tokens',message:'Invalid max_tokens'}}}),false);
 assert.equal(rejectsEffort({status:401,data:refused.data}),false);
});
test('识别魔搭实际的 must be one of 枚举错误，并继续逐档检测',async()=>{
 const enumError={status:400,accepted:false,data:{error:{code:'invalid_parameter_error',message:"'reasoning_effort' must be one of: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'",param:null,type:'invalid_request_error'}}};
 assert.equal(rejectsEffort(enumError),true);
 const result=await probe({send:async effort=>effort===undefined||['low','high','max'].includes(effort)?accepted:enumError});
 assert.equal(result.validation,'validating');assert.equal(result.requests,7);assert.deepEqual(result.reasoningLevels,['low','high','max']);
 assert.equal(rejectsEffort({status:422,data:{error:{message:"reasoning_effort should be one of low, high"}}}),true);
 assert.equal(rejectsEffort({status:400,data:{error:{code:'invalid_parameter_error',message:"'max_tokens' must be one of: 64, 128"}}}),false);
});
test('网关隐藏参数详情的实际 400 仍不能证明档位支持；说明普通请求已成功',async()=>{
 const hiddenError={status:400,accepted:false,data:{error:{message:'The request could not be processed. Please check the request parameters.',type:'invalid_request_error'}}};
 assert.equal(rejectsEffort(hiddenError),false);
 let n=0;const result=await probe({send:async()=>n++===0?accepted:hiddenError});
 assert.equal(n,2);assert.equal(result.validation,'unknown');assert.deepEqual(result.reasoningLevels,[]);
 assert.match(result.reason,/普通请求已成功/);assert.match(result.reason,/手动配置/);assert.doesNotMatch(result.reason,/认证、限流/);
});
test('识别中转省略参数名且缩写随机值的明确档位声明，两次请求即可完成',async()=>{
 for(const abbreviated of [false,true]){
  const seen=[];const result=await probe({send:async effort=>{
   seen.push(effort);if(effort===undefined)return accepted;
   const value=abbreviated?effort.slice(0,3)+'...'+effort.slice(-3):effort;
   return {status:400,accepted:false,data:{error:{message:`Invalid value: '${value}'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.`}}};
  }});
  assert.equal(seen.length,2);assert.equal(result.requests,2);assert.equal(result.validation,'validating');
  assert.deepEqual(result.reasoningLevels,['low','medium','high','xhigh','max']);assert.match(result.reason,/按接口声明/);assert.match(result.reason,/未逐档验证/);
 }
});
test('不把不相关参数、错误状态、其他随机值或不完整列表识别为强度声明',()=>{
 const sentinel='diagram_probe_1234567890abcdef12345678';
 const message=`Invalid value: 'dia...678'. Supported values are: 'low', 'medium', and 'max'.`;
 const result=(msg=message,param=null,status=400)=>({status,data:{error:{message:msg,param}}});
 assert.deepEqual(declaredEfforts(result(),sentinel),['low','medium','max']);
 for(const response of [result(message,'max_tokens'),result(message,null,429),result(message.replace('dia...678','dia...000')),result(message.replace("'max'","'fast'")),result(message+' Contact support.'),result(message.replace('Supported values','Example values'))]){
  assert.deepEqual(declaredEfforts(response,sentinel),[]);
 }
});
test('明确枚举声明返回同时取消时不产生成功结果',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(probe({signal:controller.signal,send:async effort=>{
  calls++;if(!effort)return accepted;controller.abort();
  return {status:400,data:{error:{message:`Invalid value: '${effort}'. Supported values are: 'low', 'max'.`}}};
 }}),{name:'AbortError'});assert.equal(calls,2);
});
test('取消不会继续检测或生成成功记录',async()=>{
 const controller=new AbortController();let calls=0;
 await assert.rejects(probe({signal:controller.signal,send:async()=>{calls++;controller.abort();return accepted;}}),{name:'AbortError'});assert.equal(calls,1);
});
test('明确档位与手动配置优先；只有有效检测可补充自动能力',()=>{
 const p={protocol:'openai-chat-completions'};const reasoningProbe={validation:'validating',reasoningLevels:['low','max'],requests:7,probedAt:new Date().toISOString()};
 assert.deepEqual(Cap.resolve(p,{modelId:'m',reasoningProbe}).reasoningLevels,['low','max']);
 assert.deepEqual(Cap.resolve(p,{modelId:'m',reasoningProbe,remoteCapabilities:{effortSupported:true,reasoningLevels:['medium']}}).reasoningLevels,['medium']);
 assert.deepEqual(Cap.resolve(p,{modelId:'m',reasoningProbe,capabilityProfile:'custom',reasoningLevels:['high']}).reasoningLevels,['high']);
 assert.deepEqual(Cap.resolve(p,{modelId:'m',reasoningProbe:{...reasoningProbe,validation:'non-validating'}}).reasoningLevels,[]);
 assert.equal(Cap.canProbe(p,{modelId:'Qwen/Qwen3.8-27B'}),false);
});
test('检测记录持久化；改名字不失效，换密钥失效；过期或取消写入被拒绝',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {ProviderStore}=require('../../lib/provider-store');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-probe-store-'));const filePath=path.join(dir,'providers.json');
 try{
  const store=new ProviderStore({filePath,env:{}}).load();await store.createProvider({providerId:'p',name:'p',baseUrl:'https://api.example/v1',protocol:'openai-chat-completions',apiKey:'fixture-key',models:[{modelId:'m'}]});
  const snapshot={...store.getRaw('p'),capabilityProfile:'auto',remoteCapabilities:null};const result={validation:'validating',reasoningLevels:['low','max'],requests:7};
  await store.recordReasoningProbe('p','m',result,snapshot);await store.updateModel('p','m',{reasoningEffort:'max'});
  await store.updateProvider('p',{name:'renamed'});await store.updateModel('p','m',{displayName:'renamed model',capabilityProfile:'auto',reasoningLevels:[]});
  assert.deepEqual(new ProviderStore({filePath,env:{}}).load().getSanitized('p').models[0].capabilities.reasoningLevels,['low','max']);
  await store.updateProvider('p',{apiKey:'rotated-fixture-key'});assert.equal(store.getRaw('p').models[0].reasoningProbe,null);assert.equal(store.getRaw('p').models[0].reasoningEffort,null);
  await assert.rejects(store.recordReasoningProbe('p','m',result,snapshot),{code:'stale-config'});
  const controller=new AbortController();controller.abort();await assert.rejects(store.recordReasoningProbe('p','m',result,{...snapshot,signal:controller.signal}),{name:'AbortError'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
