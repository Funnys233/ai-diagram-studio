'use strict';
const Documents = require('./conversation-documents');
const { extractDocument } = require('./document-extraction');
const { safeName } = require('../services/dsh-bridge/file-protocol');
const { DocumentError, MAX_FILE_BYTES, MAX_TEXT_CHARS } = Documents;
const MAX_PDF_PAGES = 50;
const TEXT_TYPES = new Set(['txt', 'md', 'markdown', 'csv', 'json', 'js', 'ts', 'tsx', 'jsx', 'py', 'html', 'css', 'svg', 'drawio', 'yaml', 'yml', 'xml', 'sql', 'log']);
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'avif']);
const extensionFor = name => typeof name === 'string' && name.includes('.') ? name.split('.').at(-1).toLowerCase() : '';
function typeForName(name) {
  const extension = extensionFor(name);
  return ['pdf', 'docx'].includes(extension) || TEXT_TYPES.has(extension) ? extension === 'markdown' ? 'md' : extension : null;
}
function validName(name) {
  return safeName(name);
}
async function extractAgentFile(body, { signal, timeoutMs } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'data,name') throw new DocumentError('附件上传只接受文件名和文件数据。', 'invalid-agent-file');
  if (!validName(body.name)) throw new DocumentError('文件名含有不支持的字符、保留名称，或超过 160 个字符，请修改后重试。', 'invalid-agent-file-name');
  const type = typeForName(body.name);
  if (!type) throw new DocumentError(IMAGE_TYPES.has(extensionFor(body.name)) ? '暂不支持图片附件，请上传 PDF、DOCX 或文字资料。' : '支持 PDF、DOCX 和常见文本、代码文件；旧版 .doc 请先另存为 .docx。', 'unsupported-agent-file');
  // Reuse the existing bounded worker and extraction lock. Code/text files are
  // decoded as text only; their original names and types stay in the metadata.
  const name = type === 'pdf' || type === 'docx' ? body.name : 'agent-reference.txt';
  try {
    const document = await extractDocument({ name, data: body.data }, { signal, timeoutMs, maxPdfPages: MAX_PDF_PAGES });
    return { ...document, name: body.name, type };
  } catch (error) {
    if (type === 'pdf' && /没有可提取的文字|扫描件/.test(error.message || '')) throw new DocumentError('暂时只能读取文字，请提供文字版文件。', 'agent-file-text-required', 422);
    throw error;
  }
}
module.exports = { extractAgentFile, MAX_FILE_BYTES, MAX_TEXT_CHARS, MAX_PDF_PAGES, typeForName, validName };
