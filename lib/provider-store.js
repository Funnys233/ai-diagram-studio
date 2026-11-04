// 提供商与模型配置的持久化存储
//
// 设计约束（对应验收要求）：
//   1. 数据文件带版本号，原子写入（tmp + rename），权限 600，放在 public 之外
//   2. 损坏文件：备份为 *.corrupt-<ts> 后用环境变量种子重建，绝不静默丢配置
//   3. 并发更新：进程内串行化（promise 链互斥）。所有变更先在**候选副本**上完成，
//      落盘成功后才发布到内存（写盘/rename/mutator 失败时内存、磁盘、revision、
//      默认引用全部保持原状态）；mutator 只允许改传入的候选数据，绝不通过
//      getRaw 触碰实时数据。客户端可携带编辑版本（revision）做过期检测，
//      过期写返回 StaleWriteError(409)，不覆盖新配置。
//   4. apiKey 只进不出：list()/对外序列化只暴露 hasKey；测试状态等错误文本
//      在入库前统一经过 secret-guard 擦除，加载时再擦一次历史遗留数据
//   5. DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEEPSEEK_MODEL 仅在没有持久配置时
//      作为初始种子；文件一旦存在，启动绝不覆盖用户已保存的配置
const fs = require('fs');
const path = require('path');
const { redactSecrets } = require('./secret-guard.js');
const Capabilities = require('./model-capabilities.js');

const STORE_VERSION = 1;
const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const PROTOCOLS = ['openai-chat-completions', 'anthropic-messages'];
const MODEL_ID_MAX = 200;
const NAME_MAX = 60;
const THINKING_MODES = ['default', 'deepseek-off', 'deepseek-on', 'enable-thinking-off', 'enable-thinking-on'];

function validateThinkingMode(value) {
  return value !== undefined && !THINKING_MODES.includes(value) ? '请选择有效的思考模式' : null;
}

/** 字段级校验错误：fields = { 字段名: 错误信息 } */
class ValidationError extends Error {
  constructor(fields, message) {
    super(message || '配置校验失败');
    this.name = 'ValidationError';
    this.fields = fields;
    this.status = 400;
    this.code = 'invalid-config';
  }
}

/** 冲突错误：客户端读取配置后，配置已被其他修改更新（编辑版本过期） */
class StaleWriteError extends Error {
  constructor() {
    super('配置已被其他修改更新，请刷新后重试（过期编辑未被应用）');
    this.name = 'StaleWriteError';
    this.status = 409;
    this.code = 'stale-config';
  }
}

function isLocalAddress(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/** 校验基础地址：必须是 http/https URL；外部地址强制 https，仅本机允许 http */
function validateBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return '基础地址不能为空';
  let u;
  try { u = new URL(value.trim()); } catch { return '基础地址不是合法 URL'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '仅支持 http/https 协议';
  if (u.protocol === 'http:' && !isLocalAddress(u.hostname)) return '外部接口必须使用 HTTPS（仅 127.0.0.1/localhost 允许 HTTP）';
  if (u.username || u.password) return '基础地址不能包含用户名/密码';
  return null;
}

function normalizeBaseUrl(value) {
  // 去掉尾斜杠（保留路径，如网关自定义 /v1 前缀），避免产生 // 或 /v1/ 拼接错误
  return value.trim().replace(/\/+$/, '');
}

function validateName(value, label) {
  if (typeof value !== 'string' || value.trim() === '') return `${label}不能为空`;
  if (value.trim().length > NAME_MAX) return `${label}过长（最多 ${NAME_MAX} 字）`;
  return null;
}

function validateModelId(value) {
  if (typeof value !== 'string' || value.trim() === '') return '模型 ID 不能为空';
  if (value.trim().length > MODEL_ID_MAX) return `模型 ID 过长（最多 ${MODEL_ID_MAX} 字符）`;
  if (value.trim() !== value) return '模型 ID 首尾不能有空格';
  if (/[\n\r]/.test(value)) return '模型 ID 不能包含换行';
  return null; // 大小写敏感，原样保留，不做任何改写
}

function validateMaxTokens(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 200000) return '输出长度必须是 1–200000 的整数';
  return null;
}

function validateTemperature(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 2) return 'temperature 必须是 0–2 之间的数值';
  return null;
}

