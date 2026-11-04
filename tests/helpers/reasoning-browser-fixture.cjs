// Browser fixture: real preference endpoints and local editor protocol; no inference.
const http=require('node:http');
const {createServer,cloudRuntime:cloud}=require('../../server');
(async()=>{
 await cloud.platform.createProvider({providerId:'fixture',name:'测试模型',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-only'});
 await cloud.platform.addModel('fixture',{modelId:'Qwen/Qwen3.8-27B',displayName:'Qwen 三档',thinkingMode:'enable-thinking-on',visionInput:true});
 await cloud.platform.addModel('fixture',{modelId:'fixture-light',displayName:'精简两档',thinkingMode:'enable-thinking-on',capabilityProfile:'custom',reasoningLevels:['low','high']});
 await cloud.platform.addModel('fixture',{modelId:'fixture-full',displayName:'完整五档',thinkingMode:'enable-thinking-on',capabilityProfile:'custom',reasoningLevels:['low','medium','high','xhigh','max']});
 await cloud.platform.addModel('fixture',{modelId:'fixture-unknown',displayName:'未配置强度',thinkingMode:'enable-thinking-on'});
 const app=createServer();let failNext=false,preferenceWrites=0;
 const server=http.createServer((req,res)=>{
  if(req.url==='/fixture-stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({preferenceWrites}));return;}
  if(req.url==='/api/preferences'&&req.method==='PUT')preferenceWrites++;
  if(req.url==='/fixture-fail-next'){failNext=true;res.end('ok');return;}
  if(req.url==='/api/preferences'&&req.method==='PUT'&&failNext){failNext=false;req.resume();res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{code:'stale-config',message:'模拟保存冲突'}}));return;}
  if(req.url.startsWith('/fixture-editor')){res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><html><body style="background:#fafbf8;font:14px system-ui;color:#7c897c"><p>编辑器协议测试</p><script>let xml='';const send=data=>parent.postMessage(JSON.stringify(data),'*');addEventListener('message',event=>{let message;try{message=JSON.parse(event.data);}catch{return;}if(message.action==='load'){xml=message.xml;send({event:'load',xml,currentPage:0});}if(message.action==='viewbox')send({event:'viewbox',currentPage:0,message});if(message.action==='getDiff')send({event:'getDiff',xml,message});});send({event:'init'});</script></body></html>`);return;}
  app.emit('request',req,res);
 });
 server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('REASONING_FIXTURE_READY'));
})().catch(error=>{console.error(error.message);process.exit(1);});
