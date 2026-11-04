// ChatGPT plan usage has a narrower contract than the general Responses API.
const { ModelCallError } = require('./common');

function responseError(status, data) {
  const code = data?.error?.code || data?.code;
  if (/subscription_sharing_usage_(limit_exceeded|unavailable)/.test(code || '')) return new ModelCallError('chatgpt-usage-limit', 'ChatGPT 订阅额度暂不可用，请在 ChatGPT 设置中查看用量，或手动选择其他模型。');
  if (code === 'subscription_sharing_user_not_eligible') return new ModelCallError('chatgpt-not-eligible', '当前 ChatGPT 账号、工作区或地区不支持订阅额度授权。');
  if (status === 401) return new ModelCallError('chatgpt-login-required', 'ChatGPT 授权已失效，请重新连接。');
  if (status === 403) return new ModelCallError('chatgpt-forbidden', 'ChatGPT 拒绝了访问，请检查账号资格、工作区权限和所在地区。');
  if (status === 429) return new ModelCallError('chatgpt-rate-limited', 'ChatGPT 请求过于频繁或额度不足，请稍后重试。');
  return new ModelCallError('chatgpt-response-error', `ChatGPT 请求未完成（HTTP ${status}），请检查连接或稍后重试。`);
}

function buildChatRequest(provider, model, messages) {
  const instructions = messages.filter(m => m.role === 'system' || m.role === 'developer').map(m => m.content).join('\n\n');
  const input = messages.filter(m => m.role !== 'system' && m.role !== 'developer').map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map(part => {
      if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url.url };
      return { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: part.text || '' };
    }),
  }));
  const body = { model: model.modelId, input, store: false, stream: true };
  if (instructions) body.instructions = instructions;
  if (model.thinkingMode === 'responses-off' && model.supportsNone) body.reasoning = { effort: 'none' };
  else if (model.reasoningEffort) body.reasoning = { effort: model.reasoningEffort };
  else if (model.thinkingMode === 'responses-on' && model.defaultEffort) body.reasoning = { effort: model.defaultEffort };
  return { url: 'https://api.openai.com/v1/responses', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` }, body };
}

function parseChatResponse(status, data) {
  if (status !== 200 || data?.error) throw responseError(status, data);
  if (data?.status !== 'completed') throw new ModelCallError('stream-incomplete', 'ChatGPT 回复未完整结束，图表保持不变，请重试。');
  const text = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join('');
  if (!text) throw new ModelCallError('empty-output', 'ChatGPT 未返回可用的文本。');
  return { text, model: data.model || null, usage: data.usage || null, finishReason: 'stop' };
}

module.exports = { protocol: 'chatgpt-responses', buildChatRequest, parseChatResponse, responseError };
