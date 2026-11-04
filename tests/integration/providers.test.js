// 多提供商管理 + 对话模型切换：集成测试
//
// 起两个假服务（OpenAI 兼容 / Anthropic Messages），验证：
//   - 双协议请求头、路径、消息映射、结果提取（真实调用链，非 mock 前端选项）
//   - 两个地址不同、模型同名的提供商分别路由到正确地址，回复来源准确
//   - 请求开始即锁定：在途请求不受删除/停用影响，下一次请求明确拒绝
//   - 错误映射（401/404/429）、密钥不出现在任何响应、同源写保护
//   - 配置重启保留；获取模型列表失败不影响手动添加
// 运行前必须设置 PROVIDERS_CONFIG_PATH（隔离真实 data/）与假 DEEPSEEK 环境。
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.PROVIDERS_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diagramai-prov-it-')), 'providers.json');
process.env.REQUEST_TIMEOUT_MS = '5000';
process.env.MODEL_LIST_TIMEOUT_MS = '3000';
// 密闭测试：清空真实 DEEPSEEK 种子（否则本机导出的密钥会注入 DeepSeek 提供商，
// 破坏「第一个创建的提供商自动成为默认」等断言，甚至让测试真实调用外部 API）
process.env.DEEPSEEK_API_KEY = '';

const { createServer, providerStore } = require('../../server.js');
const { sampleModel, cellEdge, cellVertex, buildModel, flowPlan, designedFlowPlan } = require('../helpers/fixtures.js');
const { validateStage } = require('../../lib/staged-generation');
const Xml = require('../../lib/xml');
const Model = require('../../lib/graphmodel');

const SECRET_A = 'sk-unique-secret-A7f9q';
const SECRET_B = 'sk-unique-secret-B2m8z';

/** 可编程假模型服务：handler(req, body) → {status, body, delayMs?}；支持队列响应 */
function fakeService(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const respond = (out) => {
        const text = JSON.stringify(out.body);
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(text);
      };
      try {
        const out = handler(req, body) || { status: 200, body: {} };
        if (out.delayMs) setTimeout(() => respond(out), out.delayMs);
        else respond(out);
      } catch (e) {
        respond({ status: 500, body: { error: e.message } });
      }
    });
  });
  return { server, requests };
}

const XML = sampleModel();
const OPENAI_OK = (model) => ({ status: 200, body: { model, choices: [{ message: { content: '```xml\n' + XML + '\n```' }, finish_reason: 'stop' }], usage: { total_tokens: 10 } } });
const ANTHROPIC_OK = (model) => ({ status: 200, body: { model, content: [{ type: 'text', text: '```xml\n' + XML + '\n```' }], stop_reason: 'end_turn', usage: { output_tokens: 10 } } });

let app;
let base;
let gwA; // OpenAI 兼容假服务
let gwB; // Anthropic 假服务
const behaviorA = { mode: 'ok', queue: [] };
const behaviorB = { mode: 'ok', queue: [] };

test.before(async () => {
  gwA = fakeService((req, body) => {
    if (behaviorA.queue.length > 0) return behaviorA.queue.shift();
    if (behaviorA.mode === 'auth') return { status: 401, body: { error: { message: 'invalid key' } } };
    if (behaviorA.mode === 'rate') return { status: 429, body: { error: { message: 'slow down' } } };
    if (req.url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'shared-model' }, { id: 'model-x' }, { id: 'model-y' }] } };
    return OPENAI_OK(body && body.model);
  });
  gwB = fakeService((req, body) => {
    if (behaviorB.queue.length > 0) return behaviorB.queue.shift();
    if (behaviorB.mode === 'notfound') return { status: 404, body: { error: { message: 'unknown' } } };
    if (req.url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'shared-model' }] } };
    return ANTHROPIC_OK(body && body.model);
  });
  await new Promise((r) => gwA.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => gwB.server.listen(0, '127.0.0.1', r));

  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(async () => {
  // fetch 使用 keep-alive 连接，先断开全部连接再 close，否则 after 钩子挂起
  for (const s of [app, gwA.server, gwB.server]) {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
  }
  await new Promise((r) => app.close(r));
  await new Promise((r) => gwA.server.close(r));
  await new Promise((r) => gwB.server.close(r));
});

