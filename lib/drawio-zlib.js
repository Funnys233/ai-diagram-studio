// draw.io 压缩内容的编解码（Node 专用，依赖内置 zlib）
//
// 与 draw.io 官方 Graph.compress / Graph.decompress 完全一致：
//   compress   = base64( deflateRaw( encodeURIComponent(xml) ) )
//   decompress = decodeURIComponent( inflateRaw( base64decode(data) ) )
// 参考：jgraph/drawio src/main/webapp/js/grapheditor/Graph.js
const zlib = require('zlib');

function decompressDiagram(encoded, options) {
  const cleaned = String(encoded == null ? '' : encoded).replace(/\s+/g, '');
  if (cleaned === '') throw new Error('压缩内容为空');
  const buf = Buffer.from(cleaned, 'base64');
  if (buf.length === 0) throw new Error('base64 解码结果为空');
  let raw;
  try {
    raw = zlib.inflateRawSync(buf, options);
  } catch (e) {
    // 兼容少数用 zlib 包装（deflate 而非 raw deflate）导出的文件
    raw = zlib.inflateSync(buf, options);
  }
  const text = raw.toString('utf8');
  try {
    return decodeURIComponent(text);
  } catch (e) {
    return text;
  }
}

function compressDiagram(modelXml) {
  return zlib.deflateRawSync(Buffer.from(encodeURIComponent(modelXml), 'utf8')).toString('base64');
}

module.exports = { decompressDiagram, compressDiagram };
