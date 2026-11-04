'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
const crypto = require('node:crypto');
const Documents = require('./conversation-documents');
let active = false;
async function extractDocument(body, { signal, timeoutMs, maxPdfPages } = {}) {
  const { DocumentError } = Documents;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['name','data','multimodal'].includes(k)) || !Documents.validName(body.name) || !Documents.typeForName(body.name)) throw new DocumentError('支持 PDF、Word（.docx）、TXT、Markdown 和 CSV。旧版 .doc 请另存为 .docx。');
  if (body.multimodal !== undefined && typeof body.multimodal !== 'boolean') throw new DocumentError('multimodal 必须是布尔值。');
  if (maxPdfPages !== undefined && (!Number.isSafeInteger(maxPdfPages) || maxPdfPages < 1 || maxPdfPages > 100)) throw new DocumentError('PDF 页数限制必须在 1–100 页之间。');
  if (typeof body.data !== 'string' || !body.data.length || body.data.length > Math.ceil(Documents.MAX_FILE_BYTES / 3) * 4 || body.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data)) throw new DocumentError('文档数据无效，单个文件不能超过 5 MB。');
  const bytes = Buffer.from(body.data, 'base64');
  if (!bytes.length || bytes.length > Documents.MAX_FILE_BYTES || bytes.toString('base64') !== body.data) throw new DocumentError('文档数据无效，单个文件不能超过 5 MB。');
  signal?.throwIfAborted();
  if (active) throw new DocumentError('服务器正在读取其他文档，请稍后重新添加。', 'document-busy', 429);
  active = true;
  try {
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'document-worker.cjs'), { env: {}, workerData: { bytes, type: Documents.typeForName(body.name), multimodal: body.multimodal === true, ...(maxPdfPages !== undefined ? { maxPdfPages } : {}) }, resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        worker.terminate().catch(() => {}); error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new DOMException('Aborted', 'AbortError'));
      const timer = setTimeout(() => finish(new DocumentError('文档读取超时，请拆分文件后重试。', 'document-timeout', 422)), timeoutMs ?? (body.multimodal === true && Documents.typeForName(body.name) === 'pdf' ? 90000 : 30000));
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', value => value.error ? finish(new DocumentError(value.error, 'document-unreadable', 422)) : finish(null, value));
      worker.on('error', () => finish(new DocumentError('文档过于复杂或无法读取，请拆分或另存后重试。', 'document-unreadable', 422)));
      worker.on('exit', () => { if (!settled) finish(new DocumentError('文档读取中断，请重新添加。', 'document-unreadable', 422)); });
    });
    return Documents.normalizeDocuments([{ id: crypto.randomUUID(), name: body.name, type: Documents.typeForName(body.name), size: bytes.length, ...result }])[0];
  } finally { active = false; }
}
module.exports = { extractDocument };