async function api(method, pathname, body, headers) {
  const res = await fetch(base + pathname, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

const portOf = (s) => s.server.address().port;

// ---------------------------------------------------------------------------

test('创建两个同名模型、不同地址的提供商（字段校验 + 密钥不出响应）', async () => {
  const a = await api('POST', '/api/providers', {
    providerId: 'gw-a', name: '网关 A', baseUrl: `http://127.0.0.1:${portOf(gwA)}`,
    protocol: 'openai-chat-completions', apiKey: SECRET_A,
  });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.ok(!a.text.includes(SECRET_A));

  const b = await api('POST', '/api/providers', {
    providerId: 'gw-b', name: '网关 B', baseUrl: `http://127.0.0.1:${portOf(gwB)}`,
    protocol: 'anthropic-messages', apiKey: SECRET_B,
  });
  assert.equal(b.status, 201);

  // 第一个提供商自动成为默认
  const list = await api('GET', '/api/providers');
  assert.equal(list.json.providers.length, 2);
  assert.ok(list.json.providers[0].isDefault === true);
  assert.ok(!list.text.includes(SECRET_A) && !list.text.includes(SECRET_B));

  for (const pid of ['gw-a', 'gw-b']) {
    const m = await api('POST', `/api/providers/${pid}/models`, { modelId: 'shared-model', displayName: '同名模型' });
    assert.equal(m.status, 201, JSON.stringify(m.json));
  }
});

test('非法字段给出字段旁错误；重复 ID / 重复模型被拒绝', async () => {
  const dup = await api('POST', '/api/providers', { providerId: 'gw-a', name: 'x', baseUrl: 'http://127.0.0.1:1', protocol: 'openai-chat-completions' });
  assert.equal(dup.status, 400);
  assert.ok(dup.json.detail.fields.providerId);

  const bad = await api('POST', '/api/providers', { providerId: 'bad-url', name: 'x', baseUrl: 'http://not-allowed.example.com', protocol: 'openai-chat-completions' });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.detail.fields.baseUrl);

  const dupModel = await api('POST', '/api/providers/gw-a/models', { modelId: 'shared-model' });
  assert.equal(dupModel.status, 400);
  assert.ok(dupModel.json.detail.fields.modelId);
});

test('chat 分别路由到正确地址；双协议请求头/路径/映射/提取；回复来源准确', async () => {
  gwA.requests.length = 0;
  gwB.requests.length = 0;

  const ra = await api('POST', '/api/chat', { message: '画一个流程图', providerId: 'gw-a', modelId: 'shared-model' });
  assert.equal(ra.status, 200, JSON.stringify(ra.json));
  assert.equal(ra.json.source, 'model');
  assert.equal(ra.json.provider.providerId, 'gw-a');
  assert.equal(ra.json.provider.name, '网关 A');
  assert.equal(ra.json.model.modelId, 'shared-model');
  assert.ok(ra.json.xml && ra.json.xml.includes('mxGraphModel'));

  const rb = await api('POST', '/api/chat', { message: '画一个流程图', providerId: 'gw-b', modelId: 'shared-model' });
  assert.equal(rb.status, 200, JSON.stringify(rb.json));
  assert.equal(rb.json.provider.providerId, 'gw-b');

  // OpenAI 兼容：Bearer 头、/chat/completions、消息数组透传
  const reqA = gwA.requests.find((r) => r.url.endsWith('/chat/completions'));
  assert.ok(reqA, '请求应到达网关 A');
  assert.equal(reqA.headers.authorization, `Bearer ${SECRET_A}`);
  assert.equal(reqA.body.model, 'shared-model');
  assert.equal(reqA.body.messages[0].role, 'system');
  assert.ok(reqA.body.messages.some((m) => m.role === 'user' && m.content.includes('画一个流程图')));

  // Anthropic：x-api-key、/v1/messages、system 抽取
  const reqB = gwB.requests.find((r) => r.url.endsWith('/v1/messages'));
  assert.ok(reqB, '请求应到达网关 B');
  assert.equal(reqB.headers['x-api-key'], SECRET_B);
  assert.ok(reqB.body.system && reqB.body.system.includes('图表'));
  assert.equal(reqB.body.messages[0].role, 'user');
  assert.ok(!reqB.body.messages.some((m) => m.role === 'system'));
  assert.equal(reqB.body.max_tokens, 32768); // 未配置时的绘图默认

  // 密钥不出现在任何聊天响应
  assert.ok(!ra.text.includes(SECRET_A) && !rb.text.includes(SECRET_B));
});

test('省略 providerId 的旧调用路由到明确的默认配置；不存在的 id 返回 4xx 不回退', async () => {
  const legacy = await api('POST', '/api/chat', { message: '画一个流程图' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.provider.providerId, 'gw-a'); // 第一个提供商为默认

  const nope = await api('POST', '/api/chat', { message: 'x', providerId: 'ghost' });
  assert.equal(nope.status, 404);
  assert.equal(nope.json.error.code, 'provider-not-found');

  const noModel = await api('POST', '/api/chat', { message: 'x', providerId: 'gw-a', modelId: 'ghost' });
  assert.equal(noModel.status, 404);
  assert.equal(noModel.json.error.code, 'model-not-found');
});

test('请求锁定：在途请求完成后才受删除影响；XML 纠错重试用同一调用配置', async () => {
  gwA.requests.length = 0;
  // 第 1 次响应：非法输出（触发 XML 纠错重试），延迟 200ms；
  // 第 2 次响应（重试）：正常图表，延迟 200ms
  behaviorA.queue = [
    { status: 200, delayMs: 200, body: { model: 'shared-model', choices: [{ message: { content: 'not-xml-at-all' }, finish_reason: 'stop' }] } },
    { status: 200, delayMs: 200, body: OPENAI_OK('shared-model').body },
  ];

  const inflight = api('POST', '/api/chat', { message: '画一个流程图', providerId: 'gw-a', modelId: 'shared-model' });
  // 请求在途：删除提供商 —— 已锁定的调用必须按原配置完成
  await new Promise((r) => setTimeout(r, 50));
  const del = await api('DELETE', '/api/providers/gw-a');
  assert.equal(del.status, 200);
  const done = await inflight;
  assert.equal(done.status, 200, JSON.stringify(done.json)); // 锁定快照完成，不被删除影响
  assert.equal(done.json.provider.providerId, 'gw-a');       // 来源仍是当时的 gw-a
  assert.equal(done.json.attempts, 2, '第一次非法输出应触发纠错重试');
  const chatHits = gwA.requests.filter((r) => r.url.endsWith('/chat/completions'));
  assert.equal(chatHits.length, 2, '纠错重试应与首次调用走同一提供商（两次都到达 gw-a）');
  assert.ok(done.json.xml.includes('mxGraphModel'));
  behaviorA.queue = [];

  // 下一次请求明确拒绝，绝不回退到其它模型
  const after = await api('POST', '/api/chat', { message: '画一个流程图', providerId: 'gw-a', modelId: 'shared-model' });
  assert.equal(after.status, 404);
  assert.equal(after.json.error.code, 'provider-not-found');
  assert.ok(!after.text.includes('网关 B'), '不得静默回退到其它提供商');

  // 默认提供商被删 → 省略字段的旧调用明确拒绝（不静默改路由到 gw-b）
  const legacyAfterDelete = await api('POST', '/api/chat', { message: '画一个流程图' });
  assert.equal(legacyAfterDelete.status, 409);
  assert.equal(legacyAfterDelete.json.error.code, 'default-model-unavailable');

  // 恢复 gw-a（后续用例需要）——重新创建并设为全局默认
  await api('POST', '/api/providers', {
    providerId: 'gw-a', name: '网关 A', baseUrl: `http://127.0.0.1:${portOf(gwA)}`,
    protocol: 'openai-chat-completions', apiKey: SECRET_A,
  });
  await api('POST', '/api/providers/gw-a/models', { modelId: 'shared-model', displayName: '同名模型' });
  await api('POST', '/api/providers/gw-a/models/shared-model/default');
  const list = await api('GET', '/api/providers');
  const defaults = list.json.providers.filter((p) => p.isDefault);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].providerId, 'gw-a');
  const legacy2 = await api('POST', '/api/chat', { message: '画一个流程图' });
  assert.equal(legacy2.status, 200);
  assert.equal(legacy2.json.provider.providerId, 'gw-a');
});

