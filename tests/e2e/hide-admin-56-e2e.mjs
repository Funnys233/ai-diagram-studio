import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/hide-admin-56');fs.mkdirSync(out,{recursive:true});
const freeModels=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-hide56-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeModels),DRAWIO_EMBED_URL:origin+'/fixture-editor',RELAY_RATE_FIXTURE:'true',ADMIN_HIDE56_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error(log||'Fixture exited'));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('hide56-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.policyOp=null;(async()=>{${code}})().then(value=>window.policyOp={value}).catch(error=>window.policyOp={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.policyOp)',v=>v!==null);if(result.error)throw Error(result.error);return result.value;}
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('模型加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value.startsWith('platform:'))`,Boolean);}
async function logout(){await run(`const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);}
const visible=id=>evalJson(`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value===${JSON.stringify(id)})`);
const openMenu=chat=>{if(!evalJson(`document.querySelector('.composer-settings').open`))ab(['click','.composer-settings > summary']);ab(['click',chat?'#chatModelSelectBtn':'#modelSelectBtn']);};
try{
 ab(['set','viewport','1280','920']);await login('admin');
 check('管理员聊天选择器隐藏5.6，保留6系和倍率',evalJson(`(()=>{const options=[...document.querySelectorAll('#modelSelect option')];return !options.some(o=>o.dataset.modelId.startsWith('gpt-5.6-'))&&options.some(o=>o.dataset.modelId==='gpt-6-luna'&&o.dataset.name.includes('×0.5'))&&options.some(o=>o.dataset.modelId==='gpt-6.1-sol')&&options.some(o=>o.dataset.modelId==='gpt-6-astra');})()`));
 openMenu(true);ab(['fill','#chatModelDropdown input','5.6']);check('聊天搜索5.6无结果',evalJson(`document.querySelector('#chatModelDropdown .model-empty')?.textContent==='没有匹配的模型'`));ab(['screenshot',path.join(out,'chat.png')]);
 ab(['reload']);await waitFor('刷新模型就绪',`document.getElementById('modelSelect')?.disabled`,v=>v===false);check('刷新不恢复5.6选项',evalJson(`[...document.querySelectorAll('#modelSelect option')].every(o=>!o.dataset.modelId.startsWith('gpt-5.6-'))`));
 ab(['open',origin+'/?test=1']);await waitFor('绘图模型就绪',`document.getElementById('modelSelectLabel')?.dataset.modelId`,Boolean);openMenu(false);check('绘图列表同样隐藏5.6并保留6系',evalJson(`(()=>{const rows=[...document.querySelectorAll('#modelDropdown .model-option')];return !rows.some(r=>r.textContent.includes('gpt-5.6-'))&&rows.some(r=>r.textContent.includes('gpt-6-luna'))&&rows.some(r=>r.textContent.includes('gpt-6.1-sol'));})()`));
 ab(['fill','#modelSearch','5.6']);check('绘图搜索5.6无结果',evalJson(`document.querySelector('#modelDropdown .model-empty')?.textContent==='没有匹配的模型'`));ab(['screenshot',path.join(out,'drawing.png')]);
 await logout();await login('alice');check('普通用户原有5.6可见性保持',evalJson(`[...document.querySelectorAll('#modelSelect option')].some(o=>o.dataset.modelId==='gpt-5.6-luna')`));
 check('检查未调用模型',(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===0);
}catch(error){check('管理员隐藏5.6浏览器检查',false,error.stack);}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
