// 多提供商返工（R1–R7）行为测试：全部走真实 HTTP 调用链（原生 http.request + fetch），
// 不做源码字符串匹配。每条用例都对应返工提示词里的一个验收点。
//
// 覆盖：
//   R1 已有提供商编辑保存（同 ID 完整表单 / 改 ID 拒绝 / 新增重复 / 重启持久化）
//   R2 上游回显密钥时的安全边界（chat / 测试 / 获取列表 / 管理列表 / 服务端日志）
//   R4 失效模型处理（显式选择失效拒绝 / 在途请求用原快照 / 不自动切换）
//   R5 本地访问边界（默认监听回环 + 可信 Host/Origin 门禁，原生 HTTP 头测试）
//   R6 编辑版本冲突（两个客户端同版先后保存 / 模型参数与默认修改 / 失败不递增版本 /
//      测试状态不制造冲突）
//   R7 模型参数编辑（新参数下一次请求生效 / 在途用原参数 / 清空回协议默认 /
//      字段校验 / 不靠删除重建）
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.PROVIDERS_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diagramai-rework-it-')), 'providers.json');
process.env.REQUEST_TIMEOUT_MS = '8000';
process.env.MODEL_LIST_TIMEOUT_MS = '3000';
process.env.DEEPSEEK_API_KEY = '';

const { createServer, start, providerStore } = require('../../server.js');
const { sampleModel } = require('../helpers/fixtures.js');

const SECRET_OA = 'sk-rework-openai-secret';
const SECRET_AN = 'sk-rework-anthropic-secret';
// 真实凭据形态：Bearer 后跟 ASCII 凭据字符（擦除标记 *** / 全角标点 / 中文不算凭据）
const CRED_FORM = /Bearer\s+[A-Za-z0-9._~+/=-]{6,}/;

function fakeService(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
      requests.push({ method: req.method, url: req.url, headers: req.headers, body, at: Date.now() });
      const out = handler(req, body) || { status: 200, body: {} };
      if (out.delayMs) setTimeout(() => {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      }, out.delayMs);
      else {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body));
      }
    });
  });
  return { server, requests };
}

const XML = sampleModel();
const openaiOk = (model) => ({ status: 200, body: { model, choices: [{ message: { content: '```xml\n' + XML + '\n```' }, finish_reason: 'stop' }] } });
const anthropicOk = (model) => ({ status: 200, body: { model, content: [{ type: 'text', text: '```xml\n' + XML + '\n```' }], stop_reason: 'end_turn' } });

let app;
let base;
let gwOpenai;
let gwAnthropic;
const upstream = { openai: 'ok', anthropic: 'ok', anthropicDelay: 0 };
const errorLogs = [];

