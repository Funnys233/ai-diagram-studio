'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { TaskError } = require('./conversation-tasks');
const { fingerprint, digest, validateArtifacts, validateUsage, validateModelSelection } = require('../services/dsh-bridge/file-protocol');
const STATES = new Set(['running', 'cancelling', 'unknown', 'completed', 'failed', 'cancelled']);
const fail = (status, code, message) => new TaskError(status, code, message);

// The destination is administrator-configured and must be a local SSH tunnel.
// Browser input never supplies an address, credential, owner or remote session ID.
class DshClient {
  constructor({ url, tokenFile, timeoutMs = 5000 } = {}) {
    this.configured = Boolean(url && tokenFile); this.timeoutMs = timeoutMs;
    if (!this.configured) return;
    const address = new URL(url);
    if (address.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(address.hostname) || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw Error('DSH bridge must use a loopback tunnel URL');
    if (!path.isAbsolute(tokenFile)) throw Error('DSH bridge token path must be absolute');
    const info = fs.lstatSync(tokenFile);
    if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw Error('DSH bridge token file permissions are invalid');
    this.token = fs.readFileSync(tokenFile, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(this.token)) throw Error('DSH bridge token is invalid');
    this.address = address;
  }
  request(ownerId, method, route, body, timeoutMs = this.timeoutMs) {
    if (!this.configured) return Promise.reject(fail(503, 'agent-not-configured', '智能任务服务尚未配置。'));
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(new URL(route, this.address), { method, maxHeaderSize: 8192, headers: {
        authorization: `Bearer ${this.token}`, 'x-site-owner': ownerId,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      } }, res => {
        let size = 0; const chunks = [];
        // JSON can expand valid control characters to six bytes each.
        res.on('data', chunk => { size += chunk.length; if (size > 8 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
        res.on('error', () => reject(fail(502, 'agent-connection', '与执行服务器的连接中断，正在核对任务状态。')));
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const messages = { 401: '执行服务器认证失败，请联系管理员。', 404: '执行服务器暂未找到该任务。', 409: '执行服务器上仍有未结束的任务。', 410: '执行服务器上的结果已清理。', 429: '执行服务器正忙，请稍后重试。', 503: '加密通道已连接，执行环境尚未就绪。' };
            return reject(fail(res.statusCode === 404 ? 404 : res.statusCode === 429 ? 429 : res.statusCode === 409 ? 409 : 503, 'agent-upstream-' + res.statusCode, messages[res.statusCode] || '执行服务器暂时不可用。'));
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(fail(502, 'agent-protocol', '执行服务器返回了无法识别的数据。')); }
        });
      });
      const deadline = setTimeout(() => req.destroy(), timeoutMs);
      req.once('close', () => clearTimeout(deadline));
      req.on('error', () => reject(fail(502, 'agent-connection', '与执行服务器的连接中断，正在核对任务状态。')));
      req.end(payload);
    });
  }
  async health(owner) {
    const body = await this.request(owner, 'GET', '/v1/health');
    if (body?.version !== 1 || body.status !== 'ready' || !['adapter', 'diagnostic'].includes(body.mode) || typeof body.jobsAvailable !== 'boolean' || (body.mode === 'diagnostic' && body.jobsAvailable)) throw fail(502, 'agent-protocol', '执行服务器版本或协议不兼容。');
    return body;
  }
  validate(body, id, conversationId) {
    if (!body || body.id !== id || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.conversationId) || (conversationId && body.conversationId !== conversationId) || !STATES.has(body.status) || typeof body.output !== 'string' || Buffer.byteLength(body.output) > 256 * 1024) throw fail(502, 'agent-protocol', '执行服务器的任务数据不完整，正在核对状态。');
    const value = { id: body.id, conversationId: body.conversationId, status: body.status, output: body.output.replaceAll(this.token, '[已隐藏]') };
    if (body.parentTaskId !== undefined) {
      if (typeof body.parentTaskId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.parentTaskId)) throw fail(502, 'agent-protocol', '执行服务器的追问记录无效。');
      value.parentTaskId = body.parentTaskId;
    }
    value.continuationAvailable = body.continuationAvailable === true;
    if (body.modelSelection !== undefined) {
      if (!validateModelSelection(body.modelSelection)) throw fail(502, 'agent-protocol', '执行模型数据无效。');
      value.modelSelection = body.modelSelection;
    }
    if (body.usage !== undefined) {
      if (!validateUsage(body.usage)) throw fail(502, 'agent-protocol', '执行用量数据无效。');
      value.usage = body.usage;
    }
    if (body.artifacts !== undefined) {
      if (!['completed', 'failed', 'cancelled'].includes(body.status) || !validateArtifacts(body.artifacts)) throw fail(502, 'agent-protocol', '执行服务器的生成文件无效，正在核对状态。');
      value.artifacts = body.artifacts.map(item => ({ ...item, text: item.text.replaceAll(this.token, '[已隐藏]') }));
    }
    if (['not-accepted', 'execution-recovered'].includes(body.recoveryReason)) value.recoveryReason = body.recoveryReason;
    return value;
  }
  async submit(owner, job) { return this.validate(await this.request(owner, 'POST', '/v1/jobs', job), job.id, job.conversationId); }
  async get(owner, id) { return this.validate(await this.request(owner, 'GET', '/v1/jobs/' + id), id); }
  async cancel(owner, id) { return this.validate(await this.request(owner, 'POST', '/v1/jobs/' + id + '/cancel', {}), id); }
  async recover(owner, job) {
    const bound = job.remoteFingerprint || fingerprint(digest(owner), job);
    if (!/^[a-f0-9]{64}$/.test(bound)) throw fail(502, 'agent-protocol', '任务恢复身份无效。');
    return this.validate(await this.request(owner, 'POST', '/v1/jobs/' + job.id + '/recover', { conversationId: job.conversationId, fingerprint: bound }, 30000), job.id, job.conversationId);
  }
  async release(owner, id) {
    const result = await this.request(owner, 'POST', '/v1/jobs/' + id + '/release', {});
    if (result?.released !== true) throw fail(502, 'agent-protocol', '执行服务器尚未确认清理结果。');
  }
}
module.exports = { DshClient };
