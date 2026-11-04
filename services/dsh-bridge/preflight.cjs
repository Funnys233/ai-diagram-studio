'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createSdkAdapter}=require('./sdk-adapter');
const root=__dirname;let diagnostic='';
const denied=folder=>{try{fs.readdirSync(folder);return false;}catch(error){return ['EPERM','EACCES'].includes(error.code);}};
const result={at:new Date().toISOString(),modelRequests:0,qqDirectoryDenied:denied('C:\\qq-bridge'),oldRuntimeDenied:denied('C:\\tools\\node'),bridgeSecretsDenied:denied('C:\\ProgramData\\DiagramSiteDsh')};
(async()=>{
 const adapter=createSdkAdapter({node:path.join(root,'node.exe'),runtime:path.join(root,'dsh/lib/bin.js'),patch:path.join(root,'site-profile.patch.yml'),directory:path.join(root,'workspaces'),model:'gpt-6-luna',requestTimeoutMs:45000,onDiagnostic:text=>{diagnostic=(diagnostic+text).slice(-10000);}});
 try{const info=await adapter.check(crypto.randomUUID());Object.assign(result,{ok:true,sdkIdentity:info.name,sdkVersion:info.version});}
 catch{Object.assign(result,{ok:false,diagnostic});}
 fs.writeFileSync(path.join(root,'home/preflight.json'),JSON.stringify(result),{mode:0o600});
 process.exitCode=result.ok&&result.qqDirectoryDenied&&result.oldRuntimeDenied&&result.bridgeSecretsDenied?0:1;
})().catch(()=>{process.exitCode=1;});
