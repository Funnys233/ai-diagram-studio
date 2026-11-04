// 适配层公共部分：错误分类与模型调用错误类型
//
// 错误分类目标（验收要求）：区分认证失败、模型不存在、限流、超时、
// 地址/协议不匹配、服务端错误 —— 各自给出可读中文信息。
class ModelCallError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'ModelCallError';
    this.code = code;
    this.extra = extra || null;
  }
}

/** 把 HTTP 状态 + 响应体映射为可读的调用错误（绝不泄漏密钥） */
function classifyHttpError(status, data, providerLabel) {
  const bodyMsg = (() => {
    const d = data && typeof data === 'object' ? data : {};
    const msg = (d.error && (d.error.message || d.error.type)) || d.message || d.type;
    return typeof msg === 'string' ? msg.slice(0, 200) : '';
  })();

  if (status === 401 || status === 403) {
    return new ModelCallError('auth-failed',
      `${providerLabel} 认证失败（HTTP ${status}${bodyMsg ? '：' + bodyMsg : ''}），请检查 API 密钥是否有效`);
  }
  if (status === 404) {
    return new ModelCallError('model-not-found',
      `${providerLabel} 返回 404：地址或模型不存在（${bodyMsg || '无详情'}），请检查基础地址与模型 ID`);
  }
  if (status === 408) {
    return new ModelCallError('timeout', `${providerLabel} 请求超时（HTTP 408）`);
  }
  if (status === 429) {
    return new ModelCallError('rate-limited', `${providerLabel} 触发限流（HTTP 429${bodyMsg ? '：' + bodyMsg : ''}），请稍后重试`);
  }
  if (status === 400 || status === 422) {
    return new ModelCallError('protocol-mismatch',
      `${providerLabel} 拒绝了请求格式（HTTP ${status}${bodyMsg ? '：' + bodyMsg : ''}），请检查协议与参数配置是否匹配`);
  }
  if (status >= 500) {
    return new ModelCallError('server-error', `${providerLabel} 服务端错误（HTTP ${status}${bodyMsg ? '：' + bodyMsg : ''}）`);
  }
  return new ModelCallError('model-error', `${providerLabel} 返回意外状态 HTTP ${status}${bodyMsg ? '：' + bodyMsg : ''}`);
}

/** 网络层错误（超时/连接失败/DNS 等） */
function classifyNetworkError(err, providerLabel) {
  const msg = err && err.message ? err.message : String(err);
  if (/超时|timeout/i.test(msg)) {
    return new ModelCallError('timeout', `${providerLabel} ${msg}`);
  }
  if (err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EHOSTUNREACH' || err.code === 'ENOTFOUND')) {
    return new ModelCallError('model-unreachable', `${providerLabel} 无法连接（${err.code}），请检查基础地址与网络`);
  }
  return new ModelCallError('model-unreachable', `${providerLabel} 连接失败：${msg}`);
}

/** 拼接基础地址与协议路径：不产生 /v1/v1、不丢网关自定义路径、不重复 /chat/completions */
function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const tail = String(suffix || '').replace(/^\/+/, '');
  return base + '/' + tail;
}

module.exports = { ModelCallError, classifyHttpError, classifyNetworkError, joinUrl };
