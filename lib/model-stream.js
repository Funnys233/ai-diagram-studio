const { ModelCallError } = require('./adapters/common');

// Only assembled answer text is retained. Reasoning deltas are observed as state,
// never included in progress payloads, logs, history or the final diagram.
function createModelStream(protocol, adapter, providerName, onProgress, maxChars = 210000, onText) {
  let text = '', model = null, usage = null, finishReason = null, done = false;
  let generationObserved = false;
  const meaningful = value => value != null && value !== '' && value !== false
    && (typeof value !== 'object' || Object.values(value).some(meaningful));
  const consumed = value => typeof value === 'number' ? value > 0
    : value && typeof value === 'object' && Object.values(value).some(consumed);
  function append(value) {
    if (typeof value !== 'string' || !value) return;
    if (text.length + value.length > maxChars) throw new ModelCallError('output-too-large', '模型输出超过大小限制，画布保持不变');
    text += value;
    onText?.(value);
    onProgress?.({ phase: 'generating', chars: text.length });
  }
  function thinking(value) { if (typeof value === 'string' && value) onProgress?.({ phase: 'thinking', chars: text.length }); }
  return {
    accept(event) {
      if (event.data === '[DONE]') {
        if (protocol === 'openai-chat-completions') done = true;
        return;
      }
      let data;
      try { data = JSON.parse(event.data); }
      catch { throw new ModelCallError('protocol-mismatch', '模型返回了无法解析的流式事件'); }
      if (protocol === 'chatgpt-responses') usage = data.response?.usage || data.usage || usage;
      else if (protocol === 'openai-chat-completions') usage = data.usage || usage;
      if (protocol === 'openai-chat-completions') {
        // Empty role/heartbeat events are not output. Reasoning, tool calls and
        // unfamiliar nonempty deltas count even when no answer text is visible.
        generationObserved ||= Boolean(consumed(usage) || data.choices?.some(choice =>
          Boolean(choice.finish_reason) || meaningful(choice.message) || Object.entries(choice.delta || {}).some(([key, value]) => key !== 'role' && meaningful(value))));
      }
      if (data.error || data.type === 'error') {
        if (protocol === 'chatgpt-responses') throw adapter.responseError(400, data);
        if (protocol === 'openai-chat-completions'
          && /^The service is busy\.\s*Please retry later\.?$/i.test(String(data.error?.message || '').trim())) {
          throw new ModelCallError('upstream-busy', `${providerName} 上游服务繁忙，请稍后重试或切换其他模型`,
            { upstreamRejectedBeforeGeneration: !generationObserved });
        }
        throw new ModelCallError('server-error', `${providerName} 流式请求失败：${String(data.error?.message || data.error?.type || '上游错误').slice(0, 200)}`);
      }
      if (done) throw new ModelCallError('protocol-mismatch', '模型在流结束后继续返回内容');
      if (protocol === 'chatgpt-responses') {
        const type = data.type || event.event;
        if (type === 'response.failed') throw adapter.responseError(400, data.response);
        if (type === 'response.incomplete') throw new ModelCallError('stream-incomplete', 'ChatGPT 回复未完整结束，画布保持不变，请重试');
        if (type === 'response.output_text.delta') append(data.delta);
        if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') thinking(data.delta);
        if (type === 'response.output_item.added' && data.item?.type === 'reasoning') onProgress?.({ phase: 'thinking', chars: text.length });
        if (type === 'response.created' || type === 'response.in_progress') onProgress?.({ phase: 'waiting' });
        if (type === 'response.completed') {
          if (data.response?.status !== 'completed' || data.response?.error) throw adapter.responseError(400, data.response);
          model = data.response.model || model; usage = data.response.usage || usage;
          done = true; finishReason = 'stop';
        }
      } else if (protocol === 'openai-chat-completions') {
        model = data.model || model;
        usage = data.usage || usage;
        const choice = data.choices?.find(c => c.index === 0 || c.index === undefined);
        if (!choice) return;
        thinking(choice.delta?.reasoning_content || choice.delta?.reasoning);
        append(choice.delta?.content);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      } else {
        switch (data.type) {
          case 'message_start': model = data.message?.model || model; usage = data.message?.usage || usage; break;
          case 'content_block_start':
            if (data.content_block?.type === 'text') append(data.content_block.text);
            break;
          case 'content_block_delta':
            if (data.delta?.type === 'text_delta') append(data.delta.text);
            if (data.delta?.type === 'thinking_delta') thinking(data.delta.thinking);
            break;
          case 'message_delta':
            finishReason = data.delta?.stop_reason || finishReason;
            usage = { ...usage, ...data.usage }; break;
          case 'message_stop': done = true; break;
        }
      }
    },
    isComplete() { return done; },
    getUsage() { return usage; },
    finish() {
      // A seemingly valid XML prefix is never enough after a broken connection.
      if (!done || !finishReason) throw new ModelCallError('stream-incomplete', '模型流式响应未完整结束，画布保持不变，请重试');
      const data = protocol === 'chatgpt-responses'
        ? { model, usage, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
        : protocol === 'openai-chat-completions'
        ? { model, usage, choices: [{ message: { content: text }, finish_reason: finishReason }] }
        : { model, usage, content: [{ type: 'text', text }], stop_reason: finishReason };
      return adapter.parseChatResponse(200, data, providerName);
    },
  };
}
module.exports = { createModelStream };