function sanitizeModel(m) {
  return {
    modelId: m.modelId,
    displayName: m.displayName,
    enabled: m.enabled !== false,
    isDefault: m.isDefault === true,
    maxTokens: Number.isInteger(m.maxTokens) ? m.maxTokens : null,
    temperature: typeof m.temperature === 'number' ? m.temperature : null,
    visionInput: m.visionInput === true,
    thinkingMode: THINKING_MODES.includes(m.thinkingMode) ? m.thinkingMode : 'default',
    capabilityProfile: Capabilities.PROFILES.includes(m.capabilityProfile) ? m.capabilityProfile : 'auto',
    reasoningLevels: Capabilities.levels(m.reasoningLevels),
    reasoningEffort: Capabilities.EFFORTS.includes(m.reasoningEffort) ? m.reasoningEffort : null,
    remoteCapabilities: Capabilities.sanitizeRemote(m.remoteCapabilities),
    reasoningProbe: Capabilities.sanitizeProbe(m.reasoningProbe),
    testStatus: ['untested', 'testing', 'success', 'fail'].includes(m.testStatus) ? m.testStatus : 'untested',
    lastTestAt: typeof m.lastTestAt === 'string' ? m.lastTestAt : null,
    lastTestError: typeof m.lastTestError === 'string' ? m.lastTestError.slice(0, 300) : null,
  };
}

