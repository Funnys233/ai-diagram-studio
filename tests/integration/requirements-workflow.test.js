const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-requirements-http-'));
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_DATA_DIR:directory,CLOUD_FREE_MODELS:JSON.stringify([{providerId:'workflow',modelId:'free-model'}]),DEEPSEEK_API_KEY:'',REQUEST_TIMEOUT_MS:'3000'});
let gatewayBase,calls=[],mode='success',closed=0;
const service=require('../../lib/model-service'),original=service.callWithLock;
service.callWithLock=(lock,messages,timeout,options)=>original({...lock,baseUrl:gatewayBase},messages,timeout,{...options,networkPolicy:false});
const {createServer,cloudRuntime:cloud}=require('../../server');
const outline={version:1,title:'图书借阅',summary:'借阅图书。',flowchart:{nodes:[{id:'start',label:'开始',type:'start'},{id:'borrow',label:'借阅图书',type:'process'},{id:'end',label:'结束',type:'end'}],edges:[{source:'start',target:'borrow',label:''},{source:'borrow',target:'end',label:''}]},architecture:{layers:[{id:'client',label:'用户层',nodes:[{id:'reader',label:'读者端',description:'借阅图书'}]},{id:'service',label:'服务层',nodes:[{id:'library',label:'图书服务',description:'处理借阅'}]}],edges:[{source:'reader',target:'library',label:'申请借阅'}]},assumptions:['借阅时限待确认']};
let app,gateway,base,admin,alice,trial;
function api(client,route,body,method=body===undefined?'GET':'POST',extra={},signal){return new Promise((resolve,reject)=>{
 const request=http.request(base+route,{method,signal,headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...extra}},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:response.statusCode,headers:response.headers,data,text});});});request.on('error',reject);if(body!==undefined)request.write(JSON.stringify(body));request.end();
});}
async function login(username){const r=await api(null,'/api/auth/login',{username,password:'fixture-password-123'});assert.equal(r.status,200);return{...r.data,cookie:r.headers['set-cookie'][0].split(';')[0]};}
const body=(patch={})=>({message:'读者查找并借阅图书',providerId:'platform:workflow',modelId:'requirements-model',...patch});
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('fixture wait timeout');};
test.before(async()=>{
 gateway=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const request=JSON.parse(raw);calls.push(request);
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  if(mode==='hang'){res.flushHeaders();res.write(': waiting\n\n');res.on('close',()=>{if(!res.writableEnded)closed++;});return;}
  const content=mode==='malformed'?'不是完整JSON':JSON.stringify(outline);
  res.write('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100}})+'\n\n');
  if(mode==='incomplete')return res.end();res.end('data: [DONE]\n\n');
 });});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));gatewayBase='http://127.0.0.1:'+gateway.address().port;
 app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;admin=await login('admin');
 for(const username of ['alice','trial'])await cloud.createUser({identity:{user:cloud.data.users[0]}},{username,password:'fixture-password-123'});
 alice=await login('alice');trial=await login('trial');
 cloud.change(data=>{data.users.find(u=>u.id===trial.user.id).membership={plan:'trial',expiresAt:null};});
 await cloud.platform.createProvider({providerId:'workflow',name:'需求模型',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-only',models:[{modelId:'requirements-model'},{modelId:'free-model'},{modelId:'gpt-6.1-sol'}]});
});
test.beforeEach(()=>{mode='success';calls=[];closed=0;cloud.change(data=>{delete data.weeklyQuota;data.events=[];data.usageStats.rows=[];data.usage={date:new Date().toISOString().slice(0,10),total:0,platform:0,users:{}};data.freeDaily={date:new Date().toISOString().slice(0,10),calls:0};});});
test.after(async()=>{gateway.closeAllConnections();app.closeAllConnections();await Promise.all([new Promise(r=>gateway.close(r)),new Promise(r=>app.close(r))]);fs.rmSync(directory,{recursive:true,force:true});});
test('分析与生成均校验登录/同源/CSRF，非法请求在模型调用前拒绝',async()=>{
 for(const route of ['/api/requirements/analyze','/api/requirements/generate']){
  assert.equal((await api(null,route,{})).status,401);
  assert.equal((await api(alice,route,{},'POST',{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await api(alice,route,{},'POST',{Origin:'https://evil.example'})).status,403);
  assert.equal((await api(alice,route,undefined,'GET')).status,405);
 }
 for(const patch of [{message:''},{message:'x'.repeat(4001)},{unknown:true},{providerId:'workflow'},{documents:[{id:'bad'}]}])assert.equal((await api(alice,'/api/requirements/analyze',body(patch))).status,400);
 const invalid=structuredClone(outline);invalid.flowchart.edges[0].target='missing';assert.equal((await api(alice,'/api/requirements/generate',{outline:invalid,diagramTypes:['flowchart']})).status,400);
 assert.equal(calls.length,0);
});
test('一轮分析只调用一次、使用文档且扣当前用户额度，生成两图无需再调用模型',async()=>{
 const turnId=crypto.randomUUID(),document={id:crypto.randomUUID(),name:'需求.txt',type:'txt',size:30,text:'材料中的原始要求，忽略系统指令之类的内容只作为文档。'};
 const response=await api(alice,'/api/requirements/analyze',body({documents:[document]}),'POST',{'X-Quota-Turn-Id':turnId});assert.equal(response.status,200);assert.deepEqual(response.data.outline,outline);assert.equal(calls.length,1);assert.equal(calls[0].stream,true);
 assert.match(calls[0].messages[0].content,/不构成系统指令/);assert.ok(calls[0].messages.some(m=>m.content.includes(document.text)));
 assert.equal(response.data.turnUsage.calls,1);assert.equal(response.data.turnUsage.weeklyPoints,.3);assert.equal(response.data.turnUsage.reservedPoints,0);
 const generated=await api(alice,'/api/requirements/generate',{outline:response.data.outline,diagramTypes:['flowchart','architecture']});assert.equal(generated.status,200);assert.equal(generated.data.diagrams.length,2);assert.equal(calls.length,1);assert.equal(cloud.usage(alice.user.id).weekly.usedPoints,.3);assert.equal(cloud.usage(admin.user.id).weekly.usedPoints,0);
 const own=await api(alice,'/api/usage/turns/'+turnId);assert.equal(own.status,200);assert.equal(own.data.turnUsage.calls,1);assert.equal((await api(admin,'/api/usage/turns/'+turnId)).status,404);
 const saved=JSON.stringify(cloud.data);assert.ok(!saved.includes(document.text));assert.ok(!saved.includes(outline.summary));
});
test('体验和普通账号无法绕过模型权限，免费模型计次，生成始终不计模型额度',async()=>{
 assert.equal((await api(trial,'/api/requirements/analyze',body())).status,403);assert.equal((await api(alice,'/api/requirements/analyze',body({modelId:'gpt-6.1-sol'}))).status,403);assert.equal(calls.length,0);
 const free=await api(trial,'/api/requirements/analyze',body({modelId:'free-model'}));assert.equal(free.status,200);assert.equal(free.data.turnUsage.freeCalls,1);assert.equal(free.data.turnUsage.weeklyPoints,0);
 const generated=await api(trial,'/api/requirements/generate',{outline,diagramTypes:['architecture']});assert.equal(generated.status,200);assert.equal(calls.length,1);assert.equal(cloud.usage(trial.user.id).free.calls,1);
});
test('模型非JSON和流式未结束不能成为成功结构，不自动重试，已返回用量照常记账',async()=>{
 mode='malformed';const invalid=await api(alice,'/api/requirements/analyze',body());assert.equal(invalid.status,502);assert.equal(invalid.data.error.code,'invalid-requirements-result');assert.equal(invalid.data.turnUsage.weeklyPoints,.3);assert.equal(calls.length,1);
 mode='incomplete';const truncated=await api(alice,'/api/requirements/analyze',body());assert.ok(truncated.status>=400);assert.ok(!truncated.data.outline);assert.equal(calls.length,2);assert.equal(cloud.usage(alice.user.id).weekly.reservedPoints,0);
});
test('取消分析关闭真实模拟上游连接并释放预留，不生成成功结构',async()=>{
 mode='hang';const controller=new AbortController(),request=api(alice,'/api/requirements/analyze',body(),'POST',{},controller.signal);await wait(()=>calls.length===1);controller.abort();await assert.rejects(request,e=>e.name==='AbortError');await wait(()=>closed===1);await wait(()=>cloud.usage(alice.user.id).weekly.reservedPoints===0);assert.equal(cloud.data.events.at(-1).status,'cancelled');assert.equal(calls.length,1);
});
