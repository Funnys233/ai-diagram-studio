'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomic } = require('./cloud-runtime');
const { TaskError } = require('./conversation-tasks');
const { AgentFiles } = require('./agent-files');
const { AgentHistory, pageOptions, paginate } = require('./agent-history');
const { fingerprint: remoteFingerprint, digest, validateModelSelection, validateUsage } = require('../services/dsh-bridge/file-protocol');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const validId = value => typeof value === 'string' && UUID.test(value);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'rejected']);
const RUNNING = new Set(['submitting', 'running', 'cancelling', 'unknown']);
const ACTIVE = new Set(['queued', ...RUNNING]);
const uncertain = '连接暂时中断，服务器正在核对任务；请勿重复提交。';
const problem = (status, code, message) => new TaskError(status, code, message);
const completeContext = turns => turns.every((turn, index) => index === 0 ? !turn.parentTaskId && (turn.turnIndex || 1) === 1 : turn.parentTaskId === turns[index - 1].id && turn.turnIndex === index + 1);

class AgentTasks {
  constructor({ directory, client, enabled = false, codec = { encode: JSON.stringify, decode: JSON.parse }, maxConcurrent = 2, retentionMs = 86400000, pollMs = 1500, now = Date.now, restoreLease, meter, queueEnabled = false, prepareQueued, acquireQueued, maxQueued = 50, maxQueueMs = 86400000, historyEnabled = false } = {}) {
    this.directory = directory; this.client = client; this.enabled = enabled; this.codec = codec; this.maxConcurrent = maxConcurrent; this.retentionMs = retentionMs; this.now = now;
    this.jobs = new Map(); this.leases = new Map(); this.operations = new Map(); this.removing = new Set(); this.capabilityChecks = new Map(); this.closed = false;
    this.files = new AgentFiles({ directory: path.join(directory, 'files'), codec, now });
    this.historyEnabled = historyEnabled;
    this.history = historyEnabled ? new AgentHistory({ directory: path.join(directory, 'history'), codec, now, retentionMs }) : null;
    this.meter = meter;
    this.queueEnabled = queueEnabled; this.prepareQueued = prepareQueued; this.acquireQueued = acquireQueued; this.maxQueued = maxQueued; this.maxQueueMs = maxQueueMs; this.queueSequence = 0; this.dispatching = null; this.scheduleRequested = false;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 6) throw Error('Invalid agent concurrency');
    if (typeof queueEnabled !== 'boolean' || queueEnabled && (typeof prepareQueued !== 'function' || typeof acquireQueued !== 'function') || !Number.isInteger(maxQueued) || maxQueued < 1 || maxQueued > 500 || !Number.isSafeInteger(maxQueueMs) || maxQueueMs < 1000 || maxQueueMs > 7 * 86400000) throw Error('Invalid agent queue configuration');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const file of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.enc$/.test(file)) continue;
      const job = codec.decode(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (!validId(job.id) || file !== job.id + '.enc' || job.version !== 1 || !validId(job.conversationId) || (job.parentTaskId !== undefined && !validId(job.parentTaskId)) || typeof job.ownerId !== 'string' || typeof job.prompt !== 'string' || typeof job.output !== 'string' || ![...ACTIVE, ...TERMINAL, 'released'].includes(job.status)) throw Error('智能任务存储格式无效，原文件保持不变');
      if (job.queueOrder !== undefined && (!Number.isSafeInteger(job.queueOrder) || job.queueOrder < 1)) throw Error('智能任务排队记录无效，原文件保持不变');
      this.queueSequence = Math.max(this.queueSequence, job.queueOrder || 0);
      if (RUNNING.has(job.status)) { job.status = 'unknown'; job.message = uncertain; this.write(job); }
      // Read one terminal body at a time on startup; a long archive must not
      // temporarily load every saved result into the in-memory task index.
      this.archive(job);
      this.jobs.set(job.id, job);
      if (RUNNING.has(job.status) && restoreLease) this.leases.set(job.id, restoreLease(job.ownerId));
    }
    if (this.history) {
      for (const job of [...this.jobs.values()].filter(j => j.status !== 'released').sort((a, b) => a.createdAt - b.createdAt || (a.turnIndex || 1) - (b.turnIndex || 1))) {
        const meta = this.history.ensure(job);
        if (job.updatedAt > meta.updatedAt) this.history.touch(job);
      }
      // Metadata is authoritative after a crash between pinning a conversation
      // and renewing its per-turn/file expiry. Repair before any cleanup.
      for (const meta of this.history.records.values()) {
        for (const job of this.turns(meta.ownerId, meta.conversationId)) if (job.status !== 'released') job.expiresAt = meta.expiresAt;
        this.files.retain(meta.ownerId, meta.conversationId, meta.expiresAt);
      }
      for (const job of this.jobs.values()) this.archive(job);
    }
    this.meter?.recover?.(this.jobs);
    this.sweep();
    this.timer = setInterval(() => { this.sweep(); this.expireQueued(); for (const job of this.jobs.values()) if (RUNNING.has(job.status)) void this.reconcile(job).catch(() => {}); void this.schedule(); }, pollMs); this.timer.unref();
    if (queueEnabled) queueMicrotask(() => void this.schedule());
  }
  full(job) {
    if (!this.historyEnabled || !job.archived || job.status === 'released') return job;
    const location = path.join(this.directory, job.id + '.enc'), info = fs.lstatSync(location);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw Error('Invalid archived task');
    const stored = this.codec.decode(fs.readFileSync(location, 'utf8'));
    if (stored.id !== job.id || stored.ownerId !== job.ownerId || stored.conversationId !== job.conversationId) throw Error('History task identity changed');
    return { ...job, prompt: stored.prompt, output: stored.output };
  }
  archive(job) {
    if (this.historyEnabled && TERMINAL.has(job.status)) Object.assign(job, { archived: true, hasOutput: Boolean(job.output || job.hasOutput), prompt: job.prompt.slice(0, 120), output: '' });
  }
  write(job) { atomic(path.join(this.directory, job.id + '.enc'), this.codec.encode(this.full(job))); }
  update(job, patch) {
    const next = { ...job, ...patch, updatedAt: this.now() };
    // An SDK process can stop before its independent gateway HTTP request has
    // finished accounting. Keep the lease until that live callback commits.
    if (TERMINAL.has(next.status) && this.meter?.hasLiveCall?.(job)) {
      next.status = 'unknown'; next.message = '正在核对最后一次模型调用的用量，请稍候。';
    }
    if (TERMINAL.has(next.status) && !next.expiresAt) next.expiresAt = this.now() + this.retentionMs;
    if (TERMINAL.has(next.status)) { const quota = this.meter?.settle(next, next); if (quota) next.quota = quota; }
    if (TERMINAL.has(next.status)) next.modelLock = null;
    if (this.historyEnabled && next.status === 'released') next.expiresAt = this.now() + 7 * 86400000;
    this.write(next); Object.assign(job, next);
    if (TERMINAL.has(job.status)) { this.leases.get(job.id)?.release(); this.leases.delete(job.id); }
    if (TERMINAL.has(job.status)) this.retainConversation(job);
    this.archive(job);
    if (TERMINAL.has(job.status) && this.queueEnabled) queueMicrotask(() => void this.schedule());
  }
  view(job, summaryOnly = false) { const value = summaryOnly ? job : this.full(job); const { id, conversationId, prompt, output, status, message, createdAt, updatedAt, expiresAt, recoveryReason, parentTaskId, turnIndex, continuationAvailable, attachments, artifacts, modelSelection, usage } = value; const quota = this.meter?.view(job) || job.quota; return { id, conversationId, prompt, output, status, message, createdAt, updatedAt, expiresAt: expiresAt || null, ...(status === 'queued' ? { queuePosition: this.queued().findIndex(item => item.id === id) + 1, queueExpiresAt: createdAt + this.maxQueueMs } : {}), ...(recoveryReason ? { recoveryReason } : {}), ...(parentTaskId ? { parentTaskId } : {}), ...(attachments?.length ? { attachments } : {}), ...(artifacts?.length ? { artifacts } : {}), ...(modelSelection ? { modelSelection } : {}), ...(usage ? { usage } : {}), ...(quota ? { quota } : {}), turnIndex: turnIndex || 1, continuationAvailable: continuationAvailable === true }; }
  queued() { return [...this.jobs.values()].filter(job => job.status === 'queued').sort((a, b) => a.queueOrder - b.queueOrder || a.createdAt - b.createdAt || a.id.localeCompare(b.id)); }
  expireQueued() {
    for (const job of this.queued()) if (job.createdAt + this.maxQueueMs <= this.now()) this.update(job, { status: 'rejected', message: '排队等待已超时，请新建任务后重试。', dispatchState: 'prepared', usage: { calls: 0, complete: true, inputTokens: 0, outputTokens: 0 } });
  }
  schedule() {
    if (!this.queueEnabled || this.closed || this.storageFailed || this.files.failed) return Promise.resolve();
    if (this.dispatching) { this.scheduleRequested = true; return this.dispatching; }
    this.dispatching = Promise.resolve().then(async () => {
      this.expireQueued();
      if (!this.queued().length || [...this.jobs.values()].filter(job => RUNNING.has(job.status)).length >= this.maxConcurrent) return;
      const ready = await this.status(this.queued()[0].ownerId);
      if (!ready.available || this.closed || this.storageFailed) return;
      let remoteSlots = Math.max(0, (ready.queue?.maxConcurrent || this.maxConcurrent) - (ready.executionActive ?? [...this.jobs.values()].filter(job => RUNNING.has(job.status)).length));
      for (const job of this.queued()) {
        if (this.closed || this.storageFailed || this.files.failed) break;
        if (remoteSlots < 1 || [...this.jobs.values()].filter(item => RUNNING.has(item.status)).length >= this.maxConcurrent) break;
        let context;
        try { context = await this.prepareQueued(job); }
        catch (error) {
          if (job.status !== 'queued' || this.closed) continue;
          if (error.status >= 500 || error.status === undefined) { this.update(job, { message: '暂时无法核对执行条件，任务仍在排队。' }); continue; }
          this.update(job, { status: 'rejected', message: error.message || '任务权限已变化，请重新提交。', dispatchState: 'prepared', usage: { calls: 0, complete: true, inputTokens: 0, outputTokens: 0 } }); continue;
        }
        if (job.status !== 'queued' || this.closed || this.storageFailed || this.jobs.get(job.id) !== job) continue;
        if (job.createdAt + this.maxQueueMs <= this.now()) { this.expireQueued(); continue; }
        let lease;
        try {
          if (job.modelSelection && (!context?.modelSelection || context.modelSelection.providerId !== job.modelSelection.providerId || context.modelSelection.modelId !== job.modelSelection.modelId)) throw problem(409, 'agent-model-changed', '排队模型已变化，请新建任务。');
          const documents = job.attachmentIds?.length ? this.files.prepare(job.ownerId, job.attachmentIds, job.conversationId) : [];
          this.files.claim(job.ownerId, job.attachmentIds || [], job.conversationId, job.id, this.history?.get(job.ownerId, job.conversationId)?.pinned ? null : this.now() + this.retentionMs);
          const wire = { id: job.id, conversationId: job.conversationId, prompt: job.prompt, ...(job.parentTaskId ? { parentTaskId: job.parentTaskId } : {}), ...(documents.length ? { documents } : {}), ...(job.modelSelection ? { modelSelection: { providerId: job.modelSelection.providerId, modelId: job.modelSelection.modelId } } : {}) };
          if (remoteFingerprint(digest(job.ownerId), wire) !== job.remoteFingerprint) throw problem(409, 'agent-queue-context-changed', '排队资料与原任务不一致，请重新提交。');
          if (ready.filesAvailable) this.files.reserve(job.ownerId, [...this.jobs.values()].filter(item => RUNNING.has(item.status)).length);
          lease = this.acquireQueued(job.ownerId, job);
          if (!lease || typeof lease.release !== 'function') throw Error('Invalid queued task lease');
          this.leases.set(job.id, lease);
          this.update(job, { status: 'submitting', message: '正在提交到执行服务器…', ...(context?.modelSelection ? { modelSelection: context.modelSelection, modelLock: context.modelLock } : {}), startedAt: this.now(), dispatchState: 'prepared', gatewayStarted: 0, gatewayCompleted: 0 });
          const quota = this.meter?.reserve(job); if (quota) job.quota = quota;
          this.update(job, { dispatchState: 'armed' });
          remoteSlots--;
          this.operation(job, async () => {
            try { this.apply(job, await this.client.submit(job.ownerId, wire)); }
            catch (error) {
              if (['agent-upstream-401', 'agent-upstream-404', 'agent-upstream-409', 'agent-upstream-410', 'agent-upstream-429', 'agent-upstream-503'].includes(error.code)) this.update(job, { status: 'rejected', message: error.message });
              else this.update(job, { status: 'unknown', message: uncertain });
            }
          });
        } catch (error) {
          if (!lease && ['concurrency-limit', 'agent-busy'].includes(error.code)) continue;
          if (this.closed) { lease?.release(); this.leases.delete(job.id); break; }
          if (!lease && error.status >= 500) { this.update(job, { message: '暂时无法准备任务，仍在排队。' }); continue; }
          try { this.update(job, { status: 'rejected', message: error.message || '任务暂未执行，请重新提交。', dispatchState: 'prepared', usage: { calls: 0, complete: true, inputTokens: 0, outputTokens: 0 } }); }
          catch { this.storageFailed = true; lease?.release(); this.leases.delete(job.id); }
        }
      }
    }).catch(() => { this.storageFailed = true; }).finally(() => {
      this.dispatching = null;
      if (this.scheduleRequested) { this.scheduleRequested = false; if (!this.closed) queueMicrotask(() => void this.schedule()); }
    });
    return this.dispatching;
  }
  turns(ownerId, conversationId) {
    return [...this.jobs.values()].filter(j => j.ownerId === ownerId && j.conversationId === conversationId).sort((a, b) => (a.turnIndex || 1) - (b.turnIndex || 1) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  retainConversation(job) {
    const expiresAt = this.history ? this.history.touch(job).expiresAt : this.now() + this.retentionMs;
    for (const turn of this.turns(job.ownerId, job.conversationId)) if (TERMINAL.has(turn.status) && turn.expiresAt !== expiresAt) {
      this.write({ ...turn, expiresAt }); turn.expiresAt = expiresAt;
    }
    this.files.retain(job.ownerId, job.conversationId, expiresAt);
  }
  conversation(ownerId, conversationId) {
    if (!validId(conversationId)) throw problem(400, 'invalid-conversation-id', '会话标识无效。');
    this.sweep();
    const turns = this.turns(ownerId, conversationId);
    if (!turns.length || turns.every(j => j.status === 'released')) throw problem(404, 'agent-conversation-not-found', '会话不存在或已过期。');
    const latest = turns.at(-1);
    let continuationBlockedReason = '';
    if (turns.some(j => j.clearing)) continuationBlockedReason = '会话正在清理，请完成清理后新建任务。';
    else if (turns.some(j => j.status === 'released') || !completeContext(turns)) continuationBlockedReason = '部分上下文已清理或过期，请新建任务。';
    else if (turns.some(j => ACTIVE.has(j.status))) continuationBlockedReason = '请等待当前任务结束后继续追问。';
    else if (turns.length >= 20) continuationBlockedReason = '本次会话已达到 20 轮，请新建任务。';
    else if (latest.continuationExpired) continuationBlockedReason = '执行上下文已过期，历史结果仍可查看；继续处理请新建任务。';
    else if ((!latest.output && !latest.hasOutput && !latest.artifacts?.length) || latest.status === 'rejected' || !latest.continuationAvailable) continuationBlockedReason = '当前会话暂时无法继续，请新建任务。';
    const meta = this.history?.get(ownerId, conversationId);
    return { conversationId, ...(meta ? { title: meta.title, pinned: meta.pinned, expiresAt: meta.expiresAt } : {}), tasks: turns.filter(j => j.status !== 'released').map(j => this.view(j)), canContinue: !continuationBlockedReason, continuationBlockedReason };
  }
  async readConversation(ownerId, conversationId) {
    const initial = this.conversation(ownerId, conversationId), latest = this.lookup(ownerId, initial.tasks.at(-1).id);
    // Completed jobs from before follow-ups existed have no capability field.
    // Verify their existing SDK session without submitting another prompt.
    if ((latest.continuationAvailable === undefined || this.historyEnabled && latest.continuationAvailable !== false) && (latest.output || latest.hasOutput || latest.artifacts?.length) && TERMINAL.has(latest.status) && latest.status !== 'rejected' && !latest.clearing && this.client?.configured) {
      const previous = this.capabilityChecks.get(latest.id);
      if (!previous || this.now() - previous.at >= 30000) {
        const check = { at: this.now(), promise: null };
        check.promise = (async () => {
          try {
            const remote = await this.client.get(ownerId, latest.id);
            if (this.closed || this.jobs.get(latest.id) !== latest || latest.clearing || !TERMINAL.has(latest.status) || remote.id !== latest.id || remote.conversationId !== conversationId || remote.status !== latest.status) return;
            const patch = { continuationAvailable: remote.continuationAvailable === true };
            this.write({ ...latest, ...patch }); Object.assign(latest, patch);
          } catch (error) {
            if (this.historyEnabled && ['agent-upstream-404', 'agent-upstream-410'].includes(error.code) && this.jobs.get(latest.id) === latest && !latest.clearing && TERMINAL.has(latest.status)) {
              this.write({ ...latest, continuationAvailable: false, continuationExpired: true }); Object.assign(latest, { continuationAvailable: false, continuationExpired: true });
            }
          }
        })();
        this.capabilityChecks.set(latest.id, check);
      }
      await this.capabilityChecks.get(latest.id).promise;
    }
    return this.conversation(ownerId, conversationId);
  }
  lookup(ownerId, id) {
    if (!validId(id)) throw problem(400, 'invalid-task-id', '任务标识无效。');
    const job = this.jobs.get(id);
    if (!job || job.ownerId !== ownerId) throw problem(404, 'agent-not-found', '任务不存在或已过期。');
    if (job.status === 'released') throw problem(410, 'agent-released', '任务记录已清理。');
    return job;
  }
  list(ownerId) {
    this.sweep();
    return [...this.jobs.values()].filter(j => j.ownerId === ownerId && j.status !== 'released').sort((a, b) => b.createdAt - a.createdAt).map(j => {
      const { output, prompt, ...summary } = this.view(j, true);
      return { ...summary, prompt: prompt.slice(0, 120), summary: true };
    });
  }
  historyList(ownerId, params) {
    this.sweep(); const options = pageOptions(params), groups = new Map();
    for (const job of this.jobs.values()) if (job.ownerId === ownerId && job.status !== 'released') {
      const group = groups.get(job.conversationId) || []; group.push(job); groups.set(job.conversationId, group);
    }
    const rows = [];
    for (const [conversationId, turns] of groups) {
      const meta = this.history.get(ownerId, conversationId); if (!meta || options.search && !meta.title.toLocaleLowerCase().includes(options.search) || options.pinned !== 'all' && meta.pinned !== (options.pinned === 'true')) continue;
      turns.sort((a, b) => (a.turnIndex || 1) - (b.turnIndex || 1) || a.createdAt - b.createdAt);
      const latest = turns.at(-1), filesCount = [...this.files.records.values()].filter(file => file.ownerId === ownerId && file.conversationId === conversationId).length;
      rows.push({ conversationId, title: meta.title, pinned: meta.pinned, createdAt: meta.createdAt, updatedAt: meta.updatedAt, turns: turns.length, status: latest.status, latestTaskId: latest.id, filesCount, expiresAt: meta.expiresAt });
    }
    const result = paginate(rows, options, 'conversationId', 'updatedAt'); return { conversations: result.items, nextCursor: result.nextCursor };
  }
  patchConversation(ownerId, conversationId, body) {
    this.conversation(ownerId, conversationId);
    const meta = this.history.patch(ownerId, conversationId, body);
    try {
      for (const job of this.turns(ownerId, conversationId)) if (job.status !== 'released') { this.write({ ...job, expiresAt: meta.expiresAt }); job.expiresAt = meta.expiresAt; }
      this.files.retain(ownerId, conversationId, meta.expiresAt);
    } catch (error) { this.storageFailed = true; throw error; }
    return this.conversation(ownerId, conversationId);
  }
  get(ownerId, id) { if (this.historyEnabled) this.sweep(); return this.view(this.lookup(ownerId, id)); }
  async status(ownerId) {
    if (this.closed || this.storageFailed || this.files.failed) return { connected: false, available: false, mode: 'unavailable', message: '任务暂存服务暂不可用，请保留当前内容。', access: 'admin-preview' };
    if (!this.client?.configured) return { connected: false, available: false, mode: 'unconfigured', message: '智能任务服务尚未配置。', access: 'admin-preview' };
    try {
      const remote = await this.client.health(ownerId);
      const capacity = Number.isInteger(remote.maxConcurrent) && remote.maxConcurrent >= 1 && remote.maxConcurrent <= 6 ? Math.min(this.maxConcurrent, remote.maxConcurrent) : this.maxConcurrent;
      return { connected: true, available: this.enabled && remote.jobsAvailable && remote.mode === 'adapter', continuationAvailable: remote.continuationAvailable === true, filesAvailable: remote.filesAvailable === true, modelSelectionAvailable: remote.modelSelectionAvailable === true, usageAvailable: remote.usageAvailable === true, ...(this.queueEnabled ? { queue: { enabled: true, waiting: this.queued().length, running: [...this.jobs.values()].filter(job => RUNNING.has(job.status)).length, maxConcurrent: capacity, maxQueued: this.maxQueued }, ...(Number.isInteger(remote.activeJobs) && remote.activeJobs >= 0 ? { executionActive: remote.activeJobs } : {}) } : {}), mode: remote.mode, simulation: Boolean(this.client.simulation), message: !remote.jobsAvailable ? '通信已连接，正在准备独立执行环境。' : !this.enabled ? '执行环境已连接，管理员尚未启用任务。' : '执行服务就绪。', access: 'admin-preview' };
    } catch { return { connected: false, available: false, mode: 'offline', message: '暂时无法连接执行服务器，已有任务仍会继续核对。', access: 'admin-preview' }; }
  }
  validate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['id', 'conversationId', 'prompt', 'parentTaskId', 'attachmentIds', 'modelSelection'].includes(key)) || !validId(body.id) || !validId(body.conversationId) || (body.parentTaskId !== undefined && (!validId(body.parentTaskId) || body.parentTaskId === body.id)) || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4000 || body.modelSelection !== undefined && !validateModelSelection(body.modelSelection) || body.attachmentIds !== undefined && (!Array.isArray(body.attachmentIds) || !body.attachmentIds.length || body.attachmentIds.length > 5 || new Set(body.attachmentIds).size !== body.attachmentIds.length || body.attachmentIds.some(id => !validId(id)))) throw problem(400, 'invalid-agent-task', '请输入 1–4000 字的任务内容，最多添加 5 份资料，并使用有效任务标识。');
  }
  async create(ownerId, body, acquire = () => ({ release() {} }), context = {}) {
    this.validate(body);
    this.sweep();
    const identity = [body.conversationId, body.prompt]; if (body.parentTaskId) identity.push(body.parentTaskId);
    if (body.attachmentIds?.length) identity.push(body.attachmentIds);
    if (body.modelSelection) identity.push([body.modelSelection.providerId, body.modelSelection.modelId]);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const existing = this.jobs.get(body.id);
    if (existing) {
      if (existing.ownerId !== ownerId) throw problem(409, 'agent-id-used', '任务标识已使用。');
      if (existing.fingerprint !== fingerprint) throw problem(409, 'agent-conflict', '同一个任务标识不能更换内容。');
      return { created: false, task: this.view(this.lookup(ownerId, body.id)) };
    }
    if (this.queueEnabled) return this.enqueue(ownerId, body, context, fingerprint);
    const service = await this.status(ownerId);
    if (!service.available) throw problem(503, 'agent-not-ready', '执行环境尚未就绪，请稍后再试。');
    if (this.closed || this.storageFailed) throw problem(503, 'agent-not-ready', '任务暂存服务暂不可用。');
    // Admission must be rechecked after the asynchronous health request.
    if (this.jobs.has(body.id)) return this.create(ownerId, body, acquire, context);
    this.sweep();
    const turns = this.turns(ownerId, body.conversationId);
    if (this.removing.has(ownerId + ':' + body.conversationId)) throw problem(409, 'agent-conversation-removing', '会话正在清理，请稍后再试。');
    if (turns.some(j => j.clearing)) throw problem(410, 'agent-context-released', '会话已开始清理，请新建任务。');
    if (body.parentTaskId) {
      const parent = this.lookup(ownerId, body.parentTaskId);
      if ((parent.modelSelection?.providerId || '') !== (body.modelSelection?.providerId || '') || (parent.modelSelection?.modelId || '') !== (body.modelSelection?.modelId || '')) throw problem(409, 'agent-model-changed', '同一会话保持原模型，更换模型请新建任务。');
      if (parent.conversationId !== body.conversationId || turns.at(-1)?.id !== parent.id) throw problem(409, 'agent-parent-conflict', '会话已有更新，请刷新后接着最新一轮追问。');
      if (turns.some(j => j.status === 'released') || !completeContext(turns)) throw problem(410, 'agent-context-released', '部分上下文已清理或过期，请新建任务。');
      if (!TERMINAL.has(parent.status) || turns.some(j => ACTIVE.has(j.status))) throw problem(409, 'agent-parent-active', '请等待当前任务结束后继续追问。');
      if (!service.continuationAvailable || !parent.continuationAvailable || (!parent.output && !parent.hasOutput && !parent.artifacts?.length) || parent.status === 'rejected') throw problem(409, 'agent-context-unavailable', '当前会话无法继续，请新建任务。');
      if (turns.length >= 20) throw problem(409, 'agent-turn-limit', '本次会话已达到 20 轮，请新建任务。');
    } else if (turns.length) throw problem(409, 'agent-parent-required', '继续已有会话时需要接着最新一轮，请刷新后再试。');
    const jobs = [...this.jobs.values()];
    if (jobs.filter(j => ACTIVE.has(j.status)).length >= this.maxConcurrent || jobs.some(j => j.ownerId === ownerId && ACTIVE.has(j.status))) throw problem(429, 'agent-busy', '已有任务正在执行或核对，请等待任务结束。');
    const retained = jobs.filter(j => j.status !== 'released');
    if (jobs.length >= 10000 || retained.length >= (this.historyEnabled ? 5000 : 500) || retained.filter(j => j.ownerId === ownerId).length >= (this.historyEnabled ? 1000 : 50)) throw problem(429, 'agent-capacity', '任务记录较多，请先清理已结束的任务。');
    if (body.attachmentIds?.length && !service.filesAvailable) throw problem(503, 'agent-files-unavailable', '执行服务暂未开放文件处理，请稍后再试。');
    if (body.modelSelection && (!service.modelSelectionAvailable || !context.modelSelection)) throw problem(503, 'agent-model-unavailable', '执行端尚未准备好模型选择，请稍后再试。');
    const documents = body.attachmentIds?.length ? this.files.prepare(ownerId, body.attachmentIds, body.conversationId) : [];
    if (service.filesAvailable) this.files.reserve(ownerId, jobs.filter(j => ACTIVE.has(j.status)).length);
    const wire = { id: body.id, conversationId: body.conversationId, prompt: body.prompt, ...(body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}), ...(documents.length ? { documents } : {}), ...(body.modelSelection ? { modelSelection: body.modelSelection } : {}) };
    const attachments = (body.attachmentIds || []).map(id => this.files.metadata(this.files.lookup(ownerId, id, 'upload')));
    const lease = acquire();
    const job = { version: 1, ...body, ...(context.modelSelection ? { modelSelection: context.modelSelection, modelLock: context.modelLock, dispatchState: 'prepared', gatewayStarted: 0, gatewayCompleted: 0 } : {}), ownerId, fingerprint, remoteFingerprint: remoteFingerprint(digest(ownerId), wire), ...(attachments.length ? { attachments } : {}), turnIndex: turns.length + 1, status: 'submitting', output: '', message: '正在提交到执行服务器…', createdAt: this.now(), updatedAt: this.now() };
    try { this.write(job); } catch (error) { lease.release(); throw error; }
    this.jobs.set(job.id, job); this.leases.set(job.id, lease);
    try { this.files.claim(ownerId, body.attachmentIds || [], job.conversationId, job.id, this.now() + this.retentionMs); this.retainConversation(job); } catch {
      this.storageFailed = true;
      // No submit has been scheduled; release this local admission even if the
      // disk cannot record its rejection. Restart recovery will fence its ID.
      Object.assign(job, { status: 'rejected', message: '会话暂存失败，请稍后再试。' });
      try { this.write(job); } catch {}
      lease.release(); this.leases.delete(job.id);
      throw problem(503, 'agent-storage', '会话暂存失败，请稍后再试。');
    }
    try {
      const quota = this.meter?.reserve(job); if (quota) job.quota = quota;
      if (job.modelSelection) this.update(job, { dispatchState: 'armed' });
    } catch (error) {
      this.update(job, { status: 'rejected', message: error.message || '额度核对未通过。' });
      throw error;
    }
    this.operation(job, async () => {
      try { this.apply(job, await this.client.submit(ownerId, wire)); }
      catch (error) {
        // Only explicit rejection proves no job was accepted. Lost replies never trigger replay.
        if (['agent-upstream-401', 'agent-upstream-404', 'agent-upstream-409', 'agent-upstream-410', 'agent-upstream-429', 'agent-upstream-503'].includes(error.code)) this.update(job, { status: 'rejected', message: error.message });
        else this.update(job, { status: 'unknown', message: uncertain });
      }
    });
    return { created: true, task: this.view(job) };
  }
  async enqueue(ownerId, body, context, fingerprint) {
    const service = await this.status(ownerId);
    if (!service.available) throw problem(503, 'agent-not-ready', '执行环境尚未就绪，请稍后再试。');
    if (this.closed || this.storageFailed || this.files.failed) throw problem(503, 'agent-not-ready', '任务暂存服务暂不可用。');
    if (this.jobs.has(body.id)) return this.create(ownerId, body, undefined, context);
    this.sweep(); this.expireQueued();
    const jobs = [...this.jobs.values()], turns = this.turns(ownerId, body.conversationId);
    if (this.removing.has(ownerId + ':' + body.conversationId) || turns.some(job => job.clearing)) throw problem(410, 'agent-context-released', '会话已开始清理，请新建任务。');
    if (jobs.some(job => job.ownerId === ownerId && ACTIVE.has(job.status))) throw problem(429, 'agent-busy', '你已有任务正在执行或排队，请等待当前任务结束。');
    if (this.queued().length >= this.maxQueued) throw problem(429, 'agent-queue-full', '当前排队人数较多，请稍后再提交。');
    if (body.parentTaskId) {
      const parent = this.lookup(ownerId, body.parentTaskId);
      if (parent.conversationId !== body.conversationId || turns.at(-1)?.id !== parent.id) throw problem(409, 'agent-parent-conflict', '会话已有更新，请刷新后接着最新一轮追问。');
      if ((parent.modelSelection?.providerId || '') !== (body.modelSelection?.providerId || '') || (parent.modelSelection?.modelId || '') !== (body.modelSelection?.modelId || '')) throw problem(409, 'agent-model-changed', '同一会话保持原模型，更换模型请新建任务。');
      if (turns.some(job => job.status === 'released') || !completeContext(turns)) throw problem(410, 'agent-context-released', '部分上下文已清理或过期，请新建任务。');
      if (!TERMINAL.has(parent.status) || turns.some(job => ACTIVE.has(job.status))) throw problem(409, 'agent-parent-active', '请等待当前任务结束后继续追问。');
      if (!service.continuationAvailable || !parent.continuationAvailable || (!parent.output && !parent.hasOutput && !parent.artifacts?.length) || parent.status === 'rejected') throw problem(409, 'agent-context-unavailable', '当前会话无法继续，请新建任务。');
      if (turns.length >= 20) throw problem(409, 'agent-turn-limit', '本次会话已达到 20 轮，请新建任务。');
    } else if (turns.length) throw problem(409, 'agent-parent-required', '继续已有会话时需要接着最新一轮，请刷新后再试。');
    const retained = jobs.filter(job => job.status !== 'released');
    if (jobs.length >= 10000 || retained.length >= (this.historyEnabled ? 5000 : 500) || retained.filter(job => job.ownerId === ownerId).length >= (this.historyEnabled ? 1000 : 50)) throw problem(429, 'agent-capacity', '任务记录较多，请先清理已结束的任务。');
    if (body.modelSelection && (!service.modelSelectionAvailable || !context.modelSelection)) throw problem(503, 'agent-model-unavailable', '执行端尚未准备好模型选择，请稍后再试。');
    if (body.attachmentIds?.length && !service.filesAvailable) throw problem(503, 'agent-files-unavailable', '执行服务暂未开放文件处理，请稍后再试。');
    const documents = body.attachmentIds?.length ? this.files.prepare(ownerId, body.attachmentIds, body.conversationId) : [];
    const wire = { id: body.id, conversationId: body.conversationId, prompt: body.prompt, ...(body.parentTaskId ? { parentTaskId: body.parentTaskId } : {}), ...(documents.length ? { documents } : {}), ...(body.modelSelection ? { modelSelection: body.modelSelection } : {}) };
    const attachments = (body.attachmentIds || []).map(id => this.files.metadata(this.files.lookup(ownerId, id, 'upload')));
    const job = { version: 1, ...body, ...(context.modelSelection ? { modelSelection: context.modelSelection } : {}), modelLock: null, dispatchState: 'prepared', ownerId, fingerprint, remoteFingerprint: remoteFingerprint(digest(ownerId), wire), ...(attachments.length ? { attachments } : {}), turnIndex: turns.length + 1, status: 'queued', output: '', message: '已加入队列，等待执行；排队不扣额度。', queueOrder: ++this.queueSequence, createdAt: this.now(), updatedAt: this.now() };
    this.write(job); this.jobs.set(job.id, job);
    try {
      this.files.claim(ownerId, body.attachmentIds || [], job.conversationId, job.id, this.now() + this.maxQueueMs + this.retentionMs);
      this.retainConversation(job);
    } catch (error) {
      this.storageFailed = true;
      try { this.update(job, { status: 'rejected', message: '排队资料暂存失败，请稍后再试。' }); } catch {}
      throw problem(503, 'agent-storage', '排队资料暂存失败，请稍后再试。');
    }
    void this.schedule();
    return { created: true, task: this.view(job) };
  }
  operation(job, fn) {
    if (this.closed) return Promise.resolve();
    const operation = Promise.resolve().then(fn).catch(() => { this.storageFailed = true; }).finally(() => this.operations.delete(job.id));
    this.operations.set(job.id, operation); return operation;
  }
  apply(job, remote) {
    // A not-accepted fence contains only the recovery fingerprint (which binds
    // the parent as well), because it never received the original submit body.
    if (remote.id !== job.id || remote.conversationId !== job.conversationId || job.parentTaskId && remote.parentTaskId !== job.parentTaskId && remote.recoveryReason !== 'not-accepted') throw problem(502, 'agent-protocol', '任务身份不一致。');
    const messages = { running: '正在执行…', cancelling: '正在停止，等待执行服务器确认…', unknown: uncertain, completed: '任务已完成。', failed: '任务执行失败，已保留收到的内容。', cancelled: '执行服务器已确认停止。' };
    // A late cancel reply cannot overwrite a terminal result.
    if (TERMINAL.has(job.status)) return;
    if (remote.usage !== undefined && !validateUsage(remote.usage)) throw problem(502, 'agent-protocol', '执行服务器用量数据无效。');
    if (job.modelSelection && remote.modelSelection && (job.modelSelection.providerId !== remote.modelSelection.providerId || job.modelSelection.modelId !== remote.modelSelection.modelId)) throw problem(502, 'agent-protocol', '执行模型与任务不一致。');
    let message = messages[remote.status];
    if (remote.recoveryReason === 'not-accepted') message = '未找到任务的执行记录，已解除占用，可以提交新任务。';
    else if (remote.recoveryReason === 'execution-recovered') message = remote.status === 'completed' ? '已恢复完成的任务结果。' : '任务已中断，已保留收到的内容并解除占用，可以提交新任务。';
    // A remote recovery receipt can have less text than the website already saved.
    const keepSaved = TERMINAL.has(remote.status) && !remote.output || ['failed', 'cancelled'].includes(remote.status) && job.output.startsWith(remote.output);
    const output = keepSaved ? job.output : remote.output;
    if (TERMINAL.has(remote.status)) this.meter?.settle(job, { ...remote, usage: remote.usage || job.usage });
    // A terminal reply is published only after generated files have a durable,
    // encrypted local copy. Downloads never depend on the viewer or worker.
    const artifacts = TERMINAL.has(remote.status) ? this.files.saveArtifacts(job.ownerId, job.conversationId, job.id, remote.artifacts || [], this.now() + this.retentionMs) : job.artifacts || [];
    this.update(job, { status: remote.status, output, message, ...(remote.usage ? { usage: remote.usage } : {}), ...(artifacts.length ? { artifacts } : {}), continuationAvailable: remote.continuationAvailable === true, ...(remote.recoveryReason ? { recoveryReason: remote.recoveryReason } : {}) });
  }
  reconcile(job) {
    if (this.closed || this.operations.has(job.id) || !RUNNING.has(job.status)) return Promise.resolve();
    return this.operation(job, async () => {
      try { this.apply(job, await this.client.get(job.ownerId, job.id)); }
      catch (error) {
        if (error.code === 'agent-upstream-410') this.update(job, { status: 'failed', message: '执行服务器暂存的结果已过期，已保留此前收到的内容。' });
        else if (error.code === 'agent-upstream-404' && typeof this.client.recover === 'function') {
          // The remote side must first fence a possibly late submission with a
          // durable tombstone; a single 404 alone cannot prove non-execution.
          try { this.apply(job, await this.client.recover(job.ownerId, job)); }
          catch { this.update(job, { status: 'unknown', message: uncertain }); }
        }
        else this.update(job, { status: 'unknown', message: uncertain });
      }
    });
  }
  async cancel(ownerId, id) {
    const job = this.lookup(ownerId, id);
    if (TERMINAL.has(job.status)) return this.view(job);
    if (job.status === 'queued') { this.update(job, { status: 'cancelled', message: '已取消排队，未调用模型，不扣额度。', dispatchState: 'prepared', usage: { calls: 0, complete: true, inputTokens: 0, outputTokens: 0 } }); return this.view(job); }
    while (this.operations.has(id)) await this.operations.get(id);
    if (TERMINAL.has(job.status)) return this.view(job);
    const attempt = this.operation(job, async () => {
      try { this.apply(job, await this.client.cancel(ownerId, id)); }
      catch { this.update(job, { status: 'unknown', message: '停止请求未获确认，正在核对状态；任务可能仍在执行。' }); }
    });
    await attempt; return this.view(job);
  }
  async recover(ownerId, id) {
    const job = this.lookup(ownerId, id);
    if (TERMINAL.has(job.status)) return this.view(job);
    if (job.status === 'queued') { void this.schedule(); return this.view(job); }
    while (this.operations.has(id)) await this.operations.get(id);
    if (TERMINAL.has(job.status)) return this.view(job);
    if (typeof this.client?.recover !== 'function') throw problem(503, 'agent-recovery-unavailable', '执行服务尚未支持异常恢复，请稍后重试。');
    const attempt = this.operation(job, async () => {
      try { this.apply(job, await this.client.recover(ownerId, job)); }
      catch { this.update(job, { status: 'unknown', message: '暂未确认任务已经停止，系统会继续核对；请勿重复提交。' }); }
    });
    await attempt; return this.view(job);
  }
  async remove(ownerId, id) {
    const job = this.lookup(ownerId, id);
    if (this.turns(ownerId, job.conversationId).filter(j => j.status !== 'released').length > 1) throw problem(409, 'agent-conversation-cleanup', '多轮会话请使用“清理会话”，避免丢失追问上下文。');
    return this.removeConversation(ownerId, job.conversationId);
  }
  async removeConversation(ownerId, conversationId) {
    this.conversation(ownerId, conversationId);
    const key = ownerId + ':' + conversationId;
    if (this.removing.has(key)) throw problem(409, 'agent-conversation-removing', '会话正在清理，请稍后再试。');
    const turns = this.turns(ownerId, conversationId).filter(j => j.status !== 'released');
    if (turns.some(j => !TERMINAL.has(j.status))) throw problem(409, 'agent-still-active', '请先等待执行结束，状态不确定时不能清理会话。');
    this.removing.add(key);
    try {
      // Persist cleanup intent before remote I/O. Even a lost release reply or
      // app restart must not make partly deleted context look resumable.
      for (const job of turns) { this.write({ ...job, clearing: true, continuationAvailable: false }); Object.assign(job, { clearing: true, continuationAvailable: false }); }
      // Keep the task records available for retry if deleting a local blob
      // fails. User-confirmed cleanup may remove files before the remote side
      // confirms its own cleanup; clearing prevents any further continuation.
      this.files.releaseConversation(ownerId, conversationId);
      for (const job of turns) {
        if (job.status !== 'rejected' && !(job.queueOrder && job.dispatchState === 'prepared')) {
          try { await this.client.release(ownerId, job.id); }
          catch (error) { if (!['agent-upstream-404', 'agent-upstream-410'].includes(error.code)) throw error; }
        }
        this.update(job, { status: 'released', prompt: '', output: '', attachments: [], artifacts: [], modelLock: null, message: '', continuationAvailable: false });
      }
      this.history?.remove(ownerId, conversationId);
    } finally { this.removing.delete(key); }
  }
  sweep() {
    // Treat a conversation as one retention unit, including after a crash
    // between the per-file expiry writes. Never leave a hole in its history.
    const retained = new Set([...this.jobs.values()].filter(j => ACTIVE.has(j.status) || (j.status !== 'released' && this.history?.get(j.ownerId, j.conversationId)?.pinned) || (j.status !== 'released' && this.history ? this.history.get(j.ownerId, j.conversationId)?.expiresAt : j.expiresAt) > this.now()).map(j => j.ownerId + ':' + j.conversationId));
    try { this.files.sweep(retained); } catch { this.storageFailed = true; }
    for (const [id, job] of this.jobs) if (!retained.has(job.ownerId + ':' + job.conversationId) && !this.removing.has(job.ownerId + ':' + job.conversationId) && !ACTIVE.has(job.status) && (job.expiresAt === null || job.expiresAt <= this.now())) {
      try { fs.unlinkSync(path.join(this.directory, id + '.enc')); this.jobs.delete(id); this.capabilityChecks.delete(id); }
      catch (error) { if (error.code === 'ENOENT') { this.jobs.delete(id); this.capabilityChecks.delete(id); } else this.storageFailed = true; }
    }
    if (this.history) {
      const conversations = new Map();
      for (const job of this.jobs.values()) {
        const id = job.ownerId + ':' + job.conversationId;
        conversations.set(id, conversations.get(id) === true || job.status !== 'released');
      }
      for (const meta of this.history.records.values()) {
        const retained = conversations.get(meta.ownerId + ':' + meta.conversationId);
        if (retained === false || retained === undefined && !meta.pinned) this.history.remove(meta.ownerId, meta.conversationId);
      }
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); if (this.dispatching) await this.dispatching; await Promise.all([...this.operations.values()]); for (const lease of this.leases.values()) lease.release(); this.leases.clear(); }
}
module.exports = { AgentTasks, ACTIVE, RUNNING, TERMINAL };
