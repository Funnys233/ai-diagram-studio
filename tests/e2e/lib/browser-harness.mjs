// 浏览器测试基础设施（agent-browser + CDP），供复现脚本与 E2E 共用
//
// 关键经验：
//   1. agent-browser 的 CLI 调用会挤掉之前建立的 CDP WebSocket → 使用前才取 cdp-url，并支持重连
//   2. Chromium 输入事件只能通过 CDP Input.dispatchMouseEvent 派发（CLI 没有坐标点击）
//   3. draw.io 的 iframe 是独立的 OOPIF target，可以 attach 进去做 DOM 查询（跨域在 CDP 层不受限）
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const NODE = process.execPath;

export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.sessionId = null;
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`CDP 连接失败: ${url}`));
    });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP 错误'));
        else resolve(msg.result);
      }
    };
    return cdp;
  }

  async attachTo(kind, urlPart) {
    const { targetInfos } = await this.send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === kind && t.url.includes(urlPart))
      || targetInfos.find((t) => t.type === kind);
    if (!target) throw new Error(`找不到 ${kind} 目标`);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    return sessionId;
  }

  /** 绑定到顶层页面（输入事件必须发到页面会话） */
  async usePage(urlPart) {
    this.sessionId = await this.attachTo('page', urlPart || '127.0.0.1');
    try { await this.send('Page.bringToFront'); } catch (e) { /* 忽略 */ }
    return this.sessionId;
  }

  /** 绑定到 draw.io 的 OOPIF，用于查询/点击其内部 DOM */
  async useEditorFrame() {
    this.frameSessionId = await this.attachTo('iframe', 'diagrams.net');
    return this.frameSessionId;
  }

  send(method, params = {}, options = {}) {
    const id = ++this.seq;
    const sessionId = options.frame ? this.frameSessionId : this.sessionId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const timeoutMs = options.timeout || 15000;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, timeoutMs);
    });
  }

  /** 在 draw.io iframe 内执行 JS，返回 JSON 值 */
  async frameEval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: false,
    }, { frame: true });
    if (res.exceptionDetails) throw new Error('frameEval 异常: ' + (res.exceptionDetails.text || ''));
    return res.result ? res.result.value : null;
  }

  async frameJson(expression) {
    const value = await this.frameEval(`JSON.stringify(${expression})`);
    return value ? JSON.parse(value) : null;
  }

  async mouse(type, x, y, clickCount, buttons) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount, buttons });
  }

  async click(x, y) {
    await this.mouse('mouseMoved', x, y, 0, 0);
    await this.mouse('mousePressed', x, y, 1, 1);
    await this.mouse('mouseReleased', x, y, 1, 0);
    await sleep(60);
  }

  async doubleClick(x, y) {
    await this.mouse('mouseMoved', x, y, 0, 0);
    for (const clickCount of [1, 2]) {
      await this.mouse('mousePressed', x, y, clickCount, 1);
      await this.mouse('mouseReleased', x, y, clickCount, 0);
      await sleep(40);
    }
  }

  async pressKey(key, code, vk) {
    const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    await sleep(150);
  }

  pressEscape() { return this.pressKey('Escape', 'Escape', 27); }

  /**
   * 在 draw.io iframe 内按文本精确查找元素并真实点击。
   * @param {string} needle 精确匹配的文本（会 trim）
   * @param {{x:number,y:number}} frameOrigin 顶层页面里 iframe 的左上角坐标
   */
  async clickFrameText(needle, frameOrigin) {
    const found = await this.frameJson(`(function () {
      const all = [].slice.call(document.querySelectorAll('div,span,td,a,button,label'));
      const hits = all.filter(function (e) { return e.textContent && e.textContent.trim() === ${JSON.stringify(needle)}; });
      const pick = hits.sort(function (a, b) { return a.getBoundingClientRect().width - b.getBoundingClientRect().width; })[0];
      if (!pick) return null;
      const r = pick.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: pick.tagName, cls: String(pick.className || '') };
    })()`);
    if (!found) return null;
    await this.click(frameOrigin.x + found.x, frameOrigin.y + found.y);
    return found;
  }

  async allowDownloads(dir) {
    try { await this.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dir }); } catch (e) { /* 忽略 */ }
    try { await this.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, eventsEnabled: true }); } catch (e) { /* 忽略 */ }
  }

  close() { try { this.ws.close(); } catch (e) { /* 忽略 */ } }
}

/** agent-browser CLI 封装 */
export function makeBrowser(session) {
  const ab = (args, options = {}) => {
    const res = spawnSync('agent-browser', ['--session', session, ...args], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024 * 1024,
      env: process.env,
      timeout: options.timeout || 180000,
    });
    if (res.error) throw res.error;
    const out = (res.stdout || '').trim();
    const err = (res.stderr || '').trim();
    if (res.status !== 0 && !options.allowFail) {
      throw new Error(`agent-browser ${args[0]} 失败(status=${res.status}): ${err || out}`);
    }
    return { out, err, status: res.status };
  };

  const evalRaw = (code, options) => ab(['eval', code], options).out;

  const evalJson = (code) => {
    const out = evalRaw(code);
    let value;
    try { value = JSON.parse(out); } catch (e) {
      throw new Error(`eval 输出不是 JSON: ${out.slice(0, 200)}`);
    }
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch (e) { /* 保持字符串 */ }
    }
    return value;
  };

  const waitFor = async (label, code, predicate, options = {}) => {
    const timeout = options.timeout || 60000;
    const interval = options.interval || 300;
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
      last = evalJson(code);
      if (predicate(last)) return last;
      await sleep(interval);
    }
    throw new Error(`等待超时：${label}；最后状态 ${JSON.stringify(last)}`);
  };

  return { ab, evalRaw, evalJson, waitFor };
}

