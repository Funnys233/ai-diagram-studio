// Drawing task transport: reconnect to the same server job; only an explicit
// cancel request stops generation. No prompt or credentials are stored here.
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.DiagramDrawingTasks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
  function create({ fetch, createParser, onReconnect = () => {}, timeoutMs = 15000, idleMs = 120000, retryMs = 1500 }) {
    async function json(path, body, signal) {
      const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      const timer = setTimeout(abort, timeoutMs);
      try {
        const response = await fetch(path, { signal: controller.signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error?.message || '生成任务请求失败'), { httpStatus: response.status, taskTerminal: [400,403,409,410,429].includes(response.status), turnUsage: data.turnUsage });
        return data;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    function pause(signal, ms = retryMs) {
      return new Promise(resolve => {
        const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true }); if (signal?.aborted) done();
      });
    }
    function result(task, paint) {
      paint(task);
      if (!terminal.has(task.status)) return null;
      if (task.status === 'succeeded') return task;
      throw Object.assign(new Error(task.error?.message || '生成已结束，未应用图表'), { code: task.error?.code, taskTerminal: true, turnUsage: task.turnUsage });
    }
    async function events(id, signal, paint) {
      const controller = new AbortController(), abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      let timer = setTimeout(abort, timeoutMs), reader;
      try {
        const response = await fetch('/api/drawing/tasks/' + id + '/events', { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
          const data = await response.json();
          if (!response.ok) throw Object.assign(new Error(data.error?.message || '连接生成任务失败'), { httpStatus: response.status, taskTerminal: [400,403,410].includes(response.status) });
          return result(data.task || data, paint);
        }
        reader = response.body.getReader(); const decoder = new TextDecoder(); let answer = null, failure = null;
        const parser = createParser(event => {
          const data = JSON.parse(event.data);
          try {
            if (event.event === 'snapshot') answer = result(data, paint) || answer;
            else if (event.event === 'progress') paint({ phase: data });
            else if (event.event === 'result') answer = result({ ...data, status: 'succeeded' }, paint);
            else if (event.event === 'error') failure = Object.assign(new Error(data.error?.message || '生成失败'), { taskTerminal: data.taskTerminal === true, code: data.error?.code, turnUsage: data.turnUsage });
          } catch (error) { failure = error; }
        });
        while (!answer && !failure) {
          timer = setTimeout(() => { abort(); void reader.cancel().catch(() => {}); }, idleMs);
          const chunk = await reader.read(); clearTimeout(timer);
          if (chunk.done) break;
          parser.push(decoder.decode(chunk.value, { stream: true }));
        }
        parser.push(decoder.decode()); if (failure) throw failure;
        if (!answer) throw new Error('生成连接中断'); return answer;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } }
    }
    async function follow(task, { body, signal, paint = () => {} } = {}) {
      let accepted = false;
      if (body) {
        try { const data = await json('/api/drawing/tasks', body, signal); accepted = true; const answer = result(data.task, paint); if (answer) return answer; }
        catch (error) { if (signal?.aborted || error.taskTerminal || error.httpStatus === 401) throw error; }
      }
      // Never retry POST after an uncertain response, even after a refresh.
      let missing = 0;
      while (!signal?.aborted) {
        try {
          if (!accepted) {
            const data = await json('/api/drawing/tasks/' + task.taskId, undefined, signal); accepted = true;
            const answer = result(data.task, paint); if (answer) return answer;
          }
          return await events(task.taskId, signal, paint);
        } catch (error) {
          if (signal?.aborted || error.taskTerminal || error.httpStatus === 401) throw error;
          if (error.httpStatus === 404 && ++missing >= 4) throw Object.assign(new Error('尚未找到此任务。任务编号已保留，请恢复任务确认，避免重复发送。'), { taskUnconfirmed: true });
          onReconnect(error); await pause(signal);
        }
      }
      throw Object.assign(new Error('页面连接已断开，服务器任务会继续'), { name: 'AbortError' });
    }
    return { follow, cancel: id => json('/api/drawing/tasks/' + id + '/cancel', {}), acknowledge: id => json('/api/drawing/tasks/' + id + '/ack', {}) };
  }
  return { create };
});
