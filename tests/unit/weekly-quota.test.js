const test = require('node:test'), assert = require('node:assert/strict');
const Quota = require('../../lib/weekly-quota');
const MONDAY = Date.parse('2026-10-19T00:00:00Z'), DAY = 86400000, WEEK = 7 * DAY;
const settings = { ownerKey: 'alice', limitPoints: 1000 };
function reserve(data, id, patch = {}, now = MONDAY + 1000) { return Quota.reserve(data, { ...settings, id, modelId: 'fixture', ...patch }, now); }
function snapshot(data, patch = {}, now = MONDAY + 2000) { return Quota.snapshot(data, { ...settings, ...patch }, now); }

test('新账本不倒扣历史；周一 UTC00/北京时间08建立新窗口', () => {
  const data = { usage: { users: { alice: 200 } }, events: [{ usage: { input_tokens: 999999 } }] };
  const before = JSON.stringify({ usage: data.usage, events: data.events });
  const sunday = snapshot(data, {}, MONDAY - 1);
  assert.equal(sunday.weekStart, MONDAY - WEEK); assert.equal(sunday.resetAt, MONDAY);
  const monday = snapshot(data, {}, MONDAY);
  assert.equal(monday.weekStart, MONDAY); assert.equal(monday.resetAt, MONDAY + WEEK);
  assert.equal(monday.usedPoints, 0); assert.equal(monday.remainingPoints, 1000);
  assert.equal(JSON.stringify({ usage: data.usage, events: data.events }), before);
  assert.deepEqual(data.weeklyQuota.windows, []);
});
test('输入+五倍输出按千 token 一点计费，reasoning/cache字段不重复相加', () => {
  const data = {};
  reserve(data, 'one', { reasoningEffort: 'max' });
  assert.equal(snapshot(data).reservedPoints, 8);
  const entry = Quota.settle(data, 'one', { usage: { input_tokens: 1000, output_tokens: 500,
    input_tokens_details: { cached_tokens: 800 }, output_tokens_details: { reasoning_tokens: 400 } } }, MONDAY + 2000);
  assert.equal(entry.chargedCredits, 3500); assert.equal(entry.estimated, false);
  assert.equal(snapshot(data).usedPoints, 3.5); assert.equal(snapshot(data).reservedPoints, 0);
  reserve(data, 'two');
  Quota.settle(data, 'two', { usage: { prompt_tokens: 100, completion_tokens: 100 } }, MONDAY + 3000);
  assert.equal(snapshot(data).usedCredits, 4100);
});
test('短响应最低0.1点，返回0 token也不误判为未知', () => {
  const data = {}; reserve(data, 'small');
  const entry = Quota.settle(data, 'small', { usage: { input_tokens: 0, output_tokens: 0 } }, MONDAY + 2000);
  assert.equal(entry.chargedCredits, 100); assert.equal(entry.estimated, false);
  assert.equal(snapshot(data).remainingPoints, 999.9);
});
test('相同实际用量按Luna、6.1 Sol、6 Astra的1/30/300倍扣点，最低值也按比例计算', () => {
  for (const [modelId, multiplier] of [['gpt-6-luna', 1], ['gpt-6.1-sol', 30], ['gpt-6-astra', 300]]) {
    const data = {}; const reservation = reserve(data, 'measured', { modelId, reasoningEffort: 'medium', limitPoints: 10000 });
    assert.equal(reservation.modelMultiplier, multiplier); assert.equal(reservation.policyVersion, 6);
    assert.equal(snapshot(data).reservedPoints, 2 * multiplier);
    const persisted = JSON.parse(JSON.stringify(data));
    const measured = Quota.settle(persisted, 'measured', { usage: { input_tokens: 1000, output_tokens: 1000 } }, MONDAY + 2000);
    assert.equal(measured.chargedCredits, 6000 * multiplier); assert.equal(measured.estimated, false);
    assert.equal(snapshot(persisted).usedPoints, 6 * multiplier); assert.equal(snapshot(persisted).reservedPoints, 0);
    reserve(persisted, 'minimum', { modelId, reasoningEffort: 'none', limitPoints: 10000 });
    const minimum = Quota.settle(persisted, 'minimum', { usage: { input_tokens: 0, output_tokens: 0 } }, MONDAY + 3000);
    assert.equal(minimum.chargedCredits, 100 * multiplier);
  }
});
test('估算、部分用量下界和预留同样应用模型倍率，不足时不能发起', () => {
  for (const [modelId, multiplier] of [['gpt-6-luna', 1], ['gpt-6.1-sol', 30], ['gpt-6-astra', 300]]) {
    const data = {}; reserve(data, 'estimated', { modelId, reasoningEffort: 'max', limitPoints: 10000 });
    assert.equal(snapshot(data).reservedPoints, 8 * multiplier);
    const estimated = Quota.settle(data, 'estimated', {}, MONDAY + 2000);
    assert.equal(estimated.chargedCredits, 8000 * multiplier); assert.equal(estimated.estimated, true);
    reserve(data, 'partial', { modelId, reasoningEffort: 'low', limitPoints: 10000 });
    const partial = Quota.settle(data, 'partial', { usage: { output_tokens: 500 } }, MONDAY + 3000);
    assert.equal(partial.chargedCredits, 2500 * multiplier); assert.equal(partial.estimated, true);
  }
  const data = {}; reserve(data, 'busy', { modelId: 'gpt-6-astra', reasoningEffort: 'medium' });
  const before = JSON.stringify(data);
  assert.throws(() => reserve(data, 'blocked', { modelId: 'gpt-6-astra', reasoningEffort: 'high' }), error => error.code === 'weekly-limit');
  assert.equal(JSON.stringify(data), before);
});
test('仅精确模型标识获得倍率，其他新增模型保持基础档', () => {
  for (const modelId of ['gpt-6.1-sol-preview', 'gpt-6-astra-extra', 'custom/gpt-6-astra', 'future-open-model', 'toString']) {
    const data = {}; const call = reserve(data, 'one', { modelId });
    assert.equal(call.modelMultiplier, 1);
    assert.equal(Quota.settle(data, 'one', { usage: { input_tokens: 1000, output_tokens: 1000 } }, MONDAY + 2000).chargedCredits, 6000);
  }
});
test('旧策略的已结记录与预留不补乘倍率，升级后新调用使用新规则', () => {
  const data = { weeklyQuota: { version: 1, policyVersion: 1,
    windows: [{ ownerKey: 'alice', weekStart: MONDAY, usedCredits: 5000, reservedCredits: 8000 }],
    calls: [
      { id: 'old-done', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 1, modelId: 'gpt-6-astra', reservedCredits: 2000, startedAt: MONDAY, status: 'success', chargedCredits: 5000, estimated: false },
      { id: 'old-pending', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 1, modelId: 'gpt-6-astra', reservedCredits: 8000, startedAt: MONDAY + 1, status: 'pending' },
    ] } };
  const before = JSON.parse(JSON.stringify(data.weeklyQuota.calls));
  assert.equal(snapshot(data).policyVersion, 6); assert.equal(data.weeklyQuota.policyVersion, 6);
  assert.deepEqual(data.weeklyQuota.calls, before);
  assert.equal(Quota.settle(data, 'old-pending', { usage: { input_tokens: 1000, output_tokens: 1000 } }, MONDAY + 2000).chargedCredits, 5000);
  assert.equal(snapshot(data).usedPoints, 10);
  assert.equal(Quota.settle(data, 'old-done', {}, MONDAY + 3000).chargedCredits, 5000);
  reserve(data, 'new', { modelId: 'gpt-6-astra', reasoningEffort: 'low' });
  assert.equal(Quota.settle(data, 'new', { usage: { input_tokens: 1000, output_tokens: 1000 } }, MONDAY + 4000).chargedCredits, 1800000);
  assert.equal(snapshot(data).usedPoints, 1810);
});
test('v2旧Sol十倍和四倍输出保留；v5新请求固定三十倍与五倍输出', () => {
  const data = { weeklyQuota: { version: 1, policyVersion: 2,
    windows: [{ ownerKey: 'alice', weekStart: MONDAY, usedCredits: 50000, reservedCredits: 120000 }],
    calls: [
      { id: 'done', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 2, modelId: 'gpt-6.1-sol', modelMultiplier: 10, startedAt: MONDAY, status: 'success', chargedCredits: 50000 },
      { id: 'sol', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 2, modelId: 'gpt-6.1-sol', modelMultiplier: 10, reservedCredits: 20000, startedAt: MONDAY, status: 'pending' },
      { id: 'astra', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 2, modelId: 'gpt-6-astra', modelMultiplier: 100, reservedCredits: 100000, startedAt: MONDAY, status: 'pending' },
    ] } };
  const before = structuredClone(data.weeklyQuota.calls);
  Quota.initialize(data, MONDAY + 1000); assert.equal(data.weeklyQuota.policyVersion, 6);
  assert.deepEqual(data.weeklyQuota.calls, before);
  const restarted = structuredClone(data);
  assert.equal(Quota.recover(restarted, MONDAY + 1000), 2);
  assert.equal(snapshot(restarted).usedPoints, 170); assert.equal(snapshot(restarted).reservedPoints, 0);
  assert.equal(Quota.recover(restarted, MONDAY + 1000), 0);
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  assert.equal(Quota.settle(data, 'sol', { usage }, MONDAY + 2000).chargedCredits, 50000);
  assert.equal(Quota.settle(data, 'astra', { usage }, MONDAY + 2000).chargedCredits, 500000);
  const next = reserve(data, 'new-sol', { modelId: 'gpt-6.1-sol' });
  assert.equal(next.modelMultiplier, 30); assert.equal(next.outputWeight, 5); assert.equal(next.reservedCredits, 60000);
  const persisted = JSON.parse(JSON.stringify(data));
  assert.equal(Quota.settle(persisted, 'new-sol', { usage }, MONDAY + 3000).chargedCredits, 180000);
  assert.equal(snapshot(persisted).usedPoints, 780);
  assert.deepEqual(persisted.weeklyQuota.calls.find(call => call.id === 'done'), before[0]);
});
test('Astra新请求三百倍，v3已结与在途请求保持百倍，最高档需预留2400点', () => {
  const data = { weeklyQuota: { version: 1, policyVersion: 3,
    windows: [{ ownerKey: 'alice', weekStart: MONDAY, usedCredits: 600000, reservedCredits: 100000 }],
    calls: [
      { id: 'done', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 3, modelId: 'gpt-6-astra', modelMultiplier: 100, outputWeight: 5, startedAt: MONDAY, status: 'success', chargedCredits: 600000 },
      { id: 'pending', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 3, modelId: 'gpt-6-astra', modelMultiplier: 100, outputWeight: 5, reservedCredits: 100000, startedAt: MONDAY, status: 'pending' },
    ] } };
  const done = structuredClone(data.weeklyQuota.calls[0]);
  Quota.initialize(data, MONDAY + 1000); assert.equal(data.weeklyQuota.policyVersion, 6);
  const restored = structuredClone(data); Quota.recover(restored, MONDAY + 1000);
  assert.equal(snapshot(restored, { limitPoints: 10000 }).usedPoints, 700);
  const usage = { input_tokens: 1000, output_tokens: 1000 };
  assert.equal(Quota.settle(data, 'pending', { usage }, MONDAY + 2000).chargedCredits, 600000);
  reserve(data, 'new', { modelId: 'gpt-6-astra', reasoningEffort: 'low', limitPoints: 10000 });
  const settled = Quota.settle(data, 'new', { usage }, MONDAY + 3000);
  assert.equal(settled.modelMultiplier, 300); assert.equal(settled.chargedCredits, 1800000);
  assert.equal(snapshot(data, { limitPoints: 10000 }).usedPoints, 3000);
  assert.deepEqual(data.weeklyQuota.calls.find(call => call.id === 'done'), done);
  assert.throws(() => reserve({}, 'blocked-max', { modelId: 'gpt-6-astra', reasoningEffort: 'max' }), error => error.code === 'weekly-limit' && /2400/.test(error.message) && /1000/.test(error.message));
  const fresh = {}; const max = reserve(fresh, 'allowed-max', { modelId: 'gpt-6-astra', reasoningEffort: 'max', limitPoints: 3000 });
  assert.equal(max.reservedCredits, 2400000);
});
test('未知usage按公开档位兜底；失败取消不自动免费，错误usage仍可结算', () => {
  const data = {};
  for (const [effort, points] of [['none', 1], ['low', 1], ['medium', 2], ['high', 3], ['xhigh', 5], ['max', 8], [null, 2], ['unsupported', 2]]) {
    const id = String(effort); reserve(data, id, { reasoningEffort: effort });
    const entry = Quota.settle(data, id, { error: { code: 'network-error' } }, MONDAY + 2000);
    assert.equal(entry.chargedCredits, points * 1000); assert.equal(entry.estimated, true); assert.equal(entry.status, 'failed');
  }
  reserve(data, 'cancelled', { reasoningEffort: 'max' });
  assert.equal(Quota.settle(data, 'cancelled', { cancelled: true }, MONDAY + 2000).chargedCredits, 8000);
  reserve(data, 'error-usage');
  const measured = Quota.settle(data, 'error-usage', { error: { extra: { usage: { prompt_tokens: 500, completion_tokens: 0 } } } }, MONDAY + 2000);
  assert.equal(measured.chargedCredits, 500); assert.equal(measured.estimated, false);
});
test('明确HTTP429且未报告消耗的新请求零扣点，释放预留，结算重放与重启不补扣', () => {
  for (const usage of [undefined, {prompt_tokens:0,completion_tokens:0}]) {
    const data={};reserve(data,'rejected',{modelId:'gpt-6-astra',reasoningEffort:'max',limitPoints:10000});
    const result=Quota.settle(data,'rejected',{httpStatus:429,error:{code:'rate-limited'},usage},MONDAY+2000);
    assert.equal(result.chargedCredits,0);assert.equal(result.estimated,false);assert.equal(result.status,'failed');assert.equal(result.unbilledReason,'http-429');
    assert.equal(snapshot(data).usedPoints,0);assert.equal(snapshot(data).reservedPoints,0);
    assert.deepEqual(Quota.settle(data,'rejected',{},MONDAY+3000),result);
    const restarted=structuredClone(data);assert.equal(Quota.recover(restarted,MONDAY+4000),0);assert.equal(snapshot(restarted).usedPoints,0);
  }
});
test('错误码不能证明HTTP拒绝，已计费、取消、200流式失败和旧在途记录继续计费', () => {
  for(const patch of [
    {error:{code:'rate-limited'}},
    {httpStatus:200,error:{code:'rate-limited'}},
    {httpStatus:429,error:{code:'rate-limited'},cancelled:true},
    {httpStatus:429,error:{code:'rate-limited'},usage:{total_tokens:3}},
    {httpStatus:429,error:{code:'rate-limited'},usage:{output_tokens:1}},
  ]){
    const data={};reserve(data,'uncertain');const entry=Quota.settle(data,'uncertain',patch,MONDAY+2000);
    assert.equal(entry.chargedCredits,2000);assert.equal(entry.estimated,true);
  }
  const data={};reserve(data,'old');delete data.weeklyQuota.calls[0].rateLimitPolicy;
  assert.equal(Quota.settle(data,'old',{httpStatus:429,error:{code:'rate-limited'}},MONDAY+2000).chargedCredits,2000);
  reserve(data,'consumed');assert.equal(Quota.settle(data,'consumed',{httpStatus:429,error:{code:'rate-limited'},usage:{prompt_tokens:100,completion_tokens:100}},MONDAY+3000).chargedCredits,600);
});
test('缺少半边usage保留已知消耗下界，非法或只有total_tokens时标记估算', () => {
  const data = {}; reserve(data, 'partial');
  const partial = Quota.settle(data, 'partial', { usage: { output_tokens: 10000 } }, MONDAY + 2000);
  assert.equal(partial.chargedCredits, 50000); assert.equal(partial.estimated, true); assert.equal(partial.inputTokens, null);
  reserve(data, 'invalid');
  const invalid = Quota.settle(data, 'invalid', { usage: { input_tokens: -2, output_tokens: NaN, total_tokens: 10000 } }, MONDAY + 2000);
  assert.equal(invalid.chargedCredits, 2000); assert.equal(invalid.estimated, true);
});
test('预留计入可用额度，多账号隔离；拒绝时不新增账目', () => {
  const data = {}; reserve(data, 'one', { limitPoints: 3 });
  const before = JSON.stringify(data);
  assert.throws(() => reserve(data, 'two', { limitPoints: 3 }), error => error.code === 'weekly-limit' && error.resetAt === MONDAY + WEEK);
  assert.equal(JSON.stringify(data), before);
  assert.equal(snapshot(data, { limitPoints: 3 }).remainingPoints, 1);
  reserve(data, 'bob', { ownerKey: 'bob', limitPoints: 2 });
  assert.equal(snapshot(data, { ownerKey: 'bob', limitPoints: 2 }).exhausted, true);
  assert.equal(snapshot(data, { limitPoints: 3 }).reservedPoints, 2);
});
test('实际超过预留全额透支，百分比封顶且后续拒绝；调整上限即时生效', () => {
  const data = {}; reserve(data, 'large', { limitPoints: 3 });
  Quota.settle(data, 'large', { usage: { input_tokens: 2000, output_tokens: 2000 } }, MONDAY + 2000);
  const used = snapshot(data, { limitPoints: 3 });
  assert.equal(used.usedPoints, 12); assert.equal(used.remainingPoints, 0); assert.equal(used.percent, 100); assert.equal(used.exhausted, true);
  assert.throws(() => reserve(data, 'blocked', { limitPoints: 3 }), error => error.code === 'weekly-limit');
  assert.equal(snapshot(data, { limitPoints: 20 }).remainingPoints, 8);
  reserve(data, 'allowed', { limitPoints: 20 });
});
test('跨周完成扣原窗口，新周恢复完整额度；同一次结算或预留重放不重复扣', () => {
  const data = {}; reserve(data, 'old', { reasoningEffort: 'max' }, MONDAY - 1000);
  reserve(data, 'old', { reasoningEffort: 'max' }, MONDAY - 500);
  assert.equal(snapshot(data, {}, MONDAY - 1).reservedPoints, 8);
  reserve(data, 'new');
  const first = Quota.settle(data, 'old', { usage: { input_tokens: 1000, output_tokens: 1000 } }, MONDAY + 2000);
  const repeated = Quota.settle(data, 'old', { usage: { input_tokens: 900000, output_tokens: 900000 } }, MONDAY + 3000);
  assert.deepEqual(repeated, first); assert.equal(first.weekStart, MONDAY - WEEK);
  assert.equal(snapshot(data).usedPoints, 0); assert.equal(snapshot(data).reservedPoints, 2);
  assert.equal(data.weeklyQuota.windows.find(row => row.weekStart === MONDAY - WEEK).usedCredits, 6000);
  assert.throws(() => reserve(data, 'old', { ownerKey: 'bob' }));
  assert.equal(Quota.settle(data, 'not-found', {}, MONDAY + 4000), null);
});
test('重启恢复预留为interrupted估算，幂等且跨周不占新周额度', () => {
  const data = {}; reserve(data, 'old', { reasoningEffort: 'max' }, MONDAY - 1000); reserve(data, 'new');
  const restored = JSON.parse(JSON.stringify(data));
  assert.equal(Quota.recover(restored, MONDAY + 2000), 2); assert.equal(Quota.recover(restored, MONDAY + 3000), 0);
  assert.equal(snapshot(restored).reservedPoints, 0); assert.equal(snapshot(restored).usedPoints, 2);
  assert.equal(restored.weeklyQuota.calls.every(call => call.status === 'interrupted' && call.estimated), true);
  assert.equal(restored.weeklyQuota.windows.find(row => row.weekStart === MONDAY - WEEK).usedCredits, 8000);
});
test('清理90天历史但保留仍在途请求及其原窗口；不保存正文和密钥', () => {
  const data = {}; const old = MONDAY - 100 * DAY;
  reserve(data, 'completed', {}, old); Quota.settle(data, 'completed', {}, old + 1000);
  reserve(data, 'pending', {}, old + 2000);
  Quota.reserve(data, { ...settings, id: 'safe', modelId: 'fixture', prompt: 'private-text', apiKey: 'private-key', contextEstimate: { prompt: 'private-text' } }, MONDAY);
  assert.equal(data.weeklyQuota.calls.some(call => call.id === 'completed'), false);
  assert.equal(data.weeklyQuota.calls.some(call => call.id === 'pending'), true);
  assert.ok(!JSON.stringify(data).includes('private'));
  Quota.recover(data, MONDAY + 2000);
  Quota.initialize(data, MONDAY + 3000);
  assert.equal(data.weeklyQuota.calls.some(call => call.id === 'pending'), false);
  assert.equal(data.weeklyQuota.windows.some(window => window.weekStart < MONDAY - 90 * DAY), false);
});
test('无效限额和不支持的数据版本明确失败，不静默重置已有账本', () => {
  for (const limitPoints of [-1, NaN, Infinity, '1000']) assert.throws(() => snapshot({}, { limitPoints }));
  const data = { weeklyQuota: { version: 2, policyVersion: 1, windows: [], calls: [] } };
  const before = JSON.stringify(data); assert.throws(() => Quota.initialize(data, MONDAY)); assert.equal(JSON.stringify(data), before);
  assert.throws(() => reserve({}, 'bad', {}, NaN));
});

