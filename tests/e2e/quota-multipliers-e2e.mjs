import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/sol-30');fs.mkdirSync(out,{recursive:true});
const models=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-multipliers-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(models),QUOTA_MULTIPLIER_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('测试启动超时 '+log)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('测试服务退出 '+log));});});
const browser=makeBrowser('quota-multipliers-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
const run=async code=>{evalRaw(`window.multiplierResult=null;(async()=>{${code}})().then(result=>window.multiplierResult=result);true`);return waitFor('读取额度','JSON.stringify(window.multiplierResult)',value=>value!==null);};
try{
 ab(['set','viewport','1280','920']);ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);
 await waitFor('模型列表可用',`JSON.stringify({disabled:document.getElementById('modelSelect')?.disabled,rows:document.querySelectorAll('#cloudUsage .qm-value').length,loaded:[...document.querySelectorAll('#modelSelect option')].some(option=>option.value==='platform:mota/gpt-6-astra')})`,value=>value.disabled===false&&value.rows===2&&value.loaded);
 let expected=3.375;
 for(const [modelId,points] of [['gpt-6-luna',.6],['gpt-6.1-sol',18],['gpt-6-astra',180]]){
  ab(['select','#modelSelect','platform:mota/'+modelId]);ab(['fill','#chatInput','本地相同用量测试 '+modelId]);ab(['click','#sendBtn']);expected=Math.round((expected+points)*1000)/1000;
  await waitFor('模型回复完成',`JSON.stringify({count:document.querySelectorAll('#chatFeed .message.assistant').length,label:document.getElementById('sendBtn').getAttribute('aria-label'),quota:document.getElementById('cloudUsage').textContent})`,value=>value.label==='发送消息'&&value.quota.includes(expected.toLocaleString('zh-CN')+' / 1,000 点'));
  const usage=await run(`return(await(await fetch('/api/usage')).json()).usage;`);
  check(modelId+' 相同100输入+100输出扣 '+points+' 点',usage.weekly.usedPoints===expected&&usage.weekly.reservedPoints===0&&usage.free.calls===1);
 }
 check('全部请求走本地网关，未调用真实模型',(await run(`return(await fetch('/fixture-stats')).json();`)).gatewayCalls===3);
 ab(['open',origin+'/usage.html']);await waitFor('扣点明细显示',`document.getElementById('report').hidden`,hidden=>!hidden);
 check('实结明细显示Sol三十倍和Astra三百倍',evalJson(`document.getElementById('events').textContent.includes('18 点（×30）')&&document.getElementById('events').textContent.includes('180 点（×300）')&&document.getElementById('events').textContent.includes('0.6 点')`));
 check('用量说明公布三种倍率',evalJson(`document.querySelector('.notes').textContent.includes('Luna 为 1 倍')&&document.querySelector('.notes').textContent.includes('Sol 为 30 倍')&&document.querySelector('.notes').textContent.includes('Astra 为 300 倍')`));
 ab(['screenshot',path.join(out,'usage-desktop.png')]);ab(['set','viewport','320','760']);
 check('320px倍率明细页面无横向溢出',evalJson('document.documentElement.scrollWidth<=innerWidth'));ab(['screenshot',path.join(out,'usage-320.png')]);
}catch(error){check('倍率浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({localGateway:true,externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
