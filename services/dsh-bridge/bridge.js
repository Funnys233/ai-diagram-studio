'use strict';

// This module is deliberately transport-agnostic: no DSH adapter is bundled until
// the exact server version, execution policy and isolation have been verified.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LIMITS, fingerprint: jobFingerprint, validateDocuments, validateArtifacts, validateModelSelection, validateUsage } = require('./file-protocol');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_OUTPUT = 256 * 1024;
const MAX_TURNS = 20;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'released']);
const digest = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => crypto.timingSafeEqual(Buffer.from(digest(a), 'hex'), Buffer.from(digest(b), 'hex'));

function createBridge({ stateDir, token, adapter, maxConcurrent = 2, timeoutMs = 15 * 60 * 1000, retentionMs = 86400000, now = Date.now, recoverStaleLock = false }) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token)) throw new Error('A 32-byte hex bridge token is required');
  if (!path.isAbsolute(stateDir || '')) throw new Error('An absolute state directory is required');
  if (adapter != null && (typeof adapter.run !== 'function' || typeof adapter.cancel !== 'function')) throw new Error('Invalid DSH adapter');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 6) throw new Error('Invalid concurrency');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('Invalid timeout');
  if (!Number.isInteger(retentionMs) || retentionMs < 1000 || retentionMs > 7 * 86400000) throw new Error('Invalid retention');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(stateDir).isSymbolicLink()) throw new Error('State directory cannot be a symlink');
  const lockPath = path.join(stateDir, 'bridge.lock');
  if (recoverStaleLock && fs.existsSync(lockPath)) {
    const stat = fs.lstatSync(lockPath, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Invalid bridge lock');
    const previous = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (!Number.isSafeInteger(previous.pid) || previous.pid < 1 || previous.pid > 2147483647) throw Error('Invalid bridge lock owner');
    let gone = false;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') gone = true; }
    if (!gone) throw Error('Bridge lock owner is still running');
    const current = fs.lstatSync(lockPath, { bigint: true });
    if (current.ino !== stat.ino || current.birthtimeNs !== stat.birthtimeNs || current.mtimeNs !== stat.mtimeNs) throw Error('Bridge lock changed');
    fs.unlinkSync(lockPath);
  }
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid })); fs.fsyncSync(lock);
  const statePath = path.join(stateDir, 'state.json');
  let jobs;
  try {
    if (fs.existsSync(statePath)) {
      if (fs.lstatSync(statePath).isSymbolicLink()) throw new Error('State file cannot be a symlink');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.version !== 1 || !Array.isArray(state.jobs)) throw new Error('Invalid state file');
      jobs = new Map(state.jobs.map((j) => [j.id, j]));
    } else jobs = new Map();
    for (const j of jobs.values()) {
      if (!TERMINAL.has(j.status)) j.status = 'unknown';
      else if (!j.expiresAt) j.expiresAt = now() + retentionMs;
    }
  } catch (err) { fs.closeSync(lock); fs.unlinkSync(lockPath); throw err; }
  const active = new Map();
  const cancellingSessions = new Set();
  const cleaningSessions = new Map();
  const recoveries = new Map();
  const recoveryAttempts = new Map();
  let closed = false;
  function persist() {
    const tmp = path.join(stateDir, `.state-${crypto.randomUUID()}.tmp`);
    let fd;
    try {
      fd = fs.openSync(tmp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ version: 1, jobs: [...jobs.values()] }));
      fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, statePath);
    } catch (e) {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw e;
    }
  }
  try { persist(); } catch (err) { fs.closeSync(lock); fs.unlinkSync(lockPath); throw err; }
  const continuationSupported = () => adapter?.supportsContinuation === true && typeof adapter.canResume === 'function';
  const artifactBytes = items => (items || []).reduce((sum, item) => sum + Buffer.byteLength(item.text), 0);
  const artifactUsage = () => [...jobs.values()].reduce((sum, j) => sum + artifactBytes(j.artifacts) + (j.filesEnabled && !TERMINAL.has(j.status) ? LIMITS.artifactTotalBytes : 0), 0);
  const acceptedArtifacts = result => result.artifacts === undefined ? [] : validateArtifacts(result.artifacts) ? result.artifacts : null;
  const conversationJobs = j => [...jobs.values()].filter(item => item.ownerHash === j.ownerHash && item.conversationId === j.conversationId);
  // Map insertion order is persisted. It also orders legacy turns without a
  // parent link, even when several turns share the same clock timestamp.
  const latestTurn = j => conversationJobs(j).at(-1);
  function canContinue(j) {
    if (!continuationSupported() || !j.sessionId || !TERMINAL.has(j.status) || conversationJobs(j).some(item => item.status === 'released') || j.status === 'released' || latestTurn(j) !== j || cancellingSessions.has(j.sessionId) || cleaningSessions.has(j.sessionId) || conversationJobs(j).filter(item => item.sessionId).length >= MAX_TURNS) return false;
    try { return adapter.canResume({ sessionId: j.sessionId }) === true; } catch { return false; }
  }
  function visible(j) { return { id: j.id, conversationId: j.conversationId, status: j.status, output: j.output, updatedAt: j.updatedAt, continuationAvailable: canContinue(j), ...(j.artifacts?.length ? { artifacts: j.artifacts } : {}), ...(j.parentTaskId ? { parentTaskId: j.parentTaskId } : {}), ...(j.recoveryReason ? { recoveryReason: j.recoveryReason } : {}), ...(j.modelSelection ? { modelSelection: j.modelSelection } : {}), ...(j.usage ? { usage: j.usage } : {}) }; }
  function extendConversation(j) {
    const expiresAt = now() + retentionMs;
    for (const item of conversationJobs(j)) if (item.status !== 'released' && item.recoveryReason !== 'not-accepted' && TERMINAL.has(item.status)) item.expiresAt = expiresAt;
  }
  function send(res, status, obj) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(obj));
  }
  function change(j, updates) {
    Object.assign(j, updates, { updatedAt: new Date(now()).toISOString() });
    if (updates.status === 'released') j.expiresAt = now() + 7 * 86400000;
    else if (TERMINAL.has(j.status)) extendConversation(j);
    persist();
  }
  function sweep() {
    let changed = false;
    const pinned = new Set([...jobs.values()].filter(j => !TERMINAL.has(j.status)).map(j => j.ownerHash + ':' + j.conversationId));
    for (const [id, j] of jobs) if (TERMINAL.has(j.status) && j.expiresAt <= now() && !pinned.has(j.ownerHash + ':' + j.conversationId)) {
      if (j.recoveryReason === 'not-accepted') jobs.delete(id);
      else if (j.status === 'released') { if (!adapter?.release || j.sdkReleased) jobs.delete(id); else continue; }
      else Object.assign(j, { status: 'released', output: '', artifacts: [], updatedAt: new Date(now()).toISOString(), expiresAt: now() + 7 * 86400000 });
      changed = true;
    }
    if (changed) persist();
  }
  function cleanSession(sessionId) {
    if (!sessionId) return Promise.resolve();
    if (cleaningSessions.has(sessionId)) return cleaningSessions.get(sessionId);
    const sessionJobs = [...jobs.values()].filter(j => j.sessionId === sessionId);
    if (!adapter?.release || sessionJobs.some(j => j.status !== 'released') || sessionJobs.every(j => j.sdkReleased)) return Promise.resolve();
    // Set the lock before calling an async adapter: admission cannot reuse a
    // session while its persisted history is being removed.
    const operation = Promise.resolve().then(async () => {
      await adapter.release({ sessionId });
      for (const job of sessionJobs) job.sdkReleased = true;
      persist();
    }).finally(() => cleaningSessions.delete(sessionId));
    cleaningSessions.set(sessionId, operation);
    return operation;
  }
  const cleaner = setInterval(() => {
    try { sweep(); } catch { closed = true; return; }
    for (const sessionId of new Set([...jobs.values()].filter(j => j.status === 'released').map(j => j.sessionId))) void cleanSession(sessionId).catch(() => {});
  }, 60000); cleaner.unref();
  function recover(j, force = false) {
    if (closed || j.status !== 'unknown' || !j.sessionId || typeof adapter?.recover !== 'function') return Promise.resolve();
    if (recoveries.has(j.id)) return recoveries.get(j.id);
    if (cancellingSessions.has(j.sessionId)) return Promise.resolve();
    if (!force && recoveryAttempts.has(j.id) && now() - recoveryAttempts.get(j.id) < 15000) return Promise.resolve();
    recoveryAttempts.set(j.id, now());
    cancellingSessions.add(j.sessionId);
    const operation = (async () => {
      let result;
      try { result = await adapter.recover({ sessionId: j.sessionId, ...(j.executionBound ? { taskId: j.id } : {}) }); }
      catch { return; } // A failed inspection never proves the old execution stopped.
      if (closed || j.status !== 'unknown') return;
      if (!result || result.stopped !== true || !['completed', 'failed', 'cancelled'].includes(result.status) || typeof result.output !== 'string' || Buffer.byteLength(result.output) > MAX_OUTPUT) return;
      const artifacts = acceptedArtifacts(result); if (!artifacts) return;
      if (result.usage !== undefined && !validateUsage(result.usage)) return;
      if (result.status === 'completed' && !result.output && !artifacts.length) return;
      const output = result.output || j.output;
      change(j, { status: result.status, output, artifacts, ...(result.usage ? { usage: result.usage } : {}), recoveryReason: 'execution-recovered' });
      recoveryAttempts.delete(j.id);
      // The adapter has proven process termination; a late run() cannot keep
      // this slot occupied or replace the recovered terminal result.
      active.delete(j.id);
    })().catch(() => { closed = true; }).finally(() => {
      recoveries.delete(j.id); cancellingSessions.delete(j.sessionId);
    });
    recoveries.set(j.id, operation);
    return operation;
  }
  const recoverUnknown = () => { for (const job of jobs.values()) if (job.status === 'unknown') void recover(job); };
  const recoveryTimer = setInterval(recoverUnknown, 15000); recoveryTimer.unref();
  queueMicrotask(recoverUnknown);
  async function readBody(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) { const e = new Error('too large'); e.code = 'TOO_LARGE'; throw e; }
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function run(j, prompt, documents = []) {
    let timer;
    try {
      timer = setTimeout(() => {
        if (!TERMINAL.has(j.status)) {
          try { change(j, { status: 'unknown' }); void recover(j); } catch (_) { closed = true; }
        }
      }, timeoutMs);
      timer.unref();
      const result = await adapter.run({ sessionId: j.sessionId, taskId: j.id, continuation: Boolean(j.parentTaskId), documents, prompt, ...(j.modelSelection ? { modelSelection: j.modelSelection } : {}), onUsage(usage) {
        if (closed || j.status === 'unknown' || TERMINAL.has(j.status)) return;
        if (!validateUsage(usage)) throw Error('Invalid usage result');
        change(j, { usage });
      }, onProgress(output) {
        if (closed || j.status === 'unknown' || TERMINAL.has(j.status)) return;
        if (typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT) throw new Error('Invalid or oversized output');
        change(j, { output });
      } });
      if (closed || TERMINAL.has(j.status)) return;
      if (!result || !['completed', 'failed', 'cancelled'].includes(result.status) || typeof result.output !== 'string' || Buffer.byteLength(result.output) > MAX_OUTPUT) throw new Error('Invalid adapter result');
      const artifacts = acceptedArtifacts(result); if (!artifacts) throw Error('Invalid output files');
      if (result.usage !== undefined && !validateUsage(result.usage)) throw Error('Invalid usage result');
      change(j, { status: result.status, output: result.output, artifacts, ...(result.usage ? { usage: result.usage } : {}) });
    } catch (_) {
      // Transport errors do not prove whether DSH accepted or completed a prompt.
      if (!closed && !TERMINAL.has(j.status)) {
        try { change(j, { status: 'unknown' }); } catch (_) { closed = true; }
      }
    } finally { clearTimeout(timer); active.delete(j.id); if (!closed && j.status === 'unknown') void recover(j); }
  }
  const server = http.createServer(async (req, res) => {
    try {
      if (closed) return send(res, 503, { error: 'unavailable' });
      const auth = req.headers.authorization || '';
      if (!safeEqual(auth, `Bearer ${token}`)) return send(res, 401, { error: 'unauthorized' });
      const owner = req.headers['x-site-owner'];
      if (typeof owner !== 'string' || !ID.test(owner)) return send(res, 400, { error: 'invalid owner' });
      const ownerHash = digest(owner);
      sweep();
      const url = new URL(req.url, 'http://localhost');
      if (url.search || url.pathname.includes('%')) return send(res, 400, { error: 'invalid path' });
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(res, 200, { status: 'ready', mode: adapter ? 'adapter' : 'diagnostic', version: 1, jobsAvailable: Boolean(adapter), recoveryAvailable: typeof adapter?.recover === 'function', continuationAvailable: continuationSupported(), filesAvailable: adapter?.supportsFiles === true, usageAvailable: adapter?.supportsUsage === true, modelSelectionAvailable: adapter?.supportsModelSelection === true, maxConcurrent, activeJobs: [...jobs.values()].filter(job => !TERMINAL.has(job.status)).length });
      if (req.method === 'POST' && url.pathname === '/v1/jobs') {
        if (!adapter) return send(res, 503, { error: 'DSH adapter unavailable' });
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json required' });
        const body = await readBody(req);
        if (closed) return send(res, 503, { error: 'unavailable' });
        if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !['conversationId', 'id', 'prompt', 'parentTaskId', 'documents', 'modelSelection'].includes(key)) || typeof body.id !== 'string' || !ID.test(body.id) || typeof body.conversationId !== 'string' || !ID.test(body.conversationId) || (Object.hasOwn(body, 'parentTaskId') && (typeof body.parentTaskId !== 'string' || !ID.test(body.parentTaskId))) || typeof body.prompt !== 'string' || !body.prompt.trim() || Buffer.byteLength(body.prompt) > 48 * 1024 || Object.hasOwn(body, 'documents') && !validateDocuments(body.documents) || Object.hasOwn(body, 'modelSelection') && !validateModelSelection(body.modelSelection)) return send(res, 400, { error: 'invalid job' });
        const fingerprint = jobFingerprint(ownerHash, body);
        const existing = jobs.get(body.id);
        if (existing) {
          if (!safeEqual(existing.ownerHash, ownerHash)) return send(res, 404, { error: 'not found' });
          if (!safeEqual(existing.fingerprint, fingerprint)) return send(res, 409, { error: 'id already used' });
          if (existing.status === 'released') return send(res, 410, { error: 'released' });
          return send(res, 200, visible(existing));
        }
        if (jobs.size >= 10000) return send(res, 503, { error: 'state capacity reached' });
        if (body.documents?.length && adapter.supportsFiles !== true) return send(res, 503, { error: 'file input unavailable' });
        if (body.modelSelection && adapter.supportsModelSelection !== true) return send(res, 503, { error: 'model selection unavailable' });
        if (adapter.supportsFiles === true && artifactUsage() + LIMITS.artifactTotalBytes > LIMITS.globalArtifactBytes) return send(res, 503, { error: 'file capacity reached' });
        const retained = [...jobs.values()].filter(j => j.status !== 'released');
        if (retained.length >= 500 || retained.filter(j => j.ownerHash === ownerHash).length >= 50) return send(res, 503, { error: 'output capacity reached' });
        const sessionJobs = [...jobs.values()].filter((j) => j.ownerHash === ownerHash && j.conversationId === body.conversationId);
        if (sessionJobs.some((j) => !TERMINAL.has(j.status) || cancellingSessions.has(j.sessionId) || cleaningSessions.has(j.sessionId))) return send(res, 409, { error: 'session has an unresolved job' });
        let parent;
        if (body.parentTaskId) {
          parent = jobs.get(body.parentTaskId);
          if (!parent || !safeEqual(parent.ownerHash, ownerHash) || parent.conversationId !== body.conversationId) return send(res, 404, { error: 'parent not found' });
          if (parent.status === 'released' || !parent.sessionId) return send(res, 410, { error: 'conversation context expired' });
          if (latestTurn(parent) !== parent) return send(res, 409, { error: 'parent is not the latest turn' });
          if (sessionJobs.filter(j => j.sessionId).length >= MAX_TURNS) return send(res, 409, { error: 'conversation turn limit reached' });
          if (!continuationSupported()) return send(res, 503, { error: 'continuation unavailable' });
          if (!canContinue(parent)) return send(res, 410, { error: 'conversation context expired' });
          if (parent.modelSelection?.providerId !== body.modelSelection?.providerId || parent.modelSelection?.modelId !== body.modelSelection?.modelId) return send(res, 409, { error: 'conversation model selection changed' });
        } else if (sessionJobs.length) return send(res, 409, { error: 'existing conversation requires its latest parent' });
        if ([...jobs.values()].filter(job => !TERMINAL.has(job.status)).length >= maxConcurrent) return send(res, 429, { error: 'busy' });
        const sessionId = parent?.sessionId || crypto.randomUUID();
        const j = { id: body.id, ownerHash, fingerprint, conversationId: body.conversationId, sessionId, ...(parent ? { parentTaskId: parent.id } : {}), ...(body.modelSelection ? { modelSelection: body.modelSelection } : {}), executionBound: true, filesEnabled: adapter.supportsFiles === true, status: 'running', output: '', updatedAt: new Date(now()).toISOString() };
        extendConversation(j);
        jobs.set(j.id, j);
        try { persist(); } catch (e) { jobs.delete(j.id); throw e; }
        active.set(j.id, true);
        void run(j, body.prompt, body.documents || []);
        return send(res, 202, visible(j));
      }
      const match = /^\/v1\/jobs\/([a-zA-Z0-9_-]{1,64})(\/(?:cancel|release|recover))?$/.exec(url.pathname);
      if (!match) return send(res, 404, { error: 'not found' });
      let j = jobs.get(match[1]);
      if (req.method === 'POST' && match[2] === '/recover') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'json required' });
        const body = await readBody(req);
        if (closed) return send(res, 503, { error: 'unavailable' });
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'conversationId,fingerprint' || typeof body.conversationId !== 'string' || !ID.test(body.conversationId) || typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint)) return send(res, 400, { error: 'invalid recovery identity' });
        // Re-read after awaiting the body: a delayed submit may have arrived.
        j = jobs.get(match[1]);
        if (!j) {
          if (jobs.size >= 10000) return send(res, 503, { error: 'state capacity reached' });
          j = { id: match[1], ownerHash, conversationId: body.conversationId, fingerprint: body.fingerprint, sessionId: null, status: 'failed', output: '', recoveryReason: 'not-accepted', updatedAt: new Date(now()).toISOString(), expiresAt: now() + 7 * 86400000 };
          jobs.set(j.id, j); persist();
          return send(res, 200, visible(j));
        }
        if (!safeEqual(j.ownerHash, ownerHash)) return send(res, 404, { error: 'not found' });
        if (j.conversationId !== body.conversationId || !safeEqual(j.fingerprint, body.fingerprint)) return send(res, 409, { error: 'recovery identity mismatch' });
        if (j.status === 'released') return send(res, 410, { error: 'released' });
        await recover(j, true);
        if (closed) return send(res, 503, { error: 'unavailable' });
        return send(res, 200, visible(j));
      }
      if (!j || !safeEqual(j.ownerHash, ownerHash)) return send(res, 404, { error: 'not found' });
      if (req.method === 'POST' && match[2] === '/release') {
        if (!TERMINAL.has(j.status)) return send(res, 409, { error: 'job unresolved' });
        change(j, { status: 'released', output: '', artifacts: [] }); await cleanSession(j.sessionId); return send(res, 200, { released: true });
      }
      if (j.status === 'released') return send(res, 410, { error: 'released' });
      if (req.method === 'GET' && !match[2]) { void recover(j); return send(res, 200, visible(j)); }
      if (req.method === 'POST' && match[2] === '/cancel') {
        if (TERMINAL.has(j.status)) return send(res, 200, visible(j));
        if (j.status === 'unknown' || !active.has(j.id)) return send(res, 409, { error: 'status unknown' });
        if (j.status === 'cancelling') return send(res, 200, visible(j));
        change(j, { status: 'cancelling' });
        // A cancellation request is not a terminal result. Only run() can report one.
        cancellingSessions.add(j.sessionId);
        try { await adapter.cancel({ sessionId: j.sessionId }); }
        catch (_) { if (!TERMINAL.has(j.status)) change(j, { status: 'unknown' }); }
        finally { cancellingSessions.delete(j.sessionId); }
        return send(res, 200, visible(j));
      }
      return send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      if (e.code === 'TOO_LARGE') return send(res, 413, { error: 'too large' });
      if (e instanceof SyntaxError) return send(res, 400, { error: 'invalid json' });
      closed = true; return send(res, 503, { error: 'unavailable' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    listen(port = 0) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address()); }); }); },
    async close() {
      closed = true;
      clearInterval(cleaner);
      clearInterval(recoveryTimer);
      await Promise.allSettled([...recoveries.values(), ...cleaningSessions.values()]);
      for (const j of jobs.values()) if (!TERMINAL.has(j.status)) j.status = 'unknown';
      persist();
      if (adapter) await Promise.allSettled([...active.keys()].map(async id => {
        const job = jobs.get(id), result = await adapter.cancel({ sessionId: job.sessionId });
        if (result?.stopped === true) change(job, { status: 'cancelled' });
      }));
      try {
        if (server.listening) await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
      } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
    },
  };
}
module.exports = { createBridge };