test('v4 Sol二十倍历史与待结保留，v5新请求三十倍并可重启恢复', () => {
  const data = { weeklyQuota: { version: 1, policyVersion: 4,
    windows: [{ ownerKey: 'alice', weekStart: MONDAY, usedCredits: 120000, reservedCredits: 40000 }],
    calls: [
      { id: 'done-v4', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 4, modelId: 'gpt-6.1-sol', modelMultiplier: 20, outputWeight: 5, startedAt: MONDAY, status: 'success', chargedCredits: 120000 },
      { id: 'pending-v4', ownerKey: 'alice', weekStart: MONDAY, policyVersion: 4, modelId: 'gpt-6.1-sol', modelMultiplier: 20, outputWeight: 5, reservedCredits: 40000, startedAt: MONDAY, status: 'pending' },
    ] } };
  const old = structuredClone(data.weeklyQuota.calls), usage = { input_tokens: 1000, output_tokens: 1000 };
  Quota.initialize(data, MONDAY + 1000); assert.equal(data.weeklyQuota.policyVersion, 6);
  assert.deepEqual(data.weeklyQuota.calls, old); assert.equal(snapshot(data).usedPoints, 120);
  const crashed = structuredClone(data); Quota.recover(crashed, MONDAY + 2000);
  assert.equal(crashed.weeklyQuota.calls[1].chargedCredits, 40000); assert.equal(snapshot(crashed).usedPoints, 160);
  assert.equal(Quota.settle(data, 'pending-v4', { usage }, MONDAY + 2000).chargedCredits, 120000);
  const next = reserve(data, 'new-v5', { modelId: 'gpt-6.1-sol', reasoningEffort: 'max' });
  assert.equal(next.modelMultiplier, 30); assert.equal(next.reservedCredits, 240000);
  const restart = structuredClone(data); Quota.recover(restart, MONDAY + 3000);
  assert.equal(restart.weeklyQuota.calls.at(-1).chargedCredits, 240000);
  assert.equal(Quota.settle(data, 'new-v5', { usage }, MONDAY + 3000).chargedCredits, 180000);
  assert.deepEqual(data.weeklyQuota.calls[0], old[0]);
});

