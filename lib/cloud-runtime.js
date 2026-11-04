'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{promisify}=require('node:util');
const {ProviderStore}=require('./provider-store');
const UsageReport=require('./usage-report');
const WeeklyQuota=require('./weekly-quota');
const Membership=require('./membership');
const derive=promisify(crypto.scrypt);
const KDF={N:32768,r:8,p:3,maxmem:64*1024*1024};
class CloudError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const fail=(status,code,message)=>{throw new CloudError(status,code,message);};
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const publicUser=u=>({id:u.id,username:u.username,role:u.role,disabled:Boolean(u.disabled)});
const day=()=>new Date().toISOString().slice(0,10);
function atomic(file,data){
 fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const tmp=file+'.tmp-'+crypto.randomUUID();
 try{fs.writeFileSync(tmp,data,{mode:0o600});const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
}
function codec(key){
 return {encode(data){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);c.setAAD(Buffer.from('diagram-cloud-v1'));const ciphertext=Buffer.concat([c.update(JSON.stringify(data)),c.final()]);return JSON.stringify({version:1,iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:ciphertext.toString('base64')});},
 decode(raw){try{const p=JSON.parse(raw);if(p.version!==1)throw Error();const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(p.iv,'base64'));d.setAAD(Buffer.from('diagram-cloud-v1'));d.setAuthTag(Buffer.from(p.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(p.data,'base64')),d.final()]).toString());}catch{throw new Error('云端数据无法解密；请检查主密钥或恢复备份，原文件保持不变');}}};
}
function credentials(username,password){
 if(typeof username!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(username))fail(400,'invalid-user','账号须为 3–40 位字母、数字、点、横线或下划线');
 if(typeof password!=='string'||password.length<8||password.length>128)fail(400,'invalid-password','密码至少 8 位，最多 128 位，无需字母或符号组合');
 return username.toLowerCase();
}
class CloudRuntime {
 constructor(env,root){
  if(env.APP_MODE&&!['local','cloud'].includes(env.APP_MODE))throw Error('APP_MODE 只能为 local 或 cloud');
  this.enabled=env.APP_MODE==='cloud';if(!this.enabled)return;
  let origin;try{origin=new URL(env.PUBLIC_ORIGIN);}catch{throw Error('云端模式必须设置 PUBLIC_ORIGIN');}
  this.development=env.CLOUD_ALLOW_HTTP_LOOPBACK==='true'&&origin.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(origin.hostname);
  if(origin.origin!==env.PUBLIC_ORIGIN||origin.username||origin.password||(!this.development&&origin.protocol!=='https:'))throw Error('PUBLIC_ORIGIN 必须是 HTTPS origin；本机 HTTP 测试需显式开启 CLOUD_ALLOW_HTTP_LOOPBACK');
  this.origin=origin.origin;this.host=origin.host;this.cookie=this.development?'diagram_session':'__Host-diagram_session';
  const key=Buffer.from(env.CLOUD_MASTER_KEY||'','base64');if(key.length!==32||key.toString('base64')!==env.CLOUD_MASTER_KEY)throw Error('CLOUD_MASTER_KEY 必须是 32 字节随机密钥的标准 base64');
  this.codec=codec(key);this.directory=path.resolve(env.CLOUD_DATA_DIR||path.join(root,'data','cloud'));
  this.file=path.join(this.directory,'state.enc');this.stores=new Map();this.active=new Map();this.globalActive=0;
  // Daily user/whole-site caps are retired. Only the explicit free pool has a daily call cap.
  this.limits={platform:200,weeklyPoints:1000,concurrentUser:1,concurrentTotal:4};
  for(const [k,name] of Object.entries({platform:'CLOUD_PLATFORM_DAILY_LIMIT',weeklyPoints:'CLOUD_WEEKLY_POINTS',concurrentUser:'CLOUD_USER_CONCURRENCY',concurrentTotal:'CLOUD_TOTAL_CONCURRENCY'})){if(env[name]!==undefined){const n=Number(env[name]);if(!Number.isSafeInteger(n)||n<1||(k==='weeklyPoints'&&n>1000000))throw Error(name+' 必须是有效正整数');this.limits[k]=n;}}
  try {
   this.freeModels=JSON.parse(env.CLOUD_FREE_MODELS||'[]');
   if(!Array.isArray(this.freeModels)||this.freeModels.length>3||this.freeModels.some(model=>!model||typeof model.providerId!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(model.providerId)||typeof model.modelId!=='string'||!model.modelId||model.modelId.length>200||/[\r\n]/.test(model.modelId)))throw Error();
   if(new Set(this.freeModels.map(model=>model.providerId+'/'+model.modelId)).size!==this.freeModels.length)throw Error();
   this.freeModels=this.freeModels.map(({providerId,modelId})=>({providerId,modelId}));
  } catch { throw Error('CLOUD_FREE_MODELS 必须是最多三个明确的 providerId/modelId 对象组成的 JSON 数组'); }
  this.sessionHours=12;this.registrations=0;
  this.data=fs.existsSync(this.file)?this.codec.decode(fs.readFileSync(this.file,'utf8')):{version:1,users:[],sessions:[],loginAttempts:{},usage:{date:day(),total:0,platform:0,users:{}},events:[],preferences:{}};
  if(this.data.version!==1||!Array.isArray(this.data.users)||!Array.isArray(this.data.sessions))throw Error('云端数据版本或结构不合法');
  if(!this.data.users.some(u=>u.role==='admin'&&!u.disabled)){
   const username=credentials(env.CLOUD_ADMIN_USERNAME,env.CLOUD_ADMIN_PASSWORD),salt=crypto.randomBytes(16).toString('hex');
   const hash=crypto.scryptSync(env.CLOUD_ADMIN_PASSWORD,salt,64,KDF).toString('hex');
   this.change(d=>d.users.push({id:crypto.randomUUID(),username,salt,hash,kdf:KDF,role:'admin',disabled:false}));
  }
  this.platform=this.providerStore('platform');
  this.restrictedRelayIds=new Set((env.CLOUD_RESTRICTED_RELAY_PROVIDER_IDS||'').split(',').map(id=>id.trim()).filter(Boolean));
  if([...this.restrictedRelayIds].some(id=>!/^[a-z][a-z0-9-]{0,63}$/.test(id)))throw Error('CLOUD_RESTRICTED_RELAY_PROVIDER_IDS 含无效的提供商标识');
  this.subscriptionOwnerId=this.data.users.find(user=>user.username===env.CLOUD_CHATGPT_OWNER)?.id||null;
  this.change(data=>{
   UsageReport.initialize(data,this.subscriptionOwnerId);
   WeeklyQuota.initialize(data);WeeklyQuota.recover(data);
   if(!data.freeDaily)data.freeDaily={date:data.usage.date,calls:data.usage.platform||0};
   const recovered=new Map(data.weeklyQuota.calls.filter(call=>call.status==='interrupted').map(call=>[call.id,call]));
   for(const event of data.events){const call=recovered.get(event.id);if(call)event.quota={pool:'weekly',points:call.chargedCredits/1000,estimated:true,reservedPoints:0,policyVersion:call.policyVersion,modelMultiplier:call.modelMultiplier??1};}
  });
 }
 change(mutator){const next=structuredClone(this.data);const result=mutator(next);atomic(this.file,this.codec.encode(next));this.data=next;return result;}
 providerStore(owner){
  if(!this.stores.has(owner))this.stores.set(owner,new ProviderStore({filePath:path.join(this.directory,'providers-'+owner+'.enc'),env:{},codec:this.codec,strict:true}).load());
  return this.stores.get(owner);
 }
 assertOrigin(req,mutation=false){
  if(String(req.headers.host)!==this.host)fail(403,'forbidden-host','请求域名与网站公开地址不匹配');
  const origin=req.headers.origin;
  if((origin!==undefined&&origin!==this.origin)||(mutation&&origin!==this.origin))fail(403,'forbidden-origin','请通过网站同源页面进行操作');
  if(this.development&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))fail(403,'forbidden-origin','HTTP 开发模式仅允许本机访问');
 }
 session(req){
  const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(this.cookie+'='));
  if(!raw)return null;const token=raw.slice(this.cookie.length+1);if(!/^[a-f0-9]{64}$/.test(token))return null;
  const s=this.data.sessions.find(s=>s.hash===digest(token)&&s.expires>Date.now());const user=s&&this.data.users.find(u=>u.id===s.userId&&!u.disabled);
  return user?{session:s,user}:null;
 }
 authorize(req){this.assertOrigin(req,!['GET','HEAD'].includes(req.method));const identity=this.session(req);if(!identity)fail(401,'login-required','请先登录');req.identity=identity;if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==identity.session.csrf)fail(403,'csrf-required','会话校验失败，请刷新页面');return identity;}
 admin(req){if(!this.data.users.some(user=>user.id===req.identity?.user.id&&user.role==='admin'&&!user.disabled))fail(403,'admin-required','只有管理员可以管理平台 API 和用户');}
 async login(req,body,res){
  this.assertOrigin(req,true);
  const username=typeof body.username==='string'?body.username.toLowerCase():'';
  if(typeof body.password!=='string'||body.password.length>128||username.length>40)fail(401,'invalid-login','账号或密码不正确');
  const bucket=digest(req.socket.remoteAddress+'|'+username),globalBucket=digest(req.socket.remoteAddress+'|all');
  const now=Date.now();for(const k of [bucket,globalBucket]){const b=this.data.loginAttempts[k];if(b&&b.until>now&&b.count>=(k===bucket?8:40))fail(429,'login-limited','登录尝试过多，请稍后再试');}
  this.change(d=>{for(const k of [bucket,globalBucket]){const b=d.loginAttempts[k];d.loginAttempts[k]=b&&b.until>now?{...b,count:b.count+1}:{count:1,until:now+600000};}for(const k of Object.keys(d.loginAttempts))if(d.loginAttempts[k].until<now)delete d.loginAttempts[k];});
  const user=this.data.users.find(u=>u.username===username&&!u.disabled);
  const expected=user?Buffer.from(user.hash,'hex'):Buffer.alloc(64),actual=await derive(body.password,user?.salt||'unknown-account',64,user?.kdf||(user?{N:16384,r:8,p:1,maxmem:64*1024*1024}:KDF));
  if(!user||!crypto.timingSafeEqual(expected,actual))fail(401,'invalid-login','账号或密码不正确');
  return this.issueSession(user,res,bucket);
 }
 issueSession(user,res,bucket){
  const current=this.data.users.find(row=>row.id===user.id&&!row.disabled);if(!current)fail(401,'login-required','账号不可用');user=current;const now=Date.now();
  const token=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
  this.change(d=>{if(bucket)delete d.loginAttempts[bucket];d.sessions=d.sessions.filter(s=>s.expires>now);const mine=d.sessions.filter(s=>s.userId===user.id);if(mine.length>=10)d.sessions=d.sessions.filter(s=>s!==mine[0]);d.sessions.push({hash:digest(token),userId:user.id,csrf,expires:now+this.sessionHours*3600000});});
  res.setHeader('Set-Cookie',`${this.cookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${this.sessionHours*3600}${this.development?'':'; Secure'}`);
  return this.profile({user,session:{csrf}});
 }
 async register(req,body,res){
  this.assertOrigin(req,true);
  if(this.session(req))fail(409,'already-logged-in','请先退出当前账号再注册');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['username','password'].includes(key)))fail(400,'invalid-registration','仅支持账号和密码');
  const bucket=digest('register|'+req.socket.remoteAddress),now=Date.now(),attempt=this.data.loginAttempts[bucket];
  if(attempt?.until>now&&attempt.count>=10)fail(429,'register-limited','注册尝试过于频繁，请十分钟后再试');
  if(this.registrations>=2)fail(429,'register-busy','正在处理注册，请稍后重试');
  this.change(data=>{const old=data.loginAttempts[bucket];data.loginAttempts[bucket]=old&&old.until>now?{count:old.count+1,until:old.until}:{count:1,until:now+600000};for(const key of Object.keys(data.loginAttempts))if(data.loginAttempts[key].until<now)delete data.loginAttempts[key];});
  this.registrations++;
  try{const user=await this.createAccount(body.username,body.password,true);return this.issueSession(user,res);}
  finally{this.registrations--;}
 }
 logout(req,res){const hash=req.identity.session.hash;this.change(d=>{d.sessions=d.sessions.filter(s=>s.hash!==hash);});res.setHeader('Set-Cookie',`${this.cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${this.development?'':'; Secure'}`);}
 profile(identity){return {mode:'cloud',user:identity?this.userView(identity.user):null,csrf:identity?.session.csrf||null,usage:identity?this.usage(identity.user.id):null};}
 planLimits(){return {free:this.limits.weeklyPoints,pro:5000,max:20000,...this.data.membershipPlans};}
 membershipFor(userId){return Membership.snapshot(this.data.users.find(user=>user.id===userId));}
 isRestrictedRelay(source,providerId){
  if(source!=='platform'||typeof providerId!=='string'||!this.restrictedRelayIds.size)return false;
  const id=providerId.replace(/^platform:/,''),provider=this.platform.getRaw(id);if(!provider)return false;
  if(this.restrictedRelayIds.has(id))return true;
  try{const origin=new URL(provider.baseUrl).origin;return [...this.restrictedRelayIds].some(anchor=>{const candidate=this.platform.getRaw(anchor);try{return candidate&&new URL(candidate.baseUrl).origin===origin;}catch{return false;}});}catch{return false;}
 }
 memberModelAllowed(userId,modelId,source,providerId){return Membership.allows(this.data.users.find(user=>user.id===userId),modelId,Date.now(),{restrictedRelay:this.isRestrictedRelay(source,providerId)});}
 assertMemberModel(req,modelId,source,providerId){if(!this.memberModelAllowed(req.identity?.user.id,modelId,source,providerId)){const plan=Membership.requiredPlan(modelId,{restrictedRelay:this.isRestrictedRelay(source,providerId)});fail(403,'membership-required',plan!=='free'?`此模型需要 ${Membership.NAMES[plan]} 会员，请升级会员或选择其他模型`:'当前账号不能使用此模型');}}
 isTrial(userId){return this.data.users.find(user=>user.id===userId)?.role!=='admin'&&this.membershipFor(userId).plan==='trial';}
 assertModelUse(req,source,providerId,modelId){if(this.isTrial(req.identity.user.id)){if(modelId&&this.trialModelAllowed(source,providerId,modelId))return;fail(403,'trial-model-required','体验用户仅可使用三个全站免费模型，请联系管理员升级');}if(source!=='personal'&&modelId)this.assertMemberModel(req,modelId,source,providerId);}
 weeklyLimit(userId){if(this.isTrial(userId))return 0;const value=this.data.users.find(user=>user.id===userId)?.weeklyLimitPoints;return Number.isSafeInteger(value)&&value>=1&&value<=1000000?value:this.planLimits()[this.membershipFor(userId).plan];}
 userView(user){const current=this.data.users.find(row=>row.id===user.id)||user,weekly=this.weeklySnapshot(current.id);return {...publicUser(current),membership:this.membershipFor(current.id),weeklyLimitPoints:this.weeklyLimit(current.id),customWeeklyLimitPoints:current.weeklyLimitPoints??null,weeklyUsedPoints:weekly.usedPoints,resetCards:this.resetCardState(current.id)};}
 weeklySnapshot(userId){return WeeklyQuota.snapshot({weeklyQuota:this.data.weeklyQuota&&{...this.data.weeklyQuota}},{ownerKey:userId,limitPoints:this.weeklyLimit(userId)});}
 listUsers(){return this.data.users.map(user=>this.userView(user));}
 auditMembership(data,req,action,targetId,before,after){
  const entries=data.membershipAudit||(data.membershipAudit=[]);
  entries.push({id:crypto.randomUUID(),time:Date.now(),actorId:req.identity.user.id,action,targetId,before,after});
  if(entries.length>1000)entries.splice(0,entries.length-1000);
 }
 usernameFor(userId){const current=this.data.users.find(user=>user.id===userId);if(current)return current.username;const deleted=this.data.deletedUsers?.find(user=>user.id===userId);return deleted?deleted.username+'（已删除）':undefined;}
 membershipSettings(req){this.admin(req);return {plans:this.planLimits(),audit:(this.data.membershipAudit||[]).slice(-50).reverse().map(entry=>({...entry,actorUsername:this.usernameFor(entry.actorId),targetUsername:this.usernameFor(entry.targetId)}))};}
 setMembershipPlans(req,plans){
  this.admin(req);if(!plans||typeof plans!=='object'||Array.isArray(plans)||Object.keys(plans).length!==3||['free','pro','max'].some(key=>!Number.isSafeInteger(plans[key])||plans[key]<1||plans[key]>1000000))fail(400,'invalid-membership-plans','三个等级的周额度须为 1–1000000 的整数点数');
  if(plans.free>plans.pro||plans.pro>plans.max)fail(400,'invalid-membership-plans','Pro 额度不能低于普通用户，Max 不能低于 Pro');
  const before=this.planLimits();this.change(data=>{this.auditMembership(data,req,'plans',null,before,plans);data.membershipPlans={...plans};});
  return {plans:this.planLimits()};
 }
 setMembership(req,id,body){
  this.admin(req);if(!body||Object.keys(body).some(key=>!['plan','expiresAt'].includes(key))||!Membership.validPlan(body.plan)|| (['trial','free'].includes(body.plan)?body.expiresAt!==null:!Number.isSafeInteger(body.expiresAt)||body.expiresAt<=Date.now()||body.expiresAt>Date.now()+3650*Membership.DAY))fail(400,'invalid-membership','请选择有效等级和未来的到期时间（最长十年）');
  this.change(data=>{const target=data.users.find(user=>user.id===id);if(!target)fail(404,'user-not-found','账号不存在');if(target.role==='admin'&&body.plan==='trial')fail(400,'invalid-membership','管理员不能设为体验用户');const next={plan:body.plan,expiresAt:['trial','free'].includes(body.plan)?null:body.expiresAt};this.auditMembership(data,req,'membership',id,target.membership||{plan:'free',expiresAt:null},next);target.membership=next;});
  return {user:this.userView(this.data.users.find(user=>user.id===id)),weekly:this.weeklySnapshot(id)};
 }
 setWeeklyLimit(req,id,limitPoints,{inherit=false}={}){
  this.admin(req);if(!inherit&&(!Number.isSafeInteger(limitPoints)||limitPoints<1||limitPoints>1000000))fail(400,'invalid-weekly-limit','周额度须为 1–1000000 的整数点数');
  this.change(data=>{const actor=data.users.find(row=>row.id===req.identity.user.id&&!row.disabled&&row.role==='admin');if(!actor)fail(403,'admin-required','只有管理员可以调整周额度');const target=data.users.find(row=>row.id===id);if(!target)fail(404,'user-not-found','账号不存在');if(!inherit&&this.isTrial(id))fail(400,'trial-quota','体验用户没有周额度，请先调整会员等级');this.auditMembership(data,req,'weekly-limit',id,target.weeklyLimitPoints??null,inherit?null:limitPoints);if(inherit)delete target.weeklyLimitPoints;else target.weeklyLimitPoints=limitPoints;});
  return {user:this.userView(this.data.users.find(user=>user.id===id)),weekly:this.weeklySnapshot(id)};
 }
 resetCardState(userId){
  const user=this.data.users.find(row=>row.id===userId);if(!user)fail(404,'user-not-found','账号不存在');
  const balance=user.resetCards??0,revision=user.quotaResetRevision??0;
  if(!Number.isSafeInteger(balance)||balance<0||balance>10000||!Number.isSafeInteger(revision)||revision<0)fail(500,'invalid-reset-cards','重置卡数据异常，请联系管理员');
  const weekly=this.weeklySnapshot(userId),pending=this.data.weeklyQuota?.calls.some(call=>call.ownerKey===userId&&call.status==='pending');
  const reason=this.isTrial(userId)?'体验用户没有周额度，升级后可使用':user.disabled?'账号已停用':pending?'请等待周额度请求完成':!balance?'暂无重置卡':!weekly.usedPoints?'本周尚未消耗额度':'';
  return {balance,revision,canUse:!reason,canReset:!this.isTrial(userId)&&!user.disabled&&!pending&&weekly.usedPoints>0,reason};
 }
 checkResetRevision(user,revision){
  if(!Number.isSafeInteger(revision)||revision<0)fail(400,'invalid-reset-revision','请刷新后再操作');
  if((user.quotaResetRevision??0)!==revision)fail(409,'reset-conflict','重置卡状态已变化，请刷新后重试');
  if(revision===Number.MAX_SAFE_INTEGER)fail(409,'reset-conflict','重置操作已达上限，请联系管理员');
 }
 grantResetCards(req,id,body){
  this.admin(req);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['count','revision'].includes(key))||!Number.isSafeInteger(body.count)||body.count<1||body.count>1000)fail(400,'invalid-reset-cards','每次发放须为 1–1000 张整数');
  this.change(data=>{
   const user=data.users.find(row=>row.id===id);if(!user)fail(404,'user-not-found','账号不存在');this.checkResetRevision(user,body.revision);
   const before=this.resetCardState(id);if(before.balance+body.count>10000)fail(400,'reset-card-limit','每人最多持有 10000 张重置卡');
   user.resetCards=before.balance+body.count;user.quotaResetRevision=body.revision+1;
   this.auditMembership(data,req,'reset-cards',id,{balance:before.balance},{balance:user.resetCards,granted:body.count});
  });
  return {user:this.userView(this.data.users.find(user=>user.id===id))};
 }
 resetWeekly(req,id,body,{useCard=false}={}){
  if(useCard){if(req.identity.user.id!==id)fail(403,'reset-owner-required','只能使用自己的重置卡');}else this.admin(req);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='revision'))fail(400,'invalid-weekly-reset','仅支持重置当前用户的本周额度');
  let restored;
  this.change(data=>{
   const user=data.users.find(row=>row.id===id&&!row.disabled);if(!user)fail(404,'user-not-found','账号不存在或已停用');this.checkResetRevision(user,body.revision);
   if(this.isTrial(id))fail(403,'trial-quota','体验用户没有周额度，请先调整会员等级');
   const cards=this.resetCardState(id);if(useCard&&!cards.balance)fail(409,'reset-card-empty','没有可用重置卡，请联系管理员领取');
   try{restored=WeeklyQuota.reset(data,{ownerKey:id});}catch(error){if(['weekly-reset-pending','weekly-reset-empty'].includes(error.code))fail(409,error.code,error.message);throw error;}
   if(useCard)user.resetCards=cards.balance-1;user.quotaResetRevision=body.revision+1;
   this.auditMembership(data,req,'weekly-reset',id,{balance:cards.balance,usedPoints:restored.restoredPoints},{balance:user.resetCards??0,usedPoints:0,restoredPoints:restored.restoredPoints,useCard,weekStart:restored.weekStart});
  });
  return {restoredPoints:restored.restoredPoints,user:this.userView(this.data.users.find(user=>user.id===id)),usage:this.usage(id)};
 }
 batchQuota(req,action,body){
  this.admin(req);const granting=action==='reset-cards';
  if(!['reset-cards','weekly-reset'].includes(action)||!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['targets',...(granting?['count']:[])].includes(key))||!Array.isArray(body.targets)||!body.targets.length||body.targets.length>50||body.targets.some(target=>!target||typeof target!=='object'||Array.isArray(target)||Object.keys(target).some(key=>!['id','revision'].includes(key))||typeof target.id!=='string'||!/^[a-f0-9-]{36}$/.test(target.id)||!Number.isSafeInteger(target.revision)||target.revision<0)||new Set(body.targets.map(target=>target.id)).size!==body.targets.length)fail(400,'invalid-quota-batch','请先刷新并确认本次操作的用户范围');
  if(granting&&(!Number.isSafeInteger(body.count)||body.count<1||body.count>1000))fail(400,'invalid-reset-cards','每人发放须为 1–1000 张整数');
  let processed=0,restoredPoints=0;
  this.change(data=>{
   const eligible=this.listUsers().filter(user=>granting?!user.disabled&&['pro','max'].includes(user.membership.plan):user.resetCards.canReset),targets=new Map(body.targets.map(target=>[target.id,target.revision]));
   if(eligible.length!==targets.size||eligible.some(user=>!targets.has(user.id)))fail(409,'batch-changed','用户范围或会员状态已变化，请重新确认');
   for(const item of eligible){const user=data.users.find(user=>user.id===item.id);this.checkResetRevision(user,targets.get(item.id));if(granting&&item.resetCards.balance+body.count>10000)fail(400,'reset-card-limit','有用户的重置卡会超过 10000 张，本次未发放');}
   let restoredCredits=0;
   for(const item of eligible){
    const user=data.users.find(user=>user.id===item.id),balance=item.resetCards.balance;user.quotaResetRevision=(user.quotaResetRevision??0)+1;
    if(granting){user.resetCards=balance+body.count;this.auditMembership(data,req,'reset-cards',user.id,{balance},{balance:user.resetCards,granted:body.count,bulk:true});}
    else{let restored;try{restored=WeeklyQuota.reset(data,{ownerKey:user.id});}catch(error){if(['weekly-reset-pending','weekly-reset-empty'].includes(error.code))fail(409,'batch-changed','额度状态已变化，请重新确认');throw error;}
     restoredCredits+=Math.round(restored.restoredPoints*1000);this.auditMembership(data,req,'weekly-reset',user.id,{balance,usedPoints:restored.restoredPoints},{balance,usedPoints:0,restoredPoints:restored.restoredPoints,useCard:false,weekStart:restored.weekStart,bulk:true});}
   }
   processed=eligible.length;restoredPoints=restoredCredits/1000;
  });
  return {processed,restoredPoints,totalCards:granting?processed*body.count:0};
 }
 isFreeModel(source,providerId,modelId){return source==='platform'&&this.freeModels.some(model=>model.providerId===String(providerId).replace(/^platform:/,'')&&model.modelId===modelId);}
 trialModelAllowed(source,providerId,modelId){return this.isFreeModel(source,providerId,modelId)&&!(this.isRestrictedRelay(source,providerId)&&!Membership.relayExempt(modelId));}
 usage(userId){
  const usage=this.data.usage.date===day()?this.data.usage:{date:day(),total:0,platform:0,users:{}},free=this.data.freeDaily?.date===day()?this.data.freeDaily.calls:0;
  return {date:usage.date,timezone:'UTC',userCalls:usage.users[userId]||0,platformCalls:usage.platform,totalCalls:usage.total,limits:{...this.limits,weeklyPoints:this.planLimits().free},membership:this.membershipFor(userId),
   resetCards:this.resetCardState(userId),free:{calls:free,limit:this.limits.platform,remaining:Math.max(0,this.limits.platform-free),resetAt:Date.parse(day()+'T00:00:00Z')+86400000,models:this.freeModels.map(model=>({...model,providerId:'platform:'+model.providerId}))},weekly:this.weeklySnapshot(userId)};
 }
 usageReport(req,params){try{return UsageReport.report(this.data,req.identity,params);}catch(error){if(error instanceof UsageReport.QueryError)throw new CloudError(error.status,'invalid-usage-query',error.message);throw error;}}
 async createUser(req,body){this.admin(req);return this.createAccount(body.username,body.password);}
 async createAccount(username,password,trial=false){
  username=credentials(username,password);if(this.data.users.length>=50)fail(409,'user-limit','账号数量已达上限，请联系管理员');if(this.data.users.some(user=>user.username===username))fail(409,'user-exists','账号已存在');
  const salt=crypto.randomBytes(16).toString('hex'),hash=(await derive(password,salt,64,KDF)).toString('hex');
  const user={id:crypto.randomUUID(),username,salt,hash,kdf:KDF,role:'user',disabled:false,...(trial?{membership:{plan:'trial',expiresAt:null}}:{})};
  this.change(data=>{if(data.users.length>=50)fail(409,'user-limit','账号数量已达上限，请联系管理员');if(data.users.some(row=>row.username===username))fail(409,'user-exists','账号已存在');data.users.push(user);});return publicUser(user);
 }

 disableUser(req,id,disabled){this.admin(req);if(id===req.identity.user.id||typeof disabled!=='boolean')fail(400,'invalid-user','不能禁用自己，disabled 必须是布尔值');return this.change(d=>{const u=d.users.find(u=>u.id===id);if(!u)fail(404,'user-not-found','账号不存在');u.disabled=disabled;d.sessions=d.sessions.filter(s=>s.userId!==id);return publicUser(u);});}
 deleteUser(req,id,body){
  this.admin(req);const user=this.data.users.find(row=>row.id===id);if(!user)fail(404,'user-not-found','账号不存在');
  if(user.role==='admin'||id===req.identity.user.id||id===this.subscriptionOwnerId)fail(403,'protected-user','管理员或订阅所有者账号不能删除');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>key!=='username')||typeof body.username!=='string'||body.username.trim()!==user.username)fail(400,'delete-confirmation','请输入该账号名称确认删除');
  if(this.active.get(id)||this.data.events.some(event=>event.userId===id&&event.status==='started')||this.data.weeklyQuota?.calls.some(call=>call.ownerKey===id&&call.status==='pending'))fail(409,'user-busy','该用户还有进行中的请求，请完成或取消后再删除');
  const file=path.join(this.directory,'providers-'+id+'.enc'),staged=file+'.deleting-'+crypto.randomUUID();let moved=false;
  if(fs.existsSync(file)){fs.renameSync(file,staged);moved=true;}
  try{this.change(data=>{
   this.auditMembership(data,req,'delete-user',id,{username:user.username},{deleted:true,username:user.username});
   (data.deletedUsers||(data.deletedUsers=[])).push({id,username:user.username,deletedAt:Date.now()});
   data.users=data.users.filter(row=>row.id!==id);data.sessions=data.sessions.filter(row=>row.userId!==id);delete data.preferences[id];
  });}catch(error){if(moved)fs.renameSync(staged,file);throw error;}
  this.stores.delete(id);let configurationRemoved=true;if(moved)try{fs.unlinkSync(staged);}catch{configurationRemoved=false;console.error('[ai-diagram-studio] 已删除账号的加密配置清理失败');}
  return {deleted:true,userId:id,username:user.username,configurationRemoved};
 }
 async replacePassword(req,user,password,{admin=false,attemptBucket}={}){
  credentials(user.username,password);
  const salt=crypto.randomBytes(16).toString('hex'),hash=(await derive(password,salt,64,KDF)).toString('hex');
  return this.change(d=>{
   const actor=d.users.find(u=>u.id===req.identity.user.id&&!u.disabled);
   if(!actor||!d.sessions.some(s=>s.hash===req.identity.session.hash&&s.expires>Date.now()))fail(401,'login-required','登录会话已失效');
   if(admin&&actor.role!=='admin')fail(403,'admin-required','只有管理员可以重置用户密码');
   const target=d.users.find(u=>u.id===user.id);
   if(!target||target.hash!==user.hash)fail(409,'password-changed','密码已被修改，请重新登录后操作');
   target.salt=salt;target.hash=hash;target.kdf=KDF;
   d.sessions=d.sessions.filter(s=>s.userId!==user.id);
   if(attemptBucket)delete d.loginAttempts[attemptBucket];
   return publicUser(target);
  });
 }
 async changePassword(req,body){
  const user=req.identity.user;
  credentials(user.username,body.newPassword);
  if(typeof body.currentPassword!=='string'||body.currentPassword.length>128)fail(400,'wrong-password','当前密码不正确');
  const bucket=digest('password-change|'+user.id),now=Date.now(),attempt=this.data.loginAttempts[bucket];
  if(attempt&&attempt.until>now&&attempt.count>=8)fail(429,'password-limited','尝试过多，请稍后再试');
  this.change(d=>{const old=d.loginAttempts[bucket];d.loginAttempts[bucket]=old&&old.until>now?{...old,count:old.count+1}:{count:1,until:now+600000};});
  const actual=await derive(body.currentPassword,user.salt,64,user.kdf||{N:16384,r:8,p:1,maxmem:64*1024*1024});
  if(!crypto.timingSafeEqual(Buffer.from(user.hash,'hex'),actual))fail(400,'wrong-password','当前密码不正确');
  await this.replacePassword(req,user,body.newPassword,{attemptBucket:bucket});
  return {ok:true};
 }
 async resetUserPassword(req,id,body){
  this.admin(req);
  const user=this.data.users.find(u=>u.id===id);
  if(!user)fail(404,'user-not-found','账号不存在');
  if(user.role!=='user')fail(400,'invalid-user','管理员请使用“修改密码”修改自己的密码');
  await this.replacePassword(req,user,body.newPassword,{admin:true});
  return {ok:true};
 }
 select(req,encoded){
  if(typeof encoded!=='string')fail(400,'api-source-required','请选择平台模型或我的模型');
  const m=/^(platform|personal):([a-z][a-z0-9-]{0,63})$/.exec(encoded);if(!m)fail(400,'api-source-required','模型来源不合法，请重新选择');
  if(m[1]==='personal'&&this.isTrial(req.identity.user.id))fail(403,'trial-api-forbidden','体验用户暂不能使用个人 API');
  return {source:m[1],id:m[2],store:this.providerStore(m[1]==='platform'?'platform':req.identity.user.id)};
 }
 management(req,encoded){
  if(this.isTrial(req.identity.user.id))fail(403,'trial-api-forbidden','体验用户暂不能管理 API');
  if(encoded?.includes(':')){const selected=this.select(req,encoded);if(selected.source==='platform')this.admin(req);return selected;}
  const source=req.headers['x-provider-scope']||'personal';if(!['personal','platform'].includes(source))fail(400,'invalid-source','API 配置来源不合法');if(source==='platform')this.admin(req);
  return {source,id:encoded,store:this.providerStore(source==='platform'?'platform':req.identity.user.id)};
 }
 catalog(req){
  const all=[];let defaultSelection=null;
  for(const source of ['platform','personal']){if(source==='personal'&&this.isTrial(req.identity.user.id))continue;const store=this.providerStore(source==='platform'?'platform':req.identity.user.id);for(const p of store.list()){
   const tagged=source+':'+p.providerId;
   const models=p.models.filter(m=>source==='personal'||(this.isTrial(req.identity.user.id)?this.trialModelAllowed(source,p.providerId,m.modelId):this.memberModelAllowed(req.identity.user.id,m.modelId,source,p.providerId))).map(m=>({...m,...this.preferenceFor(req.identity.user.id,tagged,m),quotaPool:source==='personal'?'personal':this.isFreeModel(source,p.providerId,m.modelId)?'free':'weekly',quotaMultiplier:source==='personal'||this.isFreeModel(source,p.providerId,m.modelId)?null:WeeklyQuota.multiplierFor(m.modelId,source)}));
   if(models.length)all.push({...p,providerId:tagged,name:(source==='platform'?'平台模型 · ':'我的模型 · ')+p.name,apiSource:source,models});
  }const def=store.defaultSelection();if(def&&!defaultSelection)defaultSelection={...def,providerId:source+':'+def.providerId};}
  if(defaultSelection&&!all.some(p=>p.providerId===defaultSelection.providerId&&p.models.some(m=>m.modelId===defaultSelection.modelId)))defaultSelection=null;
  return {providers:all,defaultSelection};
 }
 preferenceFor(userId,providerId,model){
  const saved=this.data.preferences[userId]?.[providerId+'/'+model.modelId]||{},result={};
  if(saved.thinkingMode!==undefined)result.thinkingMode=saved.thinkingMode;
  if(saved.reasoningEffort!==undefined)result.reasoningEffort=model.capabilities?.reasoningLevels.includes(saved.reasoningEffort)?saved.reasoningEffort:null;
  return result;
 }
 preference(req,body){
  const selected=this.select(req,body.providerId),provider=selected.store.getRaw(selected.id),model=provider?.models.find(m=>m.modelId===body.modelId);if(!model)fail(404,'model-not-found','模型不存在');
  this.assertModelUse(req,selected.source,selected.id,body.modelId);
  const patch={};const Cap=require('./model-capabilities');
  if(body.thinkingMode!==undefined){if(!['default','deepseek-on','deepseek-off','enable-thinking-on','enable-thinking-off'].includes(body.thinkingMode))fail(400,'invalid-preference','思考模式不合法');patch.thinkingMode=body.thinkingMode;}
  if(body.reasoningEffort!==undefined){if(body.reasoningEffort!==null&&!Cap.resolve(provider,model).reasoningLevels.includes(body.reasoningEffort))fail(400,'invalid-preference','该模型不支持此思考强度');patch.reasoningEffort=body.reasoningEffort;}
  this.change(d=>{const mine=d.preferences[req.identity.user.id]||(d.preferences[req.identity.user.id]={});const k=body.providerId+'/'+body.modelId;mine[k]={...mine[k],...patch};});return patch;
 }
 acquireTask(req){
  const userId=req.identity.user.id;if((this.active.get(userId)||0)>=this.limits.concurrentUser||this.globalActive>=this.limits.concurrentTotal)fail(429,'concurrency-limit','正在处理的请求过多，请等待当前请求完成');
  this.active.set(userId,(this.active.get(userId)||0)+1);this.globalActive++;
  const controller=new AbortController();req.modelSignal=controller.signal;
  let released=false;const release=()=>{if(released)return;released=true;this.active.set(userId,Math.max(0,(this.active.get(userId)||1)-1));this.globalActive--;};
  return {controller,release};
 }
 acquire(req,res){
  const {controller,release}=this.acquireTask(req);res.once('finish',release);res.once('close',release);
  res.once('close',()=>{if(!res.writableEnded)controller.abort();});
 }
 beginTurn(req,res){
  const requested=req.headers['x-quota-turn-id'];
  if(requested!==undefined&&(typeof requested!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requested)))fail(400,'invalid-turn-id','本轮用量标识不合法，请刷新后重试');
  req.quotaTurnId=requested||crypto.randomUUID();
  res.turnUsage=()=>this.turnUsage(req.identity.user.id,req.quotaTurnId,true);
 }
 turnUsage(userId,turnId,allowEmpty=false){
  const events=this.data.events.filter(event=>event.userId===userId&&event.turnId===turnId);
  if(!events.length&&!allowEmpty)return null;
  let credits=0,reservedCredits=0,freeCalls=0,personalCalls=0,pending=false,estimated=false;
  for(const event of events){
   const quota=event.quota;pending=pending||event.status==='started';
   if(quota?.pool==='weekly'){
    if(typeof quota.points==='number'&&Number.isFinite(quota.points))credits+=Math.round(quota.points*1000);
    else pending=true;
    reservedCredits+=Math.round((quota.reservedPoints||0)*1000);estimated=estimated||quota.estimated===true;
   }else if(quota?.pool==='free')freeCalls++;
   else if(quota?.pool==='personal'||quota?.pool==='catalog')personalCalls++;
  }
  return {turnId,status:pending?'pending':'settled',calls:events.length,weeklyPoints:credits/1000,reservedPoints:reservedCredits/1000,freeCalls,personalCalls,estimated,cache:UsageReport.cacheForEvents(events)};
 }
 callOptions(req,source,providerId,modelId){
  return {networkPolicy:true,signal:req.modelSignal,beforeCall:(context={})=>{
   const id=crypto.randomUUID(),userId=req.identity.user.id,pool=!modelId?'catalog':source==='personal'?'personal':this.isFreeModel(source,providerId,modelId)?'free':'weekly';
   if(!this.data.users.some(user=>user.id===userId&&!user.disabled)||!this.data.sessions.some(session=>session.hash===req.identity.session.hash&&session.expires>Date.now()))fail(401,'login-required','登录会话已失效');
   this.assertModelUse(req,source,providerId,modelId);
   this.change(data=>{
    if(data.usage.date!==day())data.usage={date:day(),total:0,platform:0,users:{}};
    if(data.freeDaily?.date!==day())data.freeDaily={date:day(),calls:0};
    let reservation;
    if(pool==='free'&&data.freeDaily.calls>=this.limits.platform)fail(429,'daily-limit','三个免费模型今日全站共享额度已用完，请切换周额度模型；北京时间 08:00 恢复');
    if(pool==='weekly')try{reservation=WeeklyQuota.reserve(data,{id,ownerKey:userId,limitPoints:this.weeklyLimit(userId),modelId,source,reasoningEffort:context.reasoningEffort});}catch(error){if(error.code==='weekly-limit')fail(429,error.code,error.message);throw error;}
    const usage=data.usage;usage.total++;usage.users[userId]=(usage.users[userId]||0)+1;if(source==='platform')usage.platform++;if(pool==='free')data.freeDaily.calls++;
    UsageReport.start(data,{id,userId,source,providerId,modelId:modelId||'',...(req.quotaTurnId?{turnId:req.quotaTurnId}:{}),subscriptionOwnerId:source==='chatgpt'?this.subscriptionOwnerId:null,time:Date.now(),status:'started',usage:null,errorCode:null,
     quota:{pool,points:null,estimated:false,reservedPoints:reservation?reservation.reservedCredits/1000:0,policyVersion:reservation?.policyVersion||1,...(reservation?{modelMultiplier:reservation.modelMultiplier??1}:{})}});
   });return id;
  },afterCall:(id,result,error)=>{
   if(!id)return;this.change(data=>{
    const cancelled=Boolean(req.modelSignal?.aborted||error?.name==='AbortError');
    const call=WeeklyQuota.settle(data,id,{usage:result?.usage||error?.extra?.usage,httpStatus:result?.httpStatus,error,cancelled});
    UsageReport.finish(data,id,result,error,cancelled);
    if(call){const event=data.events.find(row=>row.id===id);if(event)event.quota={pool:'weekly',points:call.chargedCredits/1000,estimated:call.estimated,reservedPoints:0,policyVersion:call.policyVersion,modelMultiplier:call.modelMultiplier??1};}
   });
  }};
 }
}
module.exports={CloudRuntime,CloudError,codec,atomic};
