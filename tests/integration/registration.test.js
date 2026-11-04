const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-register-'));
const freeIds=['deepseek-free','qwen-free','flash-free'];
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'12345678',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeIds.map(modelId=>({providerId:'mota',modelId}))),DEEPSEEK_API_KEY:''});
let modelCalls=0;
const service=require('../../lib/model-service');
service.callWithLock=async(lock,messages,timeout,options)=>{const id=options.beforeCall?.({reasoningEffort:'low'});modelCalls++;const result={text:'本地体验回复',usage:{prompt_tokens:100,completion_tokens:100},finishReason:'stop'};options.onText?.(result.text);options.afterCall?.(id,result,null);return result;};
const {createServer,cloudRuntime:cloud,chatgptCloud:subscription}=require('../../server'),{CloudRuntime}=require('../../lib/cloud-runtime');
let app,base,admin,trial,subscriptionId;
async function api(client,route,body,method=body===undefined?'GET':'POST',extra={}){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...extra}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,text,headers:res.headers});});});req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});}
const client=response=>({...response.data,cookie:response.headers['set-cookie'][0].split(';')[0]});
const register=username=>api(null,'/api/auth/register',{username,password:'12345678'});
const setPlan=(user,plan)=>api(admin,'/api/users/'+user.user.id+'/membership',{plan,expiresAt:['trial','free'].includes(plan)?null:Date.now()+86400000},'PUT');
const message=(user,providerId,modelId)=>api(user,'/api/conversation',{providerId,modelId,message:'测试'});
test.before(async()=>{
 app=createServer();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;admin=client(await api(null,'/api/auth/login',{username:'admin',password:'12345678'}));
 await cloud.platform.createProvider({providerId:'mota',name:'免费共享',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-platform-key'});
 for(const modelId of [...freeIds,'gpt-6-luna','gpt-6.1-sol','gpt-6-astra','future-model'])await cloud.platform.addModel('mota',{modelId,displayName:modelId});
 await cloud.platform.createProvider({providerId:'clone',name:'同名其他来源',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-clone-key',models:[{modelId:freeIds[0]}]});
 const account={id:crypto.randomUUID(),clientId:'oaiapp_registration',accessToken:'fixture-sub-token',refreshToken:'fixture-refresh-token',expiresAt:Date.now()+86400000,scopes:['chatgpt.tokens.use.direct'],models:['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'].map(modelId=>({modelId,displayName:modelId,enabled:true,reasoningLevels:['low'],defaultEffort:'low'})),preferences:{}};
 subscription.data.accounts.push(account);subscription.data.activeId=account.id;subscription.save();subscriptionId='chatgpt:'+account.id;for(const id of ['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'])subscription.shareModel(id);
});
test.beforeEach(()=>{modelCalls=0;cloud.limits.platform=200;cloud.change(data=>{data.loginAttempts={};data.events=[];data.usageStats.rows=[];data.usage={date:new Date().toISOString().slice(0,10),total:0,platform:0,users:{}};data.freeDaily={date:new Date().toISOString().slice(0,10),calls:0};delete data.weeklyQuota;});});
test.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
test('公开注册自动登录为体验用户，零周额度，密码散列和凭据不返回客户端',async()=>{
 const response=await register('NewTrial');assert.equal(response.status,201);trial=client(response);assert.equal(trial.user.username,'newtrial');assert.equal(trial.user.role,'user');assert.equal(trial.user.membership.plan,'trial');assert.equal(trial.user.membership.name,'体验用户');assert.equal(trial.usage.weekly.limitPoints,0);assert.equal(trial.usage.weekly.percent,0);assert.equal(trial.usage.totalCalls,0);assert.equal(modelCalls,0);assert.ok(trial.csrf);assert.match(response.headers['set-cookie'][0],/HttpOnly; SameSite=Strict/);assert.match(response.headers['set-cookie'][0],/Secure/);
 assert.ok(!response.text.includes('salt')&&!response.text.includes('hash'));assert.ok(!fs.readFileSync(path.join(directory,'state.enc'),'utf8').includes('12345678'));
 assert.equal((await api(trial,'/api/auth/session')).data.user.membership.plan,'trial');
 const again=await api(null,'/api/auth/login',{username:'NEWTRIAL',password:'12345678'});assert.equal(again.status,200);assert.equal(again.data.user.membership.plan,'trial');
});
test('体验目录仅保留明确的三个免费模型，个人及订阅模型不可见',async()=>{
 for(const route of ['/api/models/catalog','/api/conversation/models']){const result=await api(trial,route);assert.equal(result.status,200);assert.deepEqual(result.data.providers.flatMap(p=>p.models.map(m=>[p.providerId,m.modelId])),freeIds.map(id=>['platform:mota',id]));}
 assert.deepEqual((await api(trial,'/api/providers')).data,{providers:[],revision:0});assert.equal((await api(trial,'/admin.html')).status,403);
});
test('两个目录按免费名单标记模型，同来源新增模型和同名个人模型不会误归免费',async()=>{
 const personal=cloud.providerStore(admin.user.id);
 await personal.createProvider({providerId:'group-test',name:'分类测试',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-group-key',models:[{modelId:freeIds[0]}]});
 for(const route of ['/api/models/catalog','/api/conversation/models']){
  const result=await api(admin,route);assert.equal(result.status,200);
  const providers=result.data.providers,shared=providers.find(p=>p.providerId==='platform:mota');
  assert.deepEqual(shared.models.filter(m=>m.quotaPool==='free').map(m=>m.modelId),freeIds);assert.ok(shared.models.filter(m=>m.quotaPool==='free').every(m=>m.quotaMultiplier===null));
  assert.equal(shared.models.find(m=>m.modelId==='future-model').quotaPool,'weekly');assert.equal(shared.models.find(m=>m.modelId==='future-model').quotaMultiplier,.5);
  assert.equal(providers.find(p=>p.providerId==='platform:clone').models[0].quotaPool,'weekly');
  assert.equal(providers.find(p=>p.providerId==='personal:group-test').models[0].quotaPool,'personal');assert.equal(providers.find(p=>p.providerId==='personal:group-test').models[0].quotaMultiplier,null);
  const subscription=providers.find(p=>p.providerId===subscriptionId);for(const [modelId,rate]of [['gpt-6-luna',1],['gpt-6.1-sol',30],['gpt-6-astra',300]])assert.equal(subscription.models.find(m=>m.modelId===modelId).quotaMultiplier,rate);
 }
 assert.equal(modelCalls,0);
});
test('免费模型只扣全站日次数，多注册账号不能绕开全站上限',async()=>{
 cloud.limits.platform=3;for(const id of freeIds){const response=await message(trial,'platform:mota',id);assert.equal(response.status,200);assert.equal(response.data.turnUsage.freeCalls,1);assert.equal(response.data.turnUsage.weeklyPoints,0);}
 const other=client(await register('othertrial'));const denied=await message(other,'platform:mota',freeIds[0]);assert.equal(denied.status,429);assert.equal(denied.data.error.code,'daily-limit');assert.equal(modelCalls,3);const usage=(await api(trial,'/api/usage')).data.usage;assert.equal(usage.free.calls,3);assert.equal(usage.weekly.usedPoints,0);assert.equal(usage.weekly.limitPoints,0);
});
test('直接调用周模型、同名其他来源、个人API和共享GPT都被拦截且无模型费用',async()=>{
 const personal=cloud.providerStore(trial.user.id);await personal.createProvider({providerId:'mine',name:'预置个人配置',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-personal-key',models:[{modelId:'private-model'}]});
 for(const [providerId,modelId]of [['platform:mota','gpt-6-luna'],['platform:mota','gpt-6.1-sol'],['platform:mota','gpt-6-astra'],['platform:mota','future-model'],['platform:clone',freeIds[0]],['personal:mine','private-model'],[subscriptionId,'gpt-6-luna']]){const result=await message(trial,providerId,modelId);assert.equal(result.status,403,providerId+'/'+modelId);}
 const usage=(await api(trial,'/api/usage')).data.usage;assert.equal(usage.totalCalls,0);assert.equal(usage.free.calls,0);assert.equal(usage.weekly.usedPoints,0);assert.equal(modelCalls,0);
});
test('体验用户不能配置API、获取远端模型、检测付费模型或自行升级',async()=>{
 for(const [route,body,method]of [['/api/providers',{providerId:'bad'},'POST'],['/api/providers/models/fetch',{baseUrl:'https://api.fixture.example'},'POST'],['/api/providers/platform:mota/models/gpt-6-luna/reasoning-detect',{confirm:true},'POST'],['/api/providers/mine',{},'PUT'],['/api/users/'+trial.user.id+'/membership',{plan:'max',expiresAt:Date.now()+86400000},'PUT']])assert.equal((await api(trial,route,body,method)).status,403,route);
 assert.equal((await api(trial,'/api/preferences',{providerId:'platform:mota',modelId:freeIds[0],reasoningEffort:null},'PUT')).status,200);
 assert.equal((await api(trial,'/api/preferences',{providerId:'platform:mota',modelId:'gpt-6-luna',reasoningEffort:null},'PUT')).status,403);assert.equal(modelCalls,0);
});
test('管理员可升级体验用户到普通、Pro和Max，降回体验保留消费并立即收回权限',async()=>{
 assert.equal((await api(admin,'/api/users/'+trial.user.id+'/weekly-limit',{limitPoints:1000},'PUT')).status,400);
 for(const [plan,id,points]of [['free','gpt-6-luna',.3],['pro','gpt-6.1-sol',9],['max','gpt-6-astra',90]]){assert.equal((await setPlan(trial,plan)).status,200);const response=await message(trial,'platform:mota',id);assert.equal(response.status,200);assert.equal(response.data.turnUsage.weeklyPoints,points);}
 const before=(await api(trial,'/api/usage')).data.usage.weekly.usedPoints;assert.equal(before,99.3);assert.equal((await setPlan(trial,'trial')).status,200);const after=(await api(trial,'/api/usage')).data.usage;assert.equal(after.weekly.usedPoints,before);assert.equal(after.weekly.limitPoints,0);assert.equal(after.weekly.remainingPoints,0);assert.equal((await message(trial,'platform:mota','gpt-6-luna')).status,403);
});
test('注册拒绝跨站、无Origin、非法字段、短密码和重复账号，不能申请管理员或Max',async()=>{
 assert.equal((await api(null,'/api/auth/register',{username:'foreign',password:'12345678'},'POST',{Origin:'https://evil.example'})).status,403);
 assert.equal((await api(null,'/api/auth/register',{username:'foreign',password:'12345678'},'POST',{Origin:''})).status,403);
 for(const body of [{username:'adminhack',password:'12345678',role:'admin'},{username:'maxhack',password:'12345678',membership:{plan:'max'}},{username:'short',password:'1234567'},{username:'bad/user',password:'12345678'}])assert.equal((await api(null,'/api/auth/register',body)).status,400);
 assert.equal((await register('newtrial')).status,409);assert.equal((await api(trial,'/api/auth/register',{username:'loggedin',password:'12345678'})).status,409);assert.equal(cloud.data.users.some(user=>user.username==='adminhack'),false);
});
test('并发同名注册最多创建一个体验账号和一份登录会话',async()=>{
 const responses=await Promise.all([register('paralleltrial'),register('paralleltrial')]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);const rows=cloud.data.users.filter(user=>user.username==='paralleltrial');assert.equal(rows.length,1);assert.equal(rows[0].membership.plan,'trial');assert.equal(cloud.data.sessions.filter(row=>row.userId===rows[0].id).length,1);assert.equal(cloud.registrations,0);
});
test('注册限频持久化，伪造代理头不能清除，旧普通账号仍保留原权限',async()=>{
 for(let i=0;i<10;i++)assert.equal((await api(null,'/api/auth/register',{username:'admin',password:'12345678'},'POST',{'X-Forwarded-For':'203.0.113.'+i})).status,409);
 assert.equal((await register('limitedtrial')).status,429);const restored=new CloudRuntime(process.env,process.cwd());await assert.rejects(()=>restored.register({headers:{host:'diagram.example',origin:'https://diagram.example'},socket:{remoteAddress:'127.0.0.1'}},{username:'limitedtrial',password:'12345678'},{setHeader(){}}),{code:'register-limited'});
 const created=await api(admin,'/api/users',{username:'invited-user',password:'12345678'});assert.equal(created.status,201);assert.equal(cloud.membershipFor(created.data.user.id).plan,'free');assert.equal(cloud.memberModelAllowed(created.data.user.id,'gpt-6-luna'),true);
});