test('体验用户零周额度可读取，禁止预留且降级保留原消费',()=>{
 const data={};reserve(data,'old');Quota.settle(data,'old',{usage:{input_tokens:1000,output_tokens:0}},MONDAY+1500);
 const limited=snapshot(data,{limitPoints:0});assert.equal(limited.usedPoints,1);assert.equal(limited.remainingPoints,0);assert.equal(limited.percent,100);assert.equal(limited.exhausted,true);
 assert.throws(()=>reserve(data,'blocked',{limitPoints:0}));assert.equal(snapshot({},{limitPoints:0}).percent,0);
});
test('Terra新请求十倍覆盖实结/最低值/估算/预留，旧预留与历史保持一倍',()=>{
 const data={};reserve(data,'old',{modelId:'gpt-5.6-terra'});data.weeklyQuota.calls[0].modelMultiplier=1;data.weeklyQuota.calls[0].reservedCredits=2000;data.weeklyQuota.windows[0].reservedCredits=2000;
 const usage={input_tokens:1000,output_tokens:1000};assert.equal(Quota.settle(data,'old',{usage},MONDAY+2000).chargedCredits,6000);
 const old=structuredClone(data.weeklyQuota.calls[0]);
 const next=reserve(data,'new',{modelId:'gpt-5.6-terra',reasoningEffort:'max'});assert.equal(next.modelMultiplier,10);assert.equal(next.reservedCredits,80000);
 assert.equal(Quota.settle(data,'new',{usage},MONDAY+3000).chargedCredits,60000);
 reserve(data,'minimum',{modelId:'gpt-5.6-terra'});assert.equal(Quota.settle(data,'minimum',{usage:{input_tokens:0,output_tokens:0}},MONDAY+4000).chargedCredits,1000);
 reserve(data,'estimated',{modelId:'gpt-5.6-terra',reasoningEffort:'low'});assert.equal(Quota.settle(data,'estimated',{},MONDAY+5000).chargedCredits,10000);
 assert.deepEqual(data.weeklyQuota.calls[0],old);assert.equal(snapshot(data).usedPoints,77);
 const reboot={};reserve(reboot,'pending',{modelId:'gpt-5.6-terra',reasoningEffort:'high'});Quota.recover(reboot,MONDAY+2000);assert.equal(snapshot(reboot).usedPoints,30);
 assert.equal(reserve({},'lookalike',{modelId:'custom/gpt-5.6-terra'}).modelMultiplier,1);
});

