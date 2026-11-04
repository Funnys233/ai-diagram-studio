const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-cloud-http-'));
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'test-password-123',CLOUD_DATA_DIR:directory,CLOUD_FREE_MODELS:JSON.stringify([{providerId:'preset',modelId:'m'}]),DEEPSEEK_API_KEY:'',REQUEST_TIMEOUT_MS:'3000'});
// The only network seam: permitted public fixture domains resolve safely, then
// model calls are routed to a loopback gateway. No production bypass exists.
const dns=require('node:dns').promises;const lookup=dns.lookup;dns.lookup=async host=>host.endsWith('.fixture.example')?[{address:'8.8.8.8',family:4}]:lookup(host,{all:true});
const service=require('../../lib/model-service'),originalCall=service.callWithLock,originalList=service.listRemoteModels,originalTest=service.testModelConnection;
const originalProbe=service.probeReasoningEfforts;
let gatewayBase;
service.callWithLock=(lock,messages,timeout,options)=>originalCall({...lock,baseUrl:gatewayBase},messages,timeout,{...options,networkPolicy:false});
service.listRemoteModels=(provider,timeout,details,options)=>originalList({...provider,baseUrl:gatewayBase},timeout,details,{...options,networkPolicy:false});
service.testModelConnection=(provider,model,timeout,options)=>originalTest({...provider,baseUrl:gatewayBase},model,timeout,{...options,networkPolicy:false});
service.probeReasoningEfforts=(lock,options)=>originalProbe({...lock,baseUrl:gatewayBase},{...options,networkPolicy:false});
const {createServer,cloudRuntime:cloud}=require('../../server'),{sampleModel}=require('../helpers/fixtures');
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
let app,gateway,base,admin,alice,bob,calls=[],outputs=[],hold=false,closed=0,probeMode=null,failureUsage=null,upstreamRejection=null,cacheMode=null;
async function api(client,url,body,method=body===undefined?'GET':'POST',extra={},signal){return new Promise((resolve,reject)=>{
 const request=http.request(base+url,{method,signal,headers:{Host:'diagram.example',Origin:'https://diagram.example',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),'Content-Type':'application/json',...extra}},response=>{
  resolve(new Response(require('node:stream').Readable.toWeb(response),{status:response.statusCode,headers:response.headers}));
 });request.on('error',reject);if(body!==undefined)request.write(JSON.stringify(body));request.end();
});}
async function login(username='admin'){const r=await api(null,'/api/auth/login',{username,password:'test-password-123'});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};}
async function provider(client,source,id,key,protocol='openai-chat-completions'){
 const r=await api(client,'/api/providers',{providerId:id,name:source+' '+id,baseUrl:'https://api.fixture.example',protocol,apiKey:key},'POST',{'X-Provider-Scope':source});assert.equal(r.status,201);assert.equal((await api(client,'/api/providers/'+id+'/models',{modelId:'m',visionInput:true},'POST',{'X-Provider-Scope':source})).status,201);
}
const chat=(providerId,extra={})=>({providerId,modelId:'m',message:'画一个流程',currentFile:sampleModel(),...extra});
const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('fixture wait timeout');};
test.before(async()=>{
 gateway=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const body=raw?JSON.parse(raw):null;calls.push({url:req.url,headers:req.headers,body});
  if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({data:[{id:'m'}]}));}
  if(cacheMode){
   const usage={prompt_tokens:1000,completion_tokens:20,total_tokens:1020,...(cacheMode==='missing'?{}:{prompt_tokens_details:{cached_tokens:cacheMode==='zero'?0:800,secret:'private'}})};
   if(cacheMode==='failed'){res.writeHead(502,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'fixture failure'},usage}));}
   if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'缓存测试回复'},finish_reason:'stop'}],usage:null})+'\n\n');return res.end('data: '+JSON.stringify({choices:[],usage})+'\n\ndata: [DONE]\n\n');}
   res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({choices:[{message:{content:'缓存测试回复'},finish_reason:'stop'}],usage}));
  }
  if(upstreamRejection){
   if(upstreamRejection.streamBusy){
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    for(const event of upstreamRejection.events||[])res.write('data: '+JSON.stringify(event)+'\n\n');
    return res.end('data: '+JSON.stringify({error:{message:'The service is busy. Please retry later.'}})+'\n\n');
   }
   if(upstreamRejection.partialStream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'已生成一部分'}}]})+'\n\n');return res.end('data: '+JSON.stringify({error:{message:'Upstream rate limit exceeded'}})+'\n\n');}
   res.writeHead(429,{'Content-Type':'application/json'});return res.end(JSON.stringify(upstreamRejection));
  }
  if(probeMode){
   if(probeMode==='hang'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write(': waiting\n\n');res.on('close',()=>{if(!res.writableEnded)closed++;});return;}
   const accepted=probeMode==='silent'||body.reasoning_effort===undefined||['low','high','max'].includes(body.reasoning_effort);
   if(!accepted){
    const error=probeMode==='relay-enum'?{message:`Invalid value: '${body.reasoning_effort.slice(0,3)}...${body.reasoning_effort.slice(-3)}'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'.`}:
     probeMode==='enum-error'?{code:'invalid_parameter_error',message:"'reasoning_effort' must be one of: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'",param:null,type:'invalid_request_error'}:
     probeMode==='hidden-error'?{message:'The request could not be processed. Please check the request parameters.',type:'invalid_request_error'}:
     {code:'invalid_value',param:'reasoning_effort',message:'Unsupported reasoning_effort'};
    res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error}));
   }
   if(probeMode==='stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{role:'assistant'}}]})+'\n\n');res.on('close',()=>{if(!res.writableEnded)closed++;});return;}
   res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({choices:[{message:{content:'pong'},finish_reason:'length'}]}));
  }
  if(failureUsage){res.writeHead(502,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:{message:'fixture upstream failure'},usage:failureUsage}));}
  if(hold){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write('data: '+JSON.stringify({choices:[{index:0,delta:{reasoning_content:'fixture'}}]})+'\n\n');res.on('close',()=>{if(!res.writableEnded)closed++;});return;}
  const text=outputs.shift()||sampleModel();res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url.includes('/messages')?{content:[{type:'text',text}],stop_reason:'end_turn',usage:{input_tokens:10,output_tokens:20}}:{choices:[{message:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30}}));
 });});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));gatewayBase='http://127.0.0.1:'+gateway.address().port;
 app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;admin=await login();
 for(const username of ['alice','bob'])assert.equal((await api(admin,'/api/users',{username,password:'test-password-123'})).status,201);
 alice=await login('alice');bob=await login('bob');await provider(admin,'platform','preset','fixture-platform-key');await provider(alice,'personal','mine','fixture-alice-key');await provider(bob,'personal','other','fixture-bob-key');await provider(alice,'personal','anthropic','fixture-anthropic-key','anthropic-messages');
});
test.after(async()=>{gateway.closeAllConnections();app.closeAllConnections();await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>gateway.close(r))]);});
test.beforeEach(()=>{calls=[];outputs=[];hold=false;probeMode=null;failureUsage=null;upstreamRejection=null;cacheMode=null;cloud.change(d=>{d.usage={date:new Date().toISOString().slice(0,10),total:0,platform:0,users:{}};d.freeDaily={date:new Date().toISOString().slice(0,10),calls:0};delete d.weeklyQuota;for(const user of d.users)delete user.weeklyLimitPoints;d.events=[];d.usageStats.rows=[];});cloud.limits.weeklyPoints=1000;cloud.limits.platform=300;});
test('所有业务 API 登录前拒绝，伪造Host、Origin、CSRF或代理头不能绕过',async()=>{
 assert.equal((await api(null,'/api/chatgpt')).status,404);assert.equal((await api(null,'/auth/callback')).status,404);
 for(const url of ['/api/chat','/api/vision/edit','/api/providers','/api/diagrams/validate'])assert.equal((await api(null,url,{})).status,401);
 assert.equal((await api(null,'/api/models/catalog')).status,401);assert.equal((await api(null,'/healthz')).status,200);
 for(const headers of [{Host:'evil.example'},{Origin:'https://evil.example'},{'X-CSRF-Token':'bad'},{Origin:'https://evil.example','X-Forwarded-Host':'diagram.example','X-Forwarded-Proto':'https'}])assert.equal((await api(alice,'/api/chat',chat('platform:preset'),'POST',headers)).status,403);assert.equal(calls.length,0);
});
test('目录显示平台与本人模型，个人配置管理和跨账号调用隔离',async()=>{
 const catalog=await(await api(alice,'/api/models/catalog')).json();assert.ok(catalog.providers.some(p=>p.providerId==='platform:preset'));assert.ok(catalog.providers.some(p=>p.providerId==='personal:mine'));assert.ok(!catalog.providers.some(p=>p.providerId.includes('other')));
 assert.equal((await api(alice,'/api/providers',{providerId:'bad'},'POST',{'X-Provider-Scope':'platform'})).status,403);assert.equal((await api(alice,'/api/providers/platform:preset',{},'PUT')).status,403);
 assert.equal((await api(alice,'/api/providers/other')).status,404);assert.equal((await api(alice,'/api/chat',chat('personal:other'))).status,404);assert.equal((await api(alice,'/api/chat',chat('personal:'+bob.user.id+':other'))).status,400);assert.equal(calls.length,0);
});
test('平台与个人 API 真正使用不同凭据，返回来源明确，个人调用不扣平台额度',async()=>{
 for(const [id,key] of [['platform:preset','fixture-platform-key'],['personal:mine','fixture-alice-key']]){const r=await api(alice,'/api/chat',chat(id));assert.equal(r.status,200);const b=await r.json();assert.equal(b.provider.providerId,id);assert.equal(calls.at(-1).headers.authorization,'Bearer '+key);}
 const u=await(await api(alice,'/api/usage')).json();assert.equal(u.usage.userCalls,2);assert.equal(u.usage.platformCalls,1);assert.ok(u.events.at(-1).usage.total_tokens===30);
 const raw=fs.readdirSync(directory).filter(n=>n.endsWith('.enc')).map(n=>fs.readFileSync(path.join(directory,n),'utf8')).join('');assert.ok(!raw.includes('fixture-alice-key'));assert.ok(!JSON.stringify(u).includes('fixture-alice-key'));
});
test('完整用量接口区分管理员和普通用户，筛选与token统计准确且不泄漏对话或密钥',async()=>{
 assert.equal((await api(null,'/api/usage/report')).status,401);
 assert.equal((await api(alice,'/api/usage/report?scope=all')).status,403);
 assert.equal((await api(alice,'/api/usage/report?userId='+bob.user.id)).status,403);
 assert.equal((await api(alice,'/api/usage/report?range=invalid')).status,400);
 assert.equal((await api(alice,'/api/chat',chat('platform:preset'))).status,200);
 assert.equal((await api(bob,'/api/chat',chat('personal:other'))).status,200);
 const all=await(await api(admin,'/api/usage/report?range=7d')).json();assert.equal(all.summary.calls,2);assert.equal(all.summary.inputTokens,20);assert.equal(all.summary.outputTokens,40);assert.equal(all.daily.length,7);assert.equal(all.users.length,2);
 const mine=await(await api(alice,'/api/usage/report')).json();assert.equal(mine.summary.calls,1);assert.equal(mine.filters.users.length,1);assert.equal(mine.events[0].username,'alice');assert.equal(mine.sources[0].id,'platform');
 const selected=await(await api(admin,'/api/usage/report?source=personal&userId='+bob.user.id+'&modelId=m')).json();assert.equal(selected.summary.calls,1);assert.equal(selected.events[0].username,'bob');
 assert.ok(!JSON.stringify(all).includes('fixture-platform-key'));assert.ok(!JSON.stringify(all).includes('画一个流程'));
 cloud.limits.platform=1;assert.equal((await api(alice,'/api/chat',chat('platform:preset'))).status,429);
 assert.equal((await(await api(admin,'/api/usage/report')).json()).summary.calls,2);
});
test('平台模型生成偏好独立，后端锁定用户偏好而不更改共享配置',async()=>{
 assert.equal((await api(alice,'/api/preferences',{providerId:'platform:preset',modelId:'m',thinkingMode:'enable-thinking-on'},'PUT')).status,200);
 const r=await api(alice,'/api/chat',chat('platform:preset'));assert.equal(r.status,200);assert.equal(calls[0].body.enable_thinking,true);assert.equal(cloud.platform.getRaw('preset').models[0].thinkingMode,'default');
 const bc=await(await api(bob,'/api/models/catalog')).json();assert.equal(bc.providers.find(p=>p.providerId==='platform:preset').models[0].thinkingMode,'default');
});
test('自定义 API 保存拒绝本机或私网，平台管理员也不能绕过出站策略',async()=>{
 for(const baseUrl of ['https://127.0.0.1','https://169.254.169.254','https://[::1]','http://api.fixture.example']){const r=await api(alice,'/api/providers',{providerId:'unsafe',name:'unsafe',baseUrl,protocol:'openai-chat-completions',apiKey:'private-fixture'});assert.equal(r.status,400);}
 assert.equal((await api(admin,'/api/providers/preset',{baseUrl:'https://10.0.0.1'},'PUT',{'X-Provider-Scope':'platform'})).status,400);assert.equal(calls.length,0);
});
test('双协议多模态收到图片，纠错保留图片和同一来源并计算两次额度',async()=>{
 for(const id of ['platform:preset','personal:anthropic']){outputs=['我看到了上传的图片'];const r=await api(alice,'/api/vision/edit',chat(id,{editMode:'multimodal',vision:{image:PNG,images:[PNG],baseXml:sampleModel()}}));assert.equal(r.status,200);assert.equal((await r.json()).kind,'multimodal-chat');assert.equal(calls.at(-1).body.messages.at(-1).content.filter(p=>p.type===(id.includes('anthropic')?'image':'image_url')).length,2);}
 const before=calls.length;outputs=['<mxGraphModel><root>',sampleModel()];const r=await api(alice,'/api/vision/edit',chat('personal:mine',{editMode:'multimodal',vision:{image:PNG,baseXml:sampleModel()}}));assert.equal(r.status,200);assert.equal(calls.length,before+2);assert.equal(calls.at(-1).headers.authorization,'Bearer fixture-alice-key');assert.equal(calls.at(-1).body.messages.at(-1).content.filter(p=>p.type==='image_url').length,1);assert.equal(cloud.usage(alice.user.id).userCalls,4);assert.equal(cloud.usage(alice.user.id).platformCalls,1);
});
test('个人 API 与模型目录只统计，免费池耗尽不阻断个人来源，无效个人 API 不回退平台',async()=>{
 cloud.limits.platform=1;
 assert.equal((await api(alice,'/api/chat',chat('platform:preset'))).status,200);
 assert.equal((await api(alice,'/api/chat',chat('platform:preset'))).status,429);
 assert.equal((await api(alice,'/api/providers/mine/models/fetch',{})).status,200);outputs=['pong'];assert.equal((await api(alice,'/api/providers/mine/models/m/test',{})).status,200);
 assert.equal((await api(alice,'/api/chat',chat('personal:mine'))).status,200);assert.equal(calls.length,4);
 assert.equal((await api(alice,'/api/chat',chat('personal:missing'))).status,404);assert.equal(calls.length,4);
 const {usage}=await(await api(alice,'/api/usage')).json();assert.equal(usage.userCalls,4);assert.equal(usage.free.calls,1);assert.equal(usage.weekly.usedPoints,0);assert.equal(usage.weekly.reservedPoints,0);
});
test('免费池跨账号共享200次，总量仍只统计，个人调用不占两个额度',async()=>{
 cloud.limits.platform=200;cloud.change(d=>{d.usage.total=1000;});
 const req={identity:{user:cloud.data.users.find(u=>u.id===admin.user.id),session:cloud.data.sessions.find(s=>s.userId===admin.user.id)}};
 for(let i=0;i<199;i++)cloud.callOptions(req,'platform','preset','m').beforeCall();
 assert.equal((await api(alice,'/api/chat',chat('platform:preset'))).status,200);
 const blocked=await api(bob,'/api/chat',chat('platform:preset'));assert.equal(blocked.status,429);assert.match((await blocked.json()).error.message,/共享|免费/);assert.equal(calls.length,1);
 assert.equal((await api(bob,'/api/chat',chat('personal:other'))).status,200);assert.equal(calls.length,2);
 const {usage}=await(await api(bob,'/api/usage')).json();assert.equal(usage.totalCalls,1201);assert.equal(usage.platformCalls,200);assert.equal(usage.userCalls,1);assert.equal(usage.free.calls,200);assert.equal(usage.weekly.usedPoints,0);assert.equal(Object.hasOwn(usage.limits,'total'),false);assert.equal(Object.hasOwn(usage.limits,'user'),false);
});
test('新增平台模型自动按每用户周额度扣点，剩余额度不足预留时拦截，免费池独立',async()=>{
 await provider(admin,'platform','weekly-new','fixture-weekly-key');
 const limitRoute='/api/users/'+alice.user.id+'/weekly-limit';assert.equal((await api(admin,limitRoute,{limitPoints:1},'PUT')).status,200);
 assert.equal((await api(alice,'/api/conversation',{providerId:'platform:weekly-new',modelId:'m',message:'hello'})).status,200);
 const aliceUsage=(await(await api(alice,'/api/usage')).json()).usage;assert.equal(aliceUsage.weekly.usedPoints,.055);assert.equal(aliceUsage.weekly.reservedPoints,0);assert.equal(aliceUsage.free.calls,0);assert.equal(aliceUsage.weekly.limitPoints,1);
 assert.equal((await api(alice,'/api/conversation',{providerId:'platform:weekly-new',modelId:'m',message:'hello again'})).status,429);
 assert.equal(calls.length,1);assert.equal((await api(bob,'/api/conversation',{providerId:'platform:weekly-new',modelId:'m',message:'separate user'})).status,200);
 const bobUsage=(await(await api(bob,'/api/usage')).json()).usage;assert.equal(bobUsage.weekly.usedPoints,.055);assert.equal(bobUsage.weekly.limitPoints,1000);
 assert.equal((await api(alice,'/api/chat',chat('platform:preset'))).status,200);assert.equal((await api(alice,'/api/chat',chat('personal:mine'))).status,200);
 const final=(await(await api(alice,'/api/usage')).json()).usage;assert.equal(final.weekly.usedPoints,.055);assert.equal(final.free.calls,1);
});
test('后台调整个人周额度限管理员、校验范围且即时生效，不清空已用额度',async()=>{
 const route='/api/users/'+alice.user.id+'/weekly-limit';
 assert.equal((await api(null,route,{limitPoints:500},'PUT')).status,401);assert.equal((await api(alice,route,{limitPoints:500},'PUT')).status,403);
 assert.equal((await api(admin,route,{limitPoints:500},'PUT',{'X-CSRF-Token':'bad'})).status,403);
 for(const value of [0,-1,1.5,1000001,'500',null])assert.equal((await api(admin,route,{limitPoints:value},'PUT')).status,400);
 assert.equal((await api(admin,'/api/users/'+crypto.randomUUID()+'/weekly-limit',{limitPoints:500},'PUT')).status,404);
 await provider(admin,'platform','weekly-admin','fixture-weekly-admin-key');assert.equal((await api(alice,'/api/chat',chat('platform:weekly-admin'))).status,200);
 const response=await api(admin,route,{limitPoints:500},'PUT');assert.equal(response.status,200);const result=await response.json();assert.equal(result.user.weeklyLimitPoints,500);assert.equal(result.weekly.limitPoints,500);assert.equal(result.weekly.usedPoints,.055);
 const users=(await(await api(admin,'/api/users')).json()).users;assert.equal(users.find(u=>u.id===alice.user.id).weeklyLimitPoints,500);assert.equal(users.find(u=>u.id===bob.user.id).weeklyLimitPoints,1000);
 const usage=(await(await api(alice,'/api/usage')).json()).usage;assert.equal(usage.weekly.limitPoints,500);assert.equal(usage.weekly.usedPoints,.055);assert.equal((await api(alice,'/api/models/catalog')).status,200);
 const created=await api(admin,'/api/users',{username:'disabled-quota',password:'test-password-123'});assert.equal(created.status,201);const target=(await created.json()).user;
 assert.equal((await api(admin,'/api/users/'+target.id,{disabled:true},'PUT')).status,200);const disabledRoute='/api/users/'+target.id+'/weekly-limit';assert.equal((await api(admin,disabledRoute,{limitPoints:500,disabled:false},'PUT')).status,400);assert.equal((await api(admin,disabledRoute,{limitPoints:500},'PUT')).status,200);const disabledUser=(await(await api(admin,'/api/users')).json()).users.find(u=>u.id===target.id);assert.equal(disabledUser.disabled,true);assert.equal(disabledUser.weeklyLimitPoints,500);
});
test('开放模型失败仍按上游返回的已用tokens结算并释放预留',async()=>{
 await provider(admin,'platform','weekly-failed','fixture-weekly-failed-key');failureUsage={prompt_tokens:100,completion_tokens:50};
 const response=await api(alice,'/api/conversation',{providerId:'platform:weekly-failed',modelId:'m',message:'failure fixture'});assert.ok(response.status>=400);assert.equal(calls.length,1);
 const usage=(await(await api(alice,'/api/usage')).json()).usage;assert.equal(usage.weekly.usedPoints,.175);assert.equal(usage.weekly.reservedPoints,0);assert.equal(usage.free.calls,0);
 const report=await(await api(alice,'/api/usage/report')).json();assert.equal(report.summary.calls,1);assert.equal(report.summary.failed,1);
});
test('开放模型流式取消关闭上游，未知用量估算扣点且预留只释放一次',async()=>{
 await provider(admin,'platform','weekly-cancel','fixture-weekly-cancel-key');hold=true;const controller=new AbortController(),before=closed,turnId=crypto.randomUUID();
 const response=await api(alice,'/api/conversation',{providerId:'platform:weekly-cancel',modelId:'m',message:'cancel fixture',stream:true},'POST',{'X-Quota-Turn-Id':turnId},controller.signal);assert.equal(response.status,200);
 await wait(()=>calls.length===1);assert.equal(cloud.usage(alice.user.id).weekly.reservedPoints,1);controller.abort();
 await wait(()=>closed===before+1&&cloud.globalActive===0&&cloud.usage(alice.user.id).weekly.reservedPoints===0);
 const usage=(await(await api(alice,'/api/usage')).json()).usage;assert.equal(usage.weekly.usedPoints,1);assert.equal(usage.weekly.reservedPoints,0);assert.equal(usage.userCalls,1);
 const report=await(await api(alice,'/api/usage/report')).json();assert.equal(report.summary.cancelled,1);assert.equal(report.summary.calls,1);
 const receipt=(await(await api(alice,'/api/usage/turns/'+turnId)).json()).turnUsage;assert.equal(receipt.weeklyPoints,1);assert.equal(receipt.status,'settled');assert.equal(receipt.estimated,true);
});
test('每轮实际扣点随JSON返回且查询仅限本人，无扣费失败返回零调用',async()=>{
 await provider(admin,'platform','turn-receipt','fixture-turn-key');const turnId=crypto.randomUUID();
 const response=await api(alice,'/api/conversation',{providerId:'platform:turn-receipt',modelId:'m',message:'receipt fixture'},'POST',{'X-Quota-Turn-Id':turnId});assert.equal(response.status,200);
 const receipt=(await response.json()).turnUsage;assert.equal(receipt.turnId,turnId);assert.equal(receipt.weeklyPoints,.055);assert.equal(receipt.calls,1);assert.equal(receipt.status,'settled');
 assert.deepEqual((await(await api(alice,'/api/usage/turns/'+turnId)).json()).turnUsage,receipt);
 assert.equal((await api(bob,'/api/usage/turns/'+turnId)).status,404);
 assert.equal((await api(alice,'/api/conversation',{providerId:'platform:turn-receipt',modelId:'m',message:'bad id'},'POST',{'X-Quota-Turn-Id':'bad'})).status,400);assert.equal(calls.length,1);
 const blockedId=crypto.randomUUID();cloud.setWeeklyLimit({identity:{user:cloud.data.users.find(user=>user.id===admin.user.id)}},alice.user.id,1);
 const blocked=await api(alice,'/api/conversation',{providerId:'platform:turn-receipt',modelId:'m',message:'blocked'},'POST',{'X-Quota-Turn-Id':blockedId});assert.equal(blocked.status,429);
 const empty=(await blocked.json()).turnUsage;assert.equal(empty.calls,0);assert.equal(empty.weeklyPoints,0);assert.equal(empty.status,'settled');assert.equal(calls.length,1);
});
test('绘图SSE自动纠错的两次调用合并为本轮免费次数，错误也携带已结算回执',async()=>{
 const turnId=crypto.randomUUID();outputs=['invalid XML',sampleModel()];
 const response=await api(alice,'/api/chat',chat('platform:preset',{stream:true}),'POST',{'X-Quota-Turn-Id':turnId});assert.equal(response.status,200);
 let result;const parser=require('../../lib/sse').createParser(event=>{if(event.event==='result')result=JSON.parse(event.data);});parser.push(await response.text());
 assert.ok(result);assert.equal(result.turnUsage.calls,2);assert.equal(result.turnUsage.freeCalls,2);assert.equal(result.turnUsage.weeklyPoints,0);assert.equal(result.turnUsage.status,'settled');
 await provider(admin,'platform','turn-failure','fixture-turn-error-key');failureUsage={prompt_tokens:100,completion_tokens:50};const failedId=crypto.randomUUID();
 const failed=await api(alice,'/api/conversation',{providerId:'platform:turn-failure',modelId:'m',message:'failure receipt'},'POST',{'X-Quota-Turn-Id':failedId});assert.ok(failed.status>=400);
 const receipt=(await failed.json()).turnUsage;assert.equal(receipt.weeklyPoints,.175);assert.equal(receipt.calls,1);assert.equal(receipt.status,'settled');
});
test('分段响应取消关闭上游并释放并发；原额度与新请求行为一致',async()=>{
 hold=true;const controller=new AbortController();const response=await api(alice,'/api/vision/edit',chat('personal:mine',{stream:true,editMode:'multimodal',vision:{image:PNG,baseXml:sampleModel()}}),'POST',{},controller.signal);assert.equal(response.status,200);await wait(()=>calls.length===1);assert.equal(cloud.active.get(alice.user.id),1);
 assert.equal((await api(alice,'/api/chat',chat('personal:mine'))).status,429);const before=closed;controller.abort();await wait(()=>closed===before+1&&cloud.globalActive===0);hold=false;assert.equal(cloud.usage(alice.user.id).userCalls,1);assert.equal((await api(alice,'/api/chat',chat('personal:mine'))).status,200);
 const report=await(await api(alice,'/api/usage/report')).json();assert.equal(report.summary.calls,2);assert.equal(report.summary.cancelled,1);assert.equal(report.summary.success,1);
});
test('模型连接测试在客户端断开后也关闭上游并释放并发',async()=>{
 hold=true;const controller=new AbortController(),before=closed;
 const pending=api(alice,'/api/providers/mine/models/m/test',{},'POST',{},controller.signal);
 await wait(()=>calls.length===1);controller.abort();await assert.rejects(pending);
 await wait(()=>closed===before+1&&cloud.globalActive===0);assert.equal(cloud.usage(alice.user.id).userCalls,1);hold=false;
});
test('图表校验和账号禁用在云端生效，退出撤销会话',async()=>{
 assert.equal((await api(alice,'/api/diagrams/validate',{payload:sampleModel()})).status,200);
 assert.equal((await api(alice,'/api/users')).status,403);assert.equal((await api(admin,'/api/users/'+bob.user.id,{disabled:true},'PUT')).status,200);assert.equal((await api(bob,'/api/models/catalog')).status,401);
 const fresh=await login('alice');assert.equal((await api(fresh,'/api/auth/logout',{})).status,200);assert.equal((await api(fresh,'/api/chat',chat('personal:mine'))).status,401);
});

