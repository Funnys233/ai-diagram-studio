import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/cache-usage');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-cache-usage-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CACHE_USAGE_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:'',DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('测试启动超时 '+log)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('测试服务退出 '+log));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('cache-usage-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.cacheOperation=null;(async()=>{${code}})().then(value=>window.cacheOperation={value}).catch(error=>window.cacheOperation={error:error.message});true`);const result=await waitFor('操作完成','JSON.stringify(window.cacheOperation)',value=>value!==null);if(result.error)throw Error(result.error);return result.value;}
const ready=()=>waitFor('模型加载',`Boolean([...document.getElementById('modelSelect')?.options||[]].find(o=>o.value==='platform:mota/future-open-model'))`,Boolean);
async function send(text){const count=evalJson(`document.querySelectorAll('.message.assistant').length`);ab(['fill','#chatInput',text]);ab(['click','#sendBtn']);await waitFor('缓存用量结算',`JSON.stringify({count:document.querySelectorAll('.message.assistant').length,status:document.querySelector('.message.assistant:last-child .turn-usage')?.dataset.status})`,v=>v.count===count+1&&v.status==='settled');return evalJson(`document.querySelector('.message.assistant:last-child .turn-cache')?.textContent`);}
try{
 ab(['set','viewport','1280','920']);ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await ready();ab(['select','#modelSelect','platform:mota/future-open-model']);
 check('流式末尾缓存数据在回复下显示800 token和80%',await send('缓存命中')==='缓存命中：800 token · 80%');
 check('缓存只统计，仍按总输入结算1.5点',evalJson(`document.querySelector('.message.assistant:last-child .turn-usage').firstChild.textContent==='本轮消耗：1.5 点'`));
 ab(['reload']);await ready();await waitFor('刷新缓存回执',`document.querySelector('.message.assistant:last-child .turn-cache')?.textContent`,value=>value==='缓存命中：800 token · 80%');check('刷新保留真实缓存回执',true);
 check('明确零命中显示0 token和0%',await send('缓存零')==='缓存命中：0 token · 0%');
 check('接口缺失缓存数据不伪造零命中',await send('缓存未知')==='缓存：接口未提供');ab(['screenshot',path.join(out,'chat.png')]);
 ab(['set','viewport','320','760']);check('320px每轮缓存信息可换行且不溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.turn-cache')].every(n=>n.getBoundingClientRect().right<=innerWidth)`));ab(['screenshot',path.join(out,'chat-mobile.png')]);
 ab(['set','viewport','1280','920']);ab(['open',origin+'/usage.html']);await waitFor('用量页缓存概览',`!document.getElementById('report').hidden&&!document.getElementById('refreshBtn').disabled`,Boolean);
 check('用量页缓存按输入加权为40%并标注部分未提供',evalJson(`document.getElementById('cards').textContent.includes('800')&&document.getElementById('cards').textContent.includes('40%')&&document.getElementById('cards').textContent.includes('次未提供')`));
 check('调用明细区分真实零命中与未提供',evalJson(`document.getElementById('events').textContent.includes('缓存 0 token · 0%')&&document.getElementById('events').textContent.includes('缓存未提供')`));ab(['screenshot',path.join(out,'usage.png')]);
 ab(['set','viewport','320','760']);check('320px用量概览与表格在容器内滚动',evalJson(`document.documentElement.scrollWidth<=innerWidth`));ab(['screenshot',path.join(out,'usage-mobile.png')]);
 ab(['set','viewport','1280','920']);ab(['open',origin+'/?test=1']);await waitFor('绘图页就绪',`Boolean(window.__DIAGRAM_AI_TEST__?.isReady())`,Boolean);
 const drawn=await run(`window.__DIAGRAM_AI_TEST__.setModelSelection({providerId:'platform:mota',modelId:'future-open-model'});return await window.__DIAGRAM_AI_TEST__.sendMessage('画图缓存');`);check('绘图页真实请求成功',drawn.ok===true);
 await waitFor('绘图缓存回执',`document.querySelector('.msg.assistant:last-child .turn-cache')?.textContent`,value=>value==='缓存命中：800 token · 80%');
 const saved=await run(`await window.__DIAGRAM_AI_TEST__.flushSession();return window.__DIAGRAM_AI_TEST__.captureSession().messages.at(-1).turnUsage;`);check('绘图持久会话保存缓存计数与比率',saved.cache.cachedTokens===800&&saved.cache.hitRate===80);
 ab(['reload']);await waitFor('绘图缓存刷新恢复',`[...document.querySelectorAll('.msg.assistant .turn-cache')].some(n=>n.textContent==='缓存命中：800 token · 80%')`,Boolean);check('绘图刷新恢复缓存信息',true);ab(['screenshot',path.join(out,'drawing.png')]);
}catch(error){check('缓存统计浏览器检查',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