test('重置只清当前周已用，保留计价历史和周恢复时间，新调用照常扣点', () => {
 const data={};reserve(data,'before');Quota.settle(data,'before',{usage:{input_tokens:1000,output_tokens:1000}},MONDAY+2000);
 const calls=structuredClone(data.weeklyQuota.calls),reset=Quota.reset(data,{ownerKey:'alice'},MONDAY+3000);
 assert.deepEqual(reset,{weekStart:MONDAY,resetAt:MONDAY+WEEK,restoredPoints:6});assert.deepEqual(data.weeklyQuota.calls,calls);assert.equal(snapshot(data).usedPoints,0);assert.equal(snapshot(data).remainingPoints,1000);assert.equal(data.weeklyQuota.windows[0].resetCredits,6000);
 Quota.settle(data,'before',{},MONDAY+4000);assert.equal(snapshot(data).usedPoints,0);
 reserve(data,'after',{},MONDAY+5000);Quota.settle(data,'after',{usage:{input_tokens:100,output_tokens:100}},MONDAY+6000);assert.equal(snapshot(data).usedPoints,.6);
 Quota.reset(data,{ownerKey:'alice'},MONDAY+7000);assert.equal(data.weeklyQuota.windows[0].resetCredits,6600);assert.equal(data.weeklyQuota.calls.length,2);
});
test('进行中请求、空周和跨周在途请求不允许重置，不吞掉预留或新周额度', () => {
 const data={};assert.throws(()=>Quota.reset(data,{ownerKey:'alice'},MONDAY),{code:'weekly-reset-empty'});
 reserve(data,'pending');const before=structuredClone(data.weeklyQuota);assert.throws(()=>Quota.reset(data,{ownerKey:'alice'},MONDAY+2000),{code:'weekly-reset-pending'});assert.deepEqual(data.weeklyQuota,before);
 assert.throws(()=>Quota.reset(data,{ownerKey:'alice'},MONDAY+WEEK+1),{code:'weekly-reset-pending'});
 Quota.settle(data,'pending',{usage:{input_tokens:100,output_tokens:100}},MONDAY+WEEK+2);assert.throws(()=>Quota.reset(data,{ownerKey:'alice'},MONDAY+WEEK+3),{code:'weekly-reset-empty'});assert.equal(snapshot(data,{},MONDAY+WEEK+4).usedPoints,0);
});
test('重置不会清其他用户、旧周或历史扣费，累计恢复数溢出时保持已用', () => {
 const data={};reserve(data,'old',{},MONDAY-WEEK+1000);Quota.settle(data,'old',{usage:{input_tokens:100,output_tokens:100}},MONDAY-WEEK+2000);
 reserve(data,'bob',{ownerKey:'bob'},MONDAY+1000);Quota.settle(data,'bob',{usage:{input_tokens:100,output_tokens:100}},MONDAY+2000);
 reserve(data,'current');Quota.settle(data,'current',{usage:{input_tokens:100,output_tokens:100}},MONDAY+2000);
 const before=structuredClone(data.weeklyQuota.windows);Quota.reset(data,{ownerKey:'alice'},MONDAY+3000);
 for(const row of before)if(row.ownerKey!=='alice'||row.weekStart!==MONDAY)assert.deepEqual(data.weeklyQuota.windows.find(x=>x.ownerKey===row.ownerKey&&x.weekStart===row.weekStart),row);
 reserve(data,'overflow',{},MONDAY+4000);Quota.settle(data,'overflow',{usage:{input_tokens:0,output_tokens:0}},MONDAY+5000);const window=data.weeklyQuota.windows.find(x=>x.ownerKey==='alice'&&x.weekStart===MONDAY);window.resetCredits=Number.MAX_SAFE_INTEGER;assert.throws(()=>Quota.reset(data,{ownerKey:'alice'},MONDAY+6000),/安全整数/);assert.equal(window.usedCredits,100);
});

