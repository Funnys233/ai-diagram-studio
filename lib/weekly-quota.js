'use strict';

// Credits are thousandths of a point. This module only changes the supplied
// data; the caller owns atomic persistence and decides which sources are billed.
const DAY = 86400000;
const WEEK = 7 * DAY;
const POLICY_VERSION = 6;
const MODEL_MULTIPLIERS = { 'gpt-5.6-terra': 10, 'gpt-6.1-sol': 30, 'gpt-6-astra': 300 };
// These are final website rates, including for platform relay requests.
const FIXED_MODEL_MULTIPLIERS = { 'gpt-6.1-terra': 20, 'grok-4.6-latest': 20, 'grok-4.7': 25,
  'claude-sonnet-5-5': 30, 'claude-opus-5-5': 80, 'claude-fable-5.1': 150 };
const FALLBACK_POINTS = { none: 1, low: 1, medium: 2, high: 3, xhigh: 5, max: 8 };
const integer = value => Number.isSafeInteger(value) && value >= 0;

function clock(now) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new TypeError('用量时间不合法');
  return now;
}
function weekOf(now) {
  const date = new Date(clock(now));
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return midnight - (date.getUTCDay() + 6) % 7 * DAY;
}
function key(value, name) {
  if (typeof value !== 'string' || !value || value.length > 300) throw new TypeError(name + ' 不合法');
  return value;
}
function creditsForLimit(points) {
  const credits = Math.round(points * 1000);
  if (typeof points !== 'number' || !Number.isFinite(points) || points <= 0 || !Number.isSafeInteger(credits) || credits < 1) throw new TypeError('周额度必须是正数');
  return credits;
}
function prune(ledger, now) {
  const cutoff = now - 90 * DAY;
  ledger.calls = ledger.calls.filter(call => call.status === 'pending' || call.startedAt >= cutoff);
  const retainedWindows = new Set(ledger.calls.map(call => call.ownerKey + ':' + call.weekStart));
  ledger.windows = ledger.windows.filter(window => window.weekStart + WEEK >= cutoff
    || retainedWindows.has(window.ownerKey + ':' + window.weekStart));
}
function initialize(data, now = Date.now()) {
  clock(now);
  if (!data.weeklyQuota) data.weeklyQuota = { version: 1, policyVersion: POLICY_VERSION, windows: [], calls: [] };
  const ledger = data.weeklyQuota;
  if (ledger.version !== 1 || ![1, 2, 3, 4, 5, POLICY_VERSION].includes(ledger.policyVersion) || !Array.isArray(ledger.windows) || !Array.isArray(ledger.calls)) throw new Error('周额度数据版本或结构不支持');
  // Upgrade the marker only; older calls keep the rates in effect at reservation.
  ledger.policyVersion = POLICY_VERSION;
  prune(ledger, now);
  return ledger;
}
function windowFor(ledger, ownerKey, weekStart, create = false) {
  let window = ledger.windows.find(row => row.ownerKey === ownerKey && row.weekStart === weekStart);
  if (!window && create) {
    window = { ownerKey, weekStart, usedCredits: 0, reservedCredits: 0 };
    ledger.windows.push(window);
  }
  return window;
}
function fallbackCredits(effort) {
  return (Object.hasOwn(FALLBACK_POINTS, effort) ? FALLBACK_POINTS[effort] : 2) * 1000;
}
function snapshot(data, { ownerKey, limitPoints }, now = Date.now()) {
  key(ownerKey, '额度账号');
  const limitCredits = limitPoints === 0 ? 0 : creditsForLimit(limitPoints), weekStart = weekOf(now);
  const ledger = initialize(data, now), window = windowFor(ledger, ownerKey, weekStart);
  const usedCredits = window?.usedCredits || 0, reservedCredits = window?.reservedCredits || 0;
  return { policyVersion: POLICY_VERSION, ownerKey, weekStart, resetAt: weekStart + WEEK,
    limitPoints: limitCredits / 1000, usedPoints: usedCredits / 1000, reservedPoints: reservedCredits / 1000,
    remainingPoints: Math.max(0, limitCredits - usedCredits - reservedCredits) / 1000,
    usedCredits, reservedCredits, limitCredits, percent: limitCredits ? Math.min(100, usedCredits / limitCredits * 100) : usedCredits ? 100 : 0,
    exhausted: usedCredits + reservedCredits >= limitCredits };
}
function multiplierFor(modelId, source = 'chatgpt') {
  if (Object.hasOwn(FIXED_MODEL_MULTIPLIERS, modelId)) return FIXED_MODEL_MULTIPLIERS[modelId];
  const base = Object.hasOwn(MODEL_MULTIPLIERS, modelId) ? MODEL_MULTIPLIERS[modelId] : 1;
  return base * (source === 'platform' ? 0.5 : 1);
}
function reserve(data, { id, ownerKey, limitPoints, modelId = '', source = 'chatgpt', reasoningEffort = null }, now = Date.now()) {
  key(id, '调用编号'); key(ownerKey, '额度账号');
  if (typeof modelId !== 'string' || modelId.length > 300) throw new TypeError('模型编号不合法');
  if (!['platform', 'chatgpt'].includes(source)) throw new TypeError('周额度来源不合法');
  const limitCredits = creditsForLimit(limitPoints), weekStart = weekOf(now), ledger = initialize(data, now);
  const previous = ledger.calls.find(call => call.id === id);
  if (previous) {
    if (previous.ownerKey !== ownerKey) throw new Error('调用编号已经属于其他账号');
    return { ...previous, resetAt: previous.weekStart + WEEK };
  }
  const modelMultiplier = multiplierFor(modelId, source);
  const reservedCredits = fallbackCredits(reasoningEffort) * modelMultiplier, window = windowFor(ledger, ownerKey, weekStart);
  if ((window?.usedCredits || 0) + (window?.reservedCredits || 0) + reservedCredits > limitCredits) {
    const error = new Error(reservedCredits > limitCredits
      ? `当前模型和思考档位需预留 ${reservedCredits / 1000} 点，超过每周 ${limitCredits / 1000} 点上限；请降低思考强度或联系管理员调整额度`
      : '本周剩余额度不足，请降低思考强度或等待下周一北京时间 08:00 恢复');
    error.code = 'weekly-limit'; error.resetAt = weekStart + WEEK;
    throw error;
  }
  const call = { id, ownerKey, weekStart, policyVersion: POLICY_VERSION, modelId, source, modelMultiplier, outputWeight: 5,
    rateLimitPolicy: 1, streamBusyPolicy: 1,
    reasoningEffort: Object.hasOwn(FALLBACK_POINTS, reasoningEffort) ? reasoningEffort : null,
    reservedCredits, startedAt: now, status: 'pending' };
  windowFor(ledger, ownerKey, weekStart, true).reservedCredits += reservedCredits;
  ledger.calls.push(call);
  return { ...call, resetAt: weekStart + WEEK };
}
function normalizeUsage(value) {
  const input = integer(value?.input_tokens) ? value.input_tokens : integer(value?.prompt_tokens) ? value.prompt_tokens : null;
  const output = integer(value?.output_tokens) ? value.output_tokens : integer(value?.completion_tokens) ? value.completion_tokens : null;
  return { inputTokens: input, outputTokens: output };
}
function settle(data, id, { usage, httpStatus, error = null, cancelled = false, forceEstimated = false, noConsumptionConfirmed = false, estimatedMinimumCredits = 0 } = {}, now = Date.now()) {
  const ledger = initialize(data, now), call = ledger.calls.find(row => row.id === id);
  if (!call) return null;
  if (call.status !== 'pending') return { ...call };
  const rawUsage = usage || error?.extra?.usage;
  const tokens = normalizeUsage(rawUsage);
  // Waive explicit rejections only. Other stream errors, cancellations and
  // connection failures retain their charge. Freeze each rule at reservation.
  const noReportedConsumption = !['input_tokens', 'prompt_tokens', 'output_tokens', 'completion_tokens', 'total_tokens'].some(key => rawUsage?.[key] > 0);
  const rejectionReason = call.kind === 'agent' && noConsumptionConfirmed && noReportedConsumption ? 'agent-not-dispatched' : !cancelled && Boolean(error) && noReportedConsumption
    ? call.rateLimitPolicy === 1 && httpStatus === 429 ? 'http-429'
      : call.streamBusyPolicy === 1 && error.code === 'upstream-busy'
        && error.extra?.upstreamRejectedBeforeGeneration === true ? 'stream-busy' : null
    : null;
  const unbilledRejection = Boolean(rejectionReason);
  const estimated = !unbilledRejection && (forceEstimated || tokens.inputTokens === null || tokens.outputTokens === null);
  // v1 had no model multiplier; v1/v2 used output weight 4.
  const modelMultiplier = call.modelMultiplier ?? 1;
  const outputWeight = call.outputWeight ?? 4;
  // Half-rate models can produce half a credit; keep storage in whole credits
  // (0.001 point), rounding upward once after weighting the complete usage.
  const measuredCredits = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(((tokens.inputTokens || 0) + outputWeight * (tokens.outputTokens || 0)) * modelMultiplier));
  const agentMinimum = call.kind === 'agent' && integer(estimatedMinimumCredits) ? estimatedMinimumCredits : 0;
  const chargedCredits = unbilledRejection ? 0 : estimated ? Math.max(call.reservedCredits, measuredCredits, agentMinimum) : Math.max(100 * modelMultiplier, measuredCredits);
  const window = windowFor(ledger, call.ownerKey, call.weekStart, true);
  if (!Number.isSafeInteger(window.usedCredits + chargedCredits)) throw new Error('周额度累计超出安全整数范围');
  window.reservedCredits = Math.max(0, window.reservedCredits - call.reservedCredits);
  window.usedCredits += chargedCredits;
  Object.assign(call, tokens, { chargedCredits, estimated, ...(unbilledRejection ? { unbilledReason: rejectionReason } : {}), settledAt: now,
    status: cancelled ? 'cancelled' : error ? 'failed' : 'success' });
  return { ...call };
}
function recover(data, now = Date.now()) {
  const ledger = initialize(data, now);
  let count = 0;
  for (const call of ledger.calls) {
    if (call.status !== 'pending') continue;
    // DSH keeps running on a separate host. Its task manager reconciles these
    // reservations after loading durable jobs; a web restart is not failure.
    if (call.kind === 'agent') continue;
    settle(data, call.id, {}, now);
    call.status = 'interrupted';
    count++;
  }
  return count;
}

function reset(data, { ownerKey }, now = Date.now()) {
  key(ownerKey, '额度账号');
  const ledger = initialize(data, now), weekStart = weekOf(now);
  const window = windowFor(ledger, ownerKey, weekStart);
  const reject = (code, message) => { const error = new Error(message); error.code = code; throw error; };
  if (ledger.calls.some(call => call.ownerKey === ownerKey && call.status === 'pending') || window?.reservedCredits) {
    reject('weekly-reset-pending', '还有进行中的周额度请求，请完成或取消后再重置');
  }
  if (!window?.usedCredits) reject('weekly-reset-empty', '本周尚未消耗额度，无需重置');
  const restoredCredits = window.usedCredits, resetCredits = (window.resetCredits || 0) + restoredCredits;
  if (!Number.isSafeInteger(resetCredits)) throw new Error('累计重置额度超出安全整数范围');
  window.usedCredits = 0; window.resetCredits = resetCredits; window.lastResetAt = now;
  return { weekStart, resetAt: weekStart + WEEK, restoredPoints: restoredCredits / 1000 };
}

module.exports = { initialize, reserve, settle, snapshot, recover, reset, multiplierFor };
