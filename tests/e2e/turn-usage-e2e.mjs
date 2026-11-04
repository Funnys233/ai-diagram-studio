import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/turn-usage');fs.mkdirSync(out,{recursive:true});
const models=['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}));
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fs.mkdtempSync(path.join(os.tmpdir(),'diagram-turns-')),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CLOUD_FREE_MODELS:JSON.stringify(models),TURN_USAGE_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:'',DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('测试启动超时 '+log)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('测试服务退出 '+log));});});
const browser=makeBrowser('turn-usage-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
const run=async code=>{evalRaw(`window.turnOperation=null;(async()=>{${code}})().then(value=>window.turnOperation=value).catch(error=>window.turnOperation={error:error.message});true`);return waitFor('操作完成','JSON.stringify(window.turnOperation)',value=>value!==null,{timeout:20000});};
const ready=()=>waitFor('模型列表加载',`[...document.querySelectorAll('#modelSelect option')].some(option=>option.value==='platform:mota/future-open-model')`,Boolean);
const last=()=>evalJson(`JSON.stringify((()=>{const n=[...document.querySelectorAll('.message.assistant .turn-usage')].at(-1);return n?{text:n.firstChild.textContent,status:n.dataset.status,turnId:n.dataset.turnId}:null;})())`);
async function login(username){ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername',username]);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await ready();}
async function send(text){const count=evalJson(`document.querySelectorAll('.message.assistant').length`);ab(['fill','#chatInput',text]);ab(['click','#sendBtn']);await waitFor('本轮结算',`JSON.stringify({count:document.querySelectorAll('.message.assistant').length,label:document.getElementById('sendBtn').getAttribute('aria-label'),status:document.querySelector('.message.assistant:last-child .turn-usage')?.dataset.status})`,value=>value.count===count+1&&value.label==='发送消息'&&value.status==='settled');return last();}
try{
 ab(['set','viewport','1280','920']);await login('admin');ab(['select','#modelSelect','platform:mota/future-open-model']);
 let receipt=await send('普通费用测试');check('纯对话回复下显示本轮实际0.6点',receipt.text==='本轮消耗：0.6 点');
 const exact=await run(`return(await(await fetch('/api/usage/turns/${receipt.turnId}')).json()).turnUsage;`);check('页面回执来自后台该轮，包含恰好一次调用',exact.weeklyPoints===.6&&exact.calls===1&&exact.status==='settled');
 ab(['open',origin+'/chat.html']);await ready();await waitFor('历史扣点恢复',`document.querySelector('.message.assistant .turn-usage')?.firstChild.textContent`,text=>text==='本轮消耗：0.6 点');check('刷新后保留本轮扣点',last().turnId===receipt.turnId);
 receipt=await send('费用限流');check('上游429限流显示未消耗额度',receipt.text==='本轮未消耗额度'&&evalJson(`document.getElementById('chatFeed').textContent.includes('HTTP 429')`));
 const rejected=await run(`return(await(await fetch('/api/usage/turns/${receipt.turnId}')).json()).turnUsage;`);check('限流回执释放预留且不再标注估算',rejected.weeklyPoints===0&&rejected.reservedPoints===0&&!rejected.estimated&&rejected.calls===1);
 ab(['screenshot',path.join(out,'rate-limit.png')]);
 ab(['open',origin+'/chat.html']);await ready();await waitFor('限流回执刷新恢复',`document.querySelector('.message.assistant:last-child .turn-usage')?.firstChild.textContent`,text=>text==='本轮未消耗额度');check('刷新后限流回执仍为零消耗',last().turnId===receipt.turnId);
 receipt=await send('费用失败');check('失败回复仍显示实际已用0.6点',receipt.text==='本轮消耗：0.6 点'&&evalJson(`document.getElementById('chatFeed').textContent.includes('发送失败')`));
 ab(['fill','#chatInput','费用取消']);ab(['click','#sendBtn']);await waitFor('部分回复可取消',`document.getElementById('chatFeed').textContent.includes('开始回答')`,Boolean);ab(['click','#sendBtn']);
 await waitFor('取消后扣点结算',`document.querySelector('.message.assistant:last-child .turn-usage')?.textContent`,text=>text?.includes('2 点（含估算）'));
 check('取消后显示2点估算且不是零消耗',last().status==='settled');
 ab(['select','#modelSelect','platform:mota/Qwen/Qwen3.8-27B']);receipt=await send('免费费用测试');check('免费模型单轮仅显示占用1次',receipt.text==='本轮消耗：免费额度 1 次');
 check('最新回复扣点自动滚入可见区域',evalJson(`document.querySelector('.message.assistant:last-child .turn-usage').getBoundingClientRect().bottom<=document.getElementById('chatFeed').getBoundingClientRect().bottom`));
 ab(['screenshot',path.join(out,'chat-desktop.png')]);ab(['set','viewport','320','760']);await waitFor('手机侧栏收起',`document.getElementById('historyRail').getBoundingClientRect().right`,right=>right<=0);
 check('320px回复下扣点不溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth&&[...document.querySelectorAll('.turn-usage')].every(n=>n.getBoundingClientRect().right<=innerWidth)`));ab(['screenshot',path.join(out,'chat-320.png')]);
 ab(['set','viewport','1280','920']);ab(['open',origin+'/?test=1']);await waitFor('绘图页就绪',`Boolean(window.__DIAGRAM_AI_TEST__?.state.ready)`,Boolean);
 const drawn=await run(`window.__DIAGRAM_AI_TEST__.setModelSelection({providerId:'platform:mota',modelId:'future-open-model'});return await window.__DIAGRAM_AI_TEST__.sendMessage('画图费用重试');`);
 check('绘图请求经真实页面完成',drawn.ok===true,JSON.stringify(drawn));
 await waitFor('绘图本轮合并扣点',`document.querySelector('.msg.assistant:last-child .turn-usage')?.textContent`,text=>text?.includes('1.2 点')&&text.includes('共 2 次调用'));
 check('绘图自动重试合计显示1.2点和两次调用',evalJson(`document.querySelector('.msg.assistant:last-child .turn-usage').dataset.status==='settled'`));
 const saved=await run(`await window.__DIAGRAM_AI_TEST__.flushSession();return window.__DIAGRAM_AI_TEST__.captureSession().messages.at(-1).turnUsage;`);
 check('绘图持久会话保存回执而不混入回复正文',saved.weeklyPoints===1.2&&saved.calls===2);ab(['screenshot',path.join(out,'diagram-desktop.png')]);
 ab(['open',origin+'/?test=1']);await waitFor('绘图历史扣点恢复',`[...document.querySelectorAll('.msg.assistant .turn-usage')].some(n=>n.textContent.includes('1.2 点'))`,Boolean);check('绘图刷新后仍保留合并扣点',true);
 await run(`const session=await(await fetch('/api/auth/session')).json();await fetch('/api/users/'+session.user.id+'/weekly-limit',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf},body:JSON.stringify({limitPoints:1})});return true;`);
 ab(['open',origin+'/chat.html']);await ready();ab(['select','#modelSelect','platform:mota/future-open-model']);receipt=await send('额度不足测试');check('调用前拦截显示本轮未消耗额度',receipt.text==='本轮未消耗额度');
 await run(`const session=await(await fetch('/api/auth/session')).json();await fetch('/api/auth/logout',{method:'POST',headers:{'X-CSRF-Token':session.csrf}});return true;`);await login('alice');ab(['select','#modelSelect','personal:mine/my-model']);receipt=await send('个人费用测试');check('个人API显示仅统计，不误报点数',receipt.text==='本轮消耗：个人 API，仅统计');
}catch(error){check('本轮用量浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);fs.writeFileSync(path.join(out,'failure.txt'),ab(['snapshot']).out);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({localGateway:true,externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
