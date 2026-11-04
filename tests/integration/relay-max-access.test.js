'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const dns=require('node:dns').promises,lookup=dns.lookup;dns.lookup=async(host,options)=>host.endsWith('.fixture.example')?[{address:'8.8.8.8',family:4}]:lookup(host,options);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-relay-max-'));
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_RESTRICTED_RELAY_PROVIDER_IDS:'relay-anchor,relay-claude',CLOUD_FREE_MODELS:JSON.stringify(['free-a','free-b','free-c'].map(modelId=>({providerId:'free-models',modelId}))),DEEPSEEK_API_KEY:''});
const calls=[];
require('../../lib/model-service').callWithLock=async(lock,messages,timeout,options)=>{const id=options.beforeCall?.({reasoningEffort:'low'});calls.push(lock.model.modelId);const result={text:'本地测试',usage:{input_tokens:100,output_tokens:100}};options.onText?.(result.text);options.afterCall?.(id,result,null);return result;};
const {createServer,cloudRuntime:cloud,chatgptCloud:subscription}=require('../../server');
let app,base,admin,free,pro,max,trial,subscriptionId;
function api(client,route,body,method=body===undefined?'GET':'POST'){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{})}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,text,headers:res.headers});});});req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});}
async function login(username){const r=await api(null,'/api/auth/login',{username,password:'fixture-password-123'});assert.equal(r.status,200);return {...r.data,cookie:r.headers['set-cookie'][0].split(';')[0]};}
const reqFor=client=>({identity:{user:cloud.data.users.find(u=>u.id===client.user.id),session:cloud.data.sessions.find(s=>s.userId===client.user.id)}});
const conversation=(client,providerId,modelId)=>api(client,'/api/conversation',{providerId,modelId,message:'测试'});
test.before(async()=>{
 app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;admin=await login('admin');
 for(const username of ['free','pro','max','trial'])await cloud.createUser(reqFor(admin),{username,password:'fixture-password-123'});
 cloud.change(data=>{for(const user of data.users)if(user.username!=='admin')user.membership={plan:user.username,expiresAt:['pro','max'].includes(user.username)?Date.now()+86400000:null};});
 [free,pro,max,trial]=await Promise.all(['free','pro','max','trial'].map(login));
 const add=(providerId,baseUrl,ids)=>cloud.platform.createProvider({providerId,name:providerId,baseUrl,protocol:'openai-chat-completions',apiKey:'fixture-key',models:ids.map(modelId=>({modelId}))});
 await add('free-models','https://free.fixture.example/v1',['free-a','free-b','free-c']);
 await add('relay-anchor','https://relay.fixture.example/v1',['gpt-6-luna','gpt-6.1-sol','gpt-6-astra','grok-4.7','claude-opus-5-5','qwen-future','openai/gpt-7','x-ai/grok-5','my-gpt-other']);
 await add('relay-claude','https://relay.fixture.example/v2',['claude-sonnet-5-5','claude-fable-5.1']);
 await add('new-alias','https://relay.fixture.example/new/v1',['llama-next']);
 await add('other-provider','https://other.fixture.example/v1',['claude-opus-5-5','qwen-future']);
 await cloud.providerStore(free.user.id).createProvider({providerId:'mine',name:'个人 API',baseUrl:'https://relay.fixture.example/v1',protocol:'openai-chat-completions',apiKey:'fixture-personal',models:[{modelId:'claude-opus-5-5'}]});
 const account={id:crypto.randomUUID(),clientId:'fixture-subscription',accessToken:'fixture-subscription',refreshToken:'fixture-refresh',expiresAt:Date.now()+86400000,scopes:['chatgpt.tokens.use.direct'],models:[{modelId:'claude-opus-5-5',displayName:'Claude',enabled:true,reasoningLevels:['low']}],preferences:{}};
 subscription.data.accounts.push(account);subscription.data.activeId=account.id;subscription.save();subscriptionId='chatgpt:'+account.id;subscription.shareModel('claude-opus-5-5');
});
test.after(async()=>{await Promise.all([app.agentTasks.close(),app.conversationTasks.close(),app.drawingTasks.close()]);app.closeAllConnections();await new Promise(r=>app.close(r));fs.rmSync(directory,{recursive:true,force:true});});
test('目录中普通和 Pro 仅保留原先可用的 GPT/Grok；中转其他模型与新同站入口仅 Max 可见',async()=>{
 for(const route of ['/api/models/catalog','/api/conversation/models'])for(const client of [free,pro,max,admin,trial]){
  const r=await api(client,route);assert.equal(r.status,200);
  const ids=provider=>r.data.providers.find(p=>p.providerId===provider)?.models.map(m=>m.modelId)||[];
  if(client===trial){assert.deepEqual(ids('platform:free-models'),['free-a','free-b','free-c']);assert.deepEqual(ids('platform:relay-anchor'),[]);continue;}
  assert.ok(ids('platform:relay-anchor').includes('gpt-6-luna'));
  assert.equal(ids('platform:relay-anchor').includes('gpt-6.1-sol'),[pro,max,admin].includes(client));
  assert.equal(ids('platform:relay-anchor').includes('gpt-6-astra'),[max,admin].includes(client));
  assert.equal(ids('platform:relay-anchor').includes('grok-4.7'),[pro,max,admin].includes(client));
  for(const model of ['claude-opus-5-5','qwen-future','my-gpt-other'])assert.equal(ids('platform:relay-anchor').includes(model),[max,admin].includes(client));
  assert.equal(ids('platform:relay-claude').includes('claude-sonnet-5-5'),[max,admin].includes(client));
  assert.equal(ids('platform:new-alias').includes('llama-next'),[max,admin].includes(client));
  assert.equal(ids('platform:other-provider').includes('qwen-future'),true);
  assert.equal(ids('platform:other-provider').includes('claude-opus-5-5'),[pro,max,admin].includes(client));
  assert.equal(ids(subscriptionId).includes('claude-opus-5-5'),[pro,max,admin].includes(client));
  if(client===free)assert.deepEqual(ids('personal:mine'),['claude-opus-5-5']);
 }
});
test('直接请求、偏好和调用前复核都阻止非 Max 使用中转其他模型，拒绝不扣点',async()=>{
 calls.length=0;const before=cloud.weeklySnapshot(pro.user.id).usedPoints;
 for(const id of ['claude-opus-5-5','qwen-future','my-gpt-other']){
  const r=await conversation(pro,'platform:relay-anchor',id);assert.equal(r.status,403);assert.equal(r.data.error.code,'membership-required');assert.match(r.data.error.message,/Max/);
  assert.equal((await api(pro,'/api/preferences',{providerId:'platform:relay-anchor',modelId:id,thinkingMode:'default'},'PUT')).status,403);
  assert.throws(()=>cloud.callOptions(reqFor(pro),'platform','relay-anchor',id).beforeCall(),{code:'membership-required'});
  assert.throws(()=>cloud.callOptions(reqFor(pro),'platform','platform:relay-anchor',id).beforeCall(),{code:'membership-required'});
 }
 assert.equal((await conversation(pro,'platform:new-alias','llama-next')).status,403);assert.equal(calls.length,0);assert.equal(cloud.weeklySnapshot(pro.user.id).usedPoints,before);
});
test('Max 可调用新限制模型；中转 GPT/Grok、其他平台及个人 API 保持原来的计费和权限',async()=>{
 for(const [client,providerId,modelId] of [[max,'platform:relay-claude','claude-sonnet-5-5'],[max,'platform:new-alias','llama-next'],[pro,'platform:relay-anchor','gpt-6.1-sol'],[pro,'platform:relay-anchor','grok-4.7'],[pro,'platform:other-provider','claude-opus-5-5'],[free,'personal:mine','claude-opus-5-5']]){
  const r=await conversation(client,providerId,modelId);assert.equal(r.status,200,r.text);
  if(providerId==='personal:mine')assert.equal(r.data.turnUsage.weeklyPoints,0);
 }
 assert.equal(calls.length,6);
});
test('会员到期会撤销 Max 模型权限，已经发起的调用按原规则结算',()=>{
 const options=cloud.callOptions(reqFor(max),'platform','relay-claude','claude-fable-5.1'),id=options.beforeCall();
 cloud.change(data=>{data.users.find(u=>u.id===max.user.id).membership.expiresAt=Date.now()-1;});
 options.afterCall(id,{usage:{input_tokens:100,output_tokens:100}},null);
 assert.equal(cloud.data.events.find(event=>event.id===id).quota.points,90);
 assert.throws(()=>options.beforeCall(),{code:'membership-required'});
});
