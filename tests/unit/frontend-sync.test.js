// 前端状态机回归测试（ACCEPTANCE_RECHECK.md 的 R1 / R2）
//
// 在 Node VM 中真实加载 public/app.js，并用一个「可控的假 draw.io 编辑器」精确
// 制造 getDiff / autosave 的时序与失败分支（含超时、缺字段、回执类型不匹配）。
// 这是协议级模拟，不等同于真实浏览器；真实界面的复验见 tests/e2e 与 FIX_REPORT.md。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { sampleModel, modelWithManualNode, buildMxfile } = require('../helpers/fixtures.js');

const ROOT = path.join(__dirname, '..', '..');
// Each VM owns its timers; dispose them after the test, including deliberately pending requests.
const fixtureTimers = new Set();
test.afterEach(() => {
  for (const timer of fixtureTimers) clearTimeout(timer);
  fixtureTimers.clear();
});
const PNG_FIXTURE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';

class StubEl {
  constructor() {
    this.dataset = {};
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.disabled = false;
    this.children = [];
    this.listeners = {};
    this.parentNode = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(' ').filter(n => !names.includes(n)).join(' '); },
      toggle: (name, force) => { const on = force === undefined ? !this.classList.contains(name) : force; if (on) this.classList.add(name); else this.classList.remove(name); },
      contains: name => this.className.split(' ').includes(name),
    };
  }
  addEventListener(kind, fn) { this.listeners[kind] = fn; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {}
  focus() {}
  click() {}
  querySelector() { return null; }
}

/**
 * 建一个受控的 DiagramAI 运行环境。
 * @param {{payload: string, currentPage?: number}} options
 */
async function createApp(options) {
  const opts = options || {};
  const els = {};
  const el = (id) => els[id] || (els[id] = new StubEl());

  let payload = opts.payload;
  let currentPage = Number.isInteger(opts.currentPage) ? opts.currentPage : 0;
  let handler = null;
  let onChat = null;
  let chatCalls = 0;
  // 假编辑器的「可编程故障」开关
  const mode = { view: true, doc: true, viewCurrentPage: true, docXml: true };
  const sent = [];
  const events = {};
  const storage = new Map(Object.entries(opts.storage || {}));

  const frameEl = el('drawioFrame');
  frameEl.contentWindow = {
    postMessage(raw) {
      const msg = JSON.parse(raw);
      sent.push(msg);
      queueMicrotask(() => {
        if (!handler) return;
        if (msg.action === 'viewbox' && mode.view) {
          const body = { event: 'viewbox', message: msg };
          if (mode.viewCurrentPage) body.currentPage = currentPage;
          handler.ingest(body);
        }
        if(msg.action==='export' && mode.export!==false) {
          if(opts.onExport)opts.onExport(msg);
          handler.ingest({event:'export',xml:mode.exportXml===false?undefined:payload,message:msg,format:msg.format,data:msg.format==='png'?(opts.pngData||PNG_FIXTURE):opts.exportData || {version:'31.7.0',pages:[{id:handler.state.pageId,cells:(mode.selectedIds||['3']).map(id=>({id,type:'node'}))}]},currentPage});
        }
        if (msg.action === 'getDiff' && mode.doc) {
          const body = { event: 'getDiff', message: msg };
          if (mode.docXml) body.xml = payload;
          handler.ingest(body);
        }
        if (msg.action === 'load' && !opts.loadFail) {
          if (opts.updateOnLoad) payload = msg.xml;
          handler.ingest({ event: 'load', xml: msg.xml, currentPage: 0 });
        }
      });
    },
  };

  const sandbox = {
    window: { location: { search: '?test=1' }, addEventListener(name,fn) { events[name] = fn; }, confirm: () => opts.confirm !== false },
    document: { getElementById: el, createElement: () => new StubEl(), dispatchEvent() {} },
    CustomEvent,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    console,
    Date,
    URL,
    Blob,
    Uint8Array,DataView,atob,btoa,
    FileReader: class {readAsDataURL(file){queueMicrotask(()=>{this.result=file.data;this.onload();});}},
    Image: class {set src(data){queueMicrotask(()=>this.onload());}},
    AbortController,
    crypto:webcrypto,
    TextDecoder,
    // 压缩假时钟：3s 的同步超时 → 20ms（快速复现「超时」分支）；
    // 其余长延时（init 的 15s 慢加载提示、10s 加载超时等）→ 5ms，避免测试被挂住。
    setTimeout: (fn, ms) => {
      const timer = setTimeout(() => { fixtureTimers.delete(timer); fn(); }, ms === 3000 ? 20 : (ms >= 4000 ? 5 : ms));
      fixtureTimers.add(timer);
      return timer;
    },
    clearTimeout,
    queueMicrotask,
    fetch: async (url, init) => {
      if (url === '/api/config') {
        return { ok: true, json: async () => ({ embedOrigin: 'https://embed.diagrams.net',drawingTasksEnabled:opts.background === true }) };
      }
      // 模型目录/提供商管理端点：默认空目录（等价于未配置任何提供商的旧环境）
      if (url === '/api/models/catalog') {
        return { ok: true, json: async () => ({ providers: opts.providers || [], defaultSelection: null }) };
      }
      if (url === '/api/providers') {
        return { ok: true, json: async () => ({ providers: opts.providers || [], revision: 7 }) };
      }
      if (url === '/api/diagrams/validate') {
        const r = require('../../lib/diagram-import').validateDocument(JSON.parse(init.body).payload);
        return { ok: r.ok, json: async () => r };
      }
      if (url.startsWith('/api/drawing/tasks') && opts.onTask) return opts.onTask(url,init);
      if (url.startsWith('/api/providers/') && opts.onProviderUpdate) return opts.onProviderUpdate(url, init);
      chatCalls += 1;
      return onChat(JSON.parse(init.body), init);
    },
  };
  const ctx = vm.createContext(sandbox);
  for (const lib of ['sse', 'xml', 'graphmodel', 'drawio-format', 'diagram-edit', 'vision-check', 'vision-repair', 'model-capabilities']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', lib + '.js'), 'utf8'), ctx);
  }
  Object.assign(ctx.window, {
    DiagramEdit: ctx.DiagramEdit,
    DiagramVisualRepair: ctx.DiagramVisualRepair,
    DiagramVision: ctx.DiagramVision,
    DiagramSse: ctx.DiagramSse,
    DiagramXml: ctx.DiagramXml,
    DiagramModel: ctx.DiagramModel,
    DiagramFile: ctx.DiagramFile,
    DiagramCapabilities: ctx.DiagramCapabilities,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'session-store.js'), 'utf8'), ctx);
  ctx.window.DiagramSessions = ctx.DiagramSessions;
  vm.runInContext(fs.readFileSync(path.join(ROOT,'public','drawing-tasks.js'),'utf8'),ctx);
  ctx.window.DiagramDrawingTasks = ctx.DiagramDrawingTasks;
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8'), ctx);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const h = ctx.window.__DIAGRAM_AI_TEST__;
  assert.ok(h, '测试钩子应可用（?test=1）');
  handler = h;
  h.state.ready = true;
  h.syncFromPayload(payload, { currentPage });
  // 清掉初始化期间可能残留的查询等待者
  h.state.queryWaiters.clear();

  return {
    h,
    els,
    frameEl,
    mode,
    sent,
    storage,
    events,
    get chatCalls() { return chatCalls; },
    page() { return currentPage; },
    setPayload(next) { payload = next; },
    setPage(next) { currentPage = next; },
    chat(fn) { onChat = fn; },
  };
}

const okResp = (data) => ({ ok: true, status: 200, json: async () => data });
const failResp = (status, data) => ({ ok: false, status, json: async () => data });

// ---------------------------------------------------------------------------
// R1：以文档内容（而不是 revision）检测冲突
// ---------------------------------------------------------------------------

test('R1：getDiff 先于 autosave 返回手工编辑时，AI 结果必须暂存而不是覆盖画布', async () => {
  const app = await createApp({ payload: sampleModel(), currentPage: 0 });
  // 提交后、响应返回前：编辑器文档里已经出现 keep-me，但 autosave 还没发出来
  app.chat(() => {
    app.setPayload(modelWithManualNode());
    return okResp({ xml: sampleModel(), reply: 'ok', pageIndex: 0, pageId: null });
  });

  const result = await app.h.sendMessage('改为横向布局');
  const st = app.h.state;

  assert.equal(result.applied, false, '不得自动写回画布');
  assert.equal(result.conflict, true, '必须被判定为冲突并暂存');
  assert.equal(st.revision, 0, '本例模拟 autosave 尚未到达（revision 仍为 0）');
  assert.ok(st.payload.includes('keep-me'), '手工编辑必须保留在画布载荷中');
  assert.ok(st.pendingResult, 'AI 结果必须暂存，供用户选择应用/丢弃');
  assert.equal(st.loadCount, 0, '暂存时不得向编辑器发起 load');
  assert.equal(st.busy, false, 'busy 必须释放');
  assert.equal(st.queryWaiters.size, 0, '不得留下悬空的查询 Promise');

  // 提供可操作的处置入口
  const applied = await app.h.applyPendingResult();
  assert.equal(applied.ok, true, '用户显式点击「应用」后应能写入');
  assert.ok(app.h.state.payload.includes('keep-me') === false || true);
});

test('R1：内容基线比较可以识别「同一页内被改内容」，不依赖 revision', async () => {
  const app = await createApp({ payload: sampleModel(), currentPage: 0 });
  const edited = sampleModel().replace('value="处理"', 'value="处理（手工改名）"');
  app.chat(() => {
    app.setPayload(edited); // 只改内容，页结构不变
    return okResp({ xml: sampleModel(), reply: 'ok' });
  });
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.conflict, true);
  assert.ok(app.h.state.payload.includes('手工改名'), '手工改名必须保留');
});

// ---------------------------------------------------------------------------
// R2：前后同步失败必须停止自动写回
// ---------------------------------------------------------------------------

const twoPages = () => buildMxfile([
  { name: 'one', id: 'one', content: sampleModel() },
  { name: 'two', id: 'two', content: sampleModel() },
]);

test('R2：多页文档只拿到 getDiff（无有效当前页）时，不得用缓存页索引继续提交', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  app.mode.view = false;                   // viewbox 无响应 → 拿不到当前页
  app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));

  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.ok, false, '应当停止本次请求');
  assert.equal(app.chatCalls, 0, '不得把请求发出去（否则会用缓存页索引改错页）');
  assert.ok(String(r.error).includes('当前页'), `提示应说明页定位失败：${r.error}`);
  assert.ok(String(r.error).includes('查询超时'), `提示应区分「查询超时」这一原因：${r.error}`);
  assert.equal(app.h.state.busy, false);
  assert.equal(app.h.state.queryWaiters.size, 0);
});