test('云端未保存模型预览保持权限、密钥隔离、限额和出站校验',async()=>{
 const route='/api/providers/models/fetch',draft={baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'preview-only-key'};
 assert.equal((await api(null,route,draft)).status,401);
 assert.equal((await api(alice,route,draft,'POST',{'X-Provider-Scope':'platform'})).status,403);
 assert.equal((await api(alice,route,{...draft,savedProviderId:'other',apiKey:''})).status,404);
 assert.equal((await api(alice,route,{...draft,baseUrl:'https://127.0.0.1'})).status,400);
 const before=structuredClone(cloud.platform.data);
 const r=await api(admin,route,draft,'POST',{'X-Provider-Scope':'platform'});assert.equal(r.status,200);assert.equal((await r.json()).ok,true);
 assert.equal(calls.at(-1).headers.authorization,'Bearer preview-only-key');assert.deepEqual(cloud.platform.data,before);
 assert.equal(cloud.usage(admin.user.id).platformCalls,1);cloud.limits.platform=1;
 assert.equal((await api(admin,route,draft,'POST',{'X-Provider-Scope':'platform'})).status,200);
 const usage=cloud.usage(admin.user.id);assert.equal(usage.free.calls,0);assert.equal(usage.weekly.usedPoints,0);assert.equal(usage.weekly.reservedPoints,0);assert.equal(calls.length,2);
});

