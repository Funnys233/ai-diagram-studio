import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/luna-terra');fs.mkdirSync(out,{recursive:true});
const freeModels=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-luna-terra-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeModels),LUNA_TERRA_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error(log||'Fixture exited'));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('luna-terra-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.policyOp=null;(async()=>{${code}})().then(value=>window.policyOp={value}).catch(error=>window.policyOp={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.policyOp)',v=>v!==null);if(result.error)throw Error(result.error);return result.value;}
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('模型加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value.startsWith('platform:'))`,Boolean);}
async function logout(){await run(`const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);}
const visible=id=>evalJson(`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value===${JSON.stringify(id)})`);
try{
 ab(['set','viewport','1280','920']);await login('alice');check('普通用户可选Luna专用',visible('platform:zz1/gpt-6-luna'));check('普通用户看不到Terra',!visible('platform:mota/gpt-5.6-terra'));
 const denied=await run(`const s=await(await fetch('/api/auth/session')).json();const r=await fetch('/api/conversation',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({providerId:'platform:mota',modelId:'gpt-5.6-terra',message:'越级请求'})});return{status:r.status,data:await r.json()};`);check('伪造Terra请求仍在服务端403拒绝',denied.status===403&&denied.data.error.code==='membership-required');
 check('拒绝请求未发往上游',(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===0);
 await logout();await login('bob');check('Pro可选Luna专用及Terra',visible('platform:zz1/gpt-6-luna')&&visible('platform:mota/gpt-5.6-terra'));
 ab(['select','#modelSelect','platform:mota/gpt-5.6-terra']);ab(['fill','#chatInput','Terra十倍费用']);ab(['click','#sendBtn']);await waitFor('Terra结算',`document.querySelector('.message.assistant:last-child .turn-usage')?.firstChild.textContent`,text=>text==='本轮消耗：6 点');check('同等100输入/100输出按十倍扣6点',true);
 const report=await run(`return await(await fetch('/api/usage/report')).json();`);const event=report.events.find(e=>e.modelId==='gpt-5.6-terra');check('调用明细保存实际十倍倍率和6点',event.quota.modelMultiplier===10&&event.quota.points===6);
 ab(['screenshot',path.join(out,'pro-terra.png')]);await logout();await login('maxuser');check('Max继承Luna专用及Terra权限',visible('platform:zz1/gpt-6-luna')&&visible('platform:mota/gpt-5.6-terra'));
 await logout();await login('trialuser');check('体验用户仅三个免费模型，看不到新增入口',!visible('platform:zz1/gpt-6-luna')&&!visible('platform:mota/gpt-5.6-terra')&&evalJson(`document.querySelectorAll('#modelSelect option').length===3`));
}catch(error){check('Luna/Terra浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