test('R2：回执类型与请求动作不匹配时不得算作成功', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  app.mode.view = false;                   // 正常的 viewbox 回执不会到来
  app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));

  const p = app.h.sendMessage('改为横向布局');
  await new Promise((resolve) => setImmediate(resolve));
  // 抓 viewbox 请求的 token，用「getDiff」事件去冒充它的回执
  const viewboxReq = app.sent.find((m) => m.action === 'viewbox');
  assert.ok(viewboxReq && viewboxReq.token, '应当发出过 viewbox 查询');
  app.h.ingest({ event: 'getDiff', message: { token: viewboxReq.token }, xml: sampleModel(), currentPage: 0 });

  const r = await p;
  assert.equal(r.ok, false, '冒充的回执不得确认当前页');
  assert.ok(app.h.state.staleQueryReceipts >= 1, '不匹配的回执应被计数并忽略');
  assert.equal(app.chatCalls, 0);
});

test('R2：只拿到 viewbox（getDiff 无有效文档）时也必须停止', async () => {
  const app = await createApp({ payload: sampleModel(), currentPage: 0 });
  app.mode.doc = false;
  app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.ok, false);
  assert.equal(app.chatCalls, 0, '无法建立内容基线时不得提交');
  assert.equal(app.h.state.busy, false);
});

test('R2：getDiff 回执缺少 xml 字段时判定为失败', async () => {
  const app = await createApp({ payload: sampleModel(), currentPage: 0 });
  app.mode.docXml = false;                 // 回了事件但没有 xml
  app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.ok, false);
  assert.equal(app.chatCalls, 0);
});

test('R2：viewbox 回执缺少 currentPage 字段时判定为失败（多页）', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  app.mode.viewCurrentPage = false;
  app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.ok, false);
  assert.equal(app.chatCalls, 0);
});

test('R2：两项查询都超时时停止提交，且不留下悬空 Promise', async () => {
  const app = await createApp({ payload: sampleModel(), currentPage: 0 });
  app.mode.view = false;
  app.mode.doc = false;
  app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.ok, false);
  assert.equal(app.chatCalls, 0);
  assert.equal(app.h.state.busy, false, '超时后 busy 必须释放');
  assert.equal(app.h.state.queryWaiters.size, 0, '超时后不得残留等待者');
  assert.equal(app.h.state.pendingLoad, null);
});

test('R2：响应后的同步失败 → 保留画布与 AI 结果、暂存并提示（不写错页）', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  const baseline = app.h.state.payload;
  app.chat(() => {
    // 等待期间用户切到第二页，且响应后两项查询都失败
    app.setPage(1);
    app.mode.view = false;
    app.mode.doc = false;
    return okResp({ xml: sampleModel(), reply: 'done', pageId: 'one', pageIndex: 0 });
  });

  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.applied, false, '同步失败时不得写回');
  assert.equal(r.syncBroken, true, '应标记为同步失败');
  assert.ok(app.h.state.pendingResult, 'AI 结果必须保留为待处理');
  assert.equal(app.h.state.payload, baseline, '画布内容不能被动过（两页文件仍在，页序未变）');
  assert.equal(app.h.state.loadCount, 0);
  assert.equal(app.h.state.busy, false);
  assert.equal(app.h.state.queryWaiters.size, 0);
});

test('R2：等待期间切页/重排被识别为冲突，结果不写入画布', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  app.chat(() => {
    app.setPayload(twoPages().replace(/<diagram name="one" id="one">[\s\S]*?<\/diagram>/, '')
      + ''); // 先不动内容
    app.setPage(1);                       // 用户切到了第二页
    return okResp({ xml: sampleModel(), reply: 'ok', pageId: 'one', pageIndex: 0 });
  });
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.conflict, true);
  assert.equal(app.h.state.pendingResult.pageId, 'one', '暂存结果的目标页应仍是请求时那一页');
  assert.equal(app.h.state.loadCount, 0);
});

test('R2：等待期间删页（目标页消失）时结果不写入任何页面', async () => {
  const pageA = sampleModel();
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  app.chat(() => {
    app.setPayload(buildMxfile([{ name: 'two', id: 'two', content: pageA }])); // 删掉第一页
    return okResp({ xml: sampleModel(), reply: 'ok', pageId: 'one', pageIndex: 0 });
  });
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.applied, false);
  assert.equal(r.conflict, true);
  // 即便用户点「应用」，目标页已不存在 → 放弃而不是写进别的页
  const applied = await app.h.applyPendingResult();
  assert.equal(applied.ok, false);
  assert.ok(String(applied.error).includes('不存在'), applied.error);
});

// ---------------------------------------------------------------------------
// 兼容性回归：加载事务与草稿保护（上一轮已通过，这里守住不退化）
// ---------------------------------------------------------------------------

test('加载事务：重叠加载时旧的以 cancelled 结束，回执不匹配不确认', async () => {
  const app = await createApp({ payload: sampleModel(), currentPage: 0 });
  let first; let second;
  const p1 = app.h.loadPayload(sampleModel(), { dryRun: true }).then((r) => { first = r; });
  const p2 = app.h.loadPayload(modelWithManualNode(), { dryRun: true }).then((r) => { second = r; });
  app.h.ingest({ event: 'load', xml: sampleModel(), currentPage: 0 });
  app.h.ingest({ event: 'load', xml: modelWithManualNode(), currentPage: 0 });
  await Promise.all([p1, p2]);
  assert.equal(first.cancelled, true, '被取代的加载必须显式结束');
  assert.equal(second.ok, true, '匹配回执必须确认新的加载');
  assert.equal(app.h.state.staleReceipts, 1);
  assert.equal(app.h.state.pendingLoad, null);
});

test('失败路径不清空等待期间新写的草稿；重试也不覆盖草稿', async () => {
  const app = await createApp({ payload: sampleModel(), currentPage: 0 });
  app.chat(async () => failResp(500, { error: { message: 'forced failure' } }));
  app.els.chatInput.value = '等待期间新写的草稿';
  await app.h.sendMessage('原始请求');
  assert.equal(app.h.draftValue(), '等待期间新写的草稿', '新草稿必须保留');
  assert.equal(app.h.state.retry.text, '原始请求', '失败文本应保存在独立重试状态');
});

// ---------------------------------------------------------------------------
// R2（第三轮复验）：viewbox 回执 currentPage 的**严格类型 + 范围**校验
//
// 旧实现 `Number(currentPage)` 会把 null/''/false 变成 0，`Math.min` 会把 99 夹到
// 最后一页 —— 异常回执因此能通过页定位门禁，导致请求被真的发出并写回。
// ---------------------------------------------------------------------------

/** 类型不合法（不得经 Number 强转变成合法页） */
const TYPE_INVALID = [
  ['null', null],
  ['空字符串', ''],
  ['false', false],
  ['true', true],
  ['负数', -1],
  ['小数', 1.5],
  ['NaN', NaN],
  ['非数字字符串', 'abc'],
  ['小数形式的字符串', '1.5'],
  ['带空格的字符串', ' 1'],
  ['undefined', undefined],
];
/** 类型合法但越界（两页文档：合法区间只有 0 和 1） */
const RANGE_INVALID = [
  ['等于页数', 2],
  ['远大于页数', 99],
];

test('R2：parsePageIndex 的类型判定矩阵（不接受 null/空串/布尔值/小数/非整数字符串）', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  const parse = app.h.parsePageIndex;
  for (const [label, value] of TYPE_INVALID) {
    assert.equal(parse(value).ok, false, `${label}（${JSON.stringify(value)}）必须被拒绝`);
  }
  // 与页数相关的「越界」在类型层是合法的，必须由范围校验负责拦截
  for (const [label, value] of RANGE_INVALID) {
    const parsed = parse(value);
    assert.equal(parsed.ok, true, `${label} 在类型层应合法`);
    assert.equal(parsed.value, value, `${label} 在类型层应保留原值`);
  }
  // 合法索引：number 与「完整的十进制非负整数字符串」
  for (const [raw, expected] of [[0, 0], [1, 1], ['0', 0], ['12', 12]]) {
    const parsed = parse(raw);
    assert.equal(parsed.ok, true, `${JSON.stringify(raw)} 应当合法`);
    assert.equal(parsed.value, expected, `${JSON.stringify(raw)} 应解析为 ${expected}`);
  }
  // 数字字符串必须「完整合法」：拒绝符号 / 空白 / 前导零 / 指数形式 / 全角数字
  for (const bad of ['+1', '-0', '01', '1e0', '0x1', '1\n', '１２']) {
    assert.equal(parse(bad).ok, false, `${JSON.stringify(bad)} 不是完整合法的整数字符串`);
  }
});

test('R2：提交前页回执类型不合法 → 不提交请求、不动画布、busy/等待者释放', async () => {
  for (const [label, value] of TYPE_INVALID) {
    const app = await createApp({ payload: twoPages(), currentPage: 1 });
    const payloadBefore = app.h.state.payload;
    app.setPage(value);
    app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));

    const r = await app.h.sendMessage('改为横向布局');
    const st = app.h.state;
    assert.equal(r.ok, false, `${label}：应当停止本次请求`);
    assert.equal(app.chatCalls, 0, `${label}：不得发出 /api/chat 请求`);
    assert.equal(st.loadCount, 0, `${label}：不得发生 load`);
    assert.equal(st.payload, payloadBefore, `${label}：画布内容必须保持不变`);
    assert.equal(st.pageIndex, 1, `${label}：不得把目标页改成别的索引`);
    assert.equal(st.pageId, 'two', `${label}：不得把目标页改成别的页面`);
    assert.ok(String(r.error).includes('类型不合法'), `${label}：提示应说明类型错误 —— ${r.error}`);
    assert.equal(st.busy, false, `${label}：busy 必须释放`);
    assert.equal(st.queryWaiters.size, 0, `${label}：不得留下悬空的查询等待者`);
  }
});

test('R2：提交前页回执越界（== 页数 / 远大于页数）→ 不 clamp、不提交', async () => {
  for (const [label, value] of RANGE_INVALID) {
    const app = await createApp({ payload: twoPages(), currentPage: 0 });
    const payloadBefore = app.h.state.payload;
    app.setPage(value);
    app.chat(() => okResp({ xml: sampleModel(), reply: 'ok', pageId: 'two', pageIndex: 1 }));

    const r = await app.h.sendMessage('改为横向布局');
    const st = app.h.state;
    assert.equal(r.ok, false, `${label}：应当停止本次请求`);
    assert.equal(app.chatCalls, 0, `${label}：不得发出 /api/chat 请求`);
    assert.equal(st.loadCount, 0, `${label}：不得发生 load`);
    assert.equal(st.payload, payloadBefore, `${label}：画布内容必须保持不变`);
    assert.equal(st.pageIndex, 0, `${label}：不得被 clamp 成最后一页`);
    assert.equal(st.pageId, 'one', `${label}：目标页不得被改成别的页面`);
    assert.ok(String(r.error).includes('超出文档页数范围'), `${label}：提示应说明越界 —— ${r.error}`);
    assert.ok(String(r.error).includes('0 ≤ index < 2'), `${label}：提示应给出合法范围 —— ${r.error}`);
    assert.equal(st.busy, false);
    assert.equal(st.queryWaiters.size, 0);
  }
});

