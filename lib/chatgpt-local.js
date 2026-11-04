// Official SIWC public-client flow. Credentials belong to this app only.
// No Codex/ChatGPT client files, imported tokens, or paid-API fallback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModelCallError } = require('./adapters/common');
const adapter = require('./adapters/chatgpt-responses');
const { createModelStream } = require('./model-stream');
const { postJsonWithCaFallback } = require('./http-transport');
const Capabilities = require('./model-capabilities');
const { CloudError } = require('./cloud-runtime');

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
// Luna's SIWC catalog omits none; the official model contract and a live
// Responses request confirm it. Keep this fallback exact, never infer by prefix.
// https://developers.openai.com/api/docs/models/gpt-6-luna
const OFFICIAL_NONE_MODELS = new Set(['gpt-6-luna']);
const random = () => crypto.randomBytes(32).toString('base64url');
const fail = (message, code = 'chatgpt-auth-error') => new ModelCallError(code, message);

async function requestJson(url, form, token) {
  const response = await fetch(url, {
    method: form ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : token ? { Authorization: `Bearer ${token}` } : {},
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const reader = response.body?.getReader(); let size = 0; const chunks = [];
  if (reader) try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > 1048576) throw fail('ChatGPT 响应过大，请重试。'); chunks.push(Buffer.from(item.value)); } } finally { await reader.cancel().catch(() => {}); }
  let data = null; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* Empty revocation response is valid. */ }
  return { status: response.status, data };
}