function sanitizeProvider(p) {
  const models = Array.isArray(p.models) ? p.models.map(m => {
    const safe = sanitizeModel(m);
    return { ...safe, capabilities: Capabilities.resolve(p, safe) };
  }) : [];
  return {
    providerId: p.providerId,
    name: p.name,
    baseUrl: p.baseUrl,
    protocol: p.protocol,
    enabled: p.enabled !== false,
    hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    authKind: typeof p.apiKey === 'string' && p.apiKey.length > 0 ? 'bearer' : 'none',
    models,
    isDefault: p.isDefault === true,
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
}

/** 收集数据里全部已知密钥（用于错误文本擦除）；不设长度下限，短密钥同样脱敏 */
function secretsOf(data) {
  const out = [];
  for (const p of data.providers || []) {
    if (p && typeof p.apiKey === 'string' && p.apiKey !== '') out.push(p.apiKey);
  }
  return out;
}

/** 生成 .env 种子的初始配置（仅无持久文件时调用一次） */
function seedFromEnv(env) {
  const apiKey = (env && env.DEEPSEEK_API_KEY) || '';
  if (!apiKey) return null;
  const baseUrl = normalizeBaseUrl((env && env.DEEPSEEK_BASE_URL) || 'https://api.deepseek.com');
  const model = (env && env.DEEPSEEK_MODEL) || 'deepseek-flash';
  const now = new Date().toISOString();
  return {
    version: STORE_VERSION,
    revision: 0,
    updatedAt: now,
    providers: [{
      providerId: 'deepseek',
      name: 'DeepSeek',
      baseUrl,
      protocol: 'openai-chat-completions',
      apiKey,
      enabled: true,
      isDefault: true,
      createdAt: now,
      updatedAt: now,
      models: [{
        modelId: model,
        displayName: model,
        enabled: true,
        isDefault: true,
        maxTokens: null,
        temperature: 0.3,
        testStatus: 'untested',
        lastTestAt: null,
        lastTestError: null,
      }],
    }],
  };
}

class ProviderStore {
  /** @param {{ filePath: string, env?: object, log?: (msg: string) => void }} options */
  constructor(options) {
    this.filePath = options.filePath;
    this.env = options.env || process.env;
    this.log = options.log || (() => {});
    this.codec = options.codec || null;
    this.strict = Boolean(options.strict);
    this.data = null;
    this.queue = Promise.resolve(); // 进程内写互斥
  }

  /** 启动加载：文件存在则读取（损坏则备份+种子兜底），不存在则尝试种子并落盘 */
  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const parsed = this.codec ? this.codec.decode(raw) : JSON.parse(raw);
        this.data = this.migrate(parsed);
      } catch (e) {
        if(this.strict)throw e;
        // 损坏文件：备份后回退到种子，绝不假装还能读到旧配置
        try {
          const backup = this.filePath + '.corrupt-' + Date.now();
          fs.copyFileSync(this.filePath, backup);
          this.log(`配置文件损坏（${e.message}），已备份到 ${path.basename(backup)}，回退到初始配置`);
        } catch (backupErr) {
          this.log(`配置文件损坏（${e.message}），且备份失败（${backupErr.message}）`);
        }
        this.data = seedFromEnv(this.env) || this.empty();
      }
      return this;
    }
    this.data = seedFromEnv(this.env) || this.empty();
    if (this.data.providers.length > 0) {
      try { this.writeSync(); } catch (e) { this.log(`初始配置落盘失败：${e.message}`); }
    }
    return this;
  }

  empty() {
    return { version: STORE_VERSION, revision: 0, updatedAt: new Date().toISOString(), providers: [] };
  }

  /** 当前编辑版本（客户端读取配置时带回，保存时携带做过期检测） */
  getRevision() {
    return this.data.revision;
  }

  /** 兼容未来版本迁移；当前仅接受同版本或缺失 version 的合法结构 */
  migrate(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return this.empty();
    if (typeof parsed.version !== 'number' || parsed.version > STORE_VERSION) {
      throw new Error(`配置版本 ${parsed.version} 高于本服务支持的 ${STORE_VERSION}`);
    }
    const providers = (Array.isArray(parsed.providers) ? parsed.providers : [])
      .filter((p) => p && typeof p === 'object' && typeof p.providerId === 'string')
      .map((p) => ({
        providerId: p.providerId,
        name: typeof p.name === 'string' ? p.name : p.providerId,
        baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : '',
        protocol: PROTOCOLS.includes(p.protocol) ? p.protocol : 'openai-chat-completions',
        apiKey: typeof p.apiKey === 'string' ? p.apiKey : '',
        enabled: p.enabled !== false,
        isDefault: p.isDefault === true,
        createdAt: p.createdAt || new Date().toISOString(),
        updatedAt: p.updatedAt || new Date().toISOString(),
        models: (Array.isArray(p.models) ? p.models : [])
          .filter((m) => m && typeof m === 'object' && typeof m.modelId === 'string')
          .map(sanitizeModel),
      }));
    // 历史遗留：已持久化的不安全测试错误详情可能在文本里含密钥，加载时统一擦除
    const secrets = secretsOf({ providers });
    for (const p of providers) {
      for (const m of p.models) {
        if (m.lastTestError) m.lastTestError = redactSecrets(m.lastTestError, secrets).slice(0, 300);
      }
    }
    return {
      version: STORE_VERSION,
      // revision 是编辑版本（乐观并发控制用），与 schema version 分开；缺失视为 0
      revision: Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      providers,
    };
  }

  /** 原子写入：tmp 文件 + rename；失败时 tmp 残留不影响旧文件 */
  writeSync(data) {
    const payload = data || this.data;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, this.codec ? this.codec.encode(payload) : JSON.stringify(payload, null, 2), { mode: 0o600 });
    if(this.codec){const fd=fs.openSync(tmp,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
    try { fs.chmodSync(tmp, 0o600); } catch { /* Windows 等平台忽略 */ }
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* 忽略 */ }
  }

  /**
   * 串行化所有写操作（存储事务，R3/R6）：
   *   1. 可选的编辑版本检测：expectedRevision 与当前不一致 → StaleWriteError(409)
   *   2. 深拷贝候选副本，mutator 只在副本上修改（禁止改实时数据）
   *   3. 落盘成功后才发布到内存；任何一步失败（mutator 抛错 / 写入 / rename）
   *      内存、磁盘、revision、默认引用全部保持原状态，且队列可继续接受后续写
   *   4. bumpRevision=false 用于测试状态等非配置变更：不递增编辑版本，
   *      避免连通性测试无谓地制造编辑冲突
   * @param {(candidate: object) => any} mutator
   * @param {{ expectedRevision?: number, bumpRevision?: boolean }} [options]
   */
  enqueue(mutator, options) {
    const opts = options || {};
    const run = this.queue.then(async () => {
      const base = this.data;
      if (opts.expectedRevision !== undefined && opts.expectedRevision !== null) {
        if (!Number.isInteger(opts.expectedRevision) || opts.expectedRevision < 0) {
          throw new ValidationError({ revision: '配置编辑版本 revision 必须是非负整数' });
        }
        if (opts.expectedRevision !== base.revision) throw new StaleWriteError();
      }
      const candidate = structuredClone(base);
      const result = await mutator(candidate);
      if (this.data !== base) throw new StaleWriteError(); // 期间被整体替换（reload 等）：拒绝落盘
      if (opts.bumpRevision !== false) {
        candidate.revision = base.revision + 1;
        candidate.updatedAt = new Date().toISOString();
      }
      this.writeSync(candidate); // 失败则抛出，下面这行不会执行
      this.data = candidate;    // 落盘成功才发布内存状态
      return result;
    });
    // 队列本身绝不因单个操作失败而断开
    this.queue = run.catch(() => {});
    return run;
  }

  list() {
    return this.data.providers.map(sanitizeProvider);
  }

  /**
   * 编辑版本归一（R6）：HTTP 层标准路径是 options.expectedRevision（server 的
   * takeRevision 已从请求体剥离）；直接调用 store 的脚本/探针也可能把 revision
   * 放在 payload 里 —— 两种携带方式统一归一为 options，且 revision 绝不作为
   * 业务字段落库。
   */
  mergeRevisionOption(payload, options) {
    const opts = options || {};
    if (opts.expectedRevision === undefined && payload && typeof payload === 'object'
      && payload.revision !== undefined && payload.revision !== null) {
      opts.expectedRevision = payload.revision;
    }
    if (payload && typeof payload === 'object') delete payload.revision;
    return opts;
  }

  catalog() {
    // 对话选择器用的目录：只含启用的提供商与模型，不含任何密钥信息
    return this.list().map((p) => ({
      providerId: p.providerId,
      name: p.name,
      protocol: p.protocol,
      enabled: p.enabled,
      isDefault: p.isDefault,
      models: p.models.map((m) => ({
        modelId: m.modelId,
        visionInput: m.visionInput === true,
        displayName: m.displayName,
        enabled: m.enabled,
        isDefault: m.isDefault,
      })),
    }));
  }

  getRaw(providerId) {
    return this.data.providers.find((p) => p.providerId === providerId) || null;
  }

  getSanitized(providerId) {
    const raw = this.getRaw(providerId);
    return raw ? sanitizeProvider(raw) : null;
  }

  /**
   * 字段校验。partial=true 时只校验出现的字段；excludeId 用于更新场景：
   * 自身 providerId 保持不变不算重复（R1），其它 ID 一律按重复/非法处理。
   */
  validateProviderFields(fields, partial, excludeId) {
    const errors = {};
    if (!partial || fields.providerId !== undefined) {
      const id = (fields.providerId || '').trim();
      if (!PROVIDER_ID_RE.test(id)) errors.providerId = 'Provider ID 必须以小写字母开头，只含小写字母/数字/短横线';
      else if (id !== excludeId && this.getRaw(id)) errors.providerId = `Provider ID "${id}" 已存在`;
    }
    if (!partial || fields.name !== undefined) {
      const err = validateName(fields.name, '显示名称');
      if (err) errors.name = err;
    }
    if (!partial || fields.baseUrl !== undefined) {
      const err = validateBaseUrl(fields.baseUrl);
      if (err) errors.baseUrl = err;
    }
    if (!partial || fields.protocol !== undefined) {
      if (!PROTOCOLS.includes(fields.protocol)) {
        errors.protocol = `协议必须是 ${PROTOCOLS.join(' 或 ')}`;
      }
    }
    if (fields.apiKey !== undefined && fields.apiKey !== null && typeof fields.apiKey !== 'string') {
      errors.apiKey = '密钥必须是字符串';
    }
    return errors;
  }

  async createProvider(payload, options) {
    options = this.mergeRevisionOption(payload, options);
    const errors = this.validateProviderFields(payload, false);
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);
    const initialModels = payload.models === undefined ? [] : payload.models;
    if (!Array.isArray(initialModels) || initialModels.length > 500) throw new ValidationError({ models: '模型列表必须为数组，最多 500 个' });
    const draft = { protocol: payload.protocol, baseUrl: payload.baseUrl, models: [] };
    for (const model of initialModels) {
      if (!model || typeof model !== 'object' || Array.isArray(model)) throw new ValidationError({ models: '模型配置不合法' });
      const modelErrors = this.validateModelFields(model, draft);
      if (Object.keys(modelErrors).length) throw new ValidationError(modelErrors);
      if (draft.models.some(m => m.modelId === model.modelId)) throw new ValidationError({ modelId: '模型 ID 不能重复' });
      this.appendModel(draft, model);
    }
    const now = new Date().toISOString();
    return this.enqueue((data) => {
      if (data.providers.some((p) => p.providerId === payload.providerId.trim())) {
        throw new ValidationError({ providerId: 'Provider ID 已存在' });
      }
      const provider = {
        providerId: payload.providerId.trim(),
        name: payload.name.trim(),
        baseUrl: normalizeBaseUrl(payload.baseUrl),
        protocol: payload.protocol,
        apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : '',
        enabled: payload.enabled !== false,
        // 第一个提供商自动作为默认；之后需通过「设为默认」显式切换
        isDefault: !data.providers.some((p) => p.isDefault),
        createdAt: now,
        updatedAt: now,
        models: draft.models,
      };
      data.providers.push(provider);
      return sanitizeProvider(provider);
    }, options);
  }

  /**
   * 更新提供商（R1）：完整编辑表单携带自身 providerId 是合法的（保持不变）；
   * 携带不同 providerId = 试图修改不可变主键，明确拒绝。
   * apiKey 语义：undefined=保留原值；null=清除；''（映射为 undefined）=保留；
   * 非空字符串=替换。绝不允许把空串/掩码当密钥保存。
   */
  async updateProvider(providerId, payload, options) {
    options = this.mergeRevisionOption(payload, options);
    const existing = this.getRaw(providerId);
    if (!existing) return null;
    if (payload.providerId !== undefined && payload.providerId !== null
      && String(payload.providerId).trim() !== providerId) {
      throw new ValidationError({ providerId: 'Provider ID 创建后不可修改（与当前不一致）；如需更换请删除后新建' });
    }
    const errors = this.validateProviderFields(payload, true, providerId);
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);
    return this.enqueue((data) => {
      const target = data.providers.find((p) => p.providerId === providerId);
      if (!target) return null;
      if ((payload.baseUrl !== undefined && normalizeBaseUrl(payload.baseUrl) !== target.baseUrl)
        || (payload.protocol !== undefined && payload.protocol !== target.protocol)
        || (payload.apiKey === null && target.apiKey) || (typeof payload.apiKey === 'string' && payload.apiKey && payload.apiKey !== target.apiKey)) {
        for (const model of target.models) { model.reasoningProbe = null; if (!Capabilities.resolve(target, model).reasoningLevels.includes(model.reasoningEffort)) model.reasoningEffort = null; }
      }
      if (payload.protocol !== undefined && payload.protocol !== target.protocol) {
        const incompatible = target.models.find(m => Object.keys(Capabilities.validate({ ...target, protocol: payload.protocol }, m)).length);
        if (incompatible) throw new ValidationError({ protocol: `模型 ${incompatible.modelId} 的强度配置不适用于该协议，请先在模型编辑中恢复默认并使用自动能力配置` });
      }
      if (payload.name !== undefined) target.name = String(payload.name).trim();
      if (payload.baseUrl !== undefined) target.baseUrl = normalizeBaseUrl(payload.baseUrl);
      if (payload.protocol !== undefined) target.protocol = payload.protocol;
      if (payload.apiKey === null) target.apiKey = ''; // 显式清除（独立操作）
      else if (typeof payload.apiKey === 'string' && payload.apiKey !== '') target.apiKey = payload.apiKey;
      // 空串一律忽略：留空表示保留原密钥
      if (payload.enabled !== undefined) target.enabled = payload.enabled === true;
      target.updatedAt = new Date().toISOString();
      return sanitizeProvider(target);
    }, options);
  }

  async deleteProvider(providerId, options) {
    return this.enqueue((data) => {
      const index = data.providers.findIndex((p) => p.providerId === providerId);
      if (index === -1) return false;
      data.providers.splice(index, 1);
      return true;
    }, options);
  }

  validateModelFields(fields, provider) {
    const errors = {};
    const err = validateModelId(fields.modelId);
    if (err) errors.modelId = err;
    const nameErr = fields.displayName === undefined ? null : validateName(fields.displayName, '模型显示名称');
    if (nameErr) errors.displayName = nameErr;
    const mtErr = validateMaxTokens(fields.maxTokens);
    if (mtErr) errors.maxTokens = mtErr;
    const tErr = validateTemperature(fields.temperature);
    if (tErr) errors.temperature = tErr;
    if (validateThinkingMode(fields.thinkingMode)) errors.thinkingMode = validateThinkingMode(fields.thinkingMode);
    Object.assign(errors, Capabilities.validate(provider, fields));
    return errors;
  }

  async addModel(providerId, payload, options) {
    options = this.mergeRevisionOption(payload, options);
    const provider = this.getRaw(providerId);
    if (!provider) return null;
    const errors = this.validateModelFields(payload, provider);
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);
    return this.enqueue((data) => {
      const target = data.providers.find((p) => p.providerId === providerId);
      if (!target) return null;
      // 重复检查必须落在候选副本上（事务内），与并发写保持一致
      if (target.models.some((m) => m.modelId === payload.modelId)) {
        throw new ValidationError({ modelId: `模型 "${payload.modelId}" 已存在于该提供商` });
      }
      return this.appendModel(target, payload);
    }, options);
  }

  /** 批量添加（获取列表后勾选保存）：一次事务写入，重复项逐个跳过不阻塞其余 */
  async addModels(providerId, payloads, options) {
    const provider = this.getRaw(providerId);
    if (!provider) return null;
    const errors = [];
    for (const item of payloads) errors.push(this.validateModelFields(item || {}, provider));
    return this.enqueue((data) => {
      const target = data.providers.find((p) => p.providerId === providerId);
      if (!target) return null;
      const added = [];
      const skipped = [];
      payloads.forEach((item, i) => {
        if (Object.keys(errors[i]).length > 0) {
          skipped.push({ modelId: item && item.modelId, reason: errors[i].modelId || Object.values(errors[i])[0] });
          return;
        }
        if (target.models.some((m) => m.modelId === item.modelId)) {
          skipped.push({ modelId: item.modelId, reason: `模型 "${item.modelId}" 已存在于该提供商` });
          return;
        }
        added.push(this.appendModel(target, item));
      });
      return { added, skipped };
    }, options);
  }

  /** 在候选数据的提供商下追加一个模型（只由 enqueue 内部调用） */
  appendModel(target, payload) {
    const capabilityErrors = Capabilities.validate(target, payload);
    if (Object.keys(capabilityErrors).length) throw new ValidationError(capabilityErrors);
    const model = sanitizeModel({
      modelId: payload.modelId,
      displayName: payload.displayName || payload.modelId,
      enabled: payload.enabled !== false,
      isDefault: payload.isDefault === true || target.models.length === 0,
      maxTokens: payload.maxTokens ?? null,
      temperature: payload.temperature ?? null,
      visionInput: payload.visionInput,
      thinkingMode: payload.thinkingMode,
      capabilityProfile: payload.capabilityProfile,
      reasoningLevels: payload.reasoningLevels,
      reasoningEffort: payload.reasoningEffort,
      remoteCapabilities: payload.remoteCapabilities,
      testStatus: 'untested',
      lastTestAt: null,
      lastTestError: null,
    });
    target.models.push(model);
    if (model.isDefault) for (const m of target.models) if (m !== model) m.isDefault = false;
    target.updatedAt = new Date().toISOString();
    return sanitizeModel(model);
  }

  /** modelId 不可修改（定位键）；其余字段可更新；显式 null = 清空可选参数回到协议默认 */
  async updateModel(providerId, modelId, payload, options) {
    options = this.mergeRevisionOption(payload, options);
    const provider = this.getRaw(providerId);
    if (!provider) return null;
    const errors = {};
    if (payload.displayName !== undefined && validateName(payload.displayName, '模型显示名称')) {
      errors.displayName = validateName(payload.displayName, '模型显示名称');
    }
    if (validateMaxTokens(payload.maxTokens)) errors.maxTokens = validateMaxTokens(payload.maxTokens);
    if (validateTemperature(payload.temperature)) errors.temperature = validateTemperature(payload.temperature);
    if (validateThinkingMode(payload.thinkingMode)) errors.thinkingMode = validateThinkingMode(payload.thinkingMode);
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);
    return this.enqueue((data) => {
      const target = data.providers.find((p) => p.providerId === providerId);
      const model = target && target.models.find((m) => m.modelId === modelId);
      if (!model) return null;
      const invalidateProbe = payload.capabilityProfile !== undefined && payload.capabilityProfile !== (model.capabilityProfile || 'auto')
        || payload.reasoningLevels !== undefined && JSON.stringify(Capabilities.levels(payload.reasoningLevels)) !== JSON.stringify(model.reasoningLevels)
        || payload.remoteCapabilities !== undefined && JSON.stringify(Capabilities.sanitizeRemote(payload.remoteCapabilities)) !== JSON.stringify(model.remoteCapabilities);
      const capabilityErrors = Capabilities.validate(target, { ...model, ...payload, modelId, ...(invalidateProbe ? { reasoningProbe: null } : {}) });
      if (Object.keys(capabilityErrors).length) throw new ValidationError(capabilityErrors);
      if (payload.displayName !== undefined) model.displayName = String(payload.displayName).trim();
      if (payload.enabled !== undefined) model.enabled = payload.enabled === true;
      if (payload.isDefault === true) {
        for (const p of data.providers) for (const m of p.models) m.isDefault = false;
        target.isDefault = true;
        model.isDefault = true;
      }
      if (payload.maxTokens !== undefined) model.maxTokens = Number.isInteger(payload.maxTokens) ? payload.maxTokens : null;
      if (payload.temperature !== undefined) model.temperature = typeof payload.temperature === 'number' ? payload.temperature : null;
      if (payload.visionInput !== undefined) model.visionInput = payload.visionInput;
      if (payload.thinkingMode !== undefined) model.thinkingMode = payload.thinkingMode;
      if (payload.capabilityProfile !== undefined) model.capabilityProfile = payload.capabilityProfile;
      if (payload.reasoningLevels !== undefined) model.reasoningLevels = Capabilities.levels(payload.reasoningLevels);
      if (payload.reasoningEffort !== undefined) model.reasoningEffort = payload.reasoningEffort || null;
      if (payload.remoteCapabilities !== undefined) model.remoteCapabilities = Capabilities.sanitizeRemote(payload.remoteCapabilities);
      if (invalidateProbe) model.reasoningProbe = null;
      target.updatedAt = new Date().toISOString();
      return sanitizeModel(model);
    }, options);
  }

  async deleteModel(providerId, modelId, options) {
    return this.enqueue((data) => {
      const target = data.providers.find((p) => p.providerId === providerId);
      if (!target) return false;
      const index = target.models.findIndex((m) => m.modelId === modelId);
      if (index === -1) return false;
      target.models.splice(index, 1);
      // 默认模型被删后不静默指向其它模型：默认引用留空，等用户在设置里重新指定
      target.updatedAt = new Date().toISOString();
      return true;
    }, options);
  }

  async recordReasoningProbe(providerId, modelId, outcome, snapshot) {
    return this.enqueue(data => {
      snapshot.signal?.throwIfAborted();
      const provider = data.providers.find(p => p.providerId === providerId);
      const model = provider?.models.find(m => m.modelId === modelId);
      if (!model || !provider.enabled || !model.enabled || provider.baseUrl !== snapshot.baseUrl
        || provider.protocol !== snapshot.protocol || provider.apiKey !== snapshot.apiKey
        || (model.capabilityProfile || 'auto') !== snapshot.capabilityProfile
        || JSON.stringify(Capabilities.sanitizeRemote(model.remoteCapabilities)) !== JSON.stringify(snapshot.remoteCapabilities)) throw new StaleWriteError();
      model.reasoningProbe = Capabilities.sanitizeProbe({ ...outcome, probedAt: new Date().toISOString() });
      provider.updatedAt = model.reasoningProbe.probedAt;
      if (!Capabilities.resolve(provider, model).reasoningLevels.includes(model.reasoningEffort)) model.reasoningEffort = null;
      return sanitizeModel(model);
    });
  }

  /** 设置全局默认模型：该模型所属提供商成为默认提供商（清掉其它提供商/模型的默认标记） */
  async setDefaultModel(providerId, modelId, options) {
    return this.enqueue((data) => {
      const target = data.providers.find((p) => p.providerId === providerId);
      if (!target) return null;
      const model = target.models.find((m) => m.modelId === modelId);
      if (!model) return null;
      for (const p of data.providers) {
        p.isDefault = false;
        for (const m of p.models) m.isDefault = false;
      }
      target.isDefault = true;
      model.isDefault = true;
      target.updatedAt = new Date().toISOString();
      return sanitizeModel(model);
    }, options);
  }

  /**
   * 记录一次模型连通性测试结果。测试状态不是用户配置变更：
   * 不递增编辑版本（不会把正在编辑的表单顶成 409），错误文本先擦除密钥再入库。
   */
  async recordTestResult(providerId, modelId, status, error) {
    return this.enqueue((data) => {
      const target = data.providers.find((p) => p.providerId === providerId);
      const model = target && target.models.find((m) => m.modelId === modelId);
      if (!model) return null;
      model.testStatus = status;
      model.lastTestAt = new Date().toISOString();
      model.lastTestError = status === 'fail' && error
        ? redactSecrets(String(error), secretsOf(data)).slice(0, 300)
        : null;
      target.updatedAt = new Date().toISOString();
      return sanitizeModel(model);
    }, { bumpRevision: false });
  }

  /**
   * 解析一次聊天请求要用的模型。
   * 返回 { ok, provider, model } 或 { ok: false, status, code, message }。
   * 不存在的 id / 停用的提供商或模型一律明确拒绝，绝不回退到别的模型。
   */
  resolveSelection(providerId, modelId) {
    if (providerId === 'mock') {
      return { ok: true, mock: true, provider: { providerId: 'mock', name: '示例引擎' }, model: { modelId: 'mock', displayName: '内置示例引擎' } };
    }
    if (typeof providerId !== 'string' || providerId.trim() === '') {
      // 旧调用兼容：省略字段时路由到明确的默认配置。
      // 默认模型失效（被删/停用）时明确拒绝并提示重新选择，绝不静默改路由到其它付费模型。
      const fallback = this.defaultSelectionRaw();
      if (!fallback) {
        const anyProvider = this.data.providers.length > 0;
        return {
          ok: false,
          status: 409,
          code: anyProvider ? 'default-model-unavailable' : 'no-model-configured',
          message: anyProvider
            ? '默认模型已失效（被删除或停用）：请重新在模型选择器中选择模型后再发送'
            : '尚未配置任何模型，请先在「模型设置」中添加提供商，或选择内置示例引擎',
        };
      }
      return this.resolveSelection(fallback.providerId, fallback.modelId);
    }
    const provider = this.getRaw(providerId);
    if (!provider) return { ok: false, status: 404, code: 'provider-not-found', message: `提供商 "${providerId}" 不存在（可能已被删除）` };
    if (!provider.enabled) return { ok: false, status: 409, code: 'provider-disabled', message: `提供商 "${provider.name}" 已停用` };
    let model = null;
    if (typeof modelId === 'string' && modelId !== '') {
      model = provider.models.find((m) => m.modelId === modelId) || null;
      if (!model) return { ok: false, status: 404, code: 'model-not-found', message: `提供商 "${provider.name}" 下不存在模型 "${modelId}"` };
    } else {
      model = provider.models.find((m) => m.isDefault && m.enabled) || provider.models.find((m) => m.enabled) || null;
      if (!model) return { ok: false, status: 409, code: 'model-unavailable', message: `提供商 "${provider.name}" 下没有可用模型，请在设置中选择其它模型` };
    }
    if (!model.enabled) return { ok: false, status: 409, code: 'model-disabled', message: `模型 "${model.displayName}" 已停用，请在设置中选择其它模型` };
    return { ok: true, provider, model };
  }

  /** 只认显式默认（默认提供商 + 其默认模型，且都启用）；不做静默回退 */
  defaultSelectionRaw() {
    const p = this.data.providers.find((x) => x.isDefault === true);
    if (!p || !p.enabled) return null;
    const m = p.models.find((mm) => mm.isDefault && mm.enabled);
    if (!m) return null;
    return { providerId: p.providerId, modelId: m.modelId };
  }

  /** 对外默认选择（不含密钥）；无可用配置时返回 null（前端应回展示例引擎） */
  defaultSelection() {
    const raw = this.defaultSelectionRaw();
    if (!raw) return null;
    const p = this.getRaw(raw.providerId);
    const m = p && p.models.find((mm) => mm.modelId === raw.modelId);
    if (!p || !m) return null;
    return {
      providerId: p.providerId,
      modelId: m.modelId,
      providerName: p.name,
      modelName: m.displayName,
      source: 'model',
    };
  }
}

module.exports = {
  ProviderStore,
  ValidationError,
  StaleWriteError,
  validateBaseUrl,
  normalizeBaseUrl,
  sanitizeProvider,
  seedFromEnv,
  PROTOCOLS,
  STORE_VERSION,
};
