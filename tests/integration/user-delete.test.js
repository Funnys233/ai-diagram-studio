const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-delete-users-'));
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'12345678',CLOUD_CHATGPT_OWNER:'admin',DEEPSEEK_API_KEY:''});
const {createServer,cloudRuntime:cloud}=require('../../server');let app,base,admin;
async function api(client,route,body,method=body===undefined?'GET':'POST',extra={}){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method,headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(body!==undefined?{'Content-Length':Buffer.byteLength(JSON.stringify(body))}:{}),...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...extra}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,text,headers:res.headers});});});req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});}
async function login(name){const r=await api(null,'/api/auth/login',{username:name,password:'12345678'});assert.equal(r.status,200);return {...r.data,cookie:r.headers['set-cookie'][0].split(';')[0]};}
const request=user=>({identity:{user:cloud.data.users.find(u=>u.id===user.user.id),session:cloud.data.sessions.find(s=>s.userId===user.user.id)}});
async function create(name){await cloud.createUser(request(admin),{username:name,password:'12345678'});return login(name);}
const remove=(user,body={username:user.user.username},client=admin,extra={})=>api(client,'/api/users/'+user.user.id,body,'DELETE',extra);
function charge(user,pending=false){const options=cloud.callOptions(request(user),'platform','fixture','gpt-6-luna'),id=options.beforeCall();if(!pending)options.afterCall(id,{usage:{input_tokens:100,output_tokens:100}},null);return {options,id};}
test.before(async()=>{app=createServer();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;admin=await login('admin');});
test.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
test('管理员删除用户撤销所有会话、个人配置、卡和偏好，保留历史与账本',async()=>{
 const user=await create('deleteuser');const otherSession=await login('deleteuser'),store=cloud.providerStore(user.user.id);await store.createProvider({providerId:'mine',name:'个人测试',baseUrl:'https://fixture.example',apiKey:'fixture-private',protocol:'openai-chat-completions'});
 cloud.change(data=>{data.preferences[user.user.id]={fixture:{reasoningEffort:'high'}};data.users.find(u=>u.id===user.user.id).resetCards=3;});charge(user);const before=structuredClone(cloud.data),providerFile=store.filePath;
 const r=await remove(user);assert.equal(r.status,200);assert.equal(r.data.deleted,true);assert.equal(r.data.configurationRemoved,true);assert.ok(!cloud.data.users.some(u=>u.id===user.user.id));assert.ok(!fs.existsSync(providerFile));assert.ok(!cloud.stores.has(user.user.id));assert.ok(!cloud.data.preferences[user.user.id]);assert.ok(!cloud.data.sessions.some(s=>s.userId===user.user.id));assert.deepEqual(cloud.data.events,before.events);assert.deepEqual(cloud.data.weeklyQuota,before.weeklyQuota);assert.deepEqual(cloud.data.usage,before.usage);
 for(const session of [user,otherSession]){assert.equal((await api(session,'/api/auth/session')).data.user,null);assert.equal((await api(session,'/api/usage')).status,401);}
 assert.equal((await api(null,'/api/auth/login',{username:'deleteuser',password:'12345678'})).status,401);assert.equal((await remove(user)).status,404);
 const metadata=cloud.data.deletedUsers.find(u=>u.id===user.user.id);assert.deepEqual(Object.keys(metadata).sort(),['deletedAt','id','username']);assert.equal(metadata.username,'deleteuser');
 const audit=(await api(admin,'/api/membership')).data.audit;assert.equal(audit[0].action,'delete-user');assert.equal(audit[0].targetUsername,'deleteuser（已删除）');
});
test('删除历史支持管理员筛选，同名重注册为新体验用户不继承历史或卡',async()=>{
 const old=cloud.data.deletedUsers.find(u=>u.username==='deleteuser'),report=(await api(admin,'/api/usage/report?userId='+old.id)).data;assert.equal(report.summary.calls,1);assert.equal(report.events[0].username,'deleteuser（已删除）');assert.ok(report.filters.users.some(u=>u.id===old.id));
 const r=await api(null,'/api/auth/register',{username:'deleteuser',password:'12345678'});assert.equal(r.status,201);assert.notEqual(r.data.user.id,old.id);assert.equal(r.data.user.membership.plan,'trial');assert.equal(r.data.usage.resetCards.balance,0);assert.equal(r.data.usage.userCalls,0);assert.equal(r.data.usage.weekly.usedPoints,0);
 const fresh={...r.data,cookie:r.headers['set-cookie'][0].split(';')[0]};assert.ok([400,403].includes((await api(fresh,'/api/usage/report?userId='+old.id)).status));
});
test('删除接口校验管理员、CSRF、来源、确认账号和保护账号',async()=>{
 const user=await create('guardeduser'),route='/api/users/'+user.user.id;
 assert.equal((await remove(user,{username:'guardeduser'},null)).status,401);assert.equal((await remove(user,{username:'guardeduser'},user)).status,403);
 for(const headers of [{'X-CSRF-Token':'bad'},{Origin:'https://evil.example'}])assert.equal((await remove(user,{username:'guardeduser'},admin,headers)).status,403);
 for(const body of [{},{username:'wrong'},{username:'guardeduser',role:'admin'},null,[]])assert.equal((await remove(user,body)).status,400);
 assert.equal((await remove(admin)).status,403);const other=await create('protectedadmin');cloud.change(data=>data.users.find(u=>u.id===other.user.id).role='admin');assert.equal((await remove(other)).status,403);
 assert.ok(cloud.data.users.some(u=>u.id===user.user.id));assert.equal((await api(user,'/api/usage')).status,200);
});
test('在途模型请求或活跃请求阻止删除，结算后可删除且历史消费保留',async()=>{
 const user=await create('busyuser'),pending=charge(user,true),before=structuredClone(cloud.data);assert.equal((await remove(user)).status,409);assert.deepEqual(cloud.data,before);
 pending.options.afterCall(pending.id,{usage:{input_tokens:100,output_tokens:100}},null);cloud.active.set(user.user.id,1);assert.equal((await remove(user)).status,409);cloud.active.delete(user.user.id);assert.equal((await remove(user)).status,200);assert.equal(cloud.data.weeklyQuota.calls.find(c=>c.id===pending.id).chargedCredits,300);
});
test('持久化失败时恢复个人配置文件，用户、会话和审计均不删除',async()=>{
 const user=await create('atomicuser'),store=cloud.providerStore(user.user.id);await store.createProvider({providerId:'mine',name:'fixture',baseUrl:'https://fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-private'});const raw=fs.readFileSync(store.filePath),before=structuredClone(cloud.data),file=cloud.file;cloud.file=path.join(directory,'blocked','state.enc');fs.writeFileSync(path.dirname(cloud.file),'block');
 try{assert.throws(()=>cloud.deleteUser(request(admin),user.user.id,{username:'atomicuser'}));assert.deepEqual(cloud.data,before);assert.deepEqual(fs.readFileSync(store.filePath),raw);assert.ok(cloud.stores.has(user.user.id));}finally{cloud.file=file;}
 assert.equal((await api(user,'/api/usage')).status,200);
});
