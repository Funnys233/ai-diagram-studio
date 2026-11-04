import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {ROOT,makeBrowser,makeChecker} from './lib/browser-harness.mjs';
const require=createRequire(import.meta.url),File=require('../../lib/drawio-format');
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin=`http://127.0.0.1:${port}`,out=path.join(ROOT,'acceptance/requirements');fs.mkdirSync(out,{recursive:true});
const fixtureDir=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-requirements-browser-'));
const docPath=path.join(fixtureDir,'图书借阅需求.txt');fs.writeFileSync(docPath,'校园图书借阅系统需求：读者检索图书，有库存时办理借阅，无库存时登记预约。系统包含读者端、图书检索、借阅服务和图书与借阅数据库。借阅期限尚未确认。');
const app=spawn(process.execPath,['tests/helpers/requirements-browser-fixture.cjs'],{cwd:ROOT,env:{...process.env,APP_MODE:'cloud',PUBLIC_ORIGIN:origin,CLOUD_ALLOW_HTTP_LOOPBACK:'true',CLOUD_DATA_DIR:fixtureDir,CLOUD_MASTER_KEY:crypto.randomBytes(32).toString('base64'),CLOUD_ADMIN_USERNAME:'admin',CLOUD_ADMIN_PASSWORD:'fixture-password-123',CLOUD_FREE_MODELS:JSON.stringify([{providerId:'workflow',modelId:'requirements-fixture'}]),DRAWIO_EMBED_URL:origin+'/fixture-editor',PORT:String(port),DEEPSEEK_API_KEY:''},stdio:['ignore','pipe','pipe']});
let log='';app.stderr.on('data',chunk=>log+=chunk);
await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'Fixture timeout')),15000);app.stdout.on('data',chunk=>{if(chunk.toString().includes('REQUIREMENTS_FIXTURE_READY')){clearTimeout(timer);resolve();}});app.once('exit',()=>{clearTimeout(timer);reject(Error(log||'Fixture exited'));});});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser('requirements-'+Date.now()),{check,results,failures}=makeChecker();
async function run(code){evalRaw(`window.requirementsOp=null;(async()=>{${code}})().then(value=>window.requirementsOp={value}).catch(error=>window.requirementsOp={error:error.message});true`);const result=await waitFor('页面操作完成','JSON.stringify(window.requirementsOp)',v=>v!==null);if(result.error)throw Error(result.error);return result.value;}
const stats=()=>run(`return await(await fetch('/fixture-stats')).json();`);
async function handleDialog(action){for(let i=0;i<30;i++){const shown=ab(['dialog','status']).out;if(/confirm|替换当前图表|新任务/i.test(shown)){ab(['dialog',action]);return;}await new Promise(r=>setTimeout(r,100));}throw Error('覆盖确认没有出现');}
async function newTask(action){evalRaw(`setTimeout(()=>document.getElementById('newTaskBtn').click(),100);true`);await handleDialog(action);}
const visible=id=>evalJson(`document.getElementById(${JSON.stringify(id)})?.hidden===false`);
async function waitStage(id){await waitFor(id,`document.getElementById(${JSON.stringify(id)})?.hidden`,v=>v===false);}
async function analyze(){ab(['click','#analyzeBtn']);await waitStage('confirmStep');}
async function login(){ab(['open',origin+'/login.html?next=%2Frequirements.html']);ab(['fill','#loginUsername','admin']);ab(['fill','#loginPassword','fixture-password-123']);ab(['click','#loginBtn']);await waitFor('返回文档成图页面',`location.pathname`,v=>v==='/requirements.html');await waitFor('需求模型加载',`document.querySelector('#modelSelect option')?.value`,v=>v?.includes('requirements-fixture'));}
const imageReady=`[...document.querySelectorAll('.diagram-preview')].length===2&&[...document.querySelectorAll('.diagram-preview')].every(img=>img.complete&&img.naturalWidth>0)`;
try{
 ab(['set','viewport','1280','920']);await login();
 await waitFor('源输入可操作',`!document.getElementById('analyzeBtn').disabled&&document.querySelector('.requirements-main').getAttribute('aria-busy')==='false'`,Boolean);ab(['focus','#analyzeBtn']);ab(['press','Enter']);await waitFor('空白输入提示',`document.getElementById('operationError').textContent`,v=>v?.includes('请先'));check('空白需求明确拦截且不发起模型调用',evalJson(`document.getElementById('operationError').textContent.includes('请先')`)&&(await stats()).gatewayCalls===0);
 ab(['upload','#requirementsFiles',docPath]);await waitFor('文件提取完成',`document.getElementById('analyzeBtn').disabled`,v=>v===false);
 check('复用文档上传，提取文字尚不调用模型',evalJson(`document.getElementById('sourceStep').textContent.includes('图书借阅需求.txt')`)&&(await stats()).gatewayCalls===0);
 ab(['fill','#requirementsText','请按学校图书馆的项目文档整理，确认借阅和预约两条分支。']);await analyze();
 let snapshot=await stats();check('一次分析调用接收真实文档上下文',snapshot.gatewayCalls===1&&snapshot.lastRequestHasDocument);
 check('先确认结构与明确待确认事项',evalJson(`document.getElementById('outlineTitle').value==='校园图书借阅系统'&&[...document.querySelectorAll('#assumptionsList input,#assumptionsList textarea')].some(e=>e.value.includes('借阅期限'))&&document.querySelectorAll('[data-edit="flow-node-label"]').length===6`));
 ab(['fill','[data-edit="flow-node-label"][data-id="borrow"]','确认借阅 & 登记']);ab(['fill','#outlineTitle','校园借阅管理']);
 check('两种图表默认选择且可分别操作',evalJson(`document.getElementById('diagramFlowchart').checked&&document.getElementById('diagramArchitecture').checked`));
 ab(['screenshot',path.join(out,'confirm-desktop.png')]);
 ab(['click','#generateBtn']);await waitStage('resultStep');await waitFor('实际SVG图表加载',imageReady,Boolean);
 check('确认后生成两种图表，无第二次模型调用',evalJson(`document.querySelectorAll('.diagram-card').length===2`)&&(await stats()).gatewayCalls===1);
 const images=await run(`return await Promise.all([...document.querySelectorAll('.diagram-preview')].map(async img=>{const text=await(await fetch(img.src)).text();const doc=new DOMParser().parseFromString(text,'image/svg+xml');return{type:img.closest('[data-type]').dataset.type,content:doc.documentElement.textContent,valid:doc.documentElement.localName==='svg'&&!doc.querySelector('parsererror,script,foreignObject'),width:img.naturalWidth};}));`);
 check('SVG真实渲染且采用确认后的中文标签',images.every(x=>x.valid&&x.width>100)&&images.some(x=>x.type==='flowchart'&&x.content.includes('确认借阅 & 登记')));
 const usage=await run(`return (await(await fetch('/api/usage')).json()).usage;`);check('分析回执与实际免费用量一致，编译不另扣',usage.free.calls===1&&evalJson(`document.getElementById('usageReceipt').textContent.includes('1')`));
 ab(['screenshot',path.join(out,'results-desktop.png')]);
 const drawio=path.join(out,'requirements.drawio');ab(['download','#downloadAllBtn',drawio]);const payload=fs.readFileSync(drawio,'utf8'),info=File.parseFile(payload);
 check('真实下载完整两页drawio，保留确认后的内容',info.kind==='mxfile'&&info.pageCount===2&&payload.includes('确认借阅 &amp; 登记'));
 const png=path.join(out,'flowchart.png');ab(['download','[data-action="download-png"][data-type="flowchart"]',png]);const bytes=fs.readFileSync(png);
 check('PNG真实导出且画布尺寸有效',bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&bytes.readUInt32BE(16)>100&&bytes.readUInt32BE(20)>100&&bytes.length>1000);
 ab(['reload']);await waitStage('resultStep');await waitFor('刷新恢复预览',imageReady,Boolean);check('刷新恢复生成结果且不重发分析',(await stats()).gatewayCalls===1);
 ab(['click','#backToConfirmBtn']);await waitStage('confirmStep');check('返回结构保留已确认修改',evalJson(`document.querySelector('[data-edit="flow-node-label"][data-id="borrow"]').value==='确认借阅 & 登记'`));
 ab(['uncheck','#diagramArchitecture']);ab(['click','#generateBtn']);await waitStage('resultStep');await waitFor('单图结果',`document.querySelectorAll('.diagram-card').length`,v=>v===1);check('只生成流程图仍然零额外模型调用',(await stats()).gatewayCalls===1);
 ab(['click','#backToConfirmBtn']);ab(['check','#diagramArchitecture']);ab(['click','#generateBtn']);await waitStage('resultStep');await waitFor('恢复两图',imageReady,Boolean);
 ab(['set','viewport','390','844']);check('390px手机结果不横向溢出',evalJson(`document.documentElement.scrollWidth<=innerWidth`));ab(['screenshot',path.join(out,'results-mobile.png')]);
 ab(['set','viewport','320','700']);check('320px窄屏仍可查看结果和导出',evalJson(`document.documentElement.scrollWidth<=innerWidth&&document.getElementById('downloadAllBtn').getBoundingClientRect().width>0`));
 ab(['set','viewport','1280','920']);ab(['click','#openEditorBtn']);await waitFor('进入绘图工作台',`location.pathname==='/'&&new URLSearchParams(location.search).has('requirements')`,Boolean);
 await waitFor('导入前明确确认',`document.getElementById('requirementsHandoffBanner')?.checkVisibility()`,v=>v===true);check('打开编辑器先显示导入提示，尚未消费交接数据',evalJson(`!!sessionStorage.getItem('diagramai.requirements.handoff')`));
 // Test mode only exposes existing editor assertions, not an import bypass.
 ab(['open',origin+'/?requirements=1&test=1']);await waitFor('编辑器就绪',`window.__DIAGRAM_AI_TEST__?.state.ready`,Boolean);
 await waitFor('导入按钮就绪',`document.getElementById('requirementsHandoffOpenBtn')?.disabled`,v=>v===false);
 ab(['fill','#chatInput','保留这份已有草稿']);ab(['click','#requirementsHandoffOpenBtn']);await handleDialog('dismiss');await waitFor('取消覆盖后可重试',`document.getElementById('requirementsHandoffOpenBtn').disabled`,v=>v===false);
 check('取消覆盖确认保留原草稿和待导入图表',evalJson(`document.getElementById('chatInput').value==='保留这份已有草稿'&&window.__DIAGRAM_AI_TEST__.state.pageCount===1&&!!sessionStorage.getItem('diagramai.requirements.handoff')`));
 ab(['click','#requirementsHandoffOpenBtn']);await handleDialog('accept');
 await waitFor('两页图表导入工作台',`window.__DIAGRAM_AI_TEST__?.state.pageCount`,v=>v===2);check('完整两页导入复用已有编辑器与会话保存',evalJson(`window.__DIAGRAM_AI_TEST__.state.payload.includes('确认借阅 &amp; 登记')&&!sessionStorage.getItem('diagramai.requirements.handoff')`));
 ab(['open',origin+'/requirements.html']);await waitStage('resultStep');ab(['click','#backToConfirmBtn']);ab(['click','#backToSourceBtn']);await waitStage('sourceStep');
 ab(['fill','#requirementsText','测试分析失败后重试，保留原始需求文字。']);await run(`await fetch('/fixture-mode?value=reject');return true;`);ab(['click','#analyzeBtn']);await waitFor('错误提示',`document.getElementById('operationError')?.textContent`,v=>v?.includes('模型暂时不可用'));
 check('模型失败明确提示且保留需求，可再次发起',evalJson(`document.getElementById('requirementsText').value.includes('保留原始需求')&&!document.getElementById('analyzeBtn').disabled`));
 await analyze();check('用户明确重试后成功，失败未自动重试',(await stats()).gatewayCalls===3);
 ab(['click','#backToSourceBtn']);await waitStage('sourceStep');await run(`await fetch('/fixture-mode?value=hang');return true;`);ab(['click','#analyzeBtn']);await waitFor('取消按钮可用',`document.getElementById('cancelOperationBtn').hidden`,v=>v===false);await run(`for(let i=0;i<100;i++){const value=await(await fetch('/fixture-stats')).json();if(value.gatewayCalls===4)return value;await new Promise(r=>setTimeout(r,25));}throw Error('上游尚未开始挂起请求');`);ab(['click','#cancelOperationBtn']);await waitFor('取消后恢复操作',`document.getElementById('analyzeBtn').disabled`,v=>v===false);
 const cancelled=await run(`for(let i=0;i<30;i++){const value=await(await fetch('/fixture-stats')).json();if(value.cancelledCalls)return value;await new Promise(r=>setTimeout(r,50));}return await(await fetch('/fixture-stats')).json();`);check('取消分析不伪造成功，保持源输入',visible('sourceStep')&&cancelled.gatewayCalls===4&&cancelled.cancelledCalls===1&&evalJson(`document.getElementById('requirementsText').value.includes('保留原始需求')`));
 await run(`await fetch('/fixture-mode?value=hang');return true;`);ab(['click','#analyzeBtn']);await run(`for(let i=0;i<100;i++){const value=await(await fetch('/fixture-stats')).json();if(value.gatewayCalls===5)return value;await new Promise(r=>setTimeout(r,25));}throw Error('刷新场景未发起请求');`);
 const pendingSaved=await run(`const session=await(await fetch('/api/auth/session')).json();const key='diagramai.requirements.v1.'+session.user.id;return{key,saved:JSON.parse(localStorage.getItem(key))};`);check('发起前保存本轮回执标识，刷新也能追踪消耗',pendingSaved.saved.receipts.length===5&&pendingSaved.saved.receipts.at(-1).status==='unknown');
 ab(['reload']);await waitStage('sourceStep');await waitFor('刷新恢复分析回执',`JSON.parse(localStorage.getItem(${JSON.stringify(pendingSaved.key)})||'{}').receipts?.at(-1)?.status`,v=>v==='settled');
 const refreshed=await stats();check('刷新取消在途请求并恢复实际回执，不自动重发',refreshed.gatewayCalls===5&&refreshed.cancelledCalls===2&&evalJson(`document.getElementById('requirementsText').value.includes('保留原始需求')&&JSON.parse(localStorage.getItem(${JSON.stringify(pendingSaved.key)})).receipts.at(-1).freeCalls===1`));
 await newTask('dismiss');check('取消新任务保留当前草稿',evalJson(`document.getElementById('requirementsText').value.includes('保留原始需求')`));
 await newTask('accept');await waitStage('sourceStep');check('确认新任务后清空当前草稿和费用且不调用模型',evalJson(`document.getElementById('requirementsText').value===''&&!document.getElementById('taskSummary').checkVisibility()`)&&(await stats()).gatewayCalls===5);
 // Leave the workflow before injecting corruption: its pagehide intentionally persists valid in-memory progress.
 ab(['open',origin+'/healthz']);const broken='{"broken":';await run(`localStorage.setItem(${JSON.stringify(pendingSaved.key)},${JSON.stringify(broken)});return true;`);ab(['open',origin+'/requirements.html']);await waitStage('sourceStep');await waitFor('异常记录后模型仍可使用',`!document.getElementById('modelSelect').disabled&&document.querySelector('#modelSelect option')?.value.includes('requirements-fixture')`,Boolean);
 check('损坏记录刷新后保留原文并提示，不自动请求模型',evalJson(`localStorage.getItem(${JSON.stringify(pendingSaved.key)})===${JSON.stringify(broken)}&&document.getElementById('storageNotice').checkVisibility()&&document.getElementById('storageNotice').textContent.includes('原记录未被覆盖')`)&&(await stats()).gatewayCalls===5);
 ab(['fill','#requirementsText','恢复后新需求']);check('重新输入时先备份损坏记录，再保存新进度',evalJson(`localStorage.getItem(${JSON.stringify(pendingSaved.key+'.recovery')})===${JSON.stringify(broken)}&&JSON.parse(localStorage.getItem(${JSON.stringify(pendingSaved.key)})).message==='恢复后新需求'`)&&(await stats()).gatewayCalls===5);
 check('浏览器未展示API密钥',evalJson(`!document.body.textContent.includes('fixture-only-key')`));
}catch(error){check('需求成图浏览器流程',false,error.stack);try{ab(['screenshot',path.join(out,'failure.png')]);}catch{}}finally{
 fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({externalModelCalls:0,results},null,2));if(!failures())fs.rmSync(path.join(out,'failure.png'),{force:true});try{ab(['dialog','dismiss'],{allowFail:true,timeout:5000});ab(['close'],{allowFail:true,timeout:10000});}finally{app.kill('SIGTERM');await new Promise(resolve=>{if(app.exitCode!==null)return resolve();app.once('exit',resolve);setTimeout(()=>{app.kill('SIGKILL');resolve();},2000).unref();});fs.rmSync(fixtureDir,{recursive:true,force:true});}
}
console.log(`${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
