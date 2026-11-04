#!/usr/bin/env node
// 独立验收报告（ACCEPTANCE_REPORT.md）中 A–G 七项问题的复现脚本
//
// 用途：
//   - 修复前运行：确认这些缺陷在当前代码中真实存在（输出「缺陷存在」）
//   - 修复后运行：确认同一脚本不再复现（输出「已修复」）
// 其中 B/D/F/G 为库级复现（无需浏览器），A/C/E 为真实浏览器复现。
//
// 用法：node tests/repro/repro-acceptance.mjs [--only=A,B] [--browser=0]
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { makeBrowser, startServer, makeOutDir, Cdp, PAGE_HELPERS, ROOT } from '../e2e/lib/browser-harness.mjs';

const require = createRequire(import.meta.url);
const Xml = require('../../lib/xml.js');
const Model = require('../../lib/graphmodel.js');
const File = require('../../lib/drawio-format.js');
const { mockGenerate } = require('../../lib/mock-engine.js');

const PORT = Number(process.env.REPRO_PORT || 8251);
const SESSION = process.env.REPRO_SESSION || 'diagramai-repro';
const OUT_DIR = makeOutDir(process.env.REPRO_OUT || '/tmp/diagramai-repro');
const argv = process.argv.slice(2);
const onlyArg = argv.find((a) => a.startsWith('--only='));
const ONLY = onlyArg ? onlyArg.split('=')[1].split(',').map((s) => s.trim().toUpperCase()) : null;
const WITH_BROWSER = !argv.includes('--browser=0');

const cases = [];
function record(id, title, buggy, detail) {
  cases.push({ id, title, buggy, detail: detail === undefined ? null : String(detail) });
  console.log(`${buggy ? '✗ 缺陷存在' : '✓ 未复现（行为正确）'} [${id}] ${title}${detail ? ' — ' + detail : ''}`);
}

function selected(id) {
  return !ONLY || ONLY.includes(id);
}

// ---------------- 库级复现 ----------------
function reproB() {
  // B：已有图 + 修改指令被误判为新建
  const keepMe = '<mxGraphModel dx="900" dy="650"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="keep-me" value="手工节点" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>'
    + '</root></mxGraphModel>';
  const result = mockGenerate('在当前画布增加一个审批节点', { modelXml: keepMe, pageIndex: 0, pageCount: 1 });
  const lost = !result.xml ? false : !result.xml.includes('keep-me');
  const isNew = result.kind === 'new';
  record('B', '「在当前画布增加一个审批节点」被误判为新建并丢失已有图', isNew || lost,
    `kind=${result.kind} xml=${result.xml ? 'len ' + result.xml.length : 'null'} keepMe保留=${result.xml ? result.xml.includes('keep-me') : 'n/a'}`);
}

function reproD() {
  const head = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>';
  const casesD = {
    '邻接属性无空格': head + '<mxCell id="2"value="开始" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>',
    '非法字符引用&#0;': head + '<mxCell id="2" value="&#0;开始" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>',
    '非法注释': head + '<!-- bad -- comment --><mxCell id="2" value="开始" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>',
  };
  const accepted = [];
  for (const [name, xml] of Object.entries(casesD)) {
    let parsedOk = true;
    let validationOk = true;
    try { Xml.parse(xml); } catch (e) { parsedOk = false; }
    if (parsedOk) validationOk = Model.validateGraphModel(xml).ok;
    if (parsedOk && validationOk) accepted.push(name);
  }
  record('D', '三类非法 XML（邻接属性 / &#0; / 非法注释）被解析器放行', accepted.length > 0,
    accepted.length ? `被接受：${accepted.join('、')}` : '全部被拒绝');
}

function reproF() {
  const xml = '<mxGraphModel dx="900" dy="650"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="2" value="第一行&#xa;第二行&#x9;结尾" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>'
    + '</root></mxGraphModel>';
  const before = Model.summarize(xml);
  const out = Model.applyLayout(xml, 'horizontal');
  const labelOf = (source) => {
    const parsed = Xml.parse(source);
    const rootEls = Xml.childElements(parsed.root, 'root');
    for (const { cell } of Model.collectCells(rootEls[0])) {
      if (cell && cell.attributes.id === '2') return cell.attributes.value;
    }
    return null;
  };
  const valueBefore = labelOf(xml);
  const valueAfter = labelOf(out.xml);
  record('F', '布局变换后多行 / 制表符标签的解析值被改变', valueBefore !== valueAfter,
    `${JSON.stringify(valueBefore)} → ${JSON.stringify(valueAfter)} (vertices=${before.vertices})`);
}

