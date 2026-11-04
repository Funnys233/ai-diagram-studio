// 统一安全错误边界（R2）：
// 上游 error.message、连接异常与测试详情在进入「响应 / 日志 / 持久化」之前，
// 必须先经过这里擦除密钥。
//   1. 已知密钥（当前配置里每个提供商的 apiKey）逐字替换为 ***
//      —— 不设长度下限：短密钥同样是密钥，必须脱敏
//   2. 无法枚举密钥的场景（历史遗留的已持久化错误详情）兜底擦除常见认证头形态
const AUTH_HEADER_RE = /\b(Bearer|x-api-key|api[-_]?key)["':= ]+[A-Za-z0-9._~+/=-]{6,}/gi;

/**
 * @param {string} text 任意错误/日志文本
 * @param {string[]} secrets 已知密钥列表（可为空；空串跳过，其余无论长短都擦除）
 * @returns {string} 擦除后的文本；非字符串输入安全降级为字符串
 */
function redactSecrets(text, secrets) {
  let out = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (Array.isArray(secrets)) {
    // 长密钥先替换：避免短密钥先命中，把长密钥截断成残留片段（如 'abc' 先于 'abcdef'）
    const list = secrets
      .filter((s) => typeof s === 'string' && s !== '' && out.includes(s))
      .sort((a, b) => b.length - a.length);
    for (const s of list) out = out.split(s).join('***');
  }
  // 擦除标记后强制补空白边界：避免「Bearer ***），请检查」这类形态被下游
  // 任意 \S+ 扫描重新拼成疑似凭据（全角标点/中文也属于 \S）
  return out.replace(AUTH_HEADER_RE, '$1 ***').replace(/\*\*\*(?=\S)/g, '*** ');
}

module.exports = { redactSecrets };
