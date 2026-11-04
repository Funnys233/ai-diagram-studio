const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-drawing-tasks-'));
Object.assign(process.env, { APP_MODE: 'cloud', PUBLIC_ORIGIN: 'https://diagram.example', CLOUD_DATA_DIR: directory,
  CLOUD_MASTER_KEY: crypto.randomBytes(32).toString('base64'), CLOUD_ADMIN_USERNAME: 'admin',
  CLOUD_ADMIN_PASSWORD: 'fixture-password-123', DEEPSEEK_API_KEY: '' });
const service = require('../../lib/model-service'), original = service.callWithLock;
let gatewayBase;
service.callWithLock = (lock, messages, timeout, options) => original({ ...lock, baseUrl: gatewayBase }, messages, timeout, { ...options, networkPolicy: false });
const { createServer, cloudRuntime: cloud } = require('../../server');
const { sampleModel, bigModel, buildMxfile } = require('../helpers/fixtures');
const { createParser } = require('../../lib/sse');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
let app, gateway, base, alice, bob, output = sampleModel(), held = false, calls = [], streams = new Set();
const frame = data => 'data: ' + JSON.stringify(data) + '\n\n';
const endStream = (res, text) => res.end(frame({ choices: [{ delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 100 } }) + 'data: [DONE]\n\n');
const wait = async predicate => { for (let i = 0; i < 400; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw Error('fixture wait timeout'); };
function api(client, route, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers: { Host: 'diagram.example', Origin: 'https://diagram.example',
      'Content-Type': 'application/json', ...(client ? { Cookie: client.cookie, 'X-CSRF-Token': client.csrf } : {}), ...extra } },
    res => resolve(new Response(require('node:stream').Readable.toWeb(res), { status: res.statusCode, headers: res.headers })));
    req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}
const request = patch => ({ taskId: crypto.randomUUID(), threadId: crypto.randomUUID(), assistantId: crypto.randomUUID(), mode: 'chat',
  message: 'private-original-never-on-disk', providerId: 'platform:drawing', modelId: 'm', stream: true, clientRevision: 7, ...patch });
const status = async id => (await (await api(alice, '/api/drawing/tasks/' + id)).json()).task;
const finished = async body => { assert.equal((await api(alice, '/api/drawing/tasks', body)).status, 202); await wait(async () => (await status(body.taskId)).status !== 'running'); return status(body.taskId); };
async function login(name) {
  const response = await api(null, '/api/auth/login', { username: name, password: 'fixture-password-123' });
  assert.equal(response.status, 200); return { cookie: response.headers.get('set-cookie').split(';')[0], ...await response.json() };
}
test.before(async () => {
  gateway = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      calls.push(JSON.parse(raw)); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const text = output; res.write(frame({ choices: [{ delta: { content: text.slice(0, 12) } }] }));
      if (held) { streams.add(res); res.once('close', () => streams.delete(res)); }
      else endStream(res, text.slice(12));
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve)); gatewayBase = 'http://127.0.0.1:' + gateway.address().port;
  app = createServer(); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + app.address().port;
  for (const username of ['alice', 'bob']) await cloud.createUser({ identity: { user: cloud.data.users[0] } }, { username, password: 'fixture-password-123' });
  alice = await login('alice'); bob = await login('bob');
  await cloud.platform.createProvider({ providerId: 'drawing', name: '绘图任务测试', protocol: 'openai-chat-completions', baseUrl: 'https://api.fixture.example',
    apiKey: 'secret-drawing-provider', models: [{ modelId: 'm', visionInput: true }] });
});
test.after(async () => {
  await Promise.all([app.conversationTasks.close(), app.drawingTasks.close()]); app.closeAllConnections(); gateway.closeAllConnections();
  await Promise.all([new Promise(resolve => app.close(resolve)), new Promise(resolve => gateway.close(resolve))]); fs.rmSync(directory, { recursive: true, force: true });
});
test.beforeEach(() => { output = sampleModel(); held = false; });