function reproG() {
  const arch = mockGenerate('画一个电商系统的微服务架构图，分前端层、网关层、服务层和数据层', { modelXml: null }).xml;
  const parsedBefore = Xml.parse(arch);
  const geometryOf = (source) => {
    const parsed = Xml.parse(source);
    const rootEls = Xml.childElements(parsed.root, 'root');
    const map = new Map();
    for (const { cell } of Model.collectCells(rootEls[0])) {
      if (!cell) continue;
      const g = Xml.firstChild(cell, 'mxGeometry');
      if (!g) continue;
      map.set(cell.attributes.id, {
        x: Number(g.attributes.x), y: Number(g.attributes.y),
        w: Number(g.attributes.width), h: Number(g.attributes.height),
        parent: cell.attributes.parent, vertex: cell.attributes.vertex,
      });
    }
    return map;
  };
  const before = geometryOf(arch);
  let out;
  try {
    out = Model.applyLayout(arch, 'horizontal').xml;
  } catch (e) {
    record('G', '四层架构图布局变换破坏子节点位置', true, `布局被拒绝：${e.message}（保留原图，符合「不支持则拒绝」要求）`);
    return;
  }
  const after = geometryOf(out);
  const outside = [];
  for (const [id, g] of after) {
    if (g.vertex !== '1' || g.parent === '1') continue;
    const parent = after.get(g.parent);
    if (!parent) continue;
    if (g.x < 0 || g.y < 0 || g.x + g.w > parent.w + 1 || g.y + g.h > parent.h + 1) {
      outside.push(`${id}(子 x=${g.x} y=${g.y} 尺寸 ${g.w}x${g.h} / 容器 ${parent.w}x${parent.h})`);
    }
  }
  record('G', '四层架构图布局变换后子节点跑到父容器之外', outside.length > 0,
    outside.length ? `${outside.length} 个子节点越界：${outside.slice(0, 4).join('；')}${outside.length > 4 ? ' …' : ''}` : '全部子节点都在容器内');
  void parsedBefore;
}

