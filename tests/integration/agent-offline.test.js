'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-offline-')),tokenFile=path.join(directory,'token');fs.writeFileSync(tokenFile,crypto.randomBytes(32).toString('hex'),{mode:0o600});
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://fixture.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password',CLOUD_CHATGPT_OWNER:'',DSH_MODEL_SOURCE:'site',DSH_BRIDGE_TOKEN_FILE:tokenFile,DSH_PUBLIC_ENABLED:'false',DEEPSEEK_API_KEY:''});
const {createServer}=require('../../server');let app,port,cookie='',csrf='';
function request(route,{body,method=body===undefined?'GET':'POST',authenticated=true}={}){return new Promise((resolve,reject)=>{const text=body===undefined?null:JSON.stringify(body);const req=http.request({host:'127.0.0.1',port,path:route,method,headers:{Host:'fixture.example',Origin:'https://fixture.example',...(text?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)}:{}),...(authenticated?{Cookie:cookie,'X-CSRF-Token':csrf}:{})}},res=>{let raw='';res.setEncoding('utf8');res.on('data',c=>raw+=c);res.on('end',()=>{let data;try{data=JSON.parse(raw);}catch{}resolve({status:res.statusCode,headers:res.headers,data,raw});});});req.on('error',reject);req.end(text);});}
test.before(async()=>{app=createServer({agentClient:{configured:false},agentEnabled:false});await new Promise(r=>app.listen(0,'127.0.0.1',r));port=app.address().port;const login=await request('/api/auth/login',{authenticated:false,body:{username:'admin',password:'fixture-password'}});assert.equal(login.status,200);cookie=login.headers['set-cookie'][0].split(';')[0];csrf=login.data.csrf;});
test.after(async()=>{await Promise.all([app.agentTasks.close(),app.conversationTasks.close(),app.drawingTasks.close()]);app.closeAllConnections();await new Promise(r=>app.close(r));fs.rmSync(directory,{recursive:true,force:true});});
test('public off switch blocks normalized DSH pages and all APIs without disabling chat or drawing',async()=>{
 for(const route of ['/agent','/agent/','/agent.html','/AGENT.HTML','/%61gent.html','//agent.html','/some/../agent.html','/api/agent/status','/api/agent/tasks','/api/agent/history','/api/agent/files','/api/agent/models','/api//agent/status','/api/%61gent/status']){
  for(const authenticated of [false,true]){const response=await request(route,{authenticated});assert.equal(response.status,404,route);assert.equal(response.data.error.code,'agent-offline',route);}
 }
 assert.equal((await request('/api/agent/tasks',{body:{}})).status,404);
 const profile=await request('/api/auth/session');assert.equal(profile.status,200);assert.equal(profile.data.features.agent,false);assert.equal(profile.data.user.username,'admin');
 for(const route of ['/','/chat.html','/admin.html','/healthz','/api/usage'])assert.equal((await request(route)).status,200,route);
 assert.equal(app.agentTasks.jobs.size,0);
});
test('reopening the public switch restores existing routes and account menu feature state',async()=>{
 delete process.env.DSH_PUBLIC_ENABLED;
 assert.equal((await request('/api/auth/session')).data.features.agent,true);
 assert.equal((await request('/agent.html')).status,200);
 assert.equal((await request('/api/agent/history')).status,200);
 assert.equal(app.agentTasks.jobs.size,0);
 process.env.DSH_PUBLIC_ENABLED='false';
});
