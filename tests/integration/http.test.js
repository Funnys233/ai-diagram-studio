// 服务端集成测试：异常请求不能让服务退出，非法 XML 不能进入画布，大图必须明确拒绝
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const Model = require('../../lib/graphmodel');
// 提供商存储隔离：测试不得读写真实 data/providers.json（否则断言依赖用户本机配置）。
// 用独立临时目录（避免固定路径的跨运行残留），并清空真实 DEEPSEEK 种子——
// 否则本机导出的密钥会让无 providerId 的 chat 真的去调外部 API 而不是示例引擎
process.env.PROVIDERS_CONFIG_PATH = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'diagramai-http-it-')), 'providers.json');
process.env.DEEPSEEK_API_KEY = '';
const { createServer, MAX_FILE_CHARS, MAX_BODY_BYTES } = require('../../server.js');
const { sampleModel, modelWithManualNode, buildMxfile, bigModel, buildModel, cellVertex, cellEdge } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..');

let server;
let base;

test.before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** 原始请求，path 不做任何规范化（用于畸形 URL 用例） */
function rawRequest(rawPath, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      method: opts.method || 'GET',
      path: rawPath,
      headers: opts.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function postJson(pathname, body) {
  return rawRequest(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function expectAlive() {
  const res = await rawRequest('/api/config');
  assert.equal(res.status, 200, '服务应当仍然存活并能响应正常请求');
  return res.json;
}

test('GET /api/config 返回配置与边界', async () => {
  const res = await rawRequest('/api/config');
  assert.equal(res.status, 200);
  assert.equal(typeof res.json.embedUrl, 'string');
  assert.equal(res.json.embedOrigin, 'https://embed.diagrams.net');
  assert.equal(typeof res.json.limits.maxModelChars, 'number');
  assert.equal(res.json.aiEnabled, false); // 测试环境未配置 Key
});

test('畸形 URL 返回 400，服务不退出（旧实现会以 URIError 退出进程）', async () => {
  for (const bad of ['/%E0%A4%A', '/%E0%A4%', '/%zz', '/%C3%28']) {
    const res = await rawRequest(bad);
    assert.equal(res.status, 400, `${bad} 应当返回 400`);
    assert.equal(res.json.error.code, 'malformed-url');
  }
  await expectAlive();
});

test('非法 JSON 返回 400（旧实现返回 502）', async () => {
  const res = await postJson('/api/chat', '{"message": ');
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid-json');
  await expectAlive();
});

test('JSON 顶层不是对象也返回 400', async () => {
  const res = await postJson('/api/chat', '[1,2,3]');
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid-json');
});

test('请求体超限返回 413', async () => {
  const body = JSON.stringify({ message: 'x'.repeat(MAX_BODY_BYTES + 2000) });
  const res = await postJson('/api/chat', body);
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'body-too-large');
  await expectAlive();
});

test('message / history / currentFile / currentPage / clientRevision 类型校验', async () => {
  const cases = [
    [{ message: 123 }, 'invalid-message'],
    [{ message: '' }, 'invalid-message'],
    [{ message: 'x'.repeat(5000) }, 'invalid-message'],
    [{ message: 'ok', history: 'nope' }, 'invalid-history'],
    [{ message: 'ok', history: [{ role: 'system', content: 'x' }] }, 'invalid-history'],
    [{ message: 'ok', history: [{ role: 'user', content: 42 }] }, 'invalid-history'],
    [{ message: 'ok', currentFile: 123 }, 'invalid-current-file'],
    [{ message: 'ok', currentFile: sampleModel(), currentPage: 'first' }, 'invalid-page'],
    [{ message: 'ok', clientRevision: -3 }, 'invalid-revision'],
  ];
  for (const [body, code] of cases) {
    const res = await postJson('/api/chat', body);
    assert.equal(res.status, 400, `${JSON.stringify(body).slice(0, 60)} 应当返回 400`);
    assert.equal(res.json.error.code, code);
  }
  await expectAlive();
});

test('非法当前图表（语法错误 / 重复 id / 无效引用）被拒绝且提示可读', async () => {
  const badSyntax = '<mxGraphModel><root><mxCell id="2" value="A & B"/></root></mxGraphModel>';
  const badSyntaxNoQuote = '<mxGraphModel><root><mxCell id=2 /></root></mxGraphModel>';
  const duplicate = sampleModel().replace('id="3"', 'id="2"');
  const invalidRef = sampleModel().replace('source="2" target="3"', 'source="2" target="404"');

  for (const [label, xml] of [['语法', badSyntax], ['无引号', badSyntaxNoQuote], ['重复 id', duplicate], ['无效连线', invalidRef]]) {
    const res = await postJson('/api/chat', { message: '改一下', currentFile: xml });
    assert.equal(res.status, 400, `${label} 应当返回 400，实际 ${res.status}`);
    assert.equal(res.json.error.code, 'invalid-current-file');
    assert.ok(res.json.error.message.length > 5, '错误信息应当可读');
  }
  await expectAlive();
});

test('currentFile 超过字符上限返回 413（不截断，明确拒绝）', async () => {
  const huge = bigModel(1000);
  assert.ok(huge.length > MAX_FILE_CHARS, `需要 > ${MAX_FILE_CHARS}，实际 ${huge.length}`);
  assert.ok(huge.length < MAX_BODY_BYTES, `需要 < 请求体上限 ${MAX_BODY_BYTES}，实际 ${huge.length}`);
  const res = await postJson('/api/chat', { message: '改一下', currentFile: huge });
  assert.equal(res.status, 413);
  assert.equal(res.json.error.code, 'file-too-large');
  await expectAlive();
});

test('示例引擎：生成新图返回合法 XML', async () => {
  const res = await postJson('/api/chat', { message: '画一个用户登录注册流程图', currentFile: null });
  assert.equal(res.status, 200);
  assert.equal(res.json.source, 'mock');
  assert.ok(res.json.xml.includes('<mxGraphModel'));
  assert.equal(res.json.applied, true);
});

test('示例引擎：「改为横向布局」基于当前图表，手工节点保留', async () => {
  const current = modelWithManualNode();
  const res = await postJson('/api/chat', {
    message: '把当前图表整体改成从左到右布局',
    currentFile: current,
    currentPage: 0,
    clientRevision: 3,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.clientRevision, 3); // 回显版本号，供前端判定过期响应
  assert.ok(res.json.xml.includes('keep-me'), '手工节点必须保留');
  assert.ok(res.json.xml.includes('id="2"'));
  assert.ok(res.json.xml.includes('id="5"'));
});

test('示例引擎：不支持的修改返回提示且不带新图（原图保留）', async () => {
  const res = await postJson('/api/chat', { message: '删掉所有节点', currentFile: sampleModel() });
  assert.equal(res.status, 200);
  assert.equal(res.json.xml, null);
  assert.equal(res.json.preserved, true);
  assert.equal(res.json.applied, false);
});

test('压缩存储的 diagram：服务端解压后作为当前图表上下文', async () => {
  const mxfile = buildMxfile([
    { name: 'Page-1', id: 'p1', content: sampleModel() },
    { name: 'Page-2', id: 'p2', content: modelWithManualNode(), compressed: true },
  ]);
  const res = await postJson('/api/chat', {
    message: '改为横向布局',
    currentFile: mxfile,
    currentPage: 1,
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.pageIndex, 1);
  assert.equal(res.json.pageCount, 2);
  assert.ok(res.json.xml.includes('keep-me'), '压缩页解压后应包含手工节点');
});

test('多页文件的 currentPage 越界返回 400', async () => {
  const mxfile = buildMxfile([
    { name: 'Page-1', id: 'p1', content: sampleModel() },
    { name: 'Page-2', id: 'p2', content: sampleModel() },
  ]);
  const res = await postJson('/api/chat', { message: '改一下', currentFile: mxfile, currentPage: 5 });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid-page');
});

test('按稳定页面 id 定位目标页：id 优先于（可能陈旧的）页索引', async () => {
  const pageA = buildModel([
    cellVertex('a0', 'A-开始', { x: 340, y: 60 }),
    cellVertex('a1', 'A-结束', { x: 340, y: 170 }),
    cellEdge('ae1', 'a0', 'a1'),
  ]);
  const pageB = buildModel([
    cellVertex('b0', 'B-开始', { x: 340, y: 60 }),
    cellVertex('b1', 'B-结束', { x: 340, y: 170 }),
    cellEdge('be1', 'b0', 'b1'),
  ]);
  const mxfile = buildMxfile([
    { name: '第一页', id: 'page-a', content: pageA },
    { name: '第二页', id: 'page-b', content: pageB },
  ]);

  // 前端可能传来陈旧的 currentPage 索引，但 currentPageId 指向第一页 → 必须改第一页
  const resA = await postJson('/api/chat', {
    message: '把当前图表整体改成从左到右布局',
    currentFile: mxfile,
    currentPage: 1,
    currentPageId: 'page-a',
  });
  assert.equal(resA.status, 200);
  assert.equal(resA.json.pageId, 'page-a');
  assert.equal(resA.json.pageIndex, 0);
  assert.ok(resA.json.xml.includes('id="a0"'), '应修改第一页');
  assert.ok(!resA.json.xml.includes('id="b0"'), '不应混入第二页内容');
  const horizontal = [...resA.json.xml.matchAll(/<mxGeometry x="(\d+)" y="(\d+)"/g)].map((m) => Number(m[2]));
  assert.equal(new Set(horizontal).size, 1, '第一页应变成横向布局（y 一致）');

  const resB = await postJson('/api/chat', {
    message: '把当前图表整体改成从左到右布局',
    currentFile: mxfile,
    currentPageId: 'page-b',
  });
  assert.equal(resB.status, 200);
  assert.equal(resB.json.pageId, 'page-b');
  assert.equal(resB.json.pageIndex, 1);
  assert.ok(resB.json.xml.includes('id="b0"'), '应修改第二页');
});

test('页面 id 不存在时返回 409 且不写错页面', async () => {
  const mxfile = buildMxfile([
    { name: '第一页', id: 'page-a', content: sampleModel() },
    { name: '第二页', id: 'page-b', content: sampleModel() },
  ]);
  const res = await postJson('/api/chat', {
    message: '改为横向布局',
    currentFile: mxfile,
    currentPage: 0,
    currentPageId: 'page-deleted',
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'page-not-found');
  assert.ok(res.json.error.message.includes('page-deleted'));
  await expectAlive();
});

test('currentPageId 类型错误返回 400', async () => {
  const res = await postJson('/api/chat', { message: '改一下', currentPageId: 42 });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'invalid-page');
});

test('静态资源：正常文件可访问', async () => {
  const index = await rawRequest('/');
  assert.equal(index.status, 200);
  assert.ok(index.text.includes('Diagram Studio'));
  const app = await rawRequest('/app.js');
  assert.equal(app.status, 200);
  const shared = await rawRequest('/shared/xml.js');
  assert.equal(shared.status, 200);
  assert.ok(shared.text.includes('XmlError'));
});

test('静态资源：越界与同前缀兄弟目录不可读（旧实现前缀判断会放行）', async () => {
  const siblingDir = path.join(ROOT, 'public-backup');
  const siblingFile = path.join(siblingDir, 'private.txt');
  const createdDir = !fs.existsSync(siblingDir);
  if (createdDir) fs.mkdirSync(siblingDir);
  fs.writeFileSync(siblingFile, 'secret-should-not-leak');

  try {
    const attempts = [
      '/../server.js',
      '/..%2Fserver.js',
      '/../public-backup/private.txt',
      '/%2e%2e/public-backup/private.txt',
      '/%252e%252e/server.js',
      '/../../etc/passwd',
      '/./../package.json',
    ];
    for (const attempt of attempts) {
      const res = await rawRequest(attempt);
      assert.notEqual(res.status, 200, `${attempt} 不应返回 200`);
      assert.ok(!res.text.includes('secret-should-not-leak'), `${attempt} 泄漏了兄弟目录文件`);
      assert.ok(!res.text.includes('DEEPSEEK_API_KEY') || !res.text.includes('require('), `${attempt} 泄漏了源码`);
    }
  } finally {
    fs.rmSync(siblingFile, { force: true });
    if (createdDir) fs.rmSync(siblingDir, { recursive: true, force: true });
  }
  await expectAlive();
});

test('静态资源：符号链接逃逸被阻止', async () => {
  const linkPath = path.join(ROOT, 'public', '__escape__.js');
  fs.rmSync(linkPath, { force: true });
  fs.symlinkSync(path.join('..', 'server.js'), linkPath);
  try {
    const res = await rawRequest('/__escape__.js');
    assert.equal(res.status, 403, `符号链接应被拒绝，实际 ${res.status}`);
  } finally {
    fs.rmSync(linkPath, { force: true });
  }
  await expectAlive();
});

test('不支持的 HTTP 方法返回 405', async () => {
  const res = await postJson('/api/config', '{}');
  assert.equal(res.status, 405);
  assert.equal(res.json.error.code, 'method-not-allowed');
});

test('一连串恶意请求之后服务仍然正常（综合存活检查）', async () => {
  const sequence = [
    ['/%E0%A4%A', 'GET'],
    ['/../../etc/hosts', 'GET'],
    ['/api/chat', 'POST'],
    ['/%00', 'GET'],
    ['/' + 'a'.repeat(3000), 'GET'],
  ];
  for (const [p, method] of sequence) {
    const res = await rawRequest(p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{"message":' : undefined,
    });
    assert.ok(res.status >= 400 && res.status < 600, `${p} 应有明确错误状态，实际 ${res.status}`);
  }
  const config = await expectAlive();
  assert.ok(config.embedUrl);
  const chat = await postJson('/api/chat', { message: '画一个流程图' });
  assert.equal(chat.status, 200);
});

test('R3：标准 XML 边界在真实 HTTP 请求层被拒（每个请求后服务仍正常）', async () => {
  const cases = [
    ['注释以单个减号结尾', sampleModel().replace('<root>', '<root><!-- bad --->')],
    ['非法 XML 声明', '<?xml rubbish?>' + sampleModel()],
    ['保留目标名的大小写变体', '<?XML version="1.0"?>' + sampleModel()],
    ['CDATA 内控制字符 U+0001', sampleModel().replace('<root>', '<root><![CDATA[\u0001]]>')],
    ['属性内字面 U+FFFE', sampleModel().replace('value="开始"', 'value="\uFFFE"')],
    ['属性内字面孤立代理字符', sampleModel().replace('value="开始"', 'value="\uD800"')],
  ];
  for (const [label, xml] of cases) {
    const res = await postJson('/api/chat', { message: '改一下', currentFile: xml });
    assert.equal(res.status, 400, `${label} 应当返回 400，实际 ${res.status}`);
    assert.equal(res.json.error.code, 'invalid-current-file');
    assert.ok(res.json.error.message.length > 5, `${label} 的错误信息应当可读`);
    // 每个非法请求之后，服务都必须仍能响应健康请求
    await expectAlive();
  }
});

test('R3：合法的中文 / emoji（代理对）与合法 XML 声明不会被误拒', async () => {
  const withEmoji = sampleModel().replace('value="开始"', 'value="开始😀 中文"');
  const res = await postJson('/api/chat', { message: '改为横向布局', currentFile: withEmoji });
  assert.equal(res.status, 200, '合法中文与 emoji 必须被接受');
  assert.ok(res.json.xml.includes('开始😀 中文'), 'emoji 标签必须被完整保留');

  const withDecl = '<?xml version="1.0" encoding="UTF-8"?>' + sampleModel();
  const res2 = await postJson('/api/chat', { message: '改为横向布局', currentFile: withDecl });
  assert.equal(res2.status, 200, '合法 XML 声明必须被接受');
  assert.ok(res2.json.xml.includes('<mxGraphModel'));
});

test('第三阶段通过本地规则整理，不需要有效模型并回显目标页', async () => {
  const res = await postJson('/api/chat', { stage:'layout', message:'整理布局', currentFile:sampleModel(),
    providerId:'不存在的模型供应商', modelId:'invalid', currentPage:0, clientRevision:12 });
  assert.equal(res.status,200);
  assert.equal(res.json.source,'layout');
  assert.equal(res.json.clientRevision,12);
  assert.equal(res.json.pageIndex,0);
  assert.equal(Model.validateGraphModel(res.json.xml).ok,true);
});


test('P0：图表校验接口解压并验证所有页，不调用模型', async () => {
  const file = buildMxfile([
    { id: 'one', name: 'one', content: sampleModel(), compressed: true },
    { id: 'two', name: 'two', content: '' },
  ]);
  const result = await postJson('/api/diagrams/validate', { payload: file });
  assert.equal(result.status, 200);
  assert.equal(result.json.pageCount, 2);
  assert.equal((result.json.payload.match(/<mxGraphModel/g) || []).length, 2);
  assert.equal((await postJson('/api/diagrams/validate', { payload: '<mxGraphModel/>' })).status, 400);
  assert.equal((await rawRequest('/api/diagrams/validate')).status, 405);
});

test('P0：图表导入 API 拒绝跨站来源及非可信 Host', async () => {
  const body = JSON.stringify({ payload: sampleModel() });
  const denied = await rawRequest('/api/diagrams/validate', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' } });
  assert.equal(denied.status, 403);
  const badHost = await rawRequest('/api/diagrams/validate', { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', Host: 'evil.example' } });
  assert.equal(badHost.status, 403);
  await expectAlive();
});
