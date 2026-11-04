import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const origin=`http://127.0.0.1:${port}`,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-weekly-'));
const out=path.join(ROOT,'acceptance/weekly-quota');fs.mkdirSync(out,{recursive:true});
const freeModels=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(freeModels),PORT:String(port),DEEPSEEK_API_KEY:'',DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
let serverLog='';app.stderr.on('data',chunk=>serverLog+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('周额度 fixture 启动超时 '+serverLog)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('周额度 fixture 退出 '+serverLog));});});
const browser=makeBrowser('weekly-quota-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
const run=async code=>{evalRaw(`window.quotaOperation=null;(async()=>{${code}})().then(value=>window.quotaOperation=value).catch(error=>window.quotaOperation={error:error.message});true`);return waitFor('额度操作','JSON.stringify(window.quotaOperation)',value=>value!==null);};
const usage=()=>run(`const r=await fetch('/api/usage');return (await r.json()).usage;`);
const ready=()=>waitFor('双额度条读取',`JSON.stringify({pools:document.querySelectorAll('#quotaText .qm-pool').length,values:[...document.querySelectorAll('#quotaText .qm-value')].map(n=>n.textContent),model:document.getElementById('modelSelect')?.disabled})`,value=>value.pools===2&&value.values.every(text=>text.includes('/'))&&!value.model);
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await ready();}
async function logout(){await run(`const s=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':s.csrf}});return true;`);}
const noOverflow=()=>evalJson(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.quota-meter')].filter(n=>n.checkVisibility()).every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})`);
try{
 ab(['set','viewport','1360','950']);await login('admin');
 let snapshot=await usage();check('免费池统计全站1次，管理员周池平台与GPT合计3.375点',snapshot.free.calls===1&&snapshot.free.limit===200&&snapshot.weekly.usedPoints===3.375&&snapshot.weekly.limitPoints===1000&&!Object.hasOwn(snapshot.limits,'user'));
 check('顶部两个额度条显示各自用量和北京时间恢复时间',evalJson(`document.getElementById('quotaText').textContent.includes('1 / 200 次')&&document.getElementById('quotaText').textContent.includes('3.375 / 1,000 点')&&document.querySelectorAll('#quotaText .qm-note').length===2&&[...document.querySelectorAll('#quotaText .qm-note')].every(n=>n.textContent.includes('北京时间'))`));
 ab(['select','#modelSelect','platform:mota/Qwen/Qwen3.8-27B']);check('明确三个免费模型高亮全站池',evalJson(`document.querySelector('#quotaText [data-pool=free]').classList.contains('is-current')&&!document.querySelector('#quotaText [data-pool=weekly]').classList.contains('is-current')`));
 ab(['select','#modelSelect','platform:mota/future-open-model']);check('后来新增开放模型自动使用个人周池',evalJson(`document.querySelector('#quotaText [data-pool=weekly]').classList.contains('is-current')`));
 ab(['fill','#chatInput','请返回本地模拟回复']);ab(['click','#sendBtn']);await waitFor('本地网关完成','document.getElementById("chatFeed").textContent',text=>text.includes('这是本地模拟回复。'));await waitFor('前端额度结算','document.getElementById("quotaText").textContent',text=>text.includes('3.975 / 1,000 点'));
 snapshot=await usage();check('实际本地网关100输入+100输出扣0.6点且免费池不变',snapshot.weekly.usedPoints===3.975&&snapshot.free.calls===1&&(await run(`return await(await fetch('/fixture-stats')).json();`)).gatewayCalls===1);
 for(const width of [390,320]){ab(['set','viewport',String(width),'844']);await waitFor('手机侧栏收起','document.getElementById("historyRail").getBoundingClientRect().right',right=>right<=0);check(`${width}px纯对话双条不溢出`,noOverflow());ab(['screenshot',path.join(out,`chat-${width}.png`)]);}
 ab(['set','viewport','1360','950']);ab(['open',origin+'/?test=1']);await waitFor('绘图页双条','document.querySelectorAll("#cloudUsage .qm-value").length',value=>value===2);await waitFor('绘图模型初始化','document.getElementById("modelSelectLabel").dataset.modelId',Boolean);
 await run(`window.__DIAGRAM_AI_TEST__.setModelSelection({providerId:'platform:mota',modelId:'Qwen/Qwen3.8-27B'});return true;`);check('绘图模型选择事件切换免费池高亮',evalJson(`document.querySelector('#cloudUsage [data-pool=free]').classList.contains('is-current')`));
 ab(['click','#cloudAccountSummary']);await waitFor('管理员周额度列表','document.querySelectorAll(".cloud-weekly-limit").length',value=>value===3);
 check('管理员能编辑全部用户包括自己的周额度',evalJson(`document.querySelectorAll('.cloud-weekly-limit input').length===3&&[...document.querySelectorAll('.cloud-user-row')].some(row=>row.textContent.includes('admin')&&row.querySelector('.cloud-weekly-limit'))`));
 const adminId=evalJson('window.DiagramCloud.user.id');const own=`.cloud-user-row[data-user-id="${adminId}"] .cloud-weekly-limit`;
 ab(['fill',own+' input','1200']);ab(['click',own+' button[type=submit]']);await waitFor('管理员周额度保存',`document.querySelector(${JSON.stringify(own+' .check-note')}).textContent`,text=>text.includes('已保存'));
 check('修改自己周额度保留已扣3.975点且立即变为1200点上限',(await usage()).weekly.limitPoints===1200&&(await usage()).weekly.usedPoints===3.975);
 const aliceId=evalJson(`[...document.querySelectorAll('.cloud-user-row')].find(row=>row.firstElementChild.textContent==='alice').dataset.userId`);const aliceForm=`.cloud-user-row[data-user-id="${aliceId}"] .cloud-weekly-limit`;
 ab(['fill',aliceForm+' input','1500']);ab(['click',aliceForm+' button[type=submit]']);await waitFor('Alice周额度保存',`document.querySelector(${JSON.stringify(aliceForm+' .check-note')}).textContent`,text=>text.includes('已保存'));
 ab(['set','viewport','390','844']);check('390px管理员额度表单不溢出',noOverflow());ab(['screenshot',path.join(out,'admin-settings-mobile.png')]);
 await run(`await fetch('/fixture-fail-usage');await window.DiagramCloud.refreshUsage();return true;`);check('读取失败保留上次额度并明确提示更新失败',evalJson(`document.getElementById('cloudUsage').textContent.includes('3.975 / 1,200 点')&&document.getElementById('cloudUsage').textContent.includes('更新失败')`));
 ab(['set','viewport','1360','950']);ab(['open',origin+'/usage.html']);await waitFor('用量明细','document.getElementById("report").hidden',value=>value===false);
 check('用量页保留8次调用并展示实际点数估算和免费池',evalJson(`document.querySelector('#cards strong').textContent==='8'&&document.getElementById('events').textContent.includes('0.6 点')&&document.getElementById('events').textContent.includes('估算 3 点')&&document.getElementById('events').textContent.includes('免费池 1 次')&&document.getElementById('events').textContent.includes('只统计')&&document.querySelectorAll('thead th').length===8`));ab(['screenshot',path.join(out,'usage-admin-desktop.png')]);
 for(const width of [390,320]){ab(['set','viewport',String(width),'844']);check(`${width}px用量页双条不溢出`,noOverflow());ab(['screenshot',path.join(out,`usage-${width}.png`)]);}
 await logout();await login('alice');snapshot=await usage();check('Alice独立周池4.1点和新1500点上限，免费次数全站共用',snapshot.weekly.usedPoints===4.1&&snapshot.weekly.limitPoints===1500&&snapshot.free.calls===1);
 ab(['select','#modelSelect','personal:mine/my-model']);check('个人API仅统计提示且两个共享池都不高亮',evalJson(`document.getElementById('quotaText').textContent.includes('个人 API，仅统计调用')&&!document.querySelector('#quotaText .is-current')`));
 ab(['fill','#chatInput','个人API模拟回复']);ab(['click','#sendBtn']);await waitFor('个人本地网关完成','document.getElementById("chatFeed").textContent',text=>text.includes('这是本地模拟回复。'));await waitFor('个人请求完成','document.getElementById("sendBtn").getAttribute("aria-label")',text=>text==='发送消息');snapshot=await usage();check('个人API真实模拟请求只统计，不扣周点和免费次数',snapshot.weekly.usedPoints===4.1&&snapshot.free.calls===1);
 ab(['open',origin+'/?test=1']);await waitFor('Alice绘图菜单','Boolean(window.DiagramCloud?.user)',Boolean);ab(['click','#cloudAccountSummary']);check('普通用户没有周额度修改入口',evalJson(`document.querySelectorAll('.cloud-weekly-limit').length===0&&!document.getElementById('cloudInviteForm')`));
 const denied=await run(`const r=await fetch('/api/users/${aliceId}/weekly-limit',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({limitPoints:9999})});return r.status;`);check('普通用户伪造调整周额度被403拒绝',denied===403);
 ab(['open',origin+'/usage.html']);await waitFor('Alice用量明细','document.getElementById("report").hidden',value=>value===false);check('普通用户只见本人5次明细和自己的额度',evalJson(`document.querySelector('#cards strong').textContent==='5'&&document.getElementById('scopeField').hidden&&document.getElementById('quotaNote').textContent.includes('4.1 / 1,500 点')&&!document.getElementById('events').textContent.includes('gpt-shared')`));
}catch(error){check('周额度浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);fs.writeFileSync(path.join(out,'failure.txt'),ab(['snapshot']).out);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({localGateway:true,externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
