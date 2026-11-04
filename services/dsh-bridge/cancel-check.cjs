'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createSdkAdapter}=require('./sdk-adapter');
const root=__dirname;
(async()=>{
 const adapter=createSdkAdapter({node:path.join(root,'node.exe'),runtime:path.join(root,'dsh/lib/bin.js'),patch:path.join(root,'site-profile.patch.yml'),directory:path.join(root,'workspaces'),model:'gpt-6-luna'});
 const sessionId=crypto.randomUUID();
 const checking=adapter.check(sessionId).then(()=>false,()=>true);
 await new Promise(resolve=>setTimeout(resolve,50));
 const result=await adapter.cancel({sessionId});const interrupted=await checking;
 await adapter.release({sessionId});
 const report={at:new Date().toISOString(),stopped:result.stopped===true,checkInterrupted:interrupted,modelRequests:0,workspaceRemoved:!fs.existsSync(path.join(root,'workspaces',sessionId))};
 fs.writeFileSync(path.join(root,'home/cancel-check.json'),JSON.stringify(report),{mode:0o600});
 process.exitCode=report.stopped&&report.checkInterrupted&&report.workspaceRemoved?0:1;
})().catch(()=>{fs.writeFileSync(path.join(root,'home/cancel-check.json'),JSON.stringify({ok:false,modelRequests:0}),{mode:0o600});process.exitCode=1;});
