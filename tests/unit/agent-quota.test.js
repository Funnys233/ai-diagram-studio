'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { CloudRuntime } = require('../../lib/cloud-runtime'), { AgentQuota } = require('../../lib/agent-quota');
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-quota-ledger-'));
  const env = { APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://fixture.example', CLOUD_DATA_DIR: directory, CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'fixture-password' };
  const cloud = new CloudRuntime(env, directory);
  const user = { id: crypto.randomUUID(), username: 'alice', role: 'user', disabled: false, membership: { plan: 'max', expiresAt: Date.now() + 86400000 } };
  cloud.change(data => data.users.push(user));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const job = (patch = {}) => ({ id: crypto.randomUUID(), ownerId: user.id, status: 'running', dispatchState: 'armed', modelSelection: { providerId: 'platform:relay', modelId: 'gpt-6.1-sol', source: 'platform', quotaPool: 'weekly', multiplier: 15 }, ...patch });
  return { cloud, meter: new AgentQuota(cloud), job, user, directory, env };
}
const usage = (patch = {}) => ({ calls: 3, complete: true, inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400, reasoningTokens: 50, ...patch });
test('a complete multi-step DSH turn uses the chat model rate once, without counting cache or reasoning twice', t => {
  const { cloud, meter, job, user } = setup(t), task = job(); meter.reserve(task);
  assert.equal(meter.view(task).status, 'pending');
  const quota = meter.settle(task, { status: 'completed', usage: usage() });
  assert.equal(quota.points, 22.5); assert.equal(quota.estimated, false);
  assert.equal(cloud.weeklySnapshot(user.id).usedPoints, 22.5);
  assert.equal(cloud.data.events.filter(event => event.turnId === task.id).length, 1);
  assert.equal(cloud.turnUsage(user.id, task.id).weeklyPoints, 22.5);
  assert.equal(meter.settle(task, { status: 'completed', usage: usage() }).points, 22.5);
  assert.equal(cloud.weeklySnapshot(user.id).usedPoints, 22.5);
});
test('web restart leaves DSH reservations pending until its durable task recovers actual consumption', t => {
  const { meter, job, user, directory, env } = setup(t), task = job(); meter.reserve(task);
  const restarted = new CloudRuntime(env, directory), next = new AgentQuota(restarted);
  assert.equal(next.view(task).status, 'pending'); next.recover(new Map([[task.id, { ...task, status: 'unknown' }]]));
  assert.equal(next.view(task).status, 'pending'); assert.equal(restarted.weeklySnapshot(user.id).usedPoints, 0);
  assert.equal(next.settle(task, { status: 'failed', usage: usage() }).points, 22.5);
  assert.equal(restarted.weeklySnapshot(user.id).reservedPoints, 0);
});
test('confirmed non-dispatch and zero-call receipts release all reservations, while missing usage remains estimated', t => {
  const { meter, job } = setup(t);
  for (const result of [{ status: 'failed', recoveryReason: 'not-accepted' }, { status: 'rejected' }, { status: 'failed', usage: { calls: 0, complete: true, inputTokens: 0, outputTokens: 0 } }]) {
    const task = job(); meter.reserve(task); const quota = meter.settle(task, result); assert.equal(quota.points, 0); assert.equal(quota.estimated, false);
  }
  const task = job(); meter.reserve(task); const quota = meter.settle(task, { status: 'failed', usage: { calls: 2, complete: false, inputTokens: 10, outputTokens: 1 } });
  assert.equal(quota.points, 60); assert.equal(quota.estimated, true);
});
test('complete gateway observations fill missing SDK usage, including zero-consumption upstream 429', t => {
  const { meter, job } = setup(t);
  const task = job({ gatewayStarted: 1 }); meter.reserve(task);
  const tasks = { update(job, patch) { Object.assign(job, patch); } };
  meter.finishCall(task, tasks, { httpStatus: 429 }, Error('rate limit'));
  assert.equal(meter.settle(task, { status: 'failed', usage: { calls: 1, complete: false } }).points, 0);
  const measured = job({ gatewayStarted: 1 }); meter.reserve(measured);
  meter.finishCall(measured, tasks, { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } });
  const quota = meter.settle(measured, { status: 'failed', usage: { calls: 1, complete: false } });
  assert.equal(quota.points, 3); assert.equal(quota.estimated, false);
});
test('personal models do not consume weekly points, and disabled or trial users cannot reserve DSH access', t => {
  const { cloud, meter, job, user } = setup(t);
  const personal = job({ modelSelection: { providerId: 'personal:mine', modelId: 'gpt-6-astra', source: 'personal', quotaPool: 'personal', multiplier: null } });
  meter.reserve(personal); assert.equal(meter.settle(personal, { status: 'completed', usage: usage() }).points, 0);
  assert.equal(cloud.weeklySnapshot(user.id).usedPoints, 0);
  cloud.change(data => { data.users.find(row => row.id === user.id).membership = { plan: 'trial' }; });
  assert.throws(() => meter.reserve(job()), { status: 403 });
});
test('quota exhaustion blocks new work, preserves fixed rates, and orphan reservations can be reconciled once', t => {
  const { cloud, meter, job, user } = setup(t), task = job();
  cloud.change(data => { data.users.find(row => row.id === user.id).weeklyLimitPoints = 31; });
  meter.reserve(task);
  assert.throws(() => meter.reserve(job()), { status: 429 });
  meter.recover(new Map()); assert.equal(meter.view(task).status, 'settled'); assert.equal(meter.view(task).points, 30);
  meter.recover(new Map()); assert.equal(cloud.weeklySnapshot(user.id).usedPoints, 30);
  assert.throws(() => meter.reserve(task), { status: 409 });
});
test('a turn crossing the weekly reset keeps its original quota window for additional calls', t => {
  const { cloud, meter, job, user } = setup(t), task = job();
  cloud.change(data => { data.users.find(row => row.id === user.id).weeklyLimitPoints = 31; });
  meter.reserve(task);
  cloud.change(data => {
    const call = data.weeklyQuota.calls.find(row => row.id === 'agent:' + task.id), window = data.weeklyQuota.windows.find(row => row.ownerKey === user.id && row.weekStart === call.weekStart);
    call.weekStart -= 7 * 86400000; window.weekStart = call.weekStart; window.usedCredits = 2000;
  });
  task.gatewayUsage = { calls: 1, complete: true, inputTokens: 2000, outputTokens: 0 };
  assert.equal(cloud.weeklySnapshot(user.id).remainingPoints, 31);
  assert.equal(meter.canCall(task), false, 'old-window usage plus observed consumption exceeds its frozen limit');
});
test('reusing another account task ID cannot expose or settle its ledger record', t => {
  const { cloud, meter, job, user } = setup(t), original = job(); meter.reserve(original);
  const otherId = crypto.randomUUID(); cloud.change(data => data.users.push({ ...user, id: otherId, username: 'bob' }));
  const forged = { ...original, ownerId: otherId };
  assert.equal(meter.view(forged), null); assert.equal(meter.settle(forged, { status: 'completed', usage: usage() }), null);
  assert.equal(meter.view(original).status, 'pending'); assert.throws(() => meter.reserve(forged), { status: 409 });
  assert.equal(meter.settle(original, { status: 'completed', usage: usage() }).points, 22.5);
  assert.equal(meter.view(forged), null); assert.equal(meter.canCall(forged), false);
});
test('a stopped SDK cannot seal an estimated bill before its live gateway call records final usage', t => {
  const { meter, job } = setup(t), task = job({ modelSelection: { providerId: 'chatgpt:fixture', modelId: 'gpt-6-luna', source: 'chatgpt', quotaPool: 'weekly', multiplier: 1 } });
  const tasks = { update(job, patch) { Object.assign(job, patch); } };
  meter.reserve(task); meter.beginCall(task, tasks);
  assert.equal(meter.settle(task, { status: 'cancelled', usage: { calls: 1, complete: false } }), null);
  assert.equal(meter.view(task).status, 'pending');
  meter.finishCall(task, tasks, { usage: { prompt_tokens: 10000, completion_tokens: 1000 } });
  assert.equal(meter.hasLiveCall(task), false);
  assert.equal(meter.settle(task, { status: 'cancelled', usage: { calls: 1, complete: false } }).points, 15);
});
test('unknown-usage calls each keep an estimate and stop further calls when the original allowance is exhausted', t => {
  const { cloud, meter, job, user } = setup(t);
  cloud.change(data => { data.users.find(row => row.id === user.id).weeklyLimitPoints = 5; });
  const task = job({ modelSelection: { providerId: 'chatgpt:fixture', modelId: 'gpt-6-luna', source: 'chatgpt', quotaPool: 'weekly', multiplier: 1 } });
  const tasks = { update(job, patch) { Object.assign(job, patch); } };
  meter.reserve(task); assert.equal(meter.canCall(task), true);
  meter.beginCall(task, tasks); meter.finishCall(task, tasks, {}); assert.equal(meter.canCall(task), true);
  meter.beginCall(task, tasks); meter.finishCall(task, tasks, {}); assert.equal(meter.canCall(task), false);
  const quota = meter.settle(task, { status: 'failed', usage: { calls: 2, complete: false } });
  assert.equal(quota.points, 4); assert.equal(quota.estimated, true);
});
