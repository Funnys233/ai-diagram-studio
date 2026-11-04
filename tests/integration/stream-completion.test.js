const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { callWithLock } = require('../../lib/model-service');
const { postJsonWithCaFallback } = require('../../lib/http-transport');
const { createModelStream } = require('../../lib/model-stream');
const responses = require('../../lib/adapters/chatgpt-responses');

const frame = data => `data: ${JSON.stringify(data)}\n\n`;
async function gateway(t, frames) {
  let calls = 0, closed = 0;
  const server = http.createServer((req, res) => {
    calls++; req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(frames);
      // Deliberately keep HTTP open, as a relay can after logical completion.
      const timer = setInterval(() => res.write(': ping\n\n'), 20);
      res.once('close', () => { closed++; clearInterval(timer); });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, counts: () => ({ calls, closed }) };
}

for (const protocol of ['openai-chat-completions', 'anthropic-messages']) {
  test(`${protocol}: logical completion settles once despite a pinging open socket`, async t => {
    const frames = protocol === 'openai-chat-completions'
      ? frame({ choices: [{ delta: { content: '完整回复' }, finish_reason: 'stop' }] })
        + frame({ choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } }) + 'data: [DONE]\n\n'
      : frame({ type: 'message_start', message: { usage: { input_tokens: 123 } } })
        + frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '完整回复' } })
        + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 45 } })
        + frame({ type: 'message_stop' });
    const g = await gateway(t, frames), deltas = [], settled = [];
    const result = await callWithLock({ protocol, baseUrl: g.base, providerName: 'fixture', model: { modelId: 'fixture' } },
      [{ role: 'user', content: 'test' }], 1000, {
        signal: AbortSignal.timeout(1500), stream: true, onText: text => deltas.push(text),
        beforeCall: () => 'one-call', afterCall: (id, result, error) => settled.push({ id, result, error }),
      });
    assert.equal(result.text, '完整回复'); assert.deepEqual(deltas, ['完整回复']);
    assert.equal(result.usage.completion_tokens ?? result.usage.output_tokens, 45);
    assert.equal(settled.length, 1); assert.equal(settled[0].error, null);
    assert.equal(g.counts().calls, 1);
  });
}

test('subscription completion closes a pinging response with full token usage retained', async t => {
  const g = await gateway(t, frame({ type: 'response.output_text.delta', delta: 'Sol 完整回复' })
    + frame({ type: 'response.completed', response: { status: 'completed', model: 'fixture', usage: { input_tokens: 100, output_tokens: 25 } } }));
  const stream = createModelStream(responses.protocol, responses, 'fixture');
  await postJsonWithCaFallback(g.base, {}, {}, 1000, {
    signal: AbortSignal.timeout(1500), expectSse: true,
    onEvent: e => stream.accept(e), isComplete: () => stream.isComplete(),
  });
  assert.deepEqual(stream.finish().usage, { input_tokens: 100, output_tokens: 25 });
  assert.equal(stream.finish().text, 'Sol 完整回复'); assert.equal(g.counts().calls, 1);
});

test('finish_reason without terminal marker still waits and cancels; no forged success or retry', async t => {
  const g = await gateway(t, frame({ choices: [{ delta: { content: '未完成' }, finish_reason: 'stop' }] }));
  const settled = [];
  await assert.rejects(callWithLock({ protocol: 'openai-chat-completions', baseUrl: g.base, providerName: 'fixture', model: { modelId: 'fixture' } },
    [{ role: 'user', content: 'test' }], 1000, { stream: true, signal: AbortSignal.timeout(120), beforeCall: () => 'one', afterCall: (...args) => settled.push(args) }));
  assert.equal(settled.length, 1); assert.ok(settled[0][2]); assert.equal(g.counts().calls, 1);
});
