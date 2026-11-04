const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../public/chat.js'), 'utf8');
function runtime(t, clock = {}) {
  const elements = new Map(), timers = new Set();
  const stored = new Map(), storage = clock.storage || {getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)};
  const make = () => ({ innerHTML: '', value: '', style: {}, scrollHeight: 20, focus() {}, addEventListener() {}, classList: { remove() {}, add() {}, toggle() {} } });
  const el = id => {
    if (!elements.has(id)) elements.set(id, make());
    return elements.get(id);
  };
  const window = { DiagramMarkdown: { render: String }, DiagramSse: require('../../lib/sse'), DiagramDocuments: require('../../lib/conversation-documents'), DiagramChatHistory: require('../../public/chat-history'), addEventListener() {} };
  assert.ok(source.includes('\n  boot();'));
  vm.runInNewContext(source.replace('\n  boot();', `\n  window.chatTest = {readStream, historyFor, recoverThread, unansweredQuestion, addRecoveryAction, submit, saveChats, savedTaskReply,
    configureStorage(rows, deleted={}) { account={id:'alice'};chats=rows;deletedChats=deleted; },
    configure(thread) { current=thread; selected={providerId:'fixture',modelId:'fixture',model:{}}; }};`), {
    window, document: { getElementById: el, createElement: make, addEventListener() {} }, TextDecoder,
    localStorage:storage,structuredClone,AbortSignal,AbortController,DOMException,Headers,
    fetch: clock.fetch || (() => { throw Error('unexpected model/network call'); }),
    setTimeout: clock.setTimeout || ((fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }),
    clearTimeout: clock.clearTimeout || clearTimeout,
  });
  t.after(() => timers.forEach(clearTimeout));
  return Object.assign(window.chatTest.readStream, window.chatTest, { el, storage });
}
function response(text) {
  let closed = false, controller;
  const body = new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(text)); }, cancel() { closed = true; } });
  return { value: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), closed: () => closed,
    push: text => controller.enqueue(new TextEncoder().encode(text)) };
}
const deadline = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('terminal event remained pending')), 500); promise.finally(() => clearTimeout(timer)).catch(() => {}); })]);

