'use strict';
// Isolated website + bridge + deterministic DSH stand-in. No provider requests.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const { createDemoAdapter } = require('../../services/dsh-bridge/demo-adapter');
const { DshClient } = require('../../lib/dsh-client');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-followup-browser-'));
  Object.assign(process.env, { APP_MODE: 'local', PROVIDERS_CONFIG_PATH: path.join(directory, 'providers.json'), DEEPSEEK_API_KEY: '', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: '', DSH_AGENT_ENABLED: 'true' });
  const token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'bridge.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const stats = { submissions: [], executions: [], releases: 0, modelRequests: 0 };
  const demo = createDemoAdapter({ delayMs: 180 });
  const adapter = { ...demo, async run(job) { stats.executions.push({ sessionId: job.sessionId, prompt: job.prompt, continuation: job.continuation === true }); return demo.run(job); }, async release(job) { stats.releases++; return demo.release(job); } };
  const bridge = createBridge({ stateDir: path.join(directory, 'bridge'), token, adapter });
  const address = await bridge.listen(), client = new DshClient({ url: 'http://127.0.0.1:' + address.port, tokenFile }); client.simulation = true;
  const submit = client.submit.bind(client); client.submit = async (owner, job) => { stats.submissions.push({ ...job }); return submit(owner, job); };
  const { createServer } = require('../../server');
  const app = createServer({ agentClient: client, agentEnabled: true, agentDirectory: path.join(directory, 'agent-tasks') });
  const handler = app.listeners('request')[0]; app.removeAllListeners('request');
  app.on('request', (req, res) => {
    if (req.method === 'GET' && req.url === '/fixture-stats') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(stats)); return; }
    handler(req, res);
  });
  app.listen(0, '127.0.0.1', () => console.log('AGENT_FOLLOWUP_FIXTURE_READY ' + JSON.stringify({ origin: 'http://127.0.0.1:' + app.address().port })));
  let stopping;
  const stop = () => stopping ||= (async () => {
    await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]); await bridge.close();
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); fs.rmSync(directory, { recursive: true, force: true });
  })();
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
})().catch(error => { console.error(error); process.exitCode = 1; });
