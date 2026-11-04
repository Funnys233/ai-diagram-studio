'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('node:http');
const { callDshModel, usageFrom, responsesBody } = require('../../lib/dsh-model-call');
const model = 'gpt-6-luna';
const tool = { type: 'function', function: { name: 'read_document', description: 'read', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } };
const body = () => ({ model, stream: true, messages: [{ role: 'system', content: 'controlled files' }, { role: 'user', content: 'read' }], tools: [tool] });
test('OpenAI-compatible gateway forwarding preserves tools, tool history and cache usage through actual loopback HTTP', async t => {
  let posted, authorization;
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk; posted = JSON.parse(raw); authorization = req.headers.authorization;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const delta of [{ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_document', arguments: '{"id":' } }] }, { tool_calls: [{ index: 0, function: { arguments: '"reference"}' } }] }]) res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const lock = { protocol: 'openai-chat-completions', baseUrl: 'http://127.0.0.1:' + upstream.address().port + '/v1', apiKey: 'private-upstream-key', providerName: 'fixture', model: { modelId: model, maxTokens: null, temperature: null } };
  const events = [], results = [];
  const result = await callDshModel(lock, body(), 5000, { onChunk: event => events.push(event), beforeCall: () => 'call-id', afterCall: (...args) => results.push(args) });
  assert.equal(authorization, 'Bearer private-upstream-key'); assert.equal(posted.model, model); assert.deepEqual(posted.tools, [tool]); assert.equal(posted.stream_options.include_usage, true);
  assert.equal(result.finishReason, 'tool_calls'); assert.equal(result.toolCalls[0].function.arguments, '{"id":"reference"}');
  assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 40 } });
  assert.equal(results.length, 1); assert.equal(results[0][0], 'call-id'); assert.ok(events.some(event => event.choices[0]?.delta.tool_calls));
});
test('subscription bridge translates native tool history to stateless namespaced Responses and uses refreshed runtime credentials', async () => {
  const events = [], postBodies = [];
  const runtime = { controllers: new Map(), account: () => ({ accessToken: 'oauth-not-exported-to-dsh' }), token: async () => 'oauth-not-exported-to-dsh', async post(url, headers, request, timeout, options) {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(headers.Authorization, 'Bearer oauth-not-exported-to-dsh'); postBodies.push(request);
    const frames = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', namespace: 'diagram_files', name: 'read_document', call_id: 'call-2', id: 'fc-2', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-2', delta: '{"id":"reference"}' },
      { type: 'response.completed', response: { status: 'completed', model, usage: { input_tokens: 20, output_tokens: 5, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 2 } }, output: [{ type: 'function_call', namespace: 'diagram_files', name: 'read_document', call_id: 'call-2', id: 'fc-2', arguments: '{"id":"reference"}' }] } },
    ];
    frames.forEach(frame => options.onEvent({ data: JSON.stringify(frame) })); assert.equal(options.isComplete(), true); return { status: 200, streaming: true };
  } };
  const lock = { protocol: 'chatgpt-responses', accountId: 'account-fixture', chatgptRuntime: runtime, model: { modelId: model } };
  const request = body(); request.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_document', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call-1', content: 'already read' });
  const result = await callDshModel(lock, request, 5000, { onChunk: event => events.push(event) });
  const posted = postBodies[0]; assert.equal(posted.store, false); assert.equal(posted.stream, true); assert.equal(posted.tools[0].type, 'namespace'); assert.equal(posted.instructions, 'controlled files');
  assert.equal(posted.input[1].type, 'function_call'); assert.equal(posted.input[1].namespace, 'diagram_files'); assert.equal(posted.input[2].type, 'function_call_output');
  for (const field of ['max_output_tokens', 'previous_response_id', 'temperature', 'top_p', 'conversation', 'metadata']) assert.equal(posted[field], undefined);
  assert.equal(result.toolCalls[0].id, 'call-2'); assert.equal(result.finishReason, 'tool_calls'); assert.equal(result.usage.prompt_tokens_details.cached_tokens, 10); assert.equal(result.usage.completion_tokens_details.reasoning_tokens, 2);
});
test('partial Responses and unknown hosted tool calls cannot be accepted as completed usage', async () => {
  const runtime = { controllers: new Map(), account: () => ({ accessToken: 'token' }), token: async () => 'token', async post(url, headers, request, timeout, options) { options.onEvent({ data: JSON.stringify({ type: 'response.output_text.delta', delta: 'partial' }) }); return { status: 200, streaming: true }; } };
  const lock = { protocol: 'chatgpt-responses', accountId: 'fixture', chatgptRuntime: runtime, model: { modelId: model } };
  await assert.rejects(callDshModel(lock, body(), 1000), { code: 'stream-incomplete' });
});
test('usage normalizes token aliases without charging cached and reasoning tokens twice', () => {
  assert.deepEqual(usageFrom({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } }), { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 10 } });
  assert.equal(usageFrom({ input_tokens: -1, output_tokens: 2 }), null);
});
