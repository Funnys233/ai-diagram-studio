'use strict';
// Private model gateway. The capability selects a persisted task; neither its
// owner, upstream address nor upstream credential comes from an HTTP body.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { verifyTaskCapability } = require('../services/dsh-bridge/file-protocol');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TOOLS = new Set(['list_documents', 'read_document', 'list_outputs', 'read_output', 'write_output']);
const FIELDS = new Set(['model', 'messages', 'stream', 'store', 'temperature', 'max_tokens', 'max_completion_tokens', 'top_p', 'stream_options', 'n', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => Object.assign(new Error('The model request is invalid.'), { status: 400, code: 'invalid_request', public: true });
const text = value => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every(part => object(part) && part.type === 'text' && typeof part.text === 'string' && Object.keys(part).every(key => ['type', 'text'].includes(key)))) return value.map(part => part.text).join('');
  throw invalid();
};
function normalizeRequest(body, modelId) {
  if (!object(body) || Object.keys(body).some(key => !FIELDS.has(key)) || body.model !== modelId || body.stream !== true || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 250 || body.store !== undefined && body.store !== false || body.n !== undefined && body.n !== 1) throw invalid();
  for (const key of ['max_tokens', 'max_completion_tokens']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1 || body[key] > 1000000)) throw invalid();
  for (const key of ['temperature', 'top_p']) if (body[key] !== undefined && (!Number.isFinite(body[key]) || body[key] < 0 || body[key] > (key === 'top_p' ? 1 : 2))) throw invalid();
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw invalid();
  if (body.reasoning_effort !== undefined && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort)) throw invalid();
  if (body.stream_options !== undefined && (!object(body.stream_options) || Object.keys(body.stream_options).some(key => key !== 'include_usage') || body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean')) throw invalid();
  const tools = body.tools === undefined ? [] : body.tools;
  if (!Array.isArray(tools) || tools.length > TOOLS.size || new Set(tools.map(tool => tool?.function?.name)).size !== tools.length) throw invalid();
  for (const tool of tools) {
    if (!object(tool) || Object.keys(tool).some(key => !['type', 'function'].includes(key)) || tool.type !== 'function' || !object(tool.function) || Object.keys(tool.function).some(key => !['name', 'description', 'parameters', 'strict'].includes(key)) || !TOOLS.has(tool.function.name) || !object(tool.function.parameters) || tool.function.parameters.type !== 'object' || typeof tool.function.description !== 'string' && tool.function.description !== undefined || tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean') throw invalid();
  }
  const toolNames = new Set(tools.map(tool => tool.function.name));
  const choice = body.tool_choice;
  if (choice !== undefined && !['auto', 'none', 'required'].includes(choice) && !(object(choice) && choice.type === 'function' && object(choice.function) && toolNames.has(choice.function.name) && Object.keys(choice).every(key => ['type', 'function'].includes(key)) && Object.keys(choice.function).length === 1)) throw invalid();
  const pending = new Set();
  const messages = body.messages.map(message => {
    if (!object(message) || Object.keys(message).some(key => !['role', 'content', 'tool_calls', 'tool_call_id', 'name'].includes(key)) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw invalid();
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !pending.delete(message.tool_call_id) || message.tool_calls !== undefined) throw invalid();
      return { role: 'tool', tool_call_id: message.tool_call_id, content: text(message.content) };
    }
    if (message.tool_call_id !== undefined || message.tool_calls !== undefined && message.role !== 'assistant') throw invalid();
    const normalized = { role: message.role, content: message.content === null && message.role === 'assistant' ? '' : text(message.content) };
    if (message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 32) throw invalid();
      normalized.tool_calls = message.tool_calls.map(call => {
        if (!object(call) || Object.keys(call).some(key => !['id', 'type', 'function'].includes(key)) || typeof call.id !== 'string' || !call.id || call.id.length > 300 || pending.has(call.id) || call.type !== 'function' || !object(call.function) || !TOOLS.has(call.function.name) || typeof call.function.arguments !== 'string' || Object.keys(call.function).some(key => !['name', 'arguments'].includes(key))) throw invalid();
        pending.add(call.id);
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
      });
    }
    return normalized;
  });
  if (pending.size || !messages.some(message => message.role === 'user' && message.content.trim())) throw invalid();
  return { ...body, messages, ...(tools.length ? { tools } : {}) };
}
function readSecret(tokenFile, token) {
  if (tokenFile !== undefined) {
    if (token !== undefined || !path.isAbsolute(tokenFile)) throw Error('Invalid DSH gateway credential configuration');
    const stat = fs.lstatSync(tokenFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096 || process.platform !== 'win32' && (stat.mode & 0o077)) throw Error('Invalid DSH gateway credential permissions');
    token = fs.readFileSync(tokenFile, 'utf8').trim();
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw Error('Invalid DSH gateway credential');
  return token;
}
function createDshModelGateway({ tokenFile, token, resolve, invoke, timeoutMs = 600000, maxBodyBytes = 2 * 1024 * 1024, maxConcurrent = 6 } = {}) {
  if (typeof resolve !== 'function' || typeof invoke !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 6) throw Error('Invalid DSH gateway configuration');
  const secret = readSecret(tokenFile, token), secretHash = crypto.createHash('sha256').update(secret).digest();
  let closing = false; const active = new Map();
  function contextFor(taskId) {
    let context;
    try { context = resolve(taskId); } catch {}
    if (!context || context.active !== true || typeof context.ownerId !== 'string' || !object(context.modelSelection) || typeof context.modelSelection.modelId !== 'string' || typeof context.modelSelection.providerId !== 'string') throw Object.assign(new Error('An active authorized task is required.'), { status: 403, code: 'task_required', public: true });
    return context;
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, body) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } };
    const reject = (status, code, message) => send(status, { error: { type: 'dsh_gateway_error', code, message } });
    if (!LOOPBACK.has(req.socket.remoteAddress)) { req.resume(); return reject(403, 'loopback_required', 'This endpoint is private.'); }
    const authCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
    const bearer = /^Bearer ([A-Za-z0-9_.-]{1,512})$/.exec(req.headers.authorization || '');
    if (authCount !== 1 || !bearer) { req.resume(); return reject(401, 'authentication_required', 'Gateway authentication is required.'); }
    if (req.method === 'GET' && req.url === '/v1/health') {
      req.resume(); const supplied = crypto.createHash('sha256').update(bearer[1]).digest();
      if (!crypto.timingSafeEqual(supplied, secretHash)) return reject(401, 'authentication_required', 'Gateway authentication is required.');
      return send(200, { ready: !closing, billing: 'website', taskBound: true });
    }
    const taskId = verifyTaskCapability(secret, bearer[1]);
    if (!taskId) { req.resume(); return reject(401, 'authentication_required', 'Gateway authentication is required.'); }
    if (closing) { req.resume(); return reject(503, 'gateway_closing', 'The gateway is stopping.'); }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { req.resume(); return reject(404, 'not_found', 'Endpoint not found.'); }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { req.resume(); return reject(415, 'json_required', 'A JSON request is required.'); }
    if (active.has(taskId) || active.size >= maxConcurrent) { req.resume(); return reject(429, 'gateway_busy', 'A model request is already running.'); }
    const controller = new AbortController(), operation = { controller }; active.set(taskId, operation);
    let deadline, authorityTimer;
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    res.once('close', onClose);
    deadline = setTimeout(() => controller.abort(), timeoutMs); deadline.unref();
    void (async () => {
      try {
        const initial = contextFor(taskId);
        let bytes = 0; const chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length; if (bytes > maxBodyBytes) throw Object.assign(new Error('The request exceeds the size limit.'), { status: 413, code: 'request_too_large', public: true });
          chunks.push(chunk); controller.signal.throwIfAborted();
        }
        let raw; try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw invalid(); }
        const body = normalizeRequest(raw, initial.modelSelection.modelId);
        function authority() {
          const current = contextFor(taskId);
          if (current.ownerId !== initial.ownerId || current.modelSelection.providerId !== initial.modelSelection.providerId || current.modelSelection.modelId !== initial.modelSelection.modelId) throw Object.assign(new Error('The task authorization changed.'), { status: 403, code: 'task_required', public: true });
          controller.signal.throwIfAborted();
        }
        authority();
        authorityTimer = setInterval(() => { try { authority(); } catch { controller.abort(); } }, 1000); authorityTimer.unref();
        let started = false, finish = null, outputBytes = 0;
        const id = 'chatcmpl-' + crypto.randomUUID(), created = Math.floor(Date.now() / 1000);
        function onChunk(value) {
          authority();
          if (!object(value) || !Array.isArray(value.choices)) throw Error('Invalid gateway model event');
          if (!started) { started = true; res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' }); }
          const event = { id, object: 'chat.completion.chunk', created, model: initial.modelSelection.modelId, ...value };
          outputBytes += Buffer.byteLength(JSON.stringify(event));
          if (outputBytes > 8 * 1024 * 1024 || res.writableLength > 1024 * 1024 || res.destroyed) throw Error('Gateway output limit exceeded');
          if (event.choices[0]?.finish_reason) finish = event.choices[0].finish_reason;
          res.write('data: ' + JSON.stringify(event) + '\n\n');
        }
        const result = await invoke(initial, body, { signal: controller.signal, onChunk });
        authority();
        if (!result || !['stop', 'tool_calls', 'length', 'content_filter'].includes(result.finishReason)) throw Error('Incomplete model result');
        if (!finish) onChunk({ choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }] });
        if (body.stream_options?.include_usage && result.usage) onChunk({ choices: [], usage: result.usage });
        res.end('data: [DONE]\n\n');
      } catch (error) {
        req.resume();
        const status = error.public === true ? error.status : error.status === 429 || error.code === 'weekly-limit' ? 429 : 502;
        const code = error.public === true ? error.code : status === 429 ? 'usage_limit' : 'upstream_error';
        const message = error.public === true ? error.message : status === 429 ? 'The usage quota is unavailable or exhausted.' : 'The model request did not complete.';
        if (!res.destroyed && !res.writableEnded) {
          if (res.headersSent) res.end('data: ' + JSON.stringify({ error: { type: 'dsh_gateway_error', code, message } }) + '\n\n');
          else reject(status, code, message);
        }
      } finally {
        clearTimeout(deadline); clearInterval(authorityTimer); res.removeListener('close', onClose);
        if (active.get(taskId) === operation) active.delete(taskId);
      }
    })();
  });
  server.requestTimeout = Math.min(timeoutMs, 60000); server.headersTimeout = 10000;
  const close = server.close.bind(server);
  server.close = function (callback) { closing = true; for (const operation of active.values()) operation.controller.abort(); return close(callback); };
  return server;
}
module.exports = { createDshModelGateway, normalizeRequest, TOOLS };
