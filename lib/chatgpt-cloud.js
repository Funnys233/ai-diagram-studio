// VM connection with owner-only management and explicit per-model delegation.
// Import is an offline SSH operation; no HTTP endpoint accepts raw tokens.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChatGPTLocal } = require('./chatgpt-local');
const { atomic, CloudError } = require('./cloud-runtime');

class ChatGPTCloud extends ChatGPTLocal {
  constructor({ cloud, ownerUsername, ...options }) {
    super({ filePath: path.join(cloud.directory, 'chatgpt-vm.enc'), ...options });
    this.cloud = cloud;
    const owner = cloud.data.users.find(user => user.username === ownerUsername && user.role === 'admin' && !user.disabled);
    if (!owner) throw Error('CLOUD_CHATGPT_OWNER 必须是本站已启用的管理员账号。');
    this.ownerId = owner.id;
    this.load();
  }
  load() {
    if (this.loaded) return;
    if (!this.cloud) return; // Base constructor never reads credentials.
    if (fs.existsSync(this.filePath)) {
      const data = this.cloud.codec.decode(fs.readFileSync(this.filePath, 'utf8'));
      if (data.ownerId !== this.ownerId || !/^urn:uuid:[a-f0-9-]{36}$/.test(data.hostId) || !Array.isArray(data.accounts)) throw Error('云端订阅归属或数据不匹配，请检查配置；原凭据未改动。');
      this.data = data;
    } else {
      this.data = { hostId: 'urn:uuid:' + crypto.randomUUID(), ownerId: this.ownerId, activeId: null, accounts: [] };
      this.save();
    }
    this.loaded = true;
  }
  save() { atomic(this.filePath, this.cloud.codec.encode(this.data)); }
  allows(req) { return req.identity?.user.id === this.ownerId && req.identity.user.role === 'admin' && !req.identity.user.disabled; }
  assertOwner(req) { if (!this.allows(req)) throw new CloudError(403, 'chatgpt-owner-required', '此订阅连接仅供服务器所有者本人使用。'); }
  modelGrants(req) {
    if (!req.identity?.user || req.identity.user.disabled) return [];
    return [this.data.grants?.[req.identity.user.id], this.data.sharedGrant].filter(Boolean);
  }
  assertModelAccess(req, providerId, modelId) {
    if (this.allows(req)) return;
    if (!this.modelGrants(req).some(grant => providerId === 'chatgpt:' + grant.accountId && grant.models.includes(modelId))) throw new CloudError(403, 'chatgpt-model-forbidden', '此账号没有该订阅模型的使用权限。');
    this.cloud.assertMemberModel(req, modelId);
  }
  catalogFor(req) {
    if (this.allows(req)) return this.catalog();
    if (!req.identity?.user || req.identity.user.disabled) return [];
    const grants = this.modelGrants(req);
    return this.catalog().map(p => ({ ...p, name: '授权订阅', delegated: true,
      models: p.models.filter(m => this.cloud.memberModelAllowed(req.identity.user.id, m.modelId) && grants.some(grant => p.providerId === 'chatgpt:' + grant.accountId && grant.models.includes(m.modelId))).map(m => {
        const model = { ...m }; delete model.thinkingMode; delete model.reasoningEffort;
        return { ...model, ...this.cloud.preferenceFor(req.identity.user.id, p.providerId, model) };
      }),
    })).filter(p => p.models.length);
  }
  resolveFor(req, providerId, modelId) {
    this.assertModelAccess(req, providerId, modelId);
    const selected = this.resolve(providerId, modelId);
    if (selected.ok && !this.allows(req)) {
      delete selected.lock.model.thinkingMode; delete selected.lock.model.reasoningEffort;
      Object.assign(selected.lock.model, this.cloud.preferenceFor(req.identity.user.id, providerId, selected.lock.model));
      selected.lock.providerName = '授权订阅'; selected.sourceInfo.providerName = '授权订阅';
    }
    return selected;
  }
  modelPreference(req, providerId, modelId, patch) {
    const selected = this.resolveFor(req, providerId, modelId);
    if (this.allows(req)) return this.preference(providerId, modelId, patch);
    if (!selected.ok) throw new CloudError(400, selected.code, selected.message);
    const model = selected.lock.model, value = {};
    if (patch.thinkingMode !== undefined) {
      if (!model.supportsNone || !model.reasoningLevels.length || !['responses-on','responses-off'].includes(patch.thinkingMode)) throw new CloudError(400,'invalid-preference','当前模型未声明此思考开关。');
      value.thinkingMode = patch.thinkingMode;
    }
    if (patch.reasoningEffort !== undefined) {
      if (patch.reasoningEffort !== null && !model.reasoningLevels.includes(patch.reasoningEffort)) throw new CloudError(400,'invalid-preference','当前模型未声明此思考强度。');
      value.reasoningEffort = patch.reasoningEffort;
    }
    this.cloud.change(data => {
      const mine = data.preferences[req.identity.user.id] || (data.preferences[req.identity.user.id] = {}), key = providerId + '/' + modelId;
      mine[key] = { ...mine[key], ...value };
    });
    return value;
  }
  grantModel(username, modelId) {
    const user = this.cloud.data.users.find(u => u.username === username && !u.disabled);
    const account = this.account();
    if (!user || user.id === this.ownerId || !account?.accessToken || !account.models?.some(m => m.modelId === modelId && m.enabled)) throw Error('用户或已连接的模型不存在，不能授权。');
    const grants = this.data.grants || (this.data.grants = {}), previous = grants[user.id];
    grants[user.id] = { accountId: account.id, models: [...new Set([...(previous?.accountId === account.id ? previous.models : []), modelId])] };
    this.save();
    return { username, modelId, granted: true };
  }
  shareModel(modelId) {
    const account = this.account();
    if (!account?.accessToken || !account.models?.some(m => m.modelId === modelId && m.enabled)) throw Error('已连接的模型不存在，不能开放。');
    const previous = this.data.sharedGrant;
    if (previous && previous.accountId !== account.id) throw Error('已有其他连接的全员授权，请先核对现有配置。');
    this.data.sharedGrant = { accountId: account.id, models: [...new Set([...(previous?.models || []), modelId])] };
    this.save();
    return { modelId, shared: true };
  }
  status() { return { ...super.status(), mode: 'self-hosted', hostId: this.data.hostId, ownerOnly: true }; }
  start() { throw new CloudError(409, 'local-authorization-required', '请先在本机完成官方授权，再通过 SSH 导入服务器专用连接。'); }
  async importConnection(bundle) {
    // Caller must have stopped the one application instance before this write.
    if (bundle?.format !== 'diagram-chatgpt-vm-v1' || bundle.hostId !== this.data.hostId || !bundle.account || typeof bundle.account !== 'object') throw Error('授权文件与此服务器不匹配。');
    const input = bundle.account;
    if (!/^oaiapp_[\w-]{1,200}$/.test(input.clientId || '') || typeof input.idToken !== 'string' || input.idToken.length > 32768 || typeof input.accessToken !== 'string' || !input.accessToken || input.accessToken.length > 32768 || typeof input.refreshToken !== 'string' || !input.refreshToken || input.refreshToken.length > 32768 || !Array.isArray(input.scopes) || input.scopes.length > 30 || input.scopes.some(scope => typeof scope !== 'string' || scope.length > 200) || !input.scopes.includes('chatgpt.tokens.use.direct') || !Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) throw Error('授权文件缺少有效的订阅权限或凭证，请重新在本机授权。');
    const identity = await this.identity(input.idToken, input.clientId);
    if (identity.subject !== input.subject || input.issuer !== identity.issuer) throw Error('授权文件的身份无法验证。');
    const previous = this.data.accounts.find(account => account.clientId === input.clientId && account.subject === identity.subject);
    if (!previous && this.data.accounts.length >= 10) throw Error('服务器最多保存 10 个个人订阅连接。');
    const account = { ...identity, id: previous?.id || crypto.randomUUID(), clientId: input.clientId, idToken: input.idToken, accessToken: input.accessToken, refreshToken: input.refreshToken, scopes: [...input.scopes], expiresAt: input.expiresAt, models: [], preferences: previous?.preferences || {} };
    if (previous) this.data.accounts[this.data.accounts.indexOf(previous)] = account;
    else this.data.accounts.push(account);
    this.data.activeId = account.id;
    this.save();
    return { imported: true, accountId: account.id };
  }
}

module.exports = { ChatGPTCloud };
