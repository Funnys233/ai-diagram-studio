'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const History = require('../../public/chat-history');
const user = (id, content = id) => ({ id, role: 'user', content });
const thread = (id, messages, updatedAt = 1, extra = {}) => ({ id, title: id, messages, updatedAt, ...extra });
const ids = rows => rows.flatMap(row => row.messages.map(item => item.id));

test('旧标签页保存保留缺失的新回复、新会话及双方各自新增消息', () => {
  const complete = { id: 'answer', taskId: 'task', role: 'assistant', content: '已确认取回的完整正文', taskAccepted: true, pending: false, failed: false, updatedAt: 2 };
  const stored = [thread('same', [user('first'), complete], 2), thread('only-a', [user('a')], 3)];
  const incoming = [thread('same', [user('first'), user('new-b')], 4), thread('only-b', [user('b')], 5)];
  const before = JSON.stringify({ stored, incoming });
  const result = History.merge(incoming, stored);
  assert.deepEqual(new Set(result.map(row => row.id)), new Set(['same', 'only-a', 'only-b']));
  assert.deepEqual(result.find(row => row.id === 'same').messages.map(item => item.id), ['first', 'answer', 'new-b']);
  assert.equal(result.find(row => row.id === 'same').messages[1].content, complete.content);
  assert.equal(JSON.stringify({ stored, incoming }), before);
});

test('同一任务终态始终优先于时间更新的pending旧片段，费用不得降级', () => {
  const old = { id: 'answer', taskId: 'task', role: 'assistant', content: '完整正文', taskStatus: 'succeeded', pending: false, failed: false, updatedAt: 2, turnUsage: { status: 'settled', weeklyPoints: 42 } };
  const stale = { ...old, content: '完整', pending: true, updatedAt: 100, taskStatus: 'running', turnUsage: { status: 'unknown', weeklyPoints: 0 }, notice: '旧错误' };
  for (const [a, b] of [[old, stale], [stale, old]]) {
    const item = History.merge([thread('t', [a])], [thread('t', [b])])[0].messages[0];
    assert.equal(item.content, '完整正文'); assert.equal(item.pending, false); assert.equal(item.turnUsage.status, 'settled'); assert.equal(item.notice, undefined);
  }
});

test('pending任务保留更长的累计正文，成功结果不被本地失败覆盖', () => {
  const item = { id: 'answer', role: 'assistant', pending: true, content: '收到的正文', updatedAt: 2 };
  const stale = { ...item, content: '收到', updatedAt: 99 };
  assert.equal(History.merge([thread('t', [stale])], [thread('t', [item])])[0].messages[0].content, item.content);
  const success = { ...item, pending: false, taskStatus: 'succeeded', failed: false };
  const failed = { ...item, pending: false, taskStatus: 'failed', failed: true, updatedAt: 100, notice: '读取失败' };
  const saved = History.merge([thread('t', [failed])], [thread('t', [success])])[0].messages[0];
  assert.equal(saved.failed, false); assert.equal(saved.notice, undefined);
});

test('独立元信息时间保护已移除的参考文档，不被后续流式时间戳复活', () => {
  const removed = thread('t', [user('q')], 10, { metadataUpdatedAt: 10, documents: [], title: '新标题' });
  const streaming = thread('t', [user('q'), user('next')], 99, { metadataUpdatedAt: 1, documents: [{ id: 'removed' }], title: '旧标题' });
  const result = History.merge([streaming], [removed])[0];
  assert.deepEqual(result.documents, []); assert.equal(result.title, '新标题'); assert.equal(result.updatedAt, 99);
  const legacy = { ...streaming }; delete legacy.metadataUpdatedAt;
  assert.deepEqual(History.merge([legacy], [removed])[0].documents, []);
});

test('永久删除标记合并取最新值，旧标签页无法重新保存已删除会话', () => {
  const deleted = History.mergeDeleted({ gone: 10 }, { gone: 20, older: 5 });
  assert.equal(deleted.gone, 20);
  assert.deepEqual(History.merge([thread('gone', [user('stale')], 100)], [thread('kept', [user('good')])], deleted).map(row => row.id), ['kept']);
  assert.equal(History.merge([thread('gone', [user('stale')])], [], { gone: 0 }).length, 0);
});

test('兼容无ID历史并保留重复问题的出现次数，不把相同旧记录重复拼接', () => {
  const legacy = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '您好' }, { role: 'user', content: '你好' }];
  const result = History.merge([thread('t', [...legacy, user('new')])], [thread('t', legacy)])[0];
  assert.equal(result.messages.length, 4); assert.equal(result.messages.filter(item => item.content === '你好').length, 2);
});

test('正常保留最近40个会话，旧pending会话不会被裁掉', () => {
  const recent = Array.from({ length: 45 }, (_, index) => thread(String(index), [user('q-' + index)], index));
  const active = thread('active', [{ role: 'user', content: '原问题' }, { role: 'assistant', pending: true, taskId: 'running', content: '' }], 0);
  const result = History.merge(recent, [active]);
  assert.equal(result.length, 40); assert.ok(result.some(row => row.id === 'active')); assert.ok(result.some(row => row.id === '44')); assert.ok(!result.some(row => row.id === '0'));
  const manyActive = Array.from({ length: 41 }, (_, index) => thread(String(index), [{ role: 'assistant', pending: true, taskId: 'running-' + index }], index));
  assert.equal(History.merge(manyActive, []).length, 41);
});

test('单会话最多80条时仍保留更早的pending任务及其原问题', () => {
  const messages = [user('original'), { id: 'active', role: 'assistant', pending: true, taskId: 'running', content: '片段' }, ...Array.from({ length: 100 }, (_, index) => user('later-' + index))];
  const result = History.merge([thread('t', messages)], [])[0].messages;
  assert.equal(result.length, 80); assert.ok(result.some(item => item.id === 'original')); assert.ok(result.some(item => item.id === 'active')); assert.equal(result.at(-1).id, 'later-99');
});

test('损坏顶层数据不会清空另一方有效历史，忽略无效记录', () => {
  assert.deepEqual(History.merge({}, [thread('valid', [user('q')]), { id: 'bad' }, null]).map(row => row.id), ['valid']);
  assert.equal(History.merge([thread('empty', [])], null).length, 0);
});
