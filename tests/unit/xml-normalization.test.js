// R4：属性值 XML 规范化 —— 布局前后「解析值」必须与标准解析器一致
//
// 规则（XML 1.0 §3.3.3，顺序不能颠倒）：
//   1. 先做行结束规范化（CRLF / CR → LF）
//   2. 再把「字面」空白（#x20 / #xA / #x9）规范化为空格
//   3. 最后才解码字符引用 —— `&#xa;` / `&#x9;` / `&#xd;` 表达的字符必须原样保留
//
// 判定来源：优先用 Python 标准库 xml.etree（Expat）作为独立裁判，对「布局前 / 布局后」
// 的标签与 UserObject 扩展属性值做逐字节比较；没有 Python 时退回本地断言（仍会比较
// 布局前后的解析值，而不是让项目解析器自己跟自己比）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Xml = require('../../lib/xml.js');
const Model = require('../../lib/graphmodel.js');

const HEAD = '<mxGraphModel dx="900" dy="650">';

/** 用「原始属性文本」构造单节点图，这样能精确控制字面空白与字符引用 */
function modelWithValue(attrText, extraAttr) {
  const extra = extraAttr ? ' ' + extraAttr : '';
  return `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/>`
    + `<mxCell id="2" value=${attrText} style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>`
    + `${extra}</root></mxGraphModel>`;
}

/** 用 UserObject 包装（扩展属性）构造单节点图 */
function modelWithUserObject(valueAttrText, customAttrText) {
  return `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/>`
    + `<UserObject label=${valueAttrText} myTag=${customAttrText} id="2">`
    + '<mxCell style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1">'
    + '<mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></UserObject>'
    + '</root></mxGraphModel>';
}

// 覆盖：单引号 / 双引号 × 字面 LF / CR / CRLF / TAB × 对应字符引用 × 混合输入
const CASES = {
  '双引号-字面LF': modelWithValue('"第一行\n第二行"'),
  '双引号-字面CR': modelWithValue('"第一行\r第二行"'),
  '双引号-字面CRLF': modelWithValue('"第一行\r\n第二行"'),
  '双引号-字面TAB': modelWithValue('"第一行\t第二行"'),
  '双引号-引用LF': modelWithValue('"第一行&#xa;第二行"'),
  '双引号-引用TAB': modelWithValue('"第一行&#x9;第二行"'),
  '双引号-引用CR': modelWithValue('"第一行&#xd;第二行"'),
  '单引号-字面LF': modelWithValue("'第一行\n第二行'"),
  '单引号-引用LF': modelWithValue("'第一行&#xa;第二行'"),
  '混合-字面与引用': modelWithValue('"a\nb&#xa;c\td&#x9;e"'),
  '扩展属性-混合': modelWithUserObject('"标签\n行"', '"tag&#xa;值"'),
};

