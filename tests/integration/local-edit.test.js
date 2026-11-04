const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
process.env.PROVIDERS_CONFIG_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'diagram-local-edit-')),'providers.json');
process.env.DEEPSEEK_API_KEY='';process.env.REQUEST_TIMEOUT_MS='1000';
const {createServer}=require('../../server');
const {sampleModel,buildMxfile}=require('../helpers/fixtures');
const Edit=require('../../lib/diagram-edit');
const {createParser}=require('../../lib/sse');
let upstream,app,base,calls=[],outputs=[],hang=false;
const patch=operations=>JSON.stringify({version:1,operations});
const GOOD=patch([{op:'update',id:'3',label:'人工审核',style:{fillColor:'#f0f5ee'}}]);
const secret='sk-local-edit-secret';
const api=(pathname,body)=>fetch(base+pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test.before(async()=>{
 upstream=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
  const body=JSON.parse(raw);calls.push({body,headers:req.headers});
  const output=outputs.shift()||GOOD;
  if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
   res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:output.slice(0,10)}}]})+'\n\n');
   if(hang){res.on('close',()=>{hang=false;});return;}
   res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:output.slice(10)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
  }else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:output},finish_reason:'stop'}]}));}
 });});await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.address().port}`;
 assert.equal((await api('/api/providers',{providerId:'p',name:'本地测试',protocol:'openai-chat-completions',baseUrl:`http://127.0.0.1:${upstream.address().port}`,apiKey:secret})).status,201);
 assert.equal((await api('/api/providers/p/models',{modelId:'m'})).status,201);
});
test.after(async()=>{for(const s of [app,upstream]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
const request=(extra={})=>api('/api/chat',{message:'仅把选中节点改为人工审核',editMode:'selection',targetIds:['3'],currentFile:sampleModel(),providerId:'p',modelId:'m',...extra});
const reset=()=>{calls=[];outputs=[];hang=false;};
test('局部 API 返回可复核的合并 XML 和准确变化，不把历史整图要求当作局部输出规则',async()=>{
 reset();const res=await request({history:[{role:'assistant',content:'之前生成了整张图'}]});const r=await res.json();
 assert.equal(res.status,200);assert.equal(r.kind,'local-edit');assert.equal(r.requiresReview,false);assert.equal(r.changes.updated[0].id,'3');
 assert.equal(Edit.verifyCandidate(sampleModel(),r,['3']).xml,r.xml);assert.ok(!JSON.stringify(r).includes(secret));
 assert.equal(calls.length,1);assert.ok(calls[0].body.messages[0].content.includes('operations'));assert.ok(calls[0].body.messages.at(-1).content.includes('【允许修改的 ID】["3"]'));
});
test('多页请求只修改指定页，返回稳定页面 ID，其他页不进入可写范围',async()=>{
 reset();const file=buildMxfile([{id:'first',name:'第一页',content:sampleModel()},{id:'second',name:'第二页',content:sampleModel(),compressed:true}]);
 const res=await request({currentFile:file,currentPage:1,currentPageId:'second'});const r=await res.json();assert.equal(res.status,200);assert.equal(r.pageId,'second');assert.equal(r.pageIndex,1);
 assert.ok(calls[0].body.messages.at(-1).content.includes('第 2 页'));
});
test('局部 JSON SSE 保持流式状态与最终一次合法结果',async()=>{
 reset();const res=await request({stream:true});const raw=await res.text(),events=[];
 createParser(e=>events.push({event:e.event,data:JSON.parse(e.data)})).push(raw);
 assert.ok(events.some(e=>e.data.phase==='generating'));assert.ok(events.some(e=>e.data.phase==='validating'&&e.data.kind==='local-edit'));
 const r=events.find(e=>e.event==='result').data;assert.equal(r.changes.total,1);assert.equal(events.filter(e=>e.event==='result').length,1);
});
test('范围越界只纠错一次，两次均非法则没有可应用 XML',async()=>{
 reset();outputs=[patch([{op:'update',id:'4',label:secret}]),patch([{op:'remove',id:'2'}])];
 const res=await request();const raw=await res.text(),r=JSON.parse(raw);assert.equal(res.status,502);assert.equal(r.error.code,'invalid-edit-output');assert.equal(calls.length,2);assert.equal(r.xml,undefined);assert.ok(!raw.includes(secret));
});
test('模型第一次返回整图被拒绝，第二次修正为局部操作并使用同一模型',async()=>{
 reset();outputs=[sampleModel(),GOOD];const res=await request(),r=await res.json();assert.equal(res.status,200);assert.equal(r.attempts,2);
 assert.equal(calls[0].body.model,calls[1].body.model);assert.ok(calls[1].body.messages.at(-1).content.includes('不输出 XML'));
});
test('删除节点的关联边出现在摘要中，必须由前端暂存确认',async()=>{
 reset();outputs=[patch([{op:'remove',id:'3'}])];const r=await(await request()).json();assert.equal(r.requiresReview,true);assert.equal(r.changes.removed.length,3);assert.match(r.reply,/删除 1 个节点，删除 2 条连线/);
});
test('缺选区、非法 ID、错模式、旧阶段组合、mock 都在调用模型前拒绝',async()=>{
 for(const extra of [{targetIds:[]},{targetIds:['missing']},{editMode:'anything'},{stage:'framework'},{providerId:'mock',modelId:'mock'}]){
  reset();const res=await request(extra);assert.equal(res.status,400);assert.equal(calls.length,0);
 }
});
test('流式局部请求取消后关闭上游，不产生补发或继续纠错',async()=>{
 reset();hang=true;const controller=new AbortController();
 const res=await fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({message:'改名',editMode:'selection',targetIds:['3'],currentFile:sampleModel(),providerId:'p',modelId:'m',stream:true})});
 const reading=res.text().catch(()=>{});for(let i=0;i<100&&!calls.length;i++)await new Promise(r=>setTimeout(r,10));controller.abort();await reading;
 for(let i=0;i<100&&hang;i++)await new Promise(r=>setTimeout(r,10));assert.equal(hang,false);assert.equal(calls.length,1);
});
