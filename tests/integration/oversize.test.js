// 大图上下文：超过模型上下文上限时必须「明确拒绝」，不能静默截断
//
// 该文件在 require 服务端之前设置环境变量，因此单独成一个测试文件。
// 这里给一个假的 Key + 不可达的 Base URL：
//   - 上限检查发生在调用模型之前，因此大图用例不会产生任何网络请求
//   - 小图用例会命中「连不上模型服务」，用于确认服务在拒绝之后仍然可用
process.env.MAX_MODEL_CHARS = '5000';
process.env.MAX_FILE_CHARS = '200000';
process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:1';
// 提供商存储隔离：本进程的 DeepSeek 种子不得写入（也不得读取）真实 data/providers.json
process.env.PROVIDERS_CONFIG_PATH = require('os').tmpdir() + '/diagramai-test-oversize-providers.json';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer, MAX_MODEL_CHARS } = require('../../server.js');
const { bigModel, sampleModel } = require('../helpers/fixtures.js');

let server;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function request(pathname, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 忽略 */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('模型上下文超限返回 413 model-too-large，并说明不会截断', async () => {
  const model = bigModel(120);
  assert.ok(model.length > MAX_MODEL_CHARS, `需要 > ${MAX_MODEL_CHARS}，实际 ${model.length}`);

  const res = await request('/api/chat', 'POST', { message: '把布局改成横向', currentFile: model });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'model-too-large');
  assert.ok(res.json.error.message.includes('不会截断'));
  assert.equal(res.json.detail.size, model.length);
  assert.equal(res.json.detail.limit, MAX_MODEL_CHARS);
});

test('拒绝之后服务仍然可用：小图请求进入模型调用（连不上 → 502，且分类明确）', async () => {
  const config = await request('/api/config', 'GET');
  assert.equal(config.status, 200);
  assert.equal(config.json.aiEnabled, true);

  const res = await request('/api/chat', 'POST', {
    message: '把当前图表整体改成从左到右布局',
    currentFile: sampleModel(),
  });
  assert.equal(res.status, 502);
  assert.equal(res.json.error.code, 'model-unreachable');
});
