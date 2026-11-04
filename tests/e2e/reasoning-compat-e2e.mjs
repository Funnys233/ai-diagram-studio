import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/reasoning-compat');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-reasoning-compat-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',REASONING_COMPAT_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:'',DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('测试启动超时 '+log)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('测试服务退出 '+log));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('reasoning-compat-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.compatOperation=null;(async()=>{${code}})().then(value=>window.compatOperation={value}).catch(error=>window.compatOperation={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.compatOperation)',value=>value!==null);if(result.error)throw Error(result.error);return result.value;}
const state=`JSON.stringify({disabled:document.getElementById('reasoningEffortSelectRange')?.disabled,max:document.getElementById('reasoningEffortSelectRange')?.max,value:document.getElementById('reasoningEffortSelect')?.value})`;
const open=()=>evalRaw(`document.querySelector('.composer-settings').open=true;document.querySelector('.composer-extra').open=true;true`);
try{
 ab(['set','viewport','1280','920']);ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);
 await waitFor('模型加载',`Boolean([...document.getElementById('modelSelect')?.options||[]].find(o=>o.value==='platform:mota/gpt-6-luna'))`,Boolean);ab(['select','#modelSelect','platform:mota/gpt-6-luna']);open();
 await waitFor('未配置强度',state,value=>value.disabled===true);check('检测前未知强度不预设档位',evalJson(`[...document.getElementById('reasoningEffortSelect').options].map(o=>o.value).join(',')`)==='');
 evalRaw(`window.confirm=()=>true;document.getElementById('detectReasoningBtn').click();true`);
 await waitFor('读取中转声明',state,value=>value.disabled===false&&value.max==='5');
 check('省略参数名的中转响应恢复默认及五个强度',evalJson(`[...document.getElementById('reasoningEffortSelect').options].map(o=>o.value).join(',')`)===',low,medium,high,xhigh,max');
 check('提示清楚区分接口声明与逐档验证',evalJson(`document.getElementById('composerStatus').textContent.includes('按接口声明')&&document.getElementById('composerStatus').textContent.includes('未逐档验证')`));
 let stats=await run(`return await(await fetch('/fixture-stats')).json();`);check('仅发起两次本地检测请求',stats.gatewayCalls===2);
 open();ab(['focus','#reasoningEffortSelectRange']);ab(['press','End']);await waitFor('最高档保存',state,value=>!value.disabled&&value.value==='max');
 stats=await run(`return await(await fetch('/fixture-stats')).json();`);check('调整滑块不额外调用模型',stats.gatewayCalls===2);
 ab(['reload']);await waitFor('刷新恢复强度',state,value=>value.value==='max'&&!value.disabled);open();check('刷新后五档与最高偏好同时保留',evalJson(state).max==='5');
 ab(['fill','#chatInput','检查强度参数']);ab(['click','#sendBtn']);await waitFor('完成回复',`document.getElementById('sendBtn').getAttribute('aria-label')`,value=>value==='发送消息');
 stats=await run(`return await(await fetch('/fixture-stats')).json();`);check('聊天实际发送所选max参数且只调用一次',stats.gatewayCalls===3&&stats.lastReasoningEffort==='max');
 open();ab(['screenshot',path.join(out,'chat.png')]);
 ab(['set','viewport','390','844']);check('手机展开设置不产生横向溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth`));ab(['screenshot',path.join(out,'mobile.png')]);
 ab(['set','viewport','1280','920']);ab(['open',origin+'/?test=1']);await waitFor('绘图页就绪',`Boolean(window.__DIAGRAM_AI_TEST__?.isReady())`,Boolean);evalRaw(`window.__DIAGRAM_AI_TEST__.setModelSelection({providerId:'platform:mota',modelId:'gpt-6-luna'});true`);await waitFor('绘图页恢复已检测能力',state,value=>!value.disabled&&value.max==='5'&&value.value==='max');open();check('绘图页共享同一能力声明和账号偏好',true);ab(['screenshot',path.join(out,'drawing.png')]);
}catch(error){check('强度兼容浏览器检查',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
