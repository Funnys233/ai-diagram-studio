#!/usr/bin/env node
// 前端体检（性能 / 可访问性 / 响应式）：用 CDP 驱动无头 Chrome，输出结构化报告与截图。
//
// 为什么需要它：
//   - 这个项目没有构建步骤，也没有前端 lint，UI 回归只能靠人眼。此脚本把「可度量的部分」自动化：
//     传输体积与请求数、文本对比度（含 alpha 合成）、表单标签、可访问名称、触控目标尺寸、
//     各断点横向溢出、控制台报错。
//   - 报告是 JSON，可以先用 --save 存基线，再用 --baseline 比对，退出码非 0 表示有回退。
//
// 用法：
//   node scripts/frontend-audit.mjs                         # 体检默认页面，打印摘要
//   node scripts/frontend-audit.mjs --pages index,chat,usage
//   node scripts/frontend-audit.mjs --save /tmp/base.json   # 存基线
//   node scripts/frontend-audit.mjs --baseline /tmp/base.json  # 与基线比对（回退则退出码 1）
//   node scripts/frontend-audit.mjs --out /tmp/shots --json-full
//
// 环境变量：
//   AUDIT_BASE   服务地址，默认 http://127.0.0.1:8080
//   CDP_PORT     CDP 端口，默认 9333；连不上会自动拉起无头 Chrome
//   CHROME_BIN   Chrome 可执行文件路径（可选）
//
// 注意：draw.io embed 会对无头 UA 返回 403，因此编辑器画布区在体检里始终是加载态；
// 这不影响页面框架、对话面板与顶栏的度量。

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const BASE = (opt('base', process.env.AUDIT_BASE || 'http://127.0.0.1:8080')).replace(/\/+$/, '');
const CDP_PORT = Number(opt('cdp-port', process.env.CDP_PORT || 9333));
const OUT_DIR = opt('out', process.env.AUDIT_OUT || '');
const SAVE = opt('save', '');
const BASELINE = opt('baseline', '');
const PAGES = opt('pages', 'index,chat,usage')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// 页面清单：路由 + 等待时间（draw.io embed 需要更久）
const ROUTES = {
  index: { path: '/?test=1', wait: 9000, name: '绘图工作台' },
  chat: { path: '/chat.html', wait: 3500, name: '纯对话' },
  usage: { path: '/usage.html', wait: 2500, name: '用量统计' },
  login: { path: '/login.html', wait: 2000, name: '登录' },
  register: { path: '/register.html', wait: 2000, name: '注册' },
  admin: { path: '/admin.html', wait: 2500, name: '后台' },
};

// 断点：桌面 / 平板 / 手机 / 极窄
const BREAKPOINTS = [
  { label: 'desktop', w: 1440, h: 900, mobile: false },
  { label: 'tablet', w: 834, h: 1112, mobile: true },
  { label: 'mobile', w: 390, h: 844, mobile: true },
  { label: 'narrow', w: 320, h: 640, mobile: true },
];

// ---------- CDP 客户端 ----------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.failedRequests = [];
  }

  static async fromPort(port) {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('CDP 上没有可用页面');
    return Cdp.fromWs(page.webSocketDebuggerUrl);
  }

  static async fromWs(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('CDP 连接失败'));
    });
    const cdp = new Cdp(ws);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        cdp.consoleErrors.push((d?.exception?.description || d?.text || 'exception').split('\n')[0].slice(0, 200));
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (text) cdp.consoleErrors.push(text.slice(0, 200));
      }
      if (msg.method === 'Network.loadingFailed' && !msg.params?.canceled) {
        cdp.failedRequests.push(`${msg.params.errorText} ${msg.params.type}`);
      }
    };
    return cdp;
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch { /* 忽略 */ } }
}

/** 连不上已有 Chrome 时自己拉起一个（headless，临时 profile，退出时清理） */
async function ensureChrome() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return { spawned: false };
  } catch { /* 需要自启 */ }

  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const bin = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!bin) throw new Error('找不到 Chrome；请设置 CHROME_BIN 或先自行启动带 --remote-debugging-port 的浏览器');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-audit-chrome-'));
  const child = spawn(bin, [
    '--headless=new',
    // 容器/沙箱环境下 Chrome 的 seccomp 沙箱无法初始化，必须关闭
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
  child.on('error', () => { /* 交给下方的健康检查报错 */ });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return { spawned: true, child, profile };
    } catch { /* 继续等 */ }
    await sleep(300);
  }
  throw new Error('无头 Chrome 启动超时');
}