test('停用提供商/模型：明确 409，不回退', async () => {
  await api('PUT', '/api/providers/gw-b/models/shared-model', { enabled: false });
  const r1 = await api('POST', '/api/chat', { message: 'x', providerId: 'gw-b', modelId: 'shared-model' });
  assert.equal(r1.status, 409);
  assert.equal(r1.json.error.code, 'model-disabled');
  await api('PUT', '/api/providers/gw-b/models/shared-model', { enabled: true });

  await api('PUT', '/api/providers/gw-b', { enabled: false });
  const r2 = await api('POST', '/api/chat', { message: 'x', providerId: 'gw-b', modelId: 'shared-model' });
  assert.equal(r2.status, 409);
  assert.equal(r2.json.error.code, 'provider-disabled');
  await api('PUT', '/api/providers/gw-b', { enabled: true });
});

test('错误映射：401→auth-failed、429→rate-limited、404→model-not-found', async () => {
  behaviorA.mode = 'auth';
  let r = await api('POST', '/api/chat', { message: 'x', providerId: 'gw-a', modelId: 'shared-model' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'auth-failed');
  assert.ok(r.json.error.message.includes('认证'));

  behaviorA.mode = 'rate';
  r = await api('POST', '/api/chat', { message: 'x', providerId: 'gw-a', modelId: 'shared-model' });
  assert.equal(r.json.error.code, 'rate-limited');
  behaviorA.mode = 'ok';

  behaviorB.mode = 'notfound';
  r = await api('POST', '/api/chat', { message: 'x', providerId: 'gw-b', modelId: 'shared-model' });
  assert.equal(r.json.error.code, 'model-not-found');
  behaviorB.mode = 'ok';

  // 错误之后服务仍然正常
  const alive = await api('GET', '/api/models/catalog');
  assert.equal(alive.status, 200);
});

test('密钥全链路检查：编辑留空不清空、清除用独立操作、密钥不在日志型响应里', async () => {
  // 留空 = 保留
  let r = await api('PUT', '/api/providers/gw-a', { name: '网关 A', baseUrl: `http://127.0.0.1:${portOf(gwA)}`, protocol: 'openai-chat-completions', apiKey: '' });
  assert.equal(r.status, 200);
  assert.equal(providerStore.getRaw('gw-a').apiKey, SECRET_A);

  // clearKey 独立操作
  r = await api('PUT', '/api/providers/gw-a', { clearKey: true });
  assert.equal(r.status, 200);
  assert.equal(providerStore.getRaw('gw-a').apiKey, '');
  assert.equal(providerStore.getSanitized('gw-a').hasKey, false);
  // 恢复密钥
  r = await api('PUT', '/api/providers/gw-a', { apiKey: SECRET_A });
  assert.equal(providerStore.getRaw('gw-a').apiKey, SECRET_A);

  // 所有出口都不含唯一测试密钥
  for (const [method, p] of [
    ['GET', '/api/providers'], ['GET', '/api/models/catalog'], ['GET', '/api/config'],
    ['GET', '/api/providers/gw-a'], ['GET', '/api/providers/gw-b'],
  ]) {
    const res = await api(method, p);
    assert.ok(!res.text.includes(SECRET_A), `${p} 泄漏了密钥 A`);
    assert.ok(!res.text.includes(SECRET_B), `${p} 泄漏了密钥 B`);
  }
});

test('同源写保护：跨站 Origin 被拒绝，同源 / 无 Origin 放行', async () => {
  const evil = await api('POST', '/api/providers', { providerId: 'evil', name: 'x', baseUrl: 'http://127.0.0.1:1', protocol: 'openai-chat-completions' }, { Origin: 'https://evil.example.com' });
  assert.equal(evil.status, 403);

  const sameOrigin = await fetch(base + '/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ providerId: 'origin-ok', name: '同源', baseUrl: 'http://127.0.0.1:1', protocol: 'openai-chat-completions' }),
  });
  assert.equal(sameOrigin.status, 201);
  await api('DELETE', '/api/providers/origin-ok');
});