test('browser settles final result without waiting for HTTP EOF, preserving received text and receipt', async t => {
  const read = runtime(t), r = response('event: delta\ndata: {"text":"已生成"}\n\nevent: result\ndata: {"reply":"完整正文","turnUsage":{"weeklyPoints":30}}\n\n');
  const deltas = [], result = await deadline(read(r.value, text => deltas.push(text), () => {}));
  assert.deepEqual(deltas, ['已生成']); assert.equal(result.reply, '完整正文'); assert.equal(result.turnUsage.weeklyPoints, 30); assert.equal(r.closed(), true);
});
test('browser terminal error without EOF exits promptly with receipt; partial text remains', async t => {
  const read = runtime(t), r = response('event: delta\ndata: {"text":"部分正文"}\n\nevent: error\ndata: {"error":{"message":"服务繁忙"},"turnUsage":{"weeklyPoints":15}}\n\n'), deltas = [];
  await assert.rejects(deadline(read(r.value, text => deltas.push(text), () => {})), error => error.message === '服务繁忙' && error.turnUsage.weeklyPoints === 15);
  assert.deepEqual(deltas, ['部分正文']); assert.equal(r.closed(), true);
});
test('silent connection watchdog resets on heartbeats and cancels without erasing partial text', async t => {
  const timers = new Map(); let next = 0;
  const read = runtime(t, { setTimeout(fn, ms) { assert.equal(ms, 120000); timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); } });
  const r = response('event: delta\ndata: {"text":"已收到正文"}\n\n'), deltas = [];
  const pending = read(r.value, text => deltas.push(text), () => {});
  await new Promise(resolve => setImmediate(resolve)); const first = next;
  r.push(': heartbeat\n\n'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(timers.has(first), false); assert.ok(next > first);
  timers.get(next)();
  await assert.rejects(pending, /连接长时间未收到数据/);
  assert.deepEqual(deltas, ['已收到正文']); assert.equal(r.closed(), true); assert.equal(timers.size, 0);
});
test('EOF without final result remains an explicit incomplete reply', async t => {
  const read = runtime(t), r = new Response('event: delta\ndata: {"text":"前缀"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const deltas = []; await assert.rejects(read(r, text => deltas.push(text), () => {}), /未收到完整回复/); assert.deepEqual(deltas, ['前缀']);
});
test('中断的原问题与部分回复保留为后续上下文，空白助手消息不发送',t=>{
  const api=runtime(t),thread={messages:[{role:'user',content:'请写出代码',failed:true},{role:'assistant',content:'int main() {',failed:true},{role:'user',content:'补充解释',failed:true},{role:'assistant',content:'',failed:true}]};
  const history=api.historyFor(thread,false);
  assert.equal(history.length,3);assert.equal(history[0].content,'请写出代码');assert.match(history[1].content,/int main\(\)/);assert.match(history[1].content,/中断前的部分回复/);assert.equal(history[2].content,'补充解释');
});
test('长代码上下文保留末尾可续写位置，仍遵守每条4000字符与20条上限',t=>{
  const api=runtime(t),text='开头声明\n'+'中'.repeat(7000)+'\n最后代码位置 84276';
  const history=api.historyFor({messages:[...Array.from({length:25},(_,i)=>({role:'user',content:String(i)})),{role:'assistant',content:text,failed:true}]},false);
  assert.equal(history.length,20);assert.ok(history.every(item=>item.content.length<=4000));assert.match(history.at(-1).content,/开头声明/);assert.match(history.at(-1).content,/最后代码位置 84276/);
});
test('无正文时发送继续仅恢复原问题，不发起请求或增加对话',async t=>{
  const api=runtime(t),thread={messages:[{role:'user',content:'根据PDF生成完整代码',failed:true},{role:'assistant',content:'',failed:true}]};
  api.configure(thread);api.el('chatInput').value='继续';
  await api.submit({preventDefault(){}});
  assert.equal(thread.messages.length,2);assert.equal(api.el('chatInput').value,'根据PDF生成完整代码');assert.match(api.el('composerStatus').textContent,/已恢复原问题/);
});
test('部分回复可以继续，恢复按钮只填入问题且不覆盖新草稿',t=>{
  const api=runtime(t),question={role:'user',content:'原问题'},partial={role:'assistant',content:'部分正文',failed:true};
  assert.equal(api.unansweredQuestion({messages:[question,partial]}),null);
  const empty={role:'assistant',content:'',failed:true},thread={messages:[question,empty]},buttons=[];
  api.configure(thread);api.addRecoveryAction({appendChild:button=>buttons.push(button)},empty,thread);
  assert.equal(buttons.length,1);api.el('chatInput').value='正在编辑的新问题';buttons[0].onclick();assert.equal(api.el('chatInput').value,'正在编辑的新问题');
  api.el('chatInput').value='';buttons[0].onclick();assert.equal(api.el('chatInput').value,'原问题');assert.equal(thread.messages.length,2);
});
test('刷新后的中断首轮恢复PDF参考文档，显式移除的上下文保持为空',t=>{
  const api=runtime(t),doc={id:require('node:crypto').randomUUID(),name:'reference.pdf',type:'pdf',size:100,text:'文档正文',pages:31};
  const thread={messages:[{role:'user',content:'请分析附件',documents:[doc]},{role:'assistant',content:'',pending:true}]};
  api.recoverThread(thread);assert.equal(thread.documents.length,1);assert.equal(thread.documents[0].pages,31);assert.match(thread.messages[1].notice,/没有可恢复的回复正文/);assert.doesNotMatch(thread.messages[1].notice,/未保存/);
  thread.documents=[];api.recoverThread(thread);assert.equal(thread.documents.length,0);
});
test('旧版空白提示迁移但不声称曾经生成正文；不接受损坏附件',t=>{
  const api=runtime(t),thread={messages:[{role:'user',content:'旧问题',documents:[{id:'bad'}]},{role:'assistant',content:'',notice:'上次回复未保存到内容，请重新发送。'}]};
  api.recoverThread(thread);assert.match(thread.messages[1].notice,/请求已中断/);assert.equal(thread.documents,undefined);
});
test('刷新保留服务器任务的待完成状态；累积快照替换正文而不是重复追加',async t=>{
  const api=runtime(t),item={role:'assistant',content:'首段',pending:true,taskId:require('node:crypto').randomUUID()};
  api.recoverThread({messages:[item]});assert.equal(item.pending,true);assert.equal(item.failed,undefined);assert.equal(item.notice,undefined);
  const r=response('event: snapshot\ndata: {"reply":"首段","status":"running"}\n\nevent: snapshot\ndata: {"reply":"首段后续","status":"running"}\n\nevent: result\ndata: {"reply":"首段后续"}\n\n');
  let body='';await api(r.value,()=>assert.fail('server snapshots must not be deltas'),()=>{},snapshot=>body=snapshot.reply);assert.equal(body,'首段后续');
});
test('旧标签页保存待完成快照时，不覆盖另一个标签页已保存的完整任务',async t=>{
  const api=runtime(t),taskId=require('node:crypto').randomUUID(),key='diagramai.pureChat.v1.alice';
  api.storage.setItem(key,JSON.stringify([{id:'thread',messages:[{role:'assistant',taskId,taskAccepted:true,pending:false,content:'完整结果'}]}]));
  api.configureStorage([{id:'thread',messages:[{role:'assistant',taskId,taskAccepted:true,pending:true,content:'旧片段'}]}]);assert.equal(await api.saveChats(),true);
  assert.equal(JSON.parse(api.storage.getItem(key))[0].messages[0].content,'完整结果');assert.equal((await api.savedTaskReply(taskId)).content,'完整结果');
});
test('只有浏览器持久保存成功才确认清理服务器结果，存储失败保留副本',async t=>{
  let calls=0;const rows=[{id:'thread',messages:[{taskId:require('node:crypto').randomUUID(),taskAccepted:true,pending:false,content:'完整结果'}]}];
  const api=runtime(t,{fetch:async(url,options)=>{assert.match(url,/\/ack$/);assert.equal(options.method,'POST');calls++;return new Response('{}',{status:200});}});
  api.configureStorage(rows);assert.equal(await api.saveChats(),true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  const failed=runtime(t,{storage:{getItem:()=>null,setItem:()=>{throw Error('full');}},fetch:()=>assert.fail('must not acknowledge unsaved output')});failed.configureStorage(rows);assert.equal(await failed.saveChats(),false);
});
test('两个旧标签页分别保存时，保留已确认清理服务器的新回复和双方新会话',async t=>{
  const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
  const request=async()=>new Response('{}'),a=runtime(t,{storage,fetch:request}),b=runtime(t,{storage,fetch:request}),taskId=require('node:crypto').randomUUID();
  const initial={id:'existing',messages:[{id:'q',role:'user',content:'原问题'}]},reply={id:'a',role:'assistant',taskId,taskAccepted:true,pending:false,content:'已保存的新回复'};
  b.configureStorage([initial,{id:'new-b',messages:[{id:'b',role:'user',content:'B的新对话'}]}]);
  a.configureStorage([{...initial,messages:[...initial.messages,reply]},{id:'new-a',messages:[{id:'c',role:'user',content:'A的新对话'}]}]);
  assert.equal(await a.saveChats(),true);assert.equal(await b.saveChats(),true);
  const rows=JSON.parse(storage.getItem('diagramai.pureChat.v1.alice'));assert.equal(rows.length,3);assert.equal(rows.find(row=>row.id==='existing').messages.at(-1).content,'已保存的新回复');
});
test('明确删除持久保存后，旧页面的保存不能复活会话，删除的内容不再确认清理',async t=>{
  const data=new Map(),storage={getItem:key=>data.get(key)||null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)},acks=[];
  const row={id:'deleted-thread',messages:[{id:'a',role:'assistant',taskId:require('node:crypto').randomUUID(),taskAccepted:true,pending:false,content:'已删除正文'}]};
  storage.setItem('diagramai.pureChat.v1.alice',JSON.stringify([row]));
  const a=runtime(t,{storage,fetch:async url=>{acks.push(url);return new Response('{}');}});a.configureStorage([row],{'deleted-thread':100});assert.equal(await a.saveChats(),true);
  const b=runtime(t,{storage,fetch:async url=>{acks.push(url);return new Response('{}');}});b.configureStorage([row]);assert.equal(await b.saveChats(),true);
  assert.deepEqual(JSON.parse(storage.getItem('diagramai.pureChat.v1.alice')),[]);assert.equal(acks.length,0);assert.equal(JSON.parse(storage.getItem('diagramai.pureChat.v1.deleted.alice'))['deleted-thread'],100);
});
test('旧页面删除时核对最新存储，不删除另一个页面正在生成的对话',async t=>{
  const api=runtime(t),row={id:'active',messages:[{id:'a',role:'assistant',taskId:require('node:crypto').randomUUID(),pending:true,content:'正在生成'}]};
  api.storage.setItem('diagramai.pureChat.v1.alice',JSON.stringify([row]));api.configureStorage([],{'active':100});assert.equal(await api.saveChats(),false);
  assert.equal(JSON.parse(api.storage.getItem('diagramai.pureChat.v1.alice'))[0].id,'active');assert.equal(api.storage.getItem('diagramai.pureChat.v1.deleted.alice'),null);assert.match(api.el('composerStatus').textContent,/另一个页面生成/);
});
test('被历史数量限制裁掉的结果不能发送清理确认',async t=>{
  const calls=[],api=runtime(t,{fetch:async route=>{calls.push(route);return new Response('{}');}});
  const rows=[{id:'old',updatedAt:1,messages:[{role:'assistant',content:'旧结果',taskId:require('node:crypto').randomUUID(),taskAccepted:true,pending:false}]},...Array.from({length:40},(_,i)=>({id:'new-'+i,updatedAt:i+2,messages:[{role:'user',content:'较新的对话'}]}))];
  api.configureStorage(rows);assert.equal(await api.saveChats(),true);await new Promise(setImmediate);assert.equal(JSON.parse(api.storage.getItem('diagramai.pureChat.v1.alice')).length,40);assert.equal(calls.length,0);
});
