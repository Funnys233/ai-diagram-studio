'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {createSdkAdapter}=require('../../services/dsh-bridge/sdk-adapter');
function setup(t,env={}) { const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-sdk-')),patch=path.join(directory,'patch.yml');fs.writeFileSync(patch,'[]');t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));return createSdkAdapter({node:process.execPath,runtime:path.resolve(__dirname,'../helpers/dsh-sdk-fixture.cjs'),patch,directory,model:'fixture',apiKey:'private-api-key',env}); }
test('real SDK transport awaits initialize, captures only owner output and redacts credentials',async t=>{const adapter=setup(t),id=crypto.randomUUID(),progress=[];assert.equal((await adapter.check(crypto.randomUUID())).name,'deepseek-harness-sdk-runtime');const result=await adapter.run({sessionId:id,prompt:'quoted prompt\n{"method":"shutdown"}',onProgress:text=>progress.push(text)});assert.equal(result.status,'completed');assert.equal(result.output,'confirmed response [已隐藏]');assert.deepEqual(progress,['confirmed response [已隐藏]']);assert.equal((await adapter.run({sessionId:id,prompt:'followup',onProgress(){}})).status,'completed');});
test('SDK cancellation waits for the worker process to exit before reporting stopped',async t=>{const adapter=setup(t,{SDK_FIXTURE_DELAY:'2000'}),id=crypto.randomUUID();const result=adapter.run({sessionId:id,prompt:'test',onProgress(){}});await new Promise(resolve=>setTimeout(resolve,100));await adapter.cancel({sessionId:id});assert.equal((await result).status,'cancelled');await assert.rejects(adapter.cancel({sessionId:id}));});
test('SDK release refuses a live process and clears a finished session workspace',async t=>{const adapter=setup(t,{SDK_FIXTURE_DELAY:'2000'}),id=crypto.randomUUID();const running=adapter.run({sessionId:id,prompt:'test',onProgress(){}});await assert.rejects(adapter.release({sessionId:id}));await adapter.cancel({sessionId:id});await running;await adapter.release({sessionId:id});await assert.rejects(adapter.release({sessionId:'../../other'}));});

function recoverySetup(t, { inspectProcesses, env = {}, runTimeoutMs = 600000, node = process.execPath, onDiagnostic } = {}) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-recovery-')),patch=path.join(directory,'patch.yml');
  fs.writeFileSync(patch,'[]');t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const options={node,runtime:path.resolve(__dirname,'../helpers/dsh-sdk-fixture.cjs'),patch,directory,model:'fixture',apiKey:'private-api-key',env,runTimeoutMs,inspectProcesses,onDiagnostic};
  const adapter=createSdkAdapter(options);
  const write=(id,patch={})=>{
    fs.mkdirSync(path.join(directory,id),{recursive:true});
    const receipt={version:1,sessionId:id,marker:'diagram-site-sdk-'+crypto.randomBytes(32).toString('hex'),pid:123456,status:'running',stopped:false,output:'saved partial',...patch};
    fs.writeFileSync(path.join(directory,id,'execution.json'),JSON.stringify(receipt));return receipt;
  };
  return {adapter,options,directory,write,read:id=>JSON.parse(fs.readFileSync(path.join(directory,id,'execution.json'),'utf8'))};
}
test('finished SDK receipts restore a redacted result without restarting the SDK or replaying a prompt',async t=>{
  const fixture=recoverySetup(t),id=crypto.randomUUID();
  await fixture.adapter.run({sessionId:id,prompt:'not persisted',onProgress(){}});
  const receipt=fixture.read(id);
  assert.equal(receipt.stopped,true);assert.equal(receipt.status,'completed');
  assert.ok(!JSON.stringify(receipt).includes('private-api-key'));assert.ok(!JSON.stringify(receipt).includes('not persisted'));
  const restarted=createSdkAdapter({...fixture.options,node:path.resolve('/nonexistent/node'),inspectProcesses(){throw Error('No inspection needed for prior exit proof');}});
  assert.deepEqual(await restarted.recover({sessionId:id}),{status:'completed',output:'confirmed response [已隐藏]',stopped:true});
});
test('recovery preserves a pending completion or partial failure only after verified process exit',async t=>{
  let inspections=0;
  const fixture=recoverySetup(t,{node:path.resolve('/nonexistent/node'),inspectProcesses:async identity=>{inspections++;assert.equal(identity.stop,true);assert.match(identity.marker,/^diagram-site-sdk-/);return {state:'stopped'};}});
  const complete=crypto.randomUUID();fixture.write(complete,{status:'completed',output:'already completed'});
  assert.deepEqual(await fixture.adapter.recover({sessionId:complete}),{status:'completed',output:'already completed',stopped:true});
  assert.equal(fixture.read(complete).stopped,true);
  const partial=crypto.randomUUID();fixture.write(partial);
  assert.deepEqual(await fixture.adapter.recover({sessionId:partial}),{status:'failed',output:'saved partial',stopped:true});
  await fixture.adapter.recover({sessionId:partial});assert.equal(inspections,2);
});
test('unproven, inaccessible and reused process identities remain unknown without modifying their receipt',async t=>{
  const fixture=recoverySetup(t,{inspectProcesses:async()=>({state:'unverified'})}),id=crypto.randomUUID();
  fixture.write(id);const before=fs.readFileSync(path.join(fixture.directory,id,'execution.json'),'utf8');
  assert.deepEqual(await fixture.adapter.recover({sessionId:id}),{status:'unknown',output:'saved partial',stopped:false});
  assert.equal(fs.readFileSync(path.join(fixture.directory,id,'execution.json'),'utf8'),before);
  const throws=createSdkAdapter({...fixture.options,inspectProcesses:async()=>{throw Error('Access denied');}});
  assert.equal((await throws.recover({sessionId:id})).stopped,false);
});
test('missing or damaged receipts cannot be unlocked by guessing that an execution is gone',async t=>{
  let inspections=0;const fixture=recoverySetup(t,{inspectProcesses:async()=>{inspections++;return {state:'gone'};}}),id=crypto.randomUUID();
  assert.deepEqual(await fixture.adapter.recover({sessionId:id}),{status:'unknown',output:'',stopped:false});
  fixture.write(id,{marker:'unsafe marker'});const before=fs.readFileSync(path.join(fixture.directory,id,'execution.json'),'utf8');
  assert.equal((await fixture.adapter.recover({sessionId:id})).stopped,false);
  assert.equal(fs.readFileSync(path.join(fixture.directory,id,'execution.json'),'utf8'),before);assert.equal(inspections,0);
  await assert.rejects(fixture.adapter.recover({sessionId:'../../other'}));
});
test('active SDK recovery stops the exact owned child and records a terminal result',async t=>{
  const fixture=recoverySetup(t,{env:{SDK_FIXTURE_DELAY:'30000'}}),id=crypto.randomUUID();
  const running=fixture.adapter.run({sessionId:id,prompt:'test',onProgress(){}});
  await new Promise(resolve=>setTimeout(resolve,80));
  const recovered=await fixture.adapter.recover({sessionId:id});assert.equal(recovered.stopped,true);assert.equal(recovered.status,'cancelled');
  assert.equal((await running).status,'cancelled');assert.equal(fixture.read(id).stopped,true);
  await fixture.adapter.release({sessionId:id});assert.equal(fs.existsSync(path.join(fixture.directory,id)),false);
});
test('a failed close and failed first recovery can be retried after run finally has already settled',async t=>{
  let allowStop=false,pid;
  const fixture=recoverySetup(t,{env:{SDK_FIXTURE_DELAY:'30000',SDK_FIXTURE_IGNORE_SHUTDOWN:'1'},runTimeoutMs:30,inspectProcesses:async identity=>{
    pid=identity.pid;if(!allowStop)return {state:'unverified'};
    process.kill(pid,'SIGKILL');return {state:'stopped'};
  }}),id=crypto.randomUUID();
  t.after(async()=>{allowStop=true;await fixture.adapter.recover({sessionId:id}).catch(()=>{});});
  await assert.rejects(fixture.adapter.run({sessionId:id,prompt:'test',onProgress(){}}));
  assert.equal(fixture.read(id).stopped,false);
  assert.equal((await fixture.adapter.recover({sessionId:id})).stopped,false);
  allowStop=true;
  assert.deepEqual(await fixture.adapter.recover({sessionId:id}),{status:'failed',output:'',stopped:true});
  assert.equal(fixture.read(id).stopped,true);
  await fixture.adapter.release({sessionId:id});
});
test('a failed post-spawn receipt write still waits for its child to exit and handles child errors',async t=>{
  const fixture=recoverySetup(t,{env:{SDK_FIXTURE_DELAY:'30000'}}),id=crypto.randomUUID(),rename=fs.renameSync;
  let ownedPid;
  fs.renameSync=function(from,to){
    if(to===path.join(fixture.directory,id,'execution.json')){
      const value=JSON.parse(fs.readFileSync(from,'utf8'));
      if(value.pid){ownedPid=value.pid;throw Object.assign(Error('Injected storage failure'),{code:'EIO'});}
    }
    return rename.apply(this,arguments);
  };
  try{await assert.rejects(fixture.adapter.run({sessionId:id,prompt:'test',onProgress(){}}));}
  finally{fs.renameSync=rename;}
  assert.ok(ownedPid>0);
  assert.throws(()=>process.kill(ownedPid,0),error=>error.code==='ESRCH');
});

