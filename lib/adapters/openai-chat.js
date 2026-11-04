// OpenAI Chat Completions 协议适配
// 参考：https://platform.openai.com/docs/api-reference/chat/create
//
// 职责：endpoint 拼接、Bearer 认证头、消息透传、参数裁剪（仅发送模型配置的参数）、
// 输出文本/实际模型/用量/结束原因提取、错误分类。
const { ModelCallError, classifyHttpError, joinUrl } = require('./common.js');
const Capabilities = require('../model-capabilities.js');

function authHeaders(provider) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers; // 无密钥本地服务：不带认证头（authKind=none 已在配置层标明）
}

/** baseUrl 是 API 基础前缀：已含 /v1 则直接用，不含也不强行补（DeepSeek 等即根路径） */
function chatEndpoint(provider) {
  return joinUrl(provider.baseUrl, 'chat/completions');
}

function modelsEndpoint(provider) {
  return joinUrl(provider.baseUrl, 'models');
}

/**
 * @param {object} provider 原始提供商（含密钥，绝不可日志/外发）
 * @param {object} model 模型配置（maxTokens/temperature 为 null 时省略）
 * @param {Array<{role:string, content:string}>} messages
 */
function buildChatRequest(provider, model, messages) {
  const body = { model: model.modelId, messages };
  if (Number.isInteger(model.maxTokens)) body.max_tokens = model.maxTokens;
  if (typeof model.temperature === 'number') body.temperature = model.temperature;
  // 供应商参数只在模型明确选择时发送，SDK extra_body 对应的是 HTTP 顶层字段。
  if (model.thinkingMode === 'deepseek-off' || model.thinkingMode === 'deepseek-on') {
    body.thinking = { type: model.thinkingMode === 'deepseek-off' ? 'disabled' : 'enabled' };
  }
  if (model.thinkingMode === 'enable-thinking-off' || model.thinkingMode === 'enable-thinking-on') {
    body.enable_thinking = model.thinkingMode === 'enable-thinking-on';
  }
  if (model.reasoningEffort) {
    const caps = model.capabilities || Capabilities.resolve({ ...provider, protocol: 'openai-chat-completions' }, model);
    if (!caps.reasoningLevels.includes(model.reasoningEffort)) throw new ModelCallError('protocol-mismatch', '当前模型不支持配置的思考强度，请在模型设置中检查能力配置');
    if (!model.thinkingMode?.endsWith('-off')) body.reasoning_effort = model.reasoningEffort;
  }
  return { url: chatEndpoint(provider), headers: authHeaders(provider), body };
}

function buildModelsRequest(provider) {
  return { url: modelsEndpoint(provider), headers: authHeaders(provider) };
}

/**
 * @returns {{ text: string, model: string, usage: object|null, finishReason: string|null }}
 * @throws {ModelCallError} 按状态分类的错误（认证/模型不存在/限流/协议不匹配/服务端错误）
 */
function parseChatResponse(status, data, providerName) {
  if (status !== 200) throw classifyHttpError(status, data, providerName);
  const choice = data && data.choices && data.choices[0];
  const message = choice && choice.message ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : '';
  const finishReason = choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  const usage = data && typeof data.usage === 'object' ? data.usage : null;
  if (finishReason === 'length') {
    throw new ModelCallError('model-truncated', '模型输出被截断，可能达到输出或上下文上限；请提高模型设置中的输出上限，或拆分图表后重试', { finishReason, usage });
  }
  if (!text) {
    throw new ModelCallError('empty-output', '模型返回了空文本（无 choices 内容），无法解析图表');
  }
  return { text, model: data.model || null, usage, finishReason };
}

/** 解析 GET /models 响应；结构非法时抛 protocol-mismatch（不能解释为提供商不可用） */
function parseModelsResponse(status, data, providerName) {
  if (status !== 200) throw classifyHttpError(status, data, providerName);
  if (!data || !Array.isArray(data.data)) {
    throw new ModelCallError('protocol-mismatch', `${providerName} 的模型列表响应结构不合法（缺少 data 数组）`);
  }
  const ids = [];
  for (const item of data.data) {
    if (item && typeof item.id === 'string' && item.id) ids.push(item.id);
  }
  return ids;
}

module.exports = {
  protocol: 'openai-chat-completions',
  buildChatRequest,
  buildModelsRequest,
  parseChatResponse,
  parseModelsResponse,
  chatEndpoint,
  modelsEndpoint,
};