// ---------------- 浏览器复现 ----------------
const MODEL_V = (id, value, x, y) => `<mxCell id="${id}" value="${value}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="160" height="60" as="geometry"/></mxCell>`;
const MODEL_E = (id, s, t) => `<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const HEAD = '<mxGraphModel dx="900" dy="650" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">';

function verticalModel() {
  return `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/>${MODEL_V('n0', '开始', 340, 60)}${MODEL_V('n1', '处理', 340, 170)}${MODEL_V('n2', '结束', 340, 280)}${MODEL_E('e1', 'n0', 'n1')}${MODEL_E('e2', 'n1', 'n2')}</root></mxGraphModel>`;
}

function twoPageFile() {
  return `<mxfile host="DiagramAI" type="device">
  <diagram name="第一页" id="page-one">${verticalModel()}</diagram>
  <diagram name="第二页" id="page-two">${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram>
</mxfile>`;
}

function pageGeometry(payload, pageIndex) {
  const info = File.parseFile(payload);
  if (info.kind !== 'mxfile' || !info.pages[pageIndex]) return null;
  const page = info.pages[pageIndex];
  if (page.encoding !== 'xml') return null;
  const text = Xml.sliceNode(payload, page.modelNode);
  const parsed = Xml.parse(text);
  const rootEls = Xml.childElements(parsed.root, 'root');
  const nodes = [];
  for (const { cell } of Model.collectCells(rootEls[0])) {
    if (!cell || cell.attributes.vertex !== '1') continue;
    const g = Xml.firstChild(cell, 'mxGeometry');
    nodes.push({ id: cell.attributes.id, x: Number(g.attributes.x), y: Number(g.attributes.y) });
  }
  return nodes;
}

async function reproBrowser({ check }) {
  const { ab, evalRaw, evalJson, waitFor } = makeBrowser(SESSION);
  const server = await startServer({ port: PORT });
  let cdp = null;
  try {
    ab(['close', '--all'], { allowFail: true });
    const opened = ab(['open', `${server.base}/?test=1`]);
    if (opened.out.includes('Navigation failed')) throw new Error(opened.out);
    await waitFor('编辑器就绪', PAGE_HELPERS + '\nJSON.stringify({ready: window.__DIAGRAM_AI_TEST__.isReady()})',
      (v) => v.ready, { timeout: 120000, interval: 1000 });
    evalRaw(PAGE_HELPERS);
    evalJson('window.__H.installErrorCapture()');

    const cdpUrl = ab(['get', 'cdp-url']).out.replace(/^"|"$/g, '');
    cdp = await Cdp.connect(cdpUrl);
    await cdp.usePage();
    await cdp.allowDownloads(OUT_DIR);
    await cdp.useEditorFrame();
    const rect = evalJson('JSON.stringify(window.__H.frameRect())');

    // 编辑器当前页查询（不受修复影响，用于判定 state.pageIndex 是否陈旧）
    const currentPageFromEditor = async () => {
      evalJson(`(function(){ window.__ping = null; const f = document.getElementById('drawioFrame');
        window.addEventListener('message', function h(e){ if (e.source!==f.contentWindow||typeof e.data!=='string') return; try { const m=JSON.parse(e.data); if (m.event==='viewbox') { window.__ping = m.currentPage; window.removeEventListener('message', h); } } catch(err){} });
        f.contentWindow.postMessage(JSON.stringify({action:'viewbox', viewbox:null, token:'repro'}), 'https://embed.diagrams.net'); return 'ok'; })()`);
      return waitFor('编辑器当前页', 'JSON.stringify(window.__ping)', (v) => typeof v === 'number', { timeout: 6000 });
    };

    /** 在 draw.io 内查找文本匹配的元素并真实点击 */
    const clickInFrameByText = async (needle) => {
      const found = await cdp.frameJson(`(function(){
        const all = [].slice.call(document.querySelectorAll('div,span,td,a,button,label'));
        const hits = all.filter(function(e){ return e.textContent && e.textContent.trim() === ${JSON.stringify('NEEDLE')}; });
        const pick = hits.sort(function(a,b){ return a.getBoundingClientRect().width - b.getBoundingClientRect().width; })[0];
        if (!pick) return null;
        const r = pick.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), tag: pick.tagName, cls: pick.className, text: pick.textContent.trim() };
      })()`.replace('NEEDLE', needle));
      if (!found) return null;
      await cdp.click(rect.x + found.x, rect.y + found.y);
      return found;
    };

    // ---------- A：切页后请求作用在错误的页面 ----------
    if (selected('A')) {
      evalJson(`window.__DIAGRAM_AI_TEST__.loadPayload(${JSON.stringify(twoPageFile())}).then(function(r){ window.__loaded = r; });'ok'`);
      await waitFor('两页文件加载完成', 'JSON.stringify(window.__loaded || null)', (v) => v && v.ok === true, { timeout: 30000 });

      const switchTo = async (name, openerName) => {
        const opener = await clickInFrameByText(openerName);
        if (!opener) return null;
        await sleep(500);
        const item = await clickInFrameByText(name);
        if (!item) return null;
        await sleep(800);
        return { opener, item };
      };

      // 验收场景：切到第二页，再切回第一页（纯切页、不改内容），然后直接发布局修改
      const toSecond = await switchTo('第二页', '第一页');
      const backToFirst = toSecond ? await switchTo('第一页', '第二页') : null;
      const editorPage = await currentPageFromEditor();
      const stBefore = evalJson('JSON.stringify(window.__H.st())');

      evalJson(`window.__DIAGRAM_AI_TEST__.sendMessage("把当前图表整体改成从左到右布局");'ok'`);
      await waitFor('修改完成', 'JSON.stringify(window.__H.st())', (v) => v.busy === false, { timeout: 40000 });
      const payload = evalJson('JSON.stringify(window.__DIAGRAM_AI_TEST__.state.payload)');
      const after = evalJson('JSON.stringify(window.__H.st())');
      const pageOne = pageGeometry(payload, 0) || [];
      const pageTwo = pageGeometry(payload, 1) || [];
      const pageOneHorizontal = pageOne.length > 0
        && new Set(pageOne.map((n) => n.y)).size === 1
        && new Set(pageOne.map((n) => n.x)).size > 1;
      const pageTwoUntouched = pageTwo.length === 0;

      const switched = Boolean(toSecond && backToFirst);
      const buggy = !(pageOneHorizontal && pageTwoUntouched)
        || (switched && (editorPage !== after.pageIndex || after.pageIndex !== 0));
      record('A', '切页后 AI 修改作用于错误的页面（可见页未被修改 / 旧页被改）', buggy,
        `切页=${switched ? '成功' : '未完成(退化为状态比对)'} 编辑器当前页=${editorPage} 应用页=${after.pageIndex}；第一页已横向=${pageOneHorizontal}(节点${pageOne.length}) 第二页保持为空=${pageTwoUntouched}`);
      void stBefore;
    }

    // ---------- C：重叠加载丢 Promise + 过期回执 ----------
    if (selected('C')) {
      evalJson(`window.__DIAGRAM_AI_TEST__.setLoadTimeout(2500);'ok'`);
      evalJson(`(function(){
        window.__loads = [];
        const H = window.__DIAGRAM_AI_TEST__;
        const a = ${JSON.stringify(verticalModel())};
        const b = '<mxGraphModel dx="900" dy="650"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="x1" value="B图" style="rounded=0;html=1;" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
        H.loadPayload(a).then(function(r){ window.__loads.push(['p1', !!(r && r.ok), (r && (r.cancelled ? 'cancelled' : r.error)) || '']); });
        H.loadPayload(b).then(function(r){ window.__loads.push(['p2', !!(r && r.ok), (r && (r.error||'')) || '']); });
        return 'started';
      })()`);
      await sleep(6000);
      const loads = evalJson('JSON.stringify(window.__loads)');
      record('C', '重叠加载导致旧 Promise 永不结束（悬空 resolver）', loads.length < 2,
        `已结束的加载：${JSON.stringify(loads)}`);

      // 过期回执 / 超时都不得错误确认另一项操作（用 dryRun 事务精确控制回执时序）
      const stalePayload = '<mxGraphModel dx="900" dy="650"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';
      const TARGET = verticalModel();

      // 阶段 1：A 被 B 取代；注入 A 的过期回执，不能确认 B
      evalJson(`(function(){
        window.__tx = [];
        const H = window.__DIAGRAM_AI_TEST__;
        H.setLoadTimeout(4000);
        H.loadPayload(${JSON.stringify(stalePayload)}, { dryRun: true }).then(function(r){ window.__tx.push(['A', !!(r && r.ok), r && r.cancelled ? 'cancelled' : (r && r.error) || '']); });
        H.loadPayload(${JSON.stringify(TARGET)}, { dryRun: true }).then(function(r){ window.__tx.push(['B', !!(r && r.ok), r && r.cancelled ? 'cancelled' : (r && r.error) || '']); });
        return 'started';
      })()`);
      await sleep(150);
      evalJson(`window.__DIAGRAM_AI_TEST__.ingest({ event: 'load', xml: ${JSON.stringify(stalePayload)}, currentPage: 0 });'ok'`);
      await sleep(150);
      const phase1 = evalJson('JSON.stringify({ tx: window.__tx, st: window.__H.st() })');
      const staleDidNotConfirm = phase1.st.pendingToken !== null && phase1.tx.length === 1;
      evalJson(`window.__DIAGRAM_AI_TEST__.ingest({ event: 'load', xml: ${JSON.stringify(TARGET)}, currentPage: 0 });'ok'`);
      await sleep(200);
      const phase1b = evalJson('JSON.stringify({ tx: window.__tx, st: window.__H.st() })');
      const aCancelled = phase1b.tx[0] && phase1b.tx[0][0] === 'A' && phase1b.tx[0][2] === 'cancelled';
      const bConfirmed = phase1b.tx[1] && phase1b.tx[1][0] === 'B' && phase1b.tx[1][1] === true;

      // 阶段 2：超时必须结束；迟到的回执不得确认任何操作
      evalJson(`(function(){
        window.__tx2 = [];
        const H = window.__DIAGRAM_AI_TEST__;
        H.setLoadTimeout(800);
        H.loadPayload(${JSON.stringify(stalePayload)}, { dryRun: true }).then(function(r){ window.__tx2.push(['C', !!(r && r.ok), r && r.timeout ? 'timeout' : (r && r.error) || '']); });
        return 'started';
      })()`);
      await sleep(1200);
      const phase2 = evalJson('JSON.stringify({ tx2: window.__tx2, st: window.__H.st() })');
      const timeoutSettled = phase2.tx2[0] && phase2.tx2[0][2] === 'timeout';
      evalJson(`window.__DIAGRAM_AI_TEST__.ingest({ event: 'load', xml: ${JSON.stringify(stalePayload)}, currentPage: 0 });'ok'`);
      await sleep(200);
      const phase3 = evalJson('JSON.stringify({ tx2: window.__tx2, st: window.__H.st() })');
      const lateDidNotConfirm = phase3.tx2.length === 1
        && phase3.st.staleReceipts === phase2.st.staleReceipts + 1
        && phase3.st.pendingToken === null;

      record('C2', '过期回执 / 超时错误确认了另一项操作',
        !(aCancelled && bConfirmed && staleDidNotConfirm && timeoutSettled && lateDidNotConfirm),
        `A=${JSON.stringify(phase1b.tx[0])} B=${JSON.stringify(phase1b.tx[1])} 过期回执后仍在等待=${staleDidNotConfirm} 超时=${JSON.stringify(phase2.tx2[0])} 迟到回执未确认=${lateDidNotConfirm} 过期回执计数=${phase3.st.staleReceipts}`);
    }

    // ---------- C3：AI 等待加载确认时点击撤销，连续点击恢复 ----------
    if (selected('C3')) {
      evalJson(`window.__DIAGRAM_AI_TEST__.setLoadTimeout(2500);'ok'`);
      evalJson(`(function(){
        window.__c3 = { send: null, undo1: null, undo2: null };
        const H = window.__DIAGRAM_AI_TEST__;
        H.sendMessage('把当前图表整体改成从左到右布局').then(function(r){ window.__c3.send = r || { ok: false }; });
        setTimeout(function(){
          const snaps = H.snapshots();
          const last = snaps[snaps.length - 1];
          if (last) {
            H.restoreSnapshot(last.id).then(function(r){ window.__c3.undo1 = r || { ok: false }; });
            H.restoreSnapshot(last.id).then(function(r){ window.__c3.undo2 = r || { ok: false }; });
          } else {
            window.__c3.undo1 = { ok: false, error: 'no-snapshot' };
            window.__c3.undo2 = { ok: false, error: 'no-snapshot' };
          }
        }, 300);
        return 'started';
      })()`);
      await sleep(9000);
      // 界面必须仍可继续发送
      const canSend = evalJson(`(function(){ const H = window.__DIAGRAM_AI_TEST__; return JSON.stringify({ busy: H.state.busy, disabled: document.getElementById('sendBtn').disabled }); })()`);
      const c3 = evalJson('JSON.stringify({ c3: window.__c3, st: window.__H.st() })');
      const settled = c3.c3.send !== null && c3.c3.undo1 !== null && c3.c3.undo2 !== null;
      record('C3', '加载未确认时连续撤销导致 Promise 不收敛 / busy 卡住',
        !settled || c3.st.busy === true || canSend.disabled === true,
        `send=${JSON.stringify(c3.c3.send)} undo1=${JSON.stringify(c3.c3.undo1)} undo2=${JSON.stringify(c3.c3.undo2)} busy=${c3.st.busy} 发送按钮禁用=${canSend.disabled}`);
    }

    // ---------- E：失败响应覆盖等待期间的新草稿 ----------
    if (selected('E')) {
      evalJson(`window.__H.failFetch('on', 2000)`); // 2 秒后才返回失败，留出「等待期间写新草稿」的窗口
      evalJson(`(function(){ const i=document.getElementById('chatInput'); i.value='原始请求'; document.getElementById('chatForm').requestSubmit(); return 'ok'; })()`);
      await sleep(400);
      evalJson(`document.getElementById('chatInput').value = '等待期间新写的草稿';'ok'`);
      const done = await waitFor('失败返回', 'JSON.stringify(window.__H.st())', (v) => v.busy === false, { timeout: 20000 });
      record('E', '失败响应把输入框覆盖回旧请求文本（新草稿丢失）', done.draft !== '等待期间新写的草稿',
        `输入框内容="${done.draft}"，重试状态=${JSON.stringify(done.retry)}`);
      evalJson(`window.__H.failFetch('off')`);
    }

    void check;
  } finally {
    if (cdp) cdp.close();
    try { ab(['close', '--all'], { allowFail: true }); } catch (e) { /* 忽略 */ }
    server.stop();
  }
}

// ---------------- 主流程 ----------------
console.log(`\n=== 复现脚本（${ROOT}）===\n`);
if (selected('B')) reproB();
if (selected('D')) reproD();
if (selected('F')) reproF();
if (selected('G')) reproG();

if (WITH_BROWSER && (selected('A') || selected('C') || selected('E'))) {
  const { check } = { check: () => {} };
  await reproBrowser({ check });
}

const reproduced = cases.filter((c) => c.buggy).map((c) => c.id);
const clean = cases.filter((c) => !c.buggy).map((c) => c.id);
console.log(`\n--- 汇总：复现到的缺陷 ${reproduced.length} 项，未复现 ${clean.length} 项 ---`);
if (reproduced.length) console.log(`复现到的缺陷：${reproduced.join(', ')}`);
if (clean.length) console.log(`未复现：${clean.join(', ')}`);
fs.writeFileSync(path.join(OUT_DIR, 'repro-report.json'), JSON.stringify({ at: new Date().toISOString(), cases, reproduced }, null, 2));
console.log(`报告：${path.join(OUT_DIR, 'repro-report.json')}`);
process.exit(0);