// ---------- 页面内体检脚本 ----------
// 对比度必须做 alpha 合成：本项目大量使用 rgba 边框/底色，直接比 rgb 会误报。
const A11Y_PROBE = String.raw`(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); const hi = Math.max(x, y), lo = Math.min(x, y); return (hi + 0.05) / (lo + 0.05); };
  // 从元素往上找不透明底色，逐层合成
  const backdrop = (el) => {
    const stack = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const st = getComputedStyle(n);
      const c = parse(st.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  };
  const visible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) < 0.5) return false;
    return el.getClientRects().length > 0;
  };

  const contrast = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!ownText) continue;
    const st = getComputedStyle(el);
    const fg = parse(st.color);
    if (!fg) continue;
    const bg = backdrop(el);
    const eff = fg.a < 1 ? over(fg, bg) : fg;
    const r = ratio(eff, bg);
    const size = parseFloat(st.fontSize);
    const bold = Number(st.fontWeight) >= 700;
    // WCAG AA：大文本 3:1，正文 4.5:1
    const need = size >= 18.66 || (bold && size >= 14) ? 3 : 4.5;
    if (r >= need) continue;
    const key = describe(el) + st.color;
    if (seen.has(key)) continue;
    seen.add(key);
    contrast.push({
      sel: describe(el),
      color: st.color,
      bg: 'rgb(' + [bg.r, bg.g, bg.b].map((v) => Math.round(v)).join(',') + ')',
      ratio: Math.round(r * 100) / 100,
      need,
      size,
      text: (el.textContent || '').trim().slice(0, 28),
    });
  }
  contrast.sort((a, b) => a.ratio - b.ratio);

  // 表单控件必须可被读屏命名：aria-label / aria-labelledby / title / <label> 任一即可
  const noLabel = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')].filter((el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return false;
    if (el.closest('label')) return false;
    return !(el.id && document.querySelector('label[for="' + el.id + '"]'));
  }).map((el) => el.id || el.type || el.tagName.toLowerCase());

  // 按钮/链接/可展开项必须有可访问名称
  const noName = [...document.querySelectorAll('button,a[href],summary')].filter((el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return false;
    if ((el.textContent || '').trim()) return false;
    return !el.querySelector('title');
  }).map(describe);

  // 触控目标：WCAG 2.2 AA 要求 24x24，移动端实践推荐 32x32
  const small = [...document.querySelectorAll('button,a[href],summary,input[type=checkbox],input[type=radio],select')]
    .filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.width < 32 || r.height < 32);
    })
    .map((el) => ({ id: el.id || describe(el), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }));

  // 动态状态提示应进入 aria-live，否则读屏用户听不到 toast/提示
  const liveCandidates = ['#toast', '#hintBar', '#aiStatus', '#composerStatus'];
  const missingLive = liveCandidates.filter((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return !el.getAttribute('role') && !el.getAttribute('aria-live');
  });

  return {
    contrast,
    noLabel,
    noName,
    small,
    missingLive,
    counts: {
      contrast: contrast.length,
      noLabel: noLabel.length,
      noName: noName.length,
      small: small.length,
      missingLive: missingLive.length,
    },
  };
})()`;

// ---------- 度量 ----------
async function measurePage(cdp, key) {
  const route = ROUTES[key];
  const url = `${BASE}${route.path}`;

  cdp.consoleErrors.length = 0;
  cdp.failedRequests.length = 0;

  const record = { key, name: route.name, url };

  // 桌面尺寸下等待页面稳定
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url });
  await sleep(route.wait);

  record.finalUrl = await cdp.eval('location.href');
  record.title = await cdp.eval('document.title');

  record.perf = await cdp.eval(`(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource');
    const textTypes = /^(script|link|other|fetch|xmlhttprequest|iframe)$/;
    let textBytes = 0, imageBytes = 0, fontBytes = 0;
    for (const r of res) {
      const t = r.initiatorType || 'other';
      if (textTypes.test(t)) textBytes += r.transferSize || 0;
      else if (t === 'img' || t === 'image') imageBytes += r.transferSize || 0;
      else fontBytes += r.transferSize || 0;
    }
    const big = res
      .filter((r) => (r.transferSize || 0) > 20000)
      .sort((a, b) => b.transferSize - a.transferSize)
      .map((r) => ({ file: r.name.split('/').pop().slice(0, 44), kb: Math.round(r.transferSize / 1024) }));
    return {
      dcl: Math.round(nav.domContentLoadedEventEnd || 0),
      load: Math.round(nav.loadEventEnd || 0),
      requests: res.length,
      transferBytes: res.reduce((a, r) => a + (r.transferSize || 0), 0),
      textBytes,
      imageBytes,
      fontBytes,
      big,
    };
  })()`);

  record.a11y = await cdp.eval(A11Y_PROBE);

  // 逐断点检查横向溢出与关键容器是否被压塌
  record.breakpoints = [];
  for (const bp of BREAKPOINTS) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: bp.w, height: bp.h, deviceScaleFactor: 1, mobile: bp.mobile,
    });
    await sleep(450);
    const probe = await cdp.eval(`(() => {
      const overflow = [];
      for (const el of document.querySelectorAll('body *')) {
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden') continue;
        // fixed 元素（弹层、抽屉）不在文档流内，不参与横向溢出的判断
        if (st.position === 'fixed') continue;
        const r = el.getBoundingClientRect();
        if (!r.width) continue;
        if (r.right > innerWidth + 2 && r.left < innerWidth) {
          overflow.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), right: Math.round(r.right), text: (el.textContent || '').trim().slice(0, 20) });
        }
      }
      return {
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        overflow: overflow.slice(0, 20),
      };
    })()`);
    record.breakpoints.push({ ...bp, ...probe });
  }

  // 回到桌面尺寸，供截图
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);

  if (OUT_DIR) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const bp of BREAKPOINTS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: bp.w, height: bp.h, deviceScaleFactor: 1, mobile: bp.mobile,
      });
      await sleep(450);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT_DIR, `${key}-${bp.label}.png`), Buffer.from(data, 'base64'));
    }
  }

  record.consoleErrors = [...cdp.consoleErrors];
  record.failedRequests = [...cdp.failedRequests];
  return record;
}

