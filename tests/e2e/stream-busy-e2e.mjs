import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/stream-busy');fs.mkdirSync(out,{recursive:true});
const freeModels=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-grok-claude-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeModels),DRAWIO_EMBED_URL:origin+'/fixture-editor',RELAY_RATE_FIXTURE:'true',STREAM_BUSY_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error(log||'Fixture exited'));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('stream-busy-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.policyOp=null;(async()=>{${code}})().then(value=>window.policyOp={value}).catch(error=>window.policyOp={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.policyOp)',v=>v!==null);if(result.error)throw Error(result.error);return result.value;}
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('模型加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value.startsWith('platform:'))`,Boolean);}
try{
 ab(['set','viewport','1280','920']);await login('admin');
 await run(`const s=await(await fetch('/api/auth/session')).json();const r=await fetch('/api/preferences',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({providerId:'platform:relay',modelId:'gpt-6.1-sol',reasoningEffort:'high',thinkingMode:'default'})});if(!r.ok)throw Error('preference rejected');return true;`);
 ab(['reload']);await waitFor('Sol选项加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value==='platform:relay/gpt-6.1-sol')`,Boolean);ab(['select','#modelSelect','platform:relay/gpt-6.1-sol']);await waitFor('Sol高档位加载',`document.querySelector('.compose-summary-model')?.textContent`,v=>v?.includes('gpt-6.1-sol'));
 const baseline=await run(`return (await(await fetch('/api/usage')).json()).usage.weekly.usedPoints;`);
 async function send(message){ab(['fill','#chatInput',message]);ab(['click','#sendBtn']);await waitFor('繁忙回执',`document.querySelector('.message.assistant:last-child .turn-usage')?.firstChild.textContent`,v=>v==='本轮未消耗额度'||v?.startsWith('本轮消耗：'));}
 await send('生成前繁忙');
 check('生成前拒绝显示中文繁忙提示',evalJson(`document.querySelector('.message.assistant:last-child').textContent.includes('上游服务繁忙')`));
 check('Sol高档位不再估算扣45点',evalJson(`document.querySelector('.message.assistant:last-child .turn-usage').firstChild.textContent==='本轮未消耗额度'`));
 let usage=await run(`return (await(await fetch('/api/usage')).json()).usage.weekly;`);check('周已用保持不变且预留归零',usage.usedPoints===baseline&&usage.reservedPoints===0);
 ab(['screenshot',path.join(out,'busy-zero.png')]);
 ab(['reload']);await waitFor('刷新保留0点回执',`document.querySelector('.message.assistant:last-child .turn-usage')?.firstChild.textContent`,v=>v==='本轮未消耗额度');check('刷新后错误与0点回执保留',true);
 await send('部分输出后繁忙');
 check('部分输出后失败保留45点估算扣费',evalJson(`document.querySelector('.message.assistant:last-child .turn-usage').firstChild.textContent==='本轮消耗：45 点（含估算）'`));
 usage=await run(`return (await(await fetch('/api/usage')).json()).usage.weekly;`);check('部分生成准确扣45点且预留归零',Math.abs(usage.usedPoints-baseline-45)<.0001&&usage.reservedPoints===0);
 check('两次发送只有两次模拟上游调用',(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===2);
 ab(['set','viewport','390','844']);ab(['screenshot',path.join(out,'mobile.png')]);check('手机页面无横向溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth`));
}catch(error){check('繁忙计费浏览器检查',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
