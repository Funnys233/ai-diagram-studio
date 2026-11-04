// Real mouse selection + real draw.io + real fetch/SSE. Local model fixture is
// isolated from user providers, with deterministic operations and held requests.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startServer,makeBrowser,makeChecker,Cdp,ROOT} from './lib/browser-harness.mjs';
const require=createRequire(import.meta.url),{sampleModel,cellVertex}=require('../helpers/fixtures');
const Edit=require('../../lib/diagram-edit');
const XML=sampleModel().replace('</root>',cellVertex('manual','手工保留',{x:610,y:170})+'</root>');
const out=path.join(ROOT,'acceptance','local-edit');fs.mkdirSync(out,{recursive:true});
const {check,results,failures}=makeChecker();let calls=[],queue=[],hold=false,closed=0,cdp;
const gateway=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
 const body=JSON.parse(raw),request={body,res};calls.push(request);res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
 res.write('data: '+JSON.stringify({choices:[{index:0,delta:{reasoning_content:'test private reasoning'}}]})+'\n\n');
 if(hold){res.on('close',()=>{if(!res.writableEnded)closed++;});return;}
 finish(request,queue.shift()||[{op:'update',id:'3',label:'人工审核',style:{fillColor:'#f0f5ee'}}]);
});});
const finish=(request,operations)=>request.res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify({version:1,operations})},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');
await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
const app=await startServer({port:Number(process.env.LOCAL_EDIT_E2E_PORT||8250)});
const {ab,evalRaw,evalJson,waitFor}=makeBrowser('local-edit-'+Date.now()),hook='window.__DIAGRAM_AI_TEST__';
const st=`JSON.stringify({ready:${hook}?.state.ready,sessionBusy:${hook}?.state.sessionBusy,busy:${hook}?.state.busy,capturing:${hook}?.state.editCapturing,context:${hook}?.state.editContext,pending:${hook}?.state.pendingResult,model:${hook}?.state.modelXml,loads:${hook}?.state.loadCount,history:${hook}?.state.history.length,draft:document.getElementById('chatInput').value,chat:document.getElementById('chatList').textContent,hint:document.getElementById('hintBar').textContent,summary:document.getElementById('pendingResultText').textContent})`;
const waitLocal=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('本地事件等待超时');};
const runAsync=async code=>{
 evalRaw(`window.operation=null;(async()=>{${code}})().then(r=>window.operation=r).catch(e=>window.operation={ok:false,error:e.message});'started'`);
 return waitFor('操作结果','JSON.stringify(window.operation)',s=>s!==null);
};
const connect=async()=>{cdp?.close();cdp=await Cdp.connect(ab(['get','cdp-url']).out.replace(/^"|"$/g,''));await cdp.usePage('8250');await cdp.useEditorFrame();return evalJson('JSON.stringify(document.getElementById("drawioFrame").getBoundingClientRect().toJSON())');};
const select=async label=>{const rect=await connect();const found=await cdp.clickFrameText(label,rect);if(!found)throw new Error('未找到图形：'+label);cdp.close();cdp=null;
 ab(['click','#modifySelectionBtn']);return waitFor('锁定选区',st,s=>!s.capturing&&s.context?.targetIds?.length);
};
const send=async text=>{ab(['fill','#chatInput',text]);ab(['click','#sendBtn']);return waitFor('请求完成',st,s=>!s.busy&&s.chat.includes(text));};
const api=async(url,body)=>{const r=await fetch(app.base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());};
try {
 await api('/api/providers',{providerId:'fixture',name:'局部验收',protocol:'openai-chat-completions',baseUrl:`http://127.0.0.1:${gateway.address().port}`,apiKey:''});
 await api('/api/providers/fixture/models',{modelId:'fixture',displayName:'本地测试模型'});
 ab(['open',app.base+'/?test=1']);await waitFor('编辑器就绪',st,s=>s.ready&&!s.sessionBusy);
 await runAsync(`return ${hook}.loadPayload(${JSON.stringify(XML)});`);
 let rect=await connect();await cdp.click(rect.x+40,rect.y+120);cdp.close();cdp=null;
 ab(['click','#modifySelectionBtn']);const empty=await waitFor('空选区',st,s=>!s.capturing&&s.context?.invalid);
 check('真实空选区被阻止，未调用模型',calls.length===0&&empty.hint.length>0);
 const selected=await select('处理');check('真实鼠标选中处理节点并锁定 ID 3',selected.context.targetIds.join(',')==='3');
 const before=evalJson(st);const after=await send('仅将选中节点改为人工审核，并改浅绿色');
 const change=Edit.diff(before.model,after.model);
 check('真实局部请求只有指定节点发生变化',change.updated.length===1&&change.updated[0].id==='3'&&!change.added.length&&!change.removed.length);
 check('其他节点、手工元素、连线 ID 与坐标保持原样',Edit.indexModel(after.model).cells.size===Edit.indexModel(before.model).cells.size&&change.total===1);
 check('前端发送 selection 模式和准确目标，单次模型调用',calls.length===1&&calls[0].body.messages.at(-1).content.includes('【允许修改的 ID】["3"]'));
 ab(['screenshot',path.join(out,'01-local-update.png')]);
 check('完成后沿用原选区并更新基线，可继续局部修改',after.context?.targetIds?.join(',')==='3'&&after.context.baseXml.includes('人工审核'));
 await runAsync(`${hook}.setDraft('下一次只改配色');return ${hook}.flushSession();`);
 ab(['reload']);const restored=await waitFor('局部模式恢复',st,s=>s.ready&&!s.sessionBusy&&s.context?.targetIds?.length);
 check('刷新同时恢复局部范围、图表和未发送草稿',restored.context.targetIds.join(',')==='3'&&restored.draft==='下一次只改配色');
 await runAsync(`return ${hook}.restoreSnapshot();`);
 check('局部修改可撤销恢复原图',Edit.diff(before.model,evalJson(st).model).total===0);
 await select('处理');const preDelete=evalJson(st);queue=[[{op:'remove',id:'3'}]];const deleting=await send('删除选中节点');
 check('删除先展示关联边摘要，确认前不加载',Boolean(deleting.pending?.edit)&&deleting.pending.edit.changes.removed.length===3&&deleting.loads===preDelete.loads);
 ab(['screenshot',path.join(out,'02-delete-review.png')]);
 await runAsync(`return ${hook}.flushSession();`);ab(['reload']);await waitFor('暂存恢复',st,s=>s.ready&&!s.sessionBusy&&s.pending?.edit);
 check('刷新保留局部修改元数据和正确摘要',evalJson(st).summary.includes('删除 2 条连线'));
 const removed=await runAsync(`return ${hook}.applyPendingResult();`);
 check('确认后删除目标与关联边，手工节点仍存在',removed.ok&&!Edit.indexModel(evalJson(st).model).cells.has('3')&&Edit.indexModel(evalJson(st).model).cells.has('manual'));
 await runAsync(`return ${hook}.restoreSnapshot();`);
 await select('处理');queue=[[{op:'add',id:'new1',kind:'node',label:'补充步骤',geometry:{x:520,y:280}},{op:'add',id:'newedge',kind:'edge',source:'3',target:'new1'}]];
 const adding=await send('在选中节点旁增加补充步骤');check('新增节点和连线先暂存并分配唯一 ID',adding.pending?.edit.changes.added.length===2&&Object.values(adding.pending.edit.idMap).every(id=>id.startsWith('ai-edit-')));
 check('确认新增可应用且完整 XML 合法',(await runAsync(`return ${hook}.applyPendingResult();`)).ok);
 await runAsync(`return ${hook}.restoreSnapshot();`);
 await select('处理');const safe=evalJson(st);queue=[[{op:'update',id:'manual',label:'越界'}],[{op:'remove',id:'2'}]];
 const invalid=await send('测试越界操作');check('越界两次均被拒绝，画布与手工节点不变',invalid.chat.includes('两次校验失败')&&Edit.diff(safe.model,invalid.model).total===0&&invalid.loads===safe.loads);
 await select('处理');hold=true;const count=calls.length;ab(['fill','#chatInput','取消这次局部修改']);ab(['click','#sendBtn']);
 await waitLocal(()=>calls.length===count+1);ab(['fill','#chatInput','新的草稿']);ab(['click','#cancelBtn']);await waitFor('取消完成',st,s=>!s.busy&&s.chat.includes('已取消本次生成'));await waitLocal(()=>closed===1);hold=false;
 check('取消关闭上游且保留选区图表和新草稿',Edit.diff(safe.model,evalJson(st).model).total===0&&evalJson(st).draft==='新的草稿');
 // Change an unrelated label through real draw.io editing while the response is held.
 await select('处理');hold=true;const next=calls.length;ab(['fill','#chatInput','将选中处理改名为 AI 审核']);ab(['click','#sendBtn']);await waitLocal(()=>calls.length===next+1);
 rect=await connect();const labelRect=await cdp.frameJson(`(()=>{const e=[...document.querySelectorAll('div,span,td')].filter(e=>e.textContent?.trim()==='结束').sort((a,b)=>a.getBoundingClientRect().width-b.getBoundingClientRect().width)[0];if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 if(!labelRect)throw new Error('找不到结束节点');
 await cdp.doubleClick(rect.x+labelRect.x,rect.y+labelRect.y);await cdp.send('Input.insertText',{text:'手工结束'});await cdp.click(rect.x+40,rect.y+120);cdp.close();cdp=null;
 await waitFor('真实手工编辑同步',st,s=>s.model.includes('手工结束'));
 finish(calls[next],[{op:'update',id:'3',label:'AI 审核'}]);hold=false;
 await waitFor('局部冲突暂存',st,s=>!s.busy&&s.pending?.edit);
 check('真实手工编辑触发冲突，模型结果暂存',evalJson(st).model.includes('手工结束')&&!evalJson(st).model.includes('AI 审核'));
 const applied=await runAsync(`return ${hook}.applyPendingResult();`);
 check('确认局部结果只改目标并保留真实手工编辑',applied.ok&&evalJson(st).model.includes('AI 审核')&&evalJson(st).model.includes('手工结束'));
 ab(['screenshot',path.join(out,'03-rebased.png')]);
 const exports=await runAsync(`const [png,json]=await Promise.all([${hook}.requestExport({format:'png',scale:1,border:10}),${hook}.requestExport({format:'json',allPages:false})]);return {ok:png.ok&&json.ok,png:typeof png.data==='string'&&png.data.startsWith('data:image/png;base64,'),json:Array.isArray(json.data?.pages)};`);
 check('真实 PNG 与 JSON 并发导出分别匹配回执，原有导出功能可用',exports.ok&&exports.png&&exports.json);
} catch(e){check('浏览器验收执行',false,e.stack);}finally{
 cdp?.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({realEditor:true,results},null,2));ab(['close'],{allowFail:true});app.stop();gateway.closeAllConnections();await new Promise(r=>gateway.close(r));
}
console.log(`\n${results.length-failures()}/${results.length} passed; ${out}`);if(failures())process.exitCode=1;
