const test=require('node:test'),assert=require('node:assert/strict');
const Usage=require('../../lib/usage-report');
const now=Date.parse('2026-10-17T06:00:00Z'),DAY=86400000;
const admin={user:{id:'owner',username:'admin',role:'admin'}},alice={user:{id:'alice',username:'alice',role:'user'}};
const data=()=>{const value={users:[admin.user,alice.user,{id:'bob',username:'bob',role:'user'}],events:[]};Usage.initialize(value,'owner',now);return value;};
let sequence=0;
function record(value,{userId='alice',source='chatgpt',modelId='luna',time=now,status='success',usage=null,elapsedMs=1000}={}){
 const event={id:String(++sequence),userId,source,providerId:'fixture',modelId,subscriptionOwnerId:source==='chatgpt'?'owner':null,time,status:'started',usage:null,errorCode:null};
 Usage.start(value,event,time);
 if(status!=='started')Usage.finish(value,event.id,{usage},status==='success'?null:{code:'fixture-error'},status==='cancelled',time+elapsedMs);
 return event;
}
const report=(value,identity=admin,query='')=>Usage.report(value,identity,new URLSearchParams(query),now+2000);
test('按实际使用者与订阅所有者归集，订阅合计不重复增加全站次数，未知token不当成零',()=>{
 const value=data();record(value,{usage:{input_tokens:100,output_tokens:30}});record(value,{userId:'owner',usage:{input_tokens:0,output_tokens:0}});record(value,{userId:'bob',source:'personal',modelId:'private-model',status:'failed'});record(value,{status:'cancelled'});
 const all=report(value);assert.equal(all.summary.calls,4);assert.equal(all.summary.success,2);assert.equal(all.summary.failed,1);assert.equal(all.summary.cancelled,1);assert.equal(all.summary.inputTokens,100);assert.equal(all.summary.inputUnknownCalls,2);assert.equal(all.summary.inputKnownCalls,2);assert.equal(all.summary.averageElapsedMs,1000);
 const subscription=report(value,admin,'scope=subscription');assert.equal(subscription.summary.calls,3);assert.deepEqual(subscription.users.map(user=>[user.id,user.calls]),[['alice',2],['owner',1]]);assert.equal(subscription.sources.length,1);
 const mine=report(value,alice);assert.equal(mine.summary.calls,2);assert.equal(mine.filters.users.length,1);assert.ok(!JSON.stringify(mine).includes('private-model'));assert.equal(mine.events.every(event=>event.username==='alice'),true);
});
test('普通用户无法越权筛选，管理员可按用户/来源/模型组合筛选，参数严格校验',()=>{
 const value=data();record(value);record(value,{source:'platform',modelId:'deepseek'});
 for(const query of ['scope=all','scope=subscription','userId=bob'])assert.throws(()=>report(value,alice,query),error=>error.status===403);
 for(const query of ['range=90d','page=0','page=-1','page=1.2','source=unknown','scope=unknown','unexpected=1'])assert.throws(()=>report(value,admin,query),error=>error.status===400);
 assert.equal(report(value,admin,'userId=alice&source=platform&modelId=deepseek').summary.calls,1);
});
test('保留超过500条调用，分页与每日汇总一致，重复完成回调不重复累加token',()=>{
 const value=data();for(let index=0;index<501;index++)record(value,{usage:{prompt_tokens:2,completion_tokens:1}});
 Usage.finish(value,value.events[0].id,{usage:{prompt_tokens:100}},null,false,now+2000);
 const all=report(value);assert.equal(all.summary.calls,501);assert.equal(all.summary.inputTokens,1002);assert.equal(all.events.length,50);assert.equal(all.pagination.pages,11);
 assert.equal(report(value,admin,'page=11').events.length,1);assert.equal(all.daily[0].calls,501);
});
test('明细30天/汇总90天分开保留，跨日结束仍归入发起日，历史不因日限重置消失',()=>{
 const value=data();record(value,{time:now-91*DAY});record(value,{time:now-89*DAY});record(value,{time:now-31*DAY});
 const event=record(value,{time:now-DAY,status:'started'});Usage.finish(value,event.id,null,null,false,now);
 record(value);
 assert.equal(value.events.length,2);assert.equal(value.usageStats.rows.length,4);
 const last7=report(value,admin,'range=7d');assert.equal(last7.summary.calls,2);assert.equal(last7.daily.length,7);assert.equal(last7.daily.at(-2).calls,1);assert.equal(last7.daily.at(-1).calls,1);
 assert.equal(report(value).summary.calls,1);
});
test('迁移只保留白名单元数据，升级不重复统计，重启中断请求明确标记失败而非永远进行中',()=>{
 const value={users:[admin.user,alice.user],events:[{id:'old',userId:'alice',source:'chatgpt',providerId:'fixture',modelId:'luna',time:now,status:'success',usage:{input_tokens:7,output_tokens:NaN,apiKey:'private'},prompt:'private',apiKey:'private'}]};
 Usage.initialize(value,'owner',now);assert.ok(!JSON.stringify(value).includes('private'));assert.equal(report(value,admin,'scope=subscription').summary.calls,1);
 const event=record(value,{status:'started'});Usage.initialize(value,'owner',now+100);Usage.initialize(value,'owner',now+200);
 assert.equal(report(value).summary.calls,2);assert.equal(report(value).summary.failed,1);assert.equal(value.events.find(row=>row.id===event.id).errorCode,'process-restarted');
});
test('缺失用量显示未知，失败响应已返回的token仍保留，恶意错误文本不进入明细',()=>{
 const value=data(),event=record(value,{status:'started'});
 Usage.finish(value,event.id,null,{code:'secret key text',extra:{usage:{input_tokens:9,output_tokens:0,prompt:'secret'}}},false,now+500);
 const info=report(value);assert.equal(info.summary.inputTokens,9);assert.equal(info.summary.outputTokens,0);assert.equal(info.events[0].errorCode,'request-failed');assert.ok(!JSON.stringify(info).includes('secret'));
 const blank=report(data());assert.equal(blank.summary.inputTokens,null);assert.equal(blank.summary.averageElapsedMs,null);
});
test('获取模型列表可单独筛选，按模型保留来源差异且调用总数不被重复计算',()=>{
 const value=data();record(value,{source:'platform',modelId:''});record(value,{source:'personal',modelId:''});
 assert.equal(report(value,admin,'modelId=__catalog__').summary.calls,2);assert.equal(report(value,admin,'modelId=__catalog__&source=personal').summary.calls,1);
});
test('缓存字段严格白名单，兼容Responses、Chat、DeepSeek和独立缓存输入分类',()=>{
 const safe=Usage.safeUsage({input_tokens:1000,input_tokens_details:{cached_tokens:800,secret:'private'},apiKey:'private'});
 assert.deepEqual(safe,{input_tokens:1000,input_tokens_details:{cached_tokens:800}});
 for(const [usage,cached,total]of [
  [safe,800,1000],
  [{prompt_tokens:1000,prompt_tokens_details:{cached_tokens:0}},0,1000],
  [{prompt_cache_hit_tokens:800,prompt_cache_miss_tokens:200},800,1000],
  [{input_tokens:100,cache_read_input_tokens:800,cache_creation_input_tokens:100},800,1000],
  [{input_tokens:100,cache_read_input_tokens:800},800,null],
  [{prompt_tokens:100},null,100],
  [{prompt_tokens:100,prompt_tokens_details:{cached_tokens:101}},null,100],
  [{input_tokens:100,input_tokens_details:{cached_tokens:-1}},null,100],
 ])assert.deepEqual(Usage.cacheUsage(usage),{cachedTokens:cached,inputTokens:total});
 assert.ok(!JSON.stringify(safe).includes('private'));
});
test('缓存汇总按已返回数据的输入加权，零命中与未提供不同，用户筛选和重放不重复统计',()=>{
 const value=data();const first=record(value,{usage:{input_tokens:1000,output_tokens:1,input_tokens_details:{cached_tokens:800}}});
 record(value,{usage:{prompt_tokens:9000,completion_tokens:1,prompt_tokens_details:{cached_tokens:900}}});record(value,{usage:{input_tokens:500,output_tokens:1}});
 record(value,{userId:'bob',usage:{input_tokens:1000,output_tokens:1,input_tokens_details:{cached_tokens:0}}});
 Usage.finish(value,first.id,{usage:{input_tokens:999,input_tokens_details:{cached_tokens:999}}},null,false,now+2000);
 assert.deepEqual(report(value,alice).summary.cache,{cachedTokens:1700,inputTokens:10000,hitRate:17,knownCalls:2,unknownCalls:1});
 const bob=report(value,admin,'userId=bob');assert.equal(bob.summary.cache.cachedTokens,0);assert.equal(bob.summary.cache.hitRate,0);
 const missing=report(value,alice).events.find(e=>e.inputTokens===500);assert.equal(missing.cache.cachedTokens,null);
 const restarted=structuredClone(value);Usage.initialize(restarted,'owner',now+1000);assert.deepEqual(report(restarted,alice).summary.cache,report(value,alice).summary.cache);
 record(value,{usage:{prompt_tokens_details:{cached_tokens:10}}});assert.equal(report(value,alice).summary.cache.hitRate,null);
});
test('已有汇总缺少缓存列时保留调用量，新完成请求可以增量统计且不伪造旧命中',()=>{
 const value=data();record(value,{usage:{input_tokens:500,output_tokens:1}});
 for(const row of value.usageStats.rows)for(const key of ['cachedTokens','cacheKnownCalls','cacheInputTokens','cacheInputKnownCalls'])delete row[key];
 Usage.initialize(value,'owner',now+1000);assert.equal(report(value).summary.calls,1);assert.equal(report(value).summary.cache.cachedTokens,null);
 record(value,{usage:{input_tokens:1000,output_tokens:1,input_tokens_details:{cached_tokens:800}}});
 assert.equal(report(value).summary.calls,2);assert.deepEqual(report(value).summary.cache,{cachedTokens:800,inputTokens:1000,hitRate:80,knownCalls:1,unknownCalls:1});
});
