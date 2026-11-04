import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const origin=`http://127.0.0.1:${port}`,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-slider-'));
const out=path.join(ROOT,'acceptance/drawing-styles/browser');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/reasoning-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',PORT:String(port),DEEPSEEK_API_KEY:'',DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Slider fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('REASONING_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('Slider fixture exited'));});});

const {ab,evalJson,evalRaw,waitFor}=makeBrowser('drawing-styles-'+Date.now()),{check,results,failures}=makeChecker();
const click=selector=>{evalRaw(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});true`);ab(['click',selector]);};
const bounds=()=>evalJson(`(()=>{const r=document.querySelector('.preset-options').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`);
const visibleOptions=()=>evalJson(`(()=>{const menu=document.querySelector('.preset-options');return [...menu.querySelectorAll('.chip')].every(chip=>{chip.scrollIntoView({block:'nearest',behavior:'instant'});const r=chip.getBoundingClientRect();return chip.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));});})()`);
try{
 ab(['set','viewport','1280','920']);ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);
 await waitFor('登录完成','/^platform:/.test(document.getElementById("modelSelect")?.value||"")',Boolean);
 ab(['open',origin+'/?test=1']);await waitFor('绘图工作台可用','window.__DIAGRAM_AI_TEST__?.state.ready&&!window.__DIAGRAM_AI_TEST__?.state.sessionBusy',Boolean);
 check('六种风格取代旧示例题',evalJson(`document.querySelectorAll('#chips [data-style]').length===6&&document.querySelector('#chips summary').textContent.includes('绘图风格')&&!document.querySelector('#chips').textContent.includes('登录注册流程')`));
 ab(['fill','#chatInput','画一个包含失败分支的审批流程']);click('#chips > summary');check('桌面菜单完整可见',bounds()&&visibleOptions());ab(['screenshot',path.join(out,'styles-desktop.png')]);
 click('#chips [data-style="monochrome"]');check('黑白简约加入草稿且保留需求',evalJson(`document.getElementById('chatInput').value.startsWith('画一个包含失败分支的审批流程')&&document.getElementById('chatInput').value.includes('不用彩色')&&!document.getElementById('chips').open`));
 click('#chips > summary');click('#chips [data-style="business"]');click('#chips > summary');click('#chips [data-style="business"]');
 check('切换和重复选择不堆叠风格',evalJson(`(document.getElementById('chatInput').value.match(/【绘图风格：/g)||[]).length===1&&!document.getElementById('chatInput').value.includes('黑白简约')&&document.getElementById('chatInput').value.includes('#2563EB')`));
 ab(['reload']);await waitFor('刷新草稿恢复','document.getElementById("chatInput")?.value',value=>value?.includes('商务蓝'));check('风格要求随草稿保存',evalJson(`document.getElementById('chatInput').value.includes('失败分支')`));
 ab(['set','viewport','390','844']);click('#chips > summary');check('手机菜单完整可见且可滚动',bounds()&&visibleOptions()&&evalJson(`getComputedStyle(document.querySelector('.preset-options')).overflowY==='auto'`));ab(['screenshot',path.join(out,'styles-mobile.png')]);
 click('#chips [data-style="sketch"]');check('可选择最后一项且仍保留原需求',evalJson(`document.getElementById('chatInput').value.includes('手绘草图')&&document.getElementById('chatInput').value.includes('失败分支')&&!document.getElementById('chatInput').value.includes('商务蓝')`));
 evalRaw(`window.styleUsage=null;fetch('/api/usage').then(r=>r.json()).then(data=>window.styleUsage=data.usage.userCalls);true`);await waitFor('用量核对','window.styleUsage',value=>value!==null);check('选择风格不调用模型或扣点',evalJson('window.styleUsage')===0);
}catch(error){check('绘图风格浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
