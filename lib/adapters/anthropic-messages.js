// Anthropic Messages 协议适配
// 参考：https://docs.anthropic.com/en/api/messages
//
// 与 OpenAI Chat Completions 的请求结构完全不同，这里独立实现：
//   - endpoint：{base}/v1/messages（base 已含 /v1 时不重复拼接）
//   - 认证：x-api-key + anthropic-version（不是 Bearer）
//   - system 消息抽成顶层 system 参数；user/assistant 进 messages 数组
//   - max_tokens 是该 API 的必填项：模型配置未给时使用绘图默认 32768，
//     配置了的按配置发送（绝不全站共享一个固定值）
const { ModelCallError, classifyHttpError, joinUrl } = require('./common.js');

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 32768;

function authHeaders(provider) {
  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
  return headers;
}

function withV1(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? base : base + '/v1';
}

function messagesEndpoint(provider) {
  return joinUrl(withV1(provider.baseUrl), 'messages');
}

function modelsEndpoint(provider) {
  return joinUrl(withV1(provider.baseUrl), 'models');
}

/**
 * @param {Array<{role:string, content:string}>} messages 完整消息（含 system）
 */
function buildChatRequest(provider, model, messages) {
  if (model.reasoningEffort) throw new ModelCallError('protocol-mismatch', 'Anthropic 协议暂未接入思考强度参数，请恢复供应商默认');
  if (model.thinkingMode && model.thinkingMode !== 'default') {
    throw new ModelCallError('protocol-mismatch', '当前思考参数用于 OpenAI 兼容接口，请将 Anthropic 模型的思考模式设为供应商默认');
  }
  const systemParts = [];
  const chat = [];
  for (const m of messages) {
    if (m.role === 'system') { systemParts.push(m.content); continue; }
    if (m.role === 'user' || m.role === 'assistant') {
      const content=Array.isArray(m.content)?m.content.map(part=>{
        if(part.type==='text')return {type:'text',text:part.text};
        const image=require('../vision-check').validateImage(part.image_url?.url);
        return {type:'image',source:{type:'base64',media_type:image.mime,data:image.base64}};
      }):m.content;
      chat.push({role:m.role,content});
    }
  }
  const body = {
    model: model.modelId,
    messages: chat,
    max_tokens: Number.isInteger(model.maxTokens) ? model.maxTokens : DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length > 0) body.system = systemParts.join('\n\n');
  if (typeof model.temperature === 'number') body.temperature = model.temperature;
  return { url: messagesEndpoint(provider), headers: authHeaders(provider), body };
}

function buildModelsRequest(provider) {
  return { url: modelsEndpoint(provider), headers: authHeaders(provider) };
}

/**
 * @returns {{ text: string, model: string, usage: object|null, finishReason: string|null }}
 */
function parseChatResponse(status, data, providerName) {
  if (status !== 200) throw classifyHttpError(status, data, providerName);
  if (!data || !Array.isArray(data.content)) {
    throw new ModelCallError('protocol-mismatch', `${providerName} 的响应缺少 content 数组（可能不是 Anthropic Messages 协议）`);
  }
  const texts = [];
  for (const block of data.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  const text = texts.join('');
  const finishReason = typeof data.stop_reason === 'string' ? data.stop_reason : null;
  const usage = typeof data.usage === 'object' ? data.usage : null;
  if (finishReason === 'max_tokens') {
    throw new ModelCallError('model-truncated', '模型输出预算已用尽，请调整输出长度后重试', { finishReason, usage });
  }
  if (!text) {
    throw new ModelCallError('empty-output', '模型返回了空文本（content 中没有 text 块），无法解析图表');
  }
  return { text, model: data.model || null, usage, finishReason };
}

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
  protocol: 'anthropic-messages',
  buildChatRequest,
  buildModelsRequest,
  parseChatResponse,
  parseModelsResponse,
  messagesEndpoint,
  modelsEndpoint,
  ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
};
