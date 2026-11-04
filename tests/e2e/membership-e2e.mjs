import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin='http://127.0.0.1:'+port,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-member-browser-')),out=path.join(ROOT,'acceptance/membership');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,MEMBERSHIP_FIXTURE:'true',APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',PORT:String(port),DEEPSEEK_API_KEY:'',CLOUD_FREE_MODELS:JSON.stringify(['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}))),DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
let serverLog='';app.stderr.on('data',chunk=>serverLog+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('会员 fixture 启动超时 '+serverLog)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('会员 fixture 退出 '+serverLog));});});
const browser=makeBrowser('membership-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
const run=async code=>{evalRaw(`window.memberOperation=null;(async()=>{${code}})().then(value=>window.memberOperation=value).catch(error=>window.memberOperation={error:error.message});true`);return waitFor('会员操作','JSON.stringify(window.memberOperation)',value=>value!==null);};
const ready=()=>waitFor('聊天模型可用',`JSON.stringify({model:document.getElementById('modelSelect')?.disabled,quota:document.querySelector('#quotaText .qm-member-badge')?.textContent})`,value=>value.model===false&&!!value.quota);
async function login(username,next='/chat.html'){ab(['open',origin+'/login.html?next='+encodeURIComponent(next)]);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);if(next==='/chat.html')await ready();else await waitFor('绘图账号',`Boolean(window.DiagramCloud?.user)`,Boolean);}
async function logout(){await run(`const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);}
const usage=()=>run(`return(await(await fetch('/api/usage')).json()).usage;`);
const noOverflow=()=>evalJson('document.documentElement.scrollWidth<=innerWidth');
const click=selector=>{evalRaw(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});true`);ab(['click',selector]);};
const aliceRow='.cloud-user-row[data-user-id="ALICE"]';let aliceId;
async function adminList(){ab(['click','#cloudAccountSummary']);await waitFor('会员列表','document.querySelectorAll(".cloud-membership-edit").length',n=>n===3);aliceId=evalJson(`[...document.querySelectorAll('.cloud-user-row')].find(row=>row.firstElementChild.textContent==='alice').dataset.userId`);return aliceRow.replace('ALICE',aliceId);}
async function changeAlice(row,plan){ab(['click',row+' .cloud-membership-edit > summary']);ab(['select',row+' select[name=plan]',plan]);click(row+' .member-form button[type=submit]');await waitFor('会员保存',`document.querySelector(${JSON.stringify(row+' .cloud-membership-edit > summary')}).textContent`,text=>text.startsWith(plan==='pro'?'Pro':plan==='max'?'Max':'普通用户'));}
try{
 ab(['set','viewport','1320','980']);await login('admin','/?test=1');let row=await adminList();
 check('后台默认三个会员额度，管理入口收起显示',evalJson(`document.querySelectorAll('.cloud-membership-edit').length===3&&!document.querySelector('.cloud-membership-edit').open&&document.getElementById('cloudMemberSettings')!==null`));
 ab(['click','#cloudMemberSettings > summary']);await waitFor('等级额度表单','document.getElementById("cloudMemberPlansForm")!==null',Boolean);
 check('三档默认1000、5000、20000点',evalJson(`['free','pro','max'].map(name=>document.querySelector('#cloudMemberPlansForm [name='+name+']').value).join(',')==='1000,5000,20000'`));
 ab(['fill','#cloudMemberPlansForm [name=pro]','6000']);ab(['click','#cloudMemberPlansForm button[type=submit]']);await waitFor('等级额度保存','document.querySelector("#cloudMemberPlansForm .check-note").textContent',text=>text.includes('已保存'));
 check('后台可调整等级额度',(await run(`return(await(await fetch('/api/membership')).json()).plans;`)).pro===6000);
 ab(['fill','#cloudMemberPlansForm [name=pro]','5000']);ab(['click','#cloudMemberPlansForm button[type=submit]']);await waitFor('默认额度恢复','document.querySelector("#cloudMemberPlansForm button").disabled',disabled=>!disabled);
 await run(`return(await(await fetch('/api/membership')).json()).plans;`);
 await waitFor('保存完成','document.querySelector("#cloudMemberPlansForm button").disabled',disabled=>!disabled);
 ab(['click','#cloudMemberSettings > summary']);await changeAlice(row,'pro');
 let users=(await run(`return(await(await fetch('/api/users')).json()).users;`));const alice=users.find(u=>u.id===aliceId),initialExpiry=alice.membership.expiresAt;
 check('管理员开通Pro，自动获得5000点与30天期限',alice.membership.plan==='pro'&&alice.weeklyLimitPoints===5000&&initialExpiry>Date.now()+29*86400000);
 ab(['fill',row+' .cloud-weekly-limit input','7000']);click(row+' .cloud-weekly-limit button[type=submit]');await waitFor('特殊额度保存',`document.querySelector(${JSON.stringify(row+' .cloud-weekly-limit .check-note')}).textContent`,text=>text.includes('已保存'));
 check('特殊额度保存后会员摘要即时更新',evalJson(`document.querySelector(${JSON.stringify(row+' .cloud-membership-edit > summary')}).textContent.includes('7,000 点/周')`));
 click(row+' [data-action=inherit-quota]');await waitFor('恢复等级额度',`document.querySelector(${JSON.stringify(row+' .cloud-membership-edit > summary')}).textContent`,text=>text.includes('5,000 点/周'));
 check('恢复等级额度取消特殊上限',(await run(`return(await(await fetch('/api/users')).json()).users.find(u=>u.id===${JSON.stringify(aliceId)});`)).customWeeklyLimitPoints===null);
 ab(['click',row+' .cloud-membership-edit > summary']);click(row+' .member-actions button[type=button]');click(row+' .member-form button[type=submit]');await waitFor('续期保存',`document.querySelector(${JSON.stringify(row+' .cloud-membership-edit')}).open`,open=>!open);
 users=(await run(`return(await(await fetch('/api/users')).json()).users;`));check('续期延长30天',users.find(u=>u.id===aliceId).membership.expiresAt>=initialExpiry+29.99*86400000);
 ab(['set','viewport','320','844']);ab(['click',row+' .cloud-membership-edit > summary']);evalRaw(`document.querySelector(${JSON.stringify(row+' .member-form')}).scrollIntoView({block:'center',behavior:'instant'});true`);check('320px后台会员表单无横向溢出',noOverflow());ab(['screenshot',path.join(out,'admin-membership-320.png')]);
 ab(['set','viewport','1320','980']);await logout();await login('alice');let snapshot=await usage();
 check('Pro额度条保留原4.1点消耗，显示等级剩余额度和到期',snapshot.weekly.usedPoints===4.1&&snapshot.weekly.limitPoints===5000&&evalJson(`document.querySelector('#quotaText .qm-member-badge').textContent==='Pro'&&document.getElementById('quotaText').textContent.includes('剩余 4,995.9 点')&&document.getElementById('quotaText').textContent.includes('到期')`));
 check('Pro可选6.1 Sol，不能选Astra',evalJson(`[...document.querySelectorAll('#modelSelect option')].some(n=>n.value==='platform:mota/gpt-6.1-sol')&&![...document.querySelectorAll('#modelSelect option')].some(n=>n.value==='platform:mota/gpt-6-astra')`));
 ab(['select','#modelSelect','platform:mota/gpt-6.1-sol']);ab(['fill','#chatInput','本地Pro模型测试']);ab(['click','#sendBtn']);await waitFor('Pro回复','document.getElementById("quotaText").textContent',text=>text.includes('16.1 / 5,000 点'));
 check('Pro模拟请求按Sol二十倍扣12点，回执可见',evalJson(`document.getElementById('chatFeed').textContent.includes('本轮消耗：12 点')`));
 const denied=await run(`const s=await(await fetch('/api/auth/session')).json();const r=await fetch('/api/conversation',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({providerId:'platform:mota',modelId:'gpt-6-astra',message:'越级测试'})});return {status:r.status,body:await r.json()};`);
 check('Pro伪造Astra请求被后台拒绝',denied.status===403&&denied.body.error.code==='membership-required');
 check('普通会员不能读取或修改会员管理',(await run(`return(await fetch('/api/membership')).status;`))===403);
 await logout();await login('admin','/?test=1');row=await adminList();await changeAlice(row,'max');
 await logout();await login('alice');snapshot=await usage();check('升级Max保留16.1点消耗，周上限20000点',snapshot.weekly.limitPoints===20000&&snapshot.weekly.usedPoints===16.1&&evalJson(`document.querySelector('#quotaText .qm-member-badge').textContent==='Max'`));
 check('Max包含Luna、Sol、Astra',evalJson(`['gpt-6-luna','gpt-6.1-sol','gpt-6-astra'].every(id=>[...document.querySelectorAll('#modelSelect option')].some(n=>n.value==='platform:mota/'+id))`));
 ab(['select','#modelSelect','platform:mota/gpt-6-astra']);ab(['fill','#chatInput','本地Max模型测试']);ab(['click','#sendBtn']);await waitFor('Max回复','document.getElementById("quotaText").textContent',text=>text.includes('196.1 / 20,000 点'));
 check('Max模拟Astra按三百倍扣180点',evalJson(`document.getElementById('chatFeed').textContent.includes('本轮消耗：180 点')`));ab(['screenshot',path.join(out,'max-chat-desktop.png')]);
 ab(['set','viewport','320','844']);await waitFor('手机历史侧栏收起','document.getElementById("historyRail").getBoundingClientRect().right',right=>right<=0);check('320px聊天会员额度信息无横向溢出',noOverflow());ab(['screenshot',path.join(out,'max-chat-320.png')]);
 await run(`await fetch('/fixture-membership-expire',{method:'POST'});return true;`);ab(['open',origin+'/chat.html']);await ready();snapshot=await usage();
 check('到期自动恢复普通1000点，保留196.1点消费',snapshot.membership.plan==='free'&&snapshot.membership.expired&&snapshot.weekly.limitPoints===1000&&snapshot.weekly.usedPoints===196.1);
 check('到期目录立即隐藏Sol和Astra',evalJson(`![...document.querySelectorAll('#modelSelect option')].some(n=>/gpt-6\.1-sol|gpt-6-astra/.test(n.value))&&document.getElementById('quotaText').textContent.includes('原会员已到期')`));
 ab(['open',origin+'/usage.html']);await waitFor('用量页会员显示','document.querySelector("#quotaNote .qm-member-badge")?.textContent',text=>text==='普通用户');check('用量页同步会员与剩余点数',evalJson(`document.getElementById('quotaNote').textContent.includes('剩余 803.9 点')`));
 check('320px用量页会员信息无横向溢出',noOverflow());ab(['screenshot',path.join(out,'expired-usage-320.png')]);
 check('仅两次本地模型请求，越级请求没有消耗',(await run(`return(await(await fetch('/fixture-stats')).json()).gatewayCalls;`))===2);
}catch(error){check('会员浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);fs.writeFileSync(path.join(out,'failure.txt'),ab(['snapshot']).out);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({localGateway:true,externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