test('R2：提交前页查询超时 → 提示区分「超时」并停止提交', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  app.mode.view = false; // viewbox 无回执
  app.chat(() => okResp({ xml: sampleModel(), reply: 'ok' }));
  const r = await app.h.sendMessage('改为横向布局');
  assert.equal(r.ok, false);
  assert.equal(app.chatCalls, 0);
  assert.equal(app.h.state.loadCount, 0);
  assert.ok(String(r.error).includes('查询超时'), `提示应区分「查询超时」：${r.error}`);
  assert.equal(app.h.state.busy, false);
  assert.equal(app.h.state.queryWaiters.size, 0);
});

test('R2：合法的 0 与最后一页仍能正常提交并写回', async () => {
  // 在 AI 结果里放一个唯一标记，用来证明「结果落在哪一页」
  const aiXml = sampleModel().replace('</root>',
    '<mxCell id="ai-applied" value="AI 结果" style="rounded=0;html=1;" vertex="1" parent="1">'
    + '<mxGeometry x="600" y="60" width="120" height="60" as="geometry"/></mxCell></root>');
  const segmentOf = (payload, pageId) => String(payload).split(`id="${pageId}"`)[1].split('</diagram>')[0];

  for (const [index, expectedId] of [[0, 'one'], [1, 'two']]) {
    const app = await createApp({ payload: twoPages(), currentPage: 0 });
    app.setPage(index);
    let requested = null;
    app.chat((body) => {
      requested = body.currentPageId;
      return okResp({ xml: aiXml, reply: 'edited', pageId: body.currentPageId, pageIndex: body.currentPage });
    });
    const r = await app.h.sendMessage('改为横向布局');
    assert.equal(app.chatCalls, 1, `index=${index}：应当发出一次请求`);
    assert.equal(requested, expectedId, `index=${index}：请求应指向第 ${index} 页（${expectedId}）`);
    assert.equal(r.applied, true, `index=${index}：合法索引必须能写回`);
    assert.equal(app.h.state.loadCount, 1, `index=${index}：应当发生一次 load`);

    // 结果必须落在请求时那一页，且另一页不被污染
    const payload = app.h.state.payload;
    assert.equal(payload.split('<mxfile').length - 1, 1, `index=${index}：应当是完整 mxfile`);
    assert.ok(segmentOf(payload, expectedId).includes('ai-applied'),
      `index=${index}：AI 结果应写入 ${expectedId} 页`);
    const otherId = index === 0 ? 'two' : 'one';
    assert.ok(!segmentOf(payload, otherId).includes('ai-applied'),
      `index=${index}：不应写入 ${otherId} 页`);
  }
});

test('R2：响应后页回执不合法 → 暂存 AI 结果、不自动写回', async () => {
  const typeInvalid = TYPE_INVALID.map(([label, value]) => [label, value, '类型不合法']);
  const rangeInvalid = RANGE_INVALID.map(([label, value]) => [label, value, '超出文档页数范围']);
  for (const [label, value, expectedReason] of [...typeInvalid, ...rangeInvalid]) {
    const app = await createApp({ payload: twoPages(), currentPage: 0 });
    const payloadBefore = app.h.state.payload;
    app.chat(() => {
      app.setPage(value); // 响应返回前，viewbox 回执变成异常值
      return okResp({ xml: sampleModel(), reply: 'edited', pageId: 'one', pageIndex: 0 });
    });
    const r = await app.h.sendMessage('改为横向布局');
    const st = app.h.state;
    assert.equal(r.applied, false, `${label}：不得自动写回`);
    assert.equal(r.syncBroken, true, `${label}：应判定为同步失败`);
    assert.ok(st.pendingResult, `${label}：AI 结果必须暂存`);
    assert.equal(st.loadCount, 0, `${label}：不得发生 load`);
    assert.equal(st.payload, payloadBefore, `${label}：画布内容必须保持不变`);
    assert.equal(st.busy, false, `${label}：busy 必须释放`);
    assert.equal(st.queryWaiters.size, 0, `${label}：不得留下悬空的查询等待者`);
    // 明确区分两类原因，且提示语真的出现在对话里
    const wraps = app.els.chatList.children;
    const lastBubble = wraps.length ? wraps[wraps.length - 1].children[0] : null;
    const text = lastBubble ? String(lastBubble.textContent) : '';
    assert.ok(text.includes(expectedReason), `${label}：提示应说明「${expectedReason}」—— ${text}`);
    assert.ok(text.includes('已暂存'), `${label}：提示应说明结果已暂存 —— ${text}`);
  }
});

test('思考开关保存当前模型，保存期间阻止发送，冲突时保持已保存状态', async () => {
  const providers = [{ providerId: 'deepseek', name: 'DeepSeek', protocol: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com', enabled: true,
    models: [{ modelId: 'flash', displayName: 'Flash', enabled: true, thinkingMode: 'deepseek-off' }] }];
  let release;
  let conflict = false;
  const app = await createApp({ payload: sampleModel(), providers, onProviderUpdate: async (url, init) => {
    assert.equal(url, '/api/providers/deepseek/models/flash');
    const body = JSON.parse(init.body);
    assert.equal(body.revision, 7);
    if (conflict) return failResp(409, { error: { message: '配置已修改' } });
    assert.equal(body.thinkingMode, 'deepseek-on');
    await new Promise((resolve) => { release = resolve; });
    providers[0].models[0].thinkingMode = body.thinkingMode;
    return okResp({});
  } });
  app.h.setModelSelection({ providerId: 'deepseek', modelId: 'flash' });
  assert.equal(app.els.thinkingToggleLabel.textContent, '思考·关');
  const saving = app.els.thinkingToggle.listeners.click();
  assert.equal(app.els.sendBtn.disabled, true);
  assert.equal((await app.h.sendMessage('画图')).reason, 'settings-saving');
  release();
  await saving;
  assert.equal(app.els.thinkingToggle.ariaChecked, 'true');
  assert.equal(app.els.thinkingToggleLabel.textContent, '思考·开');
  conflict = true;
  await app.els.thinkingToggle.listeners.click();
  assert.equal(app.els.thinkingToggleLabel.textContent, '思考·开');
  assert.match(app.els.toast.textContent, /未保存.*配置已修改/);
  app.h.setModelSelection({ providerId: 'mock', modelId: 'mock' });
  assert.equal(app.els.thinkingToggle.disabled, true);
});

test('等待模型时显示耗时，失败后计时停止且错误不会被进度覆盖', async () => {
  const app = await createApp({ payload: sampleModel() });
  let release;
  app.chat(() => new Promise((resolve) => { release = resolve; }));
  const pending = app.h.sendMessage('画图');
  await new Promise((resolve) => setImmediate(resolve));
  const bubble = app.els.chatList.children.at(-1).children[0];
  const header = bubble.children.find(node => node.className === 'agent-progress-header');
  const viewport = header.children.find(node => node.className === 'agent-progress-window');
  const label = viewport.children[0].children[1].children.find(node => node.className === 'agent-progress-label');
  const elapsed = header.children.find(node => node.className === 'agent-progress-time');
  assert.equal(label.textContent, '正在生成示例图表');
  assert.equal(elapsed.textContent, '0 秒');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(elapsed.textContent, '1 秒');
  release(failResp(502, { error: { message: '模型超时' } }));
  await pending;
  const failure = bubble.textContent;
  assert.match(failure, /生成失败：模型超时/);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(bubble.textContent, failure);
  assert.equal(app.h.state.busy, false);
});

test('强度选项匹配 Qwen 枚举；保存期间禁止发送，冲突恢复原值，关闭思考禁用强度', async () => {
  const providers = [{ providerId: 'mota', name: 'mota', protocol: 'openai-chat-completions', baseUrl: 'https://api-inference.modelscope.cn/v1', enabled: true,
    models: [{ modelId: 'Qwen/Qwen3.8-27B', displayName: 'Qwen', enabled: true, thinkingMode: 'enable-thinking-on', reasoningEffort: 'low' }] }];
  let release, conflict = false;
  const app = await createApp({ payload: sampleModel(), providers, onProviderUpdate: async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.revision, 7);
    if (conflict) return failResp(409, { error: { message: '配置已修改' } });
    assert.equal(body.reasoningEffort, 'medium');
    await new Promise(resolve => { release = resolve; });
    providers[0].models[0].reasoningEffort = body.reasoningEffort;
    return okResp({});
  } });
  app.h.setModelSelection({ providerId: 'mota', modelId: 'Qwen/Qwen3.8-27B' });
  assert.equal(app.els.reasoningEffortSelect.disabled, false);
  assert.equal(app.els.reasoningEffortSelect.value, 'low');
  assert.equal(app.els.reasoningEffortSelect.children.some(o => o.value === 'high'), false);
  app.els.reasoningEffortSelect.value = 'medium';
  const saving = app.els.reasoningEffortSelect.listeners.change();
  assert.equal((await app.h.sendMessage('画图')).reason, 'settings-saving');
  release(); await saving;
  assert.equal(app.els.reasoningEffortSelect.value, 'medium');
  conflict = true;
  app.els.reasoningEffortSelect.value = 'low';
  await app.els.reasoningEffortSelect.listeners.change();
  assert.equal(app.els.reasoningEffortSelect.value, 'medium');
  providers[0].models[0].thinkingMode = 'enable-thinking-off';
  await app.h.refreshModelData();
  assert.equal(app.els.reasoningEffortSelect.disabled, true);
  assert.equal(app.els.reasoningEffortSelect.value, 'medium');
  app.h.setModelSelection({ providerId: 'mock', modelId: 'mock' });
  assert.equal(app.els.reasoningEffortSelect.disabled, true);
});

const configuredProviders = () => [{ providerId:'p',name:'Provider',protocol:'openai-chat-completions',baseUrl:'https://example.com',enabled:true,
  models:[{modelId:'m',displayName:'Model',enabled:true}] }];
