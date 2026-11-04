const test=require('node:test'),assert=require('node:assert/strict'),{destination}=require('../../public/auth-redirect');
test('登录和注册默认进聊天，注册不继承任何后台返回地址',()=>{
 for(const next of [null,undefined,'','/admin.html','/admin','/ADMIN.HTML','/%61dmin.html']){
  assert.equal(destination(next,null,{register:true}),'/chat.html');assert.equal(destination(next,{role:'user'}),'/chat.html');
 }
 assert.equal(destination(undefined,{role:'admin'}),'/chat.html');
 assert.equal(destination('/admin.html',{role:'admin'}),'/admin.html');assert.equal(destination('/admin/',{role:'admin'}),'/admin.html');assert.equal(destination('/admin.html',{role:'admin'},{register:true}),'/chat.html');
 assert.equal(destination('/agent.html',{role:'admin'}),'/agent.html');assert.equal(destination('/agent.html',{role:'user'}),'/chat.html');assert.equal(destination('/agent.html',{role:'admin'},{register:true}),'/chat.html');
 for(const plan of ['free','pro','max'])assert.equal(destination('/agent.html',{role:'user',membership:{plan}}),'/agent.html');
 assert.equal(destination('/agent.html',{role:'user',membership:{plan:'trial'}}),'/chat.html');
});
test('聊天绘图用量的明确返回地址保留，拒绝跨站控制字符和登录循环',()=>{
 for(const next of ['/','/index.html','/chat.html','/usage.html?range=7d#models','/requirements.html?from=document#source'])assert.equal(destination(next,{role:'user'}),next);
 for(const next of ['https://evil.example','//evil.example','/\\evil.example','/\tevil.example','/\nevil.example','/%2f%2fevil.example','/%5cevil','/login.html','/register.html','/api/users','/%E0%A4%A','/chat.html/../admin.html'])assert.equal(destination(next,{role:'user'}),'/chat.html');
});
