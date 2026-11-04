'use strict';
const { validateUsage } = require('./file-protocol');
const count = value => Number.isSafeInteger(value) && value >= 0;
const sum = values => { const result = values.reduce((total, value) => total + value, 0); return count(result) ? result : undefined; };
function sample(usage) {
  if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)) return {};
  const read = usage.cacheReadTokens, write = usage.cacheWriteTokens, reasoning = usage.reasoningTokens;
  if (read !== undefined && !count(read) || write !== undefined && !count(write) || reasoning !== undefined && (!count(reasoning) || reasoning > usage.outputTokens)) return {};
  const knownPrompt = sum([usage.inputTokens, read || 0, write || 0]);
  if (knownPrompt === undefined) return {};
  let input = knownPrompt, exact = read !== undefined && write !== undefined;
  if (usage.totalTokens !== undefined) {
    if (!count(usage.totalTokens) || !count(usage.totalTokens - usage.outputTokens) || usage.totalTokens - usage.outputTokens < knownPrompt) return {};
    input = usage.totalTokens - usage.outputTokens;
    if (read !== undefined && write !== undefined && input !== knownPrompt) return {};
    exact = true;
  }
  // Optional cache buckets can be inferred as zero only when the authoritative
  // aggregate leaves no unknown prompt tokens.
  const noUnknownCache = input === knownPrompt;
  return { inputTokens: input, outputTokens: usage.outputTokens, exact,
    ...(read !== undefined || noUnknownCache ? { cachedInputTokens: read || 0 } : {}),
    ...(write !== undefined || noUnknownCache ? { cacheWriteInputTokens: write || 0 } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}) };
}
function streamSample(stream) {
  return Array.isArray(stream) ? stream.filter(item => item?.type === 'chunk' && item.chunk?.type === 'usage').at(-1)?.chunk.usage : undefined;
}
function createUsageMeter(saved) {
  const state = saved || { version: 1, started: false, ended: false, invalid: false, turn: null, seen: [], attempts: [], auxiliary: [], open: null };
  if (state.version !== 1 || !Array.isArray(state.seen) || !Array.isArray(state.attempts) || state.seen.length > 10000 || state.attempts.length > 1024) throw Error('Invalid usage receipt');
  state.auxiliary ||= [];
  if (!Array.isArray(state.auxiliary) || state.auxiliary.length > 1024) throw Error('Invalid auxiliary usage receipt');
  const seen = new Set(state.seen);
  let recognized = state.started || state.attempts.length > 0;
  function open(data) {
    if (state.open !== null || state.attempts.length >= 1024) { state.invalid = true; return; }
    state.attempts.push({ turn: data.turn, step: data.step, closed: false }); state.open = state.attempts.length - 1;
  }
  return {
    accept(event) {
      if (!event || !['turn/start', 'step/start', 'llm/retry-started', 'assistant/message', 'assistant/attempt', 'turn/end', 'compaction/start', 'compaction/summary', 'compaction/end'].includes(event.type)) return false;
      const data = event.data;
      if (event.type.startsWith('compaction/')) {
        if (!data || typeof data.compactionId !== 'string' || data.compactionId.length > 100) return false;
        recognized = true;
        const key = count(event.seq) ? String(event.seq) : event.type + ':' + data.compactionId;
        if (seen.has(key)) return false;
        seen.add(key); state.seen.push(key);
        if (state.seen.length > 10000) throw Error('Too many usage events');
        let auxiliary = state.auxiliary.find(item => item.id === data.compactionId);
        if (event.type === 'compaction/start') {
          if (auxiliary || data.turn !== state.turn || !state.started || state.ended) state.invalid = true;
          else { if (state.auxiliary.length >= 1024) throw Error('Too many auxiliary usage events'); state.auxiliary.push({ id: data.compactionId, summary: false, closed: false }); }
        } else if (!auxiliary || auxiliary.closed) state.invalid = true;
        else if (event.type === 'compaction/summary') {
          if (auxiliary.summary) state.invalid = true;
          else {
            auxiliary.summary = true;
            if (data.llmStreamCall === true) { if (state.attempts.length >= 1024) throw Error('Too many usage attempts'); state.attempts.push({ auxiliary: true, closed: true, ...sample(data.usage) }); }
          }
        } else {
          auxiliary.closed = true;
          if (!auxiliary.summary) { if (state.attempts.length >= 1024) throw Error('Too many usage attempts'); state.invalid = true; state.attempts.push({ auxiliary: true, closed: true }); }
        }
        return true;
      }
      // Legacy fixtures and old SDK transports have no durable lifecycle.
      if (!data || !count(data.turn) || (event.type !== 'turn/start' && event.type !== 'turn/end' && !count(data.step))) return false;
      recognized = true;
      const key = count(event.seq) ? String(event.seq) : event.type + ':' + data.turn + ':' + (data.step ?? '');
      if (seen.has(key)) return false;
      seen.add(key); state.seen.push(key);
      if (state.seen.length > 10000) throw Error('Too many usage events');
      if (event.type === 'turn/start') {
        if (state.started) state.invalid = true;
        state.started = true; state.turn = data.turn;
      } else if (data.turn !== state.turn || !state.started || state.ended) state.invalid = true;
      else if (event.type === 'step/start' || event.type === 'llm/retry-started') open(data);
      else if (event.type === 'turn/end') { state.ended = true; if (state.open !== null || state.auxiliary.some(item => !item.closed)) state.invalid = true; }
      else {
        let attempt = state.open === null ? null : state.attempts[state.open];
        // DSH's own token projection replaces the sample for one settled
        // turn/step unless a retry-started boundary opened another attempt.
        // A later durable sample must never charge that same call twice.
        const previous = state.attempts.at(-1);
        if (!attempt && previous?.closed && !previous.auxiliary && previous.turn === data.turn && previous.step === data.step) attempt = previous;
        if (!attempt || attempt.turn !== data.turn || attempt.step !== data.step) {
          state.invalid = true; open(data); attempt = state.open === null ? null : state.attempts[state.open];
        }
        if (attempt) {
          const raw = data.usage ?? streamSample(data.stream);
          if (raw !== undefined || !attempt.closed) {
            for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens', 'exact']) delete attempt[key];
            Object.assign(attempt, sample(raw));
          }
          attempt.closed = true; state.open = null;
        }
      }
      return true;
    },
    snapshot() {
      if (!recognized) return undefined;
      const usage = { calls: state.attempts.length, complete: state.started && state.ended && !state.invalid && state.open === null && state.auxiliary.every(item => item.closed) && state.attempts.every(attempt => attempt.closed && attempt.exact) };
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'reasoningTokens']) {
        const values = state.attempts.map(attempt => attempt[key]);
        const available = ['inputTokens', 'outputTokens'].includes(key) ? values.some(count) : values.every(count);
        if (values.length && available) { const total = sum(values.filter(count)); if (total !== undefined) usage[key] = total; else usage.complete = false; }
      }
      if (usage.calls === 0 && usage.complete) Object.assign(usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0 });
      if (!validateUsage(usage)) throw Error('Invalid aggregate usage');
      return usage;
    },
    state() { return state; },
  };
}
module.exports = { createUsageMeter };
