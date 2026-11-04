// 严格 XML 语法（ACCEPTANCE_REPORT.md 的 D 项）+ 与独立解析器交叉验证
//
// 自制解析器不能自己给自己当裁判：这里用 Python 标准库 xml.etree（Expat）作为独立裁判，
// 对一组输入逐一比对「合法 / 非法」判定是否一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const Xml = require('../../lib/xml.js');

const HEAD = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>';
const MODEL = (inner) => `${HEAD}${inner}</root></mxGraphModel>`;
const VERTEX = '<mxCell id="2" value="开始" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell>';

function parseVerdict(source) {
  try {
    Xml.parse(source);
    return true;
  } catch (e) {
    return false;
  }
}

test('拒绝邻接属性（属性之间缺少空白）', () => {
  const xml = MODEL('<mxCell id="2"value="开始" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell>');
  assert.throws(() => Xml.parse(xml), (e) => e.name === 'XmlError' && e.code === 'missing-attr-space');
});

test('拒绝非法字符引用 &#0;（以及代理区、超范围码位）', () => {
  for (const ref of ['&#0;', '&#x0;', '&#x1F;', '&#xD800;', '&#x110000;']) {
    assert.throws(() => Xml.parse(`<a v="${ref}"/>`), (e) => e.code === 'bad-char-ref', `${ref} 应当被拒绝`);
  }
  // 合法引用仍然接受
  const ok = Xml.parse('<a v="&#xa;&#x9;&#x20;&#x4e2d;"/>');
  assert.equal(ok.root.attributes.v, '\n\t 中');
});

test('拒绝非法注释（内容中出现 -- 或未闭合）', () => {
  assert.throws(() => Xml.parse('<!-- bad -- comment --><a/>'), (e) => e.code === 'bad-comment');
  assert.throws(() => Xml.parse(MODEL('<!-- a -- b -->')), (e) => e.code === 'bad-comment');
  assert.throws(() => Xml.parse('<!-- 未闭合 <a/>'), (e) => e.code === 'unclosed-comment');
  // 合法注释
  assert.ok(Xml.parse('<!-- ok --><a/>').root.name === 'a');
});

test('拒绝文本中的 ]]>、文档中部的 xml 声明与非法处理指令', () => {
  assert.throws(() => Xml.parse('<a>x ]]> y</a>'), (e) => e.code === 'cdata-end-in-text');
  assert.throws(() => Xml.parse('<a/><?xml version="1.0"?>'), (e) => e.code === 'reserved-pi-target');
  assert.throws(() => Xml.parse('<a><?1bad x?></a>'), (e) => e.code === 'bad-pi');
  assert.ok(Xml.parse('<?xml version="1.0"?><a/>').declaration.startsWith('<?xml'));
});

test('三类非法输入在「当前图表」结构校验层被拒绝（HTTP 层见 tests/integration/http.test.js）', async () => {
  const Model = require('../../lib/graphmodel.js');
  const cases = [
    MODEL('<mxCell id="2"value="开始" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell>'),
    MODEL('<mxCell id="2" value="&#0;开始" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell>'),
    MODEL('<!-- bad -- comment -->' + VERTEX),
  ];
  for (const xml of cases) {
    const result = Model.validateGraphModel(xml);
    assert.equal(result.ok, false, `${xml.slice(0, 60)} 不应通过结构校验`);
    assert.ok(result.error.code.startsWith('xml-'), `错误码应带 xml- 前缀，实际 ${result.error.code}`);
  }
});

// ---------- R3：补齐标准 XML 边界（独立解析器也会拒绝的输入） ----------

test('R3：拒绝以单个减号结尾的注释（<!-- bad --->）', () => {
  assert.throws(() => Xml.parse('<!-- bad ---><a/>'), (e) => e.code === 'bad-comment');
  assert.throws(() => Xml.parse(MODEL('<!-- bad --->' + VERTEX)), (e) => e.code === 'bad-comment');
  // 单个减号但后面还有内容 → 合法
  assert.ok(Xml.parse('<!-- ok - ok --><a/>').root.name === 'a');
  assert.ok(Xml.parse('<!-- ok - --><a/>').root.name === 'a');
});

test('R3：拒绝非法 XML 声明与保留目标名的大小写变体', () => {
  assert.throws(() => Xml.parse('<?xml rubbish?><a/>'), (e) => e.code === 'bad-declaration');
  assert.throws(() => Xml.parse('<?xml?><a/>'), (e) => e.code === 'bad-declaration');
  assert.throws(() => Xml.parse('<?xml version=1.0?><a/>'), (e) => e.code === 'bad-declaration');
  assert.throws(() => Xml.parse('<?xml version="1.0" foo="bar"?><a/>'), (e) => e.code === 'bad-declaration');
  assert.throws(() => Xml.parse('<?XML version="1.0"?><a/>'), (e) => e.code === 'reserved-pi-target');
  assert.throws(() => Xml.parse('<?XmL?><a/>'), (e) => e.code === 'reserved-pi-target');
  assert.throws(() => Xml.parse('<? xml version="1.0"?><a/>'), (e) => e.code === 'bad-pi');
  // 合法声明形式
  for (const decl of [
    '<?xml version="1.0"?>',
    "<?xml version='1.0'?>",
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?xml version="1.0" encoding="utf-8" standalone="yes"?>',
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<?xml version="1.0" encoding="UTF-8" ?>',
  ]) {
    const parsed = Xml.parse(decl + '<a/>');
    assert.equal(parsed.declaration, decl, `${decl} 应被识别为 XML 声明`);
  }
});