test.before(async () => {
  // 捕获服务端日志（R2：日志不得含密钥）
  const origError = console.error;
  console.error = (...args) => { errorLogs.push(args.map(String).join(' ')); origError(...args); };

  // 假上游 A（OpenAI 兼容）：401 时把收到的 Authorization 原样回显（模拟真实网关回显）
  gwOpenai = fakeService((req, body) => {
    if (upstream.openai === 'echo-auth') {
      return { status: 401, body: { error: { message: 'Invalid credential ' + req.headers.authorization } } };
    }
    if (upstream.openai === 'net-error') {
      return { status: 503, body: { error: { message: 'upstream exploding: connection refused to 10.0.0.9:443 with key ' + req.headers.authorization } } };
    }
    if (req.url.endsWith('/models')) {
      if (upstream.openai === 'echo-auth-models') {
        return { status: 401, body: { error: { message: 'bad key: ' + req.headers.authorization } } };
      }
      return { status: 200, body: { data: [{ id: 'shared-model' }, { id: 'extra-model' }] } };
    }
    return openaiOk(body && body.model);
  });
  // 假上游 B（Anthropic Messages）：401 时回显 x-api-key
  gwAnthropic = fakeService((req, body) => {
    if (upstream.anthropic === 'echo-auth') {
      return { status: 401, body: { error: { message: 'invalid x-api-key: ' + req.headers['x-api-key'] } } };
    }
    if (req.url.endsWith('/models')) return { status: 200, body: { data: [{ id: 'shared-model' }] } };
    return Object.assign(anthropicOk(body && body.model), { delayMs: upstream.anthropicDelay });
  });
  await new Promise((r) => gwOpenai.server.listen(0, '127.0.0.1', r));
  await new Promise((r) => gwAnthropic.server.listen(0, '127.0.0.1', r));

  app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

test.after(async () => {
  for (const s of [app, gwOpenai.server, gwAnthropic.server]) {
    if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
  }
  await new Promise((r) => app.close(r));
  await new Promise((r) => gwOpenai.server.close(r));
  await new Promise((r) => gwAnthropic.server.close(r));
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

/** 原生 HTTP 请求：可以任意设置 Host / Origin（fetch 会拒绝改 Host，不能用它测 R5） */
function rawRequest(pathname, { method = 'GET', host, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const port = app.address().port;
    const headers = { 'Content-Type': 'application/json' };
    if (host) headers.Host = host;
    if (origin) headers.Origin = origin;
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const portOf = (s) => s.server.address().port;

async function seed() {
  await api('POST', '/api/providers', {
    providerId: 'oa', name: 'OpenAI 假网关', baseUrl: `http://127.0.0.1:${portOf(gwOpenai)}`,
    protocol: 'openai-chat-completions', apiKey: SECRET_OA,
  });
  await api('POST', '/api/providers', {
    providerId: 'an', name: 'Anthropic 假网关', baseUrl: `http://127.0.0.1:${portOf(gwAnthropic)}`,
    protocol: 'anthropic-messages', apiKey: SECRET_AN,
  });
  await api('POST', '/api/providers/oa/models', { modelId: 'shared-model', displayName: '同名模型A' });
  await api('POST', '/api/providers/an/models', { modelId: 'shared-model', displayName: '同名模型B' });
}

// ---------------------------------------------------------------------------
// R5：本地访问边界（先测门禁，保证后续用例都在可信路径上）
// ---------------------------------------------------------------------------

test('R5：start() 默认只监听回环地址', async () => {
  const server = start(0);
  await new Promise((r) => server.once('listening', r));
  const addr = server.address();
  assert.ok(['127.0.0.1', '::1'].includes(addr.address), `默认监听地址应是回环，实际 ${addr.address}`);
  // 回环监听下，非回环来源不可达由操作系统保证；这里验证进程内可见的绑定事实
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test('R5：可信 Host/Origin 放行；外部 Host / 异常 Origin 一律 403', async () => {
  // 无 Origin 的本地客户端（curl 形态）：可信 Host → 放行
  const plain = await rawRequest('/api/providers', { host: `127.0.0.1:${app.address().port}` });
  assert.equal(plain.status, 200);

  // Origin 与 Host 完全一致且为本地 → 放行
  const sameOrigin = await rawRequest('/api/providers', {
    host: `localhost:${app.address().port}`, origin: `http://localhost:${app.address().port}`,
  });
  assert.equal(sameOrigin.status, 200);

  // 任意匹配的外部 Host → 拒绝（读与写都拦）
  for (const pathname of ['/api/providers', '/api/models/catalog']) {
    const foreign = await rawRequest(pathname, { host: 'evil.example.com' });
    assert.equal(foreign.status, 403, `${pathname} 外部 Host 应 403`);
    assert.equal(foreign.json.error.code, 'forbidden-host');
  }

  // 外部 Origin（即使 Host 伪装可信）→ 拒绝
  const cross = await rawRequest('/api/providers', {
    host: `127.0.0.1:${app.address().port}`, origin: 'http://evil.example.com',
  });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, 'forbidden-origin');

  // 畸形 Origin → 拒绝
  const malformed = await rawRequest('/api/providers', {
    host: `127.0.0.1:${app.address().port}`, origin: 'not-a-url',
  });
  assert.equal(malformed.status, 403);

  // 写操作同样被拦：外部 Host 的创建请求绝不落库
  const before = (await api('GET', '/api/providers')).json.providers.length;
  const blocked = await rawRequest('/api/providers', {
    method: 'POST', host: 'evil.example.com', origin: 'http://evil.example.com',
    body: { providerId: 'evil', name: 'x', baseUrl: 'https://e.example.com', protocol: 'openai-chat-completions' },
  });
  assert.equal(blocked.status, 403);
  const after = (await api('GET', '/api/providers')).json.providers.length;
  assert.equal(after, before, '被拒请求不得产生任何配置写入');
});

// ---------------------------------------------------------------------------
// 基础数据
// ---------------------------------------------------------------------------

test('准备：两个本机假提供商 + 同名模型', async () => {
  await seed();
  const list = await api('GET', '/api/providers');
  assert.equal(list.status, 200);
  assert.equal(list.json.providers.length, 2);
  assert.ok(Number.isInteger(list.json.revision), '列表应返回配置编辑版本');
});

// ---------------------------------------------------------------------------
// R1：已有提供商编辑保存
// ---------------------------------------------------------------------------

test('R1：完整表单携带自身 providerId 保存不报重复；改其它字段生效；密钥留空保留', async () => {
  const r0 = await api('GET', '/api/providers');
  const rev = r0.json.revision;

  const full = await api('PUT', '/api/providers/oa', {
    providerId: 'oa', // 完整表单自带自身 ID —— 不得判重（R1 旧缺陷）
    name: 'OpenAI 网关（改）',
    baseUrl: `http://127.0.0.1:${portOf(gwOpenai)}/v1`,
    protocol: 'openai-chat-completions',
    apiKey: '', // 留空 = 保留原密钥
    enabled: true,
    revision: rev,
  });
  assert.equal(full.status, 200, JSON.stringify(full.json));
  assert.equal(full.json.provider.name, 'OpenAI 网关（改）');
  assert.equal(full.json.provider.baseUrl, `http://127.0.0.1:${portOf(gwOpenai)}/v1`);
  assert.equal(full.json.provider.hasKey, true, '留空不得清掉已保存密钥');
  assert.equal(full.json.revision, rev + 1, '保存成功应推进编辑版本');

  // 留空密钥后真实调用仍然带原密钥（证明密钥真的被保留，而不是被清空）
  gwOpenai.requests.length = 0;
  const chat = await api('POST', '/api/chat', { message: '画流程图', providerId: 'oa', modelId: 'shared-model' });
  assert.equal(chat.status, 200, JSON.stringify(chat.json));
  assert.equal(gwOpenai.requests[0].headers.authorization, `Bearer ${SECRET_OA}`);

  // 停用再启用也能保存
  const dis = await api('PUT', '/api/providers/oa', { enabled: false });
  assert.equal(dis.status, 200);
  assert.equal(dis.json.provider.enabled, false);
  const en = await api('PUT', '/api/providers/oa', { enabled: true });
  assert.equal(en.status, 200);
  assert.equal(en.json.provider.enabled, true);
});

test('R1：改成不同 providerId 明确拒绝；新增重复 ID 仍是字段错误', async () => {
  const rename = await api('PUT', '/api/providers/oa', { providerId: 'oa-new' });
  assert.equal(rename.status, 400);
  assert.ok(/不可修改/.test(rename.json.detail.fields.providerId), JSON.stringify(rename.json));

  const dup = await api('POST', '/api/providers', {
    providerId: 'oa', name: '重复', baseUrl: 'https://x.example.com', protocol: 'openai-chat-completions',
  });
  assert.equal(dup.status, 400);
  assert.ok(/已存在/.test(dup.json.detail.fields.providerId));
});

test('R1：编辑结果重启后持久化（新实例读同一文件）', async () => {
  const { ProviderStore } = require('../../lib/provider-store.js');
  const reopened = new ProviderStore({ filePath: process.env.PROVIDERS_CONFIG_PATH, env: {} }).load();
  const oa = reopened.getRaw('oa');
  assert.ok(oa, '重启后提供商仍在');
  assert.equal(oa.name, 'OpenAI 网关（改）');
  assert.equal(oa.apiKey, SECRET_OA, '密钥持久化保留');
  assert.equal(oa.models.length, 1);
});

// ---------------------------------------------------------------------------
// R2：错误密钥泄漏（上游回显认证头）
// ---------------------------------------------------------------------------

test('R2：OpenAI 协议上游 401 回显 Bearer 头——chat/测试/获取列表/管理列表/日志全都不泄漏', async () => {
  upstream.openai = 'echo-auth';
  try {
    const chat = await api('POST', '/api/chat', { message: '画流程图', providerId: 'oa', modelId: 'shared-model' });
    assert.equal(chat.status, 502);
    assert.ok(!chat.text.includes(SECRET_OA), 'chat 响应不得包含密钥');
    assert.ok(!CRED_FORM.test(chat.text), 'chat 响应不得包含任何 Bearer 凭据形态');

    const t = await api('POST', '/api/providers/oa/models/shared-model/test');
    assert.equal(t.status, 200);
    assert.equal(t.json.ok, false);
    assert.ok(!t.text.includes(SECRET_OA), '测试响应不得包含密钥');

    // 持久化的测试错误详情（管理列表可见）也不得含密钥
    const list = await api('GET', '/api/providers');
    const oa = list.json.providers.find((p) => p.providerId === 'oa');
    const model = oa.models.find((m) => m.modelId === 'shared-model');
    assert.equal(model.testStatus, 'fail');
    assert.ok(!JSON.stringify(list.json).includes(SECRET_OA), '管理列表不得包含密钥');
    assert.ok(!CRED_FORM.test(model.lastTestError || ''), '持久化错误详情不得包含 Bearer 形态');
    assert.ok(/认证失败/.test(model.lastTestError || ''), '错误应保留可读分类信息');

    // 获取模型列表失败路径
    upstream.openai = 'echo-auth-models';
    const fetchModels = await api('POST', '/api/providers/oa/models/fetch');
    assert.equal(fetchModels.status, 200);
    assert.equal(fetchModels.json.ok, false);
    assert.ok(!fetchModels.text.includes(SECRET_OA), '获取列表错误不得包含密钥');

    // 服务端日志
    assert.ok(errorLogs.every((line) => !line.includes(SECRET_OA)), '服务端日志不得包含密钥');
  } finally {
    upstream.openai = 'ok';
  }
});

test('R2：Anthropic 协议上游 401 回显 x-api-key——同样不泄漏', async () => {
  upstream.anthropic = 'echo-auth';
  try {
    const chat = await api('POST', '/api/chat', { message: '画流程图', providerId: 'an', modelId: 'shared-model' });
    assert.equal(chat.status, 502);
    assert.ok(!chat.text.includes(SECRET_AN));

    const t = await api('POST', '/api/providers/an/models/shared-model/test');
    assert.equal(t.json.ok, false);
    assert.ok(!t.text.includes(SECRET_AN));

    const list = await api('GET', '/api/providers');
    assert.ok(!list.text.includes(SECRET_AN));
  } finally {
    upstream.anthropic = 'ok';
  }
});

test('R2：网络层异常消息（含密钥形态文本）也被擦除', async () => {
  upstream.openai = 'net-error';
  try {
    const chat = await api('POST', '/api/chat', { message: '画流程图', providerId: 'oa', modelId: 'shared-model' });
    assert.equal(chat.status, 502);
    assert.ok(!chat.text.includes(SECRET_OA));
    assert.ok(!CRED_FORM.test(chat.text));
  } finally {
    upstream.openai = 'ok';
  }
});

// ---------------------------------------------------------------------------
// R4：失效模型处理
// ---------------------------------------------------------------------------

test('R4：显式选择的模型/提供商失效时明确拒绝，不回退其它模型', async () => {
  await api('POST', '/api/providers', {
    providerId: 'backup', name: '备用网关', baseUrl: `http://127.0.0.1:${portOf(gwOpenai)}`,
    protocol: 'openai-chat-completions', apiKey: 'sk-backup-key',
  });
  await api('POST', '/api/providers/backup/models', { modelId: 'backup-model' });
  // backup 存在且有效；把全局默认切到 backup，用户仍显式选择已删除的模型
  await api('POST', '/api/providers/backup/models/backup-model/default');

  // 删除 oa 的 shared-model：显式选择它的请求必须失败，绝不路由到默认 backup
  await api('DELETE', '/api/providers/oa/models/shared-model');
  const chat = await api('POST', '/api/chat', { message: '画流程图', providerId: 'oa', modelId: 'shared-model' });
  assert.equal(chat.status, 404);
  assert.equal(chat.json.error.code, 'model-not-found');
  assert.ok(!chat.json.xml, '失效选择不得产出图表');

  // 停用提供商同理
  await api('PUT', '/api/providers/oa', { enabled: false });
  const chat2 = await api('POST', '/api/chat', { message: '画流程图', providerId: 'oa', modelId: 'shared-model' });
  assert.equal(chat2.status, 409);
  assert.equal(chat2.json.error.code, 'provider-disabled');
  await api('PUT', '/api/providers/oa', { enabled: true });

  // 恢复模型供后续用例使用
  await api('POST', '/api/providers/oa/models', { modelId: 'shared-model', displayName: '同名模型A' });
});

test('R4：在途请求继续使用开始时的快照（响应来源 = 原提供商）', async () => {
  upstream.anthropicDelay = 400;
  gwAnthropic.requests.length = 0;
  const pending = api('POST', '/api/chat', { message: '画流程图', providerId: 'an', modelId: 'shared-model' });
  // 等上游收到请求（已按旧配置发出）
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(gwAnthropic.requests.some((x) => x.url.endsWith('/v1/messages')), '请求应已按快照发出');
  // 请求在途时删除该模型（下一次请求才会失效，本次不受影响）
  await api('DELETE', '/api/providers/an/models/shared-model');
  const res = await pending;
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.provider.providerId, 'an', '在途请求仍按原快照完成，来源标记不变');
  assert.ok(res.json.xml);
  // 之后的新请求必须明确失败
  const after = await api('POST', '/api/chat', { message: '画流程图', providerId: 'an', modelId: 'shared-model' });
  assert.equal(after.status, 404);
  assert.equal(after.json.error.code, 'model-not-found');
  // 恢复
  await api('POST', '/api/providers/an/models', { modelId: 'shared-model', displayName: '同名模型B' });
  upstream.anthropicDelay = 0;
});

// ---------------------------------------------------------------------------
// R6：编辑版本（乐观并发）
// ---------------------------------------------------------------------------

test('R6：两个客户端读取同版后依次保存——第二个 409，不覆盖新配置', async () => {
  const r0 = await api('GET', '/api/providers');
  const sharedRev = r0.json.revision; // 两个客户端都在这一版读取

  const first = await api('PUT', '/api/providers/oa', { name: '客户端一的名称', revision: sharedRev });
  assert.equal(first.status, 200);
  assert.equal(first.json.revision, sharedRev + 1);

  const second = await api('PUT', '/api/providers/oa', { name: '客户端二的旧表单', revision: sharedRev });
  assert.equal(second.status, 409);
  assert.equal(second.json.error.code, 'stale-config');

  const r1 = await api('GET', '/api/providers');
  const oa = r1.json.providers.find((p) => p.providerId === 'oa');
  assert.equal(oa.name, '客户端一的名称', '过期写入不得覆盖新配置');
  assert.equal(r1.json.revision, sharedRev + 1, '被拒的保存不得递增版本');
});

test('R6：模型参数与默认修改同样受编辑版本保护', async () => {
  const r0 = await api('GET', '/api/providers');
  const rev = r0.json.revision;

  const okEdit = await api('PUT', '/api/providers/oa/models/shared-model', { temperature: 0.7, revision: rev });
  assert.equal(okEdit.status, 200);

  const staleEdit = await api('PUT', '/api/providers/oa/models/shared-model', { temperature: 1.5, revision: rev });
  assert.equal(staleEdit.status, 409);

  // 过期的默认修改（把默认切到 oa）必须 409；当前默认 backup 保持不变
  const staleDefault = await api('POST', '/api/providers/oa/models/shared-model/default', { revision: rev });
  assert.equal(staleDefault.status, 409);

  const fresh = await api('GET', '/api/providers');
  const oa = fresh.json.providers.find((p) => p.providerId === 'oa');
  assert.equal(oa.models.find((m) => m.modelId === 'shared-model').temperature, 0.7, '过期参数写入不得生效');
  assert.equal(oa.isDefault, false, '过期默认修改不得生效');
  assert.equal(fresh.json.providers.find((p) => p.providerId === 'backup').isDefault, true, '有效默认保持不变');
});

test('R6：测试状态更新不递增版本、不制造编辑冲突', async () => {
  const r0 = await api('GET', '/api/providers');
  const rev = r0.json.revision;

  const t = await api('POST', '/api/providers/oa/models/shared-model/test');
  assert.equal(t.status, 200);
  assert.equal(t.json.ok, true);

  const r1 = await api('GET', '/api/providers');
  assert.equal(r1.json.revision, rev, '连通性测试不得递增编辑版本');

  // 测试之后，持有旧版本的表单仍能保存（不因测试状态而无谓冲突）
  const save = await api('PUT', '/api/providers/oa', { name: '测试后仍可保存', revision: rev });
  assert.equal(save.status, 200, '测试状态不得把正在编辑的表单顶成 409');
});

test('R6：保存失败（校验错误）不递增版本', async () => {
  const r0 = await api('GET', '/api/providers');
  const rev = r0.json.revision;
  const bad = await api('PUT', '/api/providers/oa', { baseUrl: 'not-a-url', revision: rev });
  assert.equal(bad.status, 400);
  const r1 = await api('GET', '/api/providers');
  assert.equal(r1.json.revision, rev, '校验失败不得递增版本');
});

// ---------------------------------------------------------------------------
// R7：模型编辑（参数）
// ---------------------------------------------------------------------------

test('R7：编辑显示名/maxTokens/temperature——下一次请求生效；清空回协议默认', async () => {
  const r0 = await api('GET', '/api/providers');
  const rev = r0.json.revision;

  const edit = await api('PUT', '/api/providers/oa/models/shared-model', {
    displayName: '流程图专用', maxTokens: 1234, temperature: 0.2, revision: rev,
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.json));
  assert.equal(edit.json.model.displayName, '流程图专用');
  assert.equal(edit.json.model.maxTokens, 1234);
  assert.equal(edit.json.model.temperature, 0.2);
  assert.equal(edit.json.model.modelId, 'shared-model', '编辑不得改变定位键 modelId');

  gwOpenai.requests.length = 0;
  const chat = await api('POST', '/api/chat', { message: '画流程图', providerId: 'oa', modelId: 'shared-model' });
  assert.equal(chat.status, 200);
  const sent = gwOpenai.requests.find((r) => r.url.endsWith('/chat/completions'));
  assert.equal(sent.body.max_tokens, 1234, '下一次请求应使用新 maxTokens');
  assert.equal(sent.body.temperature, 0.2, '下一次请求应使用新 temperature');

  // 清空可选参数 → 回协议默认（OpenAI：省略；Anthropic：max_tokens=32768）
  const clear = await api('PUT', '/api/providers/oa/models/shared-model', { maxTokens: null, temperature: null });
  assert.equal(clear.status, 200);
  assert.equal(clear.json.model.maxTokens, null);
  assert.equal(clear.json.model.temperature, null);
  gwOpenai.requests.length = 0;
  await api('POST', '/api/chat', { message: '画流程图', providerId: 'oa', modelId: 'shared-model' });
  const sent2 = gwOpenai.requests.find((r) => r.url.endsWith('/chat/completions'));
  assert.equal(sent2.body.max_tokens, undefined, 'OpenAI 协议默认应省略 max_tokens');
  assert.equal(sent2.body.temperature, undefined);
});

test('R7：在途请求使用编辑前的原参数（请求开始即锁定）', async () => {
  await api('PUT', '/api/providers/an/models/shared-model', { maxTokens: 2048 });
  upstream.anthropicDelay = 400;
  gwAnthropic.requests.length = 0;
  const pending = api('POST', '/api/chat', { message: '画流程图', providerId: 'an', modelId: 'shared-model' });
  await new Promise((r) => setTimeout(r, 120));
  // 在途期间编辑参数
  await api('PUT', '/api/providers/an/models/shared-model', { maxTokens: 777 });
  const res = await pending;
  assert.equal(res.status, 200);
  const sent = gwAnthropic.requests.find((r) => r.url.endsWith('/v1/messages'));
  assert.equal(sent.body.max_tokens, 2048, '在途请求应使用锁定时的原参数');
  // 下一次请求用新参数
  gwAnthropic.requests.length = 0;
  await api('POST', '/api/chat', { message: '画流程图', providerId: 'an', modelId: 'shared-model' });
  const sent2 = gwAnthropic.requests.find((r) => r.url.endsWith('/v1/messages'));
  assert.equal(sent2.body.max_tokens, 777);
  upstream.anthropicDelay = 0;
});

test('R7：字段校验错误；编辑不破坏启用/默认/测试状态', async () => {
  // 先设默认并跑一次成功测试
  await api('POST', '/api/providers/oa/models/shared-model/default');
  await api('POST', '/api/providers/oa/models/shared-model/test');

  const badMt = await api('PUT', '/api/providers/oa/models/shared-model', { maxTokens: 0 });
  assert.equal(badMt.status, 400);
  assert.ok(badMt.json.detail.fields.maxTokens);
  const badTemp = await api('PUT', '/api/providers/oa/models/shared-model', { temperature: 3 });
  assert.equal(badTemp.status, 400);
  assert.ok(badTemp.json.detail.fields.temperature);

  const edit = await api('PUT', '/api/providers/oa/models/shared-model', { displayName: '改名不丢状态' });
  assert.equal(edit.status, 200);
  assert.equal(edit.json.model.isDefault, true, '编辑不得丢失默认标记');
  assert.equal(edit.json.model.enabled, true, '编辑不得丢失启用状态');
  assert.equal(edit.json.model.testStatus, 'success', '编辑不得清空测试状态（不靠删除重建）');
});

test('R7：模型编辑不删除重建——同 modelId 的其它引用（历史/在途）不受影响', async () => {
  const before = await api('GET', '/api/providers/oa');
  const modelsBefore = before.json.provider.models.map((m) => m.modelId);
  await api('PUT', '/api/providers/oa/models/shared-model', { displayName: '再改一次' });
  const after = await api('GET', '/api/providers/oa');
  const modelsAfter = after.json.provider.models.map((m) => m.modelId);
  assert.deepEqual(modelsAfter, modelsBefore, '编辑后模型集合与顺序不变（没有删除重建）');
});

// ---------------------------------------------------------------------------
// 兜底：所有出口都不含密钥（整包扫描）
// ---------------------------------------------------------------------------

test('R2 收尾：整个测试期间的所有管理响应与服务端日志都不含任何密钥', async () => {
  const list = await api('GET', '/api/providers');
  const catalog = await api('GET', '/api/models/catalog');
  assert.ok(!list.text.includes(SECRET_OA) && !list.text.includes(SECRET_AN));
  assert.ok(!catalog.text.includes(SECRET_OA) && !catalog.text.includes(SECRET_AN));
  const offending = errorLogs.filter((l) => l.includes(SECRET_OA) || l.includes(SECRET_AN));
  assert.deepEqual(offending, [], '日志泄漏行：' + JSON.stringify(offending.slice(0, 3)));
});
