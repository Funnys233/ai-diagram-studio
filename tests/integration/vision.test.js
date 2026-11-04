const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
process.env.PROVIDERS_CONFIG_PATH=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'diagram-vision-')),'providers.json');process.env.DEEPSEEK_API_KEY='';process.env.REQUEST_TIMEOUT_MS='2000';
const {createServer}=require('../../server'),{sampleModel,buildMxfile}=require('../helpers/fixtures');
const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
let app,gateway,base,calls=[],output=sampleModel(),outputs=[],hold=false,closed=false;
const api=(url,body,method='POST')=>fetch(base+url,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const body=(extra={})=>({providerId:'oa',modelId:'m',message:'生成带重试分支的审批流程',editMode:'multimodal',multimodal:{focus:'增强可读性'},currentFile:sampleModel(),vision:{image:PNG,baseXml:sampleModel()},...extra});
test.before(async()=>{
 gateway=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{const b=JSON.parse(raw);calls.push(b);if(hold){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write('data: '+JSON.stringify({choices:[{index:0,delta:{reasoning_content:'private'}}]})+'\n\n');res.on('close',()=>{closed=true;});return;}
 const text=outputs.shift()||output;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url.includes('messages')?{model:'m',content:[{type:'text',text}],stop_reason:'end_turn'}:{model:'m',choices:[{message:{content:text},finish_reason:'stop'}]}));});});
 await new Promise(r=>gateway.listen(0,'127.0.0.1',r));app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+app.address().port;
 for(const [id,protocol] of [['oa','openai-chat-completions'],['an','anthropic-messages']]){await api('/api/providers',{providerId:id,name:id,protocol,baseUrl:'http://127.0.0.1:'+gateway.address().port,apiKey:''});await api(`/api/providers/${id}/models`,{modelId:'m',visionInput:true});}
});
test.after(async()=>{gateway.closeAllConnections();app.closeAllConnections();await Promise.all([new Promise(r=>app.close(r)),new Promise(r=>gateway.close(r))]);});
test.beforeEach(()=>{calls=[];output=sampleModel();outputs=[];hold=false;closed=false;});
test('图片能力持久化，未声明能力在调用前拒绝，旧检查接口已移除',async()=>{
 const list=await(await fetch(base+'/api/providers')).json();assert.equal(list.providers.find(p=>p.providerId==='oa').models[0].visionInput,true);assert.equal((await api('/api/providers/oa/models/m',{visionInput:'true'},'PUT')).status,400);
 await api('/api/providers/oa/models/m',{visionInput:false},'PUT');const no=await api('/api/vision/edit',body());assert.equal(no.status,400);assert.equal((await no.json()).error.code,'vision-unsupported');assert.equal(calls.length,0);await api('/api/providers/oa/models/m',{visionInput:true},'PUT');assert.ok((await api('/api/vision/check',body())).status>=400);assert.equal(calls.length,0);
});
test('双协议直接看图片和完整XML并返回修改，本次要求、聊天历史与补充要求完整传递',async()=>{
 output=sampleModel().replace('处理','多模态下一版');
 for(const providerId of ['oa','an']){const response=await api('/api/vision/edit',body({providerId,history:[{role:'user',content:'统一绿色配色'},{role:'assistant',content:'方案一横排，方案二纵排'}]}));assert.equal(response.status,200);const result=await response.json();assert.equal(result.kind,'multimodal-edit');assert.equal(result.report,undefined);assert.ok(result.xml.includes('多模态下一版'));
 const call=calls.at(-1),content=call.messages.at(-1).content;assert.ok(Array.isArray(content));assert.ok(content.some(p=>providerId==='oa'?p.type==='image_url'&&p.image_url.url===PNG:p.type==='image'&&p.source.data===PNG.split(',')[1]));const text=content.find(p=>p.text?.includes('本次用户要求')).text;assert.ok(text.includes(body().message));assert.ok(text.includes(sampleModel()));assert.ok(!text.includes('轮次'));assert.ok(JSON.stringify(call).includes('统一绿色配色'));assert.ok(JSON.stringify(call).includes('方案二纵排'));assert.ok(text.includes('增强可读性'));assert.ok(!JSON.stringify(call).includes('旧局部模式'));assert.ok(!text.includes('视觉报告'));assert.ok(!text.includes('摘要'));assert.ok(!text.includes('允许修改的 ID'));}
});
test('多模态可以改变连线端点和元素ID，不受局部或旧视觉保留规则限制',async()=>{
 output=sampleModel().replaceAll('="3"','="new3"').replace('source="2"','source="4"');const response=await api('/api/vision/edit',body());assert.equal(response.status,200);const result=await response.json();assert.ok(result.changes.total>0);assert.ok(result.xml.includes('source="4"'));assert.equal(calls.length,1);
});
test('可选参考图直接作为第二张图片，与当前画面一起参与修改',async()=>{
 const response=await api('/api/vision/edit',body({vision:{image:PNG,reference:PNG,baseXml:sampleModel()}}));assert.equal(response.status,200);assert.equal(calls[0].messages.at(-1).content.filter(p=>p.type==='image_url').length,2);
});
test('绘图参考图和聊天附件接受真实 JPEG 尾部附加数据，双协议收到完整编码',async()=>{
 const bytes=fs.readFileSync(path.join(__dirname,'../helpers/images/baseline.jpg'));
 const trailer='data:image/jpeg;base64,'+Buffer.concat([bytes,Buffer.from('export metadata')]).toString('base64');
 for(const providerId of ['oa','an']){
  const r=await api('/api/vision/edit',body({providerId,vision:{reference:trailer,images:[trailer],baseXml:sampleModel()}}));assert.equal(r.status,200);
  const content=calls.at(-1).messages.at(-1).content;
  const images=content.filter(p=>p.type===(providerId==='oa'?'image_url':'image'));assert.equal(images.length,2);
  for(const image of images){if(providerId==='oa')assert.equal(image.image_url.url,'data:image/jpeg;base64,'+bytes.toString('base64'));else{assert.equal(image.source.media_type,'image/jpeg');assert.equal(image.source.data,bytes.toString('base64'));}}
 }
});
test('多模态纠错重试的最后一条消息仍含图片、完整XML和用户要求，双协议都不会丢上下文',async()=>{
 for(const providerId of ['oa','an']){outputs=['<mxGraphModel><root>',sampleModel().replace('处理','纠错完成')];const before=calls.length,response=await api('/api/vision/edit',body({providerId}));assert.equal(response.status,200);assert.equal((await response.json()).attempts,2);assert.equal(calls.length,before+2);const last=calls.at(-1).messages.at(-1).content;assert.ok(Array.isArray(last));assert.ok(last.some(p=>providerId==='oa'?p.type==='image_url':p.type==='image'));assert.ok(last.some(p=>p.text?.includes(sampleModel())&&p.text.includes(body().message)));assert.ok(last.some(p=>p.text?.includes('上一次输出没有通过校验')));}
});
test('非法XML或引用不能应用，最多纠错一次',async()=>{
 for(const invalid of ['<mxGraphModel/>',sampleModel().replace('source="2"','source="missing"')]){output=invalid;const before=calls.length,res=await api('/api/vision/edit',body());assert.equal(res.status,502);assert.equal(calls.length,before+2);}
});
test('旧报告、错误图片、过期XML、mock、文本入口和无模式请求在调用前拒绝',async()=>{
 const bad=[body({vision:{image:PNG,baseXml:sampleModel(),repairReport:{version:1,summary:'旧报告',issues:[]}}}),body({vision:{image:'https://example.com/a.png',baseXml:sampleModel()}}),body({vision:{image:PNG,baseXml:sampleModel().replace('处理','过期')}}),body({providerId:'mock',modelId:'mock'}),body({editMode:undefined})];for(const payload of bad)assert.ok((await api('/api/vision/edit',payload)).status>=400);assert.equal((await api('/api/chat',body())).status,400);assert.equal(calls.length,0);
});
test('删除轮次参数，仅补充要求可选，非法参数在调用前拒绝',async()=>{
 for(const multimodal of [null,[],{current:1,total:2},{focus:123},{focus:'a'.repeat(3801)},{report:'x'}])assert.equal((await api('/api/vision/edit',body({multimodal}))).status,400);assert.equal(calls.length,0);assert.equal((await api('/api/vision/edit',body({multimodal:undefined}))).status,200);
});
test('多模态可仅识图回答，文字进入下次对话上下文而无需XML或重复调用',async()=>{
 output='方案一：横向排列；方案二：纵向分组，适合当前审批流程。';const first=await(await api('/api/vision/edit',body({message:'先分析画面，给我两种方案'}))).json();assert.equal(first.kind,'multimodal-chat');assert.equal(first.xml,null);assert.equal(first.reply,output);assert.equal(first.requiresReview,false);assert.equal(calls.length,1);
 output='已按第二种方案调整，保持绿色配色。\n```xml\n'+sampleModel().replace('处理','纵向分组')+'\n```';const second=await(await api('/api/vision/edit',body({message:'按第二个方案改',history:[{role:'user',content:'先分析画面，给我两种方案'},{role:'assistant',content:first.reply}]}))).json();assert.equal(second.kind,'multimodal-edit');assert.ok(second.xml.includes('纵向分组'));assert.equal(second.reply,'已按第二种方案调整，保持绿色配色。');assert.equal(calls.length,2);assert.ok(JSON.stringify(calls[1]).includes('方案二：纵向分组'));
});
test('空白图可用参考图对话，缺少全部图片时拒绝',async()=>{
 const blank='<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';output=sampleModel();assert.equal((await api('/api/vision/edit',body({currentFile:blank,vision:{reference:PNG,baseXml:blank}}))).status,200);assert.equal(calls[0].messages.at(-1).content.filter(p=>p.type==='image_url').length,1);assert.equal((await api('/api/vision/edit',body({vision:{baseXml:sampleModel()}}))).status,400);
});
test('多页按稳定ID提交完整目标页，图片请求总量仍受限制',async()=>{
 const model=sampleModel().replace('处理','第二页处理'),file=buildMxfile([{id:'a',name:'首页',content:sampleModel(),compressed:true},{id:'b',name:'第二页',content:model}]);output=model;const response=await api('/api/vision/edit',body({currentFile:file,currentPage:1,currentPageId:'b',vision:{image:PNG,baseXml:model}}));assert.equal(response.status,200);assert.equal((await response.json()).pageId,'b');assert.ok(calls[0].messages.at(-1).content.some(p=>p.text?.includes(model)));assert.equal((await api('/api/vision/edit',{huge:'a'.repeat(11*1024*1024)})).status,413);
});
test('SSE进度和取消关闭上游，不补发修改',async()=>{
 hold=true;const controller=new AbortController(),response=await fetch(base+'/api/vision/edit',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify(body({stream:true}))});const reading=response.text().catch(()=>{});for(let i=0;i<100&&!calls.length;i++)await new Promise(r=>setTimeout(r,10));controller.abort();await reading;for(let i=0;i<100&&!closed;i++)await new Promise(r=>setTimeout(r,10));assert.equal(closed,true);assert.equal(calls.length,1);
});
test('纸面和背景须匹配截图基线，视口差异不影响一致性',async()=>{
 const wrong=sampleModel().replace('pageWidth="850"','pageWidth="700"');assert.equal((await api('/api/vision/edit',body({vision:{image:PNG,baseXml:wrong}}))).status,409);assert.equal(calls.length,0);const view=sampleModel().replace('dx="900"','dx="123"');assert.equal((await api('/api/vision/edit',body({vision:{image:PNG,baseXml:view}}))).status,200);
});
test('大图直接输出全页XML，不被局部目标或操作数量限制',async()=>{
 const {bigModel}=require('../helpers/fixtures'),original=bigModel(230);output=original.replace(/\bx="(\d+)"/g,(_,value)=>'x="'+(Number(value)+20)+'"');const response=await api('/api/vision/edit',body({currentFile:original,vision:{image:PNG,baseXml:original}}));assert.equal(response.status,200);const result=await response.json();assert.ok(result.changes.updated.length>100);assert.equal(calls.length,1);assert.equal(result.patch,undefined);
});

