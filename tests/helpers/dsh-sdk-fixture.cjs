'use strict';
const readline = require('node:readline'), fs = require('node:fs'), path = require('node:path');
let sessionId, history=[];
const historyFile=path.join(process.env.DSH_HOME,'fixture-history.json');
const write = frame => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const event=(id,text,type='assistant/message')=>write({method:'session.event',params:{sessionId:id,event:{type,data:type==='assistant/message'?{message:{content:[{type:'text',text}]}}:{interrupted:true}}}});
readline.createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line), reply = result => write({ id: frame.id, result });
  if (frame.method === 'initialize') {
    if(process.env.SDK_FIXTURE_SETTINGS_FILE)fs.appendFileSync(process.env.SDK_FIXTURE_SETTINGS_FILE,JSON.stringify({model:frame.params.model,envModel:process.env.DIAGRAM_AGENT_MODEL,credential:process.env.DIAGRAM_AGENT_API_KEY})+'\n');
    reply({ serverInfo: { name: 'deepseek-harness-sdk-runtime', version: 'fixture' } });
  }
  else if (frame.method === 'session/resume') {
    sessionId=frame.params.sessionId;
    if(process.env.SDK_FIXTURE_STALE_RESUME_EVENTS){event(sessionId,'old answer from first turn');event(sessionId,'','error');}
    if(process.env.SDK_FIXTURE_RESUME_ERROR || !fs.existsSync(historyFile)) return write({id:frame.id,error:{code:-32603,message:'Session not found'}});
    history=JSON.parse(fs.readFileSync(historyFile,'utf8'));reply({});
  }
  else if (frame.method === 'session/prompt') {
    sessionId = frame.params.sessionId;
    history.push(frame.params.contentBlocks.map(block=>block.text).join(''));fs.writeFileSync(historyFile,JSON.stringify(history));
    if(process.env.SDK_FIXTURE_CALLS_FILE)fs.appendFileSync(process.env.SDK_FIXTURE_CALLS_FILE,JSON.stringify({method:frame.method,sessionId,prompt:history.at(-1)})+'\n');
    reply({ messageId: 'message-'+history.length });
  }
  else if (frame.method === 'session/wait') setTimeout(() => {
    event('other-session','private other output');
    const output=process.env.SDK_FIXTURE_CONTEXT?JSON.stringify(history):'confirmed response '+process.env.DIAGRAM_AGENT_API_KEY;
    if(process.env.SDK_FIXTURE_USAGE){
      const usages=JSON.parse(process.env.SDK_FIXTURE_USAGE),turn=history.length;let seq=0;
      const durable=(type,data)=>{const value={method:'session.event',params:{sessionId,event:{seq:++seq,type,data:{turn,...data}}}};write(value);if(process.env.SDK_FIXTURE_DUPLICATE_USAGE && type==='assistant/message')write(value);};
      durable('turn/start',{});
      usages.forEach((usage,index)=>{const step=index+1;durable('step/start',{step});durable('assistant/message',{step,message:{content:index===usages.length-1&&!process.env.SDK_FIXTURE_NO_OUTPUT?[{type:'text',text:output}]:[]},...(usage?{usage}:{})});});
      durable('turn/end',{});
    }else if(!process.env.SDK_FIXTURE_NO_OUTPUT)event(sessionId,output);
    reply({});
  }, Number(process.env.SDK_FIXTURE_DELAY || 20));
  else if (frame.method === 'shutdown' && !process.env.SDK_FIXTURE_IGNORE_SHUTDOWN) { reply({}); setTimeout(() => process.exit(0), 1); }
});
