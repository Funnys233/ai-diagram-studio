'use strict';
const WeeklyQuota = require('./weekly-quota'), UsageReport = require('./usage-report');
const { TaskError } = require('./conversation-tasks');
const { validateUsage } = require('../services/dsh-bridge/file-protocol');
const ACTIVE = new Set(['submitting', 'running', 'unknown', 'cancelling']);
const fail = (status, code, message) => new TaskError(status, code, message);
const callId = id => 'agent:' + id;
const measured = usage => {
  if (!validateUsage(usage)) return null;
  return { ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined ? { input_tokens_details: { cached_tokens: usage.cachedInputTokens } } : {}) };
};
class AgentQuota {
  constructor(cloud) { this.cloud = cloud; this.liveCalls = new Set(); }
  reserve(job) {
    const selection = job.modelSelection;
    if (!selection) return null;
    const cloud = this.cloud, id = callId(job.id), user = cloud.data.users.find(user => user.id === job.ownerId && !user.disabled);
    if (!user) throw fail(401, 'login-required', '账号不可用，请重新登录。');
    if (cloud.isTrial(user.id)) throw fail(403, 'agent-membership-required', '智能任务仅向普通用户及以上开放。');
    cloud.assertModelUse({ identity: { user } }, selection.source, selection.providerId, selection.modelId);
    cloud.change(data => {
      const previous = data.events.find(event => event.id === id);
      if (previous) {
        if (previous.userId !== job.ownerId || previous.status !== 'started') throw fail(409, 'agent-task-used', '任务编号已结算，请新建任务。');
        return;
      }
      let reservation;
      if (selection.quotaPool === 'weekly') {
        try { reservation = WeeklyQuota.reserve(data, { id, ownerKey: job.ownerId, limitPoints: cloud.weeklyLimit(job.ownerId), modelId: selection.modelId, source: selection.source, reasoningEffort: job.modelLock?.model?.thinkingMode?.endsWith('-off') ? 'none' : job.modelLock?.model?.reasoningEffort }); }
        catch (error) { if (error.code === 'weekly-limit') throw fail(429, error.code, error.message); throw error; }
        Object.assign(data.weeklyQuota.calls.find(call => call.id === id), { kind: 'agent', agentLimitCredits: Math.round(cloud.weeklyLimit(job.ownerId) * 1000) });
      }
      const date = new Date().toISOString().slice(0, 10);
      if (data.usage.date !== date) data.usage = { date, total: 0, platform: 0, users: {} };
      data.usage.total++; data.usage.users[job.ownerId] = (data.usage.users[job.ownerId] || 0) + 1;
      if (selection.source === 'platform') data.usage.platform++;
      UsageReport.start(data, { id, kind: 'agent', userId: job.ownerId, source: selection.source, providerId: selection.providerId, modelId: selection.modelId,
        turnId: job.id, subscriptionOwnerId: selection.source === 'chatgpt' ? cloud.subscriptionOwnerId : null,
        time: Date.now(), status: 'started', usage: null, errorCode: null,
        quota: { pool: selection.quotaPool, points: null, estimated: false, reservedPoints: reservation ? reservation.reservedCredits / 1000 : 0, modelMultiplier: reservation?.modelMultiplier, policyVersion: reservation?.policyVersion || 1 } });
    });
    return this.view(job);
  }
  view(job) {
    if (!job.modelSelection) return null;
    const event = this.cloud.data.events.find(row => row.id === callId(job.id) && row.userId === job.ownerId);
    if (!event) return null;
    const call = this.cloud.data.weeklyQuota?.calls.find(row => row.id === event.id && row.ownerKey === job.ownerId);
    return { pool: event.quota.pool, status: event.status === 'started' ? 'pending' : 'settled',
      points: call?.status === 'pending' ? null : call ? call.chargedCredits / 1000 : 0,
      reservedPoints: call?.status === 'pending' ? call.reservedCredits / 1000 : 0,
      estimated: call?.estimated === true, multiplier: call?.modelMultiplier ?? job.modelSelection.multiplier ?? null };
  }
  settle(job, remote = job) {
    if (!job.modelSelection) return null;
    if (this.liveCalls.has(job.id)) return null;
    const id = callId(job.id), existing = this.cloud.data.events.find(event => event.id === id);
    if (!existing || existing.userId !== job.ownerId) return null;
    const reservation = this.cloud.data.weeklyQuota?.calls.find(row => row.id === id);
    if (reservation && reservation.ownerKey !== job.ownerId) throw fail(409, 'agent-quota-owner', '任务额度归属不一致。');
    if (existing.status !== 'started') return this.view(job);
    let usage = validateUsage(remote.usage) ? remote.usage : null;
    // Gateway counters are a second durable observation. Prefer the larger
    // known totals when an SDK transport error omitted an attempted call.
    if (validateUsage(job.gatewayUsage)) {
      const gateway = job.gatewayUsage;
      if (gateway.complete && (!usage?.complete || gateway.calls >= usage.calls)) usage = gateway;
      else usage = usage ? { calls: Math.max(usage.calls, gateway.calls), complete: usage.complete && gateway.complete && usage.calls === gateway.calls,
        ...Object.fromEntries(['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens'].filter(key => usage[key] !== undefined || gateway[key] !== undefined).map(key => [key, Math.max(usage[key] || 0, gateway[key] || 0)])) } : gateway;
    }
    const noConsumptionConfirmed = remote.recoveryReason === 'not-accepted' || remote.status === 'rejected' || job.dispatchState === 'prepared'
      || job.gatewayStarted === 0 && !(usage?.inputTokens || usage?.outputTokens)
      || usage?.complete && usage.calls === 0 && usage.inputTokens === 0 && usage.outputTokens === 0
      || job.gatewayRejections > 0 && job.gatewayRejections === job.gatewayUsage?.calls && !(usage?.inputTokens || usage?.outputTokens);
    const error = remote.status === 'completed' ? null : { code: noConsumptionConfirmed ? 'agent-not-dispatched' : 'agent-' + (remote.status || 'interrupted') };
    const unknownCalls = Math.max(1, Math.max(usage?.calls || 0, job.gatewayStarted || 0) - (job.gatewayMeasuredCalls || 0));
    const estimatedMinimumCredits = reservation ? Math.min(Number.MAX_SAFE_INTEGER, Math.ceil((job.gatewayKnownWeight || 0) * reservation.modelMultiplier + unknownCalls * reservation.reservedCredits)) : 0;
    this.cloud.change(data => {
      const call = WeeklyQuota.settle(data, id, { usage: measured(usage), error, cancelled: remote.status === 'cancelled', forceEstimated: !usage?.complete, noConsumptionConfirmed, estimatedMinimumCredits });
      UsageReport.finish(data, id, { usage: measured(usage) }, error, remote.status === 'cancelled');
      const event = data.events.find(row => row.id === id);
      if (call) event.quota = { pool: 'weekly', points: call.chargedCredits / 1000, estimated: call.estimated, reservedPoints: 0, policyVersion: call.policyVersion, modelMultiplier: call.modelMultiplier };
      else event.quota = { ...event.quota, points: 0, reservedPoints: 0 };
    });
    return this.view(job);
  }
  recover(jobs) {
    for (const event of this.cloud.data.events.filter(event => event.kind === 'agent' && event.status === 'started')) {
      const job = jobs.get(event.turnId);
      if (job && ACTIVE.has(job.status)) continue;
      this.settle(job || { id: event.turnId, ownerId: event.userId, modelSelection: { quotaPool: event.quota.pool } }, job || { status: 'failed' });
    }
  }
  canCall(job) {
    if (job.modelSelection?.quotaPool !== 'weekly') return true;
    const call = this.cloud.data.weeklyQuota?.calls.find(row => row.id === callId(job.id));
    if (!call || call.ownerKey !== job.ownerId || call.status !== 'pending') return false;
    const window = this.cloud.data.weeklyQuota.windows.find(row => row.ownerKey === job.ownerId && row.weekStart === call.weekStart);
    const available = (call.agentLimitCredits ?? this.cloud.weeklyLimit(job.ownerId) * 1000) - (window?.usedCredits || 0) - Math.max(0, (window?.reservedCredits || 0) - call.reservedCredits);
    const observed = job.gatewayUsage, unknownCalls = Math.max(0, (job.gatewayStarted || 0) - (job.gatewayMeasuredCalls || 0));
    const credits = Math.ceil(Math.max(((observed?.inputTokens || 0) + 5 * (observed?.outputTokens || 0)) * call.modelMultiplier,
      (job.gatewayKnownWeight || 0) * call.modelMultiplier + unknownCalls * call.reservedCredits));
    return credits + call.reservedCredits <= available;
  }
  beginCall(job, tasks) {
    tasks.update(job, { gatewayStarted: (job.gatewayStarted || 0) + 1 });
    this.liveCalls.add(job.id);
  }
  hasLiveCall(job) { return this.liveCalls.has(job.id); }
  finishCall(job, tasks, result, error) {
    const raw = result?.usage || error?.extra?.usage, integer = value => Number.isSafeInteger(value) && value >= 0;
    const input = raw?.prompt_tokens ?? raw?.input_tokens, output = raw?.completion_tokens ?? raw?.output_tokens;
    const rejected = result?.httpStatus === 429 && !(input > 0 || output > 0);
    const known = rejected || integer(input) && integer(output);
    const previous = job.gatewayUsage || {}, gatewayCompleted = (job.gatewayCompleted || 0) + 1, allMeasured = job.gatewayAllMeasured !== false && known;
    const usage = { calls: job.gatewayStarted || gatewayCompleted, complete: allMeasured && gatewayCompleted === job.gatewayStarted };
    for (const [key, value] of Object.entries({ inputTokens: rejected ? 0 : input, outputTokens: rejected ? 0 : output,
      cachedInputTokens: raw?.prompt_tokens_details?.cached_tokens ?? raw?.input_tokens_details?.cached_tokens,
      reasoningTokens: raw?.completion_tokens_details?.reasoning_tokens ?? raw?.output_tokens_details?.reasoning_tokens })) {
      if (integer(value) || previous[key] !== undefined) usage[key] = (previous[key] || 0) + (integer(value) ? value : 0);
    }
    if (rejected) { usage.inputTokens ??= 0; usage.outputTokens ??= 0; }
    if (!validateUsage(usage)) { this.liveCalls.delete(job.id); throw Error('Invalid gateway usage aggregate'); }
    try { tasks.update(job, { gatewayUsage: usage, gatewayCompleted, gatewayAllMeasured: allMeasured,
      gatewayMeasuredCalls: (job.gatewayMeasuredCalls || 0) + (known ? 1 : 0),
      gatewayKnownWeight: (job.gatewayKnownWeight || 0) + (known && !rejected ? input + 5 * output : 0),
      gatewayRejections: (job.gatewayRejections || 0) + (rejected ? 1 : 0) }); }
    finally { this.liveCalls.delete(job.id); }
  }
}
module.exports = { AgentQuota };