test('绘图网页刷新只重新订阅；验证后完整XML和页面元数据加密保存，输入和密钥不落盘', async () => {
  held = true;
  const file = buildMxfile([{ id: 'a', name: '首页', content: sampleModel() }, { id: 'b', name: '第二页', content: sampleModel(), compressed: true }]);
  const body = request({ currentFile: file, currentPage: 1, currentPageId: 'b' }), route = '/api/drawing/tasks/' + body.taskId, before = calls.length;
  assert.equal((await api(alice, '/api/drawing/tasks', body)).status, 202); await wait(() => calls.length === before + 1);
  const initial = await status(body.taskId); assert.equal(initial.status, 'running'); assert.equal(initial.reply, ''); assert.equal(initial.xml, undefined);
  const events = await api(alice, route + '/events'), reader = events.body.getReader(); await reader.read(); await reader.cancel();
  assert.equal(cloud.active.get(alice.user.id), 1); assert.equal(streams.size, 1);
  assert.equal((await api(alice, '/api/drawing/tasks', body)).status, 200); assert.equal(calls.length, before + 1);
  assert.equal((await api(alice, '/api/drawing/tasks', { ...body, message: 'different' })).status, 409);
  for (const action of ['', '/events', '/cancel', '/ack']) assert.equal((await api(bob, route + action, ['/cancel', '/ack'].includes(action) ? {} : undefined)).status, 404);
  let disk = fs.readFileSync(path.join(directory, 'drawing-tasks', body.taskId + '.enc'), 'utf8');
  let stored = cloud.codec.decode(disk); assert.ok(!JSON.stringify(stored).includes(body.message)); assert.ok(!JSON.stringify(stored).includes(file)); assert.ok(!JSON.stringify(stored).includes('secret-drawing-provider'));
  for (const res of streams) endStream(res, output.slice(12));
  await wait(async () => (await status(body.taskId)).status === 'succeeded'); const result = await status(body.taskId);
  assert.match(result.xml, /mxGraphModel/); assert.equal(result.clientRevision, 7); assert.equal(result.pageId, 'b'); assert.equal(result.pageIndex, 1); assert.equal(result.pageCount, 2);
  assert.equal(result.kind, 'generated'); assert.equal(result.attempts, 1); assert.equal(result.applied, true); assert.equal(result.provider.providerId, 'platform:drawing'); assert.equal(result.model.modelId, 'm');
  assert.ok(result.stats.vertices > 0); assert.equal(result.turnUsage.calls, 1); assert.equal(result.turnUsage.weeklyPoints, .3); assert.equal(result.callInfo.usage.prompt_tokens, 100);
  disk = fs.readFileSync(path.join(directory, 'drawing-tasks', body.taskId + '.enc'), 'utf8'); assert.ok(!disk.includes('mxGraphModel')); stored = cloud.codec.decode(disk); assert.equal(stored.result.xml, result.xml);
  const received = []; createParser(e => received.push({ event: e.event, data: JSON.parse(e.data) })).push(await (await api(alice, route + '/events')).text());
  assert.equal(received.at(-1).event, 'result'); assert.equal(received.at(-1).data.xml, result.xml); assert.equal(received.at(-1).data.taskTerminal, true);
  assert.equal(cloud.active.get(alice.user.id), 0); assert.equal(app.drawingTasks.running.size, 0); assert.equal(calls.length, before + 1);
  assert.equal((await api(alice, route + '/ack', {})).status, 200); assert.equal((await api(alice, route + '/ack', {})).status, 200); assert.equal((await api(alice, route)).status, 410);
  assert.equal((await api(alice, '/api/drawing/tasks', body)).status, 410); stored = cloud.codec.decode(fs.readFileSync(path.join(directory, 'drawing-tasks', body.taskId + '.enc'), 'utf8')); assert.equal(stored.result, undefined); assert.equal(stored.reply, '');
});

test('显式停止取消上游并释放并发，原始XML片段不暴露为可应用结果', async () => {
  held = true; const body = request(), route = '/api/drawing/tasks/' + body.taskId, before = calls.length;
  assert.equal((await api(alice, '/api/drawing/tasks', body)).status, 202); await wait(() => calls.length === before + 1);
  assert.equal((await api(alice, route + '/ack', {})).status, 409); assert.equal((await api(alice, route + '/cancel', {})).status, 200);
  await wait(async () => (await status(body.taskId)).status === 'cancelled'); const result = await status(body.taskId);
  assert.equal(result.xml, undefined); assert.equal(result.reply, ''); assert.equal(result.error.code, 'task-cancelled'); assert.equal(result.turnUsage.calls, 1);
  assert.equal(cloud.active.get(alice.user.id), 0); assert.equal(calls.length, before + 1); await wait(() => streams.size === 0);
  await api(alice, route + '/ack', {});
});

