'use strict';
// Private text-only bridge: the website retains and refreshes the subscription
// credentials. DSH receives a separate service credential, never an OAuth token.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ROLES = new Set(['system', 'developer', 'user', 'assistant']);
const FIELDS = new Set(['model', 'messages', 'stream', 'store', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stream_options', 'n', 'tools', 'functions', 'tool_choice', 'function_call']);
const MAX_OUTPUT_CHARS = 200000;
const publicErrors = new WeakSet();
const fail = (status, code, message) => { const error = Object.assign(new Error(message), { status, code }); publicErrors.add(error); return error; };
const record = value => value && typeof value === 'object' && !Array.isArray(value);

function readToken(tokenFile, token) {
  if (tokenFile !== undefined) {
    if (token !== undefined || !path.isAbsolute(tokenFile)) throw Error('Subscription gateway credential configuration is invalid');
    const info = fs.lstatSync(tokenFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || process.platform !== 'win32' && (info.mode & 0o077)) throw Error('Subscription gateway credential permissions are invalid');
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error('Subscription gateway credential is invalid');
  return crypto.createHash('sha256').update(token).digest();
}

function messagesFrom(body, modelId) {
  const invalid = () => fail(400, 'invalid_request', 'Only fixed-model streaming text requests are supported.');
  if (!record(body) || Object.keys(body).some(key => !FIELDS.has(key)) || body.model !== modelId || body.stream !== true || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100) throw invalid();
  if (body.store !== undefined && body.store !== false) throw invalid();
  for (const name of ['tools', 'functions']) if (body[name] !== undefined && (!Array.isArray(body[name]) || body[name].length)) throw invalid();
  for (const name of ['tool_choice', 'function_call']) if (body[name] !== undefined && body[name] !== 'none') throw invalid();
  if (body.n !== undefined && body.n !== 1) throw invalid();
  if (body.stream_options !== undefined && (!record(body.stream_options) || Object.keys(body.stream_options).some(key => key !== 'include_usage') || body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean')) throw invalid();
  for (const name of ['temperature', 'top_p']) if (body[name] !== undefined && (!Number.isFinite(body[name]) || body[name] < 0 || body[name] > (name === 'top_p' ? 1 : 2))) throw invalid();
  for (const name of ['max_tokens', 'max_completion_tokens']) if (body[name] !== undefined && (!Number.isSafeInteger(body[name]) || body[name] < 1 || body[name] > 1000000)) throw invalid();
  const messages = body.messages.map(message => {
    if (!record(message) || Object.keys(message).some(key => !['role', 'content'].includes(key)) || !ROLES.has(message.role)) throw invalid();
    let content = message.content;
    if (Array.isArray(content)) content = content.map(part => {
      if (!record(part) || Object.keys(part).some(key => !['type', 'text'].includes(key)) || part.type !== 'text' || typeof part.text !== 'string') throw invalid();
      return part.text;
    }).join('');
    if (typeof content !== 'string') throw invalid();
    return { role: message.role, content };
  });
  if (!messages.some(message => message.role === 'user' && message.content.trim())) throw invalid();
  return messages;
}

function usageFrom(usage) {
  if (!record(usage)) return null;
  const valid = number => Number.isSafeInteger(number) && number >= 0;
  const prompt = usage.input_tokens, completion = usage.output_tokens;
  if (!valid(prompt) || !valid(completion)) return null;
  const result = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: valid(usage.total_tokens) ? usage.total_tokens : prompt + completion };
  if (valid(usage.input_tokens_details?.cached_tokens)) result.prompt_tokens_details = { cached_tokens: usage.input_tokens_details.cached_tokens };
  if (valid(usage.output_tokens_details?.reasoning_tokens)) result.completion_tokens_details = { reasoning_tokens: usage.output_tokens_details.reasoning_tokens };
  return result;
}

function readBody(req, signal, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    const cleanup = () => {
      req.removeListener('data', data); req.removeListener('end', end); req.removeListener('error', error);
      signal.removeEventListener('abort', aborted);
      // A later socket failure after an early rejection must stay harmless.
      req.once('error', () => {});
    };
    const error = cause => { cleanup(); reject(cause); };
    const aborted = () => { error(new DOMException('Aborted', 'AbortError')); req.resume(); };
    const data = value => {
      size += value.length;
      if (size > maxBytes) { error(fail(413, 'request_too_large', 'The request exceeds the size limit.')); req.resume(); }
      else chunks.push(value);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks).toString('utf8')); };
    if (signal.aborted) return aborted();
    req.on('data', data); req.once('end', end); req.once('error', error); signal.addEventListener('abort', aborted, { once: true });
  });
}

