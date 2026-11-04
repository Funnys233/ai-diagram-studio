'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createUsageMeter } = require('../../services/dsh-bridge/usage');
const { validateUsage, validateModelSelection, taskCapability, verifyTaskCapability, fingerprint, digest } = require('../../services/dsh-bridge/file-protocol');
const event = (seq, type, data) => ({ seq, type, data: { turn: 1, ...data } });
test('DSH disjoint cache buckets become aggregate input once; reasoning remains part of output', () => {
  const meter = createUsageMeter();
  for (const item of [event(1, 'turn/start'), event(2, 'step/start', { step: 1 }), event(3, 'assistant/message', { step: 1, usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 20, outputTokens: 80, reasoningTokens: 50, totalTokens: 240 } }), event(4, 'turn/end')]) meter.accept(item);
  assert.deepEqual(meter.snapshot(), { calls: 1, complete: true, inputTokens: 160, outputTokens: 80, cachedInputTokens: 40, cacheWriteInputTokens: 20, reasoningTokens: 50 });
  const restored = createUsageMeter(JSON.parse(JSON.stringify(meter.state()))); assert.deepEqual(restored.snapshot(), meter.snapshot());
  assert.equal(restored.accept(event(3, 'assistant/message', { step: 1, usage: { inputTokens: 999, outputTokens: 999 } })), false);
  assert.equal(restored.snapshot().inputTokens, 160);
});
test('all tools and failed retry attempts are counted as separate calls, taking only the last stream usage snapshot', () => {
  const meter = createUsageMeter();
  const events = [event(1, 'turn/start'), event(2, 'step/start', { step: 1 }),
    event(3, 'assistant/attempt', { step: 1, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } } }, { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } }] }),
    event(4, 'llm/retry-started', { step: 1 }), event(5, 'assistant/message', { step: 1, usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } }),
    event(6, 'step/start', { step: 2 }), event(7, 'assistant/message', { step: 2, usage: { inputTokens: 30, outputTokens: 4, totalTokens: 34 } }), event(8, 'turn/end')];
  events.forEach(item => meter.accept(item));
  assert.deepEqual(meter.snapshot(), { calls: 3, complete: true, inputTokens: 60, outputTokens: 9, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
  const followup = createUsageMeter(); assert.equal(followup.snapshot(), undefined);
});
test('a later sample for the same settled turn and step replaces that attempt rather than charging twice', () => {
  const meter = createUsageMeter();
  [event(1, 'turn/start'), event(2, 'step/start', { step: 1 }), event(3, 'assistant/message', { step: 1, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
    event(4, 'assistant/message', { step: 1, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } }), event(5, 'turn/end')].forEach(value => meter.accept(value));
  assert.deepEqual(meter.snapshot(), { calls: 1, complete: true, inputTokens: 12, outputTokens: 3, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
});
test('missing usage, interrupted calls and inconsistent totals remain incomplete rather than fabricating zero consumption', () => {
  const partial = createUsageMeter(); partial.accept(event(1, 'turn/start')); partial.accept(event(2, 'step/start', { step: 1 }));
  assert.deepEqual(partial.snapshot(), { calls: 1, complete: false });
  partial.accept(event(3, 'assistant/message', { step: 1 })); partial.accept(event(4, 'turn/end'));
  assert.deepEqual(partial.snapshot(), { calls: 1, complete: false });
  for (const bad of [{ inputTokens: 10, outputTokens: 3, totalTokens: 12 }, { inputTokens: 10, outputTokens: -3 }, { inputTokens: 10, outputTokens: 3, reasoningTokens: 4 }]) {
    const meter = createUsageMeter(); meter.accept(event(1, 'turn/start')); meter.accept(event(2, 'step/start', { step: 1 }));
    meter.accept(event(3, 'assistant/message', { step: 1, usage: bad })); meter.accept(event(4, 'turn/end'));
    assert.equal(meter.snapshot().complete, false); assert.equal(meter.snapshot().inputTokens, undefined);
  }
});
test('authoritative totals preserve aggregate input when an optional cache bucket is not exposed', () => {
  const meter = createUsageMeter(); meter.accept(event(1, 'turn/start')); meter.accept(event(2, 'step/start', { step: 1 }));
  meter.accept(event(3, 'assistant/message', { step: 1, usage: { inputTokens: 10, outputTokens: 3, totalTokens: 33 } })); meter.accept(event(4, 'turn/end'));
  assert.deepEqual(meter.snapshot(), { calls: 1, complete: true, inputTokens: 30, outputTokens: 3 });
});
test('automatic compaction model usage is counted once and a failed auxiliary call stays incomplete', () => {
  const meter = createUsageMeter(), events = [event(1, 'turn/start'), event(2, 'compaction/start', { compactionId: 'compact-1' }),
    { seq: 3, type: 'compaction/summary', data: { compactionId: 'compact-1', llmStreamCall: true, usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } } },
    event(4, 'compaction/end', { compactionId: 'compact-1' }), event(5, 'step/start', { step: 1 }), event(6, 'assistant/message', { step: 1, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }), event(7, 'turn/end')];
  events.forEach(item => meter.accept(item)); meter.accept(events[2]);
  assert.deepEqual(meter.snapshot(), { calls: 2, complete: true, inputTokens: 110, outputTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
  const failed = createUsageMeter(); failed.accept(event(1, 'turn/start')); failed.accept(event(2, 'compaction/start', { compactionId: 'compact-fail' }));
  failed.accept(event(3, 'compaction/end', { compactionId: 'compact-fail', error: 'not retained' })); failed.accept(event(4, 'turn/end'));
  assert.deepEqual(failed.snapshot(), { calls: 1, complete: false }); assert.ok(!JSON.stringify(failed.state()).includes('not retained'));
});
test('selection identity and task capability cannot swap a model, task or secret', () => {
  const selected = { providerId: 'platform:relay', modelId: 'gpt-6.1-sol' }, body = { conversationId: 'conversation', prompt: 'task' };
  assert.equal(validateModelSelection(selected), true);
  for (const value of [{ ...selected, apiKey: 'secret' }, { ...selected, providerId: 'https://outside.example' }, { ...selected, modelId: ['gpt-6.1-sol'] }]) assert.equal(Boolean(validateModelSelection(value)), false);
  assert.notEqual(fingerprint(digest('owner'), body), fingerprint(digest('owner'), { ...body, modelSelection: selected }));
  assert.notEqual(fingerprint(digest('owner'), { ...body, modelSelection: selected }), fingerprint(digest('owner'), { ...body, modelSelection: { ...selected, modelId: 'gpt-6-astra' } }));
  const token = taskCapability('shared-gateway-fixture-secret', 'task-1');
  assert.equal(verifyTaskCapability('shared-gateway-fixture-secret', token), 'task-1');
  assert.equal(verifyTaskCapability('wrong-shared-secret', token), null);
  assert.equal(verifyTaskCapability('shared-gateway-fixture-secret', token.replace('task-1', 'task-2')), null);
  assert.equal(verifyTaskCapability('shared-gateway-fixture-secret', token + 'x'), null);
  assert.equal(validateUsage({ calls: 1, complete: true }), false);
});
