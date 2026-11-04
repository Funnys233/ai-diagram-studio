// draw.io 文件格式：mxGraphModel 与完整 mxfile 的区分、压缩 / 未压缩、多页保留、下载不重复包裹
const test = require('node:test');
const assert = require('node:assert/strict');
const File = require('../../lib/drawio-format.js');
const { decompressDiagram, compressDiagram } = require('../../lib/drawio-zlib.js');
const { buildMxfile, sampleModel, modelWithManualNode, bigModel } = require('../helpers/fixtures.js');

test('compress/decompress 与 draw.io 官方算法一致（base64 + raw deflate + URL 编码）', () => {
  const xml = sampleModel();
  const compressed = compressDiagram(xml);
  assert.ok(!compressed.startsWith('<'));
  assert.equal(decompressDiagram(compressed), xml);
});

test('区分 mxGraphModel 与 mxfile', () => {
  assert.equal(File.parseFile(sampleModel()).kind, 'model');
  assert.equal(File.parseFile(buildMxfile([{ name: 'Page-1', id: 'p1', content: sampleModel() }])).kind, 'mxfile');
  assert.equal(File.parseFile('not xml at all').kind, 'invalid');
  assert.equal(File.parseFile('').kind, 'empty');
});

test('未压缩的 diagram 内容可直接读取，且保持原样切片', () => {
  const model = sampleModel();
  const mxfile = buildMxfile([{ name: 'Page-1', id: 'p1', content: model }]);
  const info = File.parseFile(mxfile);
  assert.equal(info.pages[0].encoding, 'xml');
  const resolved = File.resolvePageModel(mxfile, info.pages[0], decompressDiagram);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.xml, model);
});

test('压缩的 diagram 内容需要解压，解压后与原文一致', () => {
  const model = sampleModel();
  const mxfile = buildMxfile([{ name: 'Page-1', id: 'p1', content: model, compressed: true }]);
  const info = File.parseFile(mxfile);
  assert.equal(info.pages[0].encoding, 'encoded');
  const withoutDecode = File.resolvePageModel(mxfile, info.pages[0], null);
  assert.equal(withoutDecode.ok, false);
  assert.equal(withoutDecode.error.code, 'needs-decompress');
  const resolved = File.resolvePageModel(mxfile, info.pages[0], decompressDiagram);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.xml, model);
});

test('替换当前页内容时其它页面字节级保留', () => {
  const page1 = sampleModel();
  const page2 = modelWithManualNode();
  const mxfile = buildMxfile([
    { name: 'Page-1', id: 'p1', content: page1 },
    { name: 'Page-2', id: 'p2', content: page2 },
  ]);
  const info = File.parseFile(mxfile);
  const replacement = sampleModel().replace('开始', '新的开始');
  const next = File.splicePageContent(mxfile, info.pages[0], replacement);
  const nextInfo = File.parseFile(next);
  assert.equal(nextInfo.kind, 'mxfile');
  assert.equal(nextInfo.pageCount, 2);
  assert.ok(File.resolvePageModel(next, nextInfo.pages[0], decompressDiagram).xml.includes('新的开始'));
  // 第二页（含手工节点）必须原封不动
  assert.equal(File.resolvePageModel(next, nextInfo.pages[1], decompressDiagram).xml, page2);
  assert.ok(next.includes('name="Page-2"'));
});

test('替换压缩页后仍可解析（退回明文内容）', () => {
  const mxfile = buildMxfile([{ name: 'Page-1', id: 'p1', content: sampleModel(), compressed: true }]);
  const info = File.parseFile(mxfile);
  const next = File.splicePageContent(mxfile, info.pages[0], sampleModel().replace('开始', '明文开始'));
  const nextInfo = File.parseFile(next);
  assert.equal(nextInfo.pages[0].encoding, 'xml');
  assert.ok(File.resolvePageModel(next, nextInfo.pages[0], decompressDiagram).xml.includes('明文开始'));
});

test('下载裸 mxGraphModel：只包裹一次，不出现嵌套 diagframe', () => {
  const model = sampleModel();
  const built = File.buildDownloadContent({ payload: model, modelXml: model, name: 'Page-1' });
  assert.equal(built.ok, true);
  assert.equal(built.wrapped, true);
  assert.ok(built.content.startsWith('<mxfile'));
  assert.equal((built.content.match(/<mxfile/g) || []).length, 1);
  assert.equal((built.content.match(/<diagram/g) || []).length, 1);
  assert.ok(!built.content.includes('<diagram><mxfile'));
  const info = File.parseFile(built.content);
  assert.equal(info.kind, 'mxfile');
  assert.equal(File.resolvePageModel(built.content, info.pages[0], decompressDiagram).xml, model);
});

test('下载完整 mxfile：直接保存原文件结构，只替换当前页', () => {
  const mxfile = buildMxfile([
    { name: 'Page-1', id: 'p1', content: sampleModel() },
    { name: 'Page-2', id: 'p2', content: modelWithManualNode() },
  ]);
  const info = File.parseFile(mxfile);
  const edited = modelWithManualNode().replace('手工加的节点', '手工节点+AI补充');
  const built = File.buildDownloadContent({ payload: mxfile, modelXml: edited, pageIndex: 0 });
  assert.equal(built.ok, true);
  assert.equal(built.wrapped, false);
  assert.equal((built.content.match(/<mxfile/g) || []).length, 1);
  assert.equal((built.content.match(/<diagram/g) || []).length, 2);
  assert.ok(!built.content.includes('<diagram><mxfile'));
  const out = File.parseFile(built.content);
  assert.equal(out.pageCount, 2);
  assert.ok(File.resolvePageModel(built.content, out.pages[0], decompressDiagram).xml.includes('手工节点+AI补充'));
  assert.equal(File.resolvePageModel(built.content, out.pages[1], decompressDiagram).xml, modelWithManualNode());
  assert.ok(built.content.includes('name="Page-2"'));
});

test('下载大图不会丢失任何节点（不截断）', () => {
  const model = bigModel(120);
  const built = File.buildDownloadContent({ payload: model, modelXml: model });
  const info = File.parseFile(built.content);
  const round = File.resolvePageModel(built.content, info.pages[0], decompressDiagram).xml;
  assert.equal(round, model);
  assert.equal((round.match(/vertex="1"/g) || []).length, 120);
});
