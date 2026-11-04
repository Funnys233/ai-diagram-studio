// Isolated cloud account and local editor fixture; no production credentials or AI calls.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {ROOT,startServer,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-navigation-'));
const out=path.join(ROOT,'acceptance/navigation');fs.mkdirSync(out,{recursive:true});
const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><body style="font:14px sans-serif;color:#788278;padding:20px">画布测试区域<script>const send=m=>parent.postMessage(JSON.stringify(m),'*');addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return}if(m.action==='load')send({event:'load',xml:m.xml});if(m.action==='getDiff')send({event:'getDiff',xml:'',message:m});});send({event:'init'});</script>`);});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:8285';
const app=await startServer({port:8285,env:{APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:path.join(dir,'data'),CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',DRAWIO_EMBED_URL:`http://127.0.0.1:${fixture.address().port}/`}});
const b=makeBrowser('navigation-'+Date.now()),{check,results,failures}=makeChecker();
const ab=args=>b.ab(args,{timeout:45000});
try{
 ab(['set','viewport','1440','900']);ab(['open',origin+'/login.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);
 await b.waitFor('工作台就绪','window.DiagramCloud?.user?.username',v=>v==='admin');
 check('顶部五类入口，模型设置已移到顶部',b.evalJson(`document.querySelectorAll('#workspaceNav > .nav-menu, #workspaceNav > button').length===5&&!!document.querySelector('#workspaceNav #modelSettingsBtn')&&!document.querySelector('.model-bar #modelSettingsBtn')`));
 check('每项原有操作只有一个入口',b.evalJson(`['newDiagramBtn','importDiagramBtn','recoverSessionBtn','undoBtn','exportPngBtn','downloadBtn','modelSettingsBtn'].every(id=>document.querySelectorAll('#'+id).length===1)`));
 ab(['click','#fileMenu > summary']);check('文件菜单可见且操作分组正确',b.evalJson(`document.getElementById('fileMenu').open&&document.querySelector('#fileMenu #importDiagramBtn').getBoundingClientRect().height>0`));
 ab(['click','#historyMenu > summary']);check('切换菜单自动收起上一组',b.evalJson(`!document.getElementById('fileMenu').open&&document.getElementById('historyMenu').open`));
 ab(['click','#recoverSessionBtn']);check('恢复会话入口正常并收起菜单',b.evalJson(`!document.getElementById('recoveryDialog').classList.contains('hidden')&&!document.getElementById('historyMenu').open`));ab(['click','#closeRecoveryBtn']);
 ab(['click','#exportMenu > summary']);ab(['press','Escape']);check('Escape 收起菜单并恢复键盘焦点',b.evalJson(`!document.getElementById('exportMenu').open&&document.activeElement===document.querySelector('#exportMenu > summary')`));
 ab(['click','#fileMenu > summary']);ab(['click','#modelSettingsBtn']);check('顶部模型入口打开设置抽屉并收起菜单',b.evalJson(`!document.getElementById('drawerOverlay').classList.contains('hidden')&&!document.getElementById('fileMenu').open`));ab(['click','#drawerCloseBtn']);
 ab(['click','#cloudAccountSummary']);check('账号菜单保留用量、密码和管理员管理',b.evalJson(`document.getElementById('cloudAccount').open&&!!document.getElementById('cloudPasswordForm')&&!!document.getElementById('cloudInviteForm')`));
 ab(['click','#fileMenu > summary']);check('动态账号菜单参与互斥展开',b.evalJson(`!document.getElementById('cloudAccount').open&&document.getElementById('fileMenu').open`));
 ab(['screenshot',out+'/desktop-file.png']);ab(['press','Escape']);ab(['screenshot',out+'/desktop.png']);
 for(const width of [768,390,320]){
  ab(['set','viewport',String(width),'844']);ab(['click','#exportMenu > summary']);
  check(width+'px 下导航和菜单均在视口内',b.evalJson(`(()=>{const r=document.querySelector('#exportMenu .nav-popover').getBoundingClientRect();const n=document.getElementById('workspaceNav').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&n.left>=0&&n.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth})()`));
  if(width===390)ab(['screenshot',out+'/mobile-export.png']);ab(['press','Escape']);
 }
 ab(['set','viewport','390','844']);ab(['click','#cloudAccountSummary']);ab(['click','#cloudPasswordSection > summary']);
 check('窄屏账号和密码表单可滚动且在视口内',b.evalJson(`(()=>{const r=document.querySelector('.cloud-account-panel').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&document.getElementById('cloudNewPassword').minLength===8})()`));
 ab(['screenshot',out+'/mobile-account.png']);console.log('Logout page state: '+JSON.stringify(b.evalJson('({url:location.href,title:document.title,logoutPresent:!!document.getElementById("cloudLogoutBtn")})')));b.evalRaw(`document.getElementById('cloudLogoutBtn').scrollIntoView({block:'nearest'});true`);b.ab(['click','#cloudLogoutBtn'],{allowFail:true,timeout:15000});await b.waitFor('退出登录','location.pathname',v=>v==='/login.html');check('账号退出登录正常',true);
}catch(e){check('导航浏览器验收',false,e.stack);try{ab(['screenshot',out+'/failure.png']);}catch{}}
finally{fs.writeFileSync(out+'/results.json',JSON.stringify({realModelCalls:0,results},null,2));b.ab(['close'],{allowFail:true,timeout:15000});app.stop();fixture.close();}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;else fs.rmSync(path.join(out,'failure.png'),{force:true});
