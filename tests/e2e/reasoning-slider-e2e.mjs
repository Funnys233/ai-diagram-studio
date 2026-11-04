import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const origin=`http://127.0.0.1:${port}`,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-slider-'));
const out=path.join(ROOT,'acceptance/reasoning-slider');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/reasoning-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',PORT:String(port),DEEPSEEK_API_KEY:'',DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Slider fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('REASONING_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('Slider fixture exited'));});});
const browser=makeBrowser('reasoning-slider-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
const state=`JSON.stringify({range:!!document.getElementById('reasoningEffortSelectRange'),disabled:document.getElementById('reasoningEffortSelectRange')?.disabled,value:document.getElementById('reasoningEffortSelect')?.value,max:document.getElementById('reasoningEffortSelectRange')?.max,output:document.querySelector('.rs-value')?.textContent})`;
async function ready(){await waitFor('强度滑块可用',state,value=>value.range&&!value.disabled);evalRaw(`document.querySelector('.composer-settings').open=true;true`);}
async function choose(value){ab(['focus','#reasoningEffortSelectRange']);ab(['press',value]);await ready();}
try{
 ab(['set','viewport','1280','920']);ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await ready();
 check('原生下拉被替换，按模型真实枚举显示默认+三档',evalJson(`document.getElementById('reasoningEffortSelect').hidden&&document.getElementById('reasoningEffortSelectRange').max==='3'&&[...document.getElementById('reasoningEffortSelect').options].map(o=>o.value).join(',')===',low,medium,xhigh'`));
 ab(['screenshot',path.join(out,'chat-default.png')]);
 const box=evalJson(`JSON.stringify((()=>{const r=document.getElementById('reasoningEffortSelectRange').getBoundingClientRect();return{x:Math.round(r.x+7),y:Math.round(r.y+r.height/2),end:Math.round(r.right-7)};})())`);
 ab(['mouse','move',String(box.x),String(box.y)]);ab(['mouse','down']);ab(['mouse','move',String(Math.round((box.x+box.end)/2)),String(box.y)]);
 check('拖到两档中间时滑块吸附到实际档位，松手前不保存',evalJson(`(()=>{const input=document.getElementById('reasoningEffortSelectRange'),root=document.querySelector('.reasoning-slider');return input.step==='1'&&Number.isInteger(Number(input.value))&&Math.abs(Number(root.dataset.position)-Number(input.value)/Number(input.max))<.0001&&document.getElementById('reasoningEffortSelect').value==='';})()`));
 ab(['mouse','move',String(box.end),String(box.y)]);
 check('拖动中只预览，松手前不改变已保存设置',evalJson(`document.getElementById('reasoningEffortSelect').value===''&&document.querySelector('.rs-value').textContent==='超高'`));
 ab(['mouse','up']);
 await waitFor('最高档持久化',state,value=>!value.disabled&&value.value==='xhigh');
 check('实际拖动到最高档保存超高，而不是虚构high/max',evalJson(state).value==='xhigh');
 check('最高档显示棱彩状态与专属动画',evalJson(`document.querySelector('.reasoning-slider').dataset.tone==='prismatic'&&getComputedStyle(document.querySelector('.rs-star')).animationName==='rs-star-drift'`));
 ab(['screenshot',path.join(out,'chat-maximum.png')]);
 ab(['reload']);await ready();check('刷新后保留最高档选择',evalJson(state).value==='xhigh');
 ab(['click','.composer-extra > summary']);ab(['click','#thinkingToggle']);await waitFor('关闭思考禁用滑块',state,value=>value.disabled);check('关闭思考禁用且保留强度',evalJson(state).value==='xhigh');
 ab(['click','#thinkingToggle']);await ready();ab(['click','.composer-extra > summary']);
 ab(['click','.rs-reset']);await waitFor('恢复默认',state,value=>!value.disabled&&value.value==='');check('默认按钮恢复供应商默认',evalJson(state).output.includes('默认'));
 await choose('ArrowRight');await waitFor('低档保存',state,value=>!value.disabled&&value.value==='low');
 evalRaw(`window.fixtureReady=false;fetch('/fixture-fail-next').then(()=>window.fixtureReady=true);true`);await waitFor('设置失败场景','window.fixtureReady',Boolean);
 await choose('End');await waitFor('冲突回退',state,value=>!value.disabled&&value.value==='low');check('保存失败退回原强度并明确提示',evalJson(`document.getElementById('composerStatus').textContent.includes('未保存')&&!document.querySelector('.reasoning-slider').classList.contains('is-max')`));
 ab(['select','#modelSelect','platform:fixture/fixture-light']);await ready();check('切换模型重建档位，不复用上一模型枚举',evalJson(state).max==='2');
 ab(['select','#modelSelect','platform:fixture/fixture-unknown']);await waitFor('未配置模型',state,value=>value.disabled&&value.output==='未配置');check('未知能力不提供虚构强度',evalJson(state).disabled);
 ab(['select','#modelSelect','platform:fixture/Qwen/Qwen3.8-27B']);await ready();await choose('End');
 ab(['set','viewport','390','844']);ab(['screenshot',path.join(out,'chat-mobile.png')]);check('手机滑块可用且页面不横向溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth&&document.getElementById('reasoningEffortSelectRange').getBoundingClientRect().width>=120`));
 ab(['set','viewport','1280','920']);ab(['open',origin+'/?test=1']);await ready();check('绘图页使用同一滑块并恢复账号偏好',evalJson(state).value==='xhigh');
 ab(['screenshot',path.join(out,'diagram-maximum.png')]);
 ab(['set','media','light','reduced-motion']);check('减少动态效果设置保留最高档配色并停止动画',evalJson(`document.querySelector('.reasoning-slider').classList.contains('is-max')&&getComputedStyle(document.querySelector('.rs-star')).animationName==='none'`));
 evalRaw(`window.quotaChecked=null;fetch('/api/usage').then(r=>r.json()).then(data=>window.quotaChecked=data.usage.userCalls);true`);await waitFor('额度检查','window.quotaChecked',value=>value!==null);check('全部交互不调用模型、不消耗调用次数',evalJson('window.quotaChecked')===0);
}catch(error){check('强度滑块浏览器流程',false,error.stack);}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
