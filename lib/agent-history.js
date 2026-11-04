'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { atomic } = require('./cloud-runtime');
const { TaskError } = require('./conversation-tasks');
const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail = (status, code, message) => new TaskError(status, code, message);
const key = (ownerId, id) => crypto.createHash('sha256').update(JSON.stringify([ownerId, id])).digest('hex');
const validTitle = title => typeof title === 'string' && title.isWellFormed() && title.trim().length > 0 && title.length <= 80 && !/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(title);
class AgentHistory {
  constructor({ directory, codec = { encode: JSON.stringify, decode: JSON.parse }, now = Date.now, retentionMs = 30 * 86400000 }) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1000 || retentionMs > 365 * 86400000) throw Error('Invalid history retention');
    this.directory = directory; this.codec = codec; this.now = now; this.retentionMs = retentionMs; this.records = new Map();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Invalid history directory');
    for (const file of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.enc$/.test(file)) continue;
      const location = path.join(directory, file), info = fs.lstatSync(location);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw Error('Invalid history metadata');
      const meta = codec.decode(fs.readFileSync(location, 'utf8'));
      if (meta.version !== 1 || typeof meta.ownerId !== 'string' || !validId(meta.conversationId) || key(meta.ownerId, meta.conversationId) + '.enc' !== file || !validTitle(meta.title) || typeof meta.pinned !== 'boolean' || !Number.isSafeInteger(meta.createdAt) || !Number.isSafeInteger(meta.updatedAt) || (meta.pinned ? meta.expiresAt !== null : !Number.isSafeInteger(meta.expiresAt))) throw Error('会话历史记录无效，原文件保持不变');
      this.records.set(file.slice(0, -4), meta);
    }
  }
  get(ownerId, conversationId) { return this.records.get(key(ownerId, conversationId)); }
  write(meta) { atomic(path.join(this.directory, key(meta.ownerId, meta.conversationId) + '.enc'), this.codec.encode(meta)); this.records.set(key(meta.ownerId, meta.conversationId), meta); return meta; }
  ensure(job) {
    const existing = this.get(job.ownerId, job.conversationId);
    if (existing) return existing;
    const title = String(job.prompt || '').toWellFormed().replace(/[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim().slice(0, 80).replace(/[\uD800-\uDBFF]$/, '') || '未命名任务';
    const createdAt = Number.isSafeInteger(job.createdAt) ? job.createdAt : this.now(), updatedAt = Number.isSafeInteger(job.updatedAt) ? job.updatedAt : createdAt;
    return this.write({ version: 1, ownerId: job.ownerId, conversationId: job.conversationId, title, pinned: false, createdAt, updatedAt, expiresAt: updatedAt + this.retentionMs });
  }
  touch(job) {
    const previous = this.ensure(job), updatedAt = Math.max(previous.updatedAt, job.updatedAt || this.now());
    return this.write({ ...previous, updatedAt, expiresAt: previous.pinned ? null : updatedAt + this.retentionMs });
  }
  patch(ownerId, conversationId, body) {
    const meta = this.get(ownerId, conversationId);
    if (!meta) throw fail(404, 'agent-conversation-not-found', '会话不存在或已过期。');
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some(k => !['pinned', 'title'].includes(k)) || body.pinned !== undefined && typeof body.pinned !== 'boolean' || body.title !== undefined && !validTitle(body.title)) throw fail(400, 'invalid-agent-history', '可修改标题或长期保留状态；标题最多 80 字。');
    const pinned = body.pinned ?? meta.pinned, updatedAt = this.now();
    return this.write({ ...meta, ...(body.title === undefined ? {} : { title: body.title.trim() }), pinned, updatedAt, expiresAt: pinned ? null : updatedAt + this.retentionMs });
  }
  remove(ownerId, conversationId) {
    const id = key(ownerId, conversationId);
    try { fs.unlinkSync(path.join(this.directory, id + '.enc')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.records.delete(id);
  }
}
function pageOptions(params) {
  const search = params.get('search') || '', limitText = params.get('limit') || '20', pinned = params.get('pinned') || 'all';
  if (search.length > 100 || !search.isWellFormed() || /[\p{Cc}]/u.test(search) || !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limitText) || !['all', 'true', 'false'].includes(pinned)) throw fail(400, 'invalid-history-query', '搜索内容或分页参数不正确。');
  let cursor = null;
  if (params.has('cursor')) {
    const raw = params.get('cursor');
    try { if (!/^[A-Za-z0-9_-]{1,200}$/.test(raw)) throw Error(); cursor = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isSafeInteger(cursor[0]) || typeof cursor[1] !== 'string' || cursor[1].length > 100) throw Error(); } catch { throw fail(400, 'invalid-history-cursor', '分页位置无效，请刷新列表。'); }
  }
  return { search: search.trim().toLocaleLowerCase(), limit: Number(limitText), pinned, cursor };
}
function paginate(rows, { limit, cursor }, idKey, timeKey) {
  rows.sort((a, b) => b[timeKey] - a[timeKey] || a[idKey].localeCompare(b[idKey]));
  const filtered = cursor ? rows.filter(row => row[timeKey] < cursor[0] || row[timeKey] === cursor[0] && row[idKey].localeCompare(cursor[1]) > 0) : rows;
  const items = filtered.slice(0, limit), last = items.at(-1);
  return { items, nextCursor: filtered.length > limit ? Buffer.from(JSON.stringify([last[timeKey], last[idKey]])).toString('base64url') : null };
}
module.exports = { AgentHistory, pageOptions, paginate };
