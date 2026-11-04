import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const origin='http://127.0.0.1:'+port,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-account-browser-')),out=path.join(ROOT,'acceptance/server-conversation-tasks/browser');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/weekly-quota-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_CHATGPT_OWNER:'admin',CHAT_RECOVERY_FIXTURE:'true',PORT:String(port),DEEPSEEK_API_KEY:'',CLOUD_FREE_MODELS:JSON.stringify(['deepseek-ai/DeepSeek-V4.1-Flash','Qwen/Qwen3.8-27B','Qwen/Qwen3.8-Flash-Next'].map(modelId=>({providerId:'mota',modelId}))),DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
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
 await send('恢复测试：切换会话');
 await waitFor('首段已落盘',`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('diagramai.pureChat.v1.reply.'))) || 'null')?.item?.content`,text=>text?.includes('已保存的第一段。'));
 check('流式生成时正文进入历史数据', (await stored()).flatMap(chat=>chat.messages).some(item=>item.role==='assistant'&&item.pending&&item.content.includes('已保存的第一段。')));
 click('#newChatBtn');click('.conversation-open');check('生成期间切走再切回仍显示已收到正文',evalJson(`document.querySelector('${body}').textContent.includes('已保存的第一段。')&&!!document.querySelector('.assistant-progress')`));
 await control('chunk');await waitFor('回到会话继续显示新内容',`document.querySelector('${body}').textContent`,text=>text.includes('切换后仍继续显示。'));check('后续片段写入当前界面而非旧节点',true);
 await control('finish');await waitFor('本轮完成','document.getElementById("sendBtn").getAttribute("aria-label")',text=>text==='发送消息');await waitFor('结算费用','document.getElementById("chatFeed").textContent',text=>text.includes('本轮消耗：0.3 点'));check('切换后最终正文、来源和费用齐全',evalJson(`document.querySelector('${body}').textContent.includes('完整回复结束。')&&!!document.querySelector('.message-source')`));
 ab(['open',origin+'/chat.html']);await ready();check('完成后刷新保留完整正文与费用',evalJson(`document.querySelector('${body}').textContent.includes('完整回复结束。')&&document.getElementById('chatFeed').textContent.includes('本轮消耗：0.3 点')`));
 click('#newChatBtn');await send('恢复测试：刷新不中止');
 ab(['reload']);await ready();await waitFor('刷新后重新订阅','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='取消生成');
 check('刷新后保留首段并继续同一个任务',evalJson(`document.querySelector('${body}').textContent.includes('已保存的第一段。')&&!document.querySelector('.message-error')`));
 await control('chunk');await waitFor('刷新后新片段',`document.querySelector('${body}').textContent`,text=>text.includes('切换后仍继续显示。'));
 await control('finish');await waitFor('刷新恢复任务完成','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 check('刷新后完整回复只结算一次',(await run(`return(await(await fetch('/fixture-stats')).json()).gatewayCalls;`))===2);
 click('#newChatBtn');ab(['fill','#chatInput','恢复测试：等待首字，离开后完成']);click('#sendBtn');
 await waitFor('首字前任务被服务器接受',`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('diagramai.pureChat.v1.reply.'))) || 'null')?.item?.taskAccepted`,Boolean);
 const waitingId=(await stored()).flatMap(chat=>chat.messages).find(item=>item.taskId&&item.pending)?.taskId;
 ab(['open','about:blank']);await fetch(origin+'/fixture-recovery/finish');ab(['open',origin+'/chat.html']);await ready();
 await waitFor('离开页面后完成的正文恢复',`document.querySelector('${body}')?.textContent`,text=>text?.includes('完整回复结束。'));
 await waitFor('恢复后保存完毕','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 check('首字前离开，服务器独立完成，回来取回正文',(await run(`return(await(await fetch('/fixture-stats')).json()).gatewayCalls;`))===3);
 const released=await run(`for(let i=0;i<40;i++){const r=await fetch('/api/conversation/tasks/${waitingId}');if(r.status===410)return true;await new Promise(r=>setTimeout(r,50));}return false;`);
 check('浏览器确认保存后清理服务器临时正文',released);
 click('#newChatBtn');await send('恢复测试：主动取消');click('#sendBtn');
 await waitFor('主动取消结束','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 check('点击取消才停止服务器任务且保留部分内容',evalJson(`document.querySelector('${body}').textContent.includes('已保存的第一段。')&&document.getElementById('chatFeed').textContent.includes('已取消生成')`));
 click('#newChatBtn');await send('恢复测试：浏览器保存失败');
 const unsavedId=(await stored()).flatMap(chat=>chat.messages).find(item=>item.taskId&&item.pending)?.taskId;
 evalRaw(`window.normalTransaction=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(store,mode,...rest){if(mode==='readwrite')throw Error('fixture storage unavailable');return window.normalTransaction.call(this,store,mode,...rest);};true`);
 await control('finish');await waitFor('保存失败后完成','document.getElementById("sendBtn").getAttribute("aria-label")',value=>value==='发送消息');
 check('浏览器保存失败时服务器保留可取回正文',await run(`const r=await fetch('/api/conversation/tasks/${unsavedId}');const d=await r.json();return r.status===200&&d.task.reply.includes('完整回复结束。');`));
 ab(['reload']);await ready();await waitFor('恢复暂存结果',`document.querySelector('${body}')?.textContent`,text=>text?.includes('完整回复结束。'));
 ab(['set','viewport','320','844']);await waitFor('手机历史栏收起','document.getElementById("historyRail").getBoundingClientRect().right',right=>right<=0);check('手机回复不撑宽页面',evalJson('document.documentElement.scrollWidth<=innerWidth'));ab(['screenshot',path.join(out,'server-recovered-320.png')]);
 check('刷新、返回和恢复没有额外模型调用',(await run(`return(await(await fetch('/fixture-stats')).json()).gatewayCalls;`))===5);

}catch(error){check('回复恢复浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);fs.writeFileSync(path.join(out,'failure.txt'),ab(['snapshot']).out);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({localGateway:true,externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