test('纯对话图片和图片追问经两种协议传递，个人来源和额度保持正确',async()=>{
 for(const id of ['platform:preset','personal:anthropic']){
  outputs=['这是一张图片'];const r=await api(alice,'/api/conversation',{providerId:id,modelId:'m',images:[PNG],multimodal:true});
  assert.equal(r.status,200);assert.equal((await r.json()).reply,'这是一张图片');
  const imageType=id.includes('anthropic')?'image':'image_url';
  assert.equal(calls.at(-1).body.messages.at(-1).content.filter(p=>p.type===imageType).length,1);
  outputs=['继续回答图片问题'];const follow=await api(alice,'/api/conversation',{providerId:id,modelId:'m',message:'图片里是什么？',multimodal:true,history:[{role:'user',content:'看看图片',images:[PNG]},{role:'assistant',content:'这是一张图片'}]});
  assert.equal(follow.status,200);const result=await follow.json();assert.equal(result.reply,'继续回答图片问题');
  assert.ok(result.provider.name.startsWith(id.startsWith('platform:')?'平台模型':'我的模型'));
  assert.equal(calls.at(-1).body.messages.find(m=>m.role==='user').content.filter(p=>p.type===imageType).length,1);
 }
 assert.equal(cloud.usage(alice.user.id).userCalls,4);assert.equal(cloud.usage(alice.user.id).platformCalls,2);
});
test('纯对话接受带附加数据的真实渐进 JPEG，当前图片与追问均发送完整图像编码',async()=>{
 const bytes=fs.readFileSync(path.join(__dirname,'../helpers/images/progressive.jpg'));
 const original='data:image/jpeg;base64,'+bytes.toString('base64'),trailer='data:image/jpeg;base64,'+Buffer.concat([bytes,Buffer.from('export metadata')]).toString('base64');
 for(const id of ['platform:preset','personal:anthropic']){
  outputs=['识图回答'];const r=await api(alice,'/api/conversation',{providerId:id,modelId:'m',images:[trailer],multimodal:true,history:[{role:'user',content:'上一张图片',images:[trailer]}]});
  assert.equal(r.status,200);assert.equal((await r.json()).reply,'识图回答');
  for(const message of calls.at(-1).body.messages.filter(m=>m.role==='user')){
   const content=message.content;
   if(id.includes('anthropic')){const image=content.find(p=>p.type==='image');assert.equal(image.source.media_type,'image/jpeg');assert.equal(image.source.data,bytes.toString('base64'));}
   else assert.equal(content.find(p=>p.type==='image_url').image_url.url,original);
  }
 }
 const before=calls.length;
 const bad='data:image/jpeg;base64,'+bytes.subarray(0,-2).toString('base64');
 assert.equal((await api(alice,'/api/conversation',{providerId:'platform:preset',modelId:'m',images:[bad],multimodal:true})).status,400);assert.equal(calls.length,before);
});

