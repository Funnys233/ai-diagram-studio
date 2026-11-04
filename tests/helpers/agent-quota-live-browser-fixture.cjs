'use strict';
// Real cloud membership, task manager, encrypted ledger and bridge protocol.
// Only the DSH model execution is deterministic; no external request is made.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), http = require('node:http');
const { createBridge } = require('../../services/dsh-bridge/bridge');
const { createDemoAdapter } = require('../../services/dsh-bridge/demo-adapter');
const { DshClient } = require('../../lib/dsh-client');
(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-agent-quota-live-'));
  const reserve = http.createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = 'http://127.0.0.1:' + port, token = crypto.randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'bridge.token'); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  Object.assign(process.env, { APP_MODE: 'cloud', PUBLIC_ORIGIN: origin, CLOUD_ALLOW_HTTP_LOOPBACK: 'true', CLOUD_DATA_DIR: path.join(directory, 'cloud'), CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin', CLOUD_ADMIN_PASSWORD: 'fixture-password-123', CLOUD_CHATGPT_OWNER: '', DSH_MODEL_SOURCE: 'site', DSH_BRIDGE_TOKEN_FILE: tokenFile, DEEPSEEK_API_KEY: '' });
  const stats = { submissions: [], executions: [], modelRequests: 0 };
  const demo = createDemoAdapter({ delayMs: 200 });
  const adapter = { ...demo, async run(job) { stats.executions.push({ taskId: job.taskId, sessionId: job.sessionId, modelSelection: job.modelSelection }); return demo.run(job); } };
  const bridge = createBridge({ stateDir: path.join(directory, 'bridge'), token, adapter }); const address = await bridge.listen();
  const client = new DshClient({ url: 'http://127.0.0.1:' + address.port, tokenFile }); client.simulation = true;
  const submit = client.submit.bind(client); client.submit = async (owner, body) => { stats.submissions.push(structuredClone(body)); return submit(owner, body); };
  const { createServer, cloudRuntime: cloud } = require('../../server');
  const actor = { identity: { user: cloud.data.users.find(user => user.role === 'admin') } };
  await cloud.createUser(actor, { username: 'quota-pro', password: 'fixture-password-123' });
  const member = cloud.data.users.find(user => user.username === 'quota-pro');
  cloud.setMembership(actor, member.id, { plan: 'pro', expiresAt: Date.now() + 30 * 86400000 });
  await cloud.platform.createProvider({ providerId: 'demo', name: '本机账单验证', protocol: 'openai-chat-completions', baseUrl: 'https://models.example/v1', apiKey: 'fixture-key-never-sent', models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map(modelId => ({ modelId, displayName: modelId })) });
  const app = createServer({ agentClient: client, agentEnabled: true, agentQueueEnabled: false, agentHistoryEnabled: false, agentModelCall: async () => { throw Error('Model gateway invocation forbidden in browser fixture'); } });
  const handler = app.listeners('request')[0]; app.removeAllListeners('request');
  app.on('request', (req, res) => {
    if (req.url === '/fixture-stats') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ ...stats, weekly: cloud.weeklySnapshot(member.id), agentCalls: cloud.data.weeklyQuota.calls.filter(call => call.kind === 'agent').map(call => ({ id: call.id, status: call.status, chargedCredits: call.chargedCredits, modelMultiplier: call.modelMultiplier })) })); return; }
    handler(req, res);
  });
  await new Promise(resolve => app.listen(port, '127.0.0.1', resolve));
  console.log('AGENT_QUOTA_LIVE_FIXTURE_READY ' + JSON.stringify({ origin, username: 'quota-pro' }));
  let stopping;
  const stop = () => stopping ||= (async () => { await Promise.all([app.agentTasks.close(), app.conversationTasks.close(), app.drawingTasks.close()]); await bridge.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); })();
  process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
})().catch(error => { console.error(error.message); process.exit(1); });
