'use strict';
// Frontend contract fixture: only localhost HTTP and deterministic task records.
// Billing/model authority is covered separately by the backend integration tests.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-quota-browser-'));
Object.assign(process.env, { APP_MODE: 'local', PROVIDERS_CONFIG_PATH: path.join(directory, 'providers.json'), DEEPSEEK_API_KEY: '', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: '', DSH_AGENT_ENABLED: 'true' });
const { createServer } = require('../../server');
const models = [
  { providerId: 'platform:demo', modelId: 'gpt-6-luna', name: 'Luna', source: 'platform', multiplier: 0.5, quotaPool: 'weekly' },
  { providerId: 'platform:demo', modelId: 'gpt-6.1-sol', name: '6.1 Sol', source: 'platform', multiplier: 15, quotaPool: 'weekly' },
  { providerId: 'personal:mine', modelId: 'gpt-6-luna', name: '我的 Luna', source: 'personal', multiplier: null, quotaPool: 'personal' },
];
let authorized = [...models], failure = false;
const jobs = new Map(), timers = new Set(), stats = { submissions: [], modelRequests: 0, completionCount: 0 };
const client = { configured: true, simulation: true, async health() { return { status: 'ready', mode: 'adapter', version: 1, jobsAvailable: true }; } };
const app = createServer({ agentClient: client, agentEnabled: true, agentDirectory: path.join(directory, 'agent-tasks') });
const handler = app.listeners('request')[0]; app.removeAllListeners('request');
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const error = (res, status, code, message) => json(res, status, { error: { code, message } });
const read = async req => { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text || '{}'); };
app.on('request', (req, res) => void (async () => {
  if (req.url === '/fixture-stats') return json(res, 200, stats);
  if (req.url === '/fixture-control' && req.method === 'POST') {
    const body = await read(req); authorized = body.empty ? [] : [...models]; failure = body.failure === true; return json(res, 200, { ok: true });
  }
  if (req.url === '/api/auth/session') return json(res, 200, { mode: 'cloud', csrf: 'fixture-csrf', user: { id: 'quota-user', username: 'pro-user', role: 'user', membership: { plan: 'pro', name: 'Pro' } } });
  if (req.url === '/api/agent/status') return json(res, 200, { connected: true, available: true, filesAvailable: false, continuationAvailable: true, mode: 'adapter', simulation: true, billing: 'site-quota', access: 'member-preview', message: '执行服务就绪。' });
  if (req.url === '/api/agent/models') return json(res, 200, { models: authorized, defaultSelection: authorized[0] ? { providerId: authorized[0].providerId, modelId: authorized[0].modelId } : null });
  if (req.url === '/api/agent/tasks' && req.method === 'GET') return json(res, 200, { tasks: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(({ output, prompt, ...job }) => ({ ...job, prompt: prompt.slice(0, 120), summary: true })) });
  if (req.url === '/api/agent/tasks' && req.method === 'POST') {
    const body = await read(req), existing = jobs.get(body.id);
    if (existing) return json(res, 200, { created: false, task: existing });
    const selected = authorized.find(item => item.providerId === body.modelSelection?.providerId && item.modelId === body.modelSelection?.modelId);
    if (!selected) return error(res, 403, 'model-unavailable', '当前账号不能使用此模型。');
    if (jobs.size && [...jobs.values()].some(job => job.status === 'running')) return error(res, 429, 'agent-busy', '任务仍在处理中。');
    const turns = [...jobs.values()].filter(job => job.conversationId === body.conversationId);
    if (body.parentTaskId && (turns.at(-1)?.id !== body.parentTaskId || turns.at(-1)?.modelSelection.modelId !== selected.modelId)) return error(res, 409, 'model-changed', '请使用新任务更换模型。');
    stats.submissions.push(structuredClone(body));
    const now = Date.now(), job = { ...body, modelSelection: { ...selected }, status: 'running', output: '', message: '正在执行…', createdAt: now, updatedAt: now, turnIndex: turns.length + 1, continuationAvailable: true, usage: { inputTokens: 500, outputTokens: 0, cachedInputTokens: 0, calls: 1, complete: false }, quota: { pool: selected.quotaPool, points: null, status: 'pending', estimated: false } };
    jobs.set(job.id, job);
    const failThis = failure;
    const timer = setTimeout(() => {
      timers.delete(timer); job.status = failThis ? 'failed' : 'completed'; job.output = failThis ? '已保留本轮中断前的部分结果。' : '本轮任务已完成，支持接着这个结果继续修改。'; job.message = failThis ? '执行中断，已保留收到的内容。' : '任务已完成。'; job.updatedAt = Date.now(); job.expiresAt = Date.now() + 86400000;
      job.usage = { inputTokens: 1000, outputTokens: 200, ...(failThis ? {} : { cachedInputTokens: 400 }), calls: 3, complete: !failThis };
      job.quota = { pool: selected.quotaPool, points: selected.quotaPool === 'personal' ? 0 : selected.multiplier * 2, status: 'settled', estimated: failThis };
      stats.completionCount++;
    }, 1500); timers.add(timer);
    return json(res, 202, { created: true, task: job });
  }
  const conversation = /^\/api\/agent\/conversations\/([a-f0-9-]{36})$/.exec(req.url);
  if (conversation && req.method === 'GET') {
    const turns = [...jobs.values()].filter(job => job.conversationId === conversation[1]);
    return turns.length ? json(res, 200, { conversationId: conversation[1], tasks: turns, canContinue: turns.at(-1).status !== 'running', continuationBlockedReason: turns.at(-1).status === 'running' ? '请等待任务结束。' : '' }) : error(res, 404, 'not-found', '会话不存在。');
  }
  const task = /^\/api\/agent\/tasks\/([a-f0-9-]{36})$/.exec(req.url);
  if (task && req.method === 'GET') return jobs.has(task[1]) ? json(res, 200, { task: jobs.get(task[1]) }) : error(res, 404, 'not-found', '任务不存在。');
  return handler(req, res);
})().catch(() => { if (!res.headersSent) error(res, 500, 'fixture-error', '本地验证未完成。'); else res.end(); }));
app.listen(0, '127.0.0.1', () => console.log('AGENT_QUOTA_FIXTURE_READY ' + JSON.stringify({ origin: 'http://127.0.0.1:' + app.address().port })));
let stopping;
const stop = () => stopping ||= (async () => { for (const timer of timers) clearTimeout(timer); await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); })();
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
