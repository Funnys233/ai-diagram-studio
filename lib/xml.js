/**
 * 严格 XML 解析器（零依赖，Node 与浏览器共用）
 *
 * 为什么不用标签栈：标签栈只能发现「标签不配对」，会把
 *   value="A & B"（未转义的 &）、id=broken（属性无引号）、
 *   重复属性、同名多根节点 等非法输入当作合法 XML 放行。
 * 这里实现一个真正的词法 + 递归下降解析器：
 *   - 属性值必须带引号
 *   - 文本与属性值中的 & 必须是合法实体引用（amp/lt/gt/quot/apos/#nnn/#xHH）
 *   - 同一标签内属性名不可重复
 *   - 标签必须正确配对、只能有一个根节点
 *   - 拒绝 DOCTYPE、控制字符、非法元素/属性名、过深嵌套
 * 解析结果保留每个节点的源码偏移，便于做「外科手术式」的文本替换
 * （多页 mxfile 只替换当前页，其余页面字节级保持不变）。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else global.DiagramXml = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
  const ENTITY_RE = /^&(?:#x[0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);/;
  const MAX_DEPTH = 512;

  /**
   * XMLDecl ::= '<?xml' VersionInfo EncodingDecl? SDDecl? S? '?>'
   * 只接受标准形状的声明：version 必须存在且在首位，encoding / standalone 顺序固定、
   * 取值合法，之后只能有空白。`<?xml rubbish?>` 这类会在这里被拒绝。
   */
  const DECL_RE = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*("1\.[0-9]+"|'1\.[0-9]+')([ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*("[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?([ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*("(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>$/;

  /**
   * XML 1.0 的 Char 产生式：允许 #x9 / #xA / #xD、#x20-#xD7FF、#xE000-#xFFFD、
   * #x10000-#x10FFFF。&#0;、代理区、0xFFFE/0xFFFF 都不合法。
   */
  function isValidXmlChar(code) {
    return code === 0x9 || code === 0xa || code === 0xd
      || (code >= 0x20 && code <= 0xd7ff)
      || (code >= 0xe000 && code <= 0xfffd)
      || (code >= 0x10000 && code <= 0x10ffff);
  }

  class XmlError extends Error {
    constructor(code, message, index) {
      super(message);
      this.name = 'XmlError';
      this.code = code;
      this.index = typeof index === 'number' ? index : -1;
    }
  }

  function fail(code, message, index) {
    throw new XmlError(code, message, index);
  }

  function describeAt(source, index) {
    const around = source.slice(Math.max(0, index - 20), index + 20).replace(/\s+/g, ' ');
    return `位置 ${index}（…${around}…）`;
  }

  function isNameStart(ch) {
    return /[A-Za-z_:]/.test(ch);
  }

  function isNameChar(ch) {
    return /[-A-Za-z0-9_.:]/.test(ch);
  }

  function isSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  }

  /**
   * 按「码位」检查内容是否全部落在 XML Char 产生式内。
   * 必须按码位而不是按 UTF-16 码元检查：emoji 等增补平面字符是代理对，
   * 照码元检查会把合法字符误判为非法；而字面出现的孤立代理字符必须被拒绝。
   * 错误码：C0 控制字符沿用 control-char（保持既有调用方与测试的语义），
   * 其余非法码位（孤立代理、0xFFFE/0xFFFF 等）用 bad-char。
   */
  function checkXmlChars(value, source, baseIndex, what) {
    for (let i = 0; i < value.length;) {
      const code = value.codePointAt(i);
      if (!isValidXmlChar(code)) {
        const here = baseIndex + i;
        const label = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
        if (code < 0x20) {
          fail('control-char', `${what}中存在非法控制字符（${label}），${describeAt(source, here)}`, here);
        }
        fail('bad-char', `${what}中存在 XML 不允许的字符（${label}，不属于 XML Char），${describeAt(source, here)}`, here);
      }
      i += code > 0xffff ? 2 : 1;
    }
  }

  /** 行结束规范化：CRLF / CR → LF（XML 2.11 End-of-Line Handling） */
  function normalizeLineEndings(text) {
    if (text.indexOf('\r') === -1) return text;
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /**
   * 属性值规范化（XML 3.3.3）。顺序很关键：
   *   1. 先做行结束规范化（CRLF / CR → LF）
   *   2. 再把「字面」空白（#x20 / #xA / #x9）规范化为空格
   *   3. 之后才做实体解码 —— 此时 `&#xa;` 还是普通 ASCII 文本，不受第 2 步影响，
   *      解码后得到真正的换行/制表符，因此「字符引用表达的字符」语义被完整保留。
   * 若反过来（先解码再规范化），`&#xa;` 会被错误地压成空格。
   */
  function normalizeAttrWhitespace(raw) {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\r') {
        if (raw[i + 1] === '\n') i++;
        out += ' ';
      } else if (ch === '\n' || ch === '\t' || ch === ' ') {
        out += ' ';
      } else {
        out += ch;
      }
    }
    return out;
  }

  function decodeEntities(raw, source, baseIndex, what) {
    if (raw.indexOf('&') === -1) return raw;
    let out = '';
    let i = 0;
    while (i < raw.length) {
      const ch = raw[i];
      if (ch !== '&') { out += ch; i++; continue; }
      const m = raw.slice(i).match(ENTITY_RE);
      if (!m) {
        fail('bad-entity', `${what}中存在未转义的 & 或非法实体引用（应写作 &amp; 等），${describeAt(source, baseIndex + i)}`, baseIndex + i);
      }
      const entity = m[0];
      out += decodeEntityToken(entity);
      i += entity.length;
    }
    return out;
  }

  function decodeEntityToken(token) {
    switch (token) {
      case '&amp;': return '&';
      case '&lt;': return '<';
      case '&gt;': return '>';
      case '&quot;': return '"';
      case '&apos;': return '\'';
      default: {
        const hex = token.startsWith('&#x') || token.startsWith('&#X');
        const body = token.slice(hex ? 3 : 2, -1);
        if ((hex && !/^[0-9A-Fa-f]+$/.test(body)) || (!hex && !/^[0-9]+$/.test(body))) {
          fail('bad-char-ref', `非法的字符引用 ${token}`, -1);
        }
        const num = parseInt(body, hex ? 16 : 10);
        if (!Number.isFinite(num) || !isValidXmlChar(num)) {
          fail('bad-char-ref', `非法的字符引用 ${token}（XML 不允许码位 ${hex ? '0x' + body : body}）`, -1);
        }
        return String.fromCodePoint(num);
      }
    }
  }

  function escapeBase(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * 文本节点转义。仅在必要时使用数值字符引用：
   * 字面 \r 会被 XML 解析器规范化为 \n，因此必须写成 &#xd; 才能保持解析值相等。
   */
  function escapeText(value) {
    return escapeBase(value).replace(/\r/g, '&#xd;');
  }

  /**
   * 属性值转义。属性值里的字面换行 / 制表符 / 回车会被解析器规范化成空格，
   * 因此统一写成数值字符引用（&#xa; / &#x9; / &#xd;），保证「解析后的值」完全相等
   * —— 这样布局变换后多行标签、制表符标签不会变形。
   */
  function escapeAttr(value) {
    return escapeBase(value)
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      .replace(/\r/g, '&#xd;').replace(/\n/g, '&#xa;').replace(/\t/g, '&#x9;');
  }

  /**
   * 解析 XML 文本。
   * @param {string} source
   * @returns {{root: object, source: string, declaration: string|null}}
   */
  function parse(source) {
    if (typeof source !== 'string') {
      fail('bad-input', 'XML 输入必须是字符串', -1);
    }
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);

    let i = 0;
    const len = source.length;
    let declaration = null;

    function readComment(start) {
      const bodyStart = start + 4;
      const end = source.indexOf('-->', bodyStart);
      if (end === -1) fail('unclosed-comment', `注释未闭合，${describeAt(source, start)}`, start);
      const body = source.slice(bodyStart, end);
      // 注释内容不能出现连续两个减号；也不能以单个减号结尾（`<!-- bad --->` 就属于这种）
      if (body.indexOf('--') !== -1 || body.endsWith('-')) {
        fail('bad-comment', `注释内容不能出现连续的两个减号，也不能以单个减号结尾（形如 <!-- 说明 -->），${describeAt(source, start)}`, start);
      }
      checkXmlChars(body, source, bodyStart, '注释');
      return end + 3;
    }

    function readProcessingInstruction(start) {
      const end = source.indexOf('?>', start + 2);
      if (end === -1) fail('unclosed-pi', `处理指令未闭合，${describeAt(source, start)}`, start);
      const raw = source.slice(start, end + 2);
      const inner = source.slice(start + 2, end);
      const target = (inner.match(/^[^\s?]+/) || [''])[0];
      if (!NAME_RE.test(target)) {
        fail('bad-pi', `处理指令目标名非法（应为合法名称），${describeAt(source, start)}`, start);
      }
      if (target.toLowerCase() === 'xml') {
        // 目标名与保留名 xml 大小写无关相等 → 只允许严格的 XML 声明形式（小写 xml、位于文档最开头）
        if (target !== 'xml') {
          fail('reserved-pi-target', `处理指令目标名 "${target}" 与保留名 xml 冲突（大小写不敏感），${describeAt(source, start)}`, start);
        }
        if (start !== 0) {
          fail('reserved-pi-target', `XML 声明只能出现在文档最开头，且之前不能有空白或其他内容，${describeAt(source, start)}`, start);
        }
        checkXmlChars(raw, source, start, 'XML 声明');
        if (!DECL_RE.test(raw)) {
          fail('bad-declaration', `XML 声明语法不正确（应形如 <?xml version="1.0" encoding="UTF-8" standalone="yes"?>），${describeAt(source, start)}`, start);
        }
        declaration = raw;
      } else {
        checkXmlChars(inner, source, start + 2, '处理指令');
        if (inner.indexOf('<?') !== -1) {
          fail('bad-pi', `处理指令内容中不能包含 <?，${describeAt(source, start)}`, start);
        }
      }
      return end + 2;
    }

    function skipMisc() {
      for (;;) {
        while (i < len && isSpace(source[i])) i++;
        if (source.startsWith('<!--', i)) { i = readComment(i); continue; }
        if (source.startsWith('<?', i)) { i = readProcessingInstruction(i); continue; }
        if (source.startsWith('<!DOCTYPE', i) || source.startsWith('<!doctype', i)) {
          fail('doctype', `不接受 DOCTYPE 声明（图表 XML 中不应出现），${describeAt(source, i)}`, i);
        }
        if (source.startsWith('<!', i)) {
          fail('unexpected-markup', `不支持的标记声明，${describeAt(source, i)}`, i);
        }
        break;
      }
    }

    function parseElement(depth) {
      if (depth > MAX_DEPTH) {
        fail('too-deep', `XML 嵌套层数超过 ${MAX_DEPTH}，疑似构造的攻击输入`, i);
      }
      const start = i;
      if (source[i] !== '<') fail('expected-tag', `期望标签起始符 <，${describeAt(source, i)}`, i);
      i++;
      const nameStart = i;
      if (i >= len || !isNameStart(source[i])) {
        fail('bad-name', `非法的标签名，${describeAt(source, i)}`, i);
      }
      while (i < len && isNameChar(source[i])) i++;
      const name = source.slice(nameStart, i);
      if (!NAME_RE.test(name)) fail('bad-name', `非法的标签名 <${name}>`, nameStart);

      const attributes = Object.create(null);
      const attributeOrder = [];
      let selfClosing = false;
      let previousToken = 'name'; // name | attribute —— 属性之间必须有空白

      for (;;) {
        let spaces = 0;
        while (i < len && isSpace(source[i])) { i++; spaces++; }
        if (i >= len) fail('unclosed-tag', `标签 <${name}> 未闭合`, start);
        const ch = source[i];
        if (ch === '/') {
          if (source[i + 1] !== '>') fail('unclosed-tag', `标签 <${name}> 的 / 后必须是 >，${describeAt(source, i)}`, i);
          selfClosing = true;
          i += 2;
          break;
        }
        if (ch === '>') { i++; break; }
        // 属性
        if (!isNameStart(ch)) {
          fail('bad-attribute', `属性必须以合法名称开始，属性值必须用引号包裹，${describeAt(source, i)}`, i);
        }
        if (previousToken === 'attribute' && spaces === 0) {
          fail('missing-attr-space', `属性之间必须有空白分隔（形如 id="1" value="x"），${describeAt(source, i)}`, i);
        }
        const attrStart = i;
        while (i < len && isNameChar(source[i])) i++;
        const attrName = source.slice(attrStart, i);
        while (i < len && isSpace(source[i])) i++;
        if (source[i] !== '=') {
          fail('unquoted-attribute', `属性 ${attrName} 缺少 = 与带引号的取值（形如 ${attrName}="值"），${describeAt(source, i)}`, i);
        }
        i++;
        while (i < len && isSpace(source[i])) i++;
        const quote = source[i];
        if (quote !== '"' && quote !== '\'') {
          fail('unquoted-attribute', `属性 ${attrName} 的取值必须用引号包裹，${describeAt(source, i)}`, i);
        }
        const valueStart = ++i;
        while (i < len && source[i] !== quote) {
          if (source[i] === '<') {
            fail('lt-in-attribute', `属性 ${attrName} 的取值中出现未转义的 <，${describeAt(source, i)}`, i);
          }
          i++;
        }
        if (i >= len) fail('unclosed-attribute', `属性 ${attrName} 的引号未闭合`, valueStart);
        const rawValue = source.slice(valueStart, i);
        i++;
        checkXmlChars(rawValue, source, valueStart, `属性 ${attrName}`);
        if (attrName in attributes) {
          fail('duplicate-attribute', `标签 <${name}> 上属性 ${attrName} 重复出现`, attrStart);
        }
        // 先做属性值规范化（字面空白 → 空格），再做实体解码（字符引用保留原字符）
        attributes[attrName] = decodeEntities(normalizeAttrWhitespace(rawValue), source, valueStart, `属性 ${attrName}`);
        attributeOrder.push(attrName);
        previousToken = 'attribute';
      }

      const node = {
        name,
        attributes,
        attributeOrder,
        children: [],
        textParts: [],
        parent: null,
        selfClosing,
        start,
        openEnd: i,
        innerStart: i,
        innerEnd: i,
        end: i,
      };
      if (selfClosing) return node;

      node.innerStart = i;
      for (;;) {
        if (i >= len) fail('unclosed-tag', `标签 <${name}> 没有对应的结束标签`, start);
        if (source.startsWith('</', i)) {
          const endStart = i;
          i += 2;
          const endNameStart = i;
          while (i < len && isNameChar(source[i])) i++;
          const endName = source.slice(endNameStart, i);
          while (i < len && isSpace(source[i])) i++;
          if (source[i] !== '>') fail('bad-end-tag', `结束标签 </${endName}> 格式不正确，${describeAt(source, i)}`, i);
          i++;
          if (endName !== name) {
            fail('mismatched-tag', `标签 <${name}> 与结束标签 </${endName}> 不匹配`, endStart);
          }
          node.innerEnd = endStart;
          node.end = i;
          return node;
        }
        if (source.startsWith('<![CDATA[', i)) {
          const cdataStart = i + 9;
          const end = source.indexOf(']]>', cdataStart);
          if (end === -1) fail('unclosed-cdata', `CDATA 未闭合，${describeAt(source, i)}`, i);
          const content = source.slice(cdataStart, end);
          checkXmlChars(content, source, cdataStart, 'CDATA 段');
          node.textParts.push({ value: normalizeLineEndings(content), start: i, end: end + 3 });
          i = end + 3;
          continue;
        }
        if (source.startsWith('<!--', i)) {
          i = readComment(i);
          continue;
        }
        if (source.startsWith('<?', i)) {
          i = readProcessingInstruction(i);
          continue;
        }
        if (source.startsWith('<!', i)) {
          fail('unexpected-markup', `不支持的标记声明，${describeAt(source, i)}`, i);
        }
        if (source[i] === '<') {
          const child = parseElement(depth + 1);
          child.parent = node;
          node.children.push(child);
          continue;
        }
        // 文本
        const textStart = i;
        while (i < len && source[i] !== '<') i++;
        const raw = source.slice(textStart, i);
        checkXmlChars(raw, source, textStart, '文本内容');
        if (raw.indexOf(']]>') !== -1) {
          fail('cdata-end-in-text', `文本内容中不能出现 ]]>（XML 规范），${describeAt(source, textStart)}`, textStart);
        }
        node.textParts.push({
          value: decodeEntities(normalizeLineEndings(raw), source, textStart, '文本内容'),
          start: textStart,
          end: i,
        });
      }
    }

    skipMisc();
    if (i >= len) fail('empty', 'XML 内容为空', 0);
    const root = parseElement(1);
    skipMisc();
    if (i < len) {
      fail('multiple-roots', `根节点之后还有其他内容（XML 只能有一个根节点），${describeAt(source, i)}`, i);
    }
    return { root, source, declaration };
  }

  /** 取出子树在原始文本中的精确切片（不重新序列化，避免任何转义变化） */
  function sliceNode(source, node) {
    return source.slice(node.start, node.end);
  }

  function childElements(node, name) {
    if (!node) return [];
    return node.children.filter((c) => (name ? c.name === name : true));
  }

  function firstChild(node, name) {
    return childElements(node, name)[0] || null;
  }

  function textOf(node) {
    if (!node) return '';
    return node.textParts.map((p) => p.value).join('');
  }

  return {
    XmlError,
    parse,
    sliceNode,
    childElements,
    firstChild,
    textOf,
    escapeText,
    escapeAttr,
    decodeEntities,
    decodeEntityToken,
    isValidXmlChar,
    normalizeAttrWhitespace,
    normalizeLineEndings,
    MAX_DEPTH,
  };
});