test('中转对共享基准减半：预留、完整用量、最低值、未知用量一致，奇数token保持整数积分',()=>{
 for(const [modelId,base]of [['gpt-6-luna',1],['gpt-6.1-sol',30],['gpt-6-astra',300],['future-model',1]]){
  for(const source of ['chatgpt','platform']){
   const rate=base*(source==='platform'?.5:1),data={};
   const call=reserve(data,'full',{source,modelId,reasoningEffort:'low',limitPoints:10000});
   assert.equal(call.modelMultiplier,rate);assert.equal(call.reservedCredits,rate*1000);
   assert.equal(Quota.settle(data,'full',{usage:{input_tokens:1001,output_tokens:1000}},MONDAY+2000).chargedCredits,Math.ceil(6001*rate));
   reserve(data,'minimum',{source,modelId,limitPoints:10000});
   assert.equal(Quota.settle(data,'minimum',{usage:{input_tokens:0,output_tokens:0}},MONDAY+2000).chargedCredits,100*rate);
   reserve(data,'unknown',{source,modelId,reasoningEffort:'max',limitPoints:10000});
   assert.equal(Quota.settle(data,'unknown',{},MONDAY+2000).chargedCredits,8000*rate);
   reserve(data,'partial',{source,modelId,reasoningEffort:'low',limitPoints:10000});
   assert.equal(Quota.settle(data,'partial',{usage:{input_tokens:3001}},MONDAY+2000).chargedCredits,Math.max(1000*rate,Math.ceil(3001*rate)));
   assert.ok(Number.isSafeInteger(snapshot(data).usedCredits));
  }
 }
});
test('v5中转历史和旧预留保持原价，新中转才按半价；恢复、失败和取消均沿用冻结倍率',()=>{
 const data={};reserve(data,'done',{modelId:'gpt-6.1-sol'});Quota.settle(data,'done',{usage:{input_tokens:100,output_tokens:100}});
 reserve(data,'old-pending',{modelId:'gpt-6-luna',reasoningEffort:'max'});
 data.weeklyQuota.policyVersion=5;for(const c of data.weeklyQuota.calls){c.policyVersion=5;c.source='platform';}
 const previous=JSON.stringify(data.weeklyQuota.calls);Quota.initialize(data,MONDAY+2000);assert.equal(JSON.stringify(data.weeklyQuota.calls),previous);
 assert.equal(Quota.settle(data,'old-pending',{},MONDAY+2000).chargedCredits,8000);
 const call=reserve(data,'new',{modelId:'gpt-6-luna',source:'platform',reasoningEffort:'max'});assert.equal(call.modelMultiplier,.5);assert.equal(call.policyVersion,6);
 assert.equal(Quota.recover(data,MONDAY+2000),1);assert.equal(data.weeklyQuota.calls.find(c=>c.id==='new').chargedCredits,4000);assert.equal(Quota.recover(data,MONDAY+2000),0);
 for(const cancelled of [false,true]){
  const id='failure-'+cancelled;reserve(data,id,{modelId:'gpt-6-luna',source:'platform',reasoningEffort:'low'});
  assert.equal(Quota.settle(data,id,{error:Error('upstream'),cancelled},MONDAY+2000).chargedCredits,500);
 }
 reserve(data,'rate-limit',{source:'platform',modelId:'gpt-6-luna'});
 assert.equal(Quota.settle(data,'rate-limit',{httpStatus:429,error:Error('limit')},MONDAY+2000).chargedCredits,0);
 assert.equal(data.weeklyQuota.calls.find(c=>c.id==='done').chargedCredits,18000);
});