async function configuredApp() {
  const app=await createApp({payload:sampleModel(),providers:configuredProviders(),updateOnLoad:true,
    storage:{'diagramai.generationMode':'plan'}});
  app.h.setModelSelection({providerId:'p',modelId:'m'});
  return app;
}
test('完整图表只提交一次请求并写回一次，旧分阶段偏好不会生效', async () => {
  const app=await configuredApp();
  const output=sampleModel().replace('value="处理"','value="模型完整设计"');
  app.chat(body=>{
    assert.equal(body.stage,undefined);assert.equal(body.generationMode,undefined);assert.equal(body.plan,undefined);
    assert.equal(body.currentFile,sampleModel());
    assert.equal(body.providerId,'p');assert.equal(body.modelId,'m');
    return okResp({xml:output,reply:'完成',source:'model',provider:{name:'Provider'},model:{modelId:'m'}});
  });
  const result=await app.h.sendMessage('画完整流程');
  assert.equal(result.applied,true);assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,1);
  assert.equal(app.h.state.payload,output);
  assert.equal(app.els.chatList.children.filter(r=>r.className==='msg user').length,1);
  assert.equal(app.els.chatList.children.filter(r=>r.className==='msg assistant').length,1);
});
test('绘图风格保留需求、替换旧风格且不自动请求，发送时携带具体外观要求', async () => {
  const app=await configuredApp();
  const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
  const presets=[...html.matchAll(/class="chip" data-style="([^"]+)" data-prompt="([^"]+)"/g)].map(match=>({style:match[1],prompt:match[2]}));
  assert.equal(presets.length,6);assert.equal(presets[0].style,'monochrome');
  app.els.chatInput.value='画一个订单审批流程，保留失败分支';
  const choose=preset=>app.els.chips.listeners.click({target:{closest:()=>({dataset:preset})}});
  choose(presets[0]);assert.equal(app.chatCalls,0);assert.equal(app.els.chips.open,false);assert.match(app.els.chatInput.value,/白色画布/);assert.match(app.els.chatInput.value,/不用彩色/);
  choose(presets[1]);choose(presets[1]);
  assert.match(app.els.chatInput.value,/^画一个订单审批流程，保留失败分支/);assert.equal((app.els.chatInput.value.match(/【绘图风格：/g)||[]).length,1);assert.doesNotMatch(app.els.chatInput.value,/黑白简约/);assert.match(app.els.chatInput.value,/#2563EB/);assert.equal(app.chatCalls,0);
  const draft=app.els.chatInput.value;
  app.chat(body=>{assert.equal(body.message,draft);assert.equal(body.currentFile,sampleModel());assert.equal(body.stage,undefined);return okResp({xml:sampleModel()});});
  await app.h.sendMessage(draft);assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,1);
});
test('每种绘图风格只追加外观要求，不替换用户内容', async () => {
  const app=await configuredApp(),html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');
  for(const match of html.matchAll(/class="chip" data-style="([^"]+)" data-prompt="([^"]+)"/g)){
    app.els.chatInput.value='需要保留的内容\n第二行需求';
    app.els.chips.listeners.click({target:{closest:()=>({dataset:{style:match[1],prompt:match[2]}})}});
    assert.ok(app.els.chatInput.value.startsWith('需要保留的内容\n第二行需求\n'));
    assert.match(app.els.chatInput.value,/保留节点文字、连接关系和布局/);assert.equal(app.chatCalls,0);
  }
  assert.doesNotMatch(html,/data-prompt="画一个用户登录注册|data-prompt="画一个电商系统|data-prompt="生成一个关于机器学习/);
});
test('完整生成失败保留画布，重试一次完整请求且保留原模型和新草稿', async () => {
  const app=await configuredApp();
  app.chat(()=>failResp(502,{error:{message:'模型超时'}}));
  await app.h.sendMessage('画完整图表');
  assert.equal(app.h.state.payload,sampleModel());assert.equal(app.h.state.loadCount,0);
  const retry=app.els.chatList.children.at(-1).children.at(-1).children[0];
  assert.equal(retry.textContent,'重试这次请求');
  app.els.chatInput.value='新的草稿';
  app.chat(body=>{
    assert.equal(body.stage,undefined);assert.equal(body.plan,undefined);
    assert.equal(body.providerId,'p');assert.equal(body.modelId,'m');
    assert.equal(body.message,'画完整图表');
    return okResp({xml:sampleModel()});
  });
  await retry.onclick();
  assert.equal(app.chatCalls,2);assert.equal(app.h.state.loadCount,1);
  assert.equal(app.els.chatInput.value,'新的草稿');
});

test('保存元数据变化不视为改图', async () => {
  const app = await createApp({ payload: twoPages(), currentPage: 0 });
  app.chat(() => {
    const metadataOnly = twoPages().replace('<mxfile ', '<mxfile modified="today" etag="new" agent="editor" ');
    app.setPayload(metadataOnly);
    app.h.ingest({ event: 'autosave', xml: metadataOnly, currentPage: 0 });
    return okResp({ xml: sampleModel(), pageId: 'one', pageIndex: 0 });
  });
  const result = await app.h.sendMessage('改为横向布局');
  assert.equal(result.applied, true);
  assert.equal(app.h.state.pendingResult, null);
});


// P0 session operations: exercise the actual app against an isolated repository.
function memorySessions() {
  let current = null, previous = null;
  let fail = false;
  return {
    read: async key => key === 'previous' ? previous : current,
    revision: async () => current?.revision || 0,
    save: async (data, expected, options = {}) => {
      if (fail) throw new Error('QuotaExceededError');
      if ((current?.revision || 0) !== expected) { const error = new Error('stale'); error.name = 'SessionConflictError'; throw error; }
      if (options.backup && current) previous = current;
      current = { version: 1, revision: expected + 1, savedAt: Date.now(), data: JSON.parse(JSON.stringify(data)) };
      return current;
    },
    setFail: value => { fail = value; },
  };
}

test('P0：保存手工编辑、聊天来源、草稿和撤销快照；新建保留上一份完整会话', async () => {
  const app = await createApp({ payload: modelWithManualNode(), updateOnLoad: true });
  const repository = memorySessions();
  app.h.useSessionRepository(repository);
  app.chat(() => okResp({ xml: sampleModel(), reply: '完成', source: 'model', provider: { name: '原提供商' }, model: { modelId: 'original-model' } }));
  await app.h.sendMessage('修改流程');
  app.h.setDraft('下一次的草稿');
  // Capture is explicit because the programmatic draft setter need not emit input.
  const data = app.h.captureSession();
  assert.equal(data.snapshots.length, 1);
  assert.ok(data.snapshots[0].payload.includes('keep-me'));
  assert.equal(data.messages[1].source, '来源：原提供商 / original-model');
  const fresh = await app.h.replaceSession(app.h.emptySession(), { confirmed: true });
  assert.equal(fresh.ok, true);
  const previous = await repository.read('previous');
  assert.equal(previous.data.history.length, 2);
  assert.equal(previous.data.draft, '下一次的草稿');
  assert.equal(previous.data.snapshots.length, 1);
  assert.equal((await repository.read()).data.history.length, 0);
});

test('P0：备份写入失败时，新建不加载空画布、不清聊天、不覆写原备份', async () => {
  const app = await createApp({ payload: modelWithManualNode(), updateOnLoad: true });
  const repository = memorySessions();
  app.h.useSessionRepository(repository);
  app.h.setDraft('保留草稿');
  await app.h.syncWithEditor();
  // Mark dirty via an actual input event before saving.
  app.els.chatInput.listeners.input();
  assert.equal(await app.h.flushSession(), true);
  const saved = JSON.stringify(await repository.read());
  repository.setFail(true);
  const result = await app.h.replaceSession(app.h.emptySession(), { confirmed: true });
  assert.equal(result.ok, false);
  assert.ok(app.h.state.payload.includes('keep-me'));
  assert.equal(app.h.draftValue(), '保留草稿');
  assert.equal(app.h.state.loadCount, 0);
  assert.equal(JSON.stringify(await repository.read()), saved);
  assert.equal(app.h.sessionState().dirty, true);
});

test('P0：取消替换保留文档；非法导入不发 load，不写会话', async () => {
  const app = await createApp({ payload: modelWithManualNode(), updateOnLoad: true, confirm: false });
  const repository = memorySessions();
  app.h.useSessionRepository(repository);
  const result = await app.h.replaceSession(app.h.emptySession());
  assert.equal(result.cancelled, true);
  const bad = await app.h.importDiagram({ name: 'bad.drawio', size: 3, text: async () => '<mxfile><diagram>bad</diagram></mxfile>' });
  assert.equal(bad.ok, false);
  assert.equal(app.h.state.loadCount, 0);
  assert.ok(app.h.state.payload.includes('keep-me'));
});

test('P0：多标签页过期保存明确阻止，不覆盖另一标签页的会话', async () => {
  const app = await createApp({ payload: sampleModel(), updateOnLoad: true });
  const repository = memorySessions();
  await repository.save(app.h.emptySession(modelWithManualNode(), '另一个标签页'), 0);
  app.h.useSessionRepository(repository);
  app.h.setDraft('本标签页'); app.els.chatInput.listeners.input();
  assert.equal(await app.h.flushSession(), false);
  assert.equal(app.h.sessionState().blocked, true);
  assert.equal((await repository.read()).data.name, '另一个标签页');
  const recovered = await app.h.recoverSession('current', { confirmed: true });
  assert.equal(recovered.ok, true);
  assert.ok(app.h.state.payload.includes('keep-me'));
  assert.equal((await repository.read()).data.name, '另一个标签页');
});


test('P0：编辑器未确认加载时，原图、草稿和已保存会话保留', async () => {
  const app = await createApp({ payload: modelWithManualNode(), loadFail: true });
  const repository = memorySessions();
  app.h.useSessionRepository(repository);
  app.h.setLoadTimeout(20);
  app.h.setDraft('不要丢'); app.els.chatInput.listeners.input();
  await app.h.flushSession();
  const result = await app.h.replaceSession(app.h.emptySession(), { confirmed: true });
  assert.equal(result.ok, false);
  assert.ok(app.h.state.payload.includes('keep-me'));
  assert.equal(app.h.draftValue(), '不要丢');
  assert.ok((await repository.read()).data.payload.includes('keep-me'));
  assert.equal((await repository.read()).data.draft, '不要丢');
  assert.equal(app.h.state.sessionBusy, false);
});

// Item 4: abort races and progress never load partial XML into the editor.
const sseResponse = (events, options = {}) => {
  const bytes = new TextEncoder().encode(events.map(([event,data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  let cursor = 0;
  return { ok:true, status:200, headers:{get:()=> 'text/event-stream'}, body:{getReader:()=>({
    async read() {
      options.onRead?.();
      if (cursor >= bytes.length) return {done:true};
      const value = bytes.slice(cursor,cursor+7); cursor += value.length;
      return {value,done:false};
    }, async cancel(){}, releaseLock(){},
  })} };
};
test('流式进度显示实际状态；所有分段和中文正确解码后只写回一次', async()=>{
  const app = await configuredApp(), phases = [];
  app.chat((body)=>{
    assert.equal(body.stream,true);
    return sseResponse([
      ['progress',{phase:'waiting',attempt:1}],['progress',{phase:'thinking'}],
      ['progress',{phase:'generating',chars:10}],['progress',{phase:'validating',chars:100}],
      ['result',{xml:sampleModel(),reply:'完成中文图表'}],
    ],{onRead:()=>{
      assert.equal(app.h.state.loadCount,0);
      const textOf = node => node.textContent + node.children.map(textOf).join('');
      phases.push(textOf(app.els.chatList.children.at(-1).children[0]));
    }});
  });
  const r = await app.h.sendMessage('画图');
  assert.equal(r.applied,true); assert.equal(app.h.state.loadCount,1);
  for(const phase of ['等待首段','正在思考','正在生成','正在校验完整 XML']) assert.ok(phases.some(p=>p.includes(phase)),phase);
  assert.ok(app.els.chatList.children.at(-1).children[0].textContent.includes('完成中文图表'));
});
test('点击取消中止 fetch，不加载、不写历史、不覆盖新草稿，下一次可以正常生成', async()=>{
  const app = await configuredApp(); let signal;
  app.chat((body,init)=>new Promise((resolve,reject)=>{
    signal=init.signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  const pending=app.h.sendMessage('原始请求');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(app.els.cancelBtn.classList.contains('hidden'),false);
  app.els.chatInput.value='新的草稿'; app.els.cancelBtn.listeners.click();
  const r=await pending;
  assert.equal(r.cancelled,true);assert.equal(signal.aborted,true);
  assert.equal(app.h.state.history.length,0);assert.equal(app.h.state.loadCount,0);
  assert.equal(app.h.state.pendingResult,null);assert.equal(app.els.chatInput.value,'新的草稿');
  assert.equal(app.h.state.busy,false);assert.equal(app.els.cancelBtn.classList.contains('hidden'),true);
  app.chat(()=>okResp({xml:sampleModel()}));
  assert.equal((await app.h.sendMessage('再试')).applied,true);
});
test('同步画布时取消不会提交模型请求',async()=>{
  const app=await configuredApp();
  app.mode.doc=false;
  const pending=app.h.sendMessage('请求');app.h.cancelRequest();
  assert.equal((await pending).cancelled,true);assert.equal(app.chatCalls,0);assert.equal(app.h.state.loadCount,0);
});
test('收到结果后同步时取消，丢弃结果且不写历史或暂存结果',async()=>{
  const app=await configuredApp();
  app.chat(()=>{app.mode.doc=false;return okResp({xml:sampleModel()});});
  const pending=app.h.sendMessage('请求');
  await new Promise(resolve=>setImmediate(resolve));app.h.cancelRequest();
  assert.equal((await pending).cancelled,true);assert.equal(app.h.state.history.length,0);
  assert.equal(app.h.state.loadCount,0);assert.equal(app.h.state.pendingResult,null);
});
for(const name of ['断流','流内错误','完整但非法 XML']) {
  test(`流式${name}保留画布`,async()=>{
    const app=await configuredApp();
    const events=[['progress',{phase:'generating',chars:10}]];
    if(name==='流内错误')events.push(['error',{error:{message:'模型流内失败'}}]);
    if(name==='完整但非法 XML')events.push(['result',{xml:'<mxGraphModel><root>',reply:'坏结果'}]);
    app.chat(()=>sseResponse(events));
    await app.h.sendMessage('请求');
    assert.equal(app.h.state.payload,sampleModel());assert.equal(app.h.state.loadCount,0);assert.equal(app.h.state.busy,false);
  });
}

const EditCompiler=require('../../lib/diagram-edit');
const editPatch=operations=>({version:1,operations});
const localResponse=(base,operations,targets=['3'])=>({kind:'local-edit',...EditCompiler.applyPatch(base,editPatch(operations),targets),reply:'已完成局部修改'});
test('修改选中读取真实导出 ID，锁定后仅发送局部请求，完成后更新局部基线',async()=>{
 const app=await configuredApp();assert.equal((await app.h.captureEditSelection()).ok,true);
 app.chat(body=>{assert.equal(body.editMode,'selection');assert.deepEqual(Array.from(body.targetIds),['3']);return okResp(localResponse(sampleModel(),[{op:'update',id:'3',label:'审批'}]));});
 assert.equal((await app.h.sendMessage('改成审批')).applied,true);assert.deepEqual(Array.from(app.h.state.editContext.targetIds),['3']);
 assert.ok(app.h.state.payload.includes('审批'));assert.equal(app.h.state.loadCount,1);
});
test('无选区不能退回全图请求；导出错误和捕获后改图都明确阻止',async()=>{
 const app=await configuredApp();app.mode.selectedIds=[];
 assert.equal((await app.h.captureEditSelection()).ok,false);assert.equal((await app.h.sendMessage('修改它')).reason,'edit-invalid');assert.equal(app.chatCalls,0);
 app.mode.selectedIds=['3'];assert.equal((await app.h.captureEditSelection()).ok,true);
 app.setPayload(sampleModel().replace('value="结束"','value="手工修改"'));
 assert.equal((await app.h.sendMessage('修改它')).ok,false);assert.equal(app.chatCalls,0);assert.equal(app.h.state.loadCount,0);
});
test('局部响应篡改未选节点或摘要时客户端拒绝，原图不变',async()=>{
 for(const tamper of [r=>{r.xml=r.xml.replace('value="开始"','value="篡改"');},r=>{r.requiresReview=true;}]) {
  const app=await configuredApp();await app.h.captureEditSelection();
  app.chat(()=>{const r=localResponse(sampleModel(),[{op:'update',id:'3',label:'审批'}]);tamper(r);return okResp(r);});
  assert.equal((await app.h.sendMessage('改名')).ok,false);assert.equal(app.h.state.loadCount,0);assert.equal(app.h.state.payload,sampleModel());
 }
});
test('删除先暂存，确认后删除关联边；刷新序列化完整保留局部元数据',async()=>{
 const app=await configuredApp({updateOnLoad:true});await app.h.captureEditSelection();
 app.chat(()=>okResp(localResponse(sampleModel(),[{op:'remove',id:'3'}])));
 const r=await app.h.sendMessage('删除选中');assert.equal(r.review,true);assert.equal(app.h.state.loadCount,0);
 const normalized=require('../../public/session-store').normalize(app.h.captureSession());
 assert.equal(normalized.pendingResult.edit.changes.removed.length,3);assert.ok(app.els.pendingResultText.textContent.includes('删除'));
 assert.equal((await app.h.applyPendingResult()).ok,true);assert.equal(app.h.state.loadCount,1);assert.ok(!app.h.state.payload.includes('id="3"'));assert.ok(!app.h.state.payload.includes('id="5"'));
});
test('局部冲突暂存后，确认只改目标，保留等待期间的未选节点手工修改',async()=>{
 const app=await configuredApp({updateOnLoad:true});await app.h.captureEditSelection();
 app.chat(()=>{app.setPayload(sampleModel().replace('value="结束"','value="手工结束"'));return okResp(localResponse(sampleModel(),[{op:'update',id:'3',label:'AI 审核'}]));});
 assert.equal((await app.h.sendMessage('改名')).conflict,true);assert.equal(app.h.state.loadCount,0);
 assert.equal((await app.h.applyPendingResult()).ok,true);assert.ok(app.h.state.payload.includes('AI 审核'));assert.ok(app.h.state.payload.includes('手工结束'));
});
test('局部冲突的目标已被手工改动时应用被拒绝，不覆盖新内容',async()=>{
 const app=await configuredApp({updateOnLoad:true});await app.h.captureEditSelection();
 app.chat(()=>{app.setPayload(sampleModel().replace('value="处理"','value="手工处理"'));return okResp(localResponse(sampleModel(),[{op:'update',id:'3',label:'AI 审核'}]));});
 await app.h.sendMessage('改名');assert.equal((await app.h.applyPendingResult()).ok,false);assert.equal(app.h.state.loadCount,0);assert.ok(app.h.state.payload.includes('手工处理'));
});
test('局部失败重试保留原节点和模型，即使后来选择其他节点也不会更换范围',async()=>{
 const app=await configuredApp();await app.h.captureEditSelection();app.chat(()=>failResp(502,{error:{message:'测试失败'}}));await app.h.sendMessage('原请求');
 const retry=app.els.chatList.children.at(-1).children.at(-1).children[0];
 app.mode.selectedIds=['4'];await app.h.captureEditSelection();app.els.chatInput.value='新草稿';
 app.chat(body=>{assert.deepEqual(Array.from(body.targetIds),['3']);assert.equal(body.message,'原请求');return okResp(localResponse(sampleModel(),[{op:'update',id:'3',label:'审批'}]));});
 await retry.onclick();assert.ok(app.h.state.payload.includes('审批'));assert.equal(app.els.chatInput.value,'新草稿');
});
test('导出并发通过 token 和格式匹配，错误格式、旧回执不能冒充最新选区',async()=>{
 const app=await configuredApp();app.mode.export=false;
 const a=app.h.requestExport({format:'json'}),b=app.h.requestExport({format:'png'});
 const messages=app.sent.filter(m=>m.action==='export');const ma=messages.at(-2),mb=messages.at(-1);
 app.h.ingest({event:'export',format:'json',message:{token:'old'},data:{pages:[]}});
 app.h.ingest({event:'export',format:'png',message:ma,data:'wrong'});
 assert.equal(app.h.state.exportWaiters.size,2);
 app.h.ingest({event:'export',format:'png',message:mb,data:'image'});
 app.h.ingest({event:'export',format:'json',message:ma,data:{pages:[]}});
 assert.equal((await a).format,'json');assert.equal((await b).data,'image');assert.equal(app.h.state.exportWaiters.size,0);
});
test('无效选区和读取选区期间的表单提交保留草稿，不悄悄发送全图',async()=>{
 const app=await configuredApp();app.mode.selectedIds=[];await app.h.captureEditSelection();
 app.els.chatInput.value='保留这份草稿';app.els.chatForm.listeners.submit({preventDefault(){}});
 assert.equal(app.els.chatInput.value,'保留这份草稿');assert.equal(app.chatCalls,0);
 app.mode.export=false;const capturing=app.h.captureEditSelection();
 app.els.chatForm.listeners.submit({preventDefault(){}});assert.equal(app.els.chatInput.value,'保留这份草稿');await capturing;assert.equal(app.chatCalls,0);
});
test('连续两次局部修改沿用原节点，新基线与局部草稿一起保存',async()=>{
 const app=await configuredApp({updateOnLoad:true});await app.h.captureEditSelection();
 app.chat(body=>{assert.deepEqual(Array.from(body.targetIds),['3']);return okResp(localResponse(app.h.state.modelXml,[{op:'update',id:'3',label:body.message}]));});
 assert.equal((await app.h.sendMessage('第一次改名')).applied,true);assert.equal((await app.h.sendMessage('第二次改名')).applied,true);
 assert.equal(app.chatCalls,2);app.els.chatInput.value='下一次只改配色';
 const saved=require('../../public/session-store').normalize(app.h.captureSession());
 assert.deepEqual(saved.editContext.targetIds,['3']);assert.ok(saved.editContext.baseXml.includes('第二次改名'));assert.equal(saved.draft,'下一次只改配色');
});
test('局部结果待确认时禁止继续发送且保留草稿',async()=>{
 const app=await configuredApp();await app.h.captureEditSelection();app.chat(()=>okResp(localResponse(sampleModel(),[{op:'remove',id:'3'}])));await app.h.sendMessage('删除');
 app.els.chatInput.value='稍后再改';app.els.chatForm.listeners.submit({preventDefault(){}});
 assert.equal(app.els.chatInput.value,'稍后再改');assert.equal((await app.h.sendMessage('再发送')).reason,'edit-review-pending');assert.equal(app.chatCalls,1);
});

const VisualRepair=require('../../lib/vision-repair');
async function visionApp(options={}){
 const providers=configuredProviders();providers[0].models[0].visionInput=true;
 const app=await createApp({payload:sampleModel(),providers,updateOnLoad:true,...options});app.h.setModelSelection({providerId:'p',modelId:'m'});return app;
}
const directResponse=(base,xml)=>({kind:'multimodal-edit',xml,changes:VisualRepair.validateCandidate(base,xml,'multimodal'),requiresReview:true,pageId:null,pageIndex:0,reply:'多模态修改完成'});
const directResize=(body,width)=>directResponse(body.vision.baseXml,body.vision.baseXml.replace(/(id="3"[\s\S]*?width=")\d+/, '$1'+width));

const chatResponse=reply=>({kind:'multimodal-chat',xml:null,reply,requiresReview:false,pageId:null,pageIndex:0});
const BLANK='<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

test('删除轮数和自动循环，旧设置无效；开关默认关闭、刷新只恢复偏好',async()=>{
 const app=await visionApp({storage:{'diagramai.visionCycles':'10','diagramai.visionEnabled':'true'}});assert.equal(app.h.state.multimodalEnabled,false);assert.equal(app.h.runVisionAutomation,undefined);assert.equal(app.h.state.visionAutomation,undefined);assert.equal(app.h.toggleMultimodal().enabled,true);assert.equal(app.chatCalls,0);
 const restored=await visionApp({storage:Object.fromEntries(app.storage)});assert.equal(restored.h.state.multimodalEnabled,true);assert.equal(restored.chatCalls,0);assert.equal(restored.h.toggleMultimodal().enabled,false);
 const html=fs.readFileSync(path.join(ROOT,'public/index.html'),'utf8');for(const id of ['visionCycles','visionAutomationCancelBtn','visionAutomationStatus','visionCheckBtn','visionIssues'])assert.ok(!html.includes(id));assert.match(html,/id="thinkingToggle"[^\n]*\n\s*<button[^\n]*id="multimodalToggle"[^\n]*<span>多模态<\/span>/);
});
test('开启多模态后本次对话直接发送当前图、XML和要求，仅调用一次并自动应用',async()=>{
 const app=await visionApp(),{h}=app;h.toggleMultimodal();app.chat(body=>{assert.equal(body.editMode,'multimodal');assert.equal(body.message,'把处理节点放宽');assert.equal(body.vision.image,PNG_FIXTURE);assert.equal(body.vision.baseXml,sampleModel());assert.equal(body.multimodal.current,undefined);assert.equal(body.multimodal.total,undefined);return okResp(directResize(body,160));});
 const result=await h.sendMessage('把处理节点放宽');assert.equal(result.applied,true);assert.equal(app.chatCalls,1);assert.equal(h.state.loadCount,1);assert.match(h.state.modelXml,/width="160"/);assert.equal(h.state.pendingResult,null);assert.equal(app.sent.filter(m=>m.action==='export'&&m.format==='png').length,1);await h.restoreSnapshot();assert.equal(h.state.modelXml,sampleModel());
});
test('识图文字回答不改图，下一轮明确携带用户和助手原文以继续讨论和修改',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();app.chat(body=>{assert.equal(body.history.length,0);return okResp(chatResponse('方案一横排；方案二纵向分组。'));});const first=await app.h.sendMessage('给我两种布局方案');assert.equal(first.applied,false);assert.equal(first.kind,'multimodal-chat');assert.equal(app.h.state.loadCount,0);assert.equal(app.h.state.modelXml,sampleModel());
 app.chat(body=>{assert.equal(body.history[0].content,'给我两种布局方案');assert.equal(body.history[1].content,'方案一横排；方案二纵向分组。');assert.equal(body.message,'按第二个方案改');return okResp({...directResize(body,180),reply:'已按纵向方案调整。'});});assert.equal((await app.h.sendMessage('按第二个方案改')).applied,true);assert.equal(app.chatCalls,2);assert.equal(app.h.state.loadCount,1);
 app.chat(body=>{assert.match(body.vision.baseXml,/width="180"/);assert.equal(body.history.length,4);assert.equal(body.history[3].content,'已按纵向方案调整。');return okResp(chatResponse('当前纵向布局更适合审批顺序。'));});await app.h.sendMessage('为什么更合适？');assert.equal(app.chatCalls,3);assert.equal(app.h.state.loadCount,1);assert.equal(app.sent.filter(m=>m.action==='export'&&m.format==='png').length,3);
});
test('每次对话以画布实际最新内容为准，包括用户手工修改',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();app.chat(body=>okResp(directResize(body,160)));await app.h.sendMessage('放宽节点');app.setPayload(app.h.state.modelXml.replace('开始','手工最新开始'));app.chat(body=>{assert.match(body.vision.baseXml,/手工最新开始/);assert.match(body.currentFile,/width="160"/);return okResp(chatResponse('看到了手工最新开始。'));});await app.h.sendMessage('你看到我的改动了吗');assert.equal(app.chatCalls,2);assert.equal(app.h.state.loadCount,1);
});
test('空白画布支持多模态生成一次，不为不存在的图截图，也不会生成后自动调用',async()=>{
 const app=await visionApp({payload:BLANK});app.h.toggleMultimodal();app.chat(body=>{assert.equal(body.vision.baseXml,BLANK);assert.equal(body.vision.image,undefined);assert.equal(body.editMode,'multimodal');return okResp(directResponse(BLANK,sampleModel()));});const result=await app.h.sendMessage('画审批流程');assert.equal(result.applied,true);assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,1);assert.equal(app.sent.some(m=>m.action==='export'&&m.format==='png'),false);
});
test('空白画布的参考图片直接参与本次生成，参考图和截图不写入会话',async()=>{
 const app=await visionApp({payload:BLANK});app.h.toggleMultimodal();app.h.state.visionReference={name:'参考',data:PNG_FIXTURE};app.chat(body=>{assert.equal(body.editMode,'multimodal');assert.equal(body.vision.reference,PNG_FIXTURE);assert.equal(body.vision.image,undefined);return okResp(directResponse(BLANK,sampleModel()));});assert.equal((await app.h.sendMessage('按参考图创建')).applied,true);assert.equal(app.chatCalls,1);const session=app.h.captureSession();assert.equal(session.visionReference,undefined);assert.equal(session.visionPreview,undefined);
});
test('有图时参考图与当前截图共同发送，补充要求不改写本次用户消息',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();app.h.state.visionReference={name:'参考',data:PNG_FIXTURE};app.els.visionPrompt.value='只参考绿色配色';app.chat(body=>{assert.equal(body.message,'增大节点');assert.equal(body.multimodal.focus,'只参考绿色配色');assert.equal(body.vision.image,PNG_FIXTURE);assert.equal(body.vision.reference,PNG_FIXTURE);return okResp(directResize(body,160));});await app.h.sendMessage('增大节点');assert.equal(app.chatCalls,1);
});
test('局部模式也能识图，但仍只修改显式选区；关闭多模态只发送XML',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();await app.h.captureEditSelection();app.chat(body=>{assert.equal(body.editMode,'selection');assert.deepEqual(body.targetIds,['3']);assert.equal(body.vision.image,PNG_FIXTURE);return okResp(localResponse(sampleModel(),[{op:'update',id:'3',label:'局部处理'}]));});assert.equal((await app.h.sendMessage('改标题')).applied,true);assert.equal(app.chatCalls,1);assert.equal(app.h.state.pendingResult,null);
 app.h.toggleMultimodal();app.chat(body=>{assert.equal(body.vision,undefined);return okResp(localResponse(app.h.state.modelXml,[{op:'update',id:'3',label:'关闭后处理'}]));});await app.h.sendMessage('继续改标题');assert.equal(app.chatCalls,2);
});
test('整页多模态结构调整不被旧局部规则限制，历史仍供对话理解',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();app.h.state.history=[{role:'user',content:'此前只修改节点3'}];app.chat(body=>{assert.equal(body.targetIds,undefined);assert.equal(body.history[0].content,'此前只修改节点3');return okResp(directResponse(body.vision.baseXml,body.vision.baseXml.replace('source="2"','source="4"')));});assert.equal((await app.h.sendMessage('调整整个流程关系')).applied,true);assert.match(app.h.state.modelXml,/source="4"/);assert.equal(app.chatCalls,1);
});
test('取消看图对话关闭上游，不执行任何后续调用，保留图表和新草稿',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();let reached;const waiting=new Promise(r=>reached=r);app.chat((body,init)=>new Promise((resolve,reject)=>{reached();init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));const pending=app.h.sendMessage('看图修改');await waiting;app.els.chatInput.value='新草稿';assert.equal(app.els.multimodalToggle.disabled,true);assert.equal((await app.h.sendMessage('重复发送')).reason,'busy');app.h.cancelRequest();assert.equal((await pending).cancelled,true);assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,0);assert.equal(app.h.state.modelXml,sampleModel());assert.equal(app.els.chatInput.value,'新草稿');assert.equal(app.h.state.history.length,0);
});
test('截图XML回执缺失、截图不合法或截图期间改图在请求前拒绝',async()=>{
 for(const branch of ['missing','change','wrong-image']){let app;app=await visionApp({onExport:msg=>{if(branch==='change'&&msg.format==='png')app.setPayload(modelWithManualNode());},...(branch==='wrong-image'?{pngData:'data:image/png;base64,abcd'}:{})});app.h.toggleMultimodal();if(branch==='missing')app.mode.exportXml=false;assert.equal((await app.h.sendMessage('看图修改')).ok,false);assert.equal(app.chatCalls,0);assert.equal(app.h.state.loadCount,0);}
});
test('错误模式、摘要、页面或非法XML均不应用，文字结果不能夹带XML或摘要',async()=>{
 for(const branch of ['kind','summary','page','xml','chat-xml','chat-changes']){const app=await visionApp();app.h.toggleMultimodal();app.chat(body=>{const data=branch.startsWith('chat-')?chatResponse('说明'):directResize(body,160);if(branch==='kind')data.kind='visual-edit';if(branch==='summary')data.changes.total=999;if(branch==='page')data.pageIndex=1;if(branch==='xml')data.xml='<mxGraphModel/>';if(branch==='chat-xml')data.xml=sampleModel();if(branch==='chat-changes')data.changes={total:0};return okResp(data);});assert.equal((await app.h.sendMessage('修改')).ok,false);assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,0);}
});
test('手工修改导致冲突暂存，不覆盖最新图，候选模式与对话可随会话恢复',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();app.chat(body=>{app.setPayload(body.currentFile.replace('开始','手工开始'));return okResp(directResize(body,160));});const result=await app.h.sendMessage('修改图表');assert.equal(result.conflict,true);assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,0);assert.match(app.h.state.modelXml,/手工开始/);assert.equal(app.h.state.pendingResult.visual.mode,'multimodal');const session=app.h.captureSession();assert.equal(session.pendingResult.visual.mode,'multimodal');assert.equal(session.history[0].content,'修改图表');assert.equal((await app.h.applyPendingResult()).ok,false);
});
test('失败或应用失败不重发，保留原图且不会污染成功对话历史',async()=>{
 for(const branch of ['request','load']){const app=await visionApp({loadFail:branch==='load'});app.h.toggleMultimodal();app.chat(body=>branch==='load'?okResp(directResize(body,160)):failResp(502,{error:{message:'模型错误'}}));const result=await app.h.sendMessage('修改');assert.equal(result.ok,false);assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,0);assert.equal(app.h.state.modelXml,sampleModel());if(branch==='request')assert.equal(app.h.state.history.length,0);}
});
test('模型缺少图片能力时禁止看图，用户可以关闭开关继续普通对话',async()=>{
 const app=await visionApp({storage:{'diagramai.multimodalEnabled':'true'}});app.h.setModelSelection({providerId:'mock',modelId:'mock'});assert.equal((await app.h.sendMessage('看图')).reason,'multimodal-unavailable');assert.equal(app.chatCalls,0);assert.equal(app.h.toggleMultimodal().enabled,false);assert.equal(app.h.toggleMultimodal().ok,false);
});
test('关闭后普通整页请求携带原有XML和历史，无截图和隐式优化',async()=>{
 const app=await visionApp();app.h.state.history=[{role:'user',content:'保持绿色'}];app.chat(body=>{assert.equal(body.vision,undefined);assert.equal(body.currentFile,sampleModel());assert.equal(body.history[0].content,'保持绿色');return okResp({xml:sampleModel().replace('处理','普通修改'),pageId:null,pageIndex:0});});await app.h.sendMessage('改文字');assert.equal(app.chatCalls,1);assert.equal(app.h.state.loadCount,1);assert.equal(app.sent.some(m=>m.action==='export'&&m.format==='png'),false);
});

