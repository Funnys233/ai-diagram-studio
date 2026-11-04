'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSubscriptionGateway } = require('../../lib/dsh-subscription-gateway');

const token = 'fixture-service-token-'.padEnd(64, 'x');
const requestBody = () => ({ model: 'gpt-6-luna', stream: true, messages: [{ role: 'user', content: 'Hello' }] });
async function fixture(t, overrides = {}, gatewayOptions = {}) {
  const calls = [], selections = [];
  let allowed = true;
  const runtime = {
    account() { return { id: 'owner-account', accessToken: 'never-export-access', refreshToken: 'never-export-refresh', scopes: ['chatgpt.tokens.use.direct'] }; },
    resolve(providerId, modelId) { selections.push({ providerId, modelId }); return { ok: true, lock: { protocol: 'chatgpt-responses', model: { modelId, enabled: true } } }; },
    async call(lock, messages, timeout, options) { calls.push({ lock, messages, timeout, options }); options.onText('你'); options.onText('好'); return { text: '你好', finishReason: 'stop', usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 }, unexpected: 'never-export-refresh' } }; },
    ...overrides,
  };
  const server = createSubscriptionGateway({ runtime, token, isAllowed: () => allowed, timeoutMs: 1000, ...gatewayOptions });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  async function request(body = requestBody(), options = {}) {
    const method = options.method || 'POST';
    const response = await fetch(url + (options.path || '/v1/chat/completions'), { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...options.headers }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
  }
  return { runtime, calls, selections, server, url, request, forbid() { allowed = false; } };
}
const events = text => text.split('\n\n').filter(part => part.startsWith('data: ') && part !== 'data: [DONE]').map(part => JSON.parse(part.slice(6)));

test('requires a private authenticated route and exposes only safe readiness metadata', async t => {
  const f = await fixture(t);
  for (const auth of ['', 'Bearer short', 'Bearer ' + 'y'.repeat(64)]) assert.equal((await f.request(undefined, { headers: { Authorization: auth } })).status, 401);
  assert.equal((await f.request(undefined, { path: '/v1/responses' })).status, 404);
  assert.equal((await f.request(undefined, { path: '/v1/chat/completions?token=secret' })).status, 404);
  const health = await f.request(undefined, { method: 'GET', path: '/v1/health' });
  assert.deepEqual(JSON.parse(health.text), { ready: true, billing: 'chatgpt-plan', model: 'gpt-6-luna' });
  assert.equal(f.calls.length, 0);
  f.forbid(); assert.equal((await f.request()).status, 403);
  assert.equal(JSON.parse((await f.request(undefined, { method: 'GET', path: '/v1/health' })).text).ready, false);
  assert.equal(f.calls.length, 0);
});

test('fixed owner account, text translation, completed deltas and sanitized usage', async t => {
  const f = await fixture(t);
  const body = { ...requestBody(), store: false, messages: [{ role: 'developer', content: [{ type: 'text', text: 'Be clear.' }] }, { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: '!' }] }], max_completion_tokens: 8192, temperature: .3, top_p: 1, stream_options: { include_usage: true }, tools: [] };
  const response = await f.request(body);
  assert.equal(response.status, 200); assert.match(response.type, /event-stream/);
  const data = events(response.text);
  assert.equal(data.map(event => event.choices[0]?.delta.content || '').join(''), '你好');
  assert.equal(data.at(-2).choices[0].finish_reason, 'stop'); assert.match(response.text, /data: \[DONE\]\n\n$/);
  assert.deepEqual(data.at(-1).usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 1 } });
  assert.doesNotMatch(response.text, /never-export|owner-account/);
  assert.deepEqual(f.selections, [{ providerId: 'chatgpt:owner-account', modelId: 'gpt-6-luna' }]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].messages, [{ role: 'developer', content: 'Be clear.' }, { role: 'user', content: 'Hi!' }]);
  assert.deepEqual(Object.keys(f.calls[0].options).sort(), ['maxChars', 'onText', 'signal']);
});