test('recovery diagnostic reasons are static and never echo inspection exception text or unknown fields',async t=>{
  const diagnostics=[];
  const fixture=recoverySetup(t,{inspectProcesses:async()=>({state:'unverified',reason:'open-handle',errorCode:-2147467259}),onDiagnostic:text=>diagnostics.push(text)}),id=crypto.randomUUID();
  fixture.write(id);assert.equal((await fixture.adapter.recover({sessionId:id})).stopped,false);
  assert.deepEqual(diagnostics,['SDK recovery inspection: open-handle (-2147467259)']);
  const unsafe=createSdkAdapter({...fixture.options,inspectProcesses:async()=>({state:'unverified',reason:'private-api-key commandline',errorCode:'private-api-key'})});
  await unsafe.recover({sessionId:id});
  assert.equal(diagnostics[1],'SDK recovery inspection: inspection-failed');
  assert.ok(!diagnostics.join('\n').includes('private-api-key'));
});

test('an unknown child proof blocks recovery; a confirmed SDK exit with only OS display helpers can finish',async t=>{
  let standardDisplayOnly=false;const diagnostics=[];
  const fixture=recoverySetup(t,{inspectProcesses:async()=>standardDisplayOnly?{state:'stopped',displayHelpers:1}:{state:'unverified',reason:'children'},onDiagnostic:text=>diagnostics.push(text)}),id=crypto.randomUUID();
  fixture.write(id);assert.equal((await fixture.adapter.recover({sessionId:id})).stopped,false);
  assert.equal(fixture.read(id).stopped,false);assert.equal(diagnostics[0],'SDK recovery inspection: children');
  standardDisplayOnly=true;assert.deepEqual(await fixture.adapter.recover({sessionId:id}),{status:'failed',output:'saved partial',stopped:true});
});

