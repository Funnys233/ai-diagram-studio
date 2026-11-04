import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin='http://127.0.0.1:'+port,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-account-browser-')),out=path.join(ROOT,'acceptance/admin');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',PORT:String(port),DEEPSEEK_API_KEY:'',CLOUD_FREE_MODELS:JSON.stringify(['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}))),DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
let serverLog='';app.stderr.on('data',chunk=>serverLog+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('账号 fixture 启动超时 '+serverLog)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('账号 fixture 退出 '+serverLog));});});
const browser=makeBrowser('admin-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
// Activate native controls deterministically; layout is verified with rendered screenshots.
const click=selector=>evalRaw(`document.querySelector(${JSON.stringify(selector)}).click();true`);
const run=async code=>{evalRaw(`window.adminOperation=null;(async()=>{${code}})().then(value=>window.adminOperation={value}).catch(error=>window.adminOperation={error:error.message});true`);const result=await waitFor('后台操作','JSON.stringify(window.adminOperation)',value=>value!==null);if(result.error)throw Error(result.error);return result.value;};
async function login(name,next='/admin.html',password='fixture-password-123'){await run(`const s=await(await fetch('/api/auth/session')).json();if(s.user)await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);ab(['open',origin+'/login.html?next='+encodeURIComponent(next)]);ab(['fill','#loginUsername',name]);ab(['fill','#loginPassword',password]);click('#loginBtn');if(next==='/admin.html'&&name==='admin')await waitFor('后台加载','document.getElementById("adminContent")?.hidden',value=>value===false);else if(next==='/chat.html')await waitFor('账号加载','!!document.getElementById("cloudAccountSummary")',Boolean);else await waitFor('普通用户返回聊天','location.pathname',path=>path==='/chat.html');}
const selector=name=>`.cloud-user-row[data-user-id="${evalJson(`[...document.querySelectorAll('.cloud-user-row')].find(row=>row.dataset.username===${JSON.stringify(name)}).dataset.userId`)}"]`;
async function setPlan(row,plan){
 const section=row+' .cloud-membership-edit';
 if(!evalJson(`document.querySelector(${JSON.stringify(section)}).open`))click(section+' > summary');
 await waitFor('会员表单展开',`document.querySelector(${JSON.stringify(section)}).open`,Boolean);
 ab(['select',row+' select[name=plan]',plan]);click(row+' .member-form button[type=submit]');
 await waitFor('会员保存',`document.querySelector(${JSON.stringify(section+' > summary')}).textContent`,text=>text.startsWith({free:'普通用户',pro:'Pro',max:'Max'}[plan]));
}

try{
 ab(['set','viewport','1300','1000']);ab(['open',origin+'/admin.html']);check('未登录打开后台会跳转登录并保留返回地址',evalJson(`location.pathname==='/login.html'&&new URLSearchParams(location.search).get('next')==='/admin.html'`));
 await login('alice');ab(['open',origin+'/admin.html']);check('普通账号直接打开后台显示无权访问',evalJson(`document.body.textContent.includes('仅管理员可访问')&&!document.getElementById('adminContent')`));
 check('普通用户不能直接获取后台用户列表',(await run(`return(await fetch('/api/users')).status;`))===403);
 await login('admin');await waitFor('用户显示','document.querySelectorAll(".cloud-user-row").length',n=>n===3);
 check('管理员可打开独立后台并看到概览和用户列表',evalJson(`document.getElementById('userCount').textContent==='3'&&document.getElementById('activeCount').textContent==='3'&&document.getElementById('freeCount').textContent==='1 / 200'`));
 const own=selector('admin');check('后台不提供禁用自己或重置自己密码按钮',evalJson(`!document.querySelector(${JSON.stringify(own+' .cloud-user-actions')})`));
 ab(['fill','#userSearch','ALICE']);check('账号搜索不区分大小写',evalJson(`[...document.querySelectorAll('.cloud-user-row')].filter(row=>!row.hidden).length===1&&!document.querySelector(${JSON.stringify(selector('alice'))}).hidden`));ab(['fill','#userSearch','']);
 ab(['fill','#cloudInviteUsername','newuser']);ab(['fill','#cloudInvitePassword','12345678']);click('#cloudInviteForm button');await waitFor('创建用户','document.getElementById("cloudInviteHint").textContent',text=>text.includes('已创建'));check('后台可创建普通账号并清空初始密码',evalJson(`document.querySelectorAll('.cloud-user-row').length===4&&document.getElementById('cloudInvitePassword').value===''&&document.getElementById('userCount').textContent==='4'`));
 ab(['fill','#cloudInvitePassword','12345678']);click('#cloudInviteForm button');await waitFor('重复用户错误','document.getElementById("cloudInviteHint").textContent',text=>text.includes('已存在'));check('重复账号显示明确错误且不重复创建',evalJson(`document.querySelectorAll('.cloud-user-row').length===4`));
 const alice=selector('alice'),bob=selector('bob');await setPlan(alice,'pro');check('后台可开通Pro并自动继承5000点',evalJson(`document.querySelector(${JSON.stringify(alice+' .cloud-weekly-limit input')}).value==='5000'`));
 ab(['fill',alice+' .cloud-weekly-limit input','7000']);click(alice+' .cloud-weekly-limit button[type=submit]');await waitFor('特殊额度保存','document.getElementById("adminStatus").textContent',text=>text.includes('特殊额度已保存'));await setPlan(alice,'max');check('切换Max仍保留特殊额度',evalJson(`document.querySelector(${JSON.stringify(alice+' .cloud-weekly-limit input')}).value==='7000'`));
 click(alice+' [data-action=inherit-quota]');await waitFor('恢复等级额度',`document.querySelector(${JSON.stringify(alice+' .cloud-weekly-limit input')}).value`,value=>Number(value)===20000);check('恢复等级额度按钮立即生效',true);
 click(bob+' [data-action=reset-password]');ab(['fill',bob+' .cloud-reset-password input','22222222']);click(bob+' .cloud-reset-password button');await waitFor('重置密码',`document.querySelector(${JSON.stringify(bob+' .cloud-reset-password [role=status]')}).textContent`,text=>text.includes('已重置'));check('后台能重置普通账号密码且清空输入',evalJson(`document.querySelector(${JSON.stringify(bob+' .cloud-reset-password input')}).value===''`));
 const signed=await fetch(origin+'/api/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'bob',password:'22222222'})});check('管理员重置的新密码可以登录',signed.status===200);const bobCookie=signed.headers.get('set-cookie').split(';')[0];
 click(bob+' .cloud-user-actions button');await waitFor('账号停用',`document.querySelector(${JSON.stringify(bob)}).classList.contains('is-disabled')`,Boolean);check('停用账号后已有会话失效',(await(await fetch(origin+'/api/auth/session',{headers:{Cookie:bobCookie}})).json()).user===null);
 click(bob+' .cloud-user-actions button');await waitFor('账号启用',`!document.querySelector(${JSON.stringify(bob)}).classList.contains('is-disabled')`,Boolean);check('后台可以重新启用账号',true);
 click('#cloudMemberSettings > summary');await waitFor('等级额度表单','!!document.getElementById("cloudMemberPlansForm")',Boolean);ab(['fill','#cloudMemberPlansForm [name=free]','1200']);ab(['fill','#cloudMemberPlansForm [name=pro]','6000']);ab(['fill','#cloudMemberPlansForm [name=max]','25000']);click('#cloudMemberPlansForm button[type=submit]');await waitFor('默认额度保存',`document.querySelector(${JSON.stringify(alice+' .cloud-weekly-limit input')}).value`,value=>Number(value)===25000);check('会员默认额度调整同步到继承账号',true);
 ab(['open',origin+'/admin.html']);await waitFor('刷新后的后台','document.getElementById("adminContent")?.hidden',hidden=>hidden===false);ab(['screenshot',path.join(out,'admin-desktop.png')]);ab(['set','viewport','320','844']);check('320px后台布局和表单不溢出',evalJson('document.documentElement.scrollWidth<=innerWidth'));ab(['screenshot',path.join(out,'admin-320.png')]);
 click('#adminLogout');await waitFor('后台退出','location.pathname',path=>path==='/login.html');ab(['open',origin+'/admin.html']);check('退出登录后后台页面重新要求登录',evalJson(`location.pathname==='/login.html'`));
 ab(['set','viewport','1300','1000']);await login('alice','/chat.html');click('#cloudAccountSummary');await waitFor('个人会员同步','document.querySelector(".account-plan").textContent',text=>text==='Max');const usage=await run(`return(await(await fetch('/api/usage')).json()).usage;`);check('后台调整同步到用户且保留已用4.1点',usage.membership.plan==='max'&&usage.weekly.limitPoints===25000&&usage.weekly.usedPoints===4.1);
 check('Max账号仍没有后台入口且无法打开后台',evalJson(`!document.getElementById('adminLink')`)&&(await run(`return(await fetch('/admin.html')).status;`))===403);
 check('管理操作未发起真实或模拟模型调用',(await(await fetch(origin+'/fixture-stats')).json()).gatewayCalls===0);
}catch(error){check('后台浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);fs.writeFileSync(path.join(out,'failure.txt'),ab(['snapshot']).out);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({localGateway:true,externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