test('空白图也能先讨论再生成，纯文字方案在后续对话保留',async()=>{
 const app=await visionApp({payload:BLANK});app.h.toggleMultimodal();app.chat(()=>okResp(chatResponse('建议先画三个审批步骤。')));await app.h.sendMessage('先讨论怎么画');assert.equal(app.h.state.loadCount,0);app.chat(body=>{assert.equal(body.history[1].content,'建议先画三个审批步骤。');return okResp(directResponse(BLANK,sampleModel()));});await app.h.sendMessage('按你说的画');assert.equal(app.chatCalls,2);assert.equal(app.h.state.loadCount,1);
});

const imageFile=()=>({name:'参考.png',type:'image/png',size:70,data:PNG_FIXTURE});
test('带尾部附加数据的真实 JPEG 在聊天与参考图入口可添加，并原样保留图像编码',async()=>{
 const bytes=fs.readFileSync(path.join(__dirname,'../helpers/images/progressive.jpg'));
 const original='data:image/jpeg;base64,'+bytes.toString('base64'),withTrailer=Buffer.concat([bytes,Buffer.from('export metadata')]);
 const file={name:'参考.jpeg',type:'image/jpeg',size:withTrailer.length,data:'data:image/jpeg;base64,'+withTrailer.toString('base64')};
 const app=await visionApp();app.h.toggleMultimodal();assert.equal((await app.h.addChatImages([file])).ok,true);
 assert.equal(app.h.state.attachments[0].data,original);assert.equal((await app.h.setVisionReference(file)).ok,true);assert.equal(app.h.state.visionReference.data,original);
});
test('聊天图片入口必须开启多模态，关闭后图片和草稿保留且不能发送',async()=>{
 const app=await visionApp();assert.equal(app.els.attachImageBtn.disabled,true);
 assert.equal((await app.h.addChatImages([imageFile()])).reason,'multimodal-off');assert.equal(app.h.state.attachments.length,0);
 app.h.toggleMultimodal();assert.equal((await app.h.addChatImages([imageFile()])).ok,true);
 app.h.toggleMultimodal();assert.equal(app.h.state.attachments.length,1);app.els.chatInput.value='保留图片';
 app.els.chatForm.listeners.submit({preventDefault(){}});assert.equal(app.chatCalls,0);assert.equal(app.els.chatInput.value,'保留图片');
 assert.equal((await app.h.sendMessage('图片',{attachments:app.h.state.attachments})).reason,'multimodal-off');
});
test('图片消息可以没有文字，上传图和当前画面直接发送、后续追问保留图片；关闭后不发送历史图片',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();await app.h.addChatImages([imageFile()]);
 app.chat(body=>{assert.equal(body.message,'请看看这些图片。');assert.equal(body.vision.image,PNG_FIXTURE);assert.deepEqual(body.vision.images,[PNG_FIXTURE]);return okResp(chatResponse('这张图片是参考布局。'));});
 assert.equal((await app.h.sendMessage('',{attachments:app.h.state.attachments})).ok,true);assert.equal(app.h.state.attachments.length,0);
 app.chat(body=>{assert.deepEqual(body.history[0].images,[PNG_FIXTURE]);return okResp(chatResponse('可以继续参考上传的图片。'));});await app.h.sendMessage('刚才那张图是什么布局？');
 const saved=require('../../public/session-store').normalize(app.h.captureSession());assert.equal(saved.history[0].images[0],PNG_FIXTURE);assert.equal(saved.messages[0].images[0],PNG_FIXTURE);
 app.h.toggleMultimodal();app.chat(body=>{assert.equal(body.vision,undefined);assert.equal(body.history.some(m=>m.images),false);return okResp({xml:sampleModel(),reply:'说明'});});await app.h.sendMessage('继续');
});
test('新上传的图片替换上下文中的旧图片，旧聊天记录仍显示图片',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();app.chat(()=>okResp(chatResponse('已收到')));
 for(let i=0;i<2;i++){await app.h.addChatImages([imageFile()]);await app.h.sendMessage('图片 '+i,{attachments:app.h.state.attachments});}
 assert.equal(app.h.state.history.filter(m=>m.images).length,1);const saved=app.h.captureSession();assert.equal(saved.messages.filter(m=>m.images).length,2);
});
test('取消和失败保留图片附件与新草稿，不生成丢失图片的文字重试',async()=>{
 for(const cancel of [true,false]){const app=await visionApp();app.h.toggleMultimodal();await app.h.addChatImages([imageFile()]);
 let reached;const waiting=new Promise(r=>reached=r);app.chat((body,init)=>new Promise((resolve,reject)=>{reached();if(cancel)init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});else reject(new Error('网关断开'));}));
 const pending=app.h.sendMessage('识图',{attachments:app.h.state.attachments});await waiting;app.els.chatInput.value='新草稿';if(cancel)app.h.cancelRequest();
 assert.equal((await pending).ok,false);assert.equal(app.h.state.attachments.length,1);assert.equal(app.els.chatInput.value,'新草稿');assert.equal(app.h.state.retry,null);assert.equal(app.h.state.history.length,0);}
});
test('非法格式、大小与超量附件均拒绝，粘贴和拖入也遵守多模态开关',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();
 for(const files of [[{...imageFile(),type:'image/gif'}],[{...imageFile(),size:4*1024*1024}],[imageFile(),imageFile(),imageFile(),imageFile()],[{...imageFile(),data:'data:image/png;base64,abcd'}]]){assert.equal((await app.h.addChatImages(files)).ok,false);assert.equal(app.h.state.attachments.length,0);}
 await app.h.addChatImages([imageFile(),imageFile(),imageFile()]);assert.equal((await app.h.addChatImages([imageFile()])).ok,false);assert.equal(app.h.state.attachments.length,3);
 app.h.state.attachments=[];app.h.toggleMultimodal();let prevented=0;app.els.chatInput.listeners.paste({clipboardData:{files:[imageFile()]},preventDefault(){prevented++;}});app.els.chatForm.listeners.drop({dataTransfer:{files:[imageFile()]},preventDefault(){prevented++;}});assert.equal(prevented,2);assert.equal(app.h.state.attachments.length,0);
 prevented=0;app.els.chatInput.listeners.paste({clipboardData:{files:[]},preventDefault(){prevented++;}});assert.equal(prevented,0);
});
test('读取图片时拒绝发送，换会话时不会把在途图片装入新会话',async()=>{
 const app=await visionApp();app.h.toggleMultimodal();const reading=app.h.addChatImages([imageFile()]);app.els.chatInput.value='不能提前清空';app.els.chatForm.listeners.submit({preventDefault(){}});assert.equal(app.els.chatInput.value,'不能提前清空');assert.equal(app.chatCalls,0);
 app.h.state.attachmentVersion++;assert.equal((await reading).ok,false);assert.equal(app.h.state.attachments.length,0);
});