test('纯对话关闭多模态、坏图片、助手伪造图片及不支持图片的模型均在调用前拒绝',async()=>{
 const base={providerId:'personal:mine',modelId:'m',message:'看图'};
 for(const patch of [{images:[PNG]},{images:['bad'],multimodal:true},{multimodal:true,history:[{role:'assistant',content:'图',images:[PNG]}]},{multimodal:'true'}]) assert.equal((await api(alice,'/api/conversation',{...base,...patch})).status,400);
 const store=cloud.providerStore(alice.user.id);await store.updateModel('mine','m',{visionInput:false});
 try {assert.equal((await api(alice,'/api/conversation',{...base,multimodal:true,images:[PNG]})).status,400);}finally{await store.updateModel('mine','m',{visionInput:true});}
 assert.equal(calls.length,0);assert.equal(cloud.usage(alice.user.id).userCalls,0);
});

test('纯对话能力目录与思考偏好共享绘图配置且不会改变其他用户',async()=>{
 await provider(admin,'platform','conversation-thinking','fixture-thinking-key');
 await cloud.platform.updateModel('conversation-thinking','m',{thinkingMode:'enable-thinking-off',capabilityProfile:'custom',reasoningLevels:['low','high']});
 const key='platform:conversation-thinking';const before=structuredClone(cloud.platform.getRaw('conversation-thinking'));
 assert.equal((await api(alice,'/api/preferences',{providerId:key,modelId:'m',thinkingMode:'enable-thinking-on',reasoningEffort:'high'},'PUT')).status,200);
 const catalog=await(await api(alice,'/api/conversation/models')).json();const model=catalog.providers.find(p=>p.providerId===key).models[0];
 assert.equal(model.visionInput,true);assert.equal(model.thinkingFamily,'enable-thinking');assert.equal(model.thinkingMode,'enable-thinking-on');assert.deepEqual(model.capabilities.reasoningLevels,['low','high']);
 assert.ok(!JSON.stringify(catalog).includes('fixture-thinking-key'));
 for(const [client,on] of [[alice,true],[admin,false]]) {outputs=['回复'];const r=await api(client,'/api/conversation',{providerId:key,modelId:'m',message:'思考一下'});assert.equal(r.status,200);assert.equal(calls.at(-1).body.enable_thinking,on);assert.equal(calls.at(-1).body.reasoning_effort,on?'high':undefined);}
 assert.deepEqual(cloud.platform.getRaw('conversation-thinking'),before);
});

