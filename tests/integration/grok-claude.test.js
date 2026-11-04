const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const dns=require('node:dns').promises,lookup=dns.lookup;dns.lookup=async(host,options)=>host==='api.fixture.example'?[{address:'8.8.8.8',family:4}]:lookup(host,options);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-grok-claude-')),rates={'grok-4.6-latest':20,'grok-4.7':25,'claude-sonnet-5-5':30,'claude-opus-5-5':80,'claude-fable-5.1':150};
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(['free-a','free-b','free-c'].map(modelId=>({providerId:'new-models',modelId}))),DEEPSEEK_API_KEY:''});
let calls=[];
require('../../lib/model-service').callWithLock=async(lock,messages,timeout,options)=>{const id=options.beforeCall?.({reasoningEffort:'low'});calls.push(lock.model.modelId);const result={text:'本地测试回复',usage:{input_tokens:100,output_tokens:100}};options.onText?.(result.text);options.afterCall?.(id,result,null);return result;};
const {createServer,cloudRuntime:cloud,chatgptCloud:subscription}=require('../../server');
let app,base,admin,free,pro,max,trial,subscriptionId;
async function api(client,route,body,method=body===undefined?'GET':'POST',extra={}){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...extra}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,headers:res.headers});});});req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});}
async function login(username){const r=await api(null,'/api/auth/login',{username,password:'fixture-password-123'});assert.equal(r.status,200);return {...r.data,cookie:r.headers['set-cookie'][0].split(';')[0]};}
const reqFor=client=>({identity:{user:cloud.data.users.find(u=>u.id===client.user.id),session:cloud.data.sessions.find(s=>s.userId===client.user.id)}});
test.before(async()=>{
 app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;admin=await login('admin');
 for(const username of ['free','pro','max','trial'])await cloud.createUser(reqFor(admin),{username,password:'fixture-password-123'});
 [free,pro,max,trial]=await Promise.all(['free','pro','max','trial'].map(login));
 await cloud.platform.createProvider({providerId:'new-models',name:'新增模型',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-key',models:[...Object.keys(rates),'free-a','free-b','free-c','gpt-6-luna','gpt-6.1-terra'].map(modelId=>({modelId,capabilityProfile:'custom',reasoningLevels:['low']}))});
 await cloud.providerStore(free.user.id).createProvider({providerId:'mine',name:'个人模型',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-personal',models:[{modelId:'claude-fable-5.1'}]});
 const account={id:crypto.randomUUID(),clientId:'oaiapp_model_fixture',accessToken:'fixture-subscription',refreshToken:'fixture-refresh',expiresAt:Date.now()+86400000,scopes:['chatgpt.tokens.use.direct'],models:[...Object.keys(rates),'gpt-6.1-terra'].map(modelId=>({modelId,displayName:modelId,enabled:true,reasoningLevels:['low'],defaultEffort:'low'})),preferences:{}};
 subscription.data.accounts.push(account);subscription.data.activeId=account.id;subscription.save();subscriptionId='chatgpt:'+account.id;for(const id of [...Object.keys(rates),'gpt-6.1-terra'])subscription.shareModel(id);
});
test.beforeEach(()=>{calls=[];cloud.change(data=>{for(const u of data.users)u.membership={plan:u.username==='trial'?'trial':u.username==='pro'?'pro':u.username==='max'?'max':'free',expiresAt:['pro','max'].includes(u.username)?Date.now()+86400000:null};delete data.weeklyQuota;data.events=[];data.usageStats.rows=[];data.usage={date:new Date().toISOString().slice(0,10),total:0,platform:0,users:{}};data.freeDaily={date:new Date().toISOString().slice(0,10),calls:0};});});
test.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));fs.rmSync(directory,{recursive:true,force:true});});
test('两个目录仅向Pro/Max及管理员开放Grok/Claude，显示最终倍率；普通与体验不见共享入口',async()=>{
 for(const client of [admin,free,pro,max,trial])for(const route of ['/api/models/catalog','/api/conversation/models']){
  const r=await api(client,route);assert.equal(r.status,200);const shared=r.data.providers.filter(p=>!p.providerId.startsWith('personal:')).flatMap(p=>p.models);
  for(const [id,rate]of Object.entries(rates)){const matches=shared.filter(m=>m.modelId===id);if([admin,pro,max].includes(client)){assert.ok(matches.length===2);assert.ok(matches.every(m=>m.quotaMultiplier===rate));}else assert.equal(matches.length,0);}
  if(client===trial)assert.equal(shared.length,3);
 }
 assert.equal(calls.length,0);
});
test('直接伪造请求、偏好与付费模型检测也不能绕过普通/体验门槛且没有上游调用',async()=>{
 for(const client of [free,trial])for(const id of Object.keys(rates)){
  const r=await api(client,'/api/conversation',{providerId:'platform:new-models',modelId:id,message:'越权测试'});assert.equal(r.status,403);if(client===free){assert.equal(r.data.error.code,'membership-required');assert.match(r.data.error.message,/Pro/);}
  assert.equal((await api(client,'/api/preferences',{providerId:'platform:new-models',modelId:id,reasoningEffort:'low'},'PUT')).status,403);
  assert.equal((await api(client,'/api/providers/platform:new-models/models/'+id+'/reasoning-detect',{confirm:true})).status,403);
  assert.throws(()=>cloud.callOptions(reqFor(client),'chatgpt',subscriptionId,id).beforeCall(),{code:client===trial?'trial-model-required':'membership-required'});
 }
 assert.equal(calls.length,0);assert.equal(cloud.data.events.length,0);
});
test('Pro/Max实际扣点、预留释放、本轮回执和用量明细均沿用指定倍率',async()=>{
 for(const client of [pro,max])for(const [modelId,rate]of Object.entries(rates)){
  const turnId=crypto.randomUUID(),r=await api(client,'/api/conversation',{providerId:'platform:new-models',modelId,message:'实际费用'},'POST',{'X-Quota-Turn-Id':turnId});assert.equal(r.status,200);
  assert.equal(r.data.turnUsage.weeklyPoints,.6*rate);assert.equal(r.data.turnUsage.reservedPoints,0);assert.equal(r.data.turnUsage.estimated,false);
  const report=(await api(client,'/api/usage/report')).data,event=report.events.find(e=>e.modelId===modelId);assert.equal(event.quota.modelMultiplier,rate);assert.equal(event.quota.points,.6*rate);
 }
 assert.equal(calls.length,10);
});
test('到期后立即撤回新请求权限而旧预留照价结算，个人API仅统计规则保留',async()=>{
 const options=cloud.callOptions(reqFor(pro),'platform','new-models','claude-opus-5-5'),id=options.beforeCall({reasoningEffort:'low'});assert.equal(cloud.weeklySnapshot(pro.user.id).reservedPoints,80);
 cloud.change(data=>{data.users.find(u=>u.id===pro.user.id).membership.expiresAt=Date.now()-1;});options.afterCall(id,{usage:{input_tokens:100,output_tokens:100}},null);assert.equal(cloud.weeklySnapshot(pro.user.id).usedPoints,48);
 assert.throws(()=>options.beforeCall(),{code:'membership-required'});
 const own=await api(free,'/api/conversation',{providerId:'personal:mine',modelId:'claude-fable-5.1',message:'个人测试'});assert.equal(own.status,200);assert.equal(own.data.turnUsage.weeklyPoints,0);assert.equal(own.data.turnUsage.personalCalls,1);
});
test('GPT-6.1 Terra 在两个目录显示20倍，普通用户共享与中转均按20倍计费',async()=>{
 for(const route of ['/api/models/catalog','/api/conversation/models']){
  const result=await api(free,route);assert.equal(result.status,200);
  const matches=result.data.providers.flatMap(p=>p.models).filter(m=>m.modelId==='gpt-6.1-terra');
  assert.equal(matches.length,2);assert.ok(matches.every(m=>m.quotaMultiplier===20));
 }
 for(const [source,id] of [['chatgpt',subscriptionId],['platform','new-models']]){
  const options=cloud.callOptions(reqFor(free),source,id,'gpt-6.1-terra'),call=options.beforeCall({reasoningEffort:'low'});
  options.afterCall(call,{usage:{input_tokens:100,output_tokens:100}},null);
  const event=cloud.data.events.find(row=>row.id===call);assert.equal(event.quota.modelMultiplier,20);assert.equal(event.quota.points,12);
 }
 assert.equal(cloud.weeklySnapshot(free.user.id).usedPoints,24);
});
