'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomic } = require('./cloud-runtime');
const { TaskError } = require('./conversation-tasks');
const { validName, typeForName } = require('./agent-file-extraction');
const { validateArtifacts } = require('../services/dsh-bridge/file-protocol');
const { pageOptions, paginate } = require('./agent-history');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MB = 1024 * 1024, OWNER_BYTES = 25 * MB, TOTAL_BYTES = 100 * MB;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => new TaskError(status, code, message);

class AgentFiles {
  constructor({ directory, codec = { encode: JSON.stringify, decode: JSON.parse }, now = Date.now } = {}) {
    this.directory = directory; this.codec = codec; this.now = now; this.records = new Map(); this.failed = false;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Invalid agent file directory');
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.meta\.enc$/.test(name)) continue;
      const meta = this.read(name);
      if (!UUID.test(meta.id) || name !== meta.id + '.meta.enc' || meta.version !== 1 || typeof meta.ownerId !== 'string' || !validName(meta.name) || !['upload', 'artifact'].includes(meta.kind) || !Number.isSafeInteger(meta.size) || meta.size < 0 || meta.size > 5 * MB || !/^[a-f0-9]{64}$/.test(meta.sha256) || !Array.isArray(meta.taskIds) || meta.taskIds.some(id => !UUID.test(id)) || meta.conversationId && !UUID.test(meta.conversationId)) throw Error('智能任务文件记录无效，原文件保持不变');
      this.records.set(meta.id, meta);
    }
  }
  read(name) {
    const file = path.join(this.directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12 * MB) throw Error('Invalid agent file data');
    return this.codec.decode(fs.readFileSync(file, 'utf8'));
  }
  write(name, value) {
    try { atomic(path.join(this.directory, name), this.codec.encode(value)); }
    catch (error) { this.failed = true; throw error; }
  }
  metadata(meta) {
    const { id, name, type, size, chars, pages } = meta;
    return { id, name, type, size, chars, ...(pages ? { pages } : {}) };
  }
  library(ownerId, params) {
    const options = pageOptions(params), kind = params.get('kind') || 'all';
    if (!['all', 'upload', 'artifact'].includes(kind)) throw fail(400, 'invalid-file-query', '文件类型筛选无效。');
    const rows = [...this.records.values()].filter(meta => meta.ownerId === ownerId && (kind === 'all' || meta.kind === kind) && (!options.search || meta.name.toLocaleLowerCase().includes(options.search))).map(meta => ({
      ...this.metadata(meta), kind: meta.kind, conversationId: meta.conversationId || null,
      taskId: meta.kind === 'artifact' ? meta.taskIds[0] : null, createdAt: meta.createdAt, expiresAt: meta.expiresAt,
    }));
    const page = paginate(rows, options, 'id', 'createdAt');
    return { files: page.items, nextCursor: page.nextCursor, usage: { usedBytes: this.usage(ownerId).owner, limitBytes: OWNER_BYTES } };
  }
  usage(ownerId) {
    let total = 0, owner = 0, count = 0;
    for (const record of this.records.values()) { total += record.size; if (record.ownerId === ownerId) { owner += record.size; count++; } }
    return { total, owner, count };
  }
  quota(ownerId, bytes, { upload = false, active = 0 } = {}) {
    if (this.failed) throw fail(503, 'agent-files-unavailable', '文件暂存服务暂不可用，请稍后重试。');
    const usage = this.usage(ownerId);
    const ownerReserve = upload ? MB : 0, globalReserve = upload ? 6 * MB : active * MB;
    if (usage.owner + bytes + ownerReserve > OWNER_BYTES || usage.total + bytes + globalReserve > TOTAL_BYTES || upload && (usage.count >= 50 || this.records.size >= 200)) throw fail(429, 'agent-files-capacity', '文件暂存空间不足，请先清理不需要的会话或资料。');
  }
  reserve(ownerId, active) { this.quota(ownerId, MB, { active }); }
  store(meta, data) {
    // Metadata stays in memory; encrypted original bytes and extracted text
    // are read only while attaching or downloading a file.
    const blobName = meta.id + '.data.enc';
    if (fs.existsSync(path.join(this.directory, blobName))) {
      const previous = this.read(blobName);
      if (previous.id !== meta.id || previous.ownerId !== meta.ownerId || previous.sha256 !== meta.sha256) throw fail(409, 'agent-file-conflict', '文件标识已使用。');
    } else this.write(blobName, { version: 1, id: meta.id, ownerId: meta.ownerId, sha256: meta.sha256, ...data });
    this.write(meta.id + '.meta.enc', meta); this.records.set(meta.id, meta);
    return this.metadata(meta);
  }
  addUpload(ownerId, document, bytes) {
    this.quota(ownerId, bytes.length, { upload: true });
    const meta = { version: 1, id: document.id, ownerId, kind: 'upload', name: document.name, type: document.type, size: bytes.length, chars: document.text.length, ...(document.pages ? { pages: document.pages } : {}), sha256: sha(bytes), textSha256: sha(document.text), createdAt: this.now(), expiresAt: this.now() + 2 * 3600000, conversationId: null, taskIds: [] };
    if (this.records.has(meta.id)) throw fail(409, 'agent-file-conflict', '文件标识已使用。');
    return this.store(meta, { data: bytes.toString('base64'), text: document.text });
  }
  lookup(ownerId, id, kind) {
    if (typeof id !== 'string' || !UUID.test(id)) throw fail(400, 'invalid-agent-file', '文件标识无效。');
    const record = this.records.get(id);
    if (!record || record.ownerId !== ownerId || kind && record.kind !== kind) throw fail(404, 'agent-file-not-found', '文件不存在或已过期，请重新添加。');
    return record;
  }
  body(meta) {
    const blob = this.read(meta.id + '.data.enc');
    if (blob.id !== meta.id || blob.ownerId !== meta.ownerId || blob.sha256 !== meta.sha256 || typeof blob.data !== 'string' || typeof blob.text !== 'string') throw Error('Invalid agent file content');
    const bytes = Buffer.from(blob.data, 'base64');
    if (bytes.length !== meta.size || sha(bytes) !== meta.sha256) throw Error('Agent file content mismatch');
    return { bytes, text: blob.text };
  }
  prepare(ownerId, ids, conversationId) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 5 || new Set(ids).size !== ids.length) throw fail(400, 'invalid-agent-attachments', '每轮最多添加 5 份不同的资料。');
    let chars = 0;
    return ids.map(id => {
      const meta = this.lookup(ownerId, id, 'upload');
      if (meta.conversationId && meta.conversationId !== conversationId) throw fail(409, 'agent-file-used', '这份资料属于其他会话，请重新上传。');
      const { text } = this.body(meta);
      if (sha(text) !== meta.textSha256) throw Error('Agent document text mismatch');
      chars += text.length;
      if (chars > 200000) throw fail(400, 'agent-attachment-context', '本轮资料正文合计超过 20 万字符，请移除部分文件。');
      return { id: meta.id, name: meta.name, text };
    });
  }
  claim(ownerId, ids, conversationId, taskId, expiresAt) {
    for (const id of ids) {
      const meta = this.lookup(ownerId, id, 'upload');
      if (meta.conversationId && meta.conversationId !== conversationId) throw fail(409, 'agent-file-used', '资料已被其他会话使用。');
      const next = { ...meta, conversationId, taskIds: [...new Set([...meta.taskIds, taskId])], expiresAt };
      this.write(id + '.meta.enc', next); Object.assign(meta, next);
    }
  }
  saveArtifacts(ownerId, conversationId, taskId, artifacts, expiresAt) {
    if (!validateArtifacts(artifacts)) throw fail(502, 'agent-artifact-protocol', '生成文件列表无效。');
    return artifacts.map(item => {
      const bytes = Buffer.from(item.text, 'utf8');
      const existing = this.records.get(item.id);
      if (existing) {
        if (existing.kind !== 'artifact' || existing.ownerId !== ownerId || existing.conversationId !== conversationId || !existing.taskIds.includes(taskId) || existing.name !== item.name || existing.sha256 !== sha(bytes)) throw fail(502, 'agent-artifact-conflict', '生成文件身份不一致。');
        return this.metadata(existing);
      }
      this.quota(ownerId, bytes.length);
      return this.store({ version: 1, id: item.id, ownerId, kind: 'artifact', conversationId, taskIds: [taskId], name: item.name, type: typeForName(item.name), size: bytes.length, chars: item.text.length, sha256: sha(bytes), createdAt: this.now(), expiresAt }, { data: bytes.toString('base64'), text: item.text });
    });
  }
  download(ownerId, id, { taskId, kind = 'upload' } = {}) {
    const meta = this.lookup(ownerId, id, kind);
    if (taskId && !meta.taskIds.includes(taskId)) throw fail(404, 'agent-file-not-found', '文件不属于当前任务。');
    return { name: meta.name, ...this.body(meta) };
  }
  removeUpload(ownerId, id) {
    const meta = this.lookup(ownerId, id, 'upload');
    if (meta.taskIds.length) throw fail(409, 'agent-file-in-use', '资料已用于会话，请通过清理整段会话删除。');
    this.remove(meta);
  }
  remove(meta) {
    // Drop the payload first. A crash leaves metadata to be retried, rather
    // than an untracked original file that could outlive its conversation.
    for (const suffix of ['.data.enc', '.meta.enc']) {
      try { fs.unlinkSync(path.join(this.directory, meta.id + suffix)); }
      catch (error) { if (error.code !== 'ENOENT') { this.failed = true; throw error; } }
    }
    this.records.delete(meta.id);
  }
  retain(ownerId, conversationId, expiresAt) {
    for (const meta of this.records.values()) if (meta.ownerId === ownerId && meta.conversationId === conversationId && meta.expiresAt !== expiresAt) {
      const next = { ...meta, expiresAt }; this.write(meta.id + '.meta.enc', next); Object.assign(meta, next);
    }
  }
  releaseConversation(ownerId, conversationId) {
    for (const meta of this.records.values()) if (meta.ownerId === ownerId && meta.conversationId === conversationId) this.remove(meta);
  }
  sweep(activeConversations = new Set()) {
    for (const meta of this.records.values()) if (meta.expiresAt !== null && meta.expiresAt <= this.now() && !activeConversations.has(meta.ownerId + ':' + meta.conversationId)) this.remove(meta);
    // Interrupted initial uploads can leave a blob before its metadata commit.
    for (const file of fs.readdirSync(this.directory)) if (/^[a-f0-9-]{36}\.data\.enc$/.test(file) && !this.records.has(file.slice(0, 36))) {
      const stat = fs.lstatSync(path.join(this.directory, file));
      if (!stat.isSymbolicLink() && stat.isFile() && stat.mtimeMs + 86400000 <= this.now()) fs.unlinkSync(path.join(this.directory, file));
    }
  }
}
module.exports = { AgentFiles };