function safeError(error, abortKind) {
  if (abortKind === 'owner') return fail(403, 'owner_task_required', 'An active owner task is required.');
  if (abortKind === 'subscription') return fail(503, 'subscription_unavailable', 'The owner subscription is no longer connected.');
  if (abortKind === 'timeout') return fail(504, 'gateway_timeout', 'The subscription request timed out.');
  if (abortKind) return fail(503, 'request_stopped', 'The subscription request was stopped.');
  const known = {
    'chatgpt-login-required': [401, 'subscription_auth_required', 'Reconnect the ChatGPT subscription.'],
    'chatgpt-usage-limit': [429, 'subscription_usage_limit', 'The ChatGPT plan usage limit is unavailable or exhausted.'],
    'chatgpt-rate-limited': [429, 'subscription_rate_limit', 'The ChatGPT subscription is rate limited.'],
    'chatgpt-not-eligible': [403, 'subscription_not_eligible', 'The ChatGPT subscription is not eligible.'],
    'chatgpt-forbidden': [403, 'subscription_forbidden', 'The ChatGPT subscription request was denied.'],
    'stream-incomplete': [502, 'upstream_incomplete', 'The subscription response did not complete.'],
    'output-too-large': [502, 'output_too_large', 'The subscription response exceeded the size limit.'],
  };
  const mapped = typeof error?.code === 'string' && Object.hasOwn(known, error.code) ? known[error.code] : null;
  return mapped ? fail(...mapped) : fail(502, 'upstream_error', 'The ChatGPT subscription request failed.');
}

