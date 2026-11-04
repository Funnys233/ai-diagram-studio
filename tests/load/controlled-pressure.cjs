'use strict';
// Run against an isolated data directory and a loopback-only mock upstream.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {performance,monitorEventLoopDelay}=require('node:perf_hooks');
const root=path.resolve(process.env.PRESSURE_APP_ROOT||path.join(__dirname,'../..'));
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-pressure-'));
const password=crypto.randomBytes(24).toString('base64url');
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://pressure.invalid',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'pressureadmin',CLOUD_ADMIN_PASSWORD:password,CLOUD_CHATGPT_OWNER:'',CLOUD_FREE_MODELS:'[]',CLOUD_TOTAL_CONCURRENCY:'6',CLOUD_USER_CONCURRENCY:'1',DEEPSEEK_API_KEY:'',PROVIDERS_CONFIG_PATH:path.join(directory,'providers.json')});
const service=require(path.join(root,'lib/model-service')),original=service.callWithLock;
let gatewayBase;
service.callWithLock=(lock,messages,timeout,options)=>{assert.equal(lock.providerId,'pressure');return original({...lock,baseUrl:gatewayBase},messages,timeout,{...options,networkPolicy:false});};
const {createServer,cloudRuntime:cloud}=require(path.join(root,'server'));
let app,gateway,base,calls=0,maxUpstream=0,maxActive=0,peakRss=0,readRequests=0;
const streams=new Set(),agent=new http.Agent({keepAlive:true,maxSockets:40});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const frame=data=>'data: '+JSON.stringify(data)+'\n\n';
function api(client,route,body,method=body===undefined?'GET':'POST'){
 readRequests++;
 return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,agent,headers:{Host:'pressure.invalid',Origin:'https://pressure.invalid','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{})}},res=>resolve(new Response(require('node:stream').Readable.toWeb(res),{status:res.statusCode,headers:res.headers})));req.setTimeout(10000,()=>req.destroy(Error('request-timeout')));req.on('error',reject);if(body!==undefined)req.end(JSON.stringify(body));else req.end();});
}
async function json(client,route,body){const res=await api(client,route,body);return {status:res.status,data:await res.json()};}
async function login(username){const res=await api(null,'/api/auth/login',{username,password});assert.equal(res.status,200);const data=await res.json();return {cookie:res.headers.get('set-cookie').split(';')[0],csrf:data.csrf,userId:data.user.id};}
async function waitFor(predicate,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await delay(30);}throw Error('condition-timeout');}
function request(duration=800){return {taskId:crypto.randomUUID(),threadId:crypto.randomUUID(),assistantId:crypto.randomUUID(),message:'pressure-duration:'+duration,providerId:'platform:pressure',modelId:'pressure-open-model',stream:true};}
async function terminal(client,id){await waitFor(async()=>{const result=await json(client,'/api/conversation/tasks/'+id);assert.equal(result.status,200);return result.data.task.status!=='running';});return (await json(client,'/api/conversation/tasks/'+id)).data.task;}
function summary(values){const sorted=[...values].sort((a,b)=>a-b);return {count:sorted.length,p50Ms:+sorted[Math.floor(sorted.length*.5)].toFixed(2),p95Ms:+sorted[Math.min(sorted.length-1,Math.floor(sorted.length*.95))].toFixed(2),maxMs:+sorted.at(-1).toFixed(2)};}
async function reads(clients,concurrency,count=180){const values=[],errors=[];let cursor=0;const start=performance.now(),routes=['/api/auth/session','/api/conversation/models','/api/usage','/chat.html','/topbar-toggle.js'];await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const i=cursor++;if(i>=count)return;const at=performance.now();try{const res=await api(clients[i%clients.length],routes[i%routes.length]);await res.arrayBuffer();if(res.status!==200)errors.push(res.status);}catch(error){errors.push(error.message);}values.push(performance.now()-at);}}));assert.equal(errors.length,0,'Read endpoint errors');return {concurrency,...summary(values),elapsedMs:+(performance.now()-start).toFixed(2),errors:errors.length};}
const report={kind:'isolated-same-server',externalModelCalls:0,limits:{total:6,perUser:1},checks:[],readStages:[],at:new Date().toISOString()};
const loop=monitorEventLoopDelay({resolution:10});loop.enable();
const sample=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss);maxActive=Math.max(maxActive,cloud.globalActive);},25);
(async()=>{
 gateway=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{const body=JSON.parse(raw);calls++;const duration=Number(JSON.stringify(body.messages).match(/pressure-duration:(\d+)/)?.[1]||800);res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frame({choices:[{delta:{content:'已开始。'}}]}));streams.add(res);maxUpstream=Math.max(maxUpstream,streams.size);const timer=setInterval(()=>res.write(frame({choices:[{delta:{content:'压力测试流式正文。'.repeat(24)}}]})),50);const end=setTimeout(()=>res.end(frame({choices:[{delta:{content:'完成。'},finish_reason:'stop'}],usage:{prompt_tokens:2000,completion_tokens:1000}})+'data: [DONE]\n\n'),duration);res.once('close',()=>{clearInterval(timer);clearTimeout(end);streams.delete(res);});});});
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));gatewayBase='http://127.0.0.1:'+gateway.address().port;
 app=createServer();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;
 const owner=cloud.data.users[0];for(let i=0;i<12;i++)await cloud.createUser({identity:{user:owner}},{username:'loaduser'+i,password});
 await cloud.platform.createProvider({providerId:'pressure',name:'Isolated pressure model',protocol:'openai-chat-completions',baseUrl:'https://api.fixture.example',apiKey:'mock-only',models:[{modelId:'pressure-open-model'}]});
 const clients=[];for(let i=0;i<12;i++)clients.push(await login('loaduser'+i));
 assert.equal(cloud.limits.concurrentTotal,6);assert.equal(cloud.limits.concurrentUser,1);
 for(const concurrency of [6,12,24])report.readStages.push(await reads(clients,concurrency));console.log(JSON.stringify({phase:'isolated-reads-complete',stages:report.readStages}));
 const held=[];for(let i=0;i<6;i++){const body=request(8000),result=await json(clients[i],'/api/conversation/tasks',body);assert.equal(result.status,202);held.push({client:clients[i],body});}
 await waitFor(()=>streams.size===6);assert.equal(cloud.globalActive,6);
 const beforeRejected=calls;
 const same=await json(clients[0],'/api/conversation/tasks',request()),seventh=await json(clients[6],'/api/conversation/tasks',request());assert.equal(same.status,429);assert.equal(seventh.status,429);assert.equal(calls,beforeRejected);
 report.checks.push('6 active streams; seventh and duplicate user receive 429 without an upstream call');
 // Disconnect a viewer, then reconnect without creating another model request.
 const events=await api(held[0].client,'/api/conversation/tasks/'+held[0].body.taskId+'/events'),reader=events.body.getReader();await reader.read();await reader.cancel();assert.equal(cloud.globalActive,6);
 const again=await json(held[0].client,'/api/conversation/tasks',held[0].body);assert.equal(again.status,200);assert.equal(calls,beforeRejected);report.checks.push('Viewer disconnect and repeated creation retain one background task and one charge');
 report.readDuringSixStreams=await reads(clients,24,240);
 assert.equal((await json(held[5].client,'/api/conversation/tasks/'+held[5].body.taskId+'/cancel',{})).status,200);assert.equal((await terminal(held[5].client,held[5].body.taskId)).status,'cancelled');
 const replacement=request(600);assert.equal((await json(clients[6],'/api/conversation/tasks',replacement)).status,202);assert.equal((await terminal(clients[6],replacement.taskId)).status,'succeeded');report.checks.push('Explicit cancellation releases capacity for another user');
 for(const row of held.slice(0,5)){const result=await terminal(row.client,row.body.taskId);assert.equal(result.status,'succeeded');assert.ok(result.reply.endsWith('完成。'));assert.equal(result.turnUsage.calls,1);}
 await waitFor(()=>cloud.globalActive===0&&streams.size===0);report.checks.push('Six-stream terminal replies persist completely and all capacity is released');
 let accepted=0,rejected=0;
 for(let wave=0;wave<8;wave++){
  const jobs=await Promise.all(clients.map(async(client)=>{const body=request(800),result=await json(client,'/api/conversation/tasks',body);return {client,body,...result};}));
  assert.equal(jobs.filter(j=>j.status===202).length,6);assert.equal(jobs.filter(j=>j.status===429).length,6);accepted+=6;rejected+=6;
  for(const j of jobs.filter(j=>j.status===202))assert.equal((await terminal(j.client,j.body.taskId)).status,'succeeded');await waitFor(()=>cloud.globalActive===0&&streams.size===0);
 }
 assert.equal(maxActive,6);assert.equal(maxUpstream,6);assert.equal(calls,55);assert.equal(cloud.data.events.length,calls);assert.equal(cloud.data.events.filter(e=>e.status==='started').length,0);assert.equal(cloud.data.weeklyQuota.calls.filter(c=>c.status==='pending').length,0);
 report.overload={waves:8,concurrentSubmissions:12,accepted,rejectedAsExpected:rejected,maxActive,maxUpstream};report.checks.push('8 overload waves accept exactly 6 and reject 6; no leaked slots or pending billing');
 const final=await reads(clients,6,60);report.afterLoad=final;
 Object.assign(report,{success:true,mockModelCalls:calls,httpRequests:readRequests,peakRssMiB:+(peakRss/1048576).toFixed(2),eventLoopP95Ms:+(loop.percentile(95)/1e6).toFixed(2),eventLoopMaxMs:+(loop.max/1e6).toFixed(2),cpuSeconds:+((process.cpuUsage().user+process.cpuUsage().system)/1e6).toFixed(2),dataIsolated:true});
})().catch(error=>{report.success=false;report.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}).finally(async()=>{clearInterval(sample);loop.disable();if(app){await app.conversationTasks.close();app.closeAllConnections();await new Promise(resolve=>app.close(resolve));}if(gateway){gateway.closeAllConnections();await new Promise(resolve=>gateway.close(resolve));}agent.destroy();fs.rmSync(directory,{recursive:true,force:true});console.log('PRESSURE_REPORT '+JSON.stringify(report));});
