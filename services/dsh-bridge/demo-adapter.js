'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const crypto = require('node:crypto');
// Explicit local simulation. No subprocess, tool, provider or model is invoked.
function createDemoAdapter({ delayMs = 1600 } = {}) {
  const active = new Map(), sessions = new Map(); let calls = 0;
  return {
    supportsContinuation: true,
    supportsFiles: true,
    supportsUsage: true,
    supportsModelSelection: true,
    canResume({ sessionId }) { return sessions.has(sessionId); },
    get calls() { return calls; },
    async run({ sessionId, prompt, continuation = false, documents = [], onProgress, onUsage, modelSelection }) {
      if (continuation && !sessions.has(sessionId)) throw Error('Demo context unavailable');
      const history = sessions.get(sessionId) || [];
      history.push({ prompt, documents, modelSelection, output: '' }); sessions.set(sessionId, history);
      calls++; const controller = new AbortController(); active.set(sessionId, controller); let output = '';
      try {
        const chunks = documents.length ? ['## 已读取参考资料\n\n', ...documents.map(doc => '**' + doc.name + '** · ' + doc.text.length + ' 字符\n\n' + doc.text.slice(0, 300) + '\n\n'), '> 这是本地模拟读取结果，没有调用真实模型。资料清单将保存为可下载的 CSV 文件。'] : continuation ? ['## 继续完善\n\n已接着上一轮继续处理。\n\n', '上一轮需求：' + history.at(-2).prompt + '\n\n', '本轮修改：' + prompt + '\n\n', '> 这是本地演示结果，用于验证连续追问。没有调用真实模型。'] : ['## 任务已接收\n\n正在梳理目标和输出要求。\n\n', '### 处理步骤\n\n1. 明确任务目标和边界。\n2. 把工作拆分成可检查的步骤。\n3. 汇总结果并核对遗漏。\n\n', '### 交付建议\n\n先完成最小可用版本，再通过实际场景验证。\n\n', '> 这是本地演示结果，用于验证任务处理流程。没有调用真实模型。'];
        for (const chunk of chunks) { await delay(delayMs, undefined, { signal: controller.signal }); output += chunk; history.at(-1).output = output; onProgress(output); }
        const references = history.flatMap(turn => turn.documents || []), csv = text => '"' + String(text).replaceAll('"', '""') + '"';
        const artifacts = documents.length || references.length && continuation ? [{ id: crypto.randomUUID(), name: '资料清单.csv', text: '\ufeff文件名,字符数\r\n' + references.map(doc => csv(doc.name) + ',' + doc.text.length).join('\r\n') + '\r\n' }] : /文件|导出|下载|保存/.test(prompt) ? [{ id: crypto.randomUUID(), name: '任务结果.md', text: output }] : [];
        const usage = { inputTokens: 100 + Math.ceil((prompt.length + documents.reduce((sum, doc) => sum + doc.text.length, 0)) / 3), outputTokens: Math.ceil(output.length / 3), cachedInputTokens: continuation ? 40 : 0, cacheWriteInputTokens: 0, calls: documents.length ? 3 : 1, complete: true };
        onUsage?.(usage); return { status: 'completed', output, artifacts, usage };
      } catch (error) { if (error.name !== 'AbortError') throw error; return { status: 'cancelled', output }; }
      finally { active.delete(sessionId); }
    },
    async cancel({ sessionId }) { active.get(sessionId)?.abort(); },
    async release({ sessionId }) { if (active.has(sessionId)) throw Error('Demo session active'); sessions.delete(sessionId); },
  };
}
module.exports = { createDemoAdapter };
