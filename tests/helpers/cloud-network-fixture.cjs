'use strict';
// Test-only fixture preload. This file is excluded from deployment images.
const dns=require('node:dns').promises,lookup=dns.lookup;
dns.lookup=(host,options)=>host==='api.fixture.example'?Promise.resolve([{address:'8.8.8.8',family:4}]):lookup(host,options);
const service=require('../../lib/model-service');
for(const method of ['callWithLock','listRemoteModels','testModelConnection']){
 const original=service[method];
 service[method]=function(provider,...args){
  if(new URL(provider.baseUrl).hostname!=='api.fixture.example')return original(provider,...args);
  const index=2;
  args[index]={...args[index],networkPolicy:false};
  return original({...provider,baseUrl:process.env.DIAGRAM_TEST_GATEWAY},...args);
 };
}
