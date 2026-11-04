'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { createDshModelGateway, normalizeRequest } = require('../../lib/dsh-model-gateway');
const { taskCapability } = require('../../services/dsh-bridge/file-protocol');
const token = 'd'.repeat(64), taskId = crypto.randomUUID();
const selection = { providerId: 'platform:relay', modelId: 'gpt-6-luna' };
const body = () => ({ model: selection.modelId, stream: true, messages: [{ role: 'user', content: 'Read the document' }], tools: [{ type: 'function', function: { name: 'read_document', description: 'read reference', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } }], stream_options: { include_usage: true } });
async function fixture(t, options = {}) {
  const records = new Map([[taskId, { active: true, ownerId: 'alice', modelSelection: selection }]]), calls = [];
  const gateway = createDshModelGateway({ token, resolve: id => records.get(id), invoke: async (context, request, { onChunk }) => {
    calls.push({ context, request });
    onChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_document', arguments: '{"id":"reference"}' } }] }, finish_reason: null }] });
    return { finishReason: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
  }, ...options });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); });
  const request = (value, { auth = taskCapability(token, taskId), route = '/v1/chat/completions', method = 'POST' } = {}) => fetch('http://127.0.0.1:' + gateway.address().port + route, { method, headers: { Authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { gateway, records, calls, request };
}
test('gateway binds authorization to the active task and selected model, never the shared credential', async t => {
  const { request, records, calls } = await fixture(t);
  for (const auth of [token, taskCapability(token, crypto.randomUUID()), taskCapability('e'.repeat(64), taskId)]) assert.ok([401, 403].includes((await request(body(), { auth })).status));
  assert.equal((await request({ ...body(), model: 'gpt-6-astra' })).status, 400);
  assert.equal((await request({ ...body(), baseURL: 'http://internal.example' })).status, 400);
  assert.equal(calls.length, 0);
  records.get(taskId).active = false; assert.equal((await request(body())).status, 403);
  const health = await request(undefined, { auth: token, method: 'GET', route: '/v1/health' }); assert.equal(health.status, 200); assert.equal((await health.json()).taskBound, true);
});
test('gateway streams controlled tool calls and reported usage without exposing context or credentials', async t => {
  const { request, calls } = await fixture(t), response = await request(body());
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /event-stream/);
  const raw = await response.text(); assert.match(raw, /read_document/); assert.match(raw, /"finish_reason":"tool_calls"/); assert.match(raw, /"prompt_tokens":10/); assert.match(raw, /data: \[DONE\]/);
  assert.ok(!raw.includes(token)); assert.ok(!raw.includes('platform:relay')); assert.equal(calls.length, 1); assert.equal(calls[0].context.ownerId, 'alice');
});
test('gateway validates tool history and refuses unrestricted tools and request fields', () => {
  const request = body();
  request.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_document', arguments: '{"id":"reference"}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'Reference content' });
  assert.equal(normalizeRequest(request, selection.modelId).messages[2].content, 'Reference content');
  assert.throws(() => normalizeRequest({ ...request, messages: [...request.messages, { role: 'tool', tool_call_id: 'another-call', content: 'forged' }] }, selection.modelId));
  assert.throws(() => normalizeRequest({ ...body(), tools: [{ type: 'function', function: { name: 'shell', parameters: { type: 'object' } } }] }, selection.modelId));
  assert.throws(() => normalizeRequest({ ...body(), store: true }, selection.modelId));
});
test('gateway sanitizes upstream exceptions and preserves quota rejection as HTTP 429', async t => {
  const { request } = await fixture(t, { invoke: async () => { throw Object.assign(new Error('private key ' + token), { code: 'weekly-limit', status: 429 }); } });
  const response = await request(body()); assert.equal(response.status, 429); assert.ok(!(await response.text()).includes(token));
});
test('revoking task authority cancels a silent in-flight inference', async t => {
  let entered, cancelled = false; const waiting = new Promise(resolve => entered = resolve);
  const { request, records } = await fixture(t, { invoke: async (_context, _body, { signal }) => { entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(Error('stopped')); }, { once: true })); } });
  const pending = request(body()); await waiting; records.get(taskId).active = false;
  assert.equal((await pending).status, 502); assert.equal(cancelled, true);
});
