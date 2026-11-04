import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin='http://127.0.0.1:'+port,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-account-browser-')),out=path.join(ROOT,'acceptance/chat-logic-fixes/browser');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CHAT_RECOVERY_FIXTURE:'true',CHAT_LOGIC_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:'',CLOUD_FREE_MODELS:JSON.stringify(['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}))),DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
let serverLog='';app.stderr.on('data',chunk=>serverLog+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('账号 fixture 启动超时 '+serverLog)),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('WEEKLY_QUOTA_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('账号 fixture 退出 '+serverLog));});});
const browser=makeBrowser('chat-recovery-'+Date.now()),{ab,evalJson,evalRaw,waitFor}=browser,{check,results,failures}=makeChecker();
const click=selector=>{evalRaw(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center',behavior:'instant'});true`);ab(['click',selector]);};
const run=async code=>{evalRaw(`window.recoveryOperation=null;(async()=>{${code}})().then(value=>window.recoveryOperation={value}).catch(error=>window.recoveryOperation={error:error.message});true`);const result=await waitFor('恢复操作','JSON.stringify(window.recoveryOperation)',value=>value!==null);if(result.error)throw Error(result.error);return result.value;};
const body='.message.assistant .message-body';
const ready=()=>waitFor('聊天模型已加载','/^(platform|personal|chatgpt):/.test(document.getElementById("modelSelect")?.options[0]?.value || "")',Boolean);
const control=action=>run(`await fetch('/fixture-recovery/${action}');return true;`);
async function send(text){ab(['fill','#chatInput',text]);click('#sendBtn');await waitFor('首段回复',`document.querySelector('${body}')?.textContent`,text=>text?.includes('已保存的第一段。'));}
async function stored(){return run(`const session=await(await fetch('/api/auth/session')).json();return await new Promise((resolve,reject)=>{const r=indexedDB.open('diagramai.pureChat',1);r.onsuccess=()=>{const db=r.result,q=db.transaction('accounts').objectStore('accounts').get(session.user.id);q.onsuccess=()=>{db.close();resolve(q.result);};q.onerror=()=>reject(q.error);};r.onerror=()=>reject(r.error);});`);}
try{
 ab(['set','viewport','1280','1000']);ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername','alice']);ab(['fill','#loginPassword','fixture-password-123']);click('#loginBtn');await ready();ab(['select','#modelSelect','platform:mota/future-open-model']);
 ab(['fill','#chatInput','基线对话']);click('#sendBtn');await waitFor('初始回复',`document.querySelector('${body}')?.textContent`,text=>text?.includes('这是本地模拟回复。'));
 await waitFor('基线保存完成','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 ab(['tab','new','--label','stale',origin+'/chat.html']);await ready();ab(['tab','t1']);
 click('#newChatBtn');await send('恢复测试：另一个标签页新增的正文');await control('finish');
 await waitFor('A任务完成','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 const aId=(await stored()).flatMap(chat=>chat.messages).find(item=>item.taskId&&item.content.includes('完整回复结束。'))?.taskId;
 check('A完整正文保存后服务器清理',await run(`for(let i=0;i<40;i++){const r=await fetch('/api/conversation/tasks/${aId}');if(r.status===410)return true;await new Promise(r=>setTimeout(r,50));}return false;`));
 ab(['tab','stale']);click('#newChatBtn');ab(['fill','#chatInput','旧标签页发出的新问题']);click('#sendBtn');
 await waitFor('B任务完成','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 await waitFor('B回复正文',`document.querySelector('${body}')?.textContent`,text=>text?.includes('这是本地模拟回复。'));
 const merged=await stored();check('真实IndexedDB合并保留旧标签页缺失的新回复',merged.some(chat=>chat.messages.some(item=>item.taskId===aId&&item.content.includes('完整回复结束。')))&&merged.some(chat=>chat.title==='旧标签页发出的新问题'));
 ab(['reload']);await ready();await waitFor('A对话在历史中可见',`Array.from(document.querySelectorAll('.conversation-open')).map(n=>n.textContent)`,rows=>rows.includes('恢复测试：另一个标签页新增的正文'));
 click('[aria-label="删除对话：恢复测试：另一个标签页新增的正文"]');
 await waitFor('明确删除已提交',`Array.from(document.querySelectorAll('.conversation-open')).map(n=>n.textContent)`,rows=>!rows.includes('恢复测试：另一个标签页新增的正文'));
 ab(['tab','t1']);click('#newChatBtn');ab(['fill','#chatInput','旧页面再次保存']);click('#sendBtn');await waitFor('C任务完成','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 check('另一页的明确删除不会被旧快照复活',!(await stored()).some(chat=>chat.messages.some(item=>item.taskId===aId)));
 click('#newChatBtn');await send('恢复测试：模型目录不可用时恢复');await run(`await fetch('/fixture-logic/fail-models');return true;`);ab(['reload']);
 await waitFor('目录失败仍显示本地历史',`document.querySelector('${body}')?.textContent`,text=>text?.includes('已保存的第一段。'));
 await waitFor('目录失败仍恢复后台任务','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='取消生成');
 await fetch(origin+'/fixture-recovery/finish');await waitFor('目录失败仍收到最终结果',`document.querySelector('${body}')?.textContent`,text=>text?.includes('完整回复结束。'));
 await waitFor('目录失败任务正常收尾','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');check('模型目录故障不阻止历史显示及同任务恢复',true);
 await run(`await fetch('/fixture-logic/restore-models');return true;`);ab(['reload']);await ready();
 await run(`await fetch('/fixture-logic/delay-create');return true;`);click('#newChatBtn');ab(['fill','#chatInput','恢复测试：创建响应挂起后取消']);click('#sendBtn');
 await run(`for(let i=0;i<60;i++){if((await(await fetch('/fixture-stats')).json()).gatewayCalls===6)return true;await new Promise(r=>setTimeout(r,50));}throw Error('new task not accepted');`);
 click('#sendBtn');await waitFor('取消解除创建等待','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息',{timeout:10000});
 check('创建响应挂起时取消成功仍能解锁输入',evalJson(`!document.getElementById('chatInput').disabled&&document.getElementById('chatFeed').textContent.includes('已取消生成')`));
 check('多标签页、目录恢复和取消没有重复调用模型',(await run(`return(await(await fetch('/fixture-stats')).json()).gatewayCalls;`))===6);
 ab(['screenshot',path.join(out,'fixed-chat-desktop.png')]);

}catch(error){check('回复恢复浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);fs.writeFileSync(path.join(out,'failure.txt'),ab(['snapshot']).out);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({localGateway:true,externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