function createSubscriptionGateway({ runtime, tokenFile, token, isAllowed, modelId = 'gpt-6-luna', timeoutMs = 600000, maxBodyBytes = 512 * 1024 } = {}) {
  if (!runtime || !['account', 'resolve', 'call'].every(name => typeof runtime[name] === 'function') || typeof isAllowed !== 'function' || typeof modelId !== 'string' || !modelId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw Error('Subscription gateway configuration is invalid');
  const expected = readToken(tokenFile, token);
  let active = null, closing = false;
  function allowed(health = false) { try { return isAllowed({ health }) === true; } catch { return false; } }
  function selection() {
    const account = runtime.account();
    if (!account?.id || !account.accessToken || !account.scopes?.includes('chatgpt.tokens.use.direct')) throw fail(503, 'subscription_unavailable', 'The owner subscription is not connected.');
    const selected = runtime.resolve('chatgpt:' + account.id, modelId);
    if (!selected?.ok || selected.lock?.model?.modelId !== modelId || selected.lock.model.enabled === false) throw fail(503, 'subscription_unavailable', 'The owner subscription model is unavailable.');
    return { ...selected.lock, accountId: account.id };
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, value) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    const reject = error => send(error.status, { error: { type: 'subscription_gateway_error', code: error.code, message: error.message } });
    if (!LOOPBACK.has(req.socket.remoteAddress)) { req.resume(); return reject(fail(403, 'loopback_required', 'This endpoint is private.')); }
    const authCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'authorization').length;
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(req.headers.authorization || '');
    const actual = crypto.createHash('sha256').update(bearer?.[1] || '').digest();
    if (authCount !== 1 || !bearer || !crypto.timingSafeEqual(actual, expected)) { req.resume(); return reject(fail(401, 'authentication_required', 'Gateway authentication is required.')); }
    if (closing) { req.resume(); return reject(fail(503, 'gateway_closing', 'The gateway is stopping.')); }
    if (req.method === 'GET' && req.url === '/v1/health') {
      req.resume(); let ready = allowed(true);
      try { selection(); } catch { ready = false; }
      return send(200, { ready, billing: 'chatgpt-plan', model: modelId });
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { req.resume(); return reject(fail(404, 'not_found', 'Endpoint not found.')); }
    if (!allowed()) { req.resume(); return reject(fail(403, 'owner_task_required', 'An active owner task is required.')); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); return reject(fail(415, 'json_required', 'A JSON request is required.')); }
    if (active) { req.resume(); return reject(fail(429, 'gateway_busy', 'A subscription request is already running.')); }
    const controller = new AbortController();
    const operation = { controller, abortKind: '' };
    active = operation;
    const abort = kind => { operation.abortKind ||= kind; controller.abort(); };
    operation.abort = abort;
    const onClose = () => { if (!res.writableFinished) abort('client'); };
    const onAborted = () => abort('client');
    res.once('close', onClose); req.once('aborted', onAborted);
    const timer = setTimeout(() => abort('timeout'), timeoutMs); timer.unref();
    void (async () => {
      let authorityTimer;
      try {
        const raw = await readBody(req, controller.signal, maxBodyBytes);
        controller.signal.throwIfAborted();
        let body;
        try { body = JSON.parse(raw); } catch { throw fail(400, 'invalid_json', 'The request must contain valid JSON.'); }
        const messages = messagesFrom(body, modelId);
        if (!allowed()) throw fail(403, 'owner_task_required', 'An active owner task is required.');
        const lock = selection();
        const checkAuthority = () => {
          if (!allowed()) abort('owner');
          try {
            const account = runtime.account();
            if (!account || account.id !== lock.accountId || !account.accessToken || !account.scopes?.includes('chatgpt.tokens.use.direct')) abort('subscription');
          } catch { abort('subscription'); }
          controller.signal.throwIfAborted();
        };
        // Stop even while a model is still thinking and emitting no text. These
        // checks use the running application's cached owner/account state.
        authorityTimer = setInterval(() => { try { checkAuthority(); } catch { /* Abort is consumed by runtime.call. */ } }, 1000); authorityTimer.unref();
        const id = 'chatcmpl-' + crypto.randomUUID(), created = Math.floor(Date.now() / 1000);
        let output = '', started = false;
        const chunk = (choices, extra) => ({ id, object: 'chat.completion.chunk', created, model: modelId, choices, ...extra });
        const writeEvent = value => {
          controller.signal.throwIfAborted();
          if (res.destroyed) throw Error('Client disconnected');
          if (!started) {
            started = true;
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
            res.write('data: ' + JSON.stringify(chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])) + '\n\n');
          }
          res.write('data: ' + JSON.stringify(value) + '\n\n');
        };
        const result = await runtime.call(lock, messages, timeoutMs, { signal: controller.signal, maxChars: MAX_OUTPUT_CHARS,
          onText(delta) {
            checkAuthority();
            if (typeof delta !== 'string' || !delta) return;
            if (output.length + delta.length > MAX_OUTPUT_CHARS) throw fail(502, 'output-too-large', 'Output exceeded the size limit.');
            output += delta;
            writeEvent(chunk([{ index: 0, delta: { content: delta }, finish_reason: null }]));
          },
        });
        checkAuthority();
        if (!output || result?.text !== output || result.finishReason !== 'stop') throw fail(502, 'stream-incomplete', 'The subscription stream did not complete.');
        writeEvent(chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]));
        const usage = usageFrom(result.usage);
        if (body.stream_options?.include_usage && usage) writeEvent(chunk([], { usage }));
        res.end('data: [DONE]\n\n');
      } catch (error) {
        // Never return upstream exception text, request contents or credentials.
        const safe = publicErrors.has(error) && ['invalid_request', 'invalid_json', 'request_too_large', 'owner_task_required', 'subscription_unavailable'].includes(error.code) ? error : safeError(error, operation.abortKind);
        if (!res.destroyed && !res.writableEnded) {
          if (res.headersSent) res.end('data: ' + JSON.stringify({ error: { type: 'subscription_gateway_error', code: safe.code, message: safe.message } }) + '\n\n');
          else reject(safe);
        }
      } finally {
        clearTimeout(timer); clearInterval(authorityTimer); res.removeListener('close', onClose); req.removeListener('aborted', onAborted);
        if (active === operation) active = null;
      }
    })();
  });
  const close = server.close.bind(server);
  server.close = function (callback) { closing = true; active?.abort('shutdown'); return close(callback); };
  return server;
}

module.exports = { createSubscriptionGateway };
