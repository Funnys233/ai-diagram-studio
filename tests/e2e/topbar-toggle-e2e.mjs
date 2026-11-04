import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
const origin=`http://127.0.0.1:${port}`,directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-topbar-'));
const out=path.join(ROOT,'acceptance/focus-toggle/browser');fs.mkdirSync(out,{recursive:true});
const app=spawn(process.execPath,['tests/helpers/reasoning-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:directory,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',PORT:String(port),DEEPSEEK_API_KEY:'',DRAWIO_EMBED_URL:origin+'/fixture-editor'},stdio:['ignore','pipe','pipe']});
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Topbar fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('REASONING_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error('Topbar fixture exited'));});});

const {ab,evalJson,evalRaw,waitFor}=makeBrowser('topbar-toggle-'+Date.now()),{check,results,failures}=makeChecker();
const click=selector=>ab(['click',selector]);
try{
 ab(['set','viewport','1280','920']);ab(['open',origin+'/login.html?next=%2Fchat.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);
 await waitFor('登录完成','/^platform:/.test(document.getElementById("modelSelect")?.value||"")',Boolean);
 ab(['open',origin+'/?test=1']);await waitFor('绘图工作台可用','window.__DIAGRAM_AI_TEST__?.state.ready&&!window.__DIAGRAM_AI_TEST__?.state.sessionBusy',Boolean);
 const drawingHeight=evalJson('document.querySelector(".workspace").getBoundingClientRect().height');
 const drawingWidth=evalJson('document.querySelector(".editor-frame-wrap").getBoundingClientRect().width');
 const canvas=evalJson('window.__DIAGRAM_AI_TEST__.state.currentFile');
 ab(['fill','#chatInput','保留我的绘图草稿']);click('#fileMenu > summary');click('#cloudAccountSummary');click('#topbarToggle');
 check('收起菜单并释放画布空间',evalJson(`getComputedStyle(document.querySelector('.topbar')).display==='none'&&document.querySelector('.workspace').getBoundingClientRect().height>${drawingHeight}+30&&document.querySelector('#topbarToggle').getAttribute('aria-expanded')==='false'&&!document.querySelector('#fileMenu').open&&!document.querySelector('#cloudAccount').open`));
 check('合并为一个按钮并同时隐藏AI面板',evalJson(`!document.querySelector('#toggleAiPaneBtn')&&document.querySelector('#aiPane').hidden&&document.querySelector('.editor-frame-wrap').getBoundingClientRect().width>${drawingWidth}+250&&document.querySelector('#topbarToggle').getAttribute('aria-controls').includes('aiPane')`));
 check('收起不影响图表和对话',evalJson('window.__DIAGRAM_AI_TEST__.state.currentFile')===canvas&&evalJson('document.querySelector("#chatInput")!==null'));
 ab(['screenshot',path.join(out,'drawing-collapsed.png')]);
 ab(['reload']);await waitFor('按钮恢复','!!document.getElementById("topbarToggle")',Boolean);
 check('刷新后菜单和AI面板一起保持隐藏',evalJson(`getComputedStyle(document.querySelector('.topbar')).display==='none'&&document.querySelector('#aiPane').hidden`));
 await waitFor('草稿恢复','document.getElementById("chatInput")?.value',value=>value==='保留我的绘图草稿');click('#topbarToggle');check('一键恢复菜单、AI面板及草稿',evalJson(`getComputedStyle(document.querySelector('.topbar')).display!=='none'&&!document.querySelector('#aiPane').hidden&&document.querySelector('#chatInput').value==='保留我的绘图草稿'`));click('#topbarToggle');
 ab(['open',origin+'/chat.html']);await waitFor('对话模型可用','/^platform:/.test(document.getElementById("modelSelect")?.value||"")',Boolean);
 check('对话页共用收起设置并使用全部高度',evalJson(`getComputedStyle(document.querySelector('.chat-topbar')).display==='none'&&Math.abs(document.querySelector('.chat-layout').getBoundingClientRect().height-innerHeight)<2&&document.querySelector('.composer').getBoundingClientRect().bottom<=innerHeight`));
 click('#topbarToggle');check('可展开并恢复菜单',evalJson(`getComputedStyle(document.querySelector('.chat-topbar')).display!=='none'&&document.querySelector('#topbarToggle').getAttribute('aria-label')==='收起顶部菜单'`));
 ab(['set','viewport','390','844']);await waitFor('手机侧栏收起完成',"document.querySelector('.history-rail').getBoundingClientRect().right",value=>value<=0);click('#topbarToggle');click('#historyToggle');await waitFor('手机侧栏展开完成',"document.querySelector('.history-rail').getBoundingClientRect().left",value=>Math.abs(value)<1);
 check('手机隐藏菜单后侧栏和遮罩从顶部开始',evalJson(`document.querySelector('.history-rail').getBoundingClientRect().top===0&&document.querySelector('.mobile-scrim').getBoundingClientRect().top===0`));
 ab(['mouse','move','370','400']);ab(['mouse','down','left']);ab(['mouse','up','left']);await waitFor('遮罩关闭侧栏',"!document.body.classList.contains('history-open')",Boolean);await waitFor('侧栏关闭动画完成',"document.querySelector('.history-rail').getBoundingClientRect().right",value=>value<=0);ab(['screenshot',path.join(out,'chat-mobile-collapsed.png')]);
 click('#topbarToggle');ab(['open',origin+'/?test=1']);await waitFor('绘图重载','window.__DIAGRAM_AI_TEST__?.state.ready&&!window.__DIAGRAM_AI_TEST__?.state.sessionBusy',Boolean);
 check('跨页面保持展开且按钮不挡账号入口',evalJson(`(()=>{const b=document.querySelector('#topbarToggle').getBoundingClientRect(),nav=document.querySelector('#workspaceNav').getBoundingClientRect();return getComputedStyle(document.querySelector('.topbar')).display!=='none'&&nav.right<=b.left-4;})()`));
 ab(['screenshot',path.join(out,'drawing-mobile-expanded.png')]);click('#topbarToggle');
 check('手机一键隐藏两处并保留恢复按钮',evalJson(`(()=>{const b=document.querySelector('#topbarToggle').getBoundingClientRect(),frame=document.querySelector('.editor-frame-wrap').getBoundingClientRect();return b.right<=innerWidth&&b.top>=0&&document.querySelector('#topbarToggle').contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2))&&document.querySelector('#aiPane').hidden&&frame.height>innerHeight*.7;})()`));ab(['screenshot',path.join(out,'drawing-mobile-focus.png')]);click('#topbarToggle');check('手机恢复后输入框重新可见',evalJson(`!document.querySelector('#aiPane').hidden&&document.querySelector('#chatInput').getBoundingClientRect().height>0`));
 evalRaw(`window.toggleUsage=null;fetch('/api/usage').then(r=>r.json()).then(data=>window.toggleUsage=data.usage.userCalls);true`);await waitFor('用量核对','window.toggleUsage',value=>value!==null);check('切换不调用模型或扣点',evalJson('window.toggleUsage')===0);
}catch(error){check('顶部菜单浏览器流程',false,error.stack);console.log(evalJson(`({open:document.body.className,scrollX,rail:document.querySelector('.history-rail')?.getBoundingClientRect().toJSON(),toggle:document.querySelector('#historyToggle')?.getBoundingClientRect().toJSON(),transform:document.querySelector('.history-rail')&&getComputedStyle(document.querySelector('.history-rail')).transform})`));try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));ab(['close'],{allowFail:true});app.kill('SIGTERM');
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