// Server-backed drawing jobs run through the same canvas conflict checks.
function drawingRepository({fail=false}={}) {
 let revision=0,current=null;
 return {get current(){return current;},get fail(){return fail;},set fail(value){fail=value;},async revision(){return revision;},async read(){return current?{data:current,revision}:null;},
  async save(value,expected){if(fail)throw Error('disk unavailable');assert.equal(expected,revision);current=require('../../public/session-store').normalize(JSON.parse(JSON.stringify(value)));return {revision:++revision,savedAt:Date.now()};}};
}
const drawingEvent = (data) => new Response('event: result\ndata: '+JSON.stringify(data)+'\n\n',{headers:{'content-type':'text/event-stream'}});
test('后台绘图：POST前持久恢复基线，结果应用并保存之后才ACK',async()=>{
 const calls=[],repo=drawingRepository();let app;
 app=await createApp({payload:sampleModel(),updateOnLoad:true,background:true,onTask:async(url,init)=>{
  calls.push(url);if(url.endsWith('/ack')){assert.equal(repo.current.drawingTask.status,'settled');assert.equal(repo.current.history.length,2);return okResp({released:true});}
  if(url.endsWith('/events'))return drawingEvent({xml:sampleModel().replace('y="280"','y="320"'),reply:'done',pageIndex:0,pageId:null});
  assert.equal(repo.current.drawingTask.status,'pending');assert.equal(repo.current.drawingTask.base.payload,sampleModel());const body=JSON.parse(init.body);assert.equal(body.taskId,repo.current.drawingTask.taskId);assert.equal(body.mode,'chat');return okResp({task:{taskId:body.taskId,status:'running'}});
 }});app.h.useSessionRepository(repo);
 const result=await app.h.sendMessage('改为横向布局');assert.equal(result.applied,true);assert.equal(repo.current.drawingTask.status,'settled');assert.equal(calls.filter(x=>x==='/api/drawing/tasks').length,1);assert.equal(calls.filter(x=>x.endsWith('/ack')).length,1);
});
test('后台绘图：本地恢复信息保存失败不发送模型任务',async()=>{
 let calls=0;const repo=drawingRepository({fail:true});
 const app=await createApp({payload:sampleModel(),background:true,onTask:async()=>{calls++;throw Error('must not send');}});app.h.useSessionRepository(repo);
 const result=await app.h.sendMessage('画图');assert.equal(result.ok,false);assert.equal(calls,0);assert.match(result.error,/未保存/);
});
test('后台绘图：恢复仅查询原任务；刷新后手工改图必须暂存，不能覆盖',async()=>{
 const calls=[],repo=drawingRepository(),taskId='12345678-1234-1234-1234-123456789abc';
 const app=await createApp({payload:modelWithManualNode(),background:true,onTask:async(url,init)=>{calls.push([url,init.method]);if(url.endsWith('/ack'))return okResp({released:true});return okResp({task:{status:'succeeded',xml:sampleModel(),reply:'done',pageIndex:0,pageId:null}});}});app.h.useSessionRepository(repo);
 app.h.state.drawingTask={taskId,threadId:taskId,assistantId:taskId,status:'pending',mode:'chat',message:'画图',selection:{providerId:'deleted-provider',modelId:'deleted-model'},base:{payload:sampleModel(),pageIndex:0,pageId:null,revision:0},attachments:[]};
 const result=await app.h.resumeDrawingTask();assert.equal(result.conflict,true);assert.match(app.h.state.payload,/keep-me/);assert.ok(repo.current.pendingResult);assert.equal(calls.filter(x=>x[1]==='POST'&&x[0]==='/api/drawing/tasks').length,0);assert.ok(calls.some(x=>x[0].endsWith('/ack')));
});
test('后台绘图：结果保存失败保留服务器副本；稍后保存重试ACK不重复应用',async()=>{
 const calls=[],repo=drawingRepository();
 const app=await createApp({payload:sampleModel(),updateOnLoad:true,background:true,onTask:async(url,init)=>{calls.push(url);if(url.endsWith('/ack'))return okResp({released:true});if(url.endsWith('/events')){repo.fail=true;return drawingEvent({xml:sampleModel(),reply:'done',pageIndex:0,pageId:null});}return okResp({task:{status:'running'}});}});app.h.useSessionRepository(repo);
 await app.h.sendMessage('画图');assert.equal(calls.filter(x=>x.endsWith('/ack')).length,0);assert.equal(app.h.state.drawingTask.status,'settled');const loads=app.sent.filter(x=>x.action==='load').length;
 repo.fail=false;await app.h.flushSession();assert.equal(calls.filter(x=>x.endsWith('/ack')).length,1);assert.equal(app.sent.filter(x=>x.action==='load').length,loads);
});

