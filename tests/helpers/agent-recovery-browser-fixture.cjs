'use strict';
// Standalone local browser fixture. It never starts DSH or calls a model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-recovery-browser-'));
Object.assign(process.env, { APP_MODE: 'local', PROVIDERS_CONFIG_PATH: path.join(directory, 'providers.json'), DEEPSEEK_API_KEY: '', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: '', DSH_AGENT_ENABLED: 'true' });
const { createServer } = require('../../server');
const id = crypto.randomUUID(), conversationId = crypto.randomUUID(), prompt = '异常重启后保留的任务';
const partial = '已经收到的部分正文会保留，恢复状态不会重新调用模型。';
const records = new Map([[id, { id, conversationId, status: 'unknown', output: partial }]]);
const stats = { recoveries: 0, submissions: 0, releasedLeases: 0, modelRequests: 0 };
const client = {
  configured: true, simulation: true,
  async health() { return { status: 'ready', mode: 'adapter', version: 1, jobsAvailable: true }; },
  async get(owner, jobId) { return records.get(jobId); },
  async recover(owner, job) {
    stats.recoveries++;
    const task = { id: job.id, conversationId: job.conversationId, status: 'failed', output: partial, recoveryReason: 'execution-recovered' };
    records.set(job.id, task); return task;
  },
  async submit(owner, job) {
    stats.submissions++;
    const task = { id: job.id, conversationId: job.conversationId, status: 'completed', output: '本地演示：新任务可以正常提交。' };
    records.set(job.id, task); return task;
  },
  async cancel(owner, jobId) { return records.get(jobId); },
  async release(owner, jobId) { records.delete(jobId); return { released: true }; },
};
const app = createServer({ agentClient: client, agentEnabled: true, agentDirectory: path.join(directory, 'agent-tasks') });
const now = Date.now();
const seeded = { version: 1, id, conversationId, ownerId: 'local', prompt, output: partial, status: 'unknown', message: '连接暂时中断，服务器正在核对任务；请勿重复提交。', createdAt: now, updatedAt: now, fingerprint: crypto.createHash('sha256').update(JSON.stringify([conversationId, prompt])).digest('hex') };
app.agentTasks.write(seeded); app.agentTasks.jobs.set(id, seeded);
app.agentTasks.leases.set(id, { release() { stats.releasedLeases++; } });
const handler = app.listeners('request')[0]; app.removeAllListeners('request');
app.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/fixture-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(stats)); return;
  }
  handler(req, res);
});
app.listen(0, '127.0.0.1', () => console.log('AGENT_RECOVERY_FIXTURE_READY ' + JSON.stringify({ origin: 'http://127.0.0.1:' + app.address().port, id, partial })));
let stopping;
const stop = () => stopping ||= (async () => {
  await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]);
  app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
})();
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
