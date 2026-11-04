const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),http=require('node:http');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-reset-cards-'));
Object.assign(process.env,{APP_MODE:'cloud',PUBLIC_ORIGIN:'https://diagram.example',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'12345678',CLOUD_FREE_MODELS:JSON.stringify([{providerId:'mota',modelId:'free'}]),DEEPSEEK_API_KEY:''});
const {createServer,cloudRuntime:cloud}=require('../../server'),{CloudRuntime}=require('../../lib/cloud-runtime');
let app,base,admin,alice,bob,trial;
async function api(client,route,body,extra={}){return new Promise((resolve,reject)=>{const req=http.request(base+route,{method:body===undefined?'GET':'POST',headers:{Host:'diagram.example',Origin:'https://diagram.example','Content-Type':'application/json',...(client?{Cookie:client.cookie,'X-CSRF-Token':client.csrf}:{}),...extra}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,data,headers:res.headers});});});req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();});}
async function login(name){const r=await api(null,'/api/auth/login',{username:name,password:'12345678'});assert.equal(r.status,200);return {...r.data,cookie:r.headers['set-cookie'][0].split(';')[0]};}
const cards=async user=>(await api(user,'/api/usage')).data.usage.resetCards;
const grant=(user,count=1,revision=0)=>api(admin,'/api/users/'+user.user.id+'/reset-cards',{count,revision});
const direct=(user,revision=0)=>api(admin,'/api/users/'+user.user.id+'/weekly-reset',{revision});
const redeem=(user,revision=1)=>api(user,'/api/usage/weekly-reset',{revision});
function request(user){return {identity:{user:cloud.data.users.find(u=>u.id===user.user.id),session:cloud.data.sessions.find(s=>s.userId===user.user.id)}};}
function charge(user,{source='platform',providerId='paid',modelId='gpt-6-luna',pending=false}={}){const options=cloud.callOptions(request(user),source,providerId,modelId),id=options.beforeCall({reasoningEffort:'low'});if(!pending)options.afterCall(id,{usage:{input_tokens:1000,output_tokens:1000}},null);return {options,id};}
test.before(async()=>{app=createServer();await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+app.address().port;admin=await login('admin');for(const name of ['alice','bob'])await cloud.createUser(request(admin),{username:name,password:'12345678'});alice=await login('alice');bob=await login('bob');await api(null,'/api/auth/register',{username:'trial',password:'12345678'});trial=await login('trial');});
test.beforeEach(()=>cloud.change(data=>{for(const u of data.users){delete u.resetCards;delete u.quotaResetRevision;delete u.weeklyLimitPoints;u.disabled=false;u.membership={plan:u.id===trial.user.id?'trial':'free',expiresAt:null};}delete data.weeklyQuota;data.events=[];data.usageStats.rows=[];data.membershipAudit=[];data.freeDaily={date:new Date().toISOString().slice(0,10),calls:0};data.usage={date:new Date().toISOString().slice(0,10),total:0,platform:0,users:{}};}));
test.after(async()=>{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});