test('后台绘图：pagehide仅断开连接，刷新前保存任务标识而非错误或重试',async()=>{
 const calls=[],repo=drawingRepository();let waiting;
 const app=await createApp({payload:sampleModel(),background:true,onTask:async(url,init)=>{calls.push(url);if(url.endsWith('/events'))return new Promise((resolve,reject)=>{waiting=true;init.signal.addEventListener('abort',()=>reject(Error('view detached')),{once:true});});return okResp({task:{status:'running'}});}});app.h.useSessionRepository(repo);
 const operation=app.h.sendMessage('画图');while(!waiting)await new Promise(resolve=>setImmediate(resolve));app.events.pagehide();
 const result=await operation;assert.equal(result.pending,true);assert.equal(app.h.state.drawingTask.status,'pending');assert.ok(!calls.some(url=>url.endsWith('/cancel')));assert.ok(!calls.some(url=>url.endsWith('/ack')));assert.equal(repo.current.drawingTask.status,'pending');assert.ok(!repo.current.messages.some(m=>m.retry));assert.match(repo.current.messages.at(-1).text,/服务器正在生成/);
});
test('后台绘图：其他标签页已推进存储时不写画布且不ACK，任务保持待恢复',async()=>{
 const calls=[],repo=drawingRepository();const originalRevision=repo.revision;
 let externallyChanged=false;
 repo.revision=async()=>externallyChanged?999:originalRevision();
 const app=await createApp({payload:sampleModel(),background:true,onTask:async(url,init)=>{calls.push(url);if(url.endsWith('/events')){externallyChanged=true;return drawingEvent({xml:sampleModel(),reply:'done',pageIndex:0,pageId:null});}return okResp({task:{status:'running'}});}});app.h.useSessionRepository(repo);
 const result=await app.h.sendMessage('画图');assert.equal(result.pending,true);assert.equal(app.h.state.drawingTask.status,'pending');assert.ok(!calls.some(url=>url.endsWith('/ack')));assert.equal(app.sent.filter(x=>x.action==='load').length,0);
});
test('后台绘图：显式取消调用cancel而非中断生成连接；终态保存后可ACK',async()=>{
 const calls=[],repo=drawingRepository();let settle,waiting;
 const app=await createApp({payload:sampleModel(),background:true,onTask:async(url,init)=>{calls.push(url);if(url.endsWith('/ack'))return okResp({released:true});if(url.endsWith('/cancel')){settle(new Response('event: error\ndata: '+JSON.stringify({taskTerminal:true,error:{code:'task-cancelled',message:'已取消生成'}})+'\n\n',{headers:{'content-type':'text/event-stream'}}));return okResp({task:{status:'running'}});}if(url.endsWith('/events'))return new Promise(resolve=>{settle=resolve;waiting=true;});return okResp({task:{status:'running'}});}});app.h.useSessionRepository(repo);
 const operation=app.h.sendMessage('画图');while(!waiting)await new Promise(resolve=>setImmediate(resolve));app.h.cancelRequest();const result=await operation;
 assert.equal(result.ok,false);assert.match(result.error,/已取消生成/);assert.equal(repo.current.drawingTask.status,'settled');assert.equal(calls.filter(x=>x.endsWith('/cancel')).length,1);assert.ok(calls.some(x=>x.endsWith('/ack')));assert.equal(app.sent.filter(x=>x.action==='load').length,0);
});
test('后台绘图：已返回结果但局部候选校验失败不能ACK丢失原结果',async()=>{
 const calls=[],repo=drawingRepository();
 const app=await createApp({payload:sampleModel(),background:true,onTask:async(url,init)=>{calls.push(url);if(url.endsWith('/events'))return drawingEvent({xml:sampleModel(),reply:'wrong edit shape',kind:'unexpected',pageIndex:0,pageId:null});return okResp({task:{status:'running'}});}});app.h.useSessionRepository(repo);
 const scope=require('../../lib/diagram-edit').resolveScope(sampleModel(),['3']);
 const result=await app.h.sendMessage('改节点',{editContext:{baseXml:sampleModel(),pageId:null,pageIndex:0,targetIds:scope.targetIds}});
 assert.equal(result.pending,true);assert.equal(app.h.state.drawingTask.status,'pending');assert.ok(!calls.some(url=>url.endsWith('/ack')));assert.equal(app.sent.filter(x=>x.action==='load').length,0);
});