test('rejects model overrides, tool and image inputs, extra fields and non-streaming requests without inference', async t => {
  const f = await fixture(t);
  const variants = [
    { model: 'gpt-6-astra' }, { stream: false }, { tools: [{ type: 'function' }] }, { functions: [{}] }, { tool_choice: 'auto' }, { function_call: { name: 'exec' } }, { n: 2 },
    { base_url: 'https://attacker.test' }, { store: true }, { store: null }, { previous_response_id: 'x' }, { reasoning_effort: 'high' }, { stream_options: { include_usage: 'true' } },
    { messages: [{ role: 'tool', content: 'secret' }] }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,foo' } }] }] },
    { messages: [{ role: 'assistant', content: 'x', tool_calls: [] }] }, { messages: [{ role: 'user', content: ' ' }] }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi', hidden: 'bad' }] }] },
  ];
  for (const patch of variants) assert.equal((await f.request({ ...requestBody(), ...patch })).status, 400, JSON.stringify(patch));
  assert.equal((await f.request('{broken')).status, 400);
  assert.equal((await f.request(undefined, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('unavailable owner connection and disabled model never call an alternate billing path', async t => {
  for (const overrides of [
    { account: () => null },
    { account: () => ({ id: 'owner', accessToken: 'private', scopes: [] }) },
    { resolve: () => ({ ok: false }) },
    { resolve: () => ({ ok: true, lock: { model: { modelId: 'gpt-6-luna', enabled: false } } }) },
  ]) {
    const f = await fixture(t, overrides);
    const response = await f.request(); assert.equal(response.status, 503); assert.doesNotMatch(response.text, /private|never-export/); assert.equal(f.calls.length, 0);
  }
});

test('upstream failures stay sanitized and never emit a successful completion', async t => {
  for (const partial of [false, true]) {
    const f = await fixture(t, { async call(lock, messages, timeout, options) {
      if (partial) options.onText('Partial');
      throw Object.assign(new Error('never-export-refresh and user-private-prompt'), { code: 'chatgpt-usage-limit' });
    } });
    const result = await f.request();
    assert.equal(result.status, partial ? 200 : 429);
    assert.doesNotMatch(result.text, /never-export|user-private-prompt|\[DONE\]|"finish_reason":"stop"/);
    assert.match(result.text, /subscription_usage_limit/);
  }
  for (const code of ['invalid_request', '__proto__']) {
    const f = await fixture(t, { async call() { throw Object.assign(new Error('never-export-refresh'), { code, status: 400 }); } });
    const result = await f.request(); assert.equal(result.status, 502); assert.doesNotMatch(result.text, /never-export/);
  }
});

test('empty or inconsistent streams cannot masquerade as completed responses', async t => {
  for (const mode of ['empty', 'mismatch', 'not-completed']) {
    const f = await fixture(t, { async call(lock, messages, timeout, options) {
      if (mode !== 'empty') options.onText('partial');
      return { text: mode === 'mismatch' ? 'different' : mode === 'empty' ? '' : 'partial', finishReason: mode === 'not-completed' ? 'length' : 'stop' };
    } });
    const result = await f.request();
    assert.equal(result.status, mode === 'empty' ? 502 : 200);
    assert.match(result.text, /upstream_incomplete/); assert.doesNotMatch(result.text, /\[DONE\]|"finish_reason":"stop"/);
  }
});

test('only one upstream request runs at a time', async t => {
  let release, started;
  const ready = new Promise(resolve => started = resolve);
  const f = await fixture(t, { async call(lock, messages, timeout, options) {
    started(); await new Promise(resolve => release = resolve); options.onText('done'); return { text: 'done', finishReason: 'stop' };
  } });
  const first = f.request(); await ready;
  assert.equal((await f.request()).status, 429); release(); assert.equal((await first).status, 200);
});

test('client disconnect aborts the real subscription operation', async t => {
  let started, aborted;
  const ready = new Promise(resolve => started = resolve), stopped = new Promise(resolve => aborted = resolve);
  const f = await fixture(t, { async call(lock, messages, timeout, options) {
    started(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
  } });
  const req = http.request(f.url + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } });
  req.on('error', () => {}); req.end(JSON.stringify(requestBody()));
  await ready; req.destroy(); await stopped;
});

test('server shutdown aborts in-flight inference without reporting completion', async t => {
  let started;
  const ready = new Promise(resolve => started = resolve);
  const f = await fixture(t, { async call(lock, messages, timeout, options) {
    started(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  } });
  const response = f.request(); await ready;
  const closed = new Promise(resolve => f.server.close(resolve));
  const result = await response; await closed;
  assert.equal(result.status, 503); assert.doesNotMatch(result.text, /\[DONE\]/);
});

test('bounds request bodies before inference', async t => {
  const f = await fixture(t, {}, { maxBodyBytes: 256 });
  const response = await f.request({ ...requestBody(), messages: [{ role: 'user', content: 'x'.repeat(512) }] });
  assert.equal(response.status, 413); assert.equal(f.calls.length, 0);
  assert.equal((await f.request()).status, 200);
});

test('hard deadline aborts subscription inference and does not report a completed stream', async t => {
  let aborted = false;
  const f = await fixture(t, { async call(lock, messages, timeout, options) {
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
  } }, { timeoutMs: 30 });
  const response = await f.request();
  assert.equal(response.status, 504); assert.equal(aborted, true); assert.doesNotMatch(response.text, /\[DONE\]/);
});

test('owner permission is checked again before inference begins', async t => {
  let checks = 0;
  const f = await fixture(t, {}, { isAllowed: () => ++checks === 1 });
  const response = await f.request();
  assert.equal(response.status, 403); assert.equal(f.calls.length, 0); assert.doesNotMatch(response.text, /\[DONE\]/);
});

test('owner disable or account disconnection stops partial streams before another delta or completion', async t => {
  for (const change of ['owner', 'account']) {
    let f, disconnected = false;
    f = await fixture(t, {
      account() { return disconnected ? null : { id: 'owner-account', accessToken: 'private', scopes: ['chatgpt.tokens.use.direct'] }; },
      async call(lock, messages, timeout, options) {
        options.onText('partial');
        if (change === 'owner') f.forbid(); else disconnected = true;
        options.onText('must-not-be-delivered');
        return { text: 'partialmust-not-be-delivered', finishReason: 'stop' };
      },
    });
    const response = await f.request();
    assert.equal(response.status, 200); assert.match(response.text, /partial/);
    assert.doesNotMatch(response.text, /must-not-be-delivered|\[DONE\]|"finish_reason":"stop"/);
    assert.match(response.text, change === 'owner' ? /owner_task_required/ : /subscription_unavailable/);
  }
});

test('owner disable or account disconnection aborts an upstream that has not emitted text', async t => {
  for (const change of ['owner', 'account']) {
    let started, disconnected = false, aborted = false;
    const ready = new Promise(resolve => started = resolve);
    const f = await fixture(t, {
      account() { return disconnected ? null : { id: 'owner-account', accessToken: 'private', scopes: ['chatgpt.tokens.use.direct'] }; },
      async call(lock, messages, timeout, options) {
        started(); return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true }));
      },
    }, { timeoutMs: 5000 });
    const response = f.request(); await ready;
    if (change === 'owner') f.forbid(); else disconnected = true;
    const result = await response;
    assert.equal(result.status, change === 'owner' ? 403 : 503); assert.equal(aborted, true); assert.doesNotMatch(result.text, /\[DONE\]/);
  }
});

test('non-loopback socket identity is denied before gateway authentication or inference', async t => {
  const f = await fixture(t);
  let status, payload;
  const request = { socket: { remoteAddress: '192.0.2.42' }, resume() {} };
  const response = { setHeader() {}, writeHead(value) { status = value; }, end(value) { payload = value; } };
  f.server.emit('request', request, response);
  assert.equal(status, 403); assert.match(payload, /loopback_required/); assert.equal(f.calls.length, 0);
});

test('credential files require protected regular files and no public credentials enter responses', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-subscription-gateway-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const filename = path.join(folder, 'service.token'); fs.writeFileSync(filename, token, { mode: 0o600 });
  const runtime = { account() {}, resolve() {}, call() {} }, config = { runtime, isAllowed: () => false, tokenFile: filename };
  const server = createSubscriptionGateway(config); server.close();
  if (process.platform !== 'win32') { fs.chmodSync(filename, 0o644); assert.throws(() => createSubscriptionGateway(config), /permissions/); fs.chmodSync(filename, 0o600); }
  const symlink = path.join(folder, 'link'); fs.symlinkSync(filename, symlink); assert.throws(() => createSubscriptionGateway({ ...config, tokenFile: symlink }), /permissions/);
  assert.throws(() => createSubscriptionGateway({ ...config, token }), /configuration/);
});
