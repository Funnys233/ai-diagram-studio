'use strict';
const fs = require('node:fs'), path = require('node:path'), { EventEmitter } = require('node:events');
const { atomic } = require('./cloud-runtime');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
class TaskError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }

class ConversationTasks {
  constructor({ directory, codec = { encode: JSON.stringify, decode: JSON.parse }, retentionMs = 86400000, maxRunMs = 1800000, flushMs = 200, maxOutputChars = 100000, progressPhases = ['waiting', 'thinking', 'generating', 'buffered'], now = Date.now } = {}) {
    this.directory = directory; this.codec = codec; this.retentionMs = retentionMs; this.maxRunMs = maxRunMs; this.flushMs = flushMs; this.now = now;
    this.maxOutputChars = maxOutputChars; this.progressPhases = new Set(progressPhases);
    this.jobs = new Map(); this.running = new Map(); this.events = new EventEmitter(); this.events.setMaxListeners(100);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.enc$/.test(file)) continue;
      const job = codec.decode(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (!UUID.test(job.id) || file !== job.id + '.enc' || job.version !== 1 || typeof job.ownerId !== 'string' || typeof job.reply !== 'string') throw Error('生成任务存储格式无效，原文件保持不变');
      if (job.status === 'running') {
        job.status = 'interrupted'; job.error = { code: 'task-interrupted', message: '服务器重启，本轮生成已中断。已保留收到的内容，不会自动重新调用模型。' };
        job.completedAt = now(); job.expiresAt = now() + retentionMs; this.write(job);
      }
      this.jobs.set(job.id, job);
    }
    this.sweep(); this.cleaner = setInterval(() => this.sweep(), 60000); this.cleaner.unref();
  }
  write(job) { atomic(path.join(this.directory, job.id + '.enc'), this.codec.encode(job)); }
  lookup(ownerId, id) {
    if (!UUID.test(id)) throw new TaskError(400, 'invalid-task-id', '生成任务标识无效');
    this.sweep(); const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw new TaskError(404, 'task-not-found', '此任务不存在或已过期，请查看本地已保存内容。');
    if (job.status === 'acknowledged') throw new TaskError(410, 'task-released', '本轮结果已保存到浏览器，服务器临时正文已清理。');
    return job;
  }
  existing(ownerId, id, fingerprint) {
    this.sweep();
    const job = this.jobs.get(id); if (!job) return null;
    if (job.ownerId !== ownerId) throw new TaskError(409, 'task-conflict', '任务标识已使用，请开始新的一轮。');
    if (job.fingerprint !== fingerprint) throw new TaskError(409, 'task-conflict', '同一任务不能更换问题或模型，请开始新的一轮。');
    if (job.status === 'acknowledged') throw new TaskError(410, 'task-released', '本轮已经完成并保存，请查看本地对话。');
    return this.snapshot(job);
  }
  snapshot(job) {
    return { taskId: job.id, threadId: job.threadId, assistantId: job.assistantId, status: job.status, reply: job.reply,
      phase: job.phase, startedAt: job.startedAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt || null,
      ...(job.result || {}), ...(job.error ? { error: job.error } : {}) };
  }
  flush(job) {
    const runtime = this.running.get(job.id); if (runtime?.flushTimer) { clearTimeout(runtime.flushTimer); runtime.flushTimer = null; }
    this.write(job); this.events.emit(job.id, this.snapshot(job));
  }
  dirty(job) {
    const runtime = this.running.get(job.id); if (!runtime || runtime.flushTimer) return;
    runtime.flushTimer = setTimeout(() => {
      runtime.flushTimer = null;
      try { this.flush(job); } catch { runtime.storageFailed = true; runtime.controller.abort(); }
    }, this.flushMs);
  }
  create({ id, ownerId, fingerprint, threadId, assistantId, controller = new AbortController(), run, safeError = () => ({ code: 'task-failed', message: '生成未完成，请稍后重试。' }), receipt, release = () => {} }) {
    if (![id, threadId, assistantId].every(value => typeof value === 'string' && UUID.test(value))) throw new TaskError(400, 'invalid-task-id', '生成任务或消息标识无效');
    const previous = this.existing(ownerId, id, fingerprint); if (previous) { release(); return previous; }
    const retained = [...this.jobs.values()].filter(job => job.status !== 'acknowledged');
    if (retained.length >= 500 || retained.filter(job => job.ownerId === ownerId).length >= 50) throw new TaskError(429, 'task-capacity', '暂存结果过多，请先打开并保存已有回复后重试。');
    const job = { version: 1, id, ownerId, fingerprint, threadId, assistantId, status: 'running', reply: '', phase: { phase: 'waiting' }, startedAt: this.now(), updatedAt: this.now() };
    this.write(job); this.jobs.set(id, job);
    const runtime = { controller, flushTimer: null, cancelRequested: false, timedOut: false, storageFailed: false };
    this.running.set(id, runtime);
    runtime.deadline = setTimeout(() => { runtime.timedOut = true; controller.abort(); }, this.maxRunMs); runtime.deadline.unref();
    runtime.promise = Promise.resolve().then(() => run({ signal: controller.signal,
      onText: text => { if (typeof text !== 'string' || !text) return; if (job.reply.length + text.length > this.maxOutputChars) throw new TaskError(502, 'output-too-large', '本轮输出超过大小限制。'); job.reply += text; job.updatedAt = this.now(); this.dirty(job); },
      onProgress: progress => { if (!this.progressPhases.has(progress?.phase)) return; if (job.phase.phase === progress.phase) return; job.phase = { phase: progress.phase }; job.updatedAt = this.now(); this.dirty(job); },
    })).then(result => {
      if (typeof result?.reply !== 'string' || result.reply.length > this.maxOutputChars) throw new TaskError(502, 'output-too-large', '生成结果超过大小限制或格式不完整。');
      controller.signal.throwIfAborted(); job.status = 'succeeded'; job.reply = result.reply;
      const { reply, ...metadata } = result; job.result = metadata;
    }).catch(error => {
      job.status = runtime.interrupted ? 'interrupted' : runtime.cancelRequested ? 'cancelled' : 'failed';
      job.error = runtime.storageFailed ? { code: 'task-storage', message: '服务器暂存失败，生成已停止，请保留当前正文。' }
        : runtime.interrupted ? { code: 'task-interrupted', message: '服务器重启，本轮生成已中断。已保留收到的内容，不会自动重新调用模型。' }
        : runtime.timedOut ? { code: 'task-timeout', message: '本轮生成超过 30 分钟，已停止并保留收到的内容。' }
        : runtime.cancelRequested ? { code: 'task-cancelled', message: '已取消生成，已保留收到的内容。' }
        : safeError(error);
    }).finally(() => {
      clearTimeout(runtime.deadline); clearTimeout(runtime.flushTimer); runtime.flushTimer = null;
      job.completedAt = this.now(); job.updatedAt = this.now(); job.expiresAt = this.now() + this.retentionMs;
      try { const usage = receipt?.(); if (usage) job.result = { ...job.result, turnUsage: usage }; } catch { /* Usage can be reconciled separately. */ }
      release(); this.running.delete(id);
      try { this.flush(job); } catch { job.status = 'failed'; job.error = { code: 'task-storage', message: '服务器未能保存最终结果，请保留当前正文。' }; this.events.emit(id, this.snapshot(job)); }
    });
    return this.snapshot(job);
  }
  get(ownerId, id) { const job = this.lookup(ownerId, id); if (this.running.has(id)) this.flush(job); return this.snapshot(job); }
  subscribe(ownerId, id, listener) {
    const job = this.lookup(ownerId, id); const fn = snapshot => listener(snapshot);
    if (this.events.listenerCount(id) >= 10) throw new TaskError(429, 'task-listeners', '此任务打开的页面过多，请关闭部分页面后重试。');
    this.events.on(id, fn);
    try { if (this.running.has(id)) this.flush(job); else listener(this.snapshot(job)); }
    catch (error) { this.events.off(id, fn); throw error; }
    return () => this.events.off(id, fn);
  }
  cancel(ownerId, id) { const job = this.lookup(ownerId, id), runtime = this.running.get(id); if (runtime) { runtime.cancelRequested = true; runtime.controller.abort(); } return this.snapshot(job); }
  acknowledge(ownerId, id) {
    const stored = this.jobs.get(id); if (stored?.ownerId === ownerId && stored.status === 'acknowledged') return;
    const job = this.lookup(ownerId, id); if (!TERMINAL.has(job.status)) throw new TaskError(409, 'task-running', '本轮尚未结束，不能清理生成结果。');
    const tombstone = { version: 1, id, ownerId, fingerprint: job.fingerprint, status: 'acknowledged', reply: '', expiresAt: job.expiresAt };
    this.write(tombstone); this.jobs.set(id, tombstone);
  }
  sweep() { for (const [id, job] of this.jobs) if (job.status !== 'running' && job.expiresAt <= this.now()) { try { fs.unlinkSync(path.join(this.directory, id + '.enc')); this.jobs.delete(id); } catch { /* Retry next minute. */ } } }
  async close() { clearInterval(this.cleaner); for (const runtime of this.running.values()) { runtime.interrupted = true; runtime.controller.abort(); } await Promise.all([...this.running.values()].map(runtime => runtime.promise)); }
}
module.exports = { ConversationTasks, TaskError };
