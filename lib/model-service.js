// 模型服务：按提供商协议路由真实模型调用 + 模型列表获取 + 连通性测试
//
// 锁定语义：resolveAndLock 在请求开始时解析出 {provider 快照, model 快照}，
// 后续 XML 纠错重试复用同一份快照（含调用参数），不受配置并发修改影响。
const openaiChat = require('./adapters/openai-chat.js');
const anthropicMessages = require('./adapters/anthropic-messages.js');
const { ModelCallError, classifyHttpError, classifyNetworkError } = require('./adapters/common.js');
const { postJsonWithCaFallback, getJson } = require('./http-transport.js');
const Capabilities = require('./model-capabilities.js');
const {pinnedOptions}=require('./egress-policy');
const {CloudError}=require('./cloud-runtime');
const { createModelStream } = require('./model-stream');

const ADAPTERS = {
  [openaiChat.protocol]: openaiChat,
  [anthropicMessages.protocol]: anthropicMessages,
};

/**
 * 解析并锁定一次调用配置（深拷贝快照，之后改配置不影响本次调用）。
 * @param {import('./provider-store.js').ProviderStore} store
 * @param {string} [providerId]
 * @param {string} [modelId]
 */
function resolveAndLock(store, providerId, modelId) {
  const resolved = store.resolveSelection(providerId, modelId);
  if (!resolved.ok) return resolved;
  if (resolved.mock) {
    return {
      ok: true,
      mock: true,
      provider: resolved.provider,
      model: resolved.model,
    };
  }
  const adapter = ADAPTERS[resolved.provider.protocol];
  if (!adapter) {
    return { ok: false, status: 502, code: 'protocol-unsupported', message: `协议 ${resolved.provider.protocol} 暂不支持` };
  }
  return {
    ok: true,
    lock: {
      providerId: resolved.provider.providerId,
      providerName: resolved.provider.name,
      protocol: resolved.provider.protocol,
      baseUrl: resolved.provider.baseUrl,
      apiKey: resolved.provider.apiKey,
      model: {
        visionInput: resolved.model.visionInput === true,
        modelId: resolved.model.modelId,
        displayName: resolved.model.displayName,
        maxTokens: resolved.model.maxTokens,
        temperature: resolved.model.temperature,
        thinkingMode: resolved.model.thinkingMode,
        reasoningEffort: resolved.model.reasoningEffort,
        capabilities: Capabilities.resolve(resolved.provider, resolved.model),
      },
    },
    // 回复里记录的是「当时实际使用」的来源信息（快照），提供商日后改名/删除不影响旧回复标记
    sourceInfo: {
      providerId: resolved.provider.providerId,
      providerName: resolved.provider.name,
      modelId: resolved.model.modelId,
      modelName: resolved.model.displayName,
    },
  };
}

/**
 * 用锁定的快照发起一次真实调用。
 * @param {object} lock resolveAndLock 返回的 lock
 * @param {Array} messages
 * @param {number} timeoutMs
 * @returns {{ text: string, model: string|null, usage: object|null, finishReason: string|null }}
 */
async function callWithLock(lock, messages, timeoutMs, options = {}) {
  if (lock.protocol === 'chatgpt-responses') return lock.chatgptRuntime.call(lock, messages, timeoutMs, options);
  const adapter = ADAPTERS[lock.protocol];
  const providerLike = { baseUrl: lock.baseUrl, apiKey: lock.apiKey, protocol: lock.protocol };
  const modelLike = { ...lock.model };
  const request = adapter.buildChatRequest(providerLike, modelLike, messages);
  const stream = options.stream ? createModelStream(lock.protocol, adapter, lock.providerName, options.onProgress, options.maxChars, options.onText) : null;
  if (stream) {
    request.body.stream = true;
    if (lock.protocol === openaiChat.protocol) request.body.stream_options = { include_usage: true };
  }
  options.signal?.throwIfAborted();
  const connection=options.networkPolicy?await pinnedOptions(request.url,undefined,{signal:options.signal,timeoutMs:Math.min(timeoutMs||5000,5000)}):undefined;
  options.signal?.throwIfAborted();
  const callId=options.beforeCall?.({reasoningEffort: String(modelLike.thinkingMode||'').endsWith('-off')?'none':modelLike.reasoningEffort||null});
  let result, parsed;
  try {
    options.signal?.throwIfAborted();
    result = await postJsonWithCaFallback(request.url, request.headers, request.body, timeoutMs,
      { signal: options.signal, connection, onEvent: stream ? e => stream.accept(e) : undefined,
        isComplete: stream ? () => stream.isComplete() : undefined });
    options.signal?.throwIfAborted();
    if (result.streaming) parsed=stream.finish();
    else {
      // Buffered responses are consumed once, without issuing another request.
      if (stream && result.status === 200) options.onProgress?.({ phase: 'buffered' });
      parsed=adapter.parseChatResponse(result.status,result.data,lock.providerName);
    }
  } catch (e) {
    options.afterCall?.(callId,{usage:stream?.getUsage()||result?.data?.usage||e.extra?.usage,httpStatus:result?.status},e);
    if (e instanceof CloudError)throw e;
    if (options.signal?.aborted || e.name === 'AbortError' || e instanceof ModelCallError || result) throw e;
    throw classifyNetworkError(e, lock.providerName);
  }
  options.afterCall?.(callId,parsed,null);
  return parsed;
}

