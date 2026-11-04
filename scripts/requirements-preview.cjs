'use strict';
// Isolated local preview. Only this explicitly labelled provider is simulated;
// any provider a user configures separately continues through the real adapter.
const path=require('node:path'),fs=require('node:fs'),http=require('node:http');
const root=path.resolve(__dirname,'..'),directory=path.join(root,'.private-preview/requirements-preview');
const port=Number(process.env.REQUIREMENTS_PREVIEW_PORT||8091);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('预览端口不合法');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
Object.assign(process.env,{APP_MODE:'local',HOST:'127.0.0.1',PORT:String(port),PROVIDERS_CONFIG_PATH:path.join(directory,'providers.json'),DEEPSEEK_API_KEY:'',REQUIREMENTS_PREVIEW:'true'});
const service=require('../lib/model-service'),original=service.callWithLock;
let gatewayBase;
service.callWithLock=(lock,messages,timeout,options)=>original(lock.providerId==='requirements-preview'?{...lock,baseUrl:gatewayBase}:lock,messages,timeout,options);
const {createServer}=require('../server');
const outline=JSON.parse(fs.readFileSync(path.join(root,'examples/requirements-library.json'),'utf8'));
(async()=>{
 // Seed via the server's store API so its in-memory catalog is updated too.
 const app=createServer();
 const gateway=http.createServer((req,res)=>{
  let bytes=0;req.on('data',chunk=>{bytes+=chunk.length;if(bytes>1200000)req.destroy();});
  req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(outline)},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}));});
 });
 await new Promise((resolve,reject)=>{gateway.once('error',reject);gateway.listen(0,'127.0.0.1',resolve);});gatewayBase='http://127.0.0.1:'+gateway.address().port;
 await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(port,'127.0.0.1',resolve);});
 const origin='http://127.0.0.1:'+port;
 async function api(route,body,method='POST'){
  const response=await fetch(origin+route,{method,headers:{Origin:origin,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw Error(data.error?.message||'初始化预览失败');return data;
 }
 const catalog=await api('/api/models/catalog',undefined,'GET');
 if(!catalog.providers.some(p=>p.providerId==='requirements-preview')){
  await api('/api/providers',{providerId:'requirements-preview',name:'本地示例模型',baseUrl:'https://requirements-preview.invalid',protocol:'openai-chat-completions',apiKey:'preview-not-a-real-key'});
  await api('/api/providers/requirements-preview/models',{modelId:'requirements-example',displayName:'本地示例模型（固定图书借阅示例）',isDefault:true});
 }
 console.log('本地文档成图预览：'+origin+'/requirements.html');
 console.log('默认示例模型只返回固定图书借阅示例，不访问模型服务、不消耗真实额度。');
 const close=()=>{app.closeAllConnections();gateway.closeAllConnections();app.close();gateway.close();};process.once('SIGTERM',close);process.once('SIGINT',close);
})().catch(error=>{console.error(error.message);process.exitCode=1;process.exit(1);});