test('native session continuation survives adapter restart and sends only the new prompt',async t=>{
  const fixture=recoverySetup(t,{env:{SDK_FIXTURE_CONTEXT:'1'}}),id=crypto.randomUUID();
  assert.equal(fixture.adapter.supportsContinuation,true);assert.equal(fixture.adapter.canResume({sessionId:id}),false);
  assert.equal((await fixture.adapter.run({sessionId:id,taskId:'turn-1',prompt:'remember the number 83'})).output,'["remember the number 83"]');
  assert.equal(fixture.adapter.canResume({sessionId:id}),true);
  const restarted=createSdkAdapter(fixture.options);
  const next=await restarted.run({sessionId:id,taskId:'turn-2',continuation:true,prompt:'what number?'});
  assert.equal(next.status,'completed');assert.deepEqual(JSON.parse(next.output),['remember the number 83','what number?']);
  assert.equal(fixture.read(id).taskId,'turn-2');
  const fresh=await restarted.run({sessionId:crypto.randomUUID(),taskId:'fresh-1',prompt:'independent'});
  assert.deepEqual(JSON.parse(fresh.output),['independent']);
  await restarted.release({sessionId:id});assert.equal(restarted.canResume({sessionId:id}),false);
  await assert.rejects(restarted.run({sessionId:id,taskId:'turn-3',continuation:true,prompt:'must not start fresh'}),/context/);
  assert.equal(fs.existsSync(path.join(fixture.directory,id)),false);
});