/** 从提供商获取模型 ID 列表；失败抛 ModelCallError（调用方不得解释为提供商不可用） */
async function listRemoteModels(provider, timeoutMs, includeDetails = false, options = {}) {
  const adapter = ADAPTERS[provider.protocol];
  if (!adapter || typeof adapter.buildModelsRequest !== 'function') {
    throw new ModelCallError('protocol-unsupported', `协议 ${provider.protocol} 不支持获取模型列表`);
  }
  const request = adapter.buildModelsRequest(provider);
  options.signal?.throwIfAborted();
  const connection=options.networkPolicy?await pinnedOptions(request.url,undefined,{signal:options.signal,timeoutMs:Math.min(timeoutMs||5000,5000)}):undefined;
  options.signal?.throwIfAborted();
  const callId=options.beforeCall?.();
  let result;
  try {
    result = await getJson(request.url, request.headers, timeoutMs,{signal:options.signal,connection});
  } catch (e) {
    options.afterCall?.(callId,null,e);
    if(e instanceof CloudError)throw e;
    throw classifyNetworkError(e, provider.name);
  }
  let models;try{models=adapter.parseModelsResponse(result.status,result.data,provider.name);options.afterCall?.(callId,null,null);}catch(e){options.afterCall?.(callId,null,e);throw e;}
  return includeDetails ? { models, modelDetails: Capabilities.remoteDetails(result.data.data) } : models;
}

/** 测试模型：最小文本请求，注明会发起一次真实 API 调用 */
async function testModelConnection(provider, model, timeoutMs, options = {}) {
  const lock = resolveAndLock({ resolveSelection: () => ({ ok: true, provider, model }) }, provider.providerId, model.modelId);
  if (!lock.ok) throw new ModelCallError('model-unavailable', lock.message || '模型不可用');
  return callWithLock(lock.lock, [{ role: 'user', content: 'ping' }], timeoutMs, options);
}

async function probeReasoningEfforts(lock, options = {}) {
  if (lock.protocol !== openaiChat.protocol) throw new ModelCallError('protocol-unsupported', '档位检测仅支持 OpenAI 兼容协议');
  const probe = require('./reasoning-probe');
  return probe.probe({ signal: options.signal, onProgress: options.onProgress, send: async effort => {
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.throwIfAborted(); options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 30000);
    let callId, accepted = false;
    const request = openaiChat.buildChatRequest(lock, { modelId: lock.model.modelId, maxTokens: 64 }, [
      { role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'ping' },
    ]);
    request.body.stream = true;
    if (effort !== undefined) request.body.reasoning_effort = effort;
    try {
      const connection = options.networkPolicy ? await pinnedOptions(request.url, undefined, { signal: controller.signal, timeoutMs: 5000 }) : undefined;
      controller.signal.throwIfAborted(); callId = options.beforeCall?.({reasoningEffort:effort||null});
      const response = await postJsonWithCaFallback(request.url, request.headers, request.body, 30000, {
        connection, signal: controller.signal, maxBytes: 65536,
        onEvent(event) {
          if (event.data === '[DONE]') return;
          const data = JSON.parse(event.data);
          if (data.choices?.some(choice => choice.delta && typeof choice.delta === 'object')) {
            accepted = true; controller.abort(); // Stop after the first valid event; don't generate a full answer.
          }
        },
      });
      accepted = response.status === 200 && (accepted || Boolean(response.data?.choices?.some(choice => choice.message && typeof choice.message === 'object')));
      options.afterCall?.(callId, { usage: response.data?.usage, httpStatus: response.status },
        accepted ? null : response.status !== 200 ? classifyHttpError(response.status, response.data, lock.providerName)
          : new ModelCallError('probe-rejected', `档位检测 HTTP ${response.status}`));
      return { status: response.status, data: response.data, accepted };
    } catch (error) {
      if (accepted && !options.signal?.aborted) { options.afterCall?.(callId, null, null); return { status: 200, accepted: true }; }
      if (callId !== undefined) options.afterCall?.(callId, null, error);
      if (options.signal?.aborted) { options.signal.throwIfAborted(); }
      if (error instanceof CloudError) throw error;
      return { status: 0, accepted: false, errorCode: controller.signal.aborted ? 'timeout' : 'model-unreachable' };
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  } });
}

module.exports = { ADAPTERS, resolveAndLock, callWithLock, listRemoteModels, testModelConnection, probeReasoningEfforts, ModelCallError };