test('五个新增模型使用最终固定倍率，中转不减半，预留/实际/最低/估算/取消与限流一致',()=>{
 for(const [modelId,rate]of [['grok-4.6-latest',20],['grok-4.7',25],['claude-sonnet-5-5',30],['claude-opus-5-5',80],['claude-fable-5.1',150]])for(const source of ['platform','chatgpt']){
  const data={},settings={modelId,source,limitPoints:10000,reasoningEffort:'low'};
  assert.equal(Quota.multiplierFor(modelId,source),rate);assert.equal(reserve(data,'actual',settings).reservedCredits,1000*rate);
  assert.equal(Quota.settle(data,'actual',{usage:{input_tokens:100,output_tokens:100}},MONDAY+2000).chargedCredits,600*rate);
  reserve(data,'minimum',settings);assert.equal(Quota.settle(data,'minimum',{usage:{prompt_tokens:0,completion_tokens:0}},MONDAY+2000).chargedCredits,100*rate);
  reserve(data,'estimated',{...settings,reasoningEffort:'max'});assert.equal(Quota.settle(data,'estimated',{},MONDAY+2000).chargedCredits,8000*rate);
  reserve(data,'partial',settings);assert.equal(Quota.settle(data,'partial',{usage:{output_tokens:300}},MONDAY+2000).chargedCredits,1500*rate);
  reserve(data,'cancelled',settings);assert.equal(Quota.settle(data,'cancelled',{cancelled:true},MONDAY+2000).chargedCredits,1000*rate);
  reserve(data,'rejected',settings);assert.equal(Quota.settle(data,'rejected',{httpStatus:429,error:Error('limited')},MONDAY+2000).chargedCredits,0);
 }
 assert.equal(Quota.multiplierFor('gpt-6.1-sol','platform'),15);assert.equal(Quota.multiplierFor('gpt-6-astra','chatgpt'),300);assert.equal(Quota.multiplierFor('gpt-6-luna','platform'),.5);
});
test('新增模型早期半倍已扣和未结算记录不补乘新价，重启恢复保留旧倍率',()=>{
 const data={weeklyQuota:{version:1,policyVersion:6,windows:[{ownerKey:'alice',weekStart:MONDAY,usedCredits:300,reservedCredits:500}],calls:[
  {id:'done',ownerKey:'alice',weekStart:MONDAY,policyVersion:6,source:'platform',modelId:'grok-4.7',modelMultiplier:.5,outputWeight:5,status:'success',startedAt:MONDAY,chargedCredits:300},
  {id:'pending',ownerKey:'alice',weekStart:MONDAY,policyVersion:6,source:'platform',modelId:'claude-opus-5-5',modelMultiplier:.5,outputWeight:5,status:'pending',startedAt:MONDAY,reservedCredits:500}
 ]}};
 const before=structuredClone(data.weeklyQuota.calls[0]);Quota.recover(data,MONDAY+2000);assert.equal(data.weeklyQuota.calls[1].chargedCredits,500);assert.deepEqual(data.weeklyQuota.calls[0],before);
 const next=reserve(data,'new',{modelId:'grok-4.7',source:'platform'});assert.equal(next.modelMultiplier,25);assert.equal(next.reservedCredits,50000);
});

