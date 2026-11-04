'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { MAX_TEXT_CHARS, MAX_PDF_PAGES, MAX_PAGE_IMAGE_BYTES } = require('./conversation-documents');
function clean(value) { return value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim(); }
async function checkWordArchive(bytes) {
  await new Promise((resolve, reject) => {
    require('yauzl').fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let count = 0, total = 0, declared = 0, done = false, stream;
      const fail = error => { if (done) return; done = true; stream?.destroy(); zip.close(); reject(error); };
      zip.on('error', fail); zip.on('end', () => { if (!done) { done = true; resolve(); } });
      zip.on('entry', entry => {
        if (done) return;
        count++; declared += entry.uncompressedSize;
        if (count > 2000 || declared > 20 * 1024 * 1024 || entry.uncompressedSize > 8 * 1024 * 1024 || entry.generalPurposeBitFlag & 1) return fail(Error('Word 文件解压内容过大、过于复杂或已加密，请精简后重试。'));
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (error, source) => {
          if (error) return fail(error); stream = source;
          source.on('error', fail);
          source.on('data', chunk => { total += chunk.length; if (total > 20 * 1024 * 1024) fail(Error('Word 文件解压内容过大，请精简后重试。')); });
          source.on('end', () => { if (!done) zip.readEntry(); });
        });
      });
      zip.readEntry();
    });
  });
}
async function extract() {
  const bytes = Buffer.from(workerData.bytes), type = workerData.type;
  let text = '', pages, pageImages;
  if (type === 'pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw Error('PDF 文件格式不正确。');
    const path = require('node:path');
    const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const visual = workerData.multimodal;
    const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, maxImageSize: visual ? 16000000 : 0, stopAtErrors: visual, useWorkerFetch: false,
      cMapUrl: path.join(base, 'cmaps') + path.sep, cMapPacked: true, standardFontDataUrl: path.join(base, 'standard_fonts') + path.sep, wasmUrl: path.join(base, 'wasm') + path.sep, verbosity: 0 });
    try {
      const pdf = await task.promise; pages = pdf.numPages;
      if (workerData.maxPdfPages !== undefined && pages > workerData.maxPdfPages) throw Error(`PDF 最多支持 ${workerData.maxPdfPages} 页，请拆分后上传。`);
      if (visual && pages > MAX_PDF_PAGES) throw Error(`PDF 画面读取最多支持 ${MAX_PDF_PAGES} 页，请拆分后上传，或关闭多模态仅读文字。`);
      if (pages > 100) throw Error('PDF 最多支持 100 页，请拆分后上传。');
      if (visual) pageImages = [];
      let imageBytes = 0;
      for (let number = 1; number <= pages; number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent();
        const pageText = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
        if (pageText.trim()) text += `[第 ${number} 页]\n` + pageText + '\n\n';
        if (visual) {
          const original = page.getViewport({ scale: 1 });
          const budget = Math.min(3 * 1024 * 1024, Math.floor((MAX_PAGE_IMAGE_BYTES - imageBytes) / (pages - number + 1)));
          let image;
          // Bound each page's share so the final pages are not dropped when
          // the request fills up. Re-render smaller only if JPEG alone cannot fit.
          for (const maxSide of [1600, 1200]) {
            const viewport = page.getViewport({ scale: Math.min(2, maxSide / Math.max(original.width, original.height)) });
            const surface = pdf.canvasFactory.create(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
            try {
              await page.render({ canvasContext: surface.context, viewport, background: '#ffffff' }).promise;
              for (const quality of [85, 70, 55]) {
                image = await surface.canvas.encode('jpeg', quality);
                if (image.length <= budget) break;
              }
            } finally { pdf.canvasFactory.destroy(surface); }
            if (image.length <= budget) break;
          }
          if (image.length > budget) throw Error('PDF 页面画面过于复杂，压缩后仍超过大小上限，请拆分文件，或关闭多模态仅读文字。');
          imageBytes += image.length;
          pageImages.push('data:image/jpeg;base64,' + image.toString('base64'));
        }
        page.cleanup();
        if (text.length > MAX_TEXT_CHARS) throw Error('单份文档正文不能超过 5 万字符，请拆分后上传。');
      }
      if (!text.trim() && !visual) throw Error('PDF 没有可提取的文字，可能是扫描件。请开启多模态后重新添加此 PDF。');
    } finally { await task.destroy(); }
  } else if (type === 'docx') {
    if (!bytes.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) throw Error('Word 文件格式不正确，请另存为 .docx 后重试。');
    await checkWordArchive(bytes);
    const result = await require('mammoth').extractRawText({ buffer: bytes }, { externalFileAccess: false });
    text = result.value;
  } else {
    try {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
      else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); } }
    } catch { throw Error('文本编码无法识别，请另存为 UTF-8 后重试。'); }
    if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) throw Error('文件不是可读取的文本，请检查格式。');
  }
  text = clean(text);
  if (!text && !pageImages?.length) throw Error('文档没有可读取的文字。');
  if (text.length > MAX_TEXT_CHARS) throw Error('单份文档正文不能超过 5 万字符，请拆分后上传。');
  return { text, ...(pages ? { pages } : {}), ...(pageImages ? { pageImages } : {}) };
}
extract().then(value => parentPort.postMessage(value)).catch(error => {
  const known = /^(PDF |Word |单份文档|文档没有|文件不是|文本编码)/.test(error.message || '');
  parentPort.postMessage({ error: error.name === 'PasswordException' ? 'PDF 已加密，请解密后上传。' : known ? error.message : '文档无法读取，请确认文件未损坏、未加密并使用受支持的格式。' });
});
