const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postJsonWithCaFallback } = require('../../lib/http-transport');
const { createModelStream } = require('../../lib/model-stream');
const adapter = require('../../lib/adapters/chatgpt-responses');

const event = data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
const text = event({ type: 'response.output_text.delta', delta: '连接正常' });
const completed = event({ type: 'response.completed', response: { status: 'completed', model: 'fixture' } });

async function fixture(t, body, headers = {}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, headers);
      const bytes = Buffer.from(body); const middle = Math.floor(bytes.length / 2);
      res.write(bytes.subarray(0, middle)); res.end(bytes.subarray(middle));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/responses`;
}

test('subscription SSE without Content-Type still streams and requires completed', async t => {
  const url = await fixture(t, text + completed);
  const deltas = [];
  const stream = createModelStream(adapter.protocol, adapter, 'ChatGPT', null, 1000, value => deltas.push(value));
  const response = await postJsonWithCaFallback(url, {}, { stream: true }, 2000, { expectSse: true, onEvent: event => stream.accept(event) });
  assert.equal(response.streaming, true); assert.deepEqual(deltas, ['连接正常']); assert.equal(stream.finish().text, '连接正常');
});

test('normal providers retain buffered JSON behavior when Content-Type is absent', async t => {
  const url = await fixture(t, JSON.stringify({ choices: [{ message: { content: 'buffered' } }] }));
  let events = 0;
  const response = await postJsonWithCaFallback(url, {}, {}, 2000, { onEvent: () => events++ });
  assert.equal(response.streaming, undefined); assert.equal(events, 0); assert.equal(response.data.choices[0].message.content, 'buffered');
});

test('forcing subscription SSE never accepts JSON, HTML, or an unterminated response as success', async t => {
  for (const body of [JSON.stringify({ status: 'completed', output_text: 'not SSE' }), '<html>not SSE</html>', text]) {
    const url = await fixture(t, body);
    const stream = createModelStream(adapter.protocol, adapter, 'ChatGPT');
    await postJsonWithCaFallback(url, {}, {}, 2000, { expectSse: true, onEvent: event => stream.accept(event) });
    assert.throws(() => stream.finish(), /未完整结束/);
  }
});
