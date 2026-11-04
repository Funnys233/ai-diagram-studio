// A real browser, real fetch/SSE and optional real draw.io. Local model fixture
// is manually gated so progress and cancellation are observed deterministically.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startServer,makeBrowser,makeChecker,ROOT} from './lib/browser-harness.mjs';
const require=createRequire(import.meta.url);
const {sampleModel}=require('../helpers/fixtures');
const XML=sampleModel();
const out=path.join(ROOT,'acceptance','streaming');fs.mkdirSync(out,{recursive:true});
const {check,results,failures}=makeChecker();
const pending=[];let closes=0;
const gateway=http.createServer((req,res)=>{
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    const body=JSON.parse(raw);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
    pending.push({body,res});res.on('close',()=>{if(!res.writableEnded)closes++;});
  });
});
const editor=http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/html'});
  res.end(`<!doctype html><html><body><p id="diagram">测试画布</p><script>
  let payload='';const send=m=>parent.postMessage(JSON.stringify(m),'*');
  addEventListener('message',e=>{let m;try{m=JSON.parse(e.data)}catch{return}
  if(m.action==='load'){payload=m.xml;document.getElementById('diagram').textContent='已加载图表';send({event:'load',xml:payload,currentPage:0,bounds:{width:700,height:500}})}
  if(m.action==='viewbox')send({event:'viewbox',currentPage:0,message:m});
  if(m.action==='getDiff')send({event:'getDiff',xml:payload,message:m});});send({event:'init'});
  </script></body></html>`);
});
await new Promise(r=>gateway.listen(0,'127.0.0.1',r));await new Promise(r=>editor.listen(0,'127.0.0.1',r));
const real=process.env.STREAM_REAL_EDITOR==='1';
const app=await startServer({port:Number(process.env.STREAM_E2E_PORT||8248),env:{DRAWIO_EMBED_URL:real?'https://embed.diagrams.net/':`http://127.0.0.1:${editor.address().port}/`}});
const {ab,evalJson,evalRaw,waitFor}=makeBrowser(`diagram-stream-${Date.now()}`);
const hook='window.__DIAGRAM_AI_TEST__';
const st=`JSON.stringify({ready:${hook}?.isReady(),sessionBusy:${hook}?.state.sessionBusy,fingerprint:${hook}?.docFingerprint(),busy:${hook}?.state.busy,load:${hook}?.state.loadCount,payload:${hook}?.state.payload,history:${hook}?.state.history.length,valid:window.DiagramModel.validateGraphModel(${hook}?.state.modelXml||'').ok,draft:document.getElementById('chatInput').value,chat:document.getElementById('chatList').textContent,cancel:!document.getElementById('cancelBtn').classList.contains('hidden')})`;
const emit=(p,data)=>pending[p].res.write(`data: ${JSON.stringify(data)}\n\n`);
const text=(p,value)=>emit(p,{model:'fixture',choices:[{index:0,delta:{content:value}}]});
const finish=(p,value)=>{text(p,value);emit(p,{choices:[{index:0,delta:{},finish_reason:'stop'}]});pending[p].res.end('data: [DONE]\n\n');};
const waitLocal = async predicate => {
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}
  throw new Error('本地模型事件等待超时');
};
const request=async message=>{
  const expected=pending.length+1;
  ab(['fill','#chatInput',message]);ab(['click','#sendBtn']);
  await waitFor('等待首段',st,s=>s.busy&&s.chat.includes('等待首段'));
  await waitLocal(()=>pending.length===expected);
};
const api=async(url,body)=>{
  const r=await fetch(app.base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!r.ok)throw new Error(await r.text());return r.json();
};
try {
  await api('/api/providers',{providerId:'stream-fixture',name:'流式验收',baseUrl:`http://127.0.0.1:${gateway.address().port}`,protocol:'openai-chat-completions',apiKey:''});
  await api('/api/providers/stream-fixture/models',{modelId:'fixture',displayName:'本地测试模型'});
  ab(['open',app.base+'/?test=1']);await waitFor('画布就绪',st,s=>s.ready&&!s.sessionBusy);
  const initialLoads=evalJson(st).load;
  await request('画一个中文流程图');
  check('真实表单发送后显示等待首段和取消按钮',evalJson(st).cancel&&pending[0].body.stream);
  emit(0,{choices:[{index:0,delta:{reasoning_content:'private reasoning never shown'}}]});
  await waitFor('思考进度',st,s=>s.chat.includes('正在思考'));
  check('显示思考状态且不显示思考原文',!evalJson(st).chat.includes('private reasoning'));
  check('花形动画位于最前，当前状态独立播报且无列表',evalJson(`!!document.querySelector('.agent-progress-header > :first-child svg ellipse')&&document.querySelector('.agent-progress-label[role=status]').textContent==='正在思考'&&!document.querySelector('.agent-progress-details, .agent-progress-steps')`));
  const cut=Math.floor(XML.length/2);text(0,XML.slice(0,cut));
  await waitFor('生成进度',st,s=>s.chat.includes('正在生成')&&s.chat.includes('字符'));
  check('半段 XML 不触发任何画布加载',evalJson(st).load===initialLoads);
  check('进度采用两帧滚动窗口，不累积历史条目',evalJson(`document.querySelectorAll('.agent-progress-item').length===2&&document.querySelector('.agent-progress-label[role=status]').textContent==='正在生成'&&getComputedStyle(document.querySelector('.agent-progress-window')).overflow==='hidden'`));
  ab(['screenshot',path.join(out,'01-generating.png')]);
  finish(0,XML.slice(cut));await waitFor('完整结果写回',st,s=>!s.busy&&s.load===initialLoads+1);
  check(real?'真实 draw.io 收到完整合法图表后只加载一次':'完整合法图表只加载一次',evalJson(st).valid);
  check('完成后移除活动状态，恢复正常回复',evalJson(`!document.querySelector('.agent-progress')&&!document.querySelector('.agent-progress-label')`));
  ab(['screenshot',path.join(out,'02-complete.png')]);
  const baseline=evalJson(st);
  await request('修改图表');text(1,XML.slice(0,cut));await waitFor('第二次生成',st,s=>s.chat.includes('正在生成')&&s.cancel);
  ab(['fill','#chatInput','用户的新草稿']);ab(['click','#cancelBtn']);
  await waitFor('取消完成',st,s=>!s.busy&&s.chat.includes('已取消本次生成'));
  const cancelled=evalJson(st);
  check('取消保留图表、历史与新草稿',cancelled.fingerprint===baseline.fingerprint&&cancelled.load===initialLoads+1&&cancelled.history===baseline.history&&cancelled.draft==='用户的新草稿');
  await waitLocal(()=>closes===1);
  check('浏览器取消真正关闭模型连接',closes===1);
  ab(['screenshot',path.join(out,'03-cancelled.png')]);
  await request('模拟断流');text(2,XML);emit(2,{choices:[{index:0,delta:{},finish_reason:'stop'}]});pending[2].res.end();
  await waitFor('断流错误',st,s=>!s.busy&&s.chat.includes('未完整结束'));
  check('即使收到完整 XML，缺失流结束标记也不写入画布',evalJson(st).load===initialLoads+1&&pending.length===3);
  await request('测试自动纠错');finish(3,'<mxGraphModel>');
  await waitFor('纠错第二次',st,s=>s.chat.includes('第 2 次')&&s.chat.includes('等待首段'));
  await waitLocal(()=>pending.length===5);
  check('XML 纠错重试进度显示第 2 次',pending.length===5);
  finish(4,XML);await waitFor('纠错完成',st,s=>!s.busy&&s.load===initialLoads+2);
  check('纠错后的完整图表只再加载一次',evalJson(st).valid);
  ab(['screenshot',path.join(out,'04-retry-complete.png')]);
  evalRaw(`${hook}.flushSession();'saving'`);
  await waitFor('会话保存','JSON.stringify(document.getElementById("saveStatus").textContent)',s=>s==='已自动保存');
  ab(['reload']);await waitFor('刷新恢复',st,s=>s.ready&&s.history===4);
  check('刷新仍恢复图表和成功对话，取消不污染模型历史',evalJson(st).valid);
} catch(e) {check('浏览器验收执行',false,e.stack);} finally {
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({realEditor:real,results},null,2));
  ab(['close'],{allowFail:true});app.stop();
  for(const s of [gateway,editor]){s.closeAllConnections();await new Promise(r=>s.close(r));}
}
console.log(`\n${results.length-failures()}/${results.length} passed; ${out}`);
if(failures())process.exitCode=1;
