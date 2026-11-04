'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {create} = require('../../public/drawing-tasks');
const {createParser} = require('../../lib/sse');
const terminal = {taskId:'12345678-1234-1234-1234-123456789abc',status:'succeeded',xml:'<complete/>',reply:'done'};
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const sse = values => new Response(values.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
test('恢复任务仅GET，完整XML和元数据透传，终态snapshot无需等待HTTP连接关闭',async()=>{
 const calls=[];let cancelled=false;
 const client=create({createParser,fetch:async(path,init)=>{calls.push([path,init.method]);if(!path.endsWith('/events'))return json({task:{...terminal,status:'running',xml:undefined}});return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('event: snapshot\ndata: '+JSON.stringify(terminal)+'\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});}});
 assert.deepEqual(await client.follow(terminal),terminal);assert.deepEqual(calls.map(x=>x[1]),[undefined,undefined]);assert.equal(cancelled,true);
});
test('POST响应丢失后查询同ID，不重试模型调用；断线SSE重新连接',async()=>{
 const calls=[];let feeds=0;
 const client=create({createParser,retryMs:1,fetch:async(path,init)=>{calls.push([path,init.method]);if(init.method==='POST')throw Error('response lost');if(path.endsWith('/events')){if(!feeds++)throw Error('network break');return sse([['result',terminal]]);}return json({task:{...terminal,status:'running'}});}});
 assert.deepEqual(await client.follow(terminal,{body:{taskId:terminal.taskId}}),terminal);assert.equal(calls.filter(x=>x[1]==='POST').length,1);assert.equal(feeds,2);
});
test('404模糊接收不自动重POST，保留可恢复状态',async()=>{
 const calls=[];
 const client=create({createParser,retryMs:1,fetch:async(path,init)=>{calls.push(init.method);return json({error:{message:'unknown'}},404);}});
 await assert.rejects(client.follow(terminal),e=>e.taskUnconfirmed===true);assert.equal(calls.length,4);assert.ok(calls.every(x=>x===undefined));
});
test('生成失败/取消透传终态和扣点，不额外调用或隐式ACK',async()=>{
 const calls=[];const receipt={weeklyPoints:0};
 const client=create({createParser,fetch:async(path,init)=>{calls.push(path);return json({task:{...terminal,status:'cancelled',error:{code:'task-cancelled',message:'cancelled'},turnUsage:receipt}});}});
 await assert.rejects(client.follow(terminal),e=>e.taskTerminal&&e.code==='task-cancelled'&&e.turnUsage.weeklyPoints===0);assert.equal(calls.length,1);
});
test('页面detach只断开读取；显式cancel和ACK为独立POST',async()=>{
 const paths=[];const controller=new AbortController();
 const client=create({createParser,fetch:async(path,init)=>{paths.push([path,init.method]);if(path.endsWith('/cancel')||path.endsWith('/ack'))return json({released:true});controller.abort();throw Error('detach');}});
 await assert.rejects(client.follow(terminal,{signal:controller.signal}));assert.equal(paths.length,1);await client.cancel(terminal.taskId);await client.acknowledge(terminal.taskId);assert.deepEqual(paths.slice(1).map(x=>[x[0].split('/').at(-1),x[1]]),[['cancel','POST'],['ack','POST']]);
});
