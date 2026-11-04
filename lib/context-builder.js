// 构造发给模型的「当前图表」上下文
//
// 硬性要求：不得对图表做字符截断（旧实现 slice(0, 24000) 会切掉 </mxGraphModel>
// 与后半部分节点，导致模型基于残缺图修改 → 丢节点）。
// 这里只有两种结果：
//   1. 完整 XML（可能再附加一份结构摘要，帮助模型定位节点）
//   2. 超过上限 → 明确拒绝，交回上层返回可理解的错误，画布保持不动
const Xml = require('./xml.js');
const Model = require('./graphmodel.js');

const DEFAULT_MAX_CHARS = 200000;
const DIGEST_XML_THRESHOLD = 40000;
const DIGEST_MAX_CELLS = 200;

/** 生成人类/模型可读的节点与连线摘要（不含样式细节时也不丢节点） */
function buildPageDigest(modelXml) {
  const parsed = Xml.parse(modelXml);
  const rootEls = Xml.childElements(parsed.root, 'root');
  if (rootEls.length !== 1) return '';
  const lines = [];
  for (const { cell, wrapper } of Model.collectCells(rootEls[0])) {
    if (!cell) continue;
    const id = cell.attributes.id || '?';
    const label = cell.attributes.value ? ` label="${cell.attributes.value}"` : '';
    const geom = Xml.firstChild(cell, 'mxGeometry');
    if (cell.attributes.vertex === '1') {
      const pos = geom ? ` pos=(${geom.attributes.x || 0},${geom.attributes.y || 0})` : '';
      const size = geom ? ` size=${geom.attributes.width || '?'}x${geom.attributes.height || '?'}` : '';
      const container = wrapper ? ` 包装=<${wrapper.name}>` : '';
      lines.push(`节点 id=${id}${label}${pos}${size} parent=${cell.attributes.parent || '1'}${container}`);
    } else if (cell.attributes.edge === '1') {
      const src = cell.attributes.source || '(悬空)';
      const tgt = cell.attributes.target || '(悬空)';
      lines.push(`连线 id=${id} ${src} → ${tgt}${label}`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {string} modelXml 当前页的完整 mxGraphModel
 * @param {{maxChars?: number, pageIndex?: number, pageCount?: number}} [options]
 */
function buildModelContext(modelXml, options) {
  const opts = options || {};
  const maxChars = opts.maxChars || DEFAULT_MAX_CHARS;
  const pageIndex = Number.isInteger(opts.pageIndex) ? opts.pageIndex : 0;
  const pageCount = Number.isInteger(opts.pageCount) ? opts.pageCount : 1;

  const validation = Model.validateGraphModel(modelXml);
  if (!validation.ok) return { ok: false, error: validation.error };

  if (modelXml.length > maxChars) {
    return {
      ok: false,
      error: {
        code: 'model-too-large',
        message: `当前第 ${pageIndex + 1} 页图表有 ${modelXml.length} 个字符，超过安全上限 ${maxChars}。服务端不会截断图表（截断会丢节点），已保留原画布；请先拆分或精简该页后再让 AI 修改。`,
        size: modelXml.length,
        limit: maxChars,
      },
    };
  }

  const wantsDigest = modelXml.length > DIGEST_XML_THRESHOLD && validation.stats.cells <= DIGEST_MAX_CELLS;
  let digest = null;
  if (wantsDigest) {
    try {
      digest = buildPageDigest(modelXml);
    } catch (e) {
      digest = null;
    }
  }

  return {
    ok: true,
    xml: modelXml,
    digest,
    stats: validation.stats,
    pageIndex,
    pageCount,
    size: modelXml.length,
  };
}

/** 拼装 user message：包含完整 XML（不截断）+ 可选结构摘要 + 多页限制说明 */
function composeUserMessage(userMessage, context) {
  const parts = [userMessage];
  if (!context) return parts.join('\n\n');

  if (context.pageCount > 1) {
    parts.push(`【多页说明】当前文件共 ${context.pageCount} 页，你只能修改第 ${context.pageIndex + 1} 页；其它页面的内容与 id 必须原样保留，输出时不要改动它们。`);
  }
  parts.push(`【当前第 ${context.pageIndex + 1} 页 mxGraphModel】（完整内容，未做任何截断，共 ${context.size} 字符）\n${context.xml}`);
  if (context.digest) {
    parts.push(`【结构摘要】（便于定位，仅列出节点与连线）\n${context.digest}`);
  }
  return parts.join('\n\n');
}

module.exports = { buildModelContext, buildPageDigest, composeUserMessage, DEFAULT_MAX_CHARS };
