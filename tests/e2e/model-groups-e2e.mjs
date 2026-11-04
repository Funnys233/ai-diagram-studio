import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/model-groups');fs.mkdirSync(out,{recursive:true});
const freeModels=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-model-groups-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeModels),DRAWIO_EMBED_URL:origin+'/fixture-editor',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error(log||'Fixture exited'));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('model-groups-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.policyOp=null;(async()=>{${code}})().then(value=>window.policyOp={value}).catch(error=>window.policyOp={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.policyOp)',v=>v!==null);if(result.error)throw Error(result.error);return result.value;}
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('模型加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value.startsWith('platform:'))`,Boolean);}
async function logout(){await run(`const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);}
const visible=id=>evalJson(`[...document.querySelectorAll('#modelSelect option')].some(o=>o.value===${JSON.stringify(id)})`);
const openMenu=chat=>{if(!evalJson(`document.querySelector('.composer-settings').open`))ab(['click','.composer-settings > summary']);ab(['click',chat?'#chatModelSelectBtn':'#modelSelectBtn']);};
const groups=chat=>evalJson(`JSON.stringify([...document.querySelectorAll('${chat?'#chatModelDropdown':'#modelDropdown'} .model-group')].map(g=>({title:g.querySelector('.model-group-title').textContent,names:[...g.querySelectorAll('.model-option-name')].map(n=>n.textContent),ids:[...g.querySelectorAll('.model-option-id')].map(n=>n.textContent)})))`);
try{
 ab(['set','viewport','1280','920']);await login('alice');
 await run(`const s=await(await fetch('/api/auth/session')).json(),p=await(await fetch('/api/providers/personal:mine')).json();const r=await fetch('/api/providers/personal:mine/models',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({modelId:'deepseek-ai/DeepSeek-V4.1-Flash',displayName:'个人同名 DeepSeek',revision:p.revision})});if(!r.ok)throw Error('Fixture model creation failed');return true;`);
 ab(['reload']);await waitFor('个人同名模型加载',`[...document.querySelectorAll('#modelSelect option')].some(o=>o.textContent.includes('个人同名'))`,Boolean);
 openMenu(true);let list=groups(true);
 check('聊天仅两类，免费在前且恰好三个',list.length===2&&list[0].title==='免费模型'&&list[0].names.length===3&&list[1].title==='其他模型');
 check('同一供应商新增开放模型和同名个人模型归其他',list[1].names.includes('新增开放模型 ×0.5')&&list[1].names.includes('个人同名 DeepSeek')&&!list[0].names.includes('个人同名 DeepSeek'));
 check('其他模型保留来源便于区分',list[1].ids.some(id=>id.includes('我的模型 · 我的 API'))&&list[1].ids.some(id=>id.includes('平台模型 · 测试共享模型')));
 ab(['fill','#chatModelDropdown input','免费模型']);check('可按分类搜索',groups(true).length===1&&groups(true)[0].names.length===3);
 ab(['fill','#chatModelDropdown input','新增开放']);ab(['press','Enter']);ab(['press','Enter']);
 check('键盘选择仍使用对应模型并关闭列表',evalJson(`document.getElementById('modelSelect').value==='platform:mota/future-open-model'&&document.getElementById('chatModelDropdown').hidden&&document.querySelector('.compose-summary-model').textContent==='新增开放模型 ×0.5'`));
 ab(['reload']);await waitFor('已选模型恢复',`document.getElementById('modelSelect')?.value`,v=>v==='platform:mota/future-open-model');check('刷新保持模型选择',true);
 openMenu(true);ab(['fill','#chatModelDropdown input','绝对不存在']);check('无结果提示保留',evalJson(`document.querySelector('#chatModelDropdown .model-empty').textContent==='没有匹配的模型'`));ab(['press','Escape']);check('Escape关闭列表并回到模型按钮',evalJson(`document.getElementById('chatModelDropdown').hidden&&document.activeElement.id==='chatModelSelectBtn'`));
 openMenu(true);ab(['screenshot',path.join(out,'chat-desktop.png')]);ab(['press','Escape']);ab(['press','Escape']);ab(['set','viewport','390','844']);await waitFor('手机侧栏收起',`document.getElementById('historyRail').getBoundingClientRect().right`,right=>right<=0);openMenu(true);
 check('手机分类面板不溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth&&(()=>{const r=document.getElementById('chatModelDropdown').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`));ab(['screenshot',path.join(out,'chat-mobile.png')]);
 ab(['set','viewport','1280','920']);ab(['open',origin+'/?test=1']);await waitFor('绘图目录就绪',`document.getElementById('modelSelectLabel')?.dataset.modelId`,Boolean);openMenu(false);list=groups(false);
 check('绘图同样仅两类且免费恰好三个',list.length===2&&list[0].title==='免费模型'&&list[0].names.length===3&&list[1].title==='其他模型');
 check('绘图其他类包括开放模型、个人模型和示例',list[1].names.includes('新增开放模型 ×0.5')&&list[1].names.includes('个人同名 DeepSeek')&&list[1].names.includes('内置示例引擎（确定性布局修改）'));
 ab(['fill','#modelSearch','个人同名']);ab(['press','Enter']);ab(['press','Enter']);check('绘图键盘选择保留来源',evalJson(`document.getElementById('modelSelectLabel').dataset.providerId==='personal:mine'&&document.getElementById('modelSelectLabel').dataset.modelId==='deepseek-ai/DeepSeek-V4.1-Flash'`));
 openMenu(false);ab(['screenshot',path.join(out,'drawing-desktop.png')]);await logout();
 await run(`const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'grouptrial',password:'fixture-password-123'})});if(!r.ok)throw Error('Registration failed');return true;`);
 ab(['open',origin+'/chat.html']);await waitFor('体验用户模型就绪',`document.querySelectorAll('#modelSelect option').length`,n=>n===3);openMenu(true);list=groups(true);check('体验用户只显示免费类，无空的其他分类',list.length===1&&list[0].title==='免费模型'&&list[0].names.length===3);
 check('全程未调用模型',(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===0);
}catch(error){check('模型分类浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