test('获取模型列表与手动添加并存；获取失败不阻止手动保存', async () => {
  const ok = await api('POST', '/api/providers/gw-a/models/fetch');
  assert.equal(ok.json.ok, true);
  assert.deepEqual(ok.json.models, ['shared-model', 'model-x', 'model-y']);

  // 批量添加（shared-model 重复 → 跳过，其余成功）
  const batch = await api('POST', '/api/providers/gw-a/models', { models: [{ modelId: 'shared-model' }, { modelId: 'model-x' }, { modelId: 'model-y' }] });
  assert.equal(batch.json.added.length, 2);
  assert.equal(batch.json.skipped.length, 1);

  // 一个不存在的提供商地址 → 获取失败，但不影响手动添加
  await api('POST', '/api/providers', { providerId: 'dead-gw', name: '死网关', baseUrl: 'http://127.0.0.1:1', protocol: 'openai-chat-completions', apiKey: 'sk-dead-gateway-test-key' });
  const fail = await api('POST', '/api/providers/dead-gw/models/fetch');
  assert.equal(fail.json.ok, false);
  const manual = await api('POST', '/api/providers/dead-gw/models', { modelId: 'manual-model' });
  assert.equal(manual.status, 201, '获取失败绝不能阻止手动添加');
  const dead = providerStore.getRaw('dead-gw');
  assert.equal(dead.models.length, 1);
});

