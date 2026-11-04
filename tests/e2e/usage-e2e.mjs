import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-usage-e2e-')),origin=`http://127.0.0.1:${port}`;
const out=process.env.USAGE_E2E_OUT||path.join(ROOT,'acceptance/usage-report');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/usage-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:dir,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('用量测试服务启动超时')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('USAGE_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('测试服务退出'));});});
const browser=makeBrowser('usage-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
const ready=()=>waitFor('用量统计完成',`JSON.stringify({ready:!document.getElementById('report').hidden,busy:document.getElementById('refreshBtn').disabled,text:document.getElementById('status').textContent})`,value=>value.ready&&!value.busy);
async function login(username){ab(['open',origin+'/login.html?next=%2Fusage.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('跳转用量页','location.pathname',value=>value==='/usage.html');await ready();}
try{
 ab(['set','viewport','1360','1000']);await login('admin');
 check('管理员显示全站4次调用与已知/未知token',evalJson(`document.querySelector('#cards strong').textContent==='4'&&document.getElementById('cards').textContent.includes('1,650')&&document.getElementById('cards').textContent.includes('2 次未知')`));
 check('三种来源与结果独立显示',evalJson(`document.getElementById('sources').textContent.includes('平台模型')&&document.getElementById('sources').textContent.includes('ChatGPT 订阅')&&document.getElementById('events').textContent.includes('已取消')`));
 ab(['screenshot',path.join(out,'admin-desktop.png')]);
 ab(['select','#scope','subscription']);await ready();check('订阅合计包含所有授权用户但只计2次',evalJson(`document.querySelector('#cards strong').textContent==='2'&&document.getElementById('users').textContent.includes('alice')&&document.getElementById('users').textContent.includes('admin')`));
 ab(['select','#userId',evalJson(`[...document.querySelectorAll('#userId option')].find(option=>option.textContent==='alice').value`)]);await ready();check('管理员筛选授权使用者只计一次',evalJson(`document.querySelector('#cards strong').textContent==='1'&&document.getElementById('models').textContent.includes('gpt-luna')`));
 ab(['select','#range','7d']);await ready();check('近7天展示7个日期',evalJson(`document.querySelectorAll('.day').length===7`));
 ab(['set','viewport','390','844']);ab(['screenshot',path.join(out,'admin-mobile.png')]);check('手机布局不产生横向页面溢出',evalJson('document.documentElement.scrollWidth<=innerWidth'));
 evalRaw(`window.loggedOut=false;fetch('/api/auth/session').then(r=>r.json()).then(s=>fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}})).then(()=>window.loggedOut=true);true`);await waitFor('退出','window.loggedOut',Boolean);
 await login('alice');check('普通用户只显示本人3次调用且隐藏管理筛选',evalJson(`document.querySelector('#cards strong').textContent==='3'&&document.getElementById('scopeField').hidden&&document.getElementById('userField').hidden&&!document.getElementById('models').textContent.includes('gpt-owner')`));
 evalRaw(`window.permissionStatus=null;fetch('/api/usage/report?scope=all').then(r=>window.permissionStatus=r.status);true`);await waitFor('权限拦截','window.permissionStatus',value=>value!==null);check('伪造管理员范围被服务器403拒绝',evalJson('window.permissionStatus')===403);
 ab(['screenshot',path.join(out,'user-mobile.png')]);
}catch(error){check('用量浏览器流程',false,error.stack);}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