test('旧用户默认零卡，管理员发卡仅改变余额和版本并记录审计',async()=>{
 assert.equal((await cards(alice)).balance,0);charge(alice);const before=structuredClone(cloud.data),r=await grant(alice,3);assert.equal(r.status,200);assert.equal(r.data.user.resetCards.balance,3);assert.equal(r.data.user.resetCards.revision,1);
 assert.deepEqual(cloud.data.weeklyQuota,before.weeklyQuota);assert.deepEqual(cloud.data.events,before.events);assert.deepEqual(cloud.data.freeDaily,before.freeDaily);assert.deepEqual(cloud.data.usage,before.usage);assert.equal((await cards(bob)).balance,0);
 const audit=(await api(admin,'/api/membership')).data.audit;assert.equal(audit[0].action,'reset-cards');assert.equal(audit[0].targetUsername,'alice');assert.equal(audit[0].after.granted,3);
});
test('用卡恢复个人周额度，消费一张并保留限额、历史、免费池和其他用户',async()=>{
 cloud.change(data=>data.users.find(u=>u.id===alice.user.id).weeklyLimitPoints=7000);charge(alice);charge(bob);charge(alice,{providerId:'mota',modelId:'free'});await grant(alice,2);
 const before=structuredClone(cloud.data),oldWeek=cloud.weeklySnapshot(alice.user.id),r=await redeem(alice);assert.equal(r.status,200);assert.equal(r.data.restoredPoints,3);assert.equal(r.data.usage.weekly.usedPoints,0);assert.equal(r.data.usage.weekly.remainingPoints,7000);assert.equal(r.data.usage.weekly.resetAt,oldWeek.resetAt);assert.equal(r.data.usage.resetCards.balance,1);assert.equal(r.data.usage.resetCards.revision,2);
 assert.deepEqual(cloud.data.events,before.events);assert.deepEqual(cloud.data.usage,before.usage);assert.deepEqual(cloud.data.freeDaily,before.freeDaily);assert.deepEqual(cloud.data.weeklyQuota.calls,before.weeklyQuota.calls);assert.equal(cloud.weeklySnapshot(bob.user.id).usedPoints,3);
 charge(alice);assert.equal(cloud.weeklySnapshot(alice.user.id).usedPoints,3);assert.equal(cloud.data.membershipAudit.at(-1).after.useCard,true);
});
test('管理员一键重置无需卡且不扣卡，普通用户不能调用管理员接口',async()=>{
 charge(alice);const r=await direct(alice);assert.equal(r.status,200);assert.equal(r.data.usage.resetCards.balance,0);assert.equal(r.data.usage.weekly.remainingPoints,1000);assert.equal(cloud.data.membershipAudit.at(-1).after.useCard,false);
 for(const suffix of ['reset-cards','weekly-reset'])for(const user of [alice,bob])assert.equal((await api(user,'/api/users/'+alice.user.id+'/'+suffix,{count:1,revision:0})).status,403);
});
test('并发发卡和重复兑换最多成功一次，旧版本重试不再次发卡或扣卡',async()=>{
 const grants=await Promise.all([grant(alice,2),grant(alice,2)]);assert.deepEqual(grants.map(r=>r.status).sort(),[200,409]);assert.equal((await cards(alice)).balance,2);
 charge(alice);const results=await Promise.all([redeem(alice),redeem(alice)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await cards(alice)).balance,1);charge(alice);assert.equal((await redeem(alice)).status,409);assert.equal(cloud.weeklySnapshot(alice.user.id).usedPoints,3);assert.equal((await cards(alice)).balance,1);
});
test('进行中、空周、无卡和试用用户失败不扣卡不改账本，预留仍正常结算',async()=>{
 await grant(alice,2);const p=charge(alice,{pending:true});const before=structuredClone(cloud.data);assert.equal((await redeem(alice)).data.error.code,'weekly-reset-pending');assert.equal((await direct(alice,1)).status,409);assert.deepEqual(cloud.data,before);
 p.options.afterCall(p.id,{usage:{input_tokens:1000,output_tokens:1000}},null);assert.equal((await redeem(alice)).status,200);assert.equal((await redeem(alice,2)).data.error.code,'weekly-reset-empty');assert.equal((await cards(alice)).balance,1);
 charge(bob);assert.equal((await redeem(bob,0)).data.error.code,'reset-card-empty');await grant(trial,2);assert.equal((await redeem(trial)).status,403);assert.equal((await direct(trial,1)).status,403);assert.equal((await cards(trial)).balance,2);assert.equal(cloud.weeklyLimit(trial.user.id),0);
});
test('鉴权、CSRF、Origin、用户目标、未知字段及数量边界检查',async()=>{
 const route='/api/users/'+alice.user.id+'/reset-cards';assert.equal((await api(null,route,{count:1,revision:0})).status,401);assert.equal((await api(admin,route,{count:1,revision:0},{'X-CSRF-Token':'bad'})).status,403);assert.equal((await api(admin,route,{count:1,revision:0},{Origin:'https://evil.example'})).status,403);
 for(const count of [0,-1,1.5,1001,'1'])assert.equal((await grant(alice,count)).status,400);
 for(const body of [{count:1},{count:1,revision:-1},{count:1,revision:'0'},{count:1,revision:0,plan:'max'},null,[]])assert.equal((await api(admin,route,body)).status,400);
 assert.equal((await api(alice,'/api/usage/weekly-reset',{revision:0,userId:bob.user.id})).status,400);assert.equal((await api(admin,'/api/users/'+crypto.randomUUID()+'/reset-cards',{count:1,revision:0})).status,404);
 cloud.change(data=>data.users.find(u=>u.id===alice.user.id).resetCards=10000);assert.equal((await grant(alice)).status,400);assert.equal((await cards(alice)).balance,10000);
});
test('重启后卡和版本保留，升降级、自然周切换不清卡，重置不提升会员权限',async()=>{
 await grant(alice,3);charge(alice);await redeem(alice);const restored=new CloudRuntime(process.env,process.cwd());assert.equal(restored.resetCardState(alice.user.id).balance,2);assert.equal(restored.resetCardState(alice.user.id).revision,2);assert.equal(restored.weeklySnapshot(alice.user.id).usedPoints,0);assert.equal(restored.data.membershipAudit.length,2);
 cloud.setMembership(request(admin),alice.user.id,{plan:'trial',expiresAt:null});assert.equal((await cards(alice)).balance,2);assert.equal((await redeem(alice,2)).status,403);cloud.setMembership(request(admin),alice.user.id,{plan:'pro',expiresAt:Date.now()+86400000});assert.equal((await cards(alice)).balance,2);assert.equal(cloud.weeklyLimit(alice.user.id),5000);
 const oldWindow=cloud.data.weeklyQuota.windows.find(w=>w.ownerKey===alice.user.id);oldWindow.weekStart-=7*86400000;assert.equal((await cards(alice)).balance,2);assert.equal(cloud.weeklySnapshot(alice.user.id).usedPoints,0);
});
test('重置提交持久化失败时卡、账本和审计均不发布',async()=>{
 await grant(alice,2);charge(alice);const before=structuredClone(cloud.data),file=cloud.file;cloud.file=path.join(directory,'non-directory','state.enc');fs.writeFileSync(path.dirname(cloud.file),'block');
 try{assert.throws(()=>cloud.resetWeekly(request(alice),alice.user.id,{revision:1},{useCard:true}));assert.deepEqual(cloud.data,before);}finally{cloud.file=file;}
});

