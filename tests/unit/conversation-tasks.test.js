const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {ConversationTasks}=require('../../lib/conversation-tasks'),{codec}=require('../../lib/cloud-runtime');
const pause=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(t,options={}){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'diagram-task-'));const tasks=new ConversationTasks({directory,flushMs:1,...options});t.after(async()=>{await tasks.close();fs.rmSync(directory,{recursive:true,force:true});});return {tasks,directory};}
const spec=patch=>({id:crypto.randomUUID(),threadId:crypto.randomUUID(),assistantId:crypto.randomUUID(),ownerId:'alice',fingerprint:'request-hash',...patch});
test('写入先于推送，断开订阅不取消；完成释放运行引用，确认保存后清空正文且不重复生成',async t=>{
 const {tasks,directory}=await fixture(t),id=crypto.randomUUID();let send,finish,calls=0,released=0;
 const request=spec({id,release:()=>released++,run:ctx=>{calls++;send=ctx.onText;return new Promise(resolve=>finish=resolve);}});
 tasks.create(request);await pause();const received=[];
 const unsubscribe=tasks.subscribe('alice',id,snapshot=>{const disk=JSON.parse(fs.readFileSync(path.join(directory,id+'.enc'),'utf8'));assert.equal(disk.reply,snapshot.reply);received.push(snapshot);});
 send('已保存正文');tasks.get('alice',id);assert.equal(received.at(-1).reply,'已保存正文');unsubscribe();
 let duplicateReleased=0;assert.equal(tasks.running.size,1);assert.equal(tasks.create({...request,release:()=>duplicateReleased++}).reply,'已保存正文');assert.equal(calls,1);assert.equal(duplicateReleased,1);
 finish({reply:'完整正文',provider:{name:'fixture'}});await tasks.running.get(id).promise;
 assert.equal(released,1);assert.equal(tasks.running.size,0);assert.equal(tasks.get('alice',id).reply,'完整正文');
 tasks.acknowledge('alice',id);const releasedJob=JSON.parse(fs.readFileSync(path.join(directory,id+'.enc'),'utf8'));assert.equal(releasedJob.reply,'');assert.equal(releasedJob.result,undefined);
 assert.throws(()=>tasks.get('alice',id),e=>e.status===410);assert.throws(()=>tasks.create(request),e=>e.status===410);assert.equal(calls,1);
});
test('按账号隔离，重复ID不能换问题；运行中不得清理，显式取消才中止',async t=>{
 const {tasks}=await fixture(t);let released=0;const request=spec({release:()=>released++,run:({signal,onText})=>new Promise((resolve,reject)=>{onText('部分回复');signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});})});
 tasks.create(request);await pause();assert.throws(()=>tasks.get('bob',request.id),e=>e.status===404);assert.throws(()=>tasks.cancel('bob',request.id),e=>e.status===404);
 assert.throws(()=>tasks.create({...request,fingerprint:'different'}),e=>e.status===409);assert.throws(()=>tasks.acknowledge('alice',request.id),e=>e.status===409);
 const finished=tasks.running.get(request.id).promise;tasks.cancel('alice',request.id);await finished;
 assert.equal(tasks.get('alice',request.id).status,'cancelled');assert.equal(tasks.get('alice',request.id).reply,'部分回复');assert.equal(released,1);
});
test('未取回结果到期清理；加密暂存可跨进程恢复，重启标记中断且不重跑',async t=>{
 let now=100;const cipher=codec(crypto.randomBytes(32)),{tasks,directory}=await fixture(t,{codec:cipher,now:()=>now,retentionMs:100});
 const request=spec({run:async()=>({reply:'敏感正文'})});tasks.create(request);await tasks.running.get(request.id).promise;
 assert.ok(!fs.readFileSync(path.join(directory,request.id+'.enc'),'utf8').includes('敏感正文'));
 now=201;assert.throws(()=>tasks.get('alice',request.id),e=>e.status===404);assert.equal(fs.existsSync(path.join(directory,request.id+'.enc')),false);
 const id=crypto.randomUUID();fs.writeFileSync(path.join(directory,id+'.enc'),cipher.encode({version:1,id,ownerId:'alice',status:'running',reply:'重启前正文'}));
 const restored=new ConversationTasks({directory,codec:cipher,now:()=>now});t.after(()=>restored.close());
 const snapshot=restored.get('alice',id);assert.equal(snapshot.status,'interrupted');assert.equal(snapshot.reply,'重启前正文');assert.equal(restored.running.size,0);assert.match(snapshot.error.message,/不会自动重新调用/);
});
test('运行时间有界，超时保存部分回复并释放资源',async t=>{
 const {tasks}=await fixture(t,{maxRunMs:15});let released=0;const request=spec({release:()=>released++,run:({signal,onText})=>new Promise((resolve,reject)=>{onText('前缀');signal.addEventListener('abort',()=>reject(Error('aborted')));})});
 tasks.create(request);const keepAlive=setTimeout(()=>{},1000);await tasks.running.get(request.id).promise;clearTimeout(keepAlive);
 assert.equal(tasks.get('alice',request.id).status,'failed');assert.equal(tasks.get('alice',request.id).error.code,'task-timeout');assert.equal(released,1);
});
test('绘图可独立设置结果与进度边界，不放宽原对话的100k正文限制',async t=>{
 const normal=await fixture(t),drawing=await fixture(t,{maxOutputChars:210000,progressPhases:['waiting','validating']});
 const reply='字'.repeat(110000),xml='<mxGraphModel>'+(' '.repeat(150000))+'</mxGraphModel>';
 const original=spec({run:async()=>({reply})});normal.tasks.create(original);await normal.tasks.running.get(original.id).promise;
 assert.equal(normal.tasks.get('alice',original.id).status,'failed');
 const request=spec({run:async({onProgress})=>{onProgress({phase:'validating'});return {reply,xml,requiresReview:true};}});
 drawing.tasks.create(request);await drawing.tasks.running.get(request.id).promise;
 const restored=drawing.tasks.get('alice',request.id);assert.equal(restored.status,'succeeded');assert.equal(restored.phase.phase,'validating');assert.equal(restored.reply,reply);assert.equal(restored.xml,xml);assert.equal(restored.requiresReview,true);
});
