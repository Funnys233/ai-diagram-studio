'use strict';
// Isolated end-to-end fixture. The real service runs against a controllable
// loopback model, so refresh/concurrency assertions never spend real quota.
const http = require('node:http');
const path = require('node:path');
const root = path.resolve(process.env.DRAWING_APP_ROOT || path.join(__dirname, '../..'));
const fixtures = require('./fixtures');
const service = require(path.join(root, 'lib/model-service'));
const original = service.callWithLock;
let gatewayBase, calls = 0, closed = 0, failModels = false;
const streams = new Map(), creations = [];
service.callWithLock = (lock, messages, timeout, options) => original({ ...lock, baseUrl: gatewayBase }, messages, timeout, { ...options, networkPolicy: false });
const { createServer, cloudRuntime: cloud } = require(path.join(root, 'server'));
const frame = data => 'data: ' + JSON.stringify(data) + '\n\n';
const piece = content => frame({ choices: [{ delta: { content } }] });
function publish(entry, action) {
  if (action === 'chunk') {
    const end = Math.min(entry.content.length - 20, entry.offset + 220);
    entry.res.write(piece(entry.content.slice(entry.offset, end)));
    entry.offset = end;
  }
  if (action === 'finish') {
    entry.res.end(frame({ choices: [{ delta: { content: entry.content.slice(entry.offset) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) + 'data: [DONE]\n\n');
  }
}
(async () => {
  const gateway = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const messages = body.messages || [];
      const text = JSON.stringify(messages.at(-1)?.content || '');
      const marker = text.match(/DR-[A-Za-z0-9-]+/)?.[0] || 'DR-unmarked';
      const content = fixtures.sampleModel().replace('value="处理"', 'value="' + marker + '"');
      const entry = { id: ++calls, marker, res, content, offset: marker.includes('first') || marker.includes('offline') ? 0 : 120 };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
      if (entry.offset) res.write(piece(content.slice(0, entry.offset)));
      streams.set(entry.id, entry);
      res.once('close', () => { streams.delete(entry.id); closed++; });
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  gatewayBase = 'http://127.0.0.1:' + gateway.address().port;
  for (const username of ['alice', 'bob', 'carol', 'david', 'erica', 'frank', 'grace']) {
    await cloud.createUser({ identity: { user: cloud.data.users[0] } }, { username, password: 'fixture-password-123' });
  }
  await cloud.platform.createProvider({ providerId: 'drawing', name: '绘图恢复测试', baseUrl: 'https://api.fixture.example', protocol: 'openai-chat-completions', apiKey: 'fixture-only', models: [{ modelId: 'drawing-open-model', visionInput: true }] });
  await cloud.platform.setDefaultModel('drawing', 'drawing-open-model');
  const app = createServer();
  const server = http.createServer((req, res) => {
    if (req.url === '/fixture-drawing/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ calls, closed, streams: [...streams.values()].map(({ id, marker, offset }) => ({ id, marker, offset })), creations, globalActive: cloud.globalActive, events: cloud.data.events.map(({ userId, status, modelId }) => ({ userId, status, modelId })), limits: cloud.limits })); return;
    }
    if (req.url.startsWith('/fixture-drawing/control/')) {
      const url = new URL(req.url, 'http://fixture');
      const action = url.pathname.split('/').pop(), marker = url.searchParams.get('marker');
      if (action === 'fail-models') failModels = true;
      if (action === 'restore-models') failModels = false;
      for (const entry of streams.values()) if (!marker || entry.marker === marker) publish(entry, action);
      res.end('ok'); return;
    }
    if (failModels && ['/api/models/catalog','/api/providers'].includes(req.url)) {
      res.writeHead(503,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:{message:'fixture model directory unavailable'}})); return;
    }
    if (req.url.startsWith('/fixture-editor')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!doctype html><html><body style="background:#fafbf8;font:14px system-ui;color:#7c897c"><p>本地绘图编辑器测试</p><script>let xml='';const send=data=>parent.postMessage(JSON.stringify(data),'*');window.fixtureSetXml=value=>{xml=value;send({event:'autosave',xml,currentPage:0});};addEventListener('message',event=>{let m;try{m=JSON.parse(event.data);}catch{return;}if(m.action==='load'){xml=m.xml;send({event:'load',xml,currentPage:0});}if(m.action==='viewbox')send({event:'viewbox',currentPage:0,message:m});if(m.action==='getDiff')send({event:'getDiff',xml,message:m});});send({event:'init'});</script></body></html>`); return;
    }
    if (req.url === '/api/drawing/tasks' && req.method === 'POST') {
      const end = res.end.bind(res);
      res.end = (body, ...rest) => {
        try { const data = JSON.parse(body); if (data.task?.taskId) creations.push({ taskId: data.task.taskId, status: res.statusCode }); } catch {}
        return end(body, ...rest);
      };
    }
    app.emit('request', req, res);
  });
  server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('DRAWING_RECOVERY_FIXTURE_READY'));
})().catch(error => { console.error(error.stack); process.exit(1); });
