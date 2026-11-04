'use strict';
const DAY = 86400000;
const NAMES = { trial: '体验用户', free: '普通用户', pro: 'Pro', max: 'Max' };
const RANK = { trial: -1, free: 0, pro: 1, max: 2 };
const REQUIRED = { 'gpt-5.6-terra': 'pro', 'gpt-6.1-sol': 'pro', 'gpt-6-astra': 'max' };
const validPlan = value => Object.hasOwn(NAMES, value);
const relayExempt = modelId => /(?:^|\/)(?:gpt|grok)(?:[-_.0-9]|$)/i.test(modelId);
function requiredPlan(modelId, { restrictedRelay = false } = {}) {
  if (restrictedRelay && !relayExempt(modelId)) return 'max';
  if (Object.hasOwn(REQUIRED, modelId)) return REQUIRED[modelId];
  return /(?:^|\/)(?:grok|claude)(?:[-_.]|$)/i.test(modelId) ? 'pro' : 'free';
}
function snapshot(user, now = Date.now()) {
  const saved = user?.membership;
  const configuredPlan = validPlan(saved?.plan) ? saved.plan : 'free';
  const expiresAt = !['trial','free'].includes(configuredPlan) && Number.isSafeInteger(saved?.expiresAt) ? saved.expiresAt : null;
  const expired = !['trial','free'].includes(configuredPlan) && (!expiresAt || expiresAt <= now);
  const plan = expired ? 'free' : configuredPlan;
  return { plan, name: NAMES[plan], configuredPlan, expiresAt, expired };
}
function allows(user, modelId, now = Date.now(), options = {}) {
  if (!user || user.disabled) return false;
  if (user.role === 'admin') return true;
  return RANK[snapshot(user, now).plan] >= RANK[requiredPlan(modelId, options)];
}
module.exports = { DAY, NAMES, REQUIRED, validPlan, snapshot, allows, requiredPlan, relayExempt };