function pythonSampler() {
  const candidates = [
    process.env.PYTHON,
    '/usr/bin/python3',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (candidate.includes('/') && !fs.existsSync(candidate)) continue;
      execFileSync(candidate, ['-c', 'import xml.etree.ElementTree'], { stdio: 'ignore' });
      return candidate;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/** 用独立解析器读取「标签值」与「UserObject 扩展属性值」 */
function pythonValues(python, xml) {
  const script = [
    'import sys, json',
    'import xml.etree.ElementTree as ET',
    'root = ET.fromstring(sys.stdin.read())',
    'cell = root.find("root/mxCell[@id=\'2\']")',
    'obj = root.find("root/UserObject[@id=\'2\']")',
    'out = {"label": None, "tag": None}',
    'if cell is not None:',
    '    out["label"] = cell.get("value")',
    'if obj is not None:',
    '    out["label"] = obj.get("label")',
    '    out["tag"] = obj.get("myTag")',
    'print(json.dumps(out))',
  ].join('\n');
  const out = execFileSync(python, ['-c', script], { input: xml, encoding: 'utf8' });
  return JSON.parse(out);
}

/** 本地读取：用项目解析器读原始值（用于在没有 Python 时仍有断言） */
function projectValues(xml) {
  const parsed = Xml.parse(xml);
  const rootEls = Xml.childElements(parsed.root, 'root');
  const entries = Model.collectCells(rootEls[0]);
  const entry = entries.find((e) => (e.cell && e.cell.attributes.id === '2')
    || (e.wrapper && e.wrapper.attributes.id === '2'));
  if (!entry) return { label: null, tag: null };
  return {
    // UserObject 包装时，标签与扩展属性在外层（与独立解析器读 obj 的行为一致）
    label: entry.wrapper ? entry.wrapper.attributes.label : entry.cell.attributes.value,
    tag: entry.wrapper ? entry.wrapper.attributes.myTag : null,
  };
}

test('R4：字面空白按 XML 规范规范化，字符引用表达的字符被保留', () => {
  // 字面空白 → 单个空格；CRLF 只算一个空白
  assert.equal(Xml.parse('<a v="第一行\n第二行"/>').root.attributes.v, '第一行 第二行');
  assert.equal(Xml.parse('<a v="第一行\r\n第二行"/>').root.attributes.v, '第一行 第二行');
  assert.equal(Xml.parse('<a v="第一行\r第二行"/>').root.attributes.v, '第一行 第二行');
  assert.equal(Xml.parse('<a v="第一行\t第二行"/>').root.attributes.v, '第一行 第二行');
  assert.equal(Xml.parse("<a v='a\nb'/>").root.attributes.v, 'a b');
  // 字符引用不被规范化
  assert.equal(Xml.parse('<a v="&#xa;&#x9;&#xd;"/>').root.attributes.v, '\n\t\r');
  // 混合：字面部分变空格，引用部分保留
  assert.equal(Xml.parse('<a v="a\nb&#xa;c\td&#x9;e"/>').root.attributes.v, 'a b\nc d\te');
  // 文本节点只做行结束规范化，不做空白折叠
  assert.equal(Xml.textOf(Xml.parse('<a>第一行\n第二行</a>').root), '第一行\n第二行');
  assert.equal(Xml.textOf(Xml.parse('<a>第一行\r\n第二行</a>').root), '第一行\n第二行');
  assert.equal(Xml.textOf(Xml.parse('<a><![CDATA[a\r\nb]]></a>').root), 'a\nb');
});

test('R4：布局变换前后，独立解析器读到的标签与扩展属性值完全相等', (t) => {
  const python = pythonSampler();
  if (!python) t.diagnostic('本机没有可用的 Python 独立解析器，改用项目解析器断言（仍比较布局前后）');
  const read = python ? (xml) => pythonValues(python, xml) : projectValues;
  const label = python ? '独立解析器(Python ElementTree)' : '项目解析器';

  for (const [name, xml] of Object.entries(CASES)) {
    const before = read(xml);
    for (const direction of ['horizontal', 'vertical']) {
      const out = Model.applyLayout(xml, direction).xml;
      const after = read(out);
      assert.deepEqual(
        after, before,
        `${name} / ${direction} 布局后「${label}」读到的值必须与布局前完全相等：${JSON.stringify(before)} → ${JSON.stringify(after)}`,
      );
      assert.ok(Model.validateGraphModel(out).ok, `${name} / ${direction} 布局结果应通过结构校验`);
    }
  }
});

test('R4：布局前的解析值就是标准解析器给出的值（规范化发生在解析阶段，而不是序列化阶段）', (t) => {
  const python = pythonSampler();
  if (!python) { t.skip('本机没有可用的 Python 独立解析器'); return; }
  for (const [name, xml] of Object.entries(CASES)) {
    const native = pythonValues(python, xml);
    const mine = projectValues(xml);
    assert.deepEqual(mine, native, `${name} 的解析值应与标准解析器一致`);
  }
});