test('R3：CDATA / 属性 / 文本中的非法码位被拒绝（含字面代理字符与 U+FFFE）', () => {
  assert.throws(() => Xml.parse(MODEL('<![CDATA[\u0001]]>')), (e) => e.code === 'control-char');
  assert.throws(() => Xml.parse('<a v="\uFFFE"/>'), (e) => e.code === 'bad-char');
  assert.throws(() => Xml.parse('<a v="\uFFFF"/>'), (e) => e.code === 'bad-char');
  assert.throws(() => Xml.parse('<a>\uFFFE</a>'), (e) => e.code === 'bad-char');
  assert.throws(() => Xml.parse('<!-- \uFFFE --><a/>'), (e) => e.code === 'bad-char');
  // 字面孤立代理字符
  assert.throws(() => Xml.parse('<a v="\uD800"/>'), (e) => e.code === 'bad-char');
  assert.throws(() => Xml.parse('<a v="\uDFFF"/>'), (e) => e.code === 'bad-char');
  assert.throws(() => Xml.parse('<a>\uD83D</a>'), (e) => e.code === 'bad-char');
  // 引用形式同样被拒
  for (const ref of ['&#xFFFE;', '&#xFFFF;', '&#xD800;']) {
    assert.throws(() => Xml.parse(`<a v="${ref}"/>`), (e) => e.code === 'bad-char-ref', `${ref} 应被拒绝`);
  }
});

test('R3：合法中文、emoji（增补平面 / 代理对）、PI、CDATA 与声明仍可解析', () => {
  assert.equal(Xml.parse('<a v="中文😀🎉"/>').root.attributes.v, '中文😀🎉');
  assert.equal(Xml.textOf(Xml.parse('<a>中文😀</a>').root), '中文😀');
  assert.equal(Xml.parse('<a v="&#x1F600;"/>').root.attributes.v, '😀');
  assert.equal(Xml.textOf(Xml.parse('<a><![CDATA[中文 & 😀]]></a>').root), '中文 & 😀');
  assert.equal(Xml.parse('<a><?custom-process target?></a>').root.name, 'a');
  assert.ok(Xml.parse('<?xml version="1.0"?><a/>').declaration);
});


// ---------- 与独立解析器（Python xml.etree / Expat）交叉验证 ----------
function resolvePython() {
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

function pythonVerdicts(samples) {
  const python = resolvePython();
  if (!python) return null;
  const script = [
    'import sys, json',
    'import xml.etree.ElementTree as ET',
    'samples = json.load(sys.stdin)',
    'out = []',
    'for s in samples:',
    '    try:',
    '        ET.fromstring(s)',
    '        out.append(True)',
    '    except Exception:',
    '        out.append(False)',
    'print(json.dumps(out))',
  ].join('\n');
  const out = execFileSync(python, ['-c', script], { input: JSON.stringify(samples), encoding: 'utf8' });
  return JSON.parse(out);
}

test('与独立 XML 解析器交叉验证「合法 / 非法」判定', (t) => {
  const samples = [
    // 合法
    '<?xml version="1.0"?><a v="1"><b/></a>',
    "<?xml version='1.0'?><a/>",
    '<?xml version="1.0" encoding="UTF-8"?><a/>',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a/>',
    '<?xml version="1.0" encoding="UTF-8" ?><a/>',
    '<a><![CDATA[x & y]]></a>',
    '<a v="a &amp; b &lt; c"/>',
    '<a v="&#xa;多行&#x9;制表"/>',
    '<a><!-- ok --><b>text</b></a>',
    '<a><!-- ok - ok --><b/></a>',
    '<a v=\'single quotes\'/>',
    '<a><b/><c/></a>',
    '<a><?custom pi?></a>',
    '<a v="中文😀🎉"/>',
    '<a v="&#x1F600;"/>',
    // 非法
    '<a v="&#0;"/>',
    '<a v="&#xD800;"/>',
    '<a v="&#xFFFE;"/>',
    '<!-- bad -- comment --><a/>',
    '<!-- bad ---><a/>',
    '<?xml rubbish?><a/>',
    '<?XML version="1.0"?><a/>',
    '<a><![CDATA[\u0001]]></a>',
    '<a v="\uFFFE"/>',
    '<a v="\uD800"/>',
    '<a id="1"value="x"/>',
    '<a v=A/>',
    '<a v="x" v="y"/>',
    '<a><b></a></b>',
    '<a/><b/>',
    '<a>x ]]> y</a>',
    '<a v="bare & ampersand"/>',
    '<a v="&nbsp;"/>',
    '<a/><?xml version="1.0"?>',
  ];
  const python = pythonVerdicts(samples);
  if (!python) {
    t.skip('本机没有可用的 Python 独立解析器，跳过交叉验证');
    return;
  }
  const diverge = [];
  samples.forEach((sample, index) => {
    const mine = parseVerdict(sample);
    if (mine !== python[index]) diverge.push({ sample: sample.slice(0, 60), mine, python: python[index] });
  });
  assert.deepEqual(diverge, [], `与 Python ElementTree 判定不一致：${JSON.stringify(diverge)}`);
});

test('自制的额外限制（比通用解析器更严）单独记录', () => {
  // DOCTYPE 在通用解析器里合法，但图表场景不需要，我们主动拒绝（防御 XXE / 实体膨胀）
  const python = pythonVerdicts(['<!DOCTYPE a><a/>']);
  if (python) assert.equal(python[0], true, '通用解析器应接受 DOCTYPE');
  assert.throws(() => Xml.parse('<!DOCTYPE a><a/>'), (e) => e.code === 'doctype');
});
