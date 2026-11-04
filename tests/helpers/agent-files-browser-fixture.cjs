'use strict';
// Real local website/bridge storage, with a deterministic adapter and no model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const { createDemoAdapter } = require('../../services/dsh-bridge/demo-adapter');
const { DshClient } = require('../../lib/dsh-client');
const { pdfFile, docxFile } = require('./document-fixtures.cjs');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-files-browser-'));
  Object.assign(process.env, { APP_MODE: 'local', PROVIDERS_CONFIG_PATH: path.join(directory, 'providers.json'), DEEPSEEK_API_KEY: '', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: '', DSH_AGENT_ENABLED: 'true' });
  const token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'bridge.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const stats = { submissions: [], executions: [], releases: 0, uploads: 0, modelRequests: 0 };
  const demo = createDemoAdapter({ delayMs: 100 });
  const adapter = { ...demo,
    async run(job) { stats.executions.push({ sessionId: job.sessionId, continuation: job.continuation === true, documents: job.documents?.map(doc => ({ id: doc.id, name: doc.name, text: doc.text })) || [] }); return demo.run(job); },
    async release(job) { stats.releases++; return demo.release(job); },
  };
  const bridge = createBridge({ stateDir: path.join(directory, 'bridge'), token, adapter });
  const address = await bridge.listen(), client = new DshClient({ url: 'http://127.0.0.1:' + address.port, tokenFile }); client.simulation = true;
  const submit = client.submit.bind(client);
  client.submit = async (owner, job) => { stats.submissions.push({ id: job.id, conversationId: job.conversationId, parentTaskId: job.parentTaskId, prompt: job.prompt, documents: job.documents?.map(doc => ({ id: doc.id, name: doc.name })) || [] }); return submit(owner, job); };
  const sampleFiles = [
    { name: '项目资料.txt', data: Buffer.from('项目：松林\n预算：73021 元\n需要整理一份简明的实施计划。').toString('base64') },
    { name: '参考说明.pdf', data: pdfFile('Reference budget 73021', { pages: 2 }).toString('base64') },
    { name: '实施要求.docx', data: (await docxFile('要求：黑白简约，输出资料清单 CSV。')).toString('base64') },
  ];
  const { createServer } = require('../../server');
  const app = createServer({ agentClient: client, agentEnabled: true, agentDirectory: path.join(directory, 'agent-tasks') });
  const handler = app.listeners('request')[0]; app.removeAllListeners('request');
  app.on('request', (req, res) => {
    if (req.method === 'GET' && req.url === '/fixture-stats') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...stats, retainedFiles: app.agentTasks.files.records.size })); return;
    }
    if (req.method === 'GET' && req.url === '/fixture-files') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(sampleFiles)); return; }
    if (req.method === 'POST' && req.url === '/fixture-expire-drafts') {
      for (const file of app.agentTasks.files.records.values()) if (!file.taskIds.length) file.expiresAt = 0;
      app.agentTasks.sweep(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return;
    }
    if (req.method === 'POST' && req.url === '/api/agent/files') stats.uploads++;
    handler(req, res);
  });
  app.listen(0, '127.0.0.1', () => console.log('AGENT_FILES_FIXTURE_READY ' + JSON.stringify({ origin: 'http://127.0.0.1:' + app.address().port })));
  let stopping;
  const stop = () => stopping ||= (async () => {
    await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]); await bridge.close();
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  })();
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
})().catch(error => { console.error(error); process.exitCode = 1; });
