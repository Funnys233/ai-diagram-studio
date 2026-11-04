// 协议适配层单元测试：endpoint 拼接、认证头、消息映射、参数裁剪、响应提取、错误分类
const test = require('node:test');
const assert = require('node:assert/strict');
const openai = require('../../lib/adapters/openai-chat.js');
const anthropic = require('../../lib/adapters/anthropic-messages.js');
const { classifyHttpError, ModelCallError } = require('../../lib/adapters/common.js');

const MSGS = [
  { role: 'system', content: '你是图表引擎' },
  { role: 'user', content: '画一个流程图' },
  { role: 'assistant', content: '好的' },
  { role: 'user', content: '加一步' },
];

// ---------- OpenAI Chat Completions ----------

test('OpenAI：endpoint 拼接兼容尾斜杠与已有 /v1，不产生 /v1/v1', () => {
  assert.equal(openai.chatEndpoint({ baseUrl: 'https://api.deepseek.com' }), 'https://api.deepseek.com/chat/completions');
  assert.equal(openai.chatEndpoint({ baseUrl: 'https://api.deepseek.com/' }), 'https://api.deepseek.com/chat/completions');
  assert.equal(openai.chatEndpoint({ baseUrl: 'https://gw.example.com/v1/' }), 'https://gw.example.com/v1/chat/completions');
  assert.equal(openai.modelsEndpoint({ baseUrl: 'https://gw.example.com/v1' }), 'https://gw.example.com/v1/models');
});

test('OpenAI：Bearer 认证与无密钥本地服务', () => {
  const withKey = openai.buildChatRequest({ baseUrl: 'https://x.com/v1', apiKey: 'sk-1' }, { modelId: 'm' }, MSGS);
  assert.equal(withKey.headers.Authorization, 'Bearer sk-1');
  const noKey = openai.buildChatRequest({ baseUrl: 'http://127.0.0.1:11434', apiKey: '' }, { modelId: 'm' }, MSGS);
  assert.equal(noKey.headers.Authorization, undefined);
});

test('OpenAI：消息透传，仅发送已配置参数（无固定 max_tokens）', () => {
  const bare = openai.buildChatRequest({ baseUrl: 'https://x.com', apiKey: '' }, { modelId: 'm' }, MSGS);
  assert.deepEqual(bare.body.messages, MSGS);
  assert.equal(bare.body.model, 'm');
  assert.equal('max_tokens' in bare.body, false);
  assert.equal('temperature' in bare.body, false);

  const full = openai.buildChatRequest(
    { baseUrl: 'https://x.com', apiKey: '' },
    { modelId: 'm', maxTokens: 8192, temperature: 0.3 },
    MSGS,
  );
  assert.equal(full.body.max_tokens, 8192);
  assert.equal(full.body.temperature, 0.3);
});

test('OpenAI：响应提取（文本/实际模型/用量/结束原因）', () => {
  const r = openai.parseChatResponse(200, {
    model: 'm-real',
    choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
    usage: { total_tokens: 12 },
  }, 'P');
  assert.equal(r.text, 'hello');
  assert.equal(r.model, 'm-real');
  assert.equal(r.usage.total_tokens, 12);
  assert.equal(r.finishReason, 'stop');
  // 缺少用量不算失败
  const noUsage = openai.parseChatResponse(200, { choices: [{ message: { content: 'x' } }] }, 'P');
  assert.equal(noUsage.usage, null);
});

test('OpenAI：截断与空输出', () => {
  assert.throws(() => openai.parseChatResponse(200, { choices: [{ message: { content: '' }, finish_reason: 'length' }] }, 'P'),
    (e) => e instanceof ModelCallError && e.code === 'model-truncated');
  assert.throws(() => openai.parseChatResponse(200, { choices: [{ message: {} }] }, 'P'),
    (e) => e.code === 'empty-output');
});

// ---------- Anthropic Messages ----------

test('Anthropic：endpoint 自动补 /v1 且不重复', () => {
  assert.equal(anthropic.messagesEndpoint({ baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.messagesEndpoint({ baseUrl: 'https://api.anthropic.com/' }), 'https://api.anthropic.com/v1/messages');
  assert.equal(anthropic.messagesEndpoint({ baseUrl: 'https://gw.example.com/v1' }), 'https://gw.example.com/v1/messages');
  assert.equal(anthropic.modelsEndpoint({ baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models');
});

test('Anthropic：认证头与 system 抽取、消息映射', () => {
  const req = anthropic.buildChatRequest({ baseUrl: 'https://api.anthropic.com', apiKey: 'ak-1' }, { modelId: 'claude-x' }, MSGS);
  assert.equal(req.headers['x-api-key'], 'ak-1');
  assert.equal(req.headers['anthropic-version'], anthropic.ANTHROPIC_VERSION);
  assert.equal(req.headers.Authorization, undefined);
  assert.equal(req.body.system, '你是图表引擎');
  assert.deepEqual(req.body.messages, [
    { role: 'user', content: '画一个流程图' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '加一步' },
  ]);
  // max_tokens 是必填：未配置时用绘图默认；配置后按配置
  assert.equal(req.body.max_tokens, 32768);
  const custom = anthropic.buildChatRequest({ baseUrl: 'https://a.com', apiKey: '' }, { modelId: 'c', maxTokens: 9000, temperature: 0.5 }, MSGS);
  assert.equal(custom.body.max_tokens, 9000);
  assert.equal(custom.body.temperature, 0.5);
});

test('Anthropic：响应提取（content 块拼接）与 max_tokens 截断', () => {
  const r = anthropic.parseChatResponse(200, {
    model: 'claude-real',
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5 },
  }, 'P');
  assert.equal(r.text, 'ab');
  assert.equal(r.model, 'claude-real');
  assert.equal(r.finishReason, 'end_turn');
  assert.throws(() => anthropic.parseChatResponse(200, { content: [], stop_reason: 'max_tokens' }, 'P'),
    (e) => e.code === 'model-truncated');
  assert.throws(() => anthropic.parseChatResponse(200, { content: [{ type: 'text', text: '' }] }, 'P'),
    (e) => e.code === 'empty-output');
});

// ---------- 错误分类 ----------

test('错误分类：认证/模型不存在/限流/服务端/协议不匹配', () => {
  assert.equal(classifyHttpError(401, { error: { message: 'bad key' } }, 'P').code, 'auth-failed');
  assert.equal(classifyHttpError(403, {}, 'P').code, 'auth-failed');
  assert.equal(classifyHttpError(404, {}, 'P').code, 'model-not-found');
  assert.equal(classifyHttpError(429, {}, 'P').code, 'rate-limited');
  assert.equal(classifyHttpError(400, {}, 'P').code, 'protocol-mismatch');
  assert.equal(classifyHttpError(500, {}, 'P').code, 'server-error');
  assert.equal(classifyHttpError(503, {}, 'P').code, 'server-error');
});

test('两种协议的请求 JSON 结构不同（绝不共用一份）', () => {
  const o = openai.buildChatRequest({ baseUrl: 'https://x.com', apiKey: 'k' }, { modelId: 'm' }, MSGS).body;
  const a = anthropic.buildChatRequest({ baseUrl: 'https://x.com', apiKey: 'k' }, { modelId: 'm' }, MSGS).body;
  assert.equal('system' in o, false);
  assert.equal('system' in a, true);
  assert.equal('max_tokens' in o, false);
  assert.equal(a.max_tokens, 32768);
});
