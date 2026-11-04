'use strict';
// Local browser fixture. No model credentials or requests leave this process.
const http=require('node:http');
const dns=require('node:dns').promises,lookup=dns.lookup;
dns.lookup=(host,options)=>host==='api.fixture.example'?Promise.resolve([{address:'8.8.8.8',family:4}]):lookup(host,options);
const service=require('../../lib/model-service'),originalCall=service.callWithLock;
let gatewayBase,gatewayCalls=0,cancelledCalls=0,nextMode='success',lastRequestHasDocument=false;
service.callWithLock=(lock,messages,timeout,options)=>originalCall({...lock,baseUrl:gatewayBase},messages,timeout,{...options,networkPolicy:false});
const {createServer,cloudRuntime:cloud}=require('../../server');
const outline={version:1,title:'校园图书借阅系统',summary:'读者查找图书、判断库存并办理借阅；库存不足时登记预约。',
 flowchart:{nodes:[{id:'start',label:'读者发起借阅',type:'start'},{id:'search',label:'查找图书',type:'process'},{id:'stock',label:'是否有可借库存？',type:'decision'},{id:'borrow',label:'办理借阅',type:'process'},{id:'reserve',label:'登记预约',type:'process'},{id:'end',label:'处理完成',type:'end'}],edges:[{source:'start',target:'search',label:''},{source:'search',target:'stock',label:''},{source:'stock',target:'borrow',label:'有库存'},{source:'stock',target:'reserve',label:'无库存'},{source:'borrow',target:'end',label:''},{source:'reserve',target:'end',label:''}]},
 architecture:{layers:[{id:'presentation',label:'用户层',nodes:[{id:'reader',label:'读者端',description:'检索、借阅与预约'}]},{id:'services',label:'业务层',nodes:[{id:'catalog',label:'图书检索',description:'查询图书与库存'},{id:'circulation',label:'借阅服务',description:'办理借阅和预约'}]},{id:'storage',label:'数据层',nodes:[{id:'database',label:'图书与借阅数据库',description:'保存图书和借阅记录'}]}],edges:[{source:'reader',target:'catalog',label:'检索'},{source:'reader',target:'circulation',label:'借阅/预约'},{source:'catalog',target:'database',label:'查询'},{source:'circulation',target:'database',label:'读写'}]},assumptions:['借阅期限尚未明确，请确认后补充。']};
const editor=`<!doctype html><html><body style="background:#fafbf8;font:14px system-ui;color:#7c897c"><p>本地编辑器协议测试</p><script>let xml='';const send=data=>parent.postMessage(JSON.stringify(data),'*');addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}if(m.action==='load'){xml=m.xml;send({event:'load',xml,currentPage:0});}if(m.action==='viewbox')send({event:'viewbox',currentPage:0,message:m});if(m.action==='getDiff')send({event:'getDiff',xml,message:m});});send({event:'init'});</script></body></html>`;
(async()=>{
 const gateway=http.createServer((req,res)=>{let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
  const body=JSON.parse(raw||'{}');gatewayCalls++;lastRequestHasDocument=JSON.stringify(body.messages||[]).includes('图书借阅需求.txt');const mode=nextMode;nextMode='success';
  if(mode==='reject'){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'本地模拟：模型暂时不可用'}}));return;}
  if(mode==='hang'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write(': waiting\n\n');res.once('close',()=>{if(!res.writableEnded)cancelledCalls++;});return;}
  const content=mode==='malformed'?'这不是可确认的结构':JSON.stringify(outline),usage={prompt_tokens:100,completion_tokens:100,total_tokens:200};
  if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content},finish_reason:'stop'}],usage})+'\n\ndata: [DONE]\n\n');}
  else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage}));}
 });});await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));gatewayBase='http://127.0.0.1:'+gateway.address().port;
 await cloud.platform.createProvider({providerId:'workflow',name:'本地需求分析模型',baseUrl:'https://api.fixture.example',protocol:'openai-chat-completions',apiKey:'fixture-only-key'});
 await cloud.platform.addModel('workflow',{modelId:'requirements-fixture',displayName:'需求分析演示',capabilityProfile:'custom',reasoningLevels:['low']});
 const app=createServer();
 const server=http.createServer((req,res)=>{
  if(req.url==='/fixture-stats'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({gatewayCalls,cancelledCalls,lastRequestHasDocument}));return;}
  if(req.url.startsWith('/fixture-mode?')){const mode=new URL(req.url,'http://fixture').searchParams.get('value');if(!['success','reject','hang','malformed'].includes(mode)){res.writeHead(400);res.end('bad mode');return;}nextMode=mode;res.end('ok');return;}
  if(req.url.startsWith('/fixture-editor')){res.writeHead(200,{'Content-Type':'text/html'});res.end(editor);return;}
  app.emit('request',req,res);
 });server.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('REQUIREMENTS_FIXTURE_READY'));
 const close=()=>{gateway.closeAllConnections();server.closeAllConnections();server.close();gateway.close();};process.once('SIGTERM',()=>{close();process.exit(0);});
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