test('测试模型：成功/失败状态、真实 provider/model 与时间；成功不冒充已连通之外的状态', async () => {
  const good = await api('POST', '/api/providers/gw-a/models/model-x/test');
  assert.equal(good.json.ok, true);
  assert.equal(good.json.status, 'success');
  assert.equal(good.json.provider.providerId, 'gw-a');
  assert.equal(good.json.model.modelId, 'model-x');
  assert.ok(good.json.testedAt);
  assert.equal(providerStore.getRaw('gw-a').models.find((m) => m.modelId === 'model-x').testStatus, 'success');

  behaviorB.mode = 'notfound';
  const bad = await api('POST', '/api/providers/gw-b/models/shared-model/test');
  assert.equal(bad.json.ok, false);
  assert.equal(bad.json.status, 'fail');
  assert.ok(bad.json.error);
  assert.ok(bad.json.testedAt);
  assert.equal(providerStore.getRaw('gw-b').models.find((m) => m.modelId === 'shared-model').testStatus, 'fail');
  behaviorB.mode = 'ok';
});

test('配置重启保留：新服务实例（同一路径）读到全部配置', async () => {
  const app2 = createServer();
  await new Promise((r) => app2.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${app2.address().port}`;
  const res = await fetch(base2 + '/api/providers').then((r) => r.json());
  const ids = res.providers.map((p) => p.providerId).sort();
  assert.deepEqual(ids, ['dead-gw', 'gw-a', 'gw-b']);
  const chat = await fetch(base2 + '/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: '画一个流程图', providerId: 'gw-a', modelId: 'shared-model' }),
  }).then((r) => r.json());
  assert.ok(chat.xml && chat.xml.includes('mxGraphModel'), '重启后真实调用链仍工作');
  await new Promise((r) => app2.close(r));
});

test('截断错误显示实际输出上限与用量，拒绝部分 XML 且不自动重复调用', async () => {
  const calls = gwB.requests.length;
  behaviorB.queue.push({ status: 200, body: {
    content: [{ type: 'text', text: '<mxGraphModel>' }], stop_reason: 'max_tokens', usage: { output_tokens: 32768 },
  } });
  const r = await api('POST', '/api/chat', { message: '画一个流程图', providerId: 'gw-b', modelId: 'shared-model' });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'model-truncated');
  assert.match(r.json.error.message, /本次输出上限：32768[^，]+，已使用：32768/);
  assert.equal(r.json.detail.maxTokens, 32768);
  assert.equal(r.json.xml, undefined);
  assert.equal(gwB.requests.length, calls + 1);
});

test('连线阶段仅输出边也可合并，框架保持原样且不携带旧历史', async () => {
  const framework = buildModel([cellVertex('left', '已确认起点'), cellVertex('right', '已确认终点', {y:200})]);
  behaviorA.queue.push({status:200,body:{choices:[{message:{content:`<mxGraphModel><root>${cellEdge('link','left','right','下一步')}</root></mxGraphModel>`},finish_reason:'stop'}]}});
  const r=await api('POST','/api/chat',{message:'画流程图',stage:'connections',currentFile:framework,
    history:[{role:'user',content:'无关旧流程'}],providerId:'gw-a',modelId:'shared-model'});
  assert.equal(r.status,200,JSON.stringify(r.json));
  assert.equal(validateStage(r.json.xml,'connections',framework),null);
  assert.equal(r.json.stats.edges,1);
  const sent=gwA.requests.at(-1).body.messages;
  assert.equal(sent.length,2);
  assert.ok(sent.at(-1).content.includes(framework));
  assert.match(sent[0].content,/仅生成连线增量/);
});

test('连线引用新框架节点被拒，纠错重试仍只要求连线', async () => {
  const framework=buildModel([cellVertex('left','起点'),cellVertex('right','终点',{y:200})]);
  const wrong={status:200,body:{choices:[{message:{content:buildModel([cellVertex('new','新起点'),cellEdge('link','new','right')])},finish_reason:'stop'}]}};
  behaviorA.queue.push(wrong,wrong);
  const before=gwA.requests.length;
  const r=await api('POST','/api/chat',{message:'画流程图',stage:'connections',currentFile:framework,providerId:'gw-a',modelId:'shared-model'});
  assert.equal(r.status,502);
  assert.equal(r.json.error.code,'invalid-model-output');
  assert.equal(r.json.xml,undefined);
  assert.equal(gwA.requests.length,before+2);
  assert.match(gwA.requests.at(-1).body.messages.at(-1).content,/仅含连线/);
});

test('mock 示例引擎始终可用且不冒充真实生成', async () => {
  const r = await api('POST', '/api/chat', { message: '把当前图表整体改成从左到右布局', providerId: 'mock' });
  assert.equal(r.status, 200);
  assert.equal(r.json.source, 'mock');
  assert.equal(r.json.provider.name, '示例引擎');
});

test('一次模型规划后，本地添加全部关系与布局；画布偏离方案时拒绝且不调用模型', async () => {
  const before=gwA.requests.length;
  behaviorA.queue.push({status:200,body:{choices:[{message:{content:JSON.stringify(designedFlowPlan())},finish_reason:'stop'}]}});
  const first=await api('POST','/api/chat',{message:'画审批流程',stage:'framework',generationMode:'plan',providerId:'gw-a',modelId:'shared-model'});
  assert.equal(first.status,200,JSON.stringify(first.json));
  assert.equal(first.json.stats.edges,0);
  assert.equal(first.json.attempts,1);
  assert.equal(first.json.layoutInfo.source,'model');
  assert.ok(first.json.xml.includes('x="320.5"'));
  assert.ok(first.json.xml.includes('fillColor=#eef5f2;'));
  const connected=await api('POST','/api/chat',{message:'继续',stage:'connections',generationMode:'plan',plan:first.json.plan,
    currentFile:first.json.xml,providerId:'deleted-provider',clientRevision:7});
  assert.equal(connected.status,200,JSON.stringify(connected.json));
  assert.equal(connected.json.source,'plan-connections');
  assert.equal(connected.json.clientRevision,7);
  assert.equal(connected.json.stats.edges,4);
  assert.equal(validateStage(connected.json.xml,'connections',first.json.xml),null);
  const layout=await api('POST','/api/chat',{message:'整理',stage:'layout',generationMode:'plan',currentFile:connected.json.xml});
  assert.equal(layout.status,200);
  assert.equal(layout.json.layoutPolicy,'preserve');
  const cells = xml => Model.collectCells(Xml.firstChild(Xml.parse(xml).root,'root')).map(e=>Model.serializeNode(e.cell));
  assert.deepEqual(cells(layout.json.xml),cells(connected.json.xml),'本地阶段保留模型设计和路径');
  assert.ok(layout.json.xml.includes('<mxPoint x="810" y="426"/>'));
  const wrong=await api('POST','/api/chat',{message:'继续',stage:'connections',plan:first.json.plan,
    currentFile:first.json.xml.replace('value="通过？"','value="手工改动"')});
  assert.equal(wrong.status,409);
  assert.equal(wrong.json.error.code,'plan-framework-mismatch');
  assert.equal(gwA.requests.length,before+1,'仅规划阶段调用模型一次');
});

test('方案缺少判断条件时最多纠正一次，缺少缓存方案不回退到模型调用', async () => {
  const invalid=flowPlan();invalid.edges[1].label='';
  for(const p of [invalid,flowPlan()])behaviorA.queue.push({status:200,body:{choices:[{message:{content:JSON.stringify(p)},finish_reason:'stop'}]}});
  const before=gwA.requests.length;
  const first=await api('POST','/api/chat',{message:'画审批',stage:'framework',generationMode:'plan',providerId:'gw-a',modelId:'shared-model'});
  assert.equal(first.status,200,JSON.stringify(first.json));
  assert.equal(first.json.attempts,2);
  assert.match(gwA.requests.at(-1).body.messages.at(-1).content,/分支条件/);
  const missing=await api('POST','/api/chat',{message:'继续',stage:'connections',generationMode:'plan',currentFile:first.json.xml});
  assert.equal(missing.status,400);
  assert.equal(missing.json.error.code,'missing-diagram-plan');
  assert.equal(gwA.requests.length,before+2);
});

test('强度参数经过配置和快照进入真实 HTTP 请求；关闭思考省略强度，非法值提前拒绝', async () => {
  const modelId = 'Qwen/Qwen3.8-27B';
  const modelPath = '/api/providers/gw-a/models/' + encodeURIComponent(modelId);
  const created = await api('POST', '/api/providers/gw-a/models', { modelId, thinkingMode: 'enable-thinking-on', reasoningEffort: 'medium' });
  assert.equal(created.status, 201);
  const request = { message: '生成一张架构图', providerId: 'gw-a', modelId };
  const generated = await api('POST', '/api/chat', request);
  assert.equal(generated.status, 200);
  assert.equal(gwA.requests.at(-1).body.reasoning_effort, 'medium');
  assert.equal(gwA.requests.at(-1).body.enable_thinking, true);
  const prompt = gwA.requests.at(-1).body.messages[0].content;
  assert.match(prompt, /保留未涉及部分/);
  assert.equal(prompt.includes('fillColor=#d5e8d4'), false);
  const before = gwA.requests.length;
  const invalid = await api('PUT', modelPath, { reasoningEffort: 'high' });
  assert.equal(invalid.status, 400);
  assert.equal(gwA.requests.length, before);
  await api('PUT', modelPath, { thinkingMode: 'enable-thinking-off' });
  assert.equal((await api('POST', '/api/chat', request)).status, 200);
  assert.equal('reasoning_effort' in gwA.requests.at(-1).body, false);
  assert.equal(providerStore.getRaw('gw-a').models.find(m => m.modelId === modelId).reasoningEffort, 'medium');
  await api('DELETE', modelPath);
});

test('模型列表扩展元数据只保留声明的能力，手动添加后可发送声明强度', async () => {
  behaviorA.queue.push({ status: 200, body: { data: [{ id: 'remote-effort', supported_parameters: ['reasoning_effort'],
    reasoning_effort_levels: ['low', 'high'], apiKey: SECRET_A, unrelated: SECRET_B }] } });
  const fetched = await api('POST', '/api/providers/gw-a/models/fetch');
  assert.deepEqual(fetched.json.models, ['remote-effort']);
  assert.equal(fetched.text.includes(SECRET_A), false);
  assert.equal(fetched.text.includes(SECRET_B), false);
  const saved = await api('POST', '/api/providers/gw-a/models', { ...fetched.json.modelDetails[0], reasoningEffort: 'high' });
  assert.equal(saved.status, 201);
  const safe = saved.json.provider.models.find(m => m.modelId === 'remote-effort');
  assert.equal(safe.capabilities.source, 'remote');
  assert.deepEqual(safe.capabilities.reasoningLevels, ['low', 'high']);
  await api('DELETE', '/api/providers/gw-a/models/remote-effort');
});
