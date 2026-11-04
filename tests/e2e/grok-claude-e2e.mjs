import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/grok-claude');fs.mkdirSync(out,{recursive:true});
const freeModels=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-grok-claude-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeModels),DRAWIO_EMBED_URL:origin+'/fixture-editor',GROK_CLAUDE_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error(log||'Fixture exited'));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('grok-claude-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.policyOp=null;(async()=>{${code}})().then(value=>window.policyOp={value}).catch(error=>window.policyOp={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.policyOp)',v=>v!==null);if(result.error)throw Error(result.error);return result.value;}
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('模型加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value.startsWith('platform:'))`,Boolean);}
async function logout(){await run(`const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);}
const visible=id=>evalJson(`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value===${JSON.stringify(id)})`);
const rates={'grok-4.6-latest':20,'grok-4.7':25,'claude-sonnet-5-5':30,'claude-opus-5-5':80,'claude-fable-5.1':150};
const openMenu=chat=>{if(!evalJson(`document.querySelector('.composer-settings').open`))ab(['click','.composer-settings > summary']);ab(['click',chat?'#chatModelSelectBtn':'#modelSelectBtn']);};
const newOptions=()=>evalJson(`JSON.stringify([...document.querySelectorAll('#modelSelect option')].filter(o=>/^(grok|claude)-/.test(o.dataset.modelId)).map(o=>({id:o.dataset.modelId,name:o.dataset.name})))`);
try{
 ab(['set','viewport','1280','920']);await login('alice');check('普通账号聊天列表不显示Grok/Claude',newOptions().length===0);
 const denied=await run(`const s=await(await fetch('/api/auth/session')).json();const r=await fetch('/api/conversation',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({providerId:'platform:grok',modelId:'grok-4.7',message:'绕过测试'})});return{status:r.status,data:await r.json()};`);check('伪造请求服务端提示需要Pro，未调用上游',denied.status===403&&denied.data.error.message.includes('Pro')&&(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===0);
 ab(['open',origin+'/?test=1']);await waitFor('绘图模型初始化',`document.getElementById('modelSelectLabel')?.dataset.modelId`,Boolean);openMenu(false);check('普通账号绘图列表同样隐藏新模型',evalJson(`[...document.querySelectorAll('#modelDropdown .model-option')].every(r=>!r.textContent.includes('grok-')&&!r.textContent.includes('claude-'))`));
 await logout();await login('bob');let list=newOptions();check('Pro可选全部五个新模型，标注最终倍率',list.length===5&&Object.entries(rates).every(([id,rate])=>list.some(o=>o.id===id&&o.name.endsWith(' ×'+rate))));
 for(const [providerId,modelId,points]of [['grok','grok-4.7',15],['anthropic','claude-opus-5-5',48]]){
  ab(['select','#modelSelect',`platform:${providerId}/${modelId}`]);await waitFor('模型可发送',`document.getElementById('modelSelect').disabled`,v=>!v);ab(['fill','#chatInput','本地费用验证 '+modelId]);ab(['click','#sendBtn']);await waitFor('本轮费用',`document.querySelector('.message.assistant:last-child .turn-usage')?.firstChild.textContent`,v=>v===`本轮消耗：${points} 点`);check(`${modelId}每轮扣点与指定倍率一致`,true);
 }
 ab(['reload']);await waitFor('刷新保持倍率',`document.querySelector('.compose-summary-model')?.textContent`,v=>v?.endsWith(' ×80'));check('刷新后收起摘要保留倍率',true);
 ab(['open',origin+'/usage.html']);await waitFor('用量显示',`document.querySelector('#report')?.hidden`,v=>v===false);check('用量明细识别×25和×80',evalJson(`document.querySelector('#report').textContent.includes('（×25）')&&document.querySelector('#report').textContent.includes('（×80）')`));ab(['screenshot',path.join(out,'usage.png')]);
 ab(['open',origin+'/?test=1']);await waitFor('Pro绘图模型初始化',`document.getElementById('modelSelectLabel')?.dataset.modelId`,Boolean);openMenu(false);check('Pro绘图菜单也标注五种最终倍率',evalJson(`(()=>{const names=[...document.querySelectorAll('#modelDropdown .model-option-name')].map(n=>n.textContent);return Object.entries(${JSON.stringify(rates)}).every(([id,rate])=>names.includes(id+' ×'+rate));})()`));ab(['fill','#modelSearch','claude']);ab(['screenshot',path.join(out,'drawing.png')]);
 ab(['open',origin+'/chat.html']);await waitFor('聊天初始化',`document.getElementById('modelSelect')?.disabled`,v=>v===false);ab(['set','viewport','390','844']);await waitFor('手机侧栏关闭',`document.getElementById('historyRail').getBoundingClientRect().right`,r=>r<=0);openMenu(true);ab(['fill','#chatModelDropdown input','claude']);check('手机新模型菜单不溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth&&(()=>{const r=document.getElementById('chatModelDropdown').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`));ab(['screenshot',path.join(out,'mobile.png')]);
 ab(['set','viewport','1280','920']);await logout();await login('maxuser');check('Max继承全部新模型权限',newOptions().length===5);
 await logout();await login('trialuser');check('体验账号仍仅三个免费模型',newOptions().length===0&&evalJson(`document.querySelectorAll('#modelSelect option').length===3`));
 check('只有两次本地模拟调用，没有真实模型调用',(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===2);
}catch(error){check('Grok/Claude浏览器检查',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