const paid=(user,plan)=>cloud.setMembership(request(admin),user.user.id,{plan,expiresAt:Date.now()+86400000});
async function batchTargets(action){const users=(await api(admin,'/api/users')).data.users;return users.filter(u=>action==='reset-cards'?!u.disabled&&['pro','max'].includes(u.membership.plan):u.resetCards.canReset).map(u=>({id:u.id,revision:u.resetCards.revision}));}
const batch=(action,targets,count=1,client=admin)=>api(client,'/api/users/bulk-'+action,{targets,...(action==='reset-cards'?{count}:{})});
test('批量发卡只给有效Pro与Max，不发普通或体验，且不更改额度和历史',async()=>{
 paid(alice,'pro');paid(bob,'max');charge(alice);const targets=await batchTargets('reset-cards'),before=structuredClone(cloud.data),r=await batch('reset-cards',targets,2);
 assert.equal(r.status,200);assert.deepEqual(r.data,{processed:2,restoredPoints:0,totalCards:4});assert.equal((await cards(alice)).balance,2);assert.equal((await cards(bob)).balance,2);assert.equal((await cards(admin)).balance,0);assert.equal((await cards(trial)).balance,0);assert.deepEqual(cloud.data.weeklyQuota,before.weeklyQuota);assert.deepEqual(cloud.data.usage,before.usage);assert.deepEqual(cloud.data.events,before.events);assert.deepEqual(cloud.data.freeDaily,before.freeDaily);assert.equal(cloud.data.membershipAudit.filter(e=>e.after.bulk).length,2);
});
test('批量发卡排除到期和停用会员，伪造普通或体验对象不能绕过筛选',async()=>{
 paid(alice,'pro');paid(bob,'max');const stale=await batchTargets('reset-cards');cloud.change(data=>{data.users.find(u=>u.id===alice.user.id).membership.expiresAt=Date.now()-1;data.users.find(u=>u.id===bob.user.id).disabled=true;});const before=structuredClone(cloud.data);assert.equal((await batch('reset-cards',stale)).status,409);assert.deepEqual(cloud.data,before);
 paid(alice,'pro');for(const user of [admin,trial])assert.equal((await batch('reset-cards',[{id:user.user.id,revision:0}])).status,409);assert.equal((await cards(admin)).balance,0);assert.equal((await cards(trial)).balance,0);assert.equal((await batchTargets('reset-cards')).length,1);
});
test('批量重置普通ProMax的已用额度，不扣卡，跳过未消耗、体验及在途用户',async()=>{
 paid(alice,'pro');charge(admin);charge(alice);const pending=charge(bob,{pending:true});await grant(alice,2);const targets=await batchTargets('weekly-reset');assert.equal(targets.length,2);const before=structuredClone(cloud.data),r=await batch('weekly-reset',targets);
 assert.equal(r.status,200);assert.equal(r.data.processed,2);assert.equal(r.data.restoredPoints,6);assert.equal(cloud.weeklySnapshot(admin.user.id).usedPoints,0);assert.equal(cloud.weeklySnapshot(alice.user.id).usedPoints,0);assert.equal((await cards(alice)).balance,2);assert.equal(cloud.weeklySnapshot(bob.user.id).reservedPoints,.5);assert.deepEqual(cloud.data.events,before.events);assert.deepEqual(cloud.data.weeklyQuota.calls,before.weeklyQuota.calls);assert.deepEqual(cloud.data.freeDaily,before.freeDaily);
 pending.options.afterCall(pending.id,{usage:{input_tokens:1000,output_tokens:1000}},null);assert.equal(cloud.weeklySnapshot(bob.user.id).usedPoints,3);
});
test('批量操作并发和旧请求重放只成功一次，单人操作改变版本后整批拒绝',async()=>{
 paid(alice,'pro');paid(bob,'max');let targets=await batchTargets('reset-cards');const results=await Promise.all([batch('reset-cards',targets,2),batch('reset-cards',targets,2)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);assert.equal((await cards(alice)).balance,2);assert.equal((await cards(bob)).balance,2);
 targets=await batchTargets('reset-cards');await grant(alice,1,1);const before=structuredClone(cloud.data);assert.equal((await batch('reset-cards',targets)).status,409);assert.deepEqual(cloud.data,before);
 charge(alice);charge(bob);const resets=await batchTargets('weekly-reset');assert.equal((await batch('weekly-reset',resets)).status,200);charge(alice);charge(bob);assert.equal((await batch('weekly-reset',resets)).status,409);assert.equal(cloud.weeklySnapshot(alice.user.id).usedPoints,3);
});
test('批量预览后增减会员或出现新在途请求时拒绝整批，不部分执行',async()=>{
 paid(alice,'pro');const targets=await batchTargets('reset-cards');paid(bob,'max');const before=structuredClone(cloud.data);assert.equal((await batch('reset-cards',targets)).status,409);assert.deepEqual(cloud.data,before);
 charge(alice);charge(bob);const resets=await batchTargets('weekly-reset'),pending=charge(bob,{pending:true}),pendingState=structuredClone(cloud.data);assert.equal((await batch('weekly-reset',resets)).status,409);assert.deepEqual(cloud.data,pendingState);pending.options.afterCall(pending.id,{usage:{input_tokens:1,output_tokens:1}},null);
});
test('批量权限、同源、CSRF、数量、空列表、重复用户和未知字段校验',async()=>{
 paid(alice,'pro');const targets=await batchTargets('reset-cards'),route='/api/users/bulk-reset-cards';for(const client of [null,alice,trial])assert.equal((await batch('reset-cards',targets,1,client)).status,client?403:401);
 for(const headers of [{Origin:'https://evil.example'},{'X-CSRF-Token':'bad'}])assert.equal((await api(admin,route,{targets,count:1},headers)).status,403);
 for(const body of [{targets:[],count:1},{targets:[...targets,...targets],count:1},{targets,count:0},{targets,count:1001},{targets,count:'1'},{targets,count:1,plan:'free'},{targets:[{id:alice.user.id,revision:-1}],count:1},{targets:[{...targets[0],role:'admin'}],count:1}])assert.equal((await api(admin,route,body)).status,400);
 assert.equal((await cards(alice)).balance,0);assert.equal(cloud.data.membershipAudit.filter(e=>e.after?.bulk).length,0);
});
test('批量卡上限或落盘失败时全体卡、版本、账本和审计保持原样',async()=>{
 paid(alice,'pro');paid(bob,'max');cloud.change(data=>data.users.find(u=>u.id===bob.user.id).resetCards=10000);let before=structuredClone(cloud.data);assert.equal((await batch('reset-cards',await batchTargets('reset-cards'))).status,400);assert.deepEqual(cloud.data,before);
 cloud.change(data=>data.users.find(u=>u.id===bob.user.id).resetCards=0);charge(alice);charge(bob);const targets=await batchTargets('weekly-reset'),file=cloud.file;before=structuredClone(cloud.data);cloud.file=path.join(directory,'bulk-not-directory','state.enc');fs.writeFileSync(path.dirname(cloud.file),'block');try{assert.throws(()=>cloud.batchQuota(request(admin),'weekly-reset',{targets}));assert.deepEqual(cloud.data,before);}finally{cloud.file=file;}
});