test('推理档位检测需要确认且平台限管理员；检测结果驱动目录和个人额度',async()=>{
 const endpoint='/api/providers/personal:mine/models/m/reasoning-detect';
 assert.equal((await api(alice,endpoint,{})).status,400);
 assert.equal((await api(alice,'/api/providers/platform:preset/models/m/reasoning-detect',{confirm:true})).status,403);assert.equal(calls.length,0);
 probeMode='validating';const response=await api(alice,endpoint,{confirm:true});assert.equal(response.status,200);const result=await response.json();
 assert.deepEqual(result.outcome.reasoningLevels,['low','high','max']);assert.equal(result.outcome.requests,7);assert.equal(calls.length,7);
 assert.ok(calls.every(c=>c.headers.authorization==='Bearer fixture-alice-key'&&c.body.max_tokens===64));assert.equal(calls[0].body.reasoning_effort,undefined);
 assert.deepEqual(calls.slice(2).map(c=>c.body.reasoning_effort),['low','medium','high','xhigh','max']);assert.equal(cloud.usage(alice.user.id).platformCalls,0);assert.equal(cloud.usage(alice.user.id).userCalls,7);
 const catalog=await(await api(alice,'/api/conversation/models')).json();assert.deepEqual(catalog.providers.find(p=>p.providerId==='personal:mine').models[0].capabilities.reasoningLevels,['low','high','max']);
 assert.equal((await api(alice,'/api/preferences',{providerId:'personal:mine',modelId:'m',reasoningEffort:'max'},'PUT')).status,200);
 probeMode=null;outputs=['最高档回复'];assert.equal((await api(alice,'/api/conversation',{providerId:'personal:mine',modelId:'m',message:'回复一下'})).status,200);assert.equal(calls.at(-1).body.reasoning_effort,'max');
});

