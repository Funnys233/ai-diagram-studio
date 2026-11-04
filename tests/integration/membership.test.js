const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
// Permission checks happen before HTTP generation; resolve the fixture address without external DNS.
const dns=require('node:dns').promises,lookup=dns.lookup;dns.lookup=async(host,options)=>host==='api.fixture.example'?[{address:'8.8.8.8',family:4}]:lookup(host,options);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-membership-'));
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'12345678',CLOUD_CHATGPT_OWNER:'admin',DEEPSEEK_API_KEY:''});
const {createServer,cloudRuntime:cloud,chatgptCloud:subscription}=require('../../server');
const {CloudRuntime}=require('../../lib/cloud-runtime');
let app,base,owner,free,pro,max,providerId,calls=[];
async function api(client,route,body,method=body===undefined?'GET':'POST',extra={}){
 return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...extra}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,text,headers:res.headers});});});req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});
}
async function login(username){const r=await api(null,'/api/auth/login',{username,password:'12345678'});assert.equal(r.status,200);return {...r.data,cookie:r.headers['set-cookie'][0].split(';')[0]};}
const expiry=()=>Date.now()+30*86400000;
const setMember=(client,plan,expiresAt=plan==='free'?null:expiry())=>api(owner,'/api/users/'+client.user.id+'/membership',{plan,expiresAt},'PUT');
const usage=async client=>(await api(client,'/api/usage')).data.usage;
const message=(client,modelId)=>api(client,'/api/conversation',{providerId,modelId,message:'hello',stream:true});
test.before(async()=>{
 const account={id:crypto.randomUUID(),clientId:'oaiapp_membership',accessToken:'fixture-private-token',refreshToken:'fixture-refresh-token',expiresAt:Date.now()+86400000,scopes:['chatgpt.tokens.use.direct'],models:['gpt-6-luna','gpt-6.1-sol','gpt-6-astra','private-model'].map(modelId=>({modelId,displayName:modelId,enabled:true,reasoningLevels:['low','high','max'],supportsNone:true,defaultEffort:'low'})),preferences:{}};
 subscription.data.accounts.push(account);subscription.data.activeId=account.id;subscription.save();providerId='chatgpt:'+account.id;
 for(const modelId of ['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'])subscription.shareModel(modelId);
 subscription.post=async(url,headers,body,timeout,options)=>{calls.push(body);const emit=data=>options.onEvent({data:JSON.stringify(data)});emit({type:'response.output_text.delta',delta:'会员测试回复'});emit({type:'response.completed',response:{status:'completed',model:body.model,usage:{input_tokens:100,output_tokens:100}}});return {status:200,streaming:true};};
 app=createServer();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;owner=await login('admin');
 for(const username of ['freeuser','prouser','maxuser'])assert.equal((await api(owner,'/api/users',{username,password:'12345678'})).status,201);
 free=await login('freeuser');pro=await login('prouser');max=await login('maxuser');
 await cloud.platform.createProvider({providerId:'members',name:'平台会员模型',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-api-key'});
 for(const modelId of ['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'])await cloud.platform.addModel('members',{modelId,displayName:modelId});
});
test.beforeEach(()=>{calls=[];cloud.change(data=>{delete data.membershipPlans;data.membershipAudit=[];for(const user of data.users){delete user.weeklyLimitPoints;user.membership={plan:user.id===pro.user.id?'pro':user.id===max.user.id?'max':'free',expiresAt:user.id===pro.user.id||user.id===max.user.id?expiry():null};}delete data.weeklyQuota;data.usage={date:new Date().toISOString().slice(0,10),total:0,platform:0,users:{}};data.events=[];data.usageStats.rows=[];});});
test.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
test('两个目录按会员开放模型，平台与订阅同样受限，连接管理仍仅所有者',async()=>{
 for(const [client,models,limit] of [[free,['gpt-6-luna'],1000],[pro,['gpt-6-luna','gpt-6.1-sol'],5000],[max,['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'],20000]]){
  for(const route of ['/api/models/catalog','/api/conversation/models']){const result=await api(client,route);assert.equal(result.status,200);for(const id of [providerId,'platform:members'])assert.deepEqual(result.data.providers.find(p=>p.providerId===id).models.map(m=>m.modelId),models);assert.doesNotMatch(result.text,/fixture-private-token|fixture-refresh-token/);}
  assert.equal((await usage(client)).weekly.limitPoints,limit);assert.equal((await api(client,'/api/chatgpt')).status,403);
 }
 assert.equal((await api(owner,'/api/models/catalog')).data.providers.find(p=>p.providerId===providerId).models.length,4);
});
test('伪造模型与偏好不能越级，拒绝请求不产生上游调用或消费',async()=>{
 for(const [client,modelId] of [[free,'gpt-6.1-sol'],[free,'gpt-6-astra'],[pro,'gpt-6-astra']]){
  for(const route of ['/api/conversation','/api/chat','/api/vision/edit']){const xml=require('../helpers/fixtures').sampleModel();const result=await api(client,route,{providerId,modelId,message:'hello',...(route==='/api/vision/edit'?{editMode:'multimodal',currentXml:xml,vision:{image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',baseXml:xml}}:{})});assert.equal(result.status,403);assert.equal(result.data.error.code,'membership-required');}
  assert.equal((await api(client,'/api/preferences',{providerId,modelId,reasoningEffort:'low'},'PUT')).status,403);
  const user=cloud.data.users.find(u=>u.id===client.user.id),session=cloud.data.sessions.find(s=>s.userId===user.id);
  assert.throws(()=>cloud.callOptions({identity:{user,session}},'platform','members',modelId).beforeCall(),{code:'membership-required'});
 }
 assert.equal(calls.length,0);assert.equal(cloud.data.events.length,0);assert.equal((await usage(free)).weekly.usedPoints,0);
 assert.equal((await message(max,'private-model')).status,403);
});
test('三档真实模拟回复按各自周池扣点，Sol三十倍、Astra三百倍和每轮回执保持',async()=>{
 for(const [client,modelId,points] of [[free,'gpt-6-luna',.6],[pro,'gpt-6.1-sol',18],[max,'gpt-6-astra',180]]){
  const result=await message(client,modelId);assert.equal(result.status,200);assert.match(result.text,/event: result/);assert.match(result.text,new RegExp('"weeklyPoints":'+points));
  assert.equal((await usage(client)).weekly.usedPoints,points);assert.equal((await usage(client)).free.calls,0);
 }
 assert.equal(calls.length,3);assert.equal((await usage(owner)).weekly.usedPoints,0);
});
test('升级续期不清空消耗，到期立即回落额度和权限，已有会话不能绕过',async()=>{
 await message(free,'gpt-6-luna');assert.equal((await setMember(free,'pro')).status,200);
 assert.equal((await usage(free)).weekly.remainingPoints,4999.4);assert.equal((await message(free,'gpt-6.1-sol')).status,200);
 const old=cloud.data.users.find(u=>u.id===free.user.id).membership.expiresAt;
 assert.equal((await setMember(free,'pro',old+30*86400000)).status,200);assert.equal((await usage(free)).weekly.usedPoints,18.6);
 await setMember(free,'max');assert.equal((await usage(free)).weekly.limitPoints,20000);
 cloud.change(data=>{data.users.find(u=>u.id===free.user.id).membership.expiresAt=Date.now()-1;});
 const snapshot=await usage(free);assert.equal(snapshot.membership.plan,'free');assert.equal(snapshot.membership.expired,true);assert.equal(snapshot.weekly.limitPoints,1000);assert.equal(snapshot.weekly.usedPoints,18.6);
 assert.equal((await message(free,'gpt-6-astra')).status,403);assert.equal((await message(free,'gpt-6.1-sol')).status,403);assert.equal(calls.length,2);
 const user=cloud.data.users.find(u=>u.id===free.user.id);assert.equal((await api(free,'/api/auth/session')).data.user.membership.plan,'free');
 const restored=new CloudRuntime(process.env,process.cwd());assert.equal(restored.membershipFor(user.id).plan,'free');assert.equal(restored.usage(user.id).weekly.usedPoints,18.6);
});
test('后台等级额度、特殊额度和恢复继承即时生效，审计与重启保留',async()=>{
 await message(pro,'gpt-6.1-sol');
 assert.equal((await api(owner,'/api/membership',{plans:{free:1200,pro:6000,max:25000}},'PUT')).status,200);
 assert.equal((await usage(free)).weekly.limitPoints,1200);assert.equal((await usage(pro)).weekly.limitPoints,6000);assert.equal((await usage(pro)).weekly.usedPoints,18);
 const route='/api/users/'+pro.user.id+'/weekly-limit';assert.equal((await api(owner,route,{limitPoints:7000},'PUT')).status,200);
 await setMember(pro,'max');assert.equal((await usage(pro)).weekly.limitPoints,7000);
 assert.equal((await api(owner,route,undefined,'DELETE')).status,200);assert.equal((await usage(pro)).weekly.limitPoints,25000);assert.equal((await usage(pro)).weekly.usedPoints,18);
 const settings=(await api(owner,'/api/membership')).data;assert.equal(settings.audit.length,4);assert.equal(settings.audit[0].actorUsername,'admin');assert.equal(settings.audit[0].targetUsername,'prouser');
 const restored=new CloudRuntime(process.env,process.cwd());assert.equal(restored.weeklyLimit(pro.user.id),25000);assert.equal(restored.data.membershipAudit.length,4);assert.equal(restored.weeklySnapshot(pro.user.id).usedPoints,18);
});
test('普通用户不能升级自己，管理接口校验CSRF、未知字段、期限与额度范围',async()=>{
 const route='/api/users/'+free.user.id+'/membership',body={plan:'max',expiresAt:expiry()};
 assert.equal((await api(null,route,body,'PUT')).status,401);assert.equal((await api(free,route,body,'PUT')).status,403);assert.equal((await api(owner,route,body,'PUT',{'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await api(free,'/api/membership')).status,403);assert.equal((await api(free,'/api/users/'+free.user.id+'/weekly-limit',undefined,'DELETE')).status,403);
 for(const bad of [{plan:'vip',expiresAt:expiry()},{plan:'max',expiresAt:Date.now()-1},{plan:'pro',expiresAt:null},{plan:'pro',expiresAt:expiry(),role:'admin'},{plan:'free',expiresAt:expiry()}])assert.equal((await api(owner,route,bad,'PUT')).status,400);
 for(const plans of [{free:1000,pro:500,max:20000},{free:1000,pro:5000,max:1000001},{free:1000,pro:'5000',max:20000},{free:1000,pro:5000,max:20000,other:1}])assert.equal((await api(owner,'/api/membership',{plans},'PUT')).status,400);
 assert.equal((await usage(free)).membership.plan,'free');assert.equal(cloud.data.membershipAudit.length,0);
});
test('会员到期拦截新的重试，已发起请求仍完整结算，个人API不受会员门槛影响',async()=>{
 const user=cloud.data.users.find(u=>u.id===pro.user.id),session=cloud.data.sessions.find(s=>s.userId===user.id),req={identity:{user,session}};
 const options=cloud.callOptions(req,'chatgpt',providerId,'gpt-6.1-sol'),id=options.beforeCall({reasoningEffort:'low'});
 cloud.change(data=>{data.users.find(u=>u.id===pro.user.id).membership.expiresAt=Date.now()-1;});
 options.afterCall(id,{usage:{input_tokens:100,output_tokens:100}},null);assert.equal(cloud.weeklySnapshot(user.id).usedPoints,18);
 assert.throws(()=>options.beforeCall(),{code:'membership-required'});
 const personal=cloud.callOptions(req,'personal','mine','gpt-6-astra'),own=personal.beforeCall();personal.afterCall(own,{usage:{input_tokens:100,output_tokens:100}},null);assert.equal(cloud.weeklySnapshot(user.id).usedPoints,18);
});
test('到期后已用超过普通额度时保留消费，等待下周恢复，不清零或产生负余额',async()=>{
 const user=cloud.data.users.find(u=>u.id===max.user.id),session=cloud.data.sessions.find(s=>s.userId===user.id),req={identity:{user,session}};
 const options=cloud.callOptions(req,'chatgpt',providerId,'gpt-6-astra'),id=options.beforeCall({reasoningEffort:'low'});options.afterCall(id,{usage:{input_tokens:1000,output_tokens:1000}},null);
 cloud.change(data=>{data.users.find(u=>u.id===max.user.id).membership.expiresAt=Date.now()-1;});
 const snapshot=cloud.weeklySnapshot(user.id);assert.equal(snapshot.usedPoints,1800);assert.equal(snapshot.limitPoints,1000);assert.equal(snapshot.remainingPoints,0);
 assert.throws(()=>cloud.callOptions(req,'chatgpt',providerId,'gpt-6-luna').beforeCall(),{code:'weekly-limit'});
});
test('Luna专用按普通门槛共享，Terra目录/伪造请求/偏好按Pro门槛且中转按基准减半',async()=>{
 await cloud.platform.createProvider({providerId:'luna-only',name:'luna专用',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-luna-only',models:[{modelId:'gpt-6-luna'}]});
 await cloud.platform.addModel('members',{modelId:'gpt-5.6-terra'});
 for(const client of [free,pro,max])for(const route of ['/api/models/catalog','/api/conversation/models']){
  const providers=(await api(client,route)).data.providers;
  assert.ok(providers.find(p=>p.providerId==='platform:luna-only').models.some(m=>m.modelId==='gpt-6-luna'));
  assert.equal(providers.find(p=>p.providerId==='platform:members').models.some(m=>m.modelId==='gpt-5.6-terra'),client!==free);
 }
 const denied=await api(free,'/api/conversation',{providerId:'platform:members',modelId:'gpt-5.6-terra',message:'绕过选择器'});assert.equal(denied.status,403,denied.text);assert.equal(denied.data.error.code,'membership-required');
 assert.equal((await api(free,'/api/preferences',{providerId:'platform:members',modelId:'gpt-5.6-terra',reasoningEffort:null},'PUT')).status,403);
 assert.equal(calls.length,0);assert.equal(cloud.data.events.length,0);
 for(const client of [pro,max]){
  const user=cloud.data.users.find(u=>u.id===client.user.id),session=cloud.data.sessions.find(s=>s.userId===user.id),req={identity:{user,session}};
  const options=cloud.callOptions(req,'platform','members','gpt-5.6-terra'),id=options.beforeCall({reasoningEffort:'low'});assert.equal(cloud.weeklySnapshot(user.id).reservedPoints,5);
  options.afterCall(id,{usage:{input_tokens:100,output_tokens:100}},null);assert.equal(cloud.weeklySnapshot(user.id).usedPoints,3);assert.equal(cloud.data.events.find(e=>e.id===id).quota.modelMultiplier,5);
 }
 const freeUser=cloud.data.users.find(u=>u.id===free.user.id),session=cloud.data.sessions.find(s=>s.userId===freeUser.id),req={identity:{user:freeUser,session}};
 const personal=cloud.callOptions(req,'personal','mine','gpt-5.6-terra'),id=personal.beforeCall();personal.afterCall(id,{usage:{input_tokens:1000,output_tokens:1000}},null);assert.equal(cloud.weeklySnapshot(freeUser.id).usedPoints,0);
 cloud.change(data=>{data.users.find(u=>u.id===freeUser.id).membership={plan:'trial',expiresAt:null};});
 assert.throws(()=>cloud.callOptions(req,'platform','luna-only','gpt-6-luna').beforeCall(),{code:'trial-model-required'});
 assert.equal((await api(free,'/api/conversation/models')).data.providers.some(p=>p.providerId==='platform:luna-only'),false);
});
test('请求中的旧管理员身份不能在账号停用后继续修改会员与等级额度',()=>{
 const req={identity:{user:cloud.data.users.find(u=>u.id===owner.user.id)}};
 cloud.change(data=>{data.users.find(u=>u.id===owner.user.id).disabled=true;});
 const before=fs.readFileSync(cloud.file);
 assert.throws(()=>cloud.setMembership(req,free.user.id,{plan:'max',expiresAt:expiry()}),{code:'admin-required'});
 assert.throws(()=>cloud.setMembershipPlans(req,{free:1000,pro:5000,max:20000}),{code:'admin-required'});
 assert.deepEqual(fs.readFileSync(cloud.file),before);
});

test('管理员两个模型目录隐藏5.6系列，个人/平台/订阅均覆盖，保留其他用户和历史配置',async()=>{
 cloud.change(data=>{data.users.find(user=>user.id===owner.user.id).disabled=false;});owner=await login('admin');
 const legacy=['gpt-5.6-luna','gpt-5.6-sol','gpt-5.6-terra'];
 const account=subscription.data.accounts.find(a=>'chatgpt:'+a.id===providerId);
 account.models.push(...[...legacy,'gpt-5.60-sol'].map(modelId=>({modelId,displayName:modelId,enabled:true,reasoningLevels:['low'],defaultEffort:'low'})));subscription.save();
 for(const modelId of legacy)subscription.shareModel(modelId);
 await cloud.platform.createProvider({providerId:'legacy-only',name:'历史配置',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-legacy',models:legacy.map(modelId=>({modelId}))});
 await cloud.platform.setDefaultModel('legacy-only','gpt-5.6-sol');
 const personal=cloud.providerStore(owner.user.id);await personal.createProvider({providerId:'legacy-personal',name:'个人历史配置',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-private-legacy',models:[{modelId:'gpt-5.6-luna'}]});
 const before=JSON.stringify({shared:cloud.platform.data,personal:personal.data,subscription:subscription.data,events:cloud.data.events,quota:cloud.data.weeklyQuota});
 for(const route of ['/api/models/catalog','/api/conversation/models']){
  const adminResult=await api(owner,route);assert.equal(adminResult.status,200);const models=adminResult.data.providers.flatMap(p=>p.models.map(m=>m.modelId));
  assert.ok(!models.some(id=>/^gpt-5\.6(?:-|$)/.test(id)));assert.ok(models.includes('gpt-6-luna'));assert.ok(models.includes('gpt-6.1-sol'));assert.ok(models.includes('gpt-6-astra'));assert.ok(models.includes('gpt-5.60-sol'));
  assert.ok(!adminResult.data.providers.some(p=>p.providerId==='platform:legacy-only'||p.providerId==='personal:legacy-personal'));assert.equal(adminResult.data.defaultSelection,null);
  const normalResult=await api(max,route);assert.equal(normalResult.status,200);
  assert.deepEqual(normalResult.data.providers.find(p=>p.providerId==='platform:legacy-only').models.map(m=>m.modelId),legacy);
  assert.deepEqual(normalResult.data.providers.find(p=>p.providerId===providerId).models.filter(m=>legacy.includes(m.modelId)).map(m=>m.modelId),legacy);
 }
 assert.equal(JSON.stringify({shared:cloud.platform.data,personal:personal.data,subscription:subscription.data,events:cloud.data.events,quota:cloud.data.weeklyQuota}),before);assert.equal(calls.length,0);
});