/** 启动本地服务并等待可访问 */
export async function startServer({ port, env = {} } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), DEEPSEEK_API_KEY: '',
      PROVIDERS_CONFIG_PATH: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'diagramai-e2e-providers-')), 'providers.json'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/healthz`);
      if (res.ok) return { child, base, stop: () => child.kill('SIGTERM') };
    } catch (e) { /* 还没起来 */ }
    await sleep(150);
  }
  child.kill('SIGTERM');
  throw new Error('本地服务启动失败');
}

export function makeOutDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function makeChecker() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : String(detail) });
    console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
    return Boolean(ok);
  };
  return { results, check, failures: () => results.filter((r) => !r.ok).length };
}

/** 客户端测试钩子辅助（页面内安装） */
export const PAGE_HELPERS = `
window.__H = {
  st: function () {
    const s = window.__DIAGRAM_AI_TEST__.state;
    const model = s.modelXml || '';
    const r = window.DiagramModel.validateGraphModel(model);
    return {
      rev: s.revision,
      kind: s.payloadKind,
      pageCount: s.pageCount,
      pageIndex: s.pageIndex,
      pageId: s.pageId || null,
      modelLen: model.length,
      valid: r.ok,
      cells: r.ok ? r.stats.cells : -1,
      vertices: r.ok ? r.stats.vertices : -1,
      edges: r.ok ? r.stats.edges : -1,
      loadCount: s.loadCount,
      staleReceipts: s.staleReceipts,
      pendingToken: s.pendingLoad ? s.pendingLoad.token : null,
      syncFailures: s.syncFailures,
      boundsW: s.lastLoadInfo && s.lastLoadInfo.bounds ? Math.round(s.lastLoadInfo.bounds.width) : null,
      boundsH: s.lastLoadInfo && s.lastLoadInfo.bounds ? Math.round(s.lastLoadInfo.bounds.height) : null,
      pendingLen: s.pendingResult ? s.pendingResult.xml.length : null,
      snapshots: s.snapshots.length,
      busy: s.busy,
      draft: document.getElementById('chatInput').value,
      retry: s.retry ? s.retry.text : null,
      banner: !document.getElementById('conflictBanner').classList.contains('hidden'),
      chatCount: window.__chatCount || 0,
      errors: window.__pageErrors || []
    };
  },
  frameRect: function () {
    const r = document.getElementById('drawioFrame').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  },
  pageSignature: function () {
    const s = window.__DIAGRAM_AI_TEST__.state;
    const info = window.DiagramFile.parseFile(s.payload || '');
    if (info.kind !== 'mxfile') return 'model';
    return info.pages.map(function (p) { return p.id || p.name; }).join('|');
  },
  delayFetch: function (ms) {
    window.__delayMs = ms;
    window.__chatCount = window.__chatCount || 0;
    if (!window.__origFetch) window.__origFetch = window.fetch;
    if (window.__fetchWrapped) return 'ok';
    window.__fetchWrapped = true;
    const orig = window.fetch.bind(window);
    window.fetch = function (u, o) {
      if (String(u).indexOf('/api/chat') !== -1) {
        window.__chatCount++;
        const delay = window.__delayMs || 0;
        return new Promise(function (resolve, reject) {
          setTimeout(function () { orig(u, o).then(resolve, reject); }, delay);
        });
      }
      return orig(u, o);
    };
    return 'ok';
  },
  /** 彻底恢复真实 fetch（把 failFetch/delayFetch 的两层包装都摘掉） */
  restoreFetch: function () {
    window.__failMode = null;
    window.__delayMs = 0;
    if (window.__origFetch) window.fetch = window.__origFetch;
    window.__fetchWrapped = false;
    window.__failWrapped = false;
    return 'ok';
  },
  failFetch: function (mode, delayMs) {
    window.__failMode = mode;
    window.__failDelay = delayMs || 0;
    if (!window.__origFetch) window.__origFetch = window.fetch;
    if (window.__failWrapped) return 'ok';
    window.__failWrapped = true;
    const orig = window.fetch.bind(window);
    window.fetch = function (u, o) {
      if (String(u).indexOf('/api/chat') !== -1 && window.__failMode) {
        window.__chatCount = (window.__chatCount || 0) + 1;
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(new Response(JSON.stringify({ error: { code: 'test-failure', message: '测试注入的失败' } }),
              { status: 500, headers: { 'Content-Type': 'application/json' } }));
          }, window.__failDelay);
        });
      }
      return orig(u, o);
    };
    return 'ok';
  },
  installErrorCapture: function () {
    window.__pageErrors = [];
    window.addEventListener('error', function (e) { window.__pageErrors.push(String(e.message)); });
    window.addEventListener('unhandledrejection', function (e) { window.__pageErrors.push('unhandled: ' + String(e.reason)); });
    return 'ok';
  }
};
'helpers-ready'
`;