test('流式检测第一段后立即断开，忽略非法参数不产生假档位且旧偏好回退默认',async()=>{
 probeMode='stream';const before=closed;const r=await api(admin,'/api/providers/platform:preset/models/m/reasoning-detect',{confirm:true});assert.equal(r.status,200);
 assert.deepEqual((await r.json()).outcome.reasoningLevels,['low','high','max']);await wait(()=>closed>=before+4);assert.equal(cloud.usage(admin.user.id).platformCalls,7);
 probeMode='silent';calls=[];const silent=await api(alice,'/api/providers/personal:mine/models/m/reasoning-detect',{confirm:true});assert.equal(silent.status,200);
 const result=await silent.json();assert.equal(result.outcome.validation,'non-validating');assert.deepEqual(result.provider.models[0].capabilities.reasoningLevels,[]);assert.equal(calls.length,2);
 const catalog=await(await api(alice,'/api/conversation/models')).json();assert.equal(catalog.providers.find(p=>p.providerId==='personal:mine').models[0].reasoningEffort,null);
});

test('取消档位检测释放并发并保持原记录，免费池在中途耗尽不写入部分结果',async()=>{
 const store=cloud.providerStore(alice.user.id),prior=structuredClone(store.getRaw('mine').models[0].reasoningProbe);
 probeMode='hang';const controller=new AbortController(),before=closed;
 const pending=api(alice,'/api/providers/personal:mine/models/m/reasoning-detect',{confirm:true},'POST',{},controller.signal);
 await wait(()=>calls.length===1);controller.abort();await assert.rejects(pending);await wait(()=>closed>before&&cloud.globalActive===0);
 assert.deepEqual(store.getRaw('mine').models[0].reasoningProbe,prior);
 const platformPrior=structuredClone(cloud.platform.getRaw('preset').models[0].reasoningProbe);
 probeMode='validating';calls=[];cloud.limits.platform=2;
 const r=await api(admin,'/api/providers/platform:preset/models/m/reasoning-detect',{confirm:true});assert.equal(r.status,429);assert.equal(calls.length,2);assert.deepEqual(cloud.platform.getRaw('preset').models[0].reasoningProbe,platformPrior);
});

test('实际枚举错误可完成检测，网关模糊错误停止且不会给目录启用假档位',async()=>{
 const endpoint='/api/providers/personal:mine/models/m/reasoning-detect';
 probeMode='enum-error';let r=await api(alice,endpoint,{confirm:true});assert.equal(r.status,200);
 let result=await r.json();assert.equal(result.outcome.validation,'validating');assert.deepEqual(result.provider.models[0].capabilities.reasoningLevels,['low','high','max']);assert.equal(calls.length,7);
 probeMode='hidden-error';calls=[];r=await api(alice,endpoint,{confirm:true});assert.equal(r.status,200);
 result=await r.json();assert.equal(result.outcome.validation,'unknown');assert.equal(result.outcome.requests,2);assert.equal(calls.length,2);
 assert.match(result.outcome.reason,/普通请求已成功/);assert.deepEqual(result.provider.models[0].capabilities.reasoningLevels,[]);
 assert.ok(!JSON.stringify(result).includes('fixture-alice-key'));
 const catalog=await(await api(alice,'/api/conversation/models')).json();assert.deepEqual(catalog.providers.find(p=>p.providerId==='personal:mine').models[0].capabilities.reasoningLevels,[]);
});

