/**
 * draw.io 文件格式处理（零依赖，Node 与浏览器共用；不含 zlib，故两端都能用）
 *
 * 明确区分两种载荷：
 *   1. 单页图模型 <mxGraphModel>（编辑器在 pages=0 单页时回传这种）
 *   2. 完整文件 <mxfile><diagram …>…</diagram></mxfile>（默认 embed 模式回传这种）
 *
 * <diagram> 的内容有两种编码：
 *   - 明文：直接是 <mxGraphModel> 子元素（Editor.defaultCompressed = false，默认就是这种）
 *   - 压缩：一段 base64 文本（Graph.compress = base64(deflateRaw(encodeURIComponent(xml)))）
 *     解压需要 zlib，Node 侧见 lib/drawio-zlib.js；本模块把「需要解压」如实标出来。
 *
 * 关键点：
 *   - 下载完整 mxfile 时直接使用原文件，只替换当前页内容，绝不重复包裹
 *   - 替换用源码偏移做「外科手术」，其余页面与 mxfile 属性字节级不变 → 多页得到保留
 */
(function (global, factory) {
  const xml = (typeof module === 'object' && module.exports)
    ? require('./xml.js')
    : global.DiagramXml;
  const api = factory(xml);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.DiagramFile = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Xml) {
  'use strict';

  const WRAPPER = 'mxfile';

  function error(code, message) {
    return { ok: false, error: { code, message } };
  }

  /**
   * 解析任意 draw.io 载荷（mxfile 或 mxGraphModel）。
   * @param {string} text
   * @returns {{kind: 'mxfile'|'model'|'empty'|'invalid'|'unknown', pages: Array, pageCount: number, error?: object}}
   */
  function parseFile(text) {
    if (typeof text !== 'string' || text.trim() === '') {
      return { kind: 'empty', pages: [], pageCount: 0 };
    }
    let parsed;
    try {
      parsed = Xml.parse(text);
    } catch (e) {
      if (e && e.name === 'XmlError') {
        return { kind: 'invalid', pages: [], pageCount: 0, error: { code: 'xml-' + e.code, message: e.message } };
      }
      throw e;
    }

    const root = parsed.root;

    if (root.name === 'mxGraphModel') {
      const page = {
        index: 0,
        name: 'Page-1',
        id: null,
        encoding: 'xml',
        modelNode: root,
        contentStart: 0,
        contentEnd: parsed.source.length,
        encodedText: null,
      };
      return { kind: 'model', doc: parsed, source: parsed.source, pages: [page], pageCount: 1 };
    }

    if (root.name === WRAPPER) {
      const diagrams = root.children.filter((c) => c.name === 'diagram');
      const otherChildren = root.children.filter((c) => c.name !== 'diagram');
      const pages = diagrams.map((diagram, index) => {
        const modelNode = Xml.firstChild(diagram, 'mxGraphModel');
        const textContent = Xml.textOf(diagram);
        let encoding = 'empty';
        if (modelNode) encoding = 'xml';
        else if (textContent.trim() !== '') encoding = 'encoded';
        return {
          index,
          name: diagram.attributes.name !== undefined ? diagram.attributes.name : 'Page-' + (index + 1),
          id: diagram.attributes.id !== undefined ? diagram.attributes.id : null,
          encoding,
          modelNode,
          contentStart: diagram.innerStart,
          contentEnd: diagram.innerEnd,
          encodedText: encoding === 'encoded' ? textContent : null,
        };
      });
      return {
        kind: 'mxfile',
        doc: parsed,
        source: parsed.source,
        pages,
        pageCount: pages.length,
        warning: otherChildren.length > 0 ? `mxfile 下存在非 diagram 元素 <${otherChildren[0].name}>` : null,
      };
    }

    return {
      kind: 'unknown',
      pages: [],
      pageCount: 0,
      error: { code: 'bad-root', message: `不支持的根节点 <${root.name}>，应为 <mxGraphModel> 或 <mxfile>` },
    };
  }

  function clampPageIndex(index, pageCount) {
    if (!Number.isInteger(index) || index < 0 || index >= pageCount) return 0;
    return index;
  }

  /**
   * 按稳定标识查找页面的下标：先按 <diagram id> 精确匹配，再退化到页名匹配。
   * 页面 id 在重排 / 增删页时保持不变，因此用它保护「AI 结果写回哪一页」。
   * @returns {number} 找不到返回 -1
   */
  function findPageIndexById(info, pageId) {
    if (!info || !Array.isArray(info.pages) || pageId === undefined || pageId === null || pageId === '') return -1;
    const byId = info.pages.findIndex((p) => p.id !== null && p.id !== undefined && String(p.id) === String(pageId));
    if (byId !== -1) return byId;
    return info.pages.findIndex((p) => p.name !== null && p.name !== undefined && String(p.name) === String(pageId));
  }

  /**
   * 取出某一页的明文 mxGraphModel 文本。无状态：源码由调用方显式传入。
   * @param {string} fileText 原始载荷
   * @param {object} page parseFile 返回的页面对象
   * @param {(encoded:string)=>string} [decompress] 压缩页需要解压函数（Node 侧提供）
   */
  function resolvePageModel(fileText, page, decompress) {
    if (!page) return error('missing-page', '请求的页面不存在');
    if (page.encoding === 'empty') return { ok: true, xml: null, empty: true };
    if (page.encoding === 'xml') {
      if (!page.modelNode) return error('missing-model', '该页面缺少 <mxGraphModel> 内容');
      return { ok: true, xml: Xml.sliceNode(fileText, page.modelNode), empty: false };
    }
    if (typeof decompress !== 'function') {
      return error('needs-decompress', '该页面内容是压缩存储的，需要解压后才能读取');
    }
    let decoded;
    try {
      decoded = decompress(page.encodedText);
    } catch (e) {
      return error('decompress-failed', `压缩的 diagram 内容解压失败：${e.message}`);
    }
    if (typeof decoded !== 'string' || decoded.trim() === '') {
      return error('decompress-empty', '压缩的 diagram 内容解压后为空');
    }
    return { ok: true, xml: decoded.trim(), empty: false };
  }

  /** 用新的单页图模型替换某一页的内容，其他页面与文件属性保持不变 */
  function splicePageContent(fileText, page, content) {
    if (!page) throw new Xml.XmlError('missing-page', '请求的页面不存在', 0);
    return fileText.slice(0, page.contentStart) + content + fileText.slice(page.contentEnd);
  }

  /** 生成一个标准的单页 mxfile */
  function buildMxfile(modelXml, options) {
    const opts = options || {};
    const name = opts.name || 'Page-1';
    const id = opts.id || 'diagram-1';
    const content = typeof opts.compress === 'function' ? opts.compress(modelXml) : modelXml;
    return `<mxfile host="DiagramAI" type="device">\n  <diagram name="${Xml.escapeAttr(name)}" id="${Xml.escapeAttr(id)}">${content}</diagram>\n</mxfile>`;
  }

  /**
   * 构造下载内容。禁止重复包裹：
   *   - 载荷本来就是完整 mxfile → 只替换当前页内容，其余原样保留
   *   - 载荷是裸 mxGraphModel → 包裹一次成 mxfile
   * @param {{payload: string, pageIndex?: number, modelXml?: string|null, name?: string, compress?: Function}} input
   */
  function buildDownloadContent(input) {
    const payload = input && input.payload;
    const info = parseFile(payload);
    if (info.kind === 'empty') return error('empty-input', '当前没有可下载的图表');
    if (info.kind === 'invalid' || info.kind === 'unknown') {
      return error((info.error && info.error.code) || 'invalid-file', (info.error && info.error.message) || '当前图表数据不是合法的 draw.io 内容，已阻止下载');
    }

    if (info.kind === 'model') {
      const model = input.modelXml || payload;
      return {
        ok: true,
        kind: 'mxfile',
        wrapped: true,
        content: buildMxfile(model, { name: input.name || 'Page-1', compress: input.compress }),
      };
    }

    // 完整 mxfile：不重新序列化，只做当前页替换
    if (!input.modelXml) {
      return { ok: true, kind: 'mxfile', wrapped: false, content: payload };
    }
    const index = clampPageIndex(input.pageIndex, info.pageCount);
    const page = info.pages[index];
    const content = (page.encoding === 'encoded' && typeof input.compress === 'function')
      ? input.compress(input.modelXml)
      : input.modelXml;
    return {
      ok: true,
      kind: 'mxfile',
      wrapped: false,
      pageIndex: index,
      content: splicePageContent(payload, page, content),
    };
  }

  return {
    parseFile,
    resolvePageModel,
    splicePageContent,
    buildMxfile,
    buildDownloadContent,
    clampPageIndex,
    findPageIndexById,
  };
});
