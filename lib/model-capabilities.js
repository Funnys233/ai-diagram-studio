// 同一份能力解析用于配置校验、请求参数和前端；模型能力不等于网关已验证。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DiagramCapabilities = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PROFILES = ['auto', 'custom', 'none'];
  const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  const LABELS = { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' };
  function levels(value) {
    return Array.isArray(value) ? EFFORTS.filter(v => value.includes(v)) : [];
  }
  function sanitizeRemote(value) {
    if (!value || typeof value !== 'object') return null;
    return { effortSupported: value.effortSupported === true, reasoningLevels: levels(value.reasoningLevels) };
  }
  function sanitizeProbe(value) {
    if (!value || !['validating', 'non-validating', 'unknown'].includes(value.validation)) return null;
    if (!Array.isArray(value.reasoningLevels) || value.reasoningLevels.some(level => !EFFORTS.includes(level))
      || !Number.isInteger(value.requests) || value.requests < 1 || value.requests > 7
      || typeof value.probedAt !== 'string' || !Number.isFinite(Date.parse(value.probedAt))) return null;
    return { validation: value.validation, reasoningLevels: value.validation === 'validating' ? levels(value.reasoningLevels) : [],
      requests: value.requests,
      probedAt: value.probedAt,
      reason: typeof value.reason === 'string' ? value.reason.slice(0, 300) : '' };
  }
  function resolve(provider, model) {
    const profile = model.capabilityProfile || 'auto';
    let reasoningLevels = [], source = 'unknown', defaultEffort = null;
    if (provider.protocol === 'chatgpt-responses') return { reasoningLevels: levels(model.reasoningLevels), source: 'remote', defaultEffort: model.defaultEffort || null };
    if (provider.protocol !== 'openai-chat-completions') return { reasoningLevels, source, defaultEffort };
    if (profile === 'none') source = 'manual';
    else if (profile === 'custom') { reasoningLevels = levels(model.reasoningLevels); source = 'manual'; }
    else if (/^(?:Qwen\/)?Qwen3\.8-27B$/i.test(model.modelId)) {
      // Qwen 官方模型卡：low / medium / xhigh，默认 xhigh；没有 high。
      reasoningLevels = ['low', 'medium', 'xhigh']; source = 'official'; defaultEffort = 'xhigh';
    } else {
      const remote = sanitizeRemote(model.remoteCapabilities);
      if (remote?.effortSupported) { reasoningLevels = remote.reasoningLevels; source = 'remote'; }
      if (!reasoningLevels.length) {
        const probe = sanitizeProbe(model.reasoningProbe);
        if (probe) { reasoningLevels = probe.reasoningLevels; source = 'probe'; }
      }
    }
    return { reasoningLevels, source, defaultEffort };
  }
  function validate(provider, model) {
    const errors = {};
    if(model.visionInput!==undefined&&typeof model.visionInput!=='boolean')errors.visionInput='图片输入能力须为布尔值';
    if (!PROFILES.includes(model.capabilityProfile || 'auto')) errors.capabilityProfile = '请选择有效的能力配置';
    if (model.reasoningLevels !== undefined && (!Array.isArray(model.reasoningLevels)
      || model.reasoningLevels.some(v => !EFFORTS.includes(v)))) errors.reasoningLevels = '强度仅支持 low、medium、high、xhigh、max';
    const caps = resolve(provider, model);
    if (model.capabilityProfile === 'custom' && !caps.reasoningLevels.length) errors.reasoningLevels = '请至少勾选一个接口支持的强度；强度参数仅适用于 OpenAI 兼容协议';
    if (model.reasoningEffort != null && model.reasoningEffort !== '' && !caps.reasoningLevels.includes(model.reasoningEffort)) {
      errors.reasoningEffort = '该模型的能力配置不支持此强度，请选择支持的值或恢复默认';
    }
    return errors;
  }
  function remoteDetails(items) {
    return (Array.isArray(items) ? items : []).filter(i => i && typeof i.id === 'string' && i.id.length <= 200).map(item => {
      // 非标准扩展：仅保留明确声明的参数与枚举，不推测未返回的级别。
      const declared = item.reasoning_effort_levels || item.capabilities?.reasoning?.effort_levels;
      const reasoningLevels = levels(declared);
      const effortSupported = reasoningLevels.length > 0 || (Array.isArray(item.supported_parameters) && item.supported_parameters.includes('reasoning_effort'));
      return { modelId: item.id, remoteCapabilities: { effortSupported, reasoningLevels } };
    });
  }
  function canProbe(provider, model) {
    const caps = resolve(provider, model);
    return provider.protocol === 'openai-chat-completions' && (model.capabilityProfile || 'auto') === 'auto'
      && (!caps.reasoningLevels.length || caps.source === 'probe');
  }
  return { PROFILES, EFFORTS, LABELS, levels, sanitizeRemote, sanitizeProbe, canProbe, resolve, validate, remoteDetails };
});
