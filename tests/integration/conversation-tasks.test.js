const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-background-'));
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',DEEPSEEK_API_KEY:''});
const service=require('../../lib/model-service'),original=service.callWithLock;let gatewayBase,calls=0,closed=0,streams=new Set();
service.callWithLock=(lock,messages,timeout,options)=>original({...lock,baseUrl:gatewayBase},messages,timeout,{...options,networkPolicy:false});
const {createServer,cloudRuntime:cloud}=require('../../server'),{createParser}=require('../../lib/sse');
let app,gateway,base,alice,bob,admin;
const frame=data=>'data: '+JSON.stringify(data)+'\n\n';
function api(client,route,body,method=body===undefined?'GET':'POST',extra={}){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...extra}},res=>resolve(new Response(require('node:stream').Readable.toWeb(res),{status:res.statusCode,headers:res.headers})));req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});}
const wait=async predicate=>{for(let i=0;i<300;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('fixture wait timeout');};
const request=()=>({taskId:crypto.randomUUID(),threadId:crypto.randomUUID(),assistantId:crypto.randomUUID(),message:'private-original-never-on-disk',providerId:'platform:tasks',modelId:'m',stream:true});
const status=async(user,id)=>(await(await api(user,'/api/conversation/tasks/'+id)).json()).task;
async function login(name){const response=await api(null,'/api/auth/login',{username:name,password:'fixture-password-123'});assert.equal(response.status,200);return {cookie:response.headers.get('set-cookie').split(';')[0],...(await response.json())};}
function finish(){for(const res of streams)res.write(frame({choices:[{delta:{content:'最终完整正文'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:100}})+'data: [DONE]\n\n');}
test.before(async()=>{
 gateway=http.createServer((req,res)=>{req.resume();req.on('end',()=>{calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(frame({choices:[{delta:{content:'第一段。'}}]}));streams.add(res);res.once('close',()=>{streams.delete(res);closed++;});});});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));gatewayBase='http://127.0.0.1:'+gateway.address().port;
 app=createServer();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;admin=await login('admin');
 for(const name of ['alice','bob'])await cloud.createUser({identity:{user:cloud.data.users[0]}},{username:name,password:'fixture-password-123'});
 alice=await login('alice');bob=await login('bob');await cloud.platform.createProvider({providerId:'tasks',name:'任务测试',protocol:'openai-chat-completions',baseUrl:'https://api.fixture.example',apiKey:'secret-task-provider',models:[{modelId:'m',visionInput:true}]});
});
test.after(async()=>{await app.conversationTasks.close();app.closeAllConnections();gateway.closeAllConnections();await Promise.all([new Promise(resolve=>app.close(resolve)),new Promise(resolve=>gateway.close(resolve))]);fs.rmSync(directory,{recursive:true,force:true});});
test('创建响应和网页连接结束不取消后台生成；刷新订阅同一任务，模型只调用一次',async()=>{
 const body=request(),route='/api/conversation/tasks/'+body.taskId;
 const response=await api(alice,'/api/conversation/tasks',body);assert.equal(response.status,202);await response.json();await wait(()=>calls===1);
 const initial=await status(alice,body.taskId);assert.equal(initial.status,'running');assert.equal(initial.reply,'第一段。');
 const stream=await api(alice,route+'/events'),reader=stream.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/第一段/);await reader.cancel();
 assert.equal(cloud.active.get(alice.user.id),1);assert.equal(closed,0);
 const repeated=await api(alice,'/api/conversation/tasks',body);assert.equal(repeated.status,200);await repeated.json();assert.equal(calls,1);
 assert.equal((await api(alice,'/api/conversation/tasks',{...body,message:'different'})).status,409);
 assert.equal((await api(alice,'/api/conversation/tasks',request())).status,429);assert.equal(calls,1);
 const disk=fs.readFileSync(path.join(directory,'conversation-tasks',body.taskId+'.enc'),'utf8');assert.ok(!disk.includes('第一段'));
 const stored=cloud.codec.decode(disk);assert.equal(stored.reply,'第一段。');assert.ok(!JSON.stringify(stored).includes('private-original-never-on-disk'));assert.ok(!JSON.stringify(stored).includes('secret-task-provider'));
 for(const action of ['', '/events','/cancel','/ack'])assert.equal((await api(bob,route+action,action==='/cancel'||action==='/ack'?{}:undefined)).status,404);
 finish();await wait(async()=> (await status(alice,body.taskId)).status==='succeeded');assert.equal(cloud.active.get(alice.user.id),0);assert.equal(app.conversationTasks.running.size,0);
 const result=await status(alice,body.taskId);assert.equal(result.reply,'第一段。最终完整正文');assert.equal(result.turnUsage.calls,1);assert.equal(result.turnUsage.weeklyPoints,.3);
 const events=[];createParser(e=>events.push({event:e.event,data:JSON.parse(e.data)})).push(await(await api(alice,route+'/events')).text());assert.equal(events.at(-1).event,'result');assert.equal(events.at(-1).data.reply,result.reply);assert.equal(calls,1);
 assert.equal((await api(alice,route+'/ack',{})).status,200);assert.equal((await api(alice,route)).status,410);assert.equal((await api(alice,'/api/conversation/tasks',body)).status,410);
 const released=cloud.codec.decode(fs.readFileSync(path.join(directory,'conversation-tasks',body.taskId+'.enc'),'utf8'));assert.equal(released.reply,'');assert.equal(released.result,undefined);
});
test('只有显式取消停止模型，保留部分正文并正常结算，读取重连均不再扣点',async()=>{
 const before=calls,body=request(),route='/api/conversation/tasks/'+body.taskId;
 assert.equal((await api(alice,'/api/conversation/tasks',body)).status,202);await wait(()=>calls===before+1);
 assert.equal((await api(alice,route+'/ack',{})).status,409);assert.equal((await api(alice,route+'/cancel',{})).status,200);
 await wait(async()=> (await status(alice,body.taskId)).status==='cancelled');const result=await status(alice,body.taskId);
 assert.equal(result.reply,'第一段。');assert.equal(result.turnUsage.status,'settled');assert.equal(result.turnUsage.calls,1);assert.equal(cloud.active.get(alice.user.id),0);
 const events=[];createParser(e=>events.push({event:e.event,data:JSON.parse(e.data)})).push(await(await api(alice,route+'/events')).text());assert.equal(events.at(-1).data.taskTerminal,true);assert.equal(events.at(-1).data.error.code,'task-cancelled');assert.equal(calls,before+1);
 await api(alice,route+'/ack',{});
});
test('鉴权、CSRF、字段及模型权限先校验，不能借任务绕过并发或已使用的用量编号',async()=>{
 const before=calls,body=request();assert.equal((await api(null,'/api/conversation/tasks',body)).status,401);
 assert.equal((await api(alice,'/api/conversation/tasks',body,'POST',{'X-CSRF-Token':'bad'})).status,403);
 for(const patch of [{message:''},{assistantId:'bad'},{modelId:'missing'},{unexpected:1}])assert.ok((await api(alice,'/api/conversation/tasks',{...body,...patch})).status>=400);
 assert.equal(calls,before);assert.equal(cloud.active.get(alice.user.id),0);
});
