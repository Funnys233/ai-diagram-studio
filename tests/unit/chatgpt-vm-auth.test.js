const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {authorize}=require('../../scripts/chatgpt-vm-auth.cjs');
test('VM OAuth uses a separate host-bound session and removes the local refresh owner after handoff',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vm-auth-test-'));fs.chmodSync(dir,0o700);t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const hostId='urn:uuid:'+crypto.randomUUID(),out=path.join(dir,'handoff.json');
 const {publicKey,privateKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});let nonce,callbackStatus;
 const pending=authorize({hostId,out,request:async(url,form)=>{
  if(url.endsWith('jwks.json'))return {status:200,data:{keys:[{...publicKey.export({format:'jwk'}),kid:'helper'}]}};
  assert.equal(form.grant_type,'authorization_code');assert.equal(form.client_id,'oaiapp_helper');assert.ok(form.code_verifier);
  const header=Buffer.from(JSON.stringify({alg:'RS256',kid:'helper'})).toString('base64url');
  const body=Buffer.from(JSON.stringify({iss:'https://auth.openai.com',sub:'helper',aud:'oaiapp_helper',nonce,iat:Date.now()/1000,exp:Date.now()/1000+3600})).toString('base64url');
  const id=`${header}.${body}.${crypto.sign('sha256',Buffer.from(`${header}.${body}`),privateKey).toString('base64url')}`;
  return {status:200,data:{id_token:id,access_token:'helper-access',refresh_token:'helper-refresh',scope:'openid chatgpt.tokens.use.direct',expires_in:3600}};
 },onReady:({authorizationUrl})=>{
  const auth=new URL(authorizationUrl);nonce=auth.searchParams.get('nonce');assert.equal(auth.searchParams.get('ext_agent_host_id'),hostId);assert.equal(auth.searchParams.get('client_id'),'dynamic_agent_client');
  const callback=new URL(auth.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({state:auth.searchParams.get('state'),code:'test-code',client_id:'oaiapp_helper'}).toString();
  callbackStatus=fetch(callback).then(async r=>{assert.equal(r.status,200);assert.doesNotMatch(await r.text(),/helper-access|helper-refresh/);});
 }});
 assert.equal((await pending).ready,true);await callbackStatus;
 assert.equal(fs.statSync(out).mode&0o777,0o600);const data=JSON.parse(fs.readFileSync(out));assert.equal(data.hostId,hostId);assert.equal(data.account.refreshToken,'helper-refresh');
 await assert.rejects(authorize({hostId,out}));await assert.rejects(authorize({hostId:'invalid',out:path.join(dir,'other')}));
});