// ---------- 摘要与比对 ----------
function summarize(record) {
  const p = record.perf;
  const a = record.a11y.counts;
  const overflowAt = record.breakpoints.filter((b) => b.hOverflow).map((b) => b.label);
  const parts = [
    `${(p.transferBytes / 1024).toFixed(0)}KB/${p.requests}req`,
    `contrast ${a.contrast}`,
    `label ${a.noLabel}`,
    `name ${a.noName}`,
    `target ${a.small}`,
    `live ${a.missingLive}`,
    overflowAt.length ? `overflow@${overflowAt.join(',')}` : 'overflow none',
  ];
  return `${record.key}: ${parts.join(' | ')}`;
}

const METRICS = [
  { name: 'transferKB', get: (r) => Math.round(r.perf.transferBytes / 1024), tolerance: 0.05, higherIsBetter: false },
  { name: 'requests', get: (r) => r.perf.requests, tolerance: 0.05, higherIsBetter: false },
  { name: 'contrast', get: (r) => r.a11y.counts.contrast, tolerance: 0, higherIsBetter: false },
  { name: 'noLabel', get: (r) => r.a11y.counts.noLabel, tolerance: 0, higherIsBetter: false },
  { name: 'noName', get: (r) => r.a11y.counts.noName, tolerance: 0, higherIsBetter: false },
  { name: 'smallTargets', get: (r) => r.a11y.counts.small, tolerance: 0, higherIsBetter: false },
  { name: 'missingLive', get: (r) => r.a11y.counts.missingLive, tolerance: 0, higherIsBetter: false },
  { name: 'overflowBreakpoints', get: (r) => r.breakpoints.filter((b) => b.hOverflow).length, tolerance: 0, higherIsBetter: false },
  { name: 'consoleErrors', get: (r) => r.consoleErrors.length, tolerance: 0, higherIsBetter: false },
];

function compareToBaseline(reports, baseline) {
  const regressions = [];
  for (const report of reports) {
    const base = baseline.pages.find((p) => p.key === report.key);
    if (!base) { regressions.push(`${report.key}: 基线中没有该页面`); continue; }
    for (const m of METRICS) {
      const before = m.get(base);
      const after = m.get(report);
      const allowed = before * (1 + m.tolerance) + (m.tolerance === 0 ? 0 : 0.5);
      const worse = m.higherIsBetter ? after < allowed : after > allowed;
      if (worse) regressions.push(`${report.key}.${m.name}: ${before} → ${after}`);
    }
  }
  return regressions;
}

// ---------- 主流程 ----------
async function main() {
  if (!PAGES.every((p) => ROUTES[p])) {
    throw new Error(`未知页面：${PAGES.filter((p) => !ROUTES[p]).join(',')}；可用：${Object.keys(ROUTES).join(',')}`);
  }

  // 服务必须先起来，否则所有度量都是空的
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    throw new Error(`服务不可访问：${BASE}（先运行 node server.js）`);
  }

  const chrome = await ensureChrome();
  const cdp = await Cdp.fromPort(CDP_PORT);

  let reports = [];
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    for (const key of PAGES) {
      process.stdout.write(`体检 ${key} … `);
      const record = await measurePage(cdp, key);
      reports.push(record);
      console.log('完成');
    }
  } finally {
    cdp.close();
    if (chrome.spawned) {
      try { chrome.child.kill('SIGKILL'); } catch { /* 已退出 */ }
      try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    pages: reports,
  };

  console.log('');
  for (const r of reports) console.log('  ' + summarize(r));

  if (SAVE) {
    fs.mkdirSync(path.dirname(path.resolve(SAVE)), { recursive: true });
    fs.writeFileSync(SAVE, JSON.stringify(payload, null, 2));
    console.log(`\n基线已保存：${SAVE}`);
  }

  if (flag('json-full')) {
    console.log('\n' + JSON.stringify(payload, null, 2));
  }

  if (BASELINE) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const regressions = compareToBaseline(reports, baseline);
    if (regressions.length) {
      console.log(`\n✗ 检测到回退（${regressions.length} 项）：`);
      for (const r of regressions) console.log('   ' + r);
      process.exitCode = 1;
    } else {
      console.log('\n✓ 与基线相比没有回退');
    }
  }

  // 有控制台异常时不静默通过
  const errored = reports.filter((r) => r.consoleErrors.length);
  if (errored.length) {
    console.log(`\n! ${errored.length} 个页面有控制台错误：`);
    for (const r of errored) console.log(`   ${r.key}: ${r.consoleErrors[0]}`);
  }
}

main().catch((e) => {
  console.error(`\n体检失败：${e.message}`);
  process.exitCode = 1;
});