test('局部修改与多模态候选保留复核字段，文字回答和大于100k的合法图均可恢复', async () => {
  output = JSON.stringify({ version: 1, operations: [{ op: 'remove', id: '3' }] });
  let result = await finished(request({ editMode: 'selection', targetIds: ['3'], currentFile: sampleModel() }));
  assert.equal(result.status, 'succeeded'); assert.equal(result.kind, 'local-edit'); assert.equal(result.requiresReview, true); assert.equal(result.changes.removed.length, 3); assert.ok(result.patch); assert.ok(result.xml);
  output = sampleModel().replace('处理', '视觉调整');
  result = await finished(request({ mode: 'vision', editMode: 'multimodal', currentFile: sampleModel(), vision: { image: PNG, baseXml: sampleModel() } }));
  assert.equal(result.status, 'succeeded'); assert.equal(result.kind, 'multimodal-edit'); assert.equal(result.requiresReview, true); assert.ok(result.changes.total > 0); assert.ok(result.xml.includes('视觉调整'));
  output = '先讨论方案，暂不修改图表。';
  result = await finished(request({ mode: 'vision', editMode: 'multimodal', currentFile: sampleModel(), vision: { image: PNG, baseXml: sampleModel() } }));
  assert.equal(result.kind, 'multimodal-chat'); assert.equal(result.xml, null); assert.equal(result.reply, output); assert.equal(result.requiresReview, false);
  output = bigModel(400);
  result = await finished(request()); assert.equal(result.status, 'succeeded'); assert.ok(result.xml.length > 100000); assert.ok(result.xml.length < 200000); assert.ok(result.xml.endsWith('</mxGraphModel>'));
});

test('结构化方案、连线、布局和示例都保留完整恢复字段，本地阶段不再调用模型', async () => {
  output = JSON.stringify({ version: 1, type: 'flowchart', title: '测试流程', direction: 'TB', nodes: [{ id: 'start', label: '开始', type: 'start' }, { id: 'end', label: '结束', type: 'end' }], edges: [{ source: 'start', target: 'end' }] });
  const before = calls.length, first = await finished(request({ stage: 'framework', generationMode: 'plan' }));
  assert.equal(first.status, 'succeeded'); assert.ok(first.plan); assert.ok(first.layoutInfo); assert.equal(first.stage, 'framework'); assert.equal(first.generationMode, 'plan'); assert.equal(calls.length, before + 1);
  const connected = await finished(request({ stage: 'connections', generationMode: 'plan', plan: first.plan, currentFile: first.xml }));
  assert.equal(connected.status, 'succeeded'); assert.equal(connected.source, 'plan-connections'); assert.equal(connected.stats.edges, 1); assert.equal(connected.turnUsage.calls, 0); assert.equal(calls.length, before + 1);
  const layout = await finished(request({ stage: 'layout', generationMode: 'plan', currentFile: connected.xml }));
  assert.equal(layout.status, 'succeeded'); assert.equal(layout.layoutPolicy, 'preserve'); assert.equal(layout.turnUsage.calls, 0); assert.equal(calls.length, before + 1);
  const mock = await finished(request({ providerId: 'mock', modelId: 'mock' })); assert.equal(mock.status, 'succeeded'); assert.equal(mock.source, 'mock'); assert.equal(mock.turnUsage.calls, 0); assert.equal(calls.length, before + 1);
});

test('鉴权、CSRF、输入、视觉基线、模型权限先校验，不能重用其他入口的已扣费编号', async () => {
  const body = request(), before = calls.length;
  assert.equal((await api(null, '/api/drawing/tasks', body)).status, 401);
  assert.equal((await api(alice, '/api/drawing/tasks', body, 'POST', { 'X-CSRF-Token': 'bad' })).status, 403);
  for (const patch of [{ mode: 'invalid' }, { message: '' }, { assistantId: 'bad' }, { unknown: 1 }, { stream: 1 }, { currentFile: '<invalid>' }, { providerId: 'personal:missing' }, { modelId: 'missing' }, { mode: 'vision', editMode: 'multimodal', currentFile: sampleModel(), vision: { baseXml: sampleModel().replace('处理', '旧基线'), image: PNG } }]) {
    assert.ok((await api(alice, '/api/drawing/tasks', { ...body, ...patch })).status >= 400);
  }
  assert.equal((await api(alice, '/api/drawing/tasks', body, 'POST', { 'X-Quota-Turn-Id': crypto.randomUUID() })).status, 400);
  assert.equal(calls.length, before); assert.equal(cloud.active.get(alice.user.id) || 0, 0);
  output = sampleModel(); const existing = await finished(request());
  const duplicate = request({ taskId: existing.taskId }); assert.equal((await api(alice, '/api/conversation/tasks', { ...duplicate, mode: undefined })).status, 409);
  assert.equal(calls.length, before + 1); const config = await (await api(alice, '/api/config')).json(); assert.equal(config.drawingTasksEnabled, true);
});
