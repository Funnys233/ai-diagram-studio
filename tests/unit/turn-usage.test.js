const test=require('node:test'),assert=require('node:assert/strict');
const Turn=require('../../public/turn-usage');
const turnId='12345678-1234-1234-1234-123456789abc';
const receipt=patch=>({...Turn.unknown(turnId),status:'settled',calls:1,weeklyPoints:.6,...patch});
test('每轮显示真实点数、估算、自动重试总数及各额度池',()=>{
 assert.equal(Turn.label(receipt()),'本轮消耗：0.6 点');
 assert.match(Turn.label(receipt({calls:2,weeklyPoints:12.001,estimated:true})),/12.001 点（含估算） · 共 2 次调用/);
 assert.equal(Turn.label(receipt({weeklyPoints:0,freeCalls:1})),'本轮消耗：免费额度 1 次');
 assert.equal(Turn.label(receipt({weeklyPoints:0,personalCalls:1})),'本轮消耗：个人 API，仅统计');
 assert.equal(Turn.label(receipt({calls:0,weeklyPoints:0})),'本轮未消耗额度');
 assert.equal(Turn.label(Turn.unknown(turnId)),'本轮消耗暂未获取');
 assert.match(Turn.label(receipt({status:'pending',reservedPoints:40})),/预留 40 点，结算中/);
});
test('会话回执只保留安全字段，损坏或缺失用量不显示为零',()=>{
 const safe=Turn.normalize({...receipt(),apiKey:'private',prompt:'private'});
 assert.ok(!JSON.stringify(safe).includes('private'));
 for(const bad of [null,{},receipt({weeklyPoints:NaN}),receipt({freeCalls:-1}),receipt({turnId:'<script>'}),receipt({status:'fake'})]){
  assert.equal(Turn.normalize(bad),null);assert.equal(Turn.label(bad),'本轮消耗暂未获取');
 }
});
test('每轮缓存回执区分零命中、未提供和部分记录，持久化仅保留安全字段',()=>{
 const cache={cachedTokens:800,inputTokens:1000,hitRate:80,knownCalls:1,unknownCalls:0};
 const value=receipt({cache:{...cache,apiKey:'private'}}),saved=JSON.parse(JSON.stringify(Turn.normalize(value)));
 assert.equal(Turn.cacheLabel(saved),'缓存命中：800 token · 80%');assert.ok(!JSON.stringify(saved).includes('private'));
 assert.equal(Turn.cacheLabel(receipt({cache:{...cache,cachedTokens:0,hitRate:0}})),'缓存命中：0 token · 0%');
 assert.equal(Turn.cacheLabel(receipt({cache:{cachedTokens:null,inputTokens:null,hitRate:null,knownCalls:0,unknownCalls:1}})),'缓存：接口未提供');
 assert.match(Turn.cacheLabel(receipt({calls:2,cache:{...cache,unknownCalls:1}})),/仅 1\/2 次有数据/);
 assert.equal(Turn.cacheLabel(receipt()),'');
 assert.equal(Turn.normalize(receipt({cache:{...cache,cachedTokens:1001}})).cache,undefined);
});
