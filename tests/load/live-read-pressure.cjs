'use strict';
// Authenticated GET load only. No inference, model probes, uploads or admin writes.
const http=require('node:http'),fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict'),{performance}=require('node:perf_hooks');
const origin=new URL(process.env.PUBLIC_ORIGIN),agent=new http.Agent({keepAlive:true,maxSockets:28});
const pid=cp.execFileSync('systemctl',['show','diagram-studio','-p','MainPID','--value'],{encoding:'utf8'}).trim();
const ticks=Number(cp.execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}));
let cookie='',csrf='',peakRss=0,aborted=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function resource(){const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' '),status=fs.readFileSync('/proc/'+pid+'/status','utf8');const rss=Number(status.match(/^VmRSS:\s+(\d+)/m)[1])/1024;peakRss=Math.max(peakRss,rss);assert.ok(rss<384,'Production RSS exceeded 384 MiB; load stopped');return {cpuTicks:Number(stat[11])+Number(stat[12]),rssMiB:+rss.toFixed(2)};}
function request(route,body){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:8080,path:route,method:body===undefined?'GET':'POST',agent,headers:{Host:origin.host,Origin:origin.origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf})}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,raw}));});req.setTimeout(3000,()=>req.destroy(Error('request-timeout')));req.on('error',reject);req.end(body===undefined?undefined:JSON.stringify(body));});}
function summarize(rows){if(!rows.length)return {requests:0,p50Ms:null,p95Ms:null,maxMs:null,errors:0};const values=rows.map(row=>row.ms).sort((a,b)=>a-b);return {requests:rows.length,p50Ms:+values[Math.floor(values.length*.5)].toFixed(2),p95Ms:+values[Math.min(values.length-1,Math.floor(values.length*.95))].toFixed(2),maxMs:+values.at(-1).toFixed(2),errors:rows.filter(row=>row.status!==200).length};}
const report={kind:'production-authenticated-GET',at:new Date().toISOString(),transport:'server loopback HTTP; excludes public network and TLS',externalModelCalls:0,phases:[]};
(async()=>{
 assert.equal((await request('/healthz')).status,200);const login=await request('/api/auth/login',{username:process.env.CLOUD_ADMIN_USERNAME,password:process.env.CLOUD_ADMIN_PASSWORD});assert.equal(login.status,200);cookie=login.headers['set-cookie'][0].split(';')[0];csrf=JSON.parse(login.raw).csrf;
 const routes=['/api/auth/session','/api/conversation/models','/api/usage','/chat.html','/topbar-toggle.js'];
 report.before=resource();
 for(const concurrency of [6,12,24]){
  const rows=[],before=resource(),started=performance.now();
  await Promise.all(Array.from({length:concurrency},async(_,worker)=>{for(let round=0;round<50&&!aborted;round++){const start=performance.now(),route=routes[(worker+round)%routes.length];try{const res=await request(route);const ms=performance.now()-start;rows.push({route,status:res.status,ms});if(res.status!==200||ms>1000){aborted=true;break;}resource();await delay(Math.max(0,100-(performance.now()-start)));}catch(error){aborted=true;rows.push({route,status:0,ms:performance.now()-start,error:error.message});break;}}}));
  const elapsed=(performance.now()-started)/1000,after=resource(),phase={concurrency,...summarize(rows),durationSeconds:+elapsed.toFixed(2),requestsPerSecond:+(rows.length/elapsed).toFixed(1),averageCpuPercentOfOneCore:+(((after.cpuTicks-before.cpuTicks)/ticks)/elapsed*100).toFixed(2)};
  phase.endpoints=Object.fromEntries(routes.map(route=>[route,summarize(rows.filter(row=>row.route===route))]));report.phases.push(phase);console.log(JSON.stringify({phase:'live-read-stage',...phase}));assert.ok(!aborted,'Load stopped after an error, a >1s response or memory threshold');assert.equal((await request('/healthz')).status,200);await delay(500);
 }
 report.after=resource();report.peakRssMiB=+peakRss.toFixed(2);report.success=true;
})().catch(error=>{report.success=false;report.error=error.message;process.exitCode=1;}).finally(async()=>{if(cookie){try{await request('/api/auth/logout',{});}catch{report.logoutFailed=true;}}agent.destroy();console.log('PRESSURE_REPORT '+JSON.stringify(report));});