test('resume errors cannot enqueue the followup or start a new model session',async t=>{
  const fixture=recoverySetup(t),id=crypto.randomUUID(),calls=path.join(fixture.directory,'calls.jsonl');
  await fixture.adapter.run({sessionId:id,taskId:'turn-1',prompt:'first'});
  const restarted=createSdkAdapter({...fixture.options,env:{SDK_FIXTURE_RESUME_ERROR:'1',SDK_FIXTURE_CALLS_FILE:calls}});
  const result=await restarted.run({sessionId:id,taskId:'turn-2',continuation:true,prompt:'never submit'});
  assert.equal(result.status,'failed');assert.equal(result.output,'');assert.equal(fs.existsSync(calls),false);
  assert.equal(fixture.read(id).taskId,'turn-2');assert.equal(fixture.read(id).stopped,true);
});

test('turn-bound recovery never reuses another turn receipt or cancels another active turn',async t=>{
  const fixture=recoverySetup(t),id=crypto.randomUUID();
  await fixture.adapter.run({sessionId:id,taskId:'turn-1',prompt:'first'});
  const before=fs.readFileSync(path.join(fixture.directory,id,'execution.json'),'utf8');
  assert.deepEqual(await fixture.adapter.recover({sessionId:id,taskId:'turn-2'}),{status:'unknown',output:'',stopped:false});
  assert.equal(fs.readFileSync(path.join(fixture.directory,id,'execution.json'),'utf8'),before);
  assert.equal((await fixture.adapter.recover({sessionId:id,taskId:'turn-1'})).output,'confirmed response [已隐藏]');
  const delayed=createSdkAdapter({...fixture.options,env:{SDK_FIXTURE_DELAY:'30000'}});
  const running=delayed.run({sessionId:id,taskId:'turn-2',continuation:true,prompt:'next'});
  assert.deepEqual(await delayed.recover({sessionId:id,taskId:'turn-1'}),{status:'unknown',output:'',stopped:false});
  await delayed.cancel({sessionId:id});assert.equal((await running).status,'cancelled');
});

test('historical resume notifications cannot become a new turn reply or failure',async t=>{
  const fixture=recoverySetup(t),id=crypto.randomUUID();
  await fixture.adapter.run({sessionId:id,taskId:'turn-1',prompt:'first'});
  const restarted=createSdkAdapter({...fixture.options,env:{SDK_FIXTURE_CONTEXT:'1',SDK_FIXTURE_STALE_RESUME_EVENTS:'1'}}),progress=[];
  const result=await restarted.run({sessionId:id,taskId:'turn-2',continuation:true,prompt:'next',onProgress:text=>progress.push(text)});
  assert.equal(result.status,'completed');assert.deepEqual(JSON.parse(result.output),['first','next']);assert.equal(progress.length,1);
  const empty=createSdkAdapter({...fixture.options,env:{SDK_FIXTURE_STALE_RESUME_EVENTS:'1',SDK_FIXTURE_NO_OUTPUT:'1'}});
  const noReply=await empty.run({sessionId:id,taskId:'turn-3',continuation:true,prompt:'no reply'});
  assert.equal(noReply.status,'failed');assert.equal(noReply.output,'');
});

