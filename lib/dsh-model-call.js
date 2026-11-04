'use strict';
// Tool-aware inference for the isolated DSH gateway. This intentionally leaves
// the drawing/chat text parsers unchanged.
const OpenAIChat = require('./adapters/openai-chat');
const Responses = require('./adapters/chatgpt-responses');
const { ModelCallError } = require('./adapters/common');
const { postJsonWithCaFallback } = require('./http-transport');
const { pinnedOptions } = require('./egress-policy');
const { TOOLS } = require('./dsh-model-gateway');
const NS = 'diagram_files';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validCount = value => Number.isSafeInteger(value) && value >= 0;
function usageFrom(value) {
  if (!object(value)) return null;
  const input = value.prompt_tokens ?? value.input_tokens, output = value.completion_tokens ?? value.output_tokens;
  if (!validCount(input) || !validCount(output)) return null;
  const result = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  const cached = value.prompt_tokens_details?.cached_tokens ?? value.input_tokens_details?.cached_tokens ?? value.prompt_cache_hit_tokens;
  const reasoning = value.completion_tokens_details?.reasoning_tokens ?? value.output_tokens_details?.reasoning_tokens;
  if (validCount(cached) && cached <= input) result.prompt_tokens_details = { cached_tokens: cached };
  if (validCount(reasoning) && reasoning <= output) result.completion_tokens_details = { reasoning_tokens: reasoning };
  return result;
}
function responsesBody(lock, body) {
  const input = [], instructions = [];
  for (const message of body.messages) {
    if (message.role === 'system' || message.role === 'developer') { instructions.push(message.content); continue; }
    if (message.role === 'tool') { input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content }); continue; }
    if (message.content) input.push({ role: message.role, content: message.content });
    for (const call of message.tool_calls || []) input.push({ type: 'function_call', namespace: NS, name: call.function.name, call_id: call.id, arguments: call.function.arguments });
  }
  const request = { model: lock.model.modelId, input, store: false, stream: true };
  if (instructions.length) request.instructions = instructions.join('\n\n');
  if (body.tools?.length) request.tools = [{ type: 'namespace', name: NS, description: 'Controlled files in the user task.', tools: body.tools.map(tool => ({ type: 'function', ...tool.function })) }];
  if (['auto', 'none', 'required'].includes(body.tool_choice)) request.tool_choice = body.tool_choice;
  // A forced tool stays a namespaced function; callers never select hosted
  // computer, shell, MCP or other tools through this endpoint.
  else if (body.tool_choice?.type === 'function') request.tool_choice = { type: 'function', namespace: NS, name: body.tool_choice.function.name };
  if (typeof body.parallel_tool_calls === 'boolean') request.parallel_tool_calls = body.parallel_tool_calls;
  const model = lock.model;
  if (model.thinkingMode === 'responses-off' && model.supportsNone) request.reasoning = { effort: 'none' };
  else if (model.reasoningEffort) request.reasoning = { effort: model.reasoningEffort };
  else if (model.thinkingMode === 'responses-on' && model.defaultEffort) request.reasoning = { effort: model.defaultEffort };
  return request;
}
function streamState(protocol, onChunk, modelId) {
  let done = false, finishReason = null, usage = null, text = '', emittedBytes = 0, generated = false;
  const calls = new Map(), outputIndexes = new Map();
  function emit(delta, extra) {
    const chunk = { choices: [{ index: 0, delta, finish_reason: null }], ...extra };
    emittedBytes += Buffer.byteLength(JSON.stringify(chunk));
    if (emittedBytes > 6 * 1024 * 1024) throw new ModelCallError('output-too-large', '模型输出超过大小限制。');
    onChunk?.(chunk);
  }
  function append(value) {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string' || Buffer.byteLength(text) + Buffer.byteLength(value) > 1024 * 1024) throw new ModelCallError('output-too-large', '模型正文超过大小限制。');
    generated = true; text += value; emit({ content: value });
  }
  function ensureCall(key, item, outputIndex) {
    if (calls.has(key)) return calls.get(key);
    if (!TOOLS.has(item.name) || item.namespace && item.namespace !== NS || typeof item.call_id !== 'string' || !item.call_id || item.call_id.length > 300 || calls.size >= 32) throw new ModelCallError('protocol-mismatch', '模型返回了不支持的工具调用。');
    const call = { index: calls.size, id: item.call_id, name: item.name, arguments: '' }; calls.set(key, call);
    if (Number.isInteger(outputIndex)) outputIndexes.set(outputIndex, key);
    generated = true;
    emit({ tool_calls: [{ index: call.index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] });
    return call;
  }
  function appendArguments(call, delta) {
    if (typeof delta !== 'string' || Buffer.byteLength(call.arguments) + Buffer.byteLength(delta) > 512 * 1024) throw new ModelCallError('output-too-large', '模型工具参数超过大小限制。');
    if (delta) { call.arguments += delta; emit({ tool_calls: [{ index: call.index, function: { arguments: delta } }] }); }
  }
  function finishCall(call, item) {
    if (typeof item.arguments !== 'string') throw new ModelCallError('protocol-mismatch', '模型工具参数无效。');
    if (!call.arguments) appendArguments(call, item.arguments);
    else if (call.arguments !== item.arguments) throw new ModelCallError('stream-incomplete', '模型工具调用未完整结束。');
  }
  return {
    accept(event) {
      if (event.data === '[DONE]') { if (protocol === OpenAIChat.protocol) done = true; return; }
      let data;
      try { data = JSON.parse(event.data); } catch { throw new ModelCallError('protocol-mismatch', '模型返回了无法解析的事件。'); }
      usage = usageFrom(protocol === 'chatgpt-responses' ? data.response?.usage || data.usage : data.usage) || usage;
      if (data.error || data.type === 'error') {
        if (protocol === 'chatgpt-responses') throw Responses.responseError(400, data);
        const busy = /^The service is busy\.\s*Please retry later\.?$/i.test(String(data.error?.message || '').trim());
        throw new ModelCallError(busy ? 'upstream-busy' : 'server-error', '模型流式请求未完成。', { usage, upstreamRejectedBeforeGeneration: busy && !generated });
      }
      if (done) throw new ModelCallError('protocol-mismatch', '模型在结束后继续返回内容。');
      if (protocol === OpenAIChat.protocol) {
        const choice = data.choices?.find(item => item.index === 0 || item.index === undefined);
        if (!choice) return;
        const delta = choice.delta || {};
        append(delta.content);
        if (Array.isArray(delta.tool_calls)) for (const item of delta.tool_calls) {
          if (!Number.isInteger(item.index) || item.index < 0 || item.index > 31) throw new ModelCallError('protocol-mismatch', '模型工具序号无效。');
          const key = String(item.index), call = calls.get(key) || { index: item.index, id: '', name: '', arguments: '' };
          if (!calls.has(key)) calls.set(key, call);
          if (item.id !== undefined) call.id += item.id;
          if (item.function?.name !== undefined) call.name += item.function.name;
          if (item.function?.arguments !== undefined) call.arguments += item.function.arguments;
          if (typeof call.id !== 'string' || call.id.length > 300 || call.name.length > 128 || Buffer.byteLength(call.arguments) > 512 * 1024) throw new ModelCallError('output-too-large', '模型工具调用超过大小限制。');
          generated = true; emit({ tool_calls: [item] });
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
        return;
      }
      const type = data.type || event.event;
      if (type === 'response.failed') throw Responses.responseError(400, data.response);
      if (type === 'response.incomplete') throw new ModelCallError('stream-incomplete', '模型未完整结束。');
      if (type === 'response.output_text.delta') append(data.delta);
      if (type === 'response.output_item.added' && data.item?.type === 'function_call') ensureCall(data.item.id || data.item.call_id, data.item, data.output_index);
      if (type === 'response.function_call_arguments.delta') {
        const call = calls.get(data.item_id || outputIndexes.get(data.output_index));
        if (!call) throw new ModelCallError('protocol-mismatch', '模型工具事件顺序无效。'); appendArguments(call, data.delta);
      }
      if (type === 'response.output_item.done' && data.item?.type === 'function_call') finishCall(ensureCall(data.item.id || data.item.call_id, data.item, data.output_index), data.item);
      if (type === 'response.completed') {
        if (data.response?.status !== 'completed' || data.response?.error) throw Responses.responseError(400, data.response);
        for (const item of data.response.output || []) {
          if (item.type === 'function_call') finishCall(ensureCall(item.id || item.call_id, item), item);
        }
        if (!text) {
          const finalText = (data.response.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join('');
          append(finalText);
        }
        finishReason = calls.size ? 'tool_calls' : 'stop'; done = true;
      }
    },
    complete() { return done; },
    usage() { return usage; },
    result() {
      if (!done || !['stop', 'tool_calls', 'length', 'content_filter'].includes(finishReason)) throw new ModelCallError('stream-incomplete', '模型流未完整结束。', { usage });
      const toolCalls = [...calls.values()].sort((a, b) => a.index - b.index);
      if (toolCalls.some(call => !call.id || !TOOLS.has(call.name)) || new Set(toolCalls.map(call => call.id)).size !== toolCalls.length || finishReason === 'tool_calls' && !toolCalls.length || !text && !toolCalls.length && finishReason === 'stop') throw new ModelCallError('protocol-mismatch', '模型返回了无效的工具或空回复。', { usage });
      return { text, toolCalls: toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })), usage, model: modelId, finishReason, httpStatus: 200 };
    },
  };
}
async function callDshModel(lock, body, timeoutMs = 600000, options = {}) {
  if (!lock || !['openai-chat-completions', 'chatgpt-responses'].includes(lock.protocol) || body.model !== lock.model?.modelId) throw new ModelCallError('protocol-unsupported', '当前模型尚未支持智能任务工具。');
  const state = streamState(lock.protocol, options.onChunk, lock.model.modelId);
  let request, post = postJsonWithCaFallback, connection, callId, response, notified = false;
  const controller = new AbortController(), abort = () => controller.abort();
  const deadline = setTimeout(abort, timeoutMs); deadline.unref();
  options.signal?.throwIfAborted(); options.signal?.addEventListener('abort', abort, { once: true });
  let accountController;
  try {
    if (lock.protocol === 'chatgpt-responses') {
      const runtime = lock.chatgptRuntime;
      if (!runtime || typeof runtime.token !== 'function' || typeof runtime.post !== 'function' || !runtime.controllers) throw new ModelCallError('protocol-unsupported', '订阅模型连接不完整。');
      const token = await runtime.token(lock.accountId); controller.signal.throwIfAborted();
      if (runtime.account(lock.accountId)?.accessToken !== token) throw new ModelCallError('chatgpt-login-required', '订阅连接已变化。');
      accountController = runtime.controllers.get(lock.accountId);
      if (!accountController) { accountController = new AbortController(); runtime.controllers.set(lock.accountId, accountController); }
      accountController.signal.addEventListener('abort', abort, { once: true });
      request = { url: 'https://api.openai.com/v1/responses', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: responsesBody(lock, body) };
      post = runtime.post.bind(runtime);
    } else {
      request = OpenAIChat.buildChatRequest({ baseUrl: lock.baseUrl, apiKey: lock.apiKey, protocol: lock.protocol }, lock.model, body.messages);
      request.body.stream = true; request.body.stream_options = { include_usage: true };
      for (const key of ['tools', 'tool_choice', 'parallel_tool_calls']) if (body[key] !== undefined) request.body[key] = body[key];
      if (request.body.max_tokens === undefined && (body.max_completion_tokens || body.max_tokens)) request.body.max_tokens = body.max_completion_tokens || body.max_tokens;
      if (options.networkPolicy) connection = await pinnedOptions(request.url, undefined, { signal: controller.signal, timeoutMs: 5000 });
    }
    controller.signal.throwIfAborted();
    callId = options.beforeCall?.({ reasoningEffort: lock.model.thinkingMode?.endsWith('-off') ? 'none' : lock.model.reasoningEffort || null });
    response = await post(request.url, request.headers, request.body, timeoutMs, { connection, signal: controller.signal, expectSse: lock.protocol === 'chatgpt-responses', maxBytes: 8 * 1024 * 1024, onEvent: event => state.accept(event), isComplete: () => state.complete() });
    controller.signal.throwIfAborted();
    if (response.status !== 200) {
      if (lock.protocol === 'chatgpt-responses') throw Responses.responseError(response.status, response.data);
      const error = new ModelCallError(response.status === 429 ? 'rate-limited' : 'model-error', '模型接口拒绝了请求。', { httpStatus: response.status, usage: usageFrom(response.data?.usage) });
      error.status = response.status; throw error;
    }
    if (!response.streaming) throw new ModelCallError('stream-incomplete', '智能任务模型未返回完整事件流。', { usage: usageFrom(response.data?.usage) });
    const result = state.result(); notified = true; options.afterCall?.(callId, result, null); return result;
  } catch (error) {
    const detail = { usage: state.usage() || usageFrom(response?.data?.usage) || error.extra?.usage || null, httpStatus: response?.status ?? error.extra?.httpStatus ?? null };
    error.extra = { ...error.extra, ...detail };
    if (!notified) { notified = true; options.afterCall?.(callId, detail, error); } throw error;
  } finally {
    clearTimeout(deadline); options.signal?.removeEventListener('abort', abort); accountController?.signal.removeEventListener('abort', abort);
  }
}
module.exports = { callDshModel, usageFrom, responsesBody, streamState };
