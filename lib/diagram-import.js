// Full-document import validation. Compressed pages are decoded with a bounded
// output, then every page is checked before anything reaches the editor.
const Xml = require('./xml');
const Model = require('./graphmodel');
const File = require('./drawio-format');
const { decompressDiagram } = require('./drawio-zlib');

const EMPTY_MODEL = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

function validateDocument(payload, options = {}) {
  const maxFileChars = options.maxFileChars || 200000;
  const maxModelChars = options.maxModelChars || 200000;
  const fail = (message, code = 'invalid-diagram') => ({ ok: false, error: { code, message } });
  if (typeof payload !== 'string' || !payload.trim()) return fail('图表文件为空');
  if (payload.length > maxFileChars) return fail(`图表超过 ${maxFileChars} 字符上限`, 'file-too-large');
  const info = File.parseFile(payload);
  if (!['model', 'mxfile'].includes(info.kind)) return fail(info.error?.message || '不是 draw.io 图表文件');
  if (!info.pages.length || info.warning) return fail(info.warning || '文件没有图表页面');
  const ids = new Set();
  let normalized = payload;
  const replacements = [];
  for (const page of info.pages) {
    if (page.id != null) {
      if (!page.id || ids.has(page.id)) return fail(`第 ${page.index + 1} 页的页面 ID 为空或重复`);
      ids.add(page.id);
    }
    if (info.kind === 'mxfile') {
      const diagram = info.doc.root.children[page.index];
      if (page.encoding === 'xml'
        ? diagram.children.length !== 1 || Xml.textOf(diagram).trim()
        : diagram.children.length !== 0) return fail(`第 ${page.index + 1} 页包含多余内容`);
    }
    const resolved = File.resolvePageModel(payload, page,
      encoded => decompressDiagram(encoded, { maxOutputLength: maxModelChars * 12 }));
    if (!resolved.ok) return fail(`第 ${page.index + 1} 页：${resolved.error.message}`);
    const model = resolved.xml || EMPTY_MODEL;
    if (model.length > maxModelChars) return fail(`第 ${page.index + 1} 页解压后超过 ${maxModelChars} 字符上限`, 'file-too-large');
    const checked = Model.validateGraphModel(model, { maxCells: options.maxCells || 5000 });
    if (!checked.ok) return fail(`第 ${page.index + 1} 页：${checked.error.message}`);
    if (info.kind === 'mxfile') replacements.push({ page, model });
  }
  // Work from the end so offsets and untouched file metadata remain valid.
  for (const { page, model } of replacements.reverse()) normalized = File.splicePageContent(normalized, page, model);
  if (normalized.length > maxFileChars) return fail(`图表解压后超过 ${maxFileChars} 字符上限`, 'file-too-large');
  return { ok: true, payload: normalized, pageCount: info.pageCount };
}

module.exports = { validateDocument };
