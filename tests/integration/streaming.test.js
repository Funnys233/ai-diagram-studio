const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.PROVIDERS_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(),'diagram-stream-')),'providers.json');
process.env.DEEPSEEK_API_KEY = '';
process.env.REQUEST_TIMEOUT_MS = '600';
const {createServer} = require('../../server');
const {sampleModel} = require('../helpers/fixtures');
const {createParser} = require('../../lib/sse');
const XML = sampleModel();
const SECRET = 'sk-stream-secret-never-return';
let app, upstream, base, mode='ok', calls=[], closed=0;
const waitUntil = async predicate => {
  for(let i=0;i<100;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}
  throw new Error('等待条件超时');
};
const event = data => `data: ${JSON.stringify(data)}\n\n`;
test.before(async()=>{
  upstream=http.createServer((req,res)=>{
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      const body=JSON.parse(raw);calls.push({body,url:req.url,headers:req.headers});
      if(mode==='json'){
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify({choices:[{message:{content:XML},finish_reason:'stop'}]}));
      }
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();
      if(mode==='hang'||(mode==='retry-hang'&&calls.length===2)){
        res.write(': keep alive\n\n');res.on('close',()=>closed++);return;
      }
      if(mode==='error')return res.end(event({error:{message:SECRET+' unavailable'}}));
      if(req.url==='/v1/messages'){
        return res.end([
          {type:'message_start',message:{model:'claude',usage:{input_tokens:10}}},
          {type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private reasoning'}},
          {type:'content_block_delta',delta:{type:'text_delta',text:XML}},
          {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:20}},
          {type:'message_stop'},
        ].map(event).join(''));
      }
      const output=(mode==='retry'||mode==='retry-hang')&&calls.length===1?'<mxGraphModel>':XML;
      const frames=[event({model:'m',choices:[{index:0,delta:{reasoning_content:'private reasoning'}}]}),
        event({choices:[{index:0,delta:{content:output.slice(0,25)}}]}),
        event({choices:[{index:0,delta:{content:output.slice(25)}}]}),
        event({choices:[{index:0,delta:{},finish_reason:mode==='truncated'?'length':'stop'}]}),
        'data: [DONE]\n\n'];
      if(mode==='incomplete')return res.end(frames.slice(0,4).join(''));
      const bytes=Buffer.from(frames.join(''));
      // Split inside UTF-8 characters and SSE framing on a real socket.
      const timers=[];
      for(let offset=0;offset<bytes.length;offset+=11){const p=offset;timers.push(setTimeout(()=>res.write(bytes.subarray(p,p+11)),Math.floor(offset/200)+5));}
      timers.push(setTimeout(()=>res.end(),Math.floor(bytes.length/200)+20));
      res.on('close',()=>timers.forEach(clearTimeout));
    });
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  app=createServer();await new Promise(r=>app.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.address().port}`;
  for(const [id,protocol] of [['o','openai-chat-completions'],['a','anthropic-messages']]) {
    let res=await fetch(base+'/api/providers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerId:id,name:id,baseUrl:`http://127.0.0.1:${upstream.address().port}`,protocol,apiKey:SECRET})});
    assert.equal(res.status,201,await res.text());
    res=await fetch(base+`/api/providers/${id}/models`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelId:'m'})});
    assert.equal(res.status,201,await res.text());
  }
});
test.after(async()=>{
  for(const s of [app,upstream]){s.closeAllConnections();await new Promise(r=>s.close(r));}
});
const request = (providerId='o',signal) => fetch(base+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({stream:true,message:'画中文流程',providerId,modelId:'m'})});
const collect = async res => {
  const raw=await res.text(), events=[];
  createParser(e=>events.push({event:e.event,data:JSON.parse(e.data)})).push(raw);
  return {raw,events,result:events.find(e=>e.event==='result')?.data,error:events.find(e=>e.event==='error')?.data.error};
};
const reset = next=>{mode=next;calls=[];closed=0;};
test('OpenAI real SSE: states before validated final XML, UTF-8 preserved, no reasoning or partial XML in progress',async()=>{
  reset('ok');const response=await request();assert.match(response.headers.get('content-type'),/event-stream/);
  const r=await collect(response);
  assert.equal(r.result.xml,XML);assert.ok(!r.result.reply.includes('<mxGraphModel'));
  assert.equal(calls.length,1);assert.equal(calls[0].body.stream,true);
  assert.equal(calls[0].headers.authorization,'Bearer '+SECRET);
  const phases=r.events.filter(e=>e.event==='progress').map(e=>e.data.phase);
  assert.deepEqual(phases,['waiting','thinking','generating','validating']);
  assert.ok(!r.raw.includes('private reasoning'));
  assert.ok(r.events.filter(e=>e.event==='progress').every(e=>!e.data.xml&&!e.data.text));
  assert.equal(r.events.at(-1).event,'result');
});
test('Anthropic SSE: own headers/path and text/usage completion',async()=>{
  reset('ok');const r=await collect(await request('a'));
  assert.equal(r.result.xml,XML);assert.deepEqual(r.result.callInfo.usage,{input_tokens:10,output_tokens:20});
  assert.equal(calls[0].url,'/v1/messages');assert.equal(calls[0].headers['x-api-key'],SECRET);
  assert.ok(!r.raw.includes('private reasoning'));
});
test('JSON gateway response is consumed once, explicitly reports buffering',async()=>{
  reset('json');const r=await collect(await request());
  assert.equal(r.result.xml,XML);assert.equal(calls.length,1);
  assert.ok(r.events.some(e=>e.data.phase==='buffered'));
});
for(const [next,code] of [['incomplete','stream-incomplete'],['truncated','model-truncated'],['error','server-error'],['hang','timeout']]){
  test(`${next}: stream sends readable safe error and never a diagram result or retries`,async()=>{
    reset(next);const r=await collect(await request());
    assert.equal(r.result,undefined);assert.equal(r.error.code,code);
    assert.equal(calls.length,1);assert.ok(!r.raw.includes(SECRET));
  });
}
test('Invalid complete XML retries once with state/attempt reset and returns only the validated result',async()=>{
  reset('retry');const r=await collect(await request());
  assert.equal(calls.length,2);assert.equal(r.result.xml,XML);assert.equal(r.result.attempts,2);
  assert.ok(r.events.some(e=>e.data.phase==='waiting'&&e.data.attempt===2));
  assert.equal(r.events.filter(e=>e.event==='result').length,1);
});
for(const next of ['hang','retry-hang']){
  test(`Cancellation closes upstream socket during ${next}, without further calls`,async()=>{
    reset(next);const c=new AbortController();const res=await request('o',c.signal);
    const reading=res.text().catch(e=>e);
    await waitUntil(()=>calls.length===(next==='hang'?1:2));c.abort();
    await reading;await waitUntil(()=>closed===1);
    await new Promise(r=>setTimeout(r,30));
    assert.equal(calls.length,next==='hang'?1:2);
  });
}
