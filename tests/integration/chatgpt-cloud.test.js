const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), http = require('node:http');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-vm-test-'));
Object.assign(process.env, { APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://diagram.example', CLOUD_DATA_DIR: directory, CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: '12345678', CLOUD_CHATGPT_OWNER: 'admin', DEEPSEEK_API_KEY: '' });
const { createServer, cloudRuntime: cloud, chatgptCloud: runtime } = require('../../server');
const { ChatGPTCloud } = require('../../lib/chatgpt-cloud');
const { run: backup } = require('../../scripts/cloud-tools.cjs');
const { sampleModel } = require('../helpers/fixtures');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
function bundle() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'vm-test' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', sub: 'personal-vm', aud: 'oaiapp_vm', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+3600, email: 'owner@example.test' })).toString('base64url');
  const idToken = `${header}.${payload}.${crypto.sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
  return { format: 'diagram-chatgpt-vm-v1', hostId: runtime.data.hostId, account: { issuer: 'https://auth.openai.com', subject: 'personal-vm', clientId: 'oaiapp_vm', idToken, accessToken: 'vm-private-access', refreshToken: 'vm-private-refresh', scopes: ['openid', 'chatgpt.tokens.use.direct'], expiresAt: Date.now()+3600000 } };
}
let app, base, owner, other, otherAdmin, calls = [], failure = false, drawing = false;
async function api(client, route, body, method=body===undefined?'GET':'POST', extra={}) {
  return new Promise((resolve,reject) => {
    const req = http.request(base+route, { method, headers: { Host: 'diagram.example', Origin: 'https://diagram.example', 'Content-Type':'application/json', ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}), ...extra } }, res => {
      let text=''; res.on('data', c=>text+=c); res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode, data, text, headers:res.headers});});
    }); req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();
  });
}
async function login(username) { const r = await api(null, '/api/auth/login', { username, password: '12345678' }); assert.equal(r.status,200);return { ...r.data, cookie:r.headers['set-cookie'][0].split(';')[0] }; }
test.before(async()=>{
  runtime.request = async url => {
    if(url.endsWith('jwks.json')) return {status:200,data:{keys:[{...publicKey.export({format:'jwk'}),kid:'vm-test'}]}};
    if(url.endsWith('/models'))return {status:200,data:{models:[{slug:'vm-model',display_name:'VM Model',visibility:'list',input_modalities:['text','image'],supported_reasoning_levels:['none','low','high']}]}};
    if(url.endsWith('openid-configuration'))return {status:200,data:{revocation_endpoint:'https://auth.openai.com/revoke'}};
    if(url.endsWith('/revoke'))return {status:200};
    throw Error('Unexpected URL');
  };
  runtime.post = async(url,headers,body,timeout,options)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(headers.Authorization,'Bearer vm-private-access');calls.push(body);
    const emit=data=>options.onEvent({data:JSON.stringify(data)});
    emit({type:'response.output_text.delta',delta:drawing?sampleModel():'云端订阅对话正常。'});
    if(failure)emit({type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}});
    else emit({type:'response.completed',response:{status:'completed',model:'vm-model'}});
    return {status:200,streaming:true};
  };
  app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;
  owner=await login('admin');
  for(const username of ['alice','secondadmin'])assert.equal((await api(owner,'/api/users',{username,password:'12345678'})).status,201);
  cloud.change(d=>{d.users.find(u=>u.username==='secondadmin').role='admin';});
  other=await login('alice');otherAdmin=await login('secondadmin');
});
test.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));fs.rmSync(directory,{recursive:true,force:true});});
test('VM host identity is stable, encrypted, backed up, and rejects a different owner or VM',async()=>{
  const initial=runtime.data.hostId;
  const input=bundle();await assert.rejects(runtime.importConnection({...input,hostId:'urn:uuid:'+crypto.randomUUID()}));
  await assert.rejects(runtime.importConnection({...input,account:{...input.account,subject:'forged'}}));
  await assert.rejects(runtime.importConnection({...input,account:{...input.account,scopes:['openid']}}));
  await runtime.importConnection(input);await runtime.refreshModels();
  assert.equal(runtime.data.hostId,initial);assert.equal(new ChatGPTCloud({cloud,ownerUsername:'admin'}).data.hostId,initial);
  assert.throws(()=>new ChatGPTCloud({cloud,ownerUsername:'secondadmin'}));
  const disk=fs.readFileSync(runtime.filePath,'utf8');assert.doesNotMatch(disk,/vm-private|owner@example/);assert.equal(fs.statSync(runtime.filePath).mode&0o777,0o600);
  const file=path.join(directory,'test.backup');backup(['backup','--out',file,'--confirm-stopped'],process.env);
  assert.ok(JSON.parse(fs.readFileSync(file)).files['chatgpt-vm.enc']);
  const restored=path.join(directory,'restored');backup(['restore','--from',file,'--out',restored,'--confirm-stopped'],process.env);
  assert.equal(cloud.codec.decode(fs.readFileSync(path.join(restored,'chatgpt-vm.enc'),'utf8')).hostId,initial);
});
test('only designated owner sees or calls subscription; forged IDs, CSRF and HTTP token import are rejected',async()=>{
  assert.equal((await api(null,'/api/chatgpt')).status,401);
  const providerId=runtime.catalog()[0].providerId;
  for(const client of [other,otherAdmin]){
    assert.equal((await api(client,'/api/chatgpt')).status,403);
    for(const route of ['/api/models/catalog','/api/conversation/models'])assert.doesNotMatch((await api(client,route)).text,/chatgpt:|owner@example/);
    for(const route of ['/api/conversation','/api/chat','/api/vision/edit'])assert.equal((await api(client,route,{providerId,modelId:'vm-model',message:'hello',...(route==='/api/vision/edit'?{editMode:'multimodal',currentXml:sampleModel(),vision:{image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==',baseXml:sampleModel()}}:{})})).status,403);
    assert.equal((await api(client,'/api/preferences',{providerId,modelId:'vm-model',reasoningEffort:'high'},'PUT')).status,403);
  }
  assert.equal(calls.length,0);
  assert.equal((await api(owner,'/api/chatgpt/models',{},'POST',{'X-CSRF-Token':'forged'})).status,403);
  assert.equal((await api(owner,'/api/chatgpt/connect',{})).status,409);
  assert.equal((await api(owner,'/api/chatgpt/import',bundle())).status,404);
  assert.equal((await api(owner,'/auth/callback')).status,404);
  for(const route of ['/api/chatgpt','/api/models/catalog','/api/conversation/models'])assert.doesNotMatch((await api(owner,route)).text,/vm-private|idToken|refreshToken/);
});
test('explicit model grant exposes only that model; management and owner preferences stay isolated',async()=>{
  const providerId=runtime.catalog()[0].providerId;
  assert.throws(()=>runtime.grantModel('missing','vm-model'));
  assert.throws(()=>runtime.grantModel('alice','unknown-model'));
  runtime.grantModel('alice','vm-model');
  const fresh=new ChatGPTCloud({cloud,ownerUsername:'admin'});
  assert.deepEqual(fresh.data.grants[other.user.id].models,['vm-model']);
  for(const route of ['/api/models/catalog','/api/conversation/models']){
    const result=await api(other,route);assert.equal(result.status,200);
    const provider=result.data.providers.find(p=>p.providerId===providerId);assert.ok(provider);assert.equal(provider.delegated,true);
    assert.deepEqual(provider.models.map(m=>m.modelId),['vm-model']);assert.doesNotMatch(result.text,/owner@example|vm-private/);
  }
  for(const route of ['/api/chatgpt','/api/chatgpt/models','/api/chatgpt/disconnect'])assert.equal((await api(other,route,route==='/api/chatgpt'?undefined:{})).status,403);
  assert.equal((await api(other,'/api/conversation',{providerId,modelId:'ungranted',message:'test'})).status,403);
  assert.equal((await api(otherAdmin,'/api/conversation',{providerId,modelId:'vm-model',message:'test'})).status,403);
  runtime.preference(providerId,'vm-model',{reasoningEffort:'low'});
  assert.equal((await api(other,'/api/preferences',{providerId,modelId:'vm-model',reasoningEffort:'high'},'PUT')).status,200);
  assert.equal(runtime.resolve(providerId,'vm-model').lock.model.reasoningEffort,'low');
  const response=await api(other,'/api/conversation',{providerId,modelId:'vm-model',message:'hello',stream:true});
  assert.match(response.text,/event: result/);assert.match(response.text,/授权订阅/);assert.doesNotMatch(response.text,/owner@example/);
  assert.equal(calls.at(-1).reasoning.effort,'high');assert.equal(cloud.usage(other.user.id).userCalls,1);assert.equal(cloud.usage(other.user.id).platformCalls,0);
  assert.equal((await api(other,'/api/preferences',{providerId,modelId:'vm-model',thinkingMode:'responses-off'},'PUT')).status,200);
  assert.equal((await api(other,'/api/conversation',{providerId,modelId:'vm-model',message:'off',stream:true})).status,200);
  assert.equal(calls.at(-1).reasoning.effort,'none');
  assert.equal(runtime.resolve(providerId,'vm-model').lock.model.thinkingMode,undefined);
  assert.equal((await api(other,'/api/providers/'+encodeURIComponent(providerId)+'/models/vm-model',{thinkingMode:'responses-on'},'PUT')).status,200);
  drawing=true;
  const diagram=await api(other,'/api/chat',{providerId,modelId:'vm-model',message:'画图',stream:true});assert.match(diagram.text,/event: result/);assert.doesNotMatch(diagram.text,/owner@example/);drawing=false;
  const stats=(await api(owner,'/api/usage/report?scope=subscription')).data;
  assert.equal(stats.summary.calls,3);assert.equal(stats.users.find(user=>user.id===other.user.id).calls,3);assert.equal(stats.sources[0].id,'chatgpt');
  const ownStats=(await api(other,'/api/usage/report')).data;assert.equal(ownStats.summary.calls,3);assert.equal(ownStats.summary.inputTokens,null);assert.equal(ownStats.filters.users.length,1);
  cloud.change(d=>{d.users.find(u=>u.id===other.user.id).disabled=true;});
  assert.equal((await api(other,'/api/conversation/models')).status,401);
  cloud.change(d=>{d.users.find(u=>u.id===other.user.id).disabled=false;d.usage={date:new Date().toISOString().slice(0,10),total:0,platform:0,users:{}};});calls=[];
});
test('delegated Luna exposes a working on/off switch when cached upstream levels omit none',async()=>{
  const account=runtime.account(),providerId='chatgpt:'+account.id;
  account.models.push({modelId:'gpt-6-luna',displayName:'Luna',enabled:true,supportsNone:false,reasoningLevels:['low','medium','high'],defaultEffort:'medium'});runtime.save();runtime.grantModel('alice','gpt-6-luna');
  const catalog=(await api(other,'/api/conversation/models')).data;
  const model=catalog.providers.find(p=>p.providerId===providerId).models.find(m=>m.modelId==='gpt-6-luna');
  assert.equal(model.thinkingFamily,'responses');
  assert.equal((await api(other,'/api/preferences',{providerId,modelId:'gpt-6-luna',thinkingMode:'responses-off'},'PUT')).status,200);
  const drawModel=(await api(other,'/api/models/catalog')).data.providers.find(p=>p.providerId===providerId).models.find(m=>m.modelId==='gpt-6-luna');
  assert.equal(drawModel.supportsNone,true);assert.equal(drawModel.thinkingMode,'responses-off');
  assert.equal(runtime.resolve(providerId,'gpt-6-luna').lock.model.thinkingMode,undefined);
  assert.equal((await api(other,'/api/providers/'+encodeURIComponent(providerId)+'/models/gpt-6-luna',{thinkingMode:'responses-on'},'PUT')).status,200);
  const restarted=new ChatGPTCloud({cloud,ownerUsername:'admin'});
  assert.equal(restarted.resolveFor({identity:{user:cloud.data.users.find(u=>u.id===other.user.id)}},providerId,'gpt-6-luna').lock.model.thinkingMode,'responses-on');
});
test('shared Luna is available to existing and future users without widening other model or management access',async()=>{
  const providerId='chatgpt:'+runtime.account().id;
  assert.throws(()=>runtime.shareModel('missing-model'));
  const previousGrants=structuredClone(runtime.data.grants);
  runtime.shareModel('gpt-6-luna');runtime.shareModel('gpt-6-luna');
  const fresh=new ChatGPTCloud({cloud,ownerUsername:'admin'});
  assert.deepEqual(fresh.data.sharedGrant,{accountId:runtime.account().id,models:['gpt-6-luna']});
  assert.deepEqual(fresh.data.grants,previousGrants);
  assert.equal((await api(owner,'/api/users',{username:'newuser',password:'12345678'})).status,201);
  const newcomer=await login('newuser');
  assert.equal(runtime.data.grants[newcomer.user.id],undefined);
  for(const client of [otherAdmin,newcomer]){
    for(const route of ['/api/models/catalog','/api/conversation/models']){
      const result=await api(client,route),provider=result.data.providers.find(p=>p.providerId===providerId);
      assert.deepEqual(provider.models.map(m=>m.modelId),['gpt-6-luna']);
      assert.doesNotMatch(result.text,/owner@example|vm-private/);
    }
    for(const route of ['/api/chatgpt','/api/chatgpt/models','/api/chatgpt/disconnect'])assert.equal((await api(client,route,route==='/api/chatgpt'?undefined:{})).status,403);
    for(const modelId of ['vm-model','gpt-6.1-sol','gpt-6-astra','gpt-5.6-luna'])assert.equal((await api(client,'/api/conversation',{providerId,modelId,message:'hello'})).status,403);
    const req={identity:{user:cloud.data.users.find(u=>u.id===client.user.id)}};
    assert.equal(fresh.resolveFor(req,providerId,'gpt-6-luna').ok,true);
    assert.throws(()=>fresh.resolveFor(req,'chatgpt:unrelated','gpt-6-luna'),{code:'chatgpt-model-forbidden'});
  }
  assert.deepEqual(runtime.catalogFor({identity:{user:cloud.data.users.find(u=>u.id===other.user.id)}})[0].models.map(m=>m.modelId),['vm-model','gpt-6-luna']);
  assert.equal((await api(newcomer,'/api/preferences',{providerId,modelId:'gpt-6-luna',reasoningEffort:'low'},'PUT')).status,200);
  assert.equal((await api(otherAdmin,'/api/preferences',{providerId,modelId:'gpt-6-luna',reasoningEffort:'high'},'PUT')).status,200);
  assert.equal(fresh.resolveFor({identity:{user:cloud.data.users.find(u=>u.id===newcomer.user.id)}},providerId,'gpt-6-luna').lock.model.reasoningEffort,'low');
  assert.equal(runtime.resolve(providerId,'gpt-6-luna').lock.model.reasoningEffort,undefined);
  const ownerPoints=cloud.usage(owner.user.id).weekly.usedPoints,priorCalls=calls.length;
  cloud.change(d=>{d.users.find(u=>u.id===newcomer.user.id).weeklyLimitPoints=1;});
  assert.equal((await api(newcomer,'/api/preferences',{providerId,modelId:'gpt-6-luna',reasoningEffort:'high'},'PUT')).status,200);
  const limited=await api(newcomer,'/api/conversation',{providerId,modelId:'gpt-6-luna',message:'hello'});
  assert.equal(limited.status,429);assert.equal(limited.data.error.code,'weekly-limit');assert.equal(calls.length,priorCalls);
  assert.equal(cloud.usage(owner.user.id).weekly.usedPoints,ownerPoints);
  assert.equal(cloud.usage(newcomer.user.id).weekly.limitPoints,1);
  assert.deepEqual(fresh.catalogFor({}),[]);
  assert.throws(()=>fresh.assertModelAccess({},providerId,'gpt-6-luna'),{code:'chatgpt-model-forbidden'});
  const disabled={identity:{user:{...newcomer.user,disabled:true}}};
  assert.deepEqual(fresh.catalogFor(disabled),[]);assert.throws(()=>fresh.resolveFor(disabled,providerId,'gpt-6-luna'),{code:'chatgpt-model-forbidden'});
});
test('owner uses full history and images, with personal weekly points rather than the free API pool',async()=>{
  const providerId=runtime.catalog()[0].providerId;
  assert.equal((await api(owner,'/api/preferences',{providerId,modelId:'vm-model',reasoningEffort:'high'},'PUT')).status,200);
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  const result=await api(owner,'/api/conversation',{providerId,modelId:'vm-model',message:'看图',multimodal:true,images:[png],history:[{role:'user',content:'第一轮'},{role:'assistant',content:'上次回复'}],stream:true});
  assert.equal(result.status,200);assert.match(result.text,/event: result/);assert.match(result.text,/云端订阅对话正常/);
  assert.equal(calls[0].input.length,3);assert.equal(calls[0].input.at(-1).content[1].type,'input_image');assert.equal(calls[0].reasoning.effort,'high');
  const usage=cloud.usage(owner.user.id);assert.equal(usage.userCalls,1);assert.equal(usage.platformCalls,0);assert.equal(usage.totalCalls,1);assert.equal(usage.free.calls,0);assert.ok(usage.weekly.usedPoints>0);
  cloud.limits.weeklyPoints=1;
  const denied=await api(owner,'/api/conversation',{providerId,modelId:'vm-model',message:'over limit'});assert.equal(denied.status,429);assert.equal(calls.length,1);
  cloud.limits.weeklyPoints=1000;
  drawing=true;
  const diagram=await api(owner,'/api/chat',{providerId,modelId:'vm-model',message:'画图',stream:true});
  assert.match(diagram.text,/event: result/);assert.match(diagram.text,/mxGraphModel/);
  failure=true;
  const failed=await api(owner,'/api/chat',{providerId,modelId:'vm-model',message:'画图',stream:true});
  assert.match(failed.text,/event: error/);assert.doesNotMatch(failed.text,/event: result/);assert.equal(cloud.usage(owner.user.id).platformCalls,0);
  await api(owner,'/api/chatgpt/disconnect',{accountId:runtime.data.activeId});
  assert.equal(runtime.catalog().length,0);
  assert.equal((await api(owner,'/api/conversation',{providerId,modelId:'vm-model',message:'after disconnect'})).status,400);
});
