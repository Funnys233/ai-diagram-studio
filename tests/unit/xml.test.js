// 严格 XML 解析器：语法层必须拒绝非法输入（旧实现只做标签栈匹配，会放行这些）
const test = require('node:test');
const assert = require('node:assert/strict');
const Xml = require('../../lib/xml.js');

test('解析合法 XML 并保留源码偏移', () => {
  const source = '<a x="1" y="2"><b t="hi">text</b><c/></a>';
  const { root } = Xml.parse(source);
  assert.equal(root.name, 'a');
  assert.equal(root.attributes.x, '1');
  assert.equal(root.children.length, 2);
  assert.equal(Xml.textOf(root.children[0]), 'text');
  assert.equal(Xml.sliceNode(source, root.children[0]), '<b t="hi">text</b>');
  assert.equal(Xml.sliceNode(source, root.children[1]), '<c/>');
});

test('拒绝未转义的 & 与未知实体', () => {
  const bad = '<mxGraphModel><root><mxCell id="2" value="A & B"/></root></mxGraphModel>';
  assert.throws(() => Xml.parse(bad), (e) => e.name === 'XmlError' && e.code === 'bad-entity');
  const badEntity = '<a v="x&nbsp;y"/>';
  assert.throws(() => Xml.parse(badEntity), (e) => e.code === 'bad-entity');
});

test('拒绝无引号属性值', () => {
  const bad = '<mxGraphModel><root><mxCell id=broken/></root></mxGraphModel>';
  assert.throws(() => Xml.parse(bad), (e) => e.name === 'XmlError' && e.code === 'unquoted-attribute');
});

test('拒绝重复属性', () => {
  const bad = '<a id="1" id="2"/>';
  assert.throws(() => Xml.parse(bad), (e) => e.code === 'duplicate-attribute');
});

test('拒绝标签不匹配与未闭合', () => {
  assert.throws(() => Xml.parse('<a><b></a></b>'), (e) => e.code === 'mismatched-tag' || e.code === 'unclosed-tag');
  assert.throws(() => Xml.parse('<a><b></b>'), (e) => e.code === 'unclosed-tag');
});

test('拒绝多根节点、DOCTYPE 与控制字符', () => {
  assert.throws(() => Xml.parse('<a/><b/>'), (e) => e.code === 'multiple-roots');
  assert.throws(() => Xml.parse('<!DOCTYPE foo><a/>'), (e) => e.code === 'doctype');
  assert.throws(() => Xml.parse('<a v="\u0007"/>'), (e) => e.code === 'control-char');
});

test('允许注释、处理指令、CDATA 与字符引用', () => {
  const source = '<?xml version="1.0"?>\n<!-- c -->\n<a v="&#38;#65"><![CDATA[x & y]]></a>';
  const { root, declaration } = Xml.parse(source);
  assert.ok(declaration && declaration.startsWith('<?xml'));
  assert.equal(root.attributes.v, '&#65'); // &#38; 解码成 &，后面的 #65 保持字面
  assert.equal(Xml.textOf(root), 'x & y');
});

test('转义工具函数往返正确', () => {
  const raw = 'a & b < c > d "e" \'f\'';
  const escaped = Xml.escapeAttr(raw);
  const { root } = Xml.parse(`<a v="${escaped}"/>`);
  assert.equal(root.attributes.v, raw);
});
