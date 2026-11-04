const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const openai = require('../../lib/adapters/openai-chat');
const anthropic = require('../../lib/adapters/anthropic-messages');
const { ProviderStore } = require('../../lib/provider-store');
const { resolveAndLock } = require('../../lib/model-service');
const Capabilities = require('../../lib/model-capabilities');
const provider = { providerId: 'p', name: 'P', baseUrl: 'https://example.com/v1', protocol: 'openai-chat-completions' };

test('思考参数按模型选择发送，默认不向未知供应商添加参数', () => {
  const build = thinkingMode => openai.buildChatRequest(provider, { modelId: 'm', thinkingMode }, []).body;
  assert.equal('thinking' in build('default'), false);
  assert.equal('enable_thinking' in build('default'), false);
  assert.deepEqual(build('deepseek-off').thinking, { type: 'disabled' });
  assert.equal('enable_thinking' in build('deepseek-off'), false);
  assert.equal(build('enable-thinking-off').enable_thinking, false);
  assert.equal('thinking' in build('enable-thinking-off'), false);
  assert.throws(() => anthropic.buildChatRequest(provider, { thinkingMode: 'deepseek-off' }, []), e => e.code === 'protocol-mismatch');
});

test('思考参数持久化、拒绝非法值，在途快照保留修改前参数', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-thinking-'));
  try {
    const filePath = path.join(dir, 'providers.json');
    const store = new ProviderStore({ filePath, env: {} }).load();
    await store.createProvider(provider);
    await store.addModel('p', { modelId: 'm', thinkingMode: 'deepseek-off', maxTokens: 8192 });
    const lock = resolveAndLock(store, 'p', 'm').lock;
    await store.updateModel('p', 'm', { thinkingMode: 'deepseek-on' });
    assert.equal(lock.model.thinkingMode, 'deepseek-off');
    assert.equal(lock.model.maxTokens, 8192);
    assert.equal(new ProviderStore({ filePath, env: {} }).load().list()[0].models[0].thinkingMode, 'deepseek-on');
    await assert.rejects(store.updateModel('p', 'm', { thinkingMode: 'arbitrary' }), e => Boolean(e.fields.thinkingMode));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('截断响应即使包含部分 XML 也不能应用；保留结束原因和用量', () => {
  const usage = { completion_tokens: 8192 };
  assert.throws(() => openai.parseChatResponse(200, {
    choices: [{ message: { content: '<mxGraphModel>' }, finish_reason: 'length' }], usage,
  }, 'P'), e => e.code === 'model-truncated' && e.extra.finishReason === 'length' && e.extra.usage.completion_tokens === 8192);
  assert.throws(() => anthropic.parseChatResponse(200, {
    content: [{ type: 'text', text: '<mxGraphModel>' }], stop_reason: 'max_tokens', usage,
  }, 'P'), e => e.code === 'model-truncated');
});

test('Qwen3.8 使用官方强度枚举；未知模型不推测，手动配置优先', () => {
  const model = { modelId: 'Qwen/Qwen3.8-27B', reasoningEffort: 'medium' };
  assert.deepEqual(Capabilities.resolve(provider, model).reasoningLevels, ['low', 'medium', 'xhigh']);
  assert.equal(openai.buildChatRequest(provider, model, []).body.reasoning_effort, 'medium');
  assert.throws(() => openai.buildChatRequest(provider, { ...model, reasoningEffort: 'high' }, []), e => e.code === 'protocol-mismatch');
  assert.equal('reasoning_effort' in openai.buildChatRequest(provider, { ...model, thinkingMode: 'enable-thinking-off' }, []).body, false);
  assert.equal('reasoning_effort' in openai.buildChatRequest(provider, { modelId: model.modelId }, []).body, false);
  assert.deepEqual(Capabilities.resolve(provider, { modelId: 'unknown' }).reasoningLevels, []);
  assert.deepEqual(Capabilities.resolve(provider, { ...model, capabilityProfile: 'custom', reasoningLevels: ['low'] }).reasoningLevels, ['low']);
});

test('强度保存与快照隔离，非法组合不能写盘；元数据缺枚举时不自动猜测', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-effort-'));
  try {
    const filePath = path.join(dir, 'providers.json');
    const store = new ProviderStore({ filePath, env: {} }).load();
    await store.createProvider(provider);
    await store.addModel('p', { modelId: 'Qwen/Qwen3.8-27B', reasoningEffort: 'low' });
    const lock = resolveAndLock(store, 'p', 'Qwen/Qwen3.8-27B').lock;
    await store.updateModel('p', 'Qwen/Qwen3.8-27B', { reasoningEffort: 'medium' });
    assert.equal(lock.model.reasoningEffort, 'low');
    assert.deepEqual(lock.model.capabilities.reasoningLevels, ['low', 'medium', 'xhigh']);
    assert.equal(new ProviderStore({ filePath, env: {} }).load().list()[0].models[0].reasoningEffort, 'medium');
    const revision = store.getRevision();
    await assert.rejects(store.updateModel('p', 'Qwen/Qwen3.8-27B', { reasoningEffort: 'high' }), e => Boolean(e.fields.reasoningEffort));
    await assert.rejects(store.updateModel('p', 'Qwen/Qwen3.8-27B', { capabilityProfile: 'none' }), e => Boolean(e.fields.reasoningEffort));
    assert.equal(store.getRevision(), revision);
    await store.updateModel('p', 'Qwen/Qwen3.8-27B', { capabilityProfile: 'none', reasoningEffort: null });
    const [detail] = Capabilities.remoteDetails([{ id: 'm', supported_parameters: ['reasoning_effort'], apiKey: 'should-not-leak' }]);
    assert.deepEqual(Capabilities.resolve(provider, detail), { reasoningLevels: [], source: 'remote', defaultEffort: null });
    assert.equal(JSON.stringify(detail).includes('should-not-leak'), false);
    await store.addModel('p', { modelId: 'custom', capabilityProfile: 'custom', reasoningLevels: ['low', 'high'], reasoningEffort: 'high' });
    const custom = store.list()[0].models.find(m => m.modelId === 'custom');
    assert.equal(custom.capabilities.source, 'manual');
    assert.equal(resolveAndLock(store, 'p', 'custom').lock.model.reasoningEffort, 'high');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
