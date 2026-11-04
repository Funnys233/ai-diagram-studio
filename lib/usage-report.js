'use strict';

const DAY = 86400000;
const SOURCES = ['platform', 'personal', 'chatgpt'];
const dateOf = time => new Date(time).toISOString().slice(0, 10);
const midnight = time => Date.parse(dateOf(time) + 'T00:00:00Z');
const number = value => Number.isSafeInteger(value) && value >= 0;
class QueryError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    if (number(value[key])) usage[key] = value[key];
  }
  for (const key of ['input_tokens_details', 'prompt_tokens_details']) {
    if (number(value[key]?.cached_tokens)) usage[key] = { cached_tokens: value[key].cached_tokens };
  }
  for (const key of ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    if (number(value[key])) usage[key] = value[key];
  }
  return Object.keys(usage).length ? usage : null;
}
function cacheUsage(usage) {
  const valid = value => number(value) ? value : null;
  let inputTokens = valid(usage?.input_tokens) ?? valid(usage?.prompt_tokens);
  let cachedTokens = valid(usage?.input_tokens_details?.cached_tokens) ?? valid(usage?.prompt_tokens_details?.cached_tokens)
    ?? valid(usage?.prompt_cache_hit_tokens);
  if (cachedTokens === null && number(usage?.cache_read_input_tokens)) {
    cachedTokens = usage.cache_read_input_tokens;
    // Anthropic input_tokens excludes cache reads and writes; don't reuse it as
    // the denominator unless all three input categories were returned.
    inputTokens = number(usage.input_tokens) && number(usage.cache_creation_input_tokens)
      ? usage.input_tokens + cachedTokens + usage.cache_creation_input_tokens : null;
  }
  if (inputTokens === null && number(usage?.prompt_cache_hit_tokens) && number(usage?.prompt_cache_miss_tokens)) inputTokens = usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens;
  if (!number(inputTokens)) inputTokens = null;
  if (inputTokens !== null && cachedTokens > inputTokens) cachedTokens = null;
  return { cachedTokens, inputTokens };
}
function cacheSummary(value) {
  const knownCalls = value.cacheKnownCalls || 0, paired = value.cacheInputKnownCalls || 0;
  return { cachedTokens: knownCalls ? value.cachedTokens || 0 : null, inputTokens: knownCalls && paired === knownCalls ? value.cacheInputTokens || 0 : null,
    hitRate: knownCalls && paired === knownCalls && value.cacheInputTokens > 0 ? value.cachedTokens / value.cacheInputTokens * 100 : null,
    knownCalls, unknownCalls: value.calls - knownCalls };
}
function cacheForEvents(events) {
  const total = empty();
  for (const event of events) add(total, measured(event));
  return cacheSummary(total);
}
function safeQuota(value) {
  if(!value||!['free','weekly','personal','catalog'].includes(value.pool))return null;
  return {pool:value.pool,points:typeof value.points==='number'&&Number.isFinite(value.points)&&value.points>=0?value.points:null,estimated:value.estimated===true,
    reservedPoints:typeof value.reservedPoints==='number'&&Number.isFinite(value.reservedPoints)&&value.reservedPoints>=0?value.reservedPoints:0,
    ...([0.5,1,5,10,15,20,25,30,80,100,150,300].includes(value.modelMultiplier)?{modelMultiplier:value.modelMultiplier}:{}),
    ...([1,2,3,4,5,6].includes(value.policyVersion)?{policyVersion:value.policyVersion}:{})};
}
function empty() {
  return { calls: 0, success: 0, failed: 0, cancelled: 0, pending: 0, inputTokens: 0, outputTokens: 0,
    inputKnownCalls: 0, outputKnownCalls: 0, elapsedMs: 0, timedCalls: 0,
    cachedTokens: 0, cacheKnownCalls: 0, cacheInputTokens: 0, cacheInputKnownCalls: 0 };
}
function add(target, value, sign = 1) {
  for (const key of Object.keys(empty())) target[key] = (target[key] || 0) + sign * (value[key] || 0);
}
function measured(event) {
  const value = empty(); value.calls = 1;
  value[event.status === 'started' ? 'pending' : event.status] = 1;
  const input = event.usage?.input_tokens ?? event.usage?.prompt_tokens;
  const output = event.usage?.output_tokens ?? event.usage?.completion_tokens;
  if (number(input)) { value.inputTokens = input; value.inputKnownCalls = 1; }
  if (number(output)) { value.outputTokens = output; value.outputKnownCalls = 1; }
  const cache = cacheUsage(event.usage);
  if (cache.cachedTokens !== null) {
    value.cachedTokens = cache.cachedTokens; value.cacheKnownCalls = 1;
    if (cache.inputTokens !== null) { value.cacheInputTokens = cache.inputTokens; value.cacheInputKnownCalls = 1; }
  }
  if (number(event.elapsedMs)) { value.elapsedMs = event.elapsedMs; value.timedCalls = 1; }
  return value;
}
function rowFor(data, event) {
  const dimensions = { date: dateOf(event.time), userId: event.userId, source: event.source,
    providerId: event.providerId || '', modelId: event.modelId || '', subscriptionOwnerId: event.subscriptionOwnerId || null };
  let row = data.usageStats.rows.find(row => Object.keys(dimensions).every(key => row[key] === dimensions[key]));
  if (!row) { row = { ...dimensions, ...empty() }; data.usageStats.rows.push(row); }
  return row;
}
function prune(data, now) {
  const today = midnight(now);
  data.events = data.events.filter(event => event.time >= today - 29 * DAY);
  data.usageStats.rows = data.usageStats.rows.filter(row => row.date >= dateOf(today - 89 * DAY));
}
function initialize(data, ownerId, now = Date.now()) {
  const fresh = !data.usageStats;
  if (fresh) {
    data.usageStats = { version: 1, trackingSince: now, rows: [] };
    // Migrate only the existing allowlisted metadata, never model content.
    data.events = (data.events || []).filter(event => SOURCES.includes(event.source) && Number.isFinite(event.time)).map(event => ({
      id: event.id, userId: event.userId, source: event.source, providerId: event.providerId || '', modelId: event.modelId || '',
      subscriptionOwnerId: event.source === 'chatgpt' ? ownerId || null : null, time: event.time,
      status: ['success', 'failed', 'cancelled'].includes(event.status) ? event.status : 'started',
      errorCode: event.errorCode || null, usage: safeUsage(event.usage), ...(number(event.elapsedMs) ? { elapsedMs: event.elapsedMs } : {}),
    }));
    for (const event of data.events) add(rowFor(data, event), measured(event));
  }
  if (data.usageStats.version !== 1 || !Array.isArray(data.usageStats.rows)) throw Error('用量统计数据版本不支持');
  for (const event of data.events) {
    if (event.status !== 'started' || event.kind === 'agent') continue;
    add(rowFor(data, event), measured(event), -1);
    event.status = 'failed'; event.errorCode = 'process-restarted';
    add(rowFor(data, event), measured(event));
  }
  prune(data, now);
}
function start(data, event, now = Date.now()) {
  prune(data, now);
  data.events.push(event);
  add(rowFor(data, event), measured(event));
}
function finish(data, id, result, error, cancelled, now = Date.now()) {
  const event = data.events.find(event => event.id === id);
  if (!event || event.status !== 'started') return;
  const row = rowFor(data, event); add(row, measured(event), -1);
  event.status = error ? (cancelled ? 'cancelled' : 'failed') : 'success';
  event.elapsedMs = Math.max(0, now - event.time);
  event.errorCode = error ? (cancelled ? 'cancelled' : /^[a-zA-Z0-9_-]{1,80}$/.test(error.code || '') ? error.code : 'request-failed') : null;
  event.usage = safeUsage(result?.usage || error?.extra?.usage);
  add(row, measured(event));
  prune(data, now);
}
function present(value) {
  return { calls: value.calls, success: value.success, failed: value.failed, cancelled: value.cancelled, pending: value.pending,
    inputTokens: value.inputKnownCalls ? value.inputTokens : null, outputTokens: value.outputKnownCalls ? value.outputTokens : null,
    inputKnownCalls: value.inputKnownCalls, outputKnownCalls: value.outputKnownCalls,
    inputUnknownCalls: value.calls - value.inputKnownCalls, outputUnknownCalls: value.calls - value.outputKnownCalls,
    averageElapsedMs: value.timedCalls ? Math.round(value.elapsedMs / value.timedCalls) : null, cache: cacheSummary(value) };
}
function report(data, identity, params, now = Date.now()) {
  const allowed = ['range', 'scope', 'userId', 'source', 'modelId', 'page'];
  if ([...params.keys()].some(key => !allowed.includes(key))) throw new QueryError('用量筛选参数不支持');
  const admin = identity.user.role === 'admin';
  const scope = params.get('scope') || (admin ? 'all' : 'mine');
  if (!['all', 'mine', 'subscription'].includes(scope)) throw new QueryError('用量范围不合法');
  if (!admin && scope !== 'mine') throw new QueryError('只能查看本人的用量', 403);
  const range = params.get('range') || 'today';
  if (!['today', '7d', '30d'].includes(range)) throw new QueryError('请选择今日、近 7 天或近 30 天');
  const userId = params.get('userId') || '';
  if (userId && !data.users.some(user => user.id === userId) && !(admin && data.deletedUsers?.some(user => user.id === userId))) throw new QueryError('所选用户不存在');
  if (!admin && userId && userId !== identity.user.id) throw new QueryError('不能查看其他用户的用量', 403);
  const source = params.get('source') || '';
  if (source && !SOURCES.includes(source)) throw new QueryError('用量来源不合法');
  const modelFilter = params.get('modelId') || '';
  if (modelFilter.length > 300) throw new QueryError('模型筛选过长');
  const modelId = modelFilter === '__catalog__' ? '' : modelFilter;
  const rawPage = params.get('page') || '1';
  if (!/^[1-9]\d{0,5}$/.test(rawPage)) throw new QueryError('明细页码不合法');
  const page = Number(rawPage), pageSize = 50;
  const from = dateOf(midnight(now) - ((range === 'today' ? 1 : range === '7d' ? 7 : 30) - 1) * DAY), to = dateOf(now);
  const scopeMatch = row => (scope !== 'mine' || row.userId === identity.user.id)
    && (scope !== 'subscription' || row.source === 'chatgpt' && row.subscriptionOwnerId === identity.user.id);
  const rows = (data.usageStats?.rows || []).filter(row => row.date >= from && row.date <= to && scopeMatch(row));
  const selected = row => (!userId || row.userId === userId) && (!source || row.source === source) && (!modelFilter || row.modelId === modelId);
  const filtered = rows.filter(selected), summary = empty();
  for (const row of filtered) add(summary, row);
  const userName = id => { const current=data.users.find(user=>user.id===id);if(current)return current.username;const deleted=data.deletedUsers?.find(user=>user.id===id);return deleted?deleted.username+'（已删除）':'已删除用户'; };
  function group(key) {
    const groups = new Map();
    for (const row of filtered) { if (!groups.has(row[key])) groups.set(row[key], empty()); add(groups.get(row[key]), row); }
    return [...groups].map(([id, value]) => ({ id, label: key === 'userId' ? userName(id) : id, ...present(value) })).sort((a, b) => b.calls - a.calls);
  }
  const daily = [];
  for (let time = Date.parse(from + 'T00:00:00Z'); dateOf(time) <= to; time += DAY) {
    const date = dateOf(time), value = empty();
    for (const row of filtered) if (row.date === date) add(value, row);
    daily.push({ date, ...present(value) });
  }
  const events = data.events.filter(event => dateOf(event.time) >= from && dateOf(event.time) <= to && scopeMatch(event) && selected(event))
    .slice().sort((a, b) => b.time - a.time || b.id.localeCompare(a.id));
  return { role: admin ? 'admin' : 'user', scope, range, from, to, timezone: 'UTC', resetLabel: '北京时间每天 08:00 重置',
    trackingSince: data.usageStats?.trackingSince || now, retention: { detailsDays: 30, summaryDays: 90 }, summary: present(summary),
    sources: group('source'), users: group('userId'), models: group('modelId'), daily,
    filters: { users: (admin ? [...data.users,...(data.deletedUsers || []).filter(user => rows.some(row => row.userId === user.id)).map(user => ({id:user.id,username:user.username+'（已删除）'}))] : [identity.user]).map(user => ({ id: user.id, username: user.username })),
      models: [...new Set(rows.map(row => row.modelId))].sort() },
    events: events.slice((page - 1) * pageSize, page * pageSize).map(event => ({ id: event.id, time: event.time,
      username: userName(event.userId), source: event.source, modelId: event.modelId, status: event.status, elapsedMs: event.elapsedMs ?? null,
      inputTokens: event.usage?.input_tokens ?? event.usage?.prompt_tokens ?? null,
      outputTokens: event.usage?.output_tokens ?? event.usage?.completion_tokens ?? null, cache:cacheForEvents([event]), quota:safeQuota(event.quota), errorCode: event.errorCode })),
    pagination: { page, pageSize, total: events.length, pages: Math.max(1, Math.ceil(events.length / pageSize)) } };
}
module.exports = { initialize, start, finish, report, safeUsage, cacheUsage, cacheForEvents, QueryError };
