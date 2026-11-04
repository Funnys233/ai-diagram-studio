const test = require('node:test');
const assert = require('node:assert/strict');
const { ChatGPTLocal } = require('../../lib/chatgpt-local');
const Quota = require('../../lib/weekly-quota');

async function call(post, { signal, cancel = false } = {}) {
  const data = {}, id = 'subscription-request', ownerKey = 'alice';
  const runtime = {
    token: async () => 'fixture-token', account: () => ({ accessToken: 'fixture-token' }),
    controllers: new Map(), post,
  };
  let starts = 0, finishes = 0, metadata, recordedError, settled;
  const result = ChatGPTLocal.prototype.call.call(runtime,
    { accountId: 'fixture-account', providerName: 'Fixture subscription', model: { modelId: 'gpt-6.1-sol' } },
    [{ role: 'user', content: 'test' }], 1000, {
      signal,
      beforeCall() {
        starts++;
        Quota.reserve(data, { id, ownerKey, limitPoints: 10000, source: 'chatgpt', modelId: 'gpt-6.1-sol' });
        return id;
      },
      afterCall(callId, response, error) {
        finishes++; metadata = response; recordedError = error;
        settled = Quota.settle(data, callId, { usage: response?.usage, httpStatus: response?.httpStatus, error,
          cancelled: cancel || signal?.aborted || error?.name === 'AbortError' });
      },
    });
  await assert.rejects(result);
  assert.equal(starts, 1); assert.equal(finishes, 1);
  assert.equal(Quota.snapshot(data, { ownerKey, limitPoints: 10000 }).reservedPoints, 0);
  return { metadata, error: recordedError, settled };
}

test('共享订阅明确 HTTP 429 且未报告消耗时零扣点，并只结算一次', async () => {
  for (const usage of [undefined, { input_tokens: 0, output_tokens: 0 }]) {
    const { metadata, error, settled } = await call(async () => ({ status: 429, streaming: false,
      data: { error: { code: 'rate_limit_exceeded' }, ...(usage ? { usage } : {}) } }));
    assert.equal(error.code, 'chatgpt-rate-limited'); assert.equal(metadata.httpStatus, 429);
    assert.equal(settled.chargedCredits, 0); assert.equal(settled.estimated, false);
    assert.equal(settled.unbilledReason, 'http-429'); assert.equal(settled.status, 'failed');
  }
});

test('HTTP 429 已报告实际用量时保留用量，按现有规则收费而不误免扣', async () => {
  const usage = { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 800 } };
  for (const data of [{ usage }, { response: { usage } }]) {
    const { metadata, settled } = await call(async () => ({ status: 429, streaming: false,
      data: { error: { code: 'rate_limit_exceeded' }, ...data } }));
    assert.deepEqual(metadata.usage, usage); assert.equal(metadata.httpStatus, 429);
    assert.equal(settled.chargedCredits, 45000); assert.equal(settled.estimated, false);
    assert.equal(settled.unbilledReason, undefined);
  }
});

test('其他 HTTP 错误和网络失败仍按估算结算，不扩大限流免扣规则', async () => {
  const rejected = await call(async () => ({ status: 503, streaming: false, data: { error: {} } }));
  assert.equal(rejected.metadata.httpStatus, 503); assert.equal(rejected.settled.chargedCredits, 60000);
  assert.equal(rejected.settled.estimated, true); assert.equal(rejected.settled.unbilledReason, undefined);
  const offline = await call(async () => { throw Error('fixture disconnected'); });
  assert.equal(offline.metadata.httpStatus, undefined); assert.equal(offline.settled.chargedCredits, 60000);
});

test('中途失败保留流中已报告用量；明确取消仍保留原扣点规则', async () => {
  const usage = { input_tokens: 100, output_tokens: 100 };
  const streamed = await call(async (_url, _headers, _body, _timeout, options) => {
    options.onEvent({ data: JSON.stringify({ type: 'response.failed', response: { usage, error: { code: 'subscription_sharing_usage_limit_exceeded' } } }) });
    throw Error('unreachable');
  });
  assert.deepEqual(streamed.metadata.usage, usage); assert.equal(streamed.settled.chargedCredits, 18000);
  const controller = new AbortController();
  const cancelled = await call(async () => { controller.abort(); throw new DOMException('Aborted', 'AbortError'); }, { signal: controller.signal });
  assert.equal(cancelled.error.name, 'AbortError'); assert.equal(cancelled.settled.status, 'cancelled');
  assert.equal(cancelled.settled.chargedCredits, 60000); assert.equal(cancelled.settled.unbilledReason, undefined);
});

test('成功的订阅流仍只结算一次并保留最终用量', async () => {
  const usage = { input_tokens: 100, output_tokens: 100 };
  let starts = 0, finishes = 0;
  const runtime = { token: async () => 'fixture-token', account: () => ({ accessToken: 'fixture-token' }), controllers: new Map(),
    post: async (_url, _headers, _body, _timeout, options) => {
      options.onEvent({ data: JSON.stringify({ type: 'response.output_text.delta', delta: '已完成' }) });
      options.onEvent({ data: JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage } }) });
      return { status: 200, streaming: true };
    } };
  const result = await ChatGPTLocal.prototype.call.call(runtime,
    { accountId: 'fixture-account', providerName: 'Fixture subscription', model: { modelId: 'gpt-6.1-sol' } },
    [{ role: 'user', content: 'test' }], 1000, { beforeCall() { starts++; return 'success'; },
      afterCall(id, metadata, error) { finishes++; assert.equal(id, 'success'); assert.equal(error, null); assert.deepEqual(metadata.usage, usage); } });
  assert.equal(result.text, '已完成'); assert.equal(starts, 1); assert.equal(finishes, 1);
});
