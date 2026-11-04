import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/relay-rates');fs.mkdirSync(out,{recursive:true});
const freeModels=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-relay-rates-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeModels),DRAWIO_EMBED_URL:origin+'/fixture-editor',RELAY_RATE_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error(log||'Fixture exited'));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('relay-rates-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.policyOp=null;(async()=>{${code}})().then(value=>window.policyOp={value}).catch(error=>window.policyOp={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.policyOp)',v=>v!==null);if(result.error)throw Error(result.error);return result.value;}
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('模型加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value.startsWith('platform:'))`,Boolean);}
async function logout(){await run(`const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);}
const visible=id=>evalJson(`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value===${JSON.stringify(id)})`);
const openMenu=chat=>{if(!evalJson(`document.querySelector('.composer-settings').open`))ab(['click','.composer-settings > summary']);ab(['click',chat?'#chatModelSelectBtn':'#modelSelectBtn']);};
try{
 ab(['set','viewport','1280','920']);await login('admin');
 const options=evalJson(`JSON.stringify([...document.querySelectorAll('#modelSelect option')].map(o=>({id:o.value,name:o.dataset.name,group:o.dataset.group})))`);
 for(const [id,rate]of [['gpt-6-luna',1],['gpt-6.1-sol',30],['gpt-6-astra',300]]){
  check(`${id}共享显示×${rate}，中转显示×${rate/2}`,options.some(o=>o.id.startsWith('chatgpt:')&&o.id.endsWith('/'+id)&&o.name.endsWith(' ×'+rate))&&options.some(o=>o.id==='platform:relay/'+id&&o.name.endsWith(' ×'+rate/2)));
 }
 check('Luna专用同样标注×0.5',options.some(o=>o.id==='platform:luna-only/gpt-6-luna'&&o.name.endsWith(' ×0.5')));
 check('三个免费模型不显示点数倍率',options.filter(o=>o.group==='免费模型').length===3&&options.filter(o=>o.group==='免费模型').every(o=>!o.name.includes('×')));
 openMenu(true);ab(['fill','#chatModelDropdown input','gpt-6-luna']);check('实际菜单行保留倍率与来源',evalJson(`(()=>{const rows=[...document.querySelectorAll('#chatModelDropdown .model-option')];return rows.some(r=>r.querySelector('.model-option-name').textContent.endsWith(' ×1'))&&rows.filter(r=>r.querySelector('.model-option-name').textContent.endsWith(' ×0.5')).length===2&&rows.some(r=>r.querySelector('.model-option-id').textContent.includes('Luna专用'));})()`));ab(['screenshot',path.join(out,'chat-rates.png')]);ab(['press','Escape']);ab(['press','Escape']);
 for(const [id,points,rate]of [['gpt-6-luna',.3,.5],['gpt-6.1-sol',9,15],['gpt-6-astra',90,150]]){
  ab(['select','#modelSelect','platform:relay/'+id]);await waitFor('模型设置更新',`document.getElementById('modelSelect').disabled`,v=>v===false);
  check(`${id}收起摘要显示倍率`,evalJson(`document.querySelector('.compose-summary-model').textContent.endsWith(${JSON.stringify(' ×'+rate)})`));
  ab(['fill','#chatInput','中转半价 '+id]);ab(['click','#sendBtn']);await waitFor('回复结算',`document.querySelector('.message.assistant:last-child .turn-usage')?.firstChild.textContent`,v=>v===`本轮消耗：${points} 点`);
  const event=await run(`const r=await(await fetch('/api/usage/report')).json();return r.events.find(e=>e.modelId===${JSON.stringify(id)}&&e.source==='platform');`);
  check(`${id}本轮实际扣${points}点且明细倍率一致`,event.quota.points===points&&event.quota.modelMultiplier===rate&&event.quota.policyVersion===6);
 }
 ab(['reload']);await waitFor('刷新恢复倍率',`document.querySelector('.compose-summary-model')?.textContent`,v=>v?.endsWith(' ×150'));check('刷新后仍标注真实倍率',true);
 ab(['open',origin+'/usage.html']);await waitFor('用量明细',`document.querySelector('#report')?.hidden`,v=>v===false);check('用量明细显示半价倍率，包括小数',evalJson(`['（×0.5）','（×15）','（×150）'].every(text=>document.querySelector('#report').textContent.includes(text))`));ab(['screenshot',path.join(out,'usage-rates.png')]);
 ab(['open',origin+'/?test=1']);await waitFor('绘图目录',`document.getElementById('modelSelectLabel')?.dataset.modelId`,Boolean);openMenu(false);ab(['fill','#modelSearch','gpt-6.1-sol']);
 check('绘图菜单区分共享×30和中转×15',evalJson(`(()=>{const names=[...document.querySelectorAll('#modelDropdown .model-option-name')].map(n=>n.textContent);return names.some(n=>n.endsWith(' ×30'))&&names.some(n=>n.endsWith(' ×15'));})()`));
 ab(['press','Escape']);await run(`window.__DIAGRAM_AI_TEST__.setModelSelection({providerId:'platform:relay',modelId:'gpt-6.1-sol'});return true;`);check('绘图收起摘要显示×15',evalJson(`document.querySelector('.compose-summary-model').textContent.endsWith(' ×15')`));
 ab(['open',origin+'/chat.html']);await waitFor('聊天初始化',`document.getElementById('modelSelect')?.disabled`,v=>v===false);ab(['set','viewport','390','844']);await waitFor('手机侧栏收起',`document.getElementById('historyRail').getBoundingClientRect().right`,r=>r<=0);openMenu(true);ab(['fill','#chatModelDropdown input','gpt-6.1-sol']);check('手机倍率列表不溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth&&(()=>{const r=document.getElementById('chatModelDropdown').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`));ab(['screenshot',path.join(out,'mobile-rates.png')]);
 ab(['set','viewport','1280','920']);await logout();await login('alice');check('个人API只统计，不标注本站扣点倍率',evalJson(`[...document.querySelectorAll('#modelSelect option')].filter(o=>o.value.startsWith('personal:')).every(o=>!o.dataset.name.includes('×'))`));
 check('仅三个本地模拟中转调用，没有调用真实订阅',(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===3);
}catch(error){check('中转倍率浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
