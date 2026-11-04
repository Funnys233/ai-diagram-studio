const test=require('node:test'),assert=require('node:assert/strict'),Membership=require('../../lib/membership');
test('会员到期边界按当前时间判断，旧用户默认为普通，未知等级不能提升权限',()=>{
 assert.equal(Membership.snapshot({}).plan,'free');assert.equal(Membership.snapshot({membership:{plan:'root',expiresAt:200}},100).plan,'free');
 const user={membership:{plan:'pro',expiresAt:200}};assert.equal(Membership.snapshot(user,199).plan,'pro');assert.equal(Membership.snapshot(user,200).plan,'free');assert.equal(Membership.snapshot(user,201).expired,true);
});
test('精确模型门槛、Max继承Pro、停用和匿名拒绝，管理账号保留管理能力',()=>{
 const free={role:'user'},pro={role:'user',membership:{plan:'pro',expiresAt:200}},max={role:'user',membership:{plan:'max',expiresAt:200}};
 assert.equal(Membership.allows(free,'gpt-6-luna',100),true);assert.equal(Membership.allows(free,'gpt-6.1-sol',100),false);assert.equal(Membership.allows(pro,'gpt-6.1-sol',100),true);assert.equal(Membership.allows(pro,'gpt-6-astra',100),false);assert.equal(Membership.allows(max,'gpt-6.1-sol',100),true);assert.equal(Membership.allows(max,'gpt-6-astra',100),true);
 assert.equal(Membership.allows({...max,disabled:true},'gpt-6-astra',100),false);assert.equal(Membership.allows(null,'gpt-6-luna',100),false);assert.equal(Membership.allows({role:'admin'},'gpt-6-astra',100),true);
 for(const modelId of ['future-model','constructor','toString','__proto__'])assert.equal(Membership.allows(free,modelId,100),true);
});

test('体验用户独立于原普通用户，不按模型名称自动开放任何周模型',()=>{
 const user={role:'user',membership:{plan:'trial'}};assert.equal(Membership.snapshot(user).name,'体验用户');assert.equal(Membership.snapshot(user).expired,false);
 for(const id of ['gpt-6-luna','gpt-6.1-sol','gpt-6-astra','future-model','deepseek-free'])assert.equal(Membership.allows(user,id),false);
 assert.equal(Membership.allows({role:'user'},'gpt-6-luna'),true);
});
test('Terra精确型号仅Pro及Max可用，到期/体验/普通拒绝，Luna专用沿用普通门槛',()=>{
 for(const plan of ['trial','free','pro','max']){
  const user={role:'user',membership:{plan,expiresAt:200}};
  assert.equal(Membership.allows(user,'gpt-5.6-terra',100),['pro','max'].includes(plan));
  assert.equal(Membership.allows(user,'gpt-6-luna',100),plan!=='trial');
 }
 assert.equal(Membership.allows({role:'user',membership:{plan:'pro',expiresAt:100}},'gpt-5.6-terra',100),false);
 assert.equal(Membership.allows({role:'admin'},'gpt-5.6-terra',100),true);
});

test('Grok和Claude全系列为Pro门槛，Max继承，普通/体验/到期拒绝，未来及命名空间模型同样受限',()=>{
 for(const id of ['grok-4.6-latest','grok-4.7','claude-sonnet-5-5','claude-opus-5-5','claude-fable-5.1','grok-future','claude-future','x-ai/grok-4.7','anthropic/claude-opus-future']){
  assert.equal(Membership.requiredPlan(id),'pro');
  for(const plan of ['trial','free','pro','max'])assert.equal(Membership.allows({role:'user',membership:{plan,expiresAt:200}},id,100),['pro','max'].includes(plan));
  assert.equal(Membership.allows({role:'user',membership:{plan:'pro',expiresAt:100}},id,100),false);assert.equal(Membership.allows({role:'admin'},id,100),true);
 }
 for(const id of ['my-claude-like','grokking','claudette','constructor'])assert.equal(Membership.requiredPlan(id),'free');
});