test('空白图没有图片时仍支持先讨论，历史方案可供下一次绘制',async()=>{
 const blank='<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';output='建议先画三个步骤。';const response=await api('/api/vision/edit',body({currentFile:blank,vision:{baseXml:blank},message:'先讨论方案'}));assert.equal(response.status,200);assert.equal((await response.json()).kind,'multimodal-chat');assert.equal(calls.length,1);assert.ok(!calls[0].messages.at(-1).content.some(p=>p.type==='image_url'));
});

test('上传图片和历史图片通过双协议直接发送，图片不会成为文字描述',async()=>{
 output='我看到你上传的参考图片。';
 for(const providerId of ['oa','an']){const r=await api('/api/vision/edit',body({providerId,vision:{image:PNG,images:[PNG,PNG],baseXml:sampleModel()},history:[{role:'user',content:'刚才的图片',images:[PNG]},{role:'assistant',content:'已看到参考图'}]}));assert.equal(r.status,200);assert.equal((await r.json()).kind,'multimodal-chat');
 const messages=calls.at(-1).messages;const imageType=providerId==='oa'?'image_url':'image';assert.equal(messages.at(-1).content.filter(p=>p.type===imageType).length,3);const previous=messages.find(m=>m.role==='user'&&Array.isArray(m.content)&&m.content.some(p=>p.text==='刚才的图片'));assert.ok(previous);assert.equal(previous.content.filter(p=>p.type===imageType).length,1);}
});
test('空白画布上传图片也能直接识图；超过附件数量、远程图片和伪造历史图片在调用前拒绝',async()=>{
 output='这张图可以作为新图表的参考。';const empty='<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
 const r=await api('/api/vision/edit',body({currentFile:empty,vision:{images:[PNG],baseXml:empty}}));assert.equal(r.status,200);assert.equal((await r.json()).kind,'multimodal-chat');const before=calls.length;
 for(const extra of [{vision:{images:[PNG,PNG,PNG,PNG],baseXml:sampleModel()}},{vision:{images:['https://example.com/p.png'],baseXml:sampleModel()}},{history:[{role:'user',content:'图片',images:['data:image/png;base64,abcd']}]},{history:[{role:'assistant',content:'图片',images:[PNG]}]}])assert.equal((await api('/api/vision/edit',body(extra))).status,400);
 assert.equal(calls.length,before);
});
test('上传图片的XML纠错仍携带附件和历史图片',async()=>{
 outputs=['<mxGraphModel><root>',sampleModel()];const r=await api('/api/vision/edit',body({vision:{image:PNG,images:[PNG],baseXml:sampleModel()},history:[{role:'user',content:'原始附件',images:[PNG]}]}));assert.equal(r.status,200);assert.equal(calls.length,2);
 assert.equal(calls[1].messages.at(-1).content.filter(p=>p.type==='image_url').length,2);assert.ok(calls[1].messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.text==='原始附件')&&m.content.some(p=>p.type==='image_url')));
});