test('GPT-6.1 Terra 实际倍率20，旧记录与在途请求按原倍率结算',()=>{
 for(const source of ['chatgpt','platform']){
  const data={},settings={modelId:'gpt-6.1-terra',source,reasoningEffort:'low'};
  const old=reserve(data,'old',settings);const frozen=source==='platform'?.5:1;
  const stored=data.weeklyQuota.calls.find(call=>call.id===old.id),window=data.weeklyQuota.windows[0];
  stored.modelMultiplier=frozen;stored.reservedCredits=1000*frozen;window.reservedCredits=1000*frozen;
  const current=reserve(data,'new',settings);assert.equal(current.modelMultiplier,20);assert.equal(current.reservedCredits,20000);
  assert.equal(Quota.settle(data,'old',{usage:{input_tokens:100,output_tokens:100}},MONDAY+2000).chargedCredits,600*frozen);
  assert.equal(Quota.settle(data,'new',{usage:{input_tokens:100,output_tokens:100}},MONDAY+2000).chargedCredits,12000);
  assert.equal(Quota.multiplierFor('gpt-6.1-terra',source),20);
 }
 assert.equal(Quota.multiplierFor('custom/gpt-6.1-terra','platform'),.5);
 assert.equal(Quota.multiplierFor('gpt-5.6-terra','chatgpt'),10);
 assert.equal(Quota.multiplierFor('gpt-5.6-terra','platform'),5);
});
