'use strict';
// Independent implementation of the baseline / invalid-value / levels approach
// reviewed in dsh-workbuddy-connect 0.7.2 (MIT). Acceptance is not effectiveness.
const { randomBytes } = require('node:crypto');
const { EFFORTS } = require('./model-capabilities');
function declaredEfforts(attempt, rejectedValue) {
  if (![400, 422].includes(attempt.status) || typeof rejectedValue !== 'string') return [];
  const error = attempt.data?.error || attempt.data?.extError || {};
  if (error.param && error.param !== 'reasoning_effort') return [];
  const message = String(error.message || attempt.data?.message || '');
  // Some relays omit `param` and abbreviate the rejected value. Match our
  // unpredictable sentinel before trusting an otherwise ambiguous enum error.
  const invalid = message.match(/\binvalid value\s*:\s*['"]([^'"]+)['"]/i)?.[1];
  if (invalid !== rejectedValue && invalid !== rejectedValue.slice(0, 3) + '...' + rejectedValue.slice(-3)) return [];
  const enumeration = message.match(/\bsupported values (?:are|include)\s*:\s*(.+)$/i)?.[1];
  if (!enumeration) return [];
  const values = [...enumeration.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1]);
  const remainder = enumeration.replace(/['"][^'"]+['"]/g, '').replace(/\b(?:and|or)\b/gi, '');
  const allowed = ['none', 'minimal', ...EFFORTS, 'ultra'];
  if (!values.length || !/^[\s,.;]*$/.test(remainder) || values.some(value => !allowed.includes(value)) || values.includes(rejectedValue)) return [];
  return EFFORTS.filter(level => values.includes(level));
}
function rejectsEffort(attempt) {
  if (![400, 422].includes(attempt.status)) return false;
  const error = attempt.data?.error || attempt.data?.extError || {};
  const code = String(error.code || attempt.data?.code || '').toLowerCase();
  if (['invalid_reasoning_effort', 'unsupported_reasoning_effort'].includes(code)) return true;
  const message = String(error.message || attempt.data?.message || '');
  const namesField = error.param === 'reasoning_effort' || /reasoning_effort/i.test(message);
  return namesField && (/invalid|unsupported|not supported|not allowed|allowed values|supported values|(?:must|should) be (?:one of|in)|不支持|无效|非法|取值/i.test(message)
    || ['invalid_value', 'invalid_argument', 'invalid_parameter_error', 'unsupported_value', 'invalid_request_error'].includes(code));
}
async function probe({ send, signal, onProgress }) {
  const accepts = attempt => attempt.status === 200 && attempt.accepted === true;
  let requests = 0;
  const attempt = async (effort, stage) => {
    signal?.throwIfAborted(); onProgress?.({ stage, requests }); requests++;
    const result = await send(effort);
    signal?.throwIfAborted();
    return result;
  };
  const unknown = (stage, result) => {
    const status = result.status ? `HTTP ${result.status}` : result.errorCode === 'timeout' ? '请求超时' : '连接失败';
    let reason;
    if (result.status === 429) reason = `${stage}遇到上游限流（HTTP 429），已停止检测，请稍后重试；这不能说明模型不支持强度。`;
    else if (stage === '普通请求') reason = `普通请求未通过（${status}），请检查认证、额度或接口响应格式后重试。`;
    else if (stage === '非法档位检测' && [400, 422].includes(result.status)) {
      reason = `普通请求已成功，但接口未返回明确指向 reasoning_effort 的档位错误（${status}），无法确认强度支持。可按接口文档手动配置。`;
    } else reason = `${stage}中断（${status}），无法确认支持情况，未保留部分检测档位。`;
    return { validation: 'unknown', reasoningLevels: [], requests, reason };
  };
  const baseline = await attempt(undefined, '普通请求');
  if (!accepts(baseline)) return unknown('普通请求', baseline);
  const sentinelValue = 'diagram_probe_' + randomBytes(12).toString('hex');
  const sentinel = await attempt(sentinelValue, '非法档位');
  if (accepts(sentinel)) return { validation: 'non-validating', reasoningLevels: [], requests,
    reason: '接口接受随机非法值，可能忽略该参数，不能据此启用档位。' };
  const declared = declaredEfforts(sentinel, sentinelValue);
  if (declared.length) return { validation: 'validating', reasoningLevels: declared, requests,
    reason: `接口拒绝了随机非法档位，并明确声明支持 ${declared.join(' / ')}；已按接口声明启用，未逐档验证推理效果。` };
  if (!rejectsEffort(sentinel)) return unknown('非法档位检测', sentinel);
  const accepted = [];
  for (const level of EFFORTS) {
    const result = await attempt(level, level);
    if (accepts(result)) accepted.push(level);
    else if (!rejectsEffort(result)) return unknown(`${level} 档位检测`, result);
  }
  signal?.throwIfAborted();
  return { validation: 'validating', reasoningLevels: accepted, requests,
    reason: accepted.length ? '已确认接口接受这些档位；不保证它们会改变推理效果。' : '接口校验参数，但未接受任何候选档位。' };
}
module.exports = { probe, rejectsEffort, declaredEfforts };
