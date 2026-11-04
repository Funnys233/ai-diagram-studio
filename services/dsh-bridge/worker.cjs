'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createBridge}=require('./bridge');
const {createSdkAdapter}=require('./sdk-adapter');
const root=__dirname,folder=path.join(root,'home');
let bridge;
(async()=>{
 const settings=JSON.parse(fs.readFileSync(path.join(root,'model.json'),'utf8'));
 const token=fs.readFileSync(path.join(root,'bridge.token'),'utf8').trim();
 const concurrency=process.env.DSH_MAX_CONCURRENT===undefined?6:Number(process.env.DSH_MAX_CONCURRENT);
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>6)throw Error('Invalid DSH concurrency');
 if(typeof settings.model!=='string'||!settings.model||settings.model.length>200||/[\x00-\x1f]/.test(settings.model)||typeof settings.apiKey!=='string'||settings.apiKey.length<8)throw Error('Invalid model setup');
 let diagnostic='';
 const adapter=createSdkAdapter({node:path.join(root,'node.exe'),runtime:path.join(root,'dsh/lib/bin.js'),patch:path.join(root,'site-profile.patch.yml'),directory:path.join(root,'workspaces'),provider:'diagram-site',model:settings.model,apiKey:token,baseURL:settings.baseURL,enableFiles:true,onDiagnostic:text=>{
  diagnostic=(diagnostic+text.replaceAll(settings.apiKey,'[hidden]').replaceAll(token,'[hidden]')).slice(-6000);
  fs.writeFileSync(path.join(folder,'sdk-diagnostic.txt'),diagnostic,{mode:0o600});
 }});
 bridge=createBridge({stateDir:path.join(folder,'bridge-state'),token,adapter,maxConcurrent:concurrency,recoverStaleLock:true,timeoutMs:12*60*1000});
 await bridge.listen(47318);
 fs.writeFileSync(path.join(folder,'bridge-ready.json'),JSON.stringify({pid:process.pid,at:new Date().toISOString(),mode:'adapter',model:settings.model,concurrency}),{mode:0o600});
 const stop=async()=>{await bridge.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
})().catch(()=>{fs.writeFileSync(path.join(folder,'worker-error.json'),JSON.stringify({at:new Date().toISOString(),error:'startup-failed'}),{mode:0o600});process.exitCode=1;});