function verifyIdentity(token, clientId, nonce, keys, now = Date.now()) {
  try {
    const parts = token.split('.'); if (parts.length !== 3 || token.length > 32768) throw Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url')); const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (!['RS256', 'ES256'].includes(header.alg) || header.crit) throw Error();
    const key = keys.find(k => k.kid === header.kid && (!k.alg || k.alg === header.alg) && (!k.use || k.use === 'sig') && (header.alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-256'));
    if (!key) throw Error();
    const publicKey = crypto.createPublicKey({ key, format: 'jwk' });
    const keyOptions = header.alg === 'ES256' ? { key: publicKey, dsaEncoding: 'ieee-p1363' } : publicKey;
    if (!crypto.verify('sha256', Buffer.from(parts.slice(0, 2).join('.')), keyOptions, Buffer.from(parts[2], 'base64url'))) throw Error();
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]; const seconds = now / 1000;
    if (claims.iss !== ISSUER || !audiences.includes(clientId) || audiences.length > 1 && claims.azp !== clientId || !Number.isFinite(claims.exp) || claims.exp <= seconds - 5 || !Number.isFinite(claims.iat) || claims.iat > seconds + 5 || claims.nbf !== undefined && claims.nbf > seconds + 5 || typeof claims.sub !== 'string' || !claims.sub || nonce !== undefined && claims.nonce !== nonce) throw Error();
    return { issuer: ISSUER, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.slice(0, 200) : '', name: typeof claims.name === 'string' ? claims.name.slice(0, 100) : '' };
  } catch { throw fail('ChatGPT 身份验证失败，请重新连接。'); }
}

class ChatGPTLocal {
  constructor({ filePath, request = requestJson, post = postJsonWithCaFallback } = {}) {
    this.filePath = filePath; this.request = request; this.post = post; this.loaded = false;
    this.data = { hostId: '', activeId: null, accounts: [] };
    this.pending = new Map(); this.refreshing = new Map(); this.controllers = new Map();
    this.authState = { phase: 'idle', message: '' }; this.keys = null; this.keysAt = 0;
    this.authEpoch = 0;
  }
  load() {
    if (this.loaded) return; this.loaded = true;
    if (fs.existsSync(this.filePath)) {
      try { const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')); if (!data.hostId || !Array.isArray(data.accounts)) throw Error(); this.data = data; fs.chmodSync(this.filePath, 0o600); }
      catch { this.loaded = false; throw fail('ChatGPT 本地授权文件无法读取，请检查文件权限。'); }
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = this.filePath + '.tmp-' + random();
    try { fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, this.filePath); fs.chmodSync(this.filePath, 0o600); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  account(id) { this.load(); return this.data.accounts.find(a => a.id === (id === undefined ? this.data.activeId : id)); }
  secrets() { this.load(); return this.data.accounts.flatMap(a => [a.accessToken, a.refreshToken, a.idToken]).filter(Boolean); }
  status() {
    this.load(); for (const [key, value] of this.pending) if (value.expiresAt < Date.now()) this.pending.delete(key);
    if (this.authState.phase === 'pending' && !this.pending.size) this.authState = { phase: 'error', message: '登录已超时，请重新连接。' };
    return { enabled: true, activeId: this.data.activeId, auth: this.authState, accounts: this.data.accounts.map(a => ({ id: a.id, label: `${a.name || a.email || 'ChatGPT 账号'} · ${a.clientId.slice(-6)}`, email: a.email, connected: Boolean(a.accessToken), planEnabled: a.scopes?.includes('chatgpt.tokens.use.direct') === true, models: a.models?.length || 0 })) };
  }
  start(port, accountId) {
    this.load(); const account = accountId ? this.account(accountId) : null;
    if (accountId && !account) throw fail('所选 ChatGPT 账号不存在。');
    if (!this.data.hostId) { this.data.hostId = 'urn:uuid:' + crypto.randomUUID(); this.save(); }
    const state = random(), verifier = random(), nonce = random();
    const transaction = { verifier, nonce, redirectUri: `http://127.0.0.1:${port}/auth/callback`, clientId: account?.clientId || null, accountId: account?.id, expiresAt: Date.now() + 600000, epoch: ++this.authEpoch };
    this.pending.clear(); this.pending.set(state, transaction);
    const url = new URL(ISSUER + '/api/accounts/authorize');
    url.search = new URLSearchParams({ client_id: transaction.clientId || 'dynamic_agent_client', ext_agent_host_id: this.data.hostId, response_type: 'code', redirect_uri: transaction.redirectUri, scope: SCOPE, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), ...(!account ? { agent_name_hint: 'Diagram Studio' } : {}), ...(account?.email ? { login_hint: account.email } : {}) }).toString();
    this.authState = { phase: 'pending', message: '请在官方页面完成登录授权。' };
    return { authorizationUrl: url.toString() };
  }
  async identity(token, clientId, nonce) {
    const header = (() => { try { return JSON.parse(Buffer.from(token.split('.')[0], 'base64url')); } catch { return {}; } })();
    if (!this.keys || Date.now() - this.keysAt > 3600000 || !this.keys.some(key => key.kid === header.kid)) {
      const result = await this.request(ISSUER + '/.well-known/jwks.json');
      if (result.status !== 200 || !Array.isArray(result.data?.keys)) throw fail('暂时无法验证 ChatGPT 身份，请稍后重试。');
      this.keys = result.data.keys; this.keysAt = Date.now();
    }
    return verifyIdentity(token, clientId, nonce, this.keys);
  }
  async callback(url) {
    const state = url.searchParams.get('state'); const transaction = this.pending.get(state);
    if (!transaction || transaction.used || transaction.expiresAt < Date.now()) throw fail('登录请求已过期或无法验证，请回到项目重新连接。');
    transaction.used = true;
    try {
      if (url.searchParams.has('error')) throw fail('已取消授权，或当前账号暂不支持此连接。');
      const code = url.searchParams.get('code'); const issued = url.searchParams.get('client_id');
    if (!code || code.length > 8192 || transaction.clientId && issued && issued !== transaction.clientId) throw fail('ChatGPT 登录回调无法验证，请重试。');
      const clientId = transaction.clientId || issued;
      if (!clientId || !/^oaiapp_[\w-]+$/.test(clientId)) throw fail('未取得 ChatGPT 应用注册信息，请重新连接。');
      const result = await this.request(ISSUER + '/api/accounts/oauth/token', { grant_type: 'authorization_code', code, client_id: clientId, code_verifier: transaction.verifier, redirect_uri: transaction.redirectUri, resource: RESOURCE });
      if (result.status !== 200 || !result.data?.id_token) throw fail('ChatGPT 授权交换失败，请重新连接；若持续失败，请检查账号资格和网络。');
      const identity = await this.identity(result.data.id_token, clientId, transaction.nonce);
      if (transaction.epoch !== this.authEpoch || transaction.expiresAt < Date.now()) throw fail('此登录已取消或被新的登录替代，请回到项目确认当前连接。');
      const previous = transaction.accountId ? this.account(transaction.accountId) : this.data.accounts.find(a => a.clientId === clientId && a.subject === identity.subject);
      if (previous && (previous.subject !== identity.subject || previous.clientId !== clientId)) throw fail('登录身份与所选账号不一致，原授权未被替换。');
      const account = { ...previous, ...identity, id: previous?.id || crypto.randomUUID(), clientId };
      this.applyTokens(account, result.data, false); account.models = []; account.preferences = account.preferences || {};
      if (previous) { this.abort(previous.id); this.data.accounts[this.data.accounts.indexOf(previous)] = account; } else this.data.accounts.push(account);
      this.data.activeId = account.id; this.save();
      this.authState = { phase: 'connected', message: account.scopes.includes('chatgpt.tokens.use.direct') ? 'ChatGPT 已连接，可以获取可用模型。' : '已登录，但未获订阅额度权限。请重新授权，或改用个人 API。' };
      return this.authState;
    } catch (error) {
      const message = error instanceof ModelCallError ? error.message : '连接未完成，请检查网络后重新连接。';
      if (transaction.epoch === this.authEpoch) this.authState = { phase: 'error', message };
      throw fail(message);
    } finally { this.pending.delete(state); }
  }
  applyTokens(account, tokens, refresh) {
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : refresh ? account.scopes : [];
    if (tokens.token_type && tokens.token_type.toLowerCase() !== 'bearer' || scopes.includes('chatgpt.tokens.use.direct') && typeof tokens.access_token !== 'string') throw fail('ChatGPT 返回了无法使用的授权信息，请重新连接。');
    account.accessToken = tokens.access_token || ''; account.refreshToken = tokens.refresh_token || (refresh ? account.refreshToken : ''); account.idToken = tokens.id_token || account.idToken;
    account.scopes = scopes; account.expiresAt = Date.now() + (Number.isFinite(tokens.expires_in) && tokens.expires_in > 0 ? tokens.expires_in * 1000 : 3600000);
  }
  async token(id) {
    const account = this.account(id);
    if (!account?.accessToken) throw fail('请先连接 ChatGPT。', 'chatgpt-login-required');
    if (!account.scopes.includes('chatgpt.tokens.use.direct')) throw fail('此账号尚未授权使用 ChatGPT 订阅额度，请重新连接并授权。');
    if (account.expiresAt > Date.now() + 60000) return account.accessToken;
    if (this.refreshing.has(id)) return this.refreshing.get(id);
    const promise = (async () => {
      if (!account.refreshToken) throw fail('ChatGPT 授权已过期，请重新连接。');
      const result = await this.request(ISSUER + '/api/accounts/oauth/token', { grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.refreshToken, resource: RESOURCE });
      if (this.account(id) !== account || !account.accessToken) throw fail('此 ChatGPT 连接已断开，请重新选择。');
      if (result.status !== 200) { if (result.status === 400 || result.status === 401) { account.accessToken = ''; account.refreshToken = ''; this.save(); } throw fail('ChatGPT 授权续期失败，请稍后重试或重新连接。'); }
      if (result.data.id_token) { const identity = await this.identity(result.data.id_token, account.clientId); if (identity.subject !== account.subject) throw fail('续期身份不一致，请重新连接。'); }
      this.applyTokens(account, result.data, true); this.save(); return account.accessToken;
    })().catch(error => { throw error instanceof ModelCallError ? error : fail('ChatGPT 授权续期暂时无法连接，请稍后重试。'); }).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, promise); return promise;
  }
  async refreshModels(id) {
    this.load(); if (id === undefined) id = this.data.activeId;
    const account = this.account(id), token = await this.token(id);
    let result; try { result = await this.request(RESOURCE + '/models', null, token); } catch { throw fail('无法获取 ChatGPT 模型，请检查网络后重试。'); }
    if (result.status !== 200) throw adapter.responseError(result.status, result.data);
    if (!Array.isArray(result.data?.models)) throw fail('ChatGPT 模型列表格式无法识别。');
    if (this.account(id) !== account || !account.accessToken) throw fail('此 ChatGPT 连接已变化，请重新获取模型。');
    account.models = result.data.models.filter(m => m.visibility === 'list' && typeof m.slug === 'string' && m.slug.length <= 200).map(m => {
      const efforts = (m.supported_reasoning_levels || []).map(v => typeof v === 'string' ? v : v.effort);
      const reasoningLevels = Capabilities.levels(efforts);
      return { modelId: m.slug, displayName: String(m.display_name || m.slug).slice(0, 200), enabled: true, visionInput: m.supports_image_input === true || m.input_modalities?.includes('image') === true, reasoningLevels, supportsNone: efforts.includes('none') || OFFICIAL_NONE_MODELS.has(m.slug), defaultEffort: reasoningLevels.includes(m.default_reasoning_level) ? m.default_reasoning_level : reasoningLevels[0] || null };
    });
    this.save(); return account.models.length;
  }
  catalog() {
    this.load(); return this.data.accounts.filter(a => a.accessToken && a.scopes?.includes('chatgpt.tokens.use.direct')).map(a => ({ providerId: 'chatgpt:' + a.id, name: '我的 ChatGPT · ' + (a.email || a.name || a.clientId.slice(-6)), protocol: adapter.protocol, baseUrl: RESOURCE, enabled: true, apiSource: 'chatgpt', models: (a.models || []).map(m => ({ ...m, supportsNone: m.supportsNone === true || OFFICIAL_NONE_MODELS.has(m.modelId), ...(a.preferences?.[m.modelId] || {}), capabilityProfile: 'custom', capabilities: { reasoningLevels: m.reasoningLevels, source: 'remote', defaultEffort: m.defaultEffort } })) }));
  }
  resolve(providerId, modelId) {
    const provider = this.catalog().find(p => p.providerId === providerId); const model = provider?.models.find(m => m.modelId === modelId);
    if (!model) return { ok: false, status: 400, code: 'chatgpt-model-unavailable', message: 'ChatGPT 模型不可用，请重新连接并获取模型。' };
    const accountId = providerId.slice(8);
    return { ok: true, lock: { protocol: adapter.protocol, chatgptRuntime: this, accountId, providerId, providerName: provider.name, model: structuredClone(model) }, sourceInfo: { providerId, providerName: provider.name, modelId, modelName: model.displayName, apiSource: 'chatgpt' } };
  }
  preference(providerId, modelId, patch) {
    const selected = this.resolve(providerId, modelId); if (!selected.ok) throw fail(selected.message);
    const model = selected.lock.model;
    if (patch.thinkingMode !== undefined && (!model.supportsNone || !model.reasoningLevels.length || !['responses-on', 'responses-off'].includes(patch.thinkingMode))) throw fail('当前模型没有声明可用的思考开关。');
    if (patch.reasoningEffort != null && !model.reasoningLevels.includes(patch.reasoningEffort)) throw fail('当前模型未声明此思考强度。');
    const account = this.account(selected.lock.accountId); const preferences = account.preferences || (account.preferences = {});
    if (!Object.hasOwn(preferences, modelId)) Object.defineProperty(preferences, modelId, { value: {}, writable: true, enumerable: true, configurable: true });
    const value = preferences[modelId];
    if (patch.thinkingMode !== undefined) value.thinkingMode = patch.thinkingMode;
    if (patch.reasoningEffort !== undefined) value.reasoningEffort = patch.reasoningEffort;
    this.save(); return value;
  }
  abort(id) { this.controllers.get(id)?.abort(); this.controllers.delete(id); }
  async disconnect(id) {
    const account = this.account(id); if (!account) throw fail('ChatGPT 账号不存在。');
    this.authEpoch++; this.pending.clear(); this.authState = { phase: 'idle', message: '' }; this.abort(id);
    const refreshToken = account.refreshToken; account.accessToken = ''; account.refreshToken = ''; account.idToken = ''; account.models = []; this.save();
    let revoked = !refreshToken;
    if (refreshToken) try {
      const discovery = await this.request(ISSUER + '/.well-known/openid-configuration');
      const endpoint = new URL(discovery.data?.revocation_endpoint);
      if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.hash) throw Error();
      const result = await this.request(endpoint.href, { token: refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }); revoked = result.status === 200;
    } catch { /* Locally signed out; report remote revocation separately. */ }
    return { revoked, message: revoked ? '已断开 ChatGPT。' : '本地已断开，但未确认远端撤销。可到 ChatGPT 设置中断开此应用。' };
  }
  async call(lock, messages, timeoutMs, options = {}) {
    const token = await this.token(lock.accountId); options.signal?.throwIfAborted();
    if (this.account(lock.accountId)?.accessToken !== token) throw fail('ChatGPT 连接已变化，请重新发送。');
    let session = this.controllers.get(lock.accountId); if (!session) { session = new AbortController(); this.controllers.set(lock.accountId, session); }
    const controller = new AbortController(); const abort = () => controller.abort();
    session.signal.addEventListener('abort', abort, { once: true }); options.signal?.addEventListener('abort', abort, { once: true });
    const stream = createModelStream(adapter.protocol, adapter, lock.providerName, options.onProgress, options.maxChars, options.onText);
    const request = adapter.buildChatRequest({ apiKey: token }, lock.model, messages);
    try {
      const callId = options.beforeCall?.({reasoningEffort: String(lock.model.thinkingMode||'').endsWith('-off')?'none':lock.model.reasoningEffort||null});
      let result, parsed;
      try {
        result = await this.post(request.url, request.headers, request.body, timeoutMs, { signal: controller.signal, expectSse: true, onEvent: event => stream.accept(event), isComplete: () => stream.isComplete() });
        controller.signal.throwIfAborted();
        if (!result.streaming) { if (result.status !== 200) throw adapter.responseError(result.status, result.data); throw fail('ChatGPT 未返回完整的事件流，请重试。'); }
        parsed = stream.finish();
      } catch (error) {
        options.afterCall?.(callId, {
          usage: stream.getUsage() || result?.data?.usage || result?.data?.response?.usage || error.extra?.usage,
          httpStatus: result?.status,
        }, error);
        throw error;
      }
      options.afterCall?.(callId, parsed, null);
      controller.signal.throwIfAborted();
      return parsed;
    } catch (error) { if (controller.signal.aborted || error instanceof ModelCallError || error instanceof CloudError) throw error; throw fail('ChatGPT 连接中断或超时，请检查网络后重试。'); }
    finally { session.signal.removeEventListener('abort', abort); options.signal?.removeEventListener('abort', abort); }
  }
}

module.exports = { ChatGPTLocal, verifyIdentity };