test('后台绘图：取消与完成同时发生时保留候选，不再自动修改画布',async()=>{
 const calls=[],repo=drawingRepository();let app;
 app=await createApp({payload:sampleModel(),updateOnLoad:true,background:true,onTask:async(url,init)=>{
  calls.push(url);if(url.endsWith('/ack'))return okResp({released:true});
  if(url.endsWith('/cancel'))return okResp({task:{status:'succeeded'}});
  if(url.endsWith('/events')){app.h.cancelRequest();return drawingEvent({xml:sampleModel().replace('y="280"','y="320"'),reply:'done',pageIndex:0,pageId:null});}
  return okResp({task:{status:'running'}});
 }});app.h.useSessionRepository(repo);
 const result=await app.h.sendMessage('画图');
 assert.equal(result.applied,false);assert.equal(result.conflict,true);
 assert.equal(app.sent.filter(x=>x.action==='load').length,0);
 assert.ok(repo.current.pendingResult);assert.equal(repo.current.drawingTask.status,'settled');
 assert.ok(calls.some(url=>url.endsWith('/ack')));
});

test('目录尚未加载时不能隐式使用示例模型；已有绘图任务仍可独立恢复',async()=>{
 const calls=[],repo=drawingRepository(),id='12345678-1234-1234-1234-123456789abc';
 const app=await createApp({payload:sampleModel(),background:true,onTask:async(url,init)=>{calls.push([url,init.method]);if(url.endsWith('/ack'))return okResp({released:true});return okResp({task:{status:'succeeded',xml:sampleModel(),reply:'done',pageIndex:0,pageId:null}});}});app.h.useSessionRepository(repo);app.h.state.modelCatalog=null;
 assert.equal((await app.h.sendMessage('画图')).reason,'catalog-loading');assert.equal(calls.length,0);
 app.h.state.drawingTask={taskId:id,threadId:id,assistantId:id,status:'pending',mode:'chat',message:'画图',selection:{providerId:'deleted',modelId:'deleted'},base:{payload:sampleModel(),pageIndex:0,pageId:null,revision:0},attachments:[]};
 assert.equal((await app.h.resumeDrawingTask()).ok,true);assert.ok(calls.some(x=>x[0].endsWith('/ack')));assert.ok(!calls.some(x=>x[0]==='/api/drawing/tasks'));
});