test('a full persistent document workspace fails this turn with confirmed stop and never enqueues its prompt', async t => {
  const { openFiles } = require('../../services/dsh-bridge/session-files');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sdk-file-capacity-')), patch = path.join(directory, 'patch.yml'), callsFile = path.join(directory, 'calls.ndjson');
  fs.writeFileSync(patch, '[]'); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessionId = crypto.randomUUID(), files = openFiles(path.join(directory, sessionId, 'files'), sessionId);
  const references = Array.from({ length: 13 }, (_, index) => ({ id: crypto.randomUUID(), name: index + '.txt', text: '文'.repeat(50000) }));
  for (let index = 0; index < references.length; index += 4) files.stage('seed-' + index, references.slice(index, index + 4));
  const options = { node: process.execPath, runtime: path.resolve(__dirname, '../helpers/dsh-sdk-fixture.cjs'), patch, directory, model: 'fixture', apiKey: 'private-api-key', enableFiles: true, env: { SDK_FIXTURE_CALLS_FILE: callsFile } };
  const adapter = createSdkAdapter(options);
  assert.equal((await adapter.run({ sessionId, taskId: 'turn-1', prompt: 'first' })).status, 'completed');
  const failed = await adapter.run({ sessionId, taskId: 'turn-2', continuation: true, prompt: 'must not be sent', documents: [{ id: crypto.randomUUID(), name: 'too-much.txt', text: '文'.repeat(50000) }] });
  assert.equal(failed.status, 'failed'); assert.equal(failed.stopped, true); assert.deepEqual(failed.artifacts, []);
  assert.equal(fs.readFileSync(callsFile, 'utf8').trim().split('\n').length, 1);
  const recovered = await createSdkAdapter(options).recover({ sessionId, taskId: 'turn-2' });
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.stopped, true); assert.deepEqual(recovered.artifacts, []);
  assert.equal(files.listDocuments().length, 13);
});

test('native per-call usage persists once per task, survives recovery and restarts at zero for a follow-up', async t => {
  const samples = [{ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 4, totalTokens: 39 }, { inputTokens: 40, outputTokens: 6, totalTokens: 46 }];
  const fixture = recoverySetup(t, { env: { SDK_FIXTURE_USAGE: JSON.stringify(samples), SDK_FIXTURE_DUPLICATE_USAGE: '1' } }), sessionId = crypto.randomUUID(), snapshots = [];
  const first = await fixture.adapter.run({ sessionId, taskId: 'usage-turn-1', prompt: 'first', onUsage: value => snapshots.push(value) });
  assert.deepEqual(first.usage, { calls: 2, complete: true, inputTokens: 75, outputTokens: 10, cachedInputTokens: 20, cacheWriteInputTokens: 5 });
  assert.ok(snapshots.some(value => !value.complete)); assert.deepEqual(fixture.read(sessionId).usage, first.usage);
  const restarted = createSdkAdapter(fixture.options);
  assert.deepEqual((await restarted.recover({ sessionId, taskId: 'usage-turn-1' })).usage, first.usage);
  assert.deepEqual((await restarted.recover({ sessionId, taskId: 'usage-turn-1' })).usage, first.usage);
  const second = await restarted.run({ sessionId, taskId: 'usage-turn-2', continuation: true, prompt: 'next' });
  assert.deepEqual(second.usage, first.usage, 'only this turn is counted, never the previous session total');
});

test('selected models use a task-bound gateway capability and cannot change within the same SDK conversation', async t => {
  const fixture = recoverySetup(t), settingsFile = path.join(fixture.directory, 'settings.jsonl');
  const adapter = createSdkAdapter({ ...fixture.options, env: { SDK_FIXTURE_SETTINGS_FILE: settingsFile } }), sessionId = crypto.randomUUID();
  const modelSelection = { providerId: 'platform:relay', modelId: 'gpt-6.1-sol' };
  const first = await adapter.run({ sessionId, taskId: 'model-turn-1', modelSelection, prompt: 'first' });
  assert.equal(first.status, 'completed'); assert.equal(first.output, 'confirmed response [已隐藏]');
  const setting = JSON.parse(fs.readFileSync(settingsFile, 'utf8').trim());
  assert.equal(setting.model, modelSelection.modelId); assert.equal(setting.envModel, modelSelection.modelId);
  assert.equal(require('../../services/dsh-bridge/file-protocol').verifyTaskCapability('private-api-key', setting.credential), 'model-turn-1');
  assert.ok(!setting.credential.includes('private-api-key')); assert.ok(!JSON.stringify(fixture.read(sessionId)).includes(setting.credential));
  const changed = await adapter.run({ sessionId, taskId: 'model-turn-2', modelSelection: { ...modelSelection, modelId: 'gpt-6-astra' }, continuation: true, prompt: 'must not run' });
  assert.equal(changed.status, 'failed'); assert.equal(changed.stopped, true); assert.equal(changed.usage.calls, 0); assert.equal(changed.usage.complete, true);
  assert.equal(fs.readFileSync(settingsFile, 'utf8').trim().split('\n').length, 1);
});
