const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {CloudRuntime,codec}=require('../../lib/cloud-runtime'),{publicAddress,pinnedOptions}=require('../../lib/egress-policy');
const env=()=>({APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-cloud-unit-'))});
const request=()=>({headers:{host:'diagram.example',origin:'https://diagram.example'},socket:{remoteAddress:'127.0.0.1'},method:'POST'});
async function login(runtime,username='admin'){const req=request(),res={setHeader(k,v){this.cookie=v;}};const info=await runtime.login(req,{username,password:'fixture-password-123'},res);req.headers.cookie=res.cookie.split(';')[0];req.headers['x-csrf-token']=info.csrf;runtime.authorize(req);return {req,res,info};}
test('云端模式缺少域名、主密钥或初始账号时启动失败，本地不需要云配置',()=>{
 assert.equal(new CloudRuntime({},os.tmpdir()).enabled,false);
 for(const patch of [{PUBLIC_ORIGIN:''},{PUBLIC_ORIGIN:'http://public.example'},{CLOUD_MASTER_KEY:'weak'},{CLOUD_ADMIN_PASSWORD:'short'},{APP_MODE:'invalid'}])assert.throws(()=>new CloudRuntime({...env(),...patch},os.tmpdir()));
});
test('本轮回执合并自动重试，区分实际和估算，并按用户隔离及重启恢复',async()=>{
 const config=env(),runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime),turnId=crypto.randomUUID(),res={};
 req.headers['x-quota-turn-id']=turnId;runtime.beginTurn(req,res);
 assert.equal(res.turnUsage().calls,0);assert.equal(res.turnUsage().status,'settled');
 const options=runtime.callOptions(req,'chatgpt','subscription','gpt-6.1-sol');
 const first=options.beforeCall({reasoningEffort:'low'});options.afterCall(first,{usage:{input_tokens:100,output_tokens:100}},null);
 const retry=options.beforeCall({reasoningEffort:'high'});options.afterCall(retry,null,Error('fixture failure'));
 assert.deepEqual(res.turnUsage(),{turnId,status:'settled',calls:2,weeklyPoints:108,reservedPoints:0,freeCalls:0,personalCalls:0,estimated:true,cache:{cachedTokens:null,inputTokens:null,hitRate:null,knownCalls:0,unknownCalls:2}});
 await runtime.createUser(req,{username:'bob',password:'fixture-password-123'});const bob=await login(runtime,'bob');
 assert.equal(runtime.turnUsage(bob.req.identity.user.id,turnId),null);
 bob.req.headers['x-quota-turn-id']=turnId;const bobRes={};runtime.beginTurn(bob.req,bobRes);
 const own=runtime.callOptions(bob.req,'chatgpt','subscription','gpt-6-luna'),ownId=own.beforeCall();own.afterCall(ownId,{usage:{input_tokens:0,output_tokens:0}},null);
 assert.equal(bobRes.turnUsage().weeklyPoints,.1);assert.equal(res.turnUsage().weeklyPoints,108);
 options.beforeCall({reasoningEffort:'max'});
 assert.equal(res.turnUsage().status,'pending');assert.equal(res.turnUsage().reservedPoints,240);
 const restored=new CloudRuntime(config,os.tmpdir()),receipt=restored.turnUsage(req.identity.user.id,turnId);
 assert.equal(receipt.status,'settled');assert.equal(receipt.weeklyPoints,348);assert.equal(receipt.calls,3);
 assert.equal(new CloudRuntime(config,os.tmpdir()).turnUsage(req.identity.user.id,turnId).weeklyPoints,348);
});
test('免费和个人API回执不伪造点数，非法本轮标识在调用前拒绝',async()=>{
 const runtime=new CloudRuntime({...env(),CLOUD_FREE_MODELS:JSON.stringify([{providerId:'p',modelId:'free'}])},os.tmpdir()),{req}=await login(runtime),res={};
 req.headers['x-quota-turn-id']='not-a-uuid';assert.throws(()=>runtime.beginTurn(req,res),error=>error.code==='invalid-turn-id');
 req.headers['x-quota-turn-id']=crypto.randomUUID();runtime.beginTurn(req,res);
 for(const [source,modelId] of [['platform','free'],['personal','mine']]){const options=runtime.callOptions(req,source,'p',modelId),id=options.beforeCall();options.afterCall(id,{usage:{input_tokens:10000,output_tokens:10000}},null);}
 assert.equal(res.turnUsage().freeCalls,1);assert.equal(res.turnUsage().personalCalls,1);assert.equal(res.turnUsage().weeklyPoints,0);assert.equal(res.turnUsage().calls,2);
});
test('AEAD 每次加密不同，篡改或错误主密钥无法解密，原数据不被替换',()=>{
 const key=crypto.randomBytes(32),c=codec(key),a=c.encode({apiKey:'fixture-secret'}),b=c.encode({apiKey:'fixture-secret'});assert.notEqual(a,b);assert.ok(!a.includes('fixture-secret'));assert.deepEqual(c.decode(a),{apiKey:'fixture-secret'});
 assert.throws(()=>codec(crypto.randomBytes(32)).decode(a));const p=JSON.parse(a);p.tag=Buffer.alloc(16).toString('base64');assert.throws(()=>c.decode(JSON.stringify(p)));
 const config=env(),runtime=new CloudRuntime(config,os.tmpdir()),original=fs.readFileSync(runtime.file);assert.throws(()=>new CloudRuntime({...config,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64')},os.tmpdir()));assert.deepEqual(fs.readFileSync(runtime.file),original);
});
test('登录Cookie受保护，域名、Origin、CSRF、退出、过期均真实生效',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),{req,res}=await login(runtime);assert.match(res.cookie,/__Host-/);assert.match(res.cookie,/HttpOnly/);assert.match(res.cookie,/SameSite=Strict/);assert.match(res.cookie,/Secure/);
 assert.throws(()=>runtime.authorize({...req,headers:{...req.headers,host:'evil.example'}}));assert.throws(()=>runtime.authorize({...req,headers:{...req.headers,origin:'https://evil.example'}}));assert.throws(()=>runtime.authorize({...req,headers:{...req.headers,'x-csrf-token':'wrong'}}));assert.throws(()=>runtime.authorize({...req,headers:{...req.headers,origin:undefined}}));
 runtime.logout(req,res);assert.equal(runtime.session(req),null);const again=await login(runtime);runtime.change(d=>d.sessions.forEach(s=>s.expires=0));assert.equal(runtime.session(again.req),null);
});
test('登录失败限流持久化，换服务器实例不能清空失败计数',async()=>{
 const config=env(),runtime=new CloudRuntime(config,os.tmpdir());for(let i=0;i<8;i++)await assert.rejects(runtime.login(request(),{username:'missing',password:'wrong-password-123'},{setHeader(){}}),e=>e.status===401);
 const restored=new CloudRuntime(config,os.tmpdir());await assert.rejects(restored.login(request(),{username:'missing',password:'wrong-password-123'},{setHeader(){}}),e=>e.status===429);
});
test('平台与个人配置分开保存，跨账号只会查询当前账号，密钥磁盘加密',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),admin=await login(runtime);await runtime.createUser(admin.req,{username:'alice',password:'fixture-password-123'});await runtime.createUser(admin.req,{username:'bob',password:'fixture-password-123'});const alice=await login(runtime,'alice'),bob=await login(runtime,'bob');
 const a=runtime.management(alice.req).store,b=runtime.management(bob.req).store;await a.createProvider({providerId:'same',name:'alice',protocol:'openai-chat-completions',baseUrl:'https://api.example',apiKey:'alice-secret-fixture'});await a.addModel('same',{modelId:'m',visionInput:true});
 assert.equal(runtime.select(alice.req,'personal:same').store.getRaw('same').name,'alice');assert.equal(runtime.select(bob.req,'personal:same').store.getRaw('same'),null);
 assert.throws(()=>runtime.management({...alice.req,headers:{...alice.req.headers,'x-provider-scope':'platform'}}),e=>e.status===403);assert.throws(()=>runtime.select(alice.req,'personal:'+bob.req.identity.user.id+':same'));
 assert.ok(!fs.readFileSync(a.filePath,'utf8').includes('alice-secret-fixture'));assert.notEqual(a.filePath,b.filePath);assert.equal(runtime.catalog(bob.req).providers.length,0);
});
test('用户生成偏好独立，平台默认参数不被修改，禁用立即撤销会话',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),admin=await login(runtime);await runtime.createUser(admin.req,{username:'alice',password:'fixture-password-123'});const alice=await login(runtime,'alice');
 await runtime.platform.createProvider({providerId:'p',name:'platform',protocol:'openai-chat-completions',baseUrl:'https://api.example',apiKey:'platform-fixture'});await runtime.platform.addModel('p',{modelId:'m',thinkingMode:'enable-thinking-off'});
 runtime.preference(alice.req,{providerId:'platform:p',modelId:'m',thinkingMode:'enable-thinking-on'});assert.equal(runtime.catalog(alice.req).providers[0].models[0].thinkingMode,'enable-thinking-on');assert.equal(runtime.platform.getRaw('p').models[0].thinkingMode,'enable-thinking-off');assert.equal(runtime.catalog(admin.req).providers[0].models[0].thinkingMode,'enable-thinking-off');
 runtime.disableUser(admin.req,alice.req.identity.user.id,true);assert.equal(runtime.session(alice.req),null);
});
test('免费池按真实尝试持久化，个人 API 只统计且旧个人日限配置不再拦截',async()=>{
 const config={...env(),CLOUD_USER_DAILY_LIMIT:'1',CLOUD_PLATFORM_DAILY_LIMIT:'1',CLOUD_FREE_MODELS:JSON.stringify([{providerId:'p',modelId:'m'}])},runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime);
 runtime.callOptions(req,'platform','p','m').beforeCall();
 const before=fs.readFileSync(runtime.file);assert.throws(()=>runtime.callOptions(req,'platform','p','m').beforeCall(),e=>e.status===429);assert.deepEqual(fs.readFileSync(runtime.file),before);
 for(let i=0;i<3;i++){const options=runtime.callOptions(req,'personal','p','m'),id=options.beforeCall();options.afterCall(id,{usage:{input_tokens:20000,output_tokens:20000}},null);}
 const restored=new CloudRuntime(config,os.tmpdir()),usage=restored.usage(req.identity.user.id);assert.equal(usage.userCalls,4);assert.equal(usage.platformCalls,1);assert.equal(usage.free.calls,1);assert.equal(usage.free.remaining,0);assert.equal(usage.weekly.usedPoints,0);assert.equal(usage.weekly.reservedPoints,0);assert.equal(Object.hasOwn(usage.limits,'user'),false);
});
test('三个免费模型全站共享默认200次，用尽后其他账号被拦截，个人来源仍可使用',async()=>{
 const models=['m','m2','m3'].map(modelId=>({providerId:'p',modelId})),runtime=new CloudRuntime({...env(),CLOUD_FREE_MODELS:JSON.stringify(models)},os.tmpdir()),admin=await login(runtime);
 assert.equal(runtime.limits.weeklyPoints,1000);assert.equal(runtime.limits.platform,200);
 await runtime.createUser(admin.req,{username:'alice',password:'fixture-password-123'});const alice=await login(runtime,'alice');
 for(let i=0;i<199;i++)runtime.callOptions(admin.req,'platform','p',models[i%3].modelId).beforeCall();
 runtime.callOptions(alice.req,'platform','p','m').beforeCall();
 const before=fs.readFileSync(runtime.file);
 assert.throws(()=>runtime.callOptions(admin.req,'platform','p','m3').beforeCall(),e=>e.status===429&&/共享|免费/.test(e.message));assert.deepEqual(fs.readFileSync(runtime.file),before);
 runtime.callOptions(admin.req,'personal','p','m').beforeCall();
 const usage=runtime.usage(admin.req.identity.user.id);assert.equal(usage.free.calls,200);assert.equal(usage.free.remaining,0);assert.equal(usage.platformCalls,200);assert.equal(usage.totalCalls,201);assert.equal(usage.userCalls,200);assert.equal(usage.weekly.usedPoints,0);
 assert.deepEqual(usage.free.models,models.map(m=>({...m,providerId:'platform:'+m.providerId})));
});
test('全站总量超过旧上限仍可调用并统计，次日仅每日统计和免费池恢复',async()=>{
 const config={...env(),CLOUD_TOTAL_DAILY_LIMIT:'1',CLOUD_FREE_MODELS:JSON.stringify([{providerId:'p',modelId:'m'}])},runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime);
 runtime.change(d=>{d.usage.total=1000;});
 for(const source of ['platform','personal','chatgpt']){const options=runtime.callOptions(req,source,'p','m'),id=options.beforeCall();options.afterCall(id,{usage:{input_tokens:10,output_tokens:20}},null);}
 const restored=new CloudRuntime(config,os.tmpdir()),usage=restored.usage(req.identity.user.id);
 assert.equal(Object.hasOwn(usage.limits,'total'),false);assert.equal(usage.totalCalls,1003);assert.equal(usage.userCalls,3);assert.equal(usage.platformCalls,1);assert.equal(usage.free.calls,1);assert.ok(usage.weekly.usedPoints>0);
 restored.change(d=>{d.usage.date='2000-01-01';d.freeDaily.date='2000-01-01';});
 restored.callOptions(req,'platform','p','m').beforeCall();
 const next=restored.usage(req.identity.user.id);assert.equal(next.totalCalls,1);assert.equal(next.userCalls,1);assert.equal(next.platformCalls,1);assert.equal(next.free.calls,1);assert.equal(next.weekly.usedPoints,usage.weekly.usedPoints);assert.equal(next.date,new Date().toISOString().slice(0,10));
});
test('非免费平台和共享订阅扣同一用户周额度，个人来源和目录只计调用统计',async()=>{
 const runtime=new CloudRuntime({...env(),CLOUD_FREE_MODELS:JSON.stringify([{providerId:'p',modelId:'free'}])},os.tmpdir()),{req}=await login(runtime);
 const finish=(source,providerId,modelId,usage)=>{const options=runtime.callOptions(req,source,providerId,modelId),id=options.beforeCall();options.afterCall(id,{usage},null);};
 finish('platform','p','free',{input_tokens:100000,output_tokens:100000});
 finish('platform','new-provider','future-model',{prompt_tokens:100,completion_tokens:50});
 finish('chatgpt','subscription','gpt-shared',{input_tokens:0,output_tokens:0});
 finish('personal','p','free',{input_tokens:100000,output_tokens:100000});
 finish('platform','p','',{input_tokens:100000,output_tokens:100000});
 const usage=runtime.usage(req.identity.user.id);assert.equal(usage.free.calls,1);assert.equal(usage.weekly.usedPoints,.275);assert.equal(usage.weekly.reservedPoints,0);assert.equal(usage.userCalls,5);assert.equal(usage.platformCalls,3);assert.equal(usage.totalCalls,5);
});
test('周额度先按强度预留再按tokens实结，失败和取消不重复结算，未知用量按估算扣点',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),{req}=await login(runtime),options=runtime.callOptions(req,'chatgpt','subscription','gpt');
 const id=options.beforeCall({reasoningEffort:'max'});assert.equal(runtime.usage(req.identity.user.id).weekly.reservedPoints,8);assert.equal(runtime.usage(req.identity.user.id).weekly.usedPoints,0);
 options.afterCall(id,{usage:{input_tokens:100,output_tokens:50}},null);options.afterCall(id,{usage:{input_tokens:100,output_tokens:50}},null);
 assert.equal(runtime.usage(req.identity.user.id).weekly.usedPoints,.35);assert.equal(runtime.usage(req.identity.user.id).weekly.reservedPoints,0);
 const failed=options.beforeCall();options.afterCall(failed,null,Object.assign(Error('fixture upstream error'),{extra:{usage:{input_tokens:100,output_tokens:100}}}));
 assert.equal(runtime.usage(req.identity.user.id).weekly.usedPoints,.95);
 const cancelled=options.beforeCall({reasoningEffort:'low'});options.afterCall(cancelled,null,Object.assign(Error('fixture cancelled'),{name:'AbortError'}));
 const unknown=options.beforeCall({reasoningEffort:'max'});options.afterCall(unknown,{usage:null},null);
 const usage=runtime.usage(req.identity.user.id);assert.equal(usage.weekly.usedPoints,9.95);assert.equal(usage.weekly.reservedPoints,0);assert.equal(usage.weekly.remainingPoints,990.05);
});
test('模型倍率贯穿周额度预留、实结和明细，Astra不足以预留时不增加调用',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),{req}=await login(runtime),userId=req.identity.user.id;
 for(const [modelId,multiplier] of [['gpt-6-luna',1],['gpt-6.1-sol',30],['gpt-6-astra',300]]){
  const options=runtime.callOptions(req,'chatgpt','subscription',modelId),id=options.beforeCall({reasoningEffort:'low'});
  assert.equal(runtime.usage(userId).weekly.reservedPoints,multiplier);
  options.afterCall(id,{usage:{input_tokens:1000,output_tokens:1000}},null);
  const event=runtime.usageReport(req,new URLSearchParams()).events.find(row=>row.id===id);
  assert.equal(event.quota.points,6*multiplier);assert.equal(event.quota.reservedPoints,0);assert.equal(event.quota.policyVersion,6);
 }
 const usage=runtime.usage(userId);assert.equal(usage.weekly.usedPoints,1986);assert.equal(usage.weekly.reservedPoints,0);assert.equal(usage.weekly.remainingPoints,0);
 const before=fs.readFileSync(runtime.file);
 assert.throws(()=>runtime.callOptions(req,'chatgpt','subscription','gpt-6-astra').beforeCall({reasoningEffort:'max'}),e=>e.status===429&&e.code==='weekly-limit');
 assert.deepEqual(fs.readFileSync(runtime.file),before);assert.equal(runtime.usage(userId).userCalls,3);
});
test('模型倍率只作用于周额度，明确列出的免费Astra、个人API和目录仍不扣点',async()=>{
 const config={...env(),CLOUD_FREE_MODELS:JSON.stringify([{providerId:'p',modelId:'gpt-6-astra'}])},runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime);
 for(const [source,providerId,modelId] of [['platform','p','gpt-6-astra'],['personal','p','gpt-6-astra'],['platform','p','']]){
  const options=runtime.callOptions(req,source,providerId,modelId),id=options.beforeCall({reasoningEffort:'max'});
  options.afterCall(id,{usage:{input_tokens:100000,output_tokens:100000}},null);
 }
 let usage=runtime.usage(req.identity.user.id);assert.equal(usage.free.calls,1);assert.equal(usage.weekly.usedPoints,0);assert.equal(usage.weekly.reservedPoints,0);assert.equal(usage.userCalls,3);
 const options=runtime.callOptions(req,'platform','another-provider','gpt-6-astra'),id=options.beforeCall({reasoningEffort:'low'});
 assert.equal(runtime.usage(req.identity.user.id).weekly.reservedPoints,150);
 options.afterCall(id,{usage:{input_tokens:0,output_tokens:0}},null);
 usage=runtime.usage(req.identity.user.id);assert.equal(usage.weekly.usedPoints,15);assert.equal(usage.free.calls,1);assert.equal(usage.totalCalls,4);
});
test('倍率同样作用于未知用量和取消估算，重启后按原倍率恢复且只记一次',async()=>{
 const config=env(),runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime),sol=runtime.callOptions(req,'chatgpt','subscription','gpt-6.1-sol');
 runtime.setWeeklyLimit(req,req.identity.user.id,3000);
 const failed=sol.beforeCall({reasoningEffort:'high'});sol.afterCall(failed,null,Error('fixture upstream error'));
 const cancelled=sol.beforeCall({reasoningEffort:'low'});sol.afterCall(cancelled,null,Object.assign(Error('fixture cancelled'),{name:'AbortError'}));
 const pending=runtime.callOptions(req,'chatgpt','subscription','gpt-6-astra').beforeCall({reasoningEffort:'max'});
 assert.equal(runtime.usage(req.identity.user.id).weekly.usedPoints,120);assert.equal(runtime.usage(req.identity.user.id).weekly.reservedPoints,2400);
 const restored=new CloudRuntime(config,os.tmpdir());assert.equal(restored.usage(req.identity.user.id).weekly.usedPoints,2520);assert.equal(restored.usage(req.identity.user.id).weekly.reservedPoints,0);
 const event=restored.usageReport(req,new URLSearchParams()).events.find(row=>row.id===pending);
 assert.equal(event.quota.points,2400);assert.equal(event.quota.estimated,true);assert.equal(event.quota.policyVersion,6);
 assert.equal(new CloudRuntime(config,os.tmpdir()).usage(req.identity.user.id).weekly.usedPoints,2520);
});
test('旧倍率策略保留已扣金额和未结束请求的原计价，新请求才采用Astra三百倍',async()=>{
 const config=env(),runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime),options=runtime.callOptions(req,'chatgpt','subscription','gpt-6-luna');
 const completed=options.beforeCall();options.afterCall(completed,{usage:{input_tokens:100,output_tokens:50}},null);
 const pending=runtime.callOptions(req,'chatgpt','subscription','gpt-6-astra').beforeCall({reasoningEffort:'medium'});
 runtime.change(data=>{
  data.weeklyQuota.policyVersion=1;
  for(const call of data.weeklyQuota.calls){call.policyVersion=1;delete call.modelMultiplier;delete call.outputWeight;call.modelId='gpt-6-astra';if(call.id===pending)call.reservedCredits=2000;}
  data.weeklyQuota.windows[0].reservedCredits=2000;data.weeklyQuota.windows[0].usedCredits=300;data.weeklyQuota.calls.find(call=>call.id===completed).chargedCredits=300;
  for(const event of data.events){event.modelId='gpt-6-astra';event.quota.policyVersion=1;if(event.id===completed)event.quota.points=.3;if(event.id===pending)event.quota.reservedPoints=2;}
 });
 const restored=new CloudRuntime(config,os.tmpdir());assert.equal(restored.usage(req.identity.user.id).weekly.usedPoints,2.3);assert.equal(restored.usage(req.identity.user.id).weekly.reservedPoints,0);
 const oldEvents=restored.usageReport(req,new URLSearchParams()).events;
 assert.equal(oldEvents.find(row=>row.id===completed).quota.points,.3);assert.equal(oldEvents.find(row=>row.id===pending).quota.points,2);assert.equal(oldEvents.find(row=>row.id===pending).quota.policyVersion,1);
 const next=restored.callOptions(req,'chatgpt','subscription','gpt-6-astra'),id=next.beforeCall({reasoningEffort:'low'});next.afterCall(id,{usage:{input_tokens:1000,output_tokens:0}},null);
 assert.equal(restored.usage(req.identity.user.id).weekly.usedPoints,302.3);assert.equal(restored.usageReport(req,new URLSearchParams()).events.find(row=>row.id===id).quota.policyVersion,6);
 assert.equal(new CloudRuntime(config,os.tmpdir()).usage(req.identity.user.id).weekly.usedPoints,302.3);
});
test('周额度按用户独立，耗尽不新增记录，免费池和个人API不受周额度拦截',async()=>{
 const runtime=new CloudRuntime({...env(),CLOUD_FREE_MODELS:JSON.stringify([{providerId:'p',modelId:'free'}])},os.tmpdir()),admin=await login(runtime);
 await runtime.createUser(admin.req,{username:'alice',password:'fixture-password-123'});const alice=await login(runtime,'alice');runtime.setWeeklyLimit(admin.req,alice.req.identity.user.id,2);
 const options=runtime.callOptions(alice.req,'platform','p','paid'),id=options.beforeCall({reasoningEffort:'low'});options.afterCall(id,{usage:{input_tokens:4000,output_tokens:0}},null);
 const before=fs.readFileSync(runtime.file);assert.throws(()=>options.beforeCall(),e=>e.status===429&&e.code==='weekly-limit');assert.deepEqual(fs.readFileSync(runtime.file),before);
 assert.equal(runtime.usage(alice.req.identity.user.id).weekly.remainingPoints,0);assert.equal(runtime.usage(admin.req.identity.user.id).weekly.usedPoints,0);
 for(const [source,modelId] of [['platform','free'],['personal','paid']])runtime.callOptions(alice.req,source,'p',modelId).beforeCall();
 const other=runtime.callOptions(admin.req,'platform','p','paid'),otherId=other.beforeCall();other.afterCall(otherId,{usage:{input_tokens:0,output_tokens:0}},null);assert.equal(runtime.usage(admin.req.identity.user.id).weekly.usedPoints,.05);
});
test('实际用量超过预留完整记账，重启恢复未结束请求并释放预留，不倒扣旧历史',async()=>{
 const config=env(),runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime);runtime.setWeeklyLimit(req,req.identity.user.id,10);
 const options=runtime.callOptions(req,'platform','p','new'),id=options.beforeCall();options.afterCall(id,{usage:{input_tokens:24000,output_tokens:0}},null);
 assert.equal(runtime.usage(req.identity.user.id).weekly.usedPoints,12);assert.equal(runtime.usage(req.identity.user.id).weekly.remainingPoints,0);assert.throws(()=>options.beforeCall(),e=>e.code==='weekly-limit');
 runtime.setWeeklyLimit(req,req.identity.user.id,1000);options.beforeCall({reasoningEffort:'max'});
 const restored=new CloudRuntime(config,os.tmpdir()),usage=restored.usage(req.identity.user.id);assert.equal(usage.weekly.usedPoints,16);assert.equal(usage.weekly.reservedPoints,0);assert.equal(usage.userCalls,2);
 const again=new CloudRuntime(config,os.tmpdir());assert.equal(again.usage(req.identity.user.id).weekly.usedPoints,16);
});
test('周额度预留和结算写盘失败不发布候选账本，重试结算可完整恢复',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),{req}=await login(runtime),options=runtime.callOptions(req,'platform','p','paid'),old=runtime.file;
 const bad=path.join(runtime.directory,'failed-write');fs.mkdirSync(bad);runtime.file=bad;
 const prior=JSON.stringify(runtime.data);assert.throws(()=>options.beforeCall());assert.equal(JSON.stringify(runtime.data),prior);
 runtime.file=old;const id=options.beforeCall({reasoningEffort:'max'}),reserved=JSON.stringify(runtime.data);runtime.file=bad;
 assert.throws(()=>options.afterCall(id,{usage:{input_tokens:100,output_tokens:50}},null));assert.equal(JSON.stringify(runtime.data),reserved);
 runtime.file=old;options.afterCall(id,{usage:{input_tokens:100,output_tokens:50}},null);assert.equal(runtime.usage(req.identity.user.id).weekly.usedPoints,.175);assert.equal(runtime.usage(req.identity.user.id).weekly.reservedPoints,0);
});
test('写盘失败不发布候选数据，未知token用量不会记录为零',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),{req}=await login(runtime),options=runtime.callOptions(req,'personal','p','m'),id=options.beforeCall();options.afterCall(id,{usage:null},null);assert.equal(runtime.data.events.at(-1).usage,null);
 const old=runtime.file,data=JSON.stringify(runtime.data);runtime.file=path.join(runtime.directory,'missing','file','bad');fs.mkdirSync(runtime.file,{recursive:true});assert.throws(()=>options.beforeCall());assert.equal(JSON.stringify(runtime.data),data);runtime.file=old;
});
test('用量明细和每日汇总重启后恢复，未结束请求标记中断且不改变当天调用计数',async()=>{
 const config={...env(),CLOUD_CHATGPT_OWNER:'admin'},runtime=new CloudRuntime(config,os.tmpdir()),{req}=await login(runtime);
 const completed=runtime.callOptions(req,'chatgpt','subscription','luna'),id=completed.beforeCall();completed.afterCall(id,{usage:{input_tokens:123,output_tokens:45}},null);
 runtime.callOptions(req,'personal','fixture','other').beforeCall();
 const restored=new CloudRuntime(config,os.tmpdir()),info=restored.usageReport(req,new URLSearchParams());
 assert.equal(info.summary.calls,2);assert.equal(info.summary.success,1);assert.equal(info.summary.failed,1);assert.equal(info.summary.inputTokens,123);assert.equal(info.summary.inputUnknownCalls,1);
 assert.equal(restored.usage(req.identity.user.id).userCalls,2);assert.equal(restored.usage(req.identity.user.id).totalCalls,2);
 assert.equal(restored.usageReport(req,new URLSearchParams('scope=subscription')).summary.calls,1);
});
test('并发名额在结束和断开时只释放一次，达到上限不增加占用',async()=>{
 const runtime=new CloudRuntime(env(),os.tmpdir()),{req}=await login(runtime),res=new EventEmitter();runtime.acquire(req,res);assert.throws(()=>runtime.acquire(req,new EventEmitter()),e=>e.status===429);assert.equal(runtime.globalActive,1);res.emit('close');res.emit('finish');assert.equal(runtime.globalActive,0);assert.equal(runtime.active.get(req.identity.user.id),0);
});
test('出站策略拒绝特殊IPv4、IPv6、HTTP、混合DNS与解析变化，连接使用校验过的地址',async()=>{
 for(const ip of ['127.0.0.1','0.0.0.0','10.1.2.3','172.16.2.3','192.168.1.1','169.254.169.254','168.63.129.16','192.88.99.2','192.0.2.1','198.51.100.2','203.0.113.1','100.64.0.1','198.18.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1','2001::1','2002:a00:1::1'])assert.equal(publicAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','203.0.114.1','198.51.101.1','192.0.3.1','2606:4700:4700::1111'])assert.equal(publicAddress(ip),true,ip);
 await assert.rejects(pinnedOptions('http://api.example'));await assert.rejects(pinnedOptions('https://127.0.0.1'));await assert.rejects(pinnedOptions('https://api.example',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));
 let resolutions=0;const options=await pinnedOptions('https://api.example/v1',async()=>{resolutions++;return [{address:'8.8.8.8',family:4}];});assert.equal(options.agent,false);
 await new Promise((resolve,reject)=>options.lookup('api.example',{},(e,address,family)=>{if(e)return reject(e);assert.equal(address,'8.8.8.8');assert.equal(family,4);resolve();}));assert.equal(resolutions,1);
 await new Promise(resolve=>options.lookup('changed.example',{},e=>{assert.ok(e);resolve();}));
});
test('DNS等待有时间上限且取消及时中断，晚到解析不会继续连接',async()=>{
 const never=()=>new Promise(()=>{});
 await assert.rejects(pinnedOptions('https://api.example',never,{timeoutMs:20}),e=>e.code==='dns-timeout');
 const controller=new AbortController();const pending=pinnedOptions('https://api.example',never,{signal:controller.signal});controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');
 await assert.rejects(pinnedOptions('https://api.example',async()=>{throw Error('DNS fixture');}),e=>e.code==='dns-unavailable');
});

test('管理员初始密码只要求8位；修改密码错误限流且重启保留新密码',async()=>{
 const config={...env(),CLOUD_ADMIN_PASSWORD:'12345678'},runtime=new CloudRuntime(config,os.tmpdir());
 const req=request(),res={setHeader(k,v){this.cookie=v;}};
 const auth=await runtime.login(req,{username:'admin',password:'12345678'},res);req.headers.cookie=res.cookie.split(';')[0];req.headers['x-csrf-token']=auth.csrf;runtime.authorize(req);
 for(let i=0;i<8;i++)await assert.rejects(runtime.changePassword(req,{currentPassword:'incorrect',newPassword:'87654321'}),e=>e.code==='wrong-password');
 await assert.rejects(runtime.changePassword(req,{currentPassword:'12345678',newPassword:'87654321'}),e=>e.status===429);
 runtime.change(d=>{for(const b of Object.values(d.loginAttempts))b.until=0;});
 await runtime.changePassword(req,{currentPassword:'12345678',newPassword:'87654321'});
 const restored=new CloudRuntime(config,os.tmpdir());assert.equal(restored.session(req),null);
 assert.equal((await restored.login(request(),{username:'admin',password:'87654321'},{setHeader(){}})).user.username,'admin');
});
