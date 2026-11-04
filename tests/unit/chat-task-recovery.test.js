const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../../public/chat.js'),'utf8'),Usage=require('../../public/turn-usage');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('condition did not settle');}
function runtime(t,{fetch:request,manualClock=false}={}){
 const elements=new Map(),timers=new Map(),polls=[];let seq=0;
 const make=()=>({innerHTML:'',textContent:'',value:'',style:{},dataset:{},disabled:false,scrollHeight:30,focus(){},addEventListener(){},appendChild(){},replaceChildren(){},querySelector(){return null;},setAttribute(k,v){this[k]=v;},classList:{add(){},remove(){},toggle(){}}});
 const el=id=>{if(!elements.has(id))elements.set(id,make());return elements.get(id);};
 const counts={persisted:0,historyRendered:0,resumed:0,saved:0,models:0};
 const window={DiagramMarkdown:{render:String},DiagramSse:require('../../lib/sse'),DiagramDocuments:require('../../lib/conversation-documents'),DiagramTurnUsage:{...Usage,paint(){},settle(...args){const p=Usage.settle(...args);polls.push(p);return p;}},DiagramAccountMenu:{mount(){return {error(){}}}},addEventListener(){}};
 const setTimer=(fn,ms)=>{const id=++seq,handle=manualClock?null:setTimeout(()=>{timers.delete(id);fn();},ms===750?0:ms);timers.set(id,{fn,ms,handle});return id;};
 const clearTimer=id=>{const record=timers.get(id);if(record?.handle)clearTimeout(record.handle);timers.delete(id);};
 const extra=`
 window.audit={taskJson,cancelServerReply,followServerReply,boot,setTurnUsage,reconcileTurnUsage,
 configure(thread){account={id:'alice'};chats=[thread];current=thread;localMode=true;updateOptions=()=>{};renderDocumentContext=()=>{};scheduleReplySave=()=>{};finishReplySave=()=>Promise.resolve(true);addRecoveryAction=()=>{};refreshQuota=async()=>{};resumeServerReply=()=>auditCounts.resumed++;persist=()=>auditCounts.persisted++;},
 configureBoot(thread,models){localMode=false;loadChats=async()=>{chats=[thread];};loadModels=()=>{auditCounts.models++;return models();};renderList=()=>auditCounts.historyRendered++;setCurrent=()=>auditCounts.historyRendered++;saveChats=()=>{auditCounts.saved++;return Promise.resolve(true);};resumeServerReply=()=>auditCounts.resumed++;refreshQuota=async()=>{};updateOptions=()=>{};},
 enableCloud(){localMode=false;},pauseSave(p){saveQueue=p;},detachViewer(){pageLeaving=true;activeController.abort();},state(){return {active:!!activeController,inputDisabled:input.disabled,label:sendButton['aria-label'],status:$('composerStatus').textContent};}};`;
 vm.runInNewContext(source.replace('\n  boot();',extra),{window,auditCounts:counts,document:{getElementById:el,createElement:make,addEventListener(){}},fetch:request||(()=>{throw Error('unexpected network');}),Headers,AbortSignal,AbortController,DOMException,TextDecoder,Response,Option:function(){},localStorage:{getItem:()=>null},setTimeout:setTimer,clearTimeout:clearTimer,setInterval:()=>0,clearInterval(){}});
 t.after(()=>{for(const id of timers.keys())clearTimer(id);});
 return {...window.audit,el,counts,polls,timers,fire(ms){const found=[...timers].find(([,v])=>v.ms===ms);assert.ok(found,'expected timer '+ms);timers.delete(found[0]);found[1].fn();},assistant(thread){const item={id:crypto.randomUUID(),role:'assistant',taskId:crypto.randomUUID(),pending:true,content:''};thread.messages.push(item);return {thread,item,node:make(),body:make(),progress:{phase(){},stop(){}}};}};
}
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const events=(task,error=false)=>new Response('event: snapshot\ndata: '+JSON.stringify(task)+'\n\nevent: '+(error?'error':'result')+'\ndata: '+JSON.stringify({...task,taskTerminal:true})+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
const thread=()=>({id:crypto.randomUUID(),messages:[{role:'user',content:'original question'}]});

test('task JSON requests have a deadline without aborting their viewer',async t=>{
 let requestSignal;const api=runtime(t,{manualClock:true,fetch:async(route,options)=>{requestSignal=options.signal;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}}),viewer=new AbortController();
 const pending=api.taskJson('/api/conversation/tasks',{},viewer.signal);api.fire(15000);
 await assert.rejects(pending,e=>e.name==='TimeoutError');assert.equal(requestSignal.aborted,true);assert.equal(viewer.signal.aborted,false);assert.equal(api.timers.size,0);
});
test('confirmed cancellation escapes a stalled creation response and follows the same terminal task',async t=>{
 const calls=[];let creationSignal;const api=runtime(t,{fetch:async(route,options)=>{calls.push(route);if(route==='/api/conversation/tasks'){creationSignal=options.signal;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}if(route.endsWith('/cancel'))return json({task:{status:'running'}});if(route.endsWith('/events'))return events({status:'cancelled',reply:'retained partial',error:{code:'task-cancelled',message:'已取消生成'}},true);return json({task:{status:'running',reply:'retained partial'}});}});
 const chat=thread(),assistant=api.assistant(chat);api.configure(chat);const followed=api.followServerReply(assistant,{message:'question'});await until(()=>creationSignal);await api.cancelServerReply(assistant);await followed;
 assert.equal(calls.filter(route=>route==='/api/conversation/tasks').length,1);assert.equal(creationSignal.aborted,true);assert.equal(assistant.item.taskStatus,'cancelled');assert.equal(assistant.item.content,'retained partial');assert.equal(api.state().active,false);assert.equal(api.state().inputDisabled,false);
});
test('leaving while the initial history save is pending does not send a late creation request',async t=>{
 let releaseSave,networkCalls=0;const api=runtime(t,{fetch:async(route,options)=>{if(options.signal.aborted)throw options.signal.reason;networkCalls++;throw Error('must not reach the network');}}),chat=thread(),assistant=api.assistant(chat);
 api.configure(chat);api.pauseSave(new Promise(resolve=>releaseSave=resolve));const followed=api.followServerReply(assistant,{message:'question'});api.detachViewer();releaseSave(true);await followed;
 assert.equal(networkCalls,0);assert.equal(assistant.item.pending,true);assert.equal(api.state().active,false);
});
test('ambiguous creation tolerates transient missing lookups and never resubmits the model request',async t=>{
 let posts=0,lookups=0;const api=runtime(t,{fetch:async route=>{if(route==='/api/conversation/tasks'){posts++;throw Error('lost creation response');}if(route.endsWith('/events'))return events({status:'succeeded',reply:'complete',provider:{name:'fixture'},model:{modelId:'m'}});lookups++;return lookups<3?json({error:{message:'not created yet'}},404):json({task:{status:'running',reply:'partial'}});}});
 const chat=thread(),assistant=api.assistant(chat);api.configure(chat);await api.followServerReply(assistant,{message:'question'});
 assert.equal(posts,1);assert.equal(lookups,3);assert.equal(assistant.item.pending,false);assert.equal(assistant.item.failed,false);assert.equal(assistant.item.content,'complete');
});
test('unconfirmed creation remains recoverable instead of declaring a late task failed',async t=>{
 let posts=0,lookups=0;const api=runtime(t,{fetch:async route=>{if(route==='/api/conversation/tasks'){posts++;throw Error('lost creation response');}lookups++;return json({error:{message:'not created yet'}},404);}});
 const chat=thread(),assistant=api.assistant(chat);api.configure(chat);await api.followServerReply(assistant,{message:'question'});
 assert.equal(posts,1);assert.equal(lookups,4);assert.equal(assistant.item.pending,true);assert.notEqual(assistant.item.failed,true);assert.equal(api.state().active,false);assert.match(api.state().status,/尚未确认服务器是否接受/);
});
for(const scenario of ['rejected','never resolves'])test('history and accepted tasks restore when the model catalog '+scenario,async t=>{
 const api=runtime(t,{fetch:async()=>json({mode:'cloud',user:{id:'alice',membership:{plan:'free'}},csrf:'test'})});api.configureBoot(thread(),()=>scenario==='rejected'?Promise.reject(Error('catalog unavailable')):new Promise(()=>{}));
 await api.boot();await tick();assert.equal(api.counts.historyRendered,2);assert.equal(api.counts.resumed,1);assert.equal(api.counts.saved,1);assert.equal(api.counts.models,1);
});
test('late fee failures and pending responses cannot downgrade a settled receipt',async t=>{
 const api=runtime(t),chat=thread(),id=crypto.randomUUID(),item={taskId:id,turnUsage:Usage.unknown(id)},node={};api.configure(chat);
 assert.equal(api.setTurnUsage(item,node,chat,{...Usage.unknown(id),status:'settled',calls:1,weeklyPoints:42}),true);
 assert.equal(api.setTurnUsage(item,node,chat,Usage.unknown(id)),false);assert.equal(api.setTurnUsage(item,node,chat,{...Usage.unknown(id),status:'pending',calls:1}),false);assert.equal(item.turnUsage.weeklyPoints,42);assert.equal(item.turnUsage.status,'settled');assert.equal(api.counts.persisted,1);
});
test('an actual old fee poll failing after SSE settlement preserves the final displayed and saved charge',async t=>{
 let rejectLookup,started=false;const api=runtime(t,{fetch:async()=>{started=true;return new Promise((resolve,reject)=>rejectLookup=reject);}}),chat=thread(),id=crypto.randomUUID(),item={taskId:id,turnUsage:Usage.unknown(id)},node={};api.configure(chat);api.enableCloud();
 api.reconcileTurnUsage(item,node,chat);await until(()=>started);api.setTurnUsage(item,node,chat,{...Usage.unknown(id),status:'settled',calls:1,weeklyPoints:42});rejectLookup(Error('old lookup failed'));await Promise.all(api.polls);
 assert.equal(item.turnUsage.status,'settled');assert.equal(item.turnUsage.weeklyPoints,42);assert.equal(api.counts.persisted,1);
});
