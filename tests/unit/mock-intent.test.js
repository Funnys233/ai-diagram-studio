// 示例引擎意图判定（ACCEPTANCE_REPORT.md 的 B）
const test = require('node:test');
const assert = require('node:assert/strict');
const { mockGenerate, wantsNewDiagram } = require('../../lib/mock-engine.js');
const Model = require('../../lib/graphmodel.js');

const HEAD = '<mxGraphModel dx="900" dy="650"><root><mxCell id="0"/><mxCell id="1" parent="0"/>';
const KEEP = `${HEAD}<mxCell id="keep-me" value="手工加的节点" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>`;

test('新建意图判定：只有「创建动词 + 图表名词」才算新建', () => {
  const newOnes = [
    '画一个用户登录注册的流程图，包含验证码校验和失败重试分支',
    '生成一个关于机器学习的思维导图',
    '画一个电商系统的微服务架构图',
    '画个登录流程',
    '帮我画一张订单流程图',
    '第一段草稿：画一个付款流程',
  ];
  const editOnes = [
    '在当前画布增加一个审批节点',
    '在当前图中绘制一条连线',
    '把当前图表整体改成从左到右布局',
    '删掉所有节点',
    '你好',
    '在画布中加入一个节点',
    '这段流程太长了，拆成两行',
  ];
  for (const text of newOnes) assert.equal(wantsNewDiagram(text), true, `应判定为新建：${text}`);
  for (const text of editOnes) assert.equal(wantsNewDiagram(text), false, `应判定为修改：${text}`);
});

test('「在当前画布增加一个审批节点」保留已有图（返回 xml:null）', () => {
  const result = mockGenerate('在当前画布增加一个审批节点', { modelXml: KEEP, pageIndex: 0, pageCount: 1 });
  assert.equal(result.kind, 'unsupported');
  assert.equal(result.xml, null);
  assert.equal(result.preserved, true);
  assert.ok(result.reply.includes('已保留'));
});

test('「在当前图中绘制一条连线」同样保留已有图', () => {
  const result = mockGenerate('在当前图中绘制一条连线，连接开始和结束', { modelXml: KEEP, pageIndex: 0, pageCount: 1 });
  assert.equal(result.xml, null);
  assert.equal(result.preserved, true);
});

test('「画布」不会被误当成「画」触发新建', () => {
  const result = mockGenerate('把当前画布里的节点整体改成横向布局', { modelXml: KEEP });
  assert.equal(result.kind, 'edited');
  assert.ok(result.xml.includes('keep-me'));
  assert.equal(Model.validateGraphModel(result.xml).ok, true);
});

test('明确的新建指令仍然生成合法图表', () => {
  const cases = [
    ['画一个用户登录注册的流程图', 'flow'],
    ['画一个电商系统的微服务架构图，分前端层、网关层、服务层和数据层', 'arch'],
    ['生成一个关于机器学习的思维导图，包含监督学习、无监督学习、强化学习', 'mind'],
  ];
  for (const [message, label] of cases) {
    const result = mockGenerate(message, { modelXml: KEEP });
    assert.equal(result.kind, 'new', `${label} 应为新建：${message}`);
    const check = Model.validateGraphModel(result.xml);
    assert.equal(check.ok, true, `${label} 生成结果必须合法：${check.error && check.error.message}`);
    assert.ok(check.stats.vertices >= 3);
  }
});

test('空画布上的修改指令：提示先生成，不返回图', () => {
  const result = mockGenerate('改为横向布局', { modelXml: null });
  assert.equal(result.kind, 'empty-canvas');
  assert.equal(result.xml, null);
});
