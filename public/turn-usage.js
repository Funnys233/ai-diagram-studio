(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiagramTurnUsage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const token = value => Number.isSafeInteger(value) && value >= 0;
  function normalizeCache(cache, calls) {
    if (!cache || !token(cache.knownCalls) || !token(cache.unknownCalls) || cache.knownCalls + cache.unknownCalls !== calls
      || !(cache.cachedTokens === null || token(cache.cachedTokens)) || !(cache.inputTokens === null || token(cache.inputTokens))
      || (cache.knownCalls === 0) !== (cache.cachedTokens === null)
      || cache.inputTokens !== null && cache.cachedTokens > cache.inputTokens) return null;
    return { cachedTokens: cache.cachedTokens, inputTokens: cache.inputTokens,
      hitRate: cache.hitRate !== null && amount(cache.hitRate) && cache.hitRate <= 100 && cache.inputTokens > 0
        ? cache.cachedTokens / cache.inputTokens * 100 : null,
      knownCalls: cache.knownCalls, unknownCalls: cache.unknownCalls };
  }
  function normalize(value) {
    if (!value || !validId(value.turnId) || !['settled', 'pending', 'unknown'].includes(value.status)) return null;
    if (!['calls', 'freeCalls', 'personalCalls'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)
      || !amount(value.weeklyPoints) || !amount(value.reservedPoints)) return null;
    return { turnId: value.turnId, status: value.status, calls: value.calls, weeklyPoints: value.weeklyPoints,
      freeCalls: value.freeCalls, personalCalls: value.personalCalls, reservedPoints: value.reservedPoints, estimated: value.estimated === true,
      ...(normalizeCache(value.cache, value.calls) ? { cache: normalizeCache(value.cache, value.calls) } : {}) };
  }
  const unknown = turnId => ({ turnId, status: 'unknown', calls: 0, weeklyPoints: 0, reservedPoints: 0, freeCalls: 0, personalCalls: 0, estimated: false });
  function label(value) {
    const usage = normalize(value);
    if (!usage || usage.status === 'unknown') return '本轮消耗暂未获取';
    const format = number => number.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
    const parts = [];
    if (usage.weeklyPoints) parts.push(`${format(usage.weeklyPoints)} 点${usage.estimated ? '（含估算）' : ''}`);
    if (usage.freeCalls) parts.push(`免费额度 ${usage.freeCalls} 次`);
    if (usage.personalCalls) parts.push('个人 API，仅统计');
    if (usage.status === 'pending') parts.push(usage.reservedPoints ? `预留 ${format(usage.reservedPoints)} 点，结算中` : '结算中');
    if (!parts.length) return '本轮未消耗额度';
    return '本轮消耗：' + parts.join(' · ') + (usage.calls > 1 ? ` · 共 ${usage.calls} 次调用` : '');
  }
  function paint(host, value) {
    host.querySelector('.turn-usage')?.remove();
    const row = document.createElement('div'); row.className = 'turn-usage'; row.textContent = label(value);
    const cacheText = cacheLabel(value);
    if (cacheText) { const cache = document.createElement('span'); cache.className = 'turn-cache'; cache.textContent = cacheText; row.appendChild(cache); }
    const receipt = normalize(value);
    if (receipt) { row.dataset.turnId = receipt.turnId; row.dataset.status = receipt.status; }
    row.setAttribute('role', 'status'); host.appendChild(row);
  }
  function cacheLabel(value) {
    const usage = normalize(value), cache = usage?.cache;
    if (!cache || !usage.calls || usage.status === 'unknown') return '';
    if (cache.cachedTokens === null) return usage.status === 'pending' ? '缓存：等待接口用量' : '缓存：接口未提供';
    const format = number => number.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
    return `缓存命中：${format(cache.cachedTokens)} token` + (cache.hitRate !== null ? ` · ${format(cache.hitRate)}%` : '')
      + (cache.unknownCalls ? `（仅 ${cache.knownCalls}/${usage.calls} 次有数据）` : '');
  }
  async function settle(request, turnId, update) {
    if (!validId(turnId)) return;
    let latest = unknown(turnId);
    for (const delay of [150, 350, 700, 1200, 1800, 2500]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const response = await request('/api/usage/turns/' + turnId);
        if (!response.ok) break;
        const receipt = normalize((await response.json()).turnUsage);
        if (!receipt || receipt.turnId !== turnId) break;
        latest = receipt; update(receipt);
        if (receipt.status === 'settled') return;
      } catch { break; }
    }
    update(latest);
  }
  return { normalize, unknown, label, cacheLabel, paint, settle, validId };
});
