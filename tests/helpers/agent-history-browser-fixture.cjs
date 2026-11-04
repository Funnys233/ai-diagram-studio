'use strict';
// Real website and bridge persistence. The deterministic adapter makes no model calls.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const { createDemoAdapter } = require('../../services/dsh-bridge/demo-adapter');
const { DshClient } = require('../../lib/dsh-client');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-history-browser-'));
  Object.assign(process.env, { APP_MODE: 'local', PROVIDERS_CONFIG_PATH: path.join(directory, 'providers.json'), DEEPSEEK_API_KEY: '', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: '', DSH_AGENT_ENABLED: 'true' });
  const token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'bridge.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const stats = { submissions: [], executions: [], cancels: 0, downloads: 0, deletes: 0, patches: 0, browserSubmissions: 0, modelRequests: 0 }, blockers = new Map();
  const demo = createDemoAdapter({ delayMs: 3 });
  const adapter = { ...demo,
    async run(job) {
      stats.executions.push({ prompt: job.prompt, sessionId: job.sessionId });
      if (!job.prompt.startsWith('占用测试执行位')) return demo.run(job);
      return new Promise(resolve => blockers.set(job.sessionId, () => { blockers.delete(job.sessionId); resolve({ status: 'cancelled', output: '', usage: { calls: 0, complete: true, inputTokens: 0, outputTokens: 0 } }); }));
    },
    async cancel(job) { if (blockers.has(job.sessionId)) blockers.get(job.sessionId)(); else return demo.cancel(job); },
  };
  const bridge = createBridge({ stateDir: path.join(directory, 'bridge'), token, adapter, maxConcurrent: 2 });
  const address = await bridge.listen(), client = new DshClient({ url: 'http://127.0.0.1:' + address.port, tokenFile }); client.simulation = true;
  const submit = client.submit.bind(client);
  client.submit = async (owner, job) => { stats.submissions.push({ owner, id: job.id, conversationId: job.conversationId }); return submit(owner, job); };
  const { createServer } = require('../../server');
  const app = createServer({ agentClient: client, agentEnabled: true, agentDirectory: path.join(directory, 'agent-tasks'), agentQueueEnabled: true, agentHistoryEnabled: true, agentParallel: 2, agentRetentionMs: 30 * 86400000 });
  const manager = app.agentTasks;
  async function create(owner, prompt, attachmentIds) {
    const body = { id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt, ...(attachmentIds ? { attachmentIds } : {}) };
    await manager.create(owner, body); return body;
  }
  async function waitJob(body, terminal = true) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await manager.schedule(); const job = manager.jobs.get(body.id); await manager.reconcile(job);
      if (terminal ? ['completed', 'cancelled', 'failed', 'rejected'].includes(job.status) : job.status === 'running') return job;
      await delay(10);
    }
    throw Error('Local history seed did not reach expected state');
  }
  for (let index = 0; index < 22; index++) await waitJob(await create('local', '历史计划 ' + String(index + 1).padStart(2, '0')));
  const original = { id: crypto.randomUUID(), name: '预算项目资料.txt', type: 'text', text: '项目：松林\n预算：73021 元\n保留上传原件并生成 CSV 清单。' };
  manager.files.addUpload('local', original, Buffer.from(original.text));
  const budget = await create('local', '预算项目：整理资料并下载清单。', [original.id]); await waitJob(budget);
  for (let index = 0; index < 21; index++) {
    const document = { id: crypto.randomUUID(), name: index === 0 ? '未发送草稿.md' : '参考草稿-' + String(index).padStart(2, '0') + '.txt', type: 'text', text: '本地文件管理验收资料 ' + index };
    manager.files.addUpload('local', document, Buffer.from(document.text));
  }
  const hidden = { id: crypto.randomUUID(), name: '其他账号私有资料.txt', type: 'text', text: '不得出现在本账号文件列表' };
  manager.files.addUpload('another-user', hidden, Buffer.from(hidden.text));
  const slot1 = await create('slot-one', '占用测试执行位 1'), slot2 = await create('slot-two', '占用测试执行位 2');
  await waitJob(slot1, false); await waitJob(slot2, false);
  const queued = await create('local', '等待队列的任务，不调用模型。');
  const handler = app.listeners('request')[0]; app.removeAllListeners('request');
  app.on('request', (req, res) => {
    if (req.method === 'GET' && req.url === '/fixture-stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...stats, queuedStatus: manager.get('local', queued.id).status, localExecutions: stats.submissions.filter(row => row.owner === 'local').length, retainedFiles: manager.files.records.size, budget, originalId: original.id })); return;
    }
    if (req.method === 'POST' && req.url === '/fixture-release-slots') {
      for (const finish of blockers.values()) finish();
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
    }
    if (req.method === 'POST' && req.url === '/api/agent/tasks') stats.browserSubmissions++;
    if (req.method === 'POST' && /\/cancel$/.test(req.url)) stats.cancels++;
    if (req.method === 'GET' && /\/download$/.test(req.url)) stats.downloads++;
    if (req.method === 'DELETE' && req.url.startsWith('/api/agent/files/')) stats.deletes++;
    if (req.method === 'PATCH' && req.url.startsWith('/api/agent/conversations/')) stats.patches++;
    handler(req, res);
  });
  app.listen(0, '127.0.0.1', () => console.log('AGENT_HISTORY_FIXTURE_READY ' + JSON.stringify({ origin: 'http://127.0.0.1:' + app.address().port, budget, queued })));
  let stopping;
  const stop = () => stopping ||= (async () => {
    for (const finish of blockers.values()) finish();
    await Promise.all([manager.close(), app.conversationTasks.close(), app.drawingTasks.close()]); await bridge.close();
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  })();
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
})().catch(error => { console.error(error); process.exitCode = 1; });