test('8位纯数字密码可创建账号，自助改密验证旧密码并撤销所有旧会话',async()=>{
 const old='12345678',next='87654321';
 const create=await api(admin,'/api/users',{username:'password-user',password:old});assert.equal(create.status,201);
 assert.equal((await api(admin,'/api/users',{username:'short-user',password:'1234567'})).status,400);
 async function signIn(password){const r=await api(null,'/api/auth/login',{username:'password-user',password});if(r.status!==200)return {status:r.status};return {status:r.status,cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};}
 const first=await signIn(old),second=await signIn(old);assert.equal(first.status,200);
 assert.equal((await api(first,'/api/auth/password',{currentPassword:'wrong',newPassword:next})).status,400);
 assert.equal((await api(first,'/api/auth/password',{currentPassword:old,newPassword:'1234567'})).status,400);
 assert.equal((await api(first,'/api/auth/password',{currentPassword:old,newPassword:next},'POST',{'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await api(first,'/api/models/catalog')).status,200);
 assert.equal((await api(first,'/api/auth/password',{currentPassword:old,newPassword:next})).status,200);
 for(const client of [first,second])assert.equal((await api(client,'/api/models/catalog')).status,401);
 assert.equal((await signIn(old)).status,401);assert.equal((await signIn(next)).status,200);
 const raw=fs.readFileSync(path.join(directory,'state.enc'),'utf8');assert.ok(!raw.includes(next));
});
test('管理员可重置普通用户8位密码，普通用户不能重置别人或绕过本人旧密码',async()=>{
 const r=await api(null,'/api/auth/login',{username:'password-user',password:'87654321'});assert.equal(r.status,200);const user={cookie:r.headers.get('set-cookie').split(';')[0],...(await r.json())};
 const route='/api/users/'+user.user.id+'/password';
 assert.equal((await api(user,route,{newPassword:'22222222'})).status,403);
 assert.equal((await api(admin,'/api/users/'+admin.user.id+'/password',{newPassword:'22222222'})).status,400);
 assert.equal((await api(admin,route,{newPassword:'2222222'})).status,400);
 assert.equal((await api(admin,route,{newPassword:'22222222'})).status,200);
 assert.equal((await api(user,'/api/models/catalog')).status,401);
 assert.equal((await api(null,'/api/auth/login',{username:'password-user',password:'87654321'})).status,401);
 const next=await api(null,'/api/auth/login',{username:'password-user',password:'22222222'});assert.equal(next.status,200);
 assert.equal((await api(admin,'/api/models/catalog')).status,200);
});


test('文档解析保持登录/CSRF边界，普通用户可上传，提取不消耗模型调用，正文通过个人模型并可追问',async()=>{
 const upload={name:'项目说明.txt',data:Buffer.from('项目：松林。\n预算：73021 元。').toString('base64')};
 assert.equal((await api(null,'/api/conversation/documents',upload)).status,401);
 assert.equal((await api(alice,'/api/conversation/documents',upload,'POST',{'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await api(alice,'/api/conversation/documents',upload,'POST',{Origin:'https://evil.example'})).status,403);
 const extracted=await api(alice,'/api/conversation/documents',upload);assert.equal(extracted.status,200);const document=(await extracted.json()).document;
 assert.equal(cloud.usage(alice.user.id).userCalls,0);assert.equal(cloud.globalActive,0);assert.equal(calls.length,0);
 outputs=['项目预算为73021元'];
 const first=await api(alice,'/api/conversation',{providerId:'personal:mine',modelId:'m',message:'预算多少？',documents:[document],multimodal:false});
 assert.equal(first.status,200);assert.ok(calls.at(-1).body.messages.some(m=>typeof m.content==='string'&&m.content.includes('73021')));
 outputs=['单位为元'];
 const follow=await api(alice,'/api/conversation',{providerId:'personal:mine',modelId:'m',message:'单位是什么？',documents:[document],history:[{role:'user',content:'预算多少？'},{role:'assistant',content:'73021元'}]});
 assert.equal(follow.status,200);assert.ok(calls.at(-1).body.messages.some(m=>typeof m.content==='string'&&m.content.includes('项目说明.txt')));
 assert.equal(cloud.usage(alice.user.id).userCalls,2);assert.equal(cloud.usage(alice.user.id).platformCalls,0);
 const before=calls.length;
 assert.equal((await api(alice,'/api/conversation',{providerId:'personal:mine',modelId:'m',message:'bad',documents:[{...document,text:'a'.repeat(50001)}]})).status,400);assert.equal(calls.length,before);
 assert.equal((await api(alice,'/api/conversation/documents',{name:'bad.docx',data:Buffer.from('bad').toString('base64')})).status,422);
 assert.equal((await api(alice,'/api/usage')).status,200);
});

test('普通用户的 PDF 多页画面通过共享 API 发送，关闭多模态只发文字，扫描件明确拦截',async()=>{
 const {pdfFile}=require('../helpers/document-fixtures.cjs');
 const upload={name:'four-pages.pdf',data:pdfFile('PDF visuals',{pages:4}).toString('base64'),multimodal:true};
 const response=await api(alice,'/api/conversation/documents',upload);assert.equal(response.status,200);const doc=(await response.json()).document;
 assert.equal(doc.pageImages.length,4);assert.equal(calls.length,0);assert.equal(cloud.usage(alice.user.id).userCalls,0);
 const body={providerId:'platform:preset',modelId:'m',message:'看看 PDF',documents:[doc],multimodal:true};
 outputs=['四页画面'];assert.equal((await api(alice,'/api/conversation',body)).status,200);
 const references=calls.at(-1).body.messages[1].content;assert.equal(references.filter(p=>p.type==='image_url').length,4);assert.match(references[7].text,/第 4 页/);
 outputs=['文字'];assert.equal((await api(alice,'/api/conversation',{...body,multimodal:false})).status,200);
 assert.equal(typeof calls.at(-1).body.messages[1].content,'string');assert.match(calls.at(-1).body.messages[1].content,/PDF visuals/);
 const before=calls.length;
 assert.equal((await api(alice,'/api/conversation',{...body,multimodal:false,documents:[{...doc,text:''}]})).status,400);
 assert.equal((await api(alice,'/api/conversation',{...body,documents:[{...doc,pageImages:['bad']}]})).status,400);
 const store=cloud.platform;await store.updateModel('preset','m',{visionInput:false});
 try{assert.equal((await api(alice,'/api/conversation',body)).status,400);}finally{await store.updateModel('preset','m',{visionInput:true});}
 assert.equal(calls.length,before);
});

test('50页PDF完整通过上传和模型请求，超限明确拒绝且不额外调用或扣费',async()=>{
 const {pdfFile}=require('../helpers/document-fixtures.cjs');
 const upload=pages=>api(alice,'/api/conversation/documents',{name:'large.pdf',data:pdfFile('All pages retained',{pages}).toString('base64'),multimodal:true});
 const response=await upload(50);assert.equal(response.status,200);const doc=(await response.json()).document;
 assert.equal(doc.pageImages.length,50);assert.match(doc.text,/\[第 50 页\]/);
 assert.equal(calls.length,0);assert.equal(cloud.usage(alice.user.id).userCalls,0);
 outputs=['已读取全部页面'];
 assert.equal((await api(alice,'/api/conversation',{providerId:'platform:preset',modelId:'m',message:'分析全部页面',documents:[doc],multimodal:true})).status,200);
 const reference=calls[0].body.messages[1].content;
 assert.equal(reference.filter(part=>part.type==='image_url').length,50);assert.match(reference.at(-2).text,/第 50 页/);
 const rejected=await upload(51);assert.equal(rejected.status,422);assert.match((await rejected.json()).error.message,/50 页/);
 assert.equal(calls.length,1);assert.equal(cloud.usage(alice.user.id).userCalls,1);
});

test('后台页面在服务端校验管理员，未登录跳转且禁止缓存',async()=>{
 for(const route of ['/admin.html','/admin','/admin/','/ADMIN.HTML','/%61dmin.html','//admin.html','/x/../admin.html']){const r=await api(null,route);assert.equal(r.status,302,route);assert.equal(r.headers.get('location'),'/login.html?next=%2Fadmin.html');assert.equal(r.headers.get('cache-control'),'no-store');}
 const page=await api(admin,'/admin.html');assert.equal(page.status,200);assert.match(await page.text(),/id="adminContent"/);assert.equal(page.headers.get('cache-control'),'no-store');
 assert.equal((await api(admin,'/admin.html',undefined,'HEAD')).status,200);
 assert.equal((await api(admin,'/admin')).headers.get('location'),'/admin.html');
});
test('普通与Max会员都不能打开后台或直接调用管理接口',async()=>{
 for(const plan of ['free','max']){
  cloud.change(data=>{data.users.find(user=>user.id===alice.user.id).membership={plan,expiresAt:Date.now()+86400000};});
  for(const route of ['/admin.html','/AdMiN.HtMl','/%61dmin.html','//admin.html','/x/../admin.html'])assert.equal((await api(alice,route)).status,403,route);
  for(const route of ['/api/users','/api/membership'])assert.equal((await api(alice,route)).status,403,route);
 }
});
test('退出、停用及伪造来源不能绕过后台页面权限',async()=>{
 assert.equal((await api(admin,'/admin.html',undefined,'GET',{Host:'evil.example'})).status,403);
 assert.equal((await api(admin,'/admin.html',undefined,'GET',{Origin:'https://evil.example'})).status,403);
 const temporary=await login('admin');assert.equal((await api(temporary,'/api/auth/logout',{},'POST')).status,200);assert.equal((await api(temporary,'/admin.html')).status,302);
 await cloud.createUser({identity:{user:cloud.data.users.find(user=>user.id===admin.user.id)}},{username:'admin-disabled-user',password:'test-password-123'});const disabled=await login('admin-disabled-user');cloud.change(data=>{data.users.find(user=>user.id===disabled.user.id).disabled=true;});assert.equal((await api(disabled,'/admin.html')).status,302);
});


test('中转HTTP429拒绝释放周预留，普通与流式回执均为零，检测只请求一次并说明限流',async()=>{
 await cloud.platform.addModel('preset',{modelId:'rate-test'});
 upstreamRejection={error:{message:'Upstream rate limit exceeded, please retry later'}};
 for(const stream of [false,true]){
  const turnId=crypto.randomUUID();
  const response=await api(alice,'/api/conversation',{providerId:'platform:preset',modelId:'rate-test',message:'你好',stream},'POST',{'X-Quota-Turn-Id':turnId});
  const body=await response.text();assert.match(body,/HTTP 429/);
  const receipt=(await(await api(alice,'/api/usage/turns/'+turnId)).json()).turnUsage;
  assert.equal(receipt.calls,1);assert.equal(receipt.weeklyPoints,0);assert.equal(receipt.reservedPoints,0);assert.equal(receipt.estimated,false);assert.equal(receipt.status,'settled');
 }
 assert.equal(calls.length,2);assert.equal(cloud.usage(alice.user.id).weekly.usedPoints,0);
 const detection=await api(admin,'/api/providers/platform:preset/models/rate-test/reasoning-detect',{confirm:true});assert.equal(detection.status,200);
 const result=await detection.json();assert.equal(result.outcome.requests,1);assert.match(result.outcome.reason,/上游限流.*HTTP 429/);assert.deepEqual(result.outcome.reasoningLevels,[]);
 assert.equal(calls.length,3);assert.equal(cloud.usage(admin.user.id).weekly.usedPoints,0);assert.equal(cloud.data.events.at(-1).errorCode,'rate-limited');
 // A rejected response which reports consumption must still settle that usage.
 upstreamRejection.usage={prompt_tokens:100,completion_tokens:100};
 await(await api(alice,'/api/conversation',{providerId:'platform:preset',modelId:'rate-test',message:'已计费用量'})).text();
 assert.equal(cloud.usage(alice.user.id).weekly.usedPoints,.3);assert.equal(cloud.usage(alice.user.id).weekly.reservedPoints,0);
 assert.equal(calls.length,4);
 upstreamRejection={partialStream:true};
 const interrupted=await api(alice,'/api/conversation',{providerId:'platform:preset',modelId:'rate-test',message:'部分输出后失败',stream:true});await interrupted.text();
 assert.equal(cloud.usage(alice.user.id).weekly.usedPoints,1.3);assert.equal(calls.length,5);assert.equal(cloud.data.events.every(e=>e.status==='failed'),true);
});


test('真实中转式枚举响应可持久化五档能力，只检测两次且用户偏好发送正确参数',async()=>{
 const endpoint='/api/providers/personal:mine/models/m/reasoning-detect';probeMode='relay-enum';
 const response=await api(alice,endpoint,{confirm:true});assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.outcome.validation,'validating');assert.equal(result.outcome.requests,2);assert.equal(calls.length,2);assert.match(result.outcome.reason,/按接口声明/);
 const expected=['low','medium','high','xhigh','max'];assert.deepEqual(result.provider.models[0].capabilities.reasoningLevels,expected);
 const catalog=(await(await api(alice,'/api/conversation/models')).json()).providers;assert.deepEqual(catalog.find(p=>p.providerId==='personal:mine').models[0].capabilities.reasoningLevels,expected);
 assert.deepEqual(cloud.providerStore(alice.user.id).getRaw('mine').models[0].reasoningProbe.reasoningLevels,expected);
 assert.equal((await api(alice,'/api/preferences',{providerId:'personal:mine',modelId:'m',reasoningEffort:'xhigh',thinkingMode:'default'},'PUT')).status,200);
 probeMode=null;outputs=['参数检查回复'];assert.equal((await api(alice,'/api/conversation',{providerId:'personal:mine',modelId:'m',message:'检查参数'})).status,200);
 assert.equal(calls.at(-1).body.reasoning_effort,'xhigh');assert.equal(calls.length,3);assert.equal(cloud.usage(alice.user.id).weekly.usedPoints,0);
});


test('流式末尾空choices用量保存缓存，重试回执合计加权，缺失/零/失败可区分且计费不打折',async()=>{
 await cloud.platform.addModel('preset',{modelId:'cache-model'});const turnId=crypto.randomUUID();
 for(const mode of ['hit','zero','missing','failed']){
  cacheMode=mode;const response=await api(alice,'/api/conversation',{providerId:'platform:preset',modelId:'cache-model',message:'缓存用量',stream:true},'POST',{'X-Quota-Turn-Id':turnId});await response.text();
  assert.equal(calls.at(-1).body.stream_options.include_usage,true);
 }
 const receipt=(await(await api(alice,'/api/usage/turns/'+turnId)).json()).turnUsage;
 assert.equal(receipt.calls,4);assert.equal(receipt.weeklyPoints,2.2);assert.equal(receipt.reservedPoints,0);assert.equal(receipt.estimated,false);
 assert.equal(receipt.cache.cachedTokens,1600);assert.equal(receipt.cache.inputTokens,3000);assert.equal(receipt.cache.knownCalls,3);assert.equal(receipt.cache.unknownCalls,1);assert.equal(receipt.cache.hitRate,1600/3000*100);
 const report=(await(await api(alice,'/api/usage/report')).json());assert.deepEqual(report.summary.cache,receipt.cache);assert.equal(report.events.filter(e=>e.cache.cachedTokens===0).length,1);assert.equal(report.events.filter(e=>e.cache.cachedTokens===null).length,1);assert.ok(!JSON.stringify(report).includes('private'));
 assert.equal((await api(admin,'/api/usage/turns/'+turnId)).status,404);
});


test('HTTP200流式繁忙在生成前零扣点，部分回答/思考/用量仍结算，回执及报表一致且无自动重试',async()=>{
 await cloud.platform.addModel('preset',{modelId:'busy-test'});
 let expected=0;
 for(const [events,points]of [
  [[],0],[[{choices:[{delta:{role:'assistant',content:''}}]}],0],
  [[{choices:[{delta:{content:'部分输出'}}]}],1],
  [[{choices:[{delta:{reasoning_content:'private reasoning'}}]}],1],
  [[{choices:[{delta:{tool_calls:[{id:'call1'}]}}]}],1],
  [[{choices:[],usage:{prompt_tokens:100,completion_tokens:100}}],.3],
 ]){
  upstreamRejection={streamBusy:true,events};const turnId=crypto.randomUUID();
  const r=await api(alice,'/api/conversation',{providerId:'platform:preset',modelId:'busy-test',message:'繁忙测试',stream:true},'POST',{'X-Quota-Turn-Id':turnId});
  const text=await r.text();assert.match(text,/上游服务繁忙/);assert.ok(!text.includes('private reasoning'));
  const receipt=(await(await api(alice,'/api/usage/turns/'+turnId)).json()).turnUsage;
  assert.equal(receipt.weeklyPoints,points);assert.equal(receipt.estimated,points===1);assert.equal(receipt.reservedPoints,0);assert.equal(receipt.status,'settled');assert.equal(receipt.calls,1);
  expected+=points;assert.equal(cloud.usage(alice.user.id).weekly.usedPoints,expected);
 }
 assert.equal(calls.length,6);assert.equal(cloud.data.events.every(e=>e.status==='failed'&&e.errorCode==='upstream-busy'),true);
 const report=(await(await api(alice,'/api/usage/report')).json());assert.equal(report.events.length,6);assert.equal(report.events.filter(e=>e.quota.points===0).length,2);assert.ok(!JSON.stringify(report).includes('private reasoning'));
});
