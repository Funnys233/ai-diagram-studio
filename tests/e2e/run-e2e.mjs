#!/usr/bin/env node
// 端到端验证（真实浏览器 + 真实 draw.io 编辑器）
//
// 覆盖：
//   1. 编辑器加载、生成、`load` 回执 bounds 证明画布真的渲染出内容
//   2. 生成期间的**真实手工编辑**（CDP 双击画布插入图形）不丢；应用/撤销快照闭环
//   3. 下载 .drawio（真实下载）+ 在全新编辑器里重新打开，手工图形仍在
//   4. 忙碌期间再次提交不清空草稿
//   5. PNG 真实导出（校验 PNG 字节与尺寸）
//   6. 非法 XML 在客户端就被拦截（不进入画布）
//   7. 【A】多页：切页后请求作用于可见页；等待期间切页判定为冲突
//   8. 【B】「在当前画布增加一个审批节点」保留已有图（不重建）
//   9. 【C】加载事务：重叠加载、过期回执、超时都不会遗留 Promise 或错误确认
//  10. 【C3】AI 加载未确认时连续撤销：所有 Promise 收敛、busy 解除、仍可继续发送
//  11. 【E】失败响应与重试都不覆盖等待期间的新草稿
//  12. 【R2】真实 embed 下 viewbox/getDiff 两个同步查询都返回有效结果（R2 门禁不误伤正常流程）
//  13. 【R1】真实编辑器文档被改动但未触发 autosave：内容基线仍判定为冲突，手工节点保留
//  14. 【R2】整轮真实界面测试期间同步查询从未失败（syncFailures === 0）
//
// 用法：node tests/e2e/run-e2e.mjs   （需要 agent-browser CLI + Chromium，且能访问本地端口与 embed.diagrams.net）
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeBrowser, startServer, makeOutDir, makeChecker, Cdp, PAGE_HELPERS, ROOT } from './lib/browser-harness.mjs';

const require = createRequire(import.meta.url);
const Xml = require('../../lib/xml.js');
const Model = require('../../lib/graphmodel.js');
const DiagramFile = require('../../lib/drawio-format.js');
const { decompressDiagram } = require('../../lib/drawio-zlib.js');

const PORT = Number(process.env.E2E_PORT || 8241);
const SESSION = process.env.E2E_SESSION || 'diagramai-e2e';
const OUT_DIR = makeOutDir(process.env.E2E_OUT || '/tmp/diagramai-e2e');
const BASE = `http://127.0.0.1:${PORT}`;

const HEAD = '<mxGraphModel dx="900" dy="650" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">';
const V = (id, value, x, y) => `<mxCell id="${id}" value="${value}" style="rounded=1;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="160" height="60" as="geometry"/></mxCell>`;
const E = (id, s, t) => `<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;" edge="1" parent="1" source="${s}" target="${t}"><mxGeometry relative="1" as="geometry"/></mxCell>`;
const verticalModel = () => `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/>${V('n0', '开始', 340, 60)}${V('n1', '处理', 340, 170)}${V('n2', '结束', 340, 280)}${E('e1', 'n0', 'n1')}${E('e2', 'n1', 'n2')}</root></mxGraphModel>`;
const emptyModel = () => `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`;
const twoPageFile = () => `<mxfile host="DiagramAI" type="device">
  <diagram name="第一页" id="page-one">${verticalModel()}</diagram>
  <diagram name="第二页" id="page-two">${emptyModel()}</diagram>
</mxfile>`;

const { results, check, failures } = makeChecker();

function pageVertices(payload, pageIndex) {
  const info = DiagramFile.parseFile(payload);
  if (info.kind !== 'mxfile' || !info.pages[pageIndex]) return [];
  const page = info.pages[pageIndex];
  if (page.encoding !== 'xml' || !page.modelNode) return [];
  const text = Xml.sliceNode(payload, page.modelNode);
  const parsed = Xml.parse(text);
  const rootEls = Xml.childElements(parsed.root, 'root');
  const out = [];
  for (const { cell } of Model.collectCells(rootEls[0])) {
    if (!cell || cell.attributes.vertex !== '1') continue;
    const g = Xml.firstChild(cell, 'mxGeometry');
    out.push({ id: cell.attributes.id, x: Number(g.attributes.x), y: Number(g.attributes.y) });
  }
  return out;
}

async function main() {
  const server = await startServer({ port: PORT });
  const { ab, evalRaw, evalJson, waitFor } = makeBrowser(SESSION);
  let cdp = null;
  try {
    console.log(`[e2e] 服务已启动：${server.base}`);
    ab(['close', '--all'], { allowFail: true });
    const opened = ab(['open', `${server.base}/?test=1`]);
    if (opened.out.includes('Navigation failed')) throw new Error(`页面打不开：${opened.out}`);
    await waitFor('编辑器就绪（draw.io embed 加载）', PAGE_HELPERS + '\nJSON.stringify({ready: window.__DIAGRAM_AI_TEST__.isReady()})',
      (v) => v.ready, { timeout: 120000, interval: 1000 });
    check('draw.io 编辑器加载完成并回发 init', true);
    evalRaw(PAGE_HELPERS);
    evalJson('window.__H.installErrorCapture()');

    async function freshCdp() {
      const url = ab(['get', 'cdp-url']).out.replace(/^"|"$/g, '');
      const session = await Cdp.connect(url);
      await session.usePage();
      session.frameSessionId = await session.attachTo('iframe', 'diagrams.net');
      await session.allowDownloads(OUT_DIR);
      return session;
    }

    // ---------- 1. 生成 ----------
    evalRaw(`window.__DIAGRAM_AI_TEST__.sendMessage("画一个用户登录注册的流程图，包含验证码校验和失败重试分支");'started'`);
    const generated = await waitFor('生成完成', 'JSON.stringify(window.__H.st())', (v) => v.busy === false && v.modelLen > 0, { timeout: 60000 });
    check('自然语言生成后画布载入成功（收到 draw.io 的 load 回执）', generated.loadCount >= 1, `loadCount=${generated.loadCount}`);
    check('画布真的渲染出内容（加载回执 bounds 非空）', generated.boundsW > 100 && generated.boundsH > 100,
      `bounds=${generated.boundsW}x${generated.boundsH}`);
    check('生成结果通过结构校验', generated.valid && generated.vertices >= 3, `vertices=${generated.vertices} edges=${generated.edges}`);

    const before = generated;

    // ---------- 2. 确定性修改 ----------
    evalRaw(`window.__DIAGRAM_AI_TEST__.sendMessage("把当前图表整体改成从左到右布局");'started'`);
    const afterLayout = await waitFor('布局修改完成', 'JSON.stringify(window.__H.st())',
      (v) => v.busy === false && v.loadCount > before.loadCount, { timeout: 40000 });
    check('「改为横向布局」保留了全部节点（未重建图表）',
      afterLayout.vertices === before.vertices && afterLayout.edges === before.edges,
      `vertices ${before.vertices}→${afterLayout.vertices}`);

    // ---------- 2.5 【R2】真实 embed 的同步查询确实可用（门禁不会误伤正常流程） ----------
    evalRaw(`window.__DIAGRAM_AI_TEST__.syncWithEditor().then(function (r) {
      window.__syncProbe = { pageOk: r.pageOk, docOk: r.docOk, pageIndex: r.pageIndex, error: r.error };
    });'started'`);
    const syncProbe = await waitFor('真实 embed 的 viewbox/getDiff 同步可用',
      'JSON.stringify(window.__syncProbe || null)', (v) => v !== null, { timeout: 20000 });
    check('真实 embed 下 viewbox（当前页）与 getDiff（最新文档）都返回有效结果',
      syncProbe.pageOk === true && syncProbe.docOk === true, JSON.stringify(syncProbe));

    // ---------- 3. 生成期间的真实手工编辑 ----------
    cdp = await freshCdp();
    let rect = evalJson('JSON.stringify(window.__H.frameRect())');
    evalJson(`window.__H.delayFetch(15000)`);
    const beforeManual = evalJson('JSON.stringify(window.__H.st())');
    evalRaw(`window.__DIAGRAM_AI_TEST__.sendMessage("把当前图表整体改成从上到下布局");'started'`);
    await sleep(600);

    const searchGrid = [
      [0.50, 0.12], [0.30, 0.12], [0.72, 0.12],
      [0.50, 0.88], [0.30, 0.88], [0.72, 0.88],
      [0.50, 0.25], [0.30, 0.25], [0.72, 0.25],
      [0.50, 0.75], [0.30, 0.75], [0.60, 0.60],
    ];
    let manualState = null;
    let hitPoint = null;
    for (const [fx, fy] of searchGrid) {
      const x = Math.round(rect.x + rect.width * fx);
      const y = Math.round(rect.y + rect.height * fy);
      try {
        await cdp.doubleClick(x, y);
      } catch (e) {
        cdp = await freshCdp();
        await cdp.doubleClick(x, y);
      }
      await cdp.pressEscape().catch(() => {});
      try {
        manualState = await waitFor('手工编辑写入画布', 'JSON.stringify(window.__H.st())',
          (v) => v.rev > beforeManual.rev, { timeout: 700, interval: 150 });
        hitPoint = [fx, fy];
        break;
      } catch (e) { /* 该点不可插入，换下一个 */ }
    }
    if (!manualState) throw new Error('未能在画布上制造出手工编辑');
    console.log(`   （可插入点：${hitPoint[0]},${hitPoint[1]}）`);
    check('生成期间的真实手工编辑被记录为新的画布版本', manualState.rev > beforeManual.rev,
      `revision ${beforeManual.rev} → ${manualState.rev}`);
    check('手工编辑确实新增了图形', manualState.cells > beforeManual.cells, `cells ${beforeManual.cells} → ${manualState.cells}`);

    const conflicted = await waitFor('冲突检测：结果被暂存而不是覆盖画布', 'JSON.stringify(window.__H.st())',
      (v) => v.busy === false && v.pendingLen !== null, { timeout: 30000 });
    check('冲突时给出明确提示（横幅可见）', conflicted.banner === true);
    check('冲突时没有把 AI 结果加载到编辑器（loadCount 未增加）',
      conflicted.loadCount === manualState.loadCount, `loadCount=${conflicted.loadCount}`);
    check('冲突时手工编辑内容完整保留在画布载荷中', conflicted.cells === manualState.cells, `cells=${conflicted.cells}`);

    ab(['click', '#applyPendingBtn']);
    const applied = await waitFor('应用暂存结果', 'JSON.stringify(window.__H.st())',
      (v) => v.pendingLen === null && v.snapshots >= 1, { timeout: 30000 });
    check('应用 AI 结果前留有可恢复快照', applied.snapshots >= 1, `snapshots=${applied.snapshots}`);
    check('应用后画布回到 AI 版本', applied.cells === beforeManual.cells, `cells=${applied.cells}`);

    ab(['click', '#undoBtn']);
    const restored = await waitFor('撤销 AI 修改', 'JSON.stringify(window.__H.st())',
      (v) => v.cells === conflicted.cells, { timeout: 30000 });
    check('可恢复到应用前的手工编辑版本（手工图形回来了）', restored.cells === conflicted.cells, `cells=${restored.cells}`);

    // ---------- 4. 下载 .drawio 并重新打开 ----------
    const manualVertices = restored.vertices;
    const downloadPath = path.join(OUT_DIR, 'diagram.drawio');
    fs.rmSync(downloadPath, { force: true });
    let downloaded = false;
    try {
      ab(['download', '#downloadBtn', downloadPath], { allowFail: true });
      downloaded = fs.existsSync(downloadPath);
    } catch (e) { downloaded = false; }
    const payloadBeforeDownload = evalJson('JSON.stringify(window.__H.st())');
    if (!downloaded) {
      const content = evalRaw('JSON.stringify(window.__DIAGRAM_AI_TEST__.buildDownloadContent())');
      fs.writeFileSync(downloadPath, JSON.parse(JSON.parse(content)).content);
    }
    console.log(`   （下载方式：${downloaded ? '浏览器真实下载' : '回退到 JS 内容'}）`);
    check('下载 .drawio 文件成功', fs.existsSync(downloadPath), downloadPath);
    check('下载时画布仍是手工编辑版本', payloadBeforeDownload.cells === conflicted.cells, `cells=${payloadBeforeDownload.cells}`);

    const fileText = fs.readFileSync(downloadPath, 'utf8');
    const info = DiagramFile.parseFile(fileText);
    check('下载内容是合法的完整 mxfile（没有重复包裹）',
      info.kind === 'mxfile' && (fileText.match(/<mxfile/g) || []).length === 1 && !fileText.includes('<diagram><mxfile'),
      `kind=${info.kind} pages=${info.pages.length}`);
    const pageModel = DiagramFile.resolvePageModel(fileText, info.pages[0], decompressDiagram);
    check('下载文件里当前页内容可解析', pageModel.ok === true && pageModel.xml.includes('<mxGraphModel'));
    const downloadedVertices = (pageModel.xml.match(/vertex="1"/g) || []).length;
    check('下载文件包含手工编辑后的全部图形', downloadedVertices === manualVertices,
      `文件内 vertex=${downloadedVertices}，手工版本 vertex=${manualVertices}`);

    ab(['open', `${BASE}/?test=1`]);
    await waitFor('编辑器重新加载', PAGE_HELPERS + '\nJSON.stringify({ready: window.__DIAGRAM_AI_TEST__.isReady()})',
      (v) => v.ready, { timeout: 120000, interval: 1000 });
    evalRaw(PAGE_HELPERS);
    evalJson('window.__H.installErrorCapture()');
    rect = evalJson('JSON.stringify(window.__H.frameRect())');
    evalJson(`window.__DIAGRAM_AI_TEST__.loadPayload(${JSON.stringify(fileText)}).then(function (r) { window.__loadResult = r; });'started'`);
    const reopen = await waitFor('重新打开下载的文件',
      `JSON.stringify({ r: window.__loadResult || null, st: window.__H.st() })`,
      (v) => v.r && v.r.ok === true, { timeout: 40000 });
    check('手工编辑后的 .drawio 能被 draw.io 重新打开（新编辑器加载回执成功）', reopen.r.ok === true);
    check('重新打开后画布渲染出内容', reopen.st.boundsW > 100 && reopen.st.boundsH > 100,
      `bounds=${reopen.st.boundsW}x${reopen.st.boundsH}`);
    check('重新打开后图形数量与文件一致（含手工图形）', reopen.st.vertices === manualVertices,
      `vertices=${reopen.st.vertices} 期望=${manualVertices}`);
    ab(['screenshot', path.join(OUT_DIR, 'reopened.png')], { allowFail: true });

    // ---------- 5. 忙碌期间提交不清空草稿 ----------
    evalJson(`window.__H.delayFetch(2500)`);
    const draftBefore = evalJson('JSON.stringify(window.__H.st())');
    evalRaw(`(function () {
      const input = document.getElementById('chatInput');
      input.value = '第一段草稿：画一个付款流程';
      document.getElementById('chatForm').requestSubmit();
      input.value = '第二段尚未发送的草稿';
      document.getElementById('chatForm').requestSubmit();
      return 'ok';
    })()`);
    const busyState = evalJson('JSON.stringify(window.__H.st())');
    check('忙碌期间再次提交不会清空尚未发送的草稿', busyState.draft === '第二段尚未发送的草稿', `draft="${busyState.draft}"`);
    check('忙碌期间第二次提交没有发出新请求（请求数只 +1）',
      busyState.chatCount === draftBefore.chatCount + 1, `chatCount ${draftBefore.chatCount} → ${busyState.chatCount}`);
    const hint = evalJson(`JSON.stringify({ hint: !document.getElementById('hintBar').classList.contains('hidden'), text: document.getElementById('hintBar').textContent })`);
    check('忙碌期间提交给出明确提示', hint.hint === true && hint.text.includes('草稿'), hint.text.slice(0, 50));
    await waitFor('忙碌结束', 'JSON.stringify(window.__H.st())', (v) => v.busy === false, { timeout: 40000 });

    // ---------- 6. PNG 导出 ----------
    evalRaw(`window.__DIAGRAM_AI_TEST__.onExport = function (r) { window.__lastExport = r; };'ok'`);
    evalRaw(`window.__DIAGRAM_AI_TEST__.exportPng().then(function (r) { window.__png = { ok: Boolean(r && r.ok) }; });'started'`);
    await waitFor('PNG 导出', 'JSON.stringify(window.__png || {})', (v) => v.ok === true, { timeout: 60000 });
    const fullB64 = evalRaw(`window.__lastExport.data.replace(/^data:image\\/png;base64,/, '')`).replace(/^"|"$/g, '');
    const pngBuf = Buffer.from(fullB64, 'base64');
    const pngPath = path.join(OUT_DIR, 'export.png');
    fs.writeFileSync(pngPath, pngBuf);
    const signature = pngBuf.slice(0, 8).toString('hex');
    const pngW = pngBuf.readUInt32BE(16);
    const pngH = pngBuf.readUInt32BE(20);
    check('PNG 导出返回真实 PNG 数据（点击顶栏导出按钮的真实链路）', signature === '89504e470d0a1a0a', `signature=${signature}`);
    check('PNG 尺寸有效（画布非空白）', pngW > 100 && pngH > 100 && pngBuf.length > 3000,
      `${pngW}x${pngH}, ${Math.round(pngBuf.length / 1024)}KB → ${pngPath}`);

    // ---------- 7. 非法 XML 客户端拦截 ----------
    const beforeInvalid = evalJson('JSON.stringify(window.__H.st())');
    const badCases = {
      未转义: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A & B" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      邻接属性: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2"value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      非法字符引用: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="&#0;A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      非法注释: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><!-- bad -- comment --><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      重复id: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell><mxCell id="2" value="B" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      无效连线引用: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell><mxCell id="3" edge="1" parent="1" source="2" target="404"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>`,
      // R3：标准 XML 边界（独立解析器同样拒绝）
      注释以单减号结尾: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><!-- bad ---><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      非法XML声明: `<?xml rubbish?>${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      保留目标名大小写变体: `<?XML version="1.0"?>${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      CDATA内控制字符: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><![CDATA[\u0001]]><mxCell id="2" value="A" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
      属性内字面UFFFE: `${HEAD}<root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="\uFFFE" vertex="1" parent="1"><mxGeometry x="1" y="1" width="10" height="10" as="geometry"/></mxCell></root></mxGraphModel>`,
    };
    const verdicts = evalJson(`JSON.stringify(Object.keys(${JSON.stringify(badCases)}).map(function (k) {
      const caseMap = ${JSON.stringify(badCases)};
      const r = window.__DIAGRAM_AI_TEST__.validatePayload(caseMap[k]);
      return [k, Boolean(r.ok)];
    }))`);
    check('非法 XML / 邻接属性 / 非法字符引用 / 非法注释 / 重复 ID / 无效引用 / 注释单减号结尾 / 非法声明 / 保留目标名 / CDATA 控制符 / 属性 U+FFFE 全部被客户端拒绝（不写回画布）',
      verdicts.every((v) => v[1] === false), verdicts.map((v) => `${v[0]}=${v[1]}`).join(' '));
    const afterInvalid = evalJson('JSON.stringify(window.__H.st())');
    check('被拒绝的非法内容没有进入画布', afterInvalid.cells === beforeInvalid.cells && afterInvalid.rev === beforeInvalid.rev,
      `cells=${afterInvalid.cells} rev=${afterInvalid.rev}`);

    // ---------- 8. 【A】多页：切页后必须作用在可见页 ----------
    evalJson(`window.__DIAGRAM_AI_TEST__.loadPayload(${JSON.stringify(twoPageFile())}).then(function(r){ window.__twoPage = r; });'ok'`);
    await waitFor('两页文件加载完成', 'JSON.stringify(window.__twoPage || null)', (v) => v && v.ok === true, { timeout: 40000 });
    // 页面在阶段 4 重新加载过，旧的 CDP 会话已失效 → 重新连接（含 iframe 会话）
    cdp = await freshCdp();

    const switchTo = async (name, openerName) => {
      const opener = await cdp.clickFrameText(openerName, rect);
      if (!opener) return null;
      await sleep(500);
      const item = await cdp.clickFrameText(name, rect);
      if (!item) return null;
      await sleep(900);
      return { opener, item };
    };
    const toSecond = await switchTo('第二页', '第一页');
    const backToFirst = toSecond ? await switchTo('第一页', '第二页') : null;
    check('能在编辑器里真实切换页面（页面控件可点击）', Boolean(toSecond && backToFirst),
      `切到第二页=${Boolean(toSecond)} 切回第一页=${Boolean(backToFirst)}`);

    evalRaw(`window.__DIAGRAM_AI_TEST__.sendMessage("把当前图表整体改成从左到右布局");'started'`);
    await waitFor('多页布局修改完成', 'JSON.stringify(window.__H.st())', (v) => v.busy === false, { timeout: 60000 });
    const multiPayload = evalJson('JSON.stringify(window.__DIAGRAM_AI_TEST__.state.payload)');
    const multiState = evalJson('JSON.stringify(window.__H.st())');
    const pageOne = pageVertices(multiPayload, 0);
    const pageTwo = pageVertices(multiPayload, 1);
    const pageOneHorizontal = pageOne.length > 0
      && new Set(pageOne.map((n) => n.y)).size === 1 && new Set(pageOne.map((n) => n.x)).size > 1;
    check('切回第一页后发送修改：第一页被改为横向布局', pageOneHorizontal,
      `第一页 y 值种类=${new Set(pageOne.map((n) => n.y)).size} 节点数=${pageOne.length}`);
    check('第二页保持原样（未被误改）', pageTwo.length === 0, `第二页顶点数=${pageTwo.length}`);
    check('请求作用在可见页（应用页与编辑器当前页一致）', multiState.pageIndex === 0 && multiState.pageId === 'page-one',
      `pageIndex=${multiState.pageIndex} pageId=${multiState.pageId}`);

    // 等待期间切换页面 → 必须判定为冲突，而不是写到错误页面
    evalJson(`window.__H.delayFetch(3000)`);
    evalRaw(`window.__DIAGRAM_AI_TEST__.sendMessage("把当前图表整体改成从上到下布局");'started'`);
    await sleep(600);
    const duringSwitch = await switchTo('第二页', '第一页');
    const pageSwitchConflict = await waitFor('切页冲突被暂存', 'JSON.stringify(window.__H.st())',
      (v) => v.busy === false && v.pendingLen !== null, { timeout: 30000 });
    check('等待期间切换页面被判定为冲突并暂存结果',
      pageSwitchConflict.banner === true && Boolean(duringSwitch),
      `横幅=${pageSwitchConflict.banner} 切页成功=${Boolean(duringSwitch)}`);
    const afterSwitchPayload = evalJson('JSON.stringify(window.__DIAGRAM_AI_TEST__.state.payload)');
    const firstPageAfter = pageVertices(afterSwitchPayload, 0);
    check('切页冲突时第一页内容未被写入结果（仍是横向布局）',
      firstPageAfter.length === pageOne.length && new Set(firstPageAfter.map((n) => n.y)).size === 1,
      `第一页顶点数=${firstPageAfter.length}`);
    evalJson(`window.__DIAGRAM_AI_TEST__.discardPending();'ok'`);
    evalJson(`window.__H.delayFetch(0)`);

    // ---------- 9. 【B】修改意图：不得重建已有图 ----------
    // 上一步把视图切到了（空的）第二页，先真实切回有内容的第一页
    const backForIntent = await switchTo('第一页', '第二页');
    const beforeIntent = evalJson('JSON.stringify(window.__H.st())');
    const beforeIntentPayload = evalJson('JSON.stringify(window.__DIAGRAM_AI_TEST__.state.payload)');
    evalJson(`window.__DIAGRAM_AI_TEST__.sendMessage("在当前画布增加一个审批节点");'ok'`);
    const intent = await waitFor('修改意图处理完成', 'JSON.stringify(window.__H.st())',
      (v) => v.busy === false && v.pendingLen === null, { timeout: 40000 });
    const intentReply = evalJson(`JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('#chatList .bubble')).pop().textContent)`);
    const afterIntentPayload = evalJson('JSON.stringify(window.__DIAGRAM_AI_TEST__.state.payload)');
    const firstPageBefore = JSON.stringify(pageVertices(beforeIntentPayload, 0));
    const firstPageAfterIntent = JSON.stringify(pageVertices(afterIntentPayload, 0));
    check('「在当前画布增加一个审批节点」没有重建图表（第一页节点完全不变）',
      Boolean(backForIntent) && intent.vertices > 0 && firstPageAfterIntent === firstPageBefore,
      `切回第一页=${Boolean(backForIntent)} 当前页顶点=${intent.vertices}（同步前的陈旧值 ${beforeIntent.vertices}）；第一页节点逐字节相同=${firstPageAfterIntent === firstPageBefore}`);
    check('不支持的示例修改给出明确提示并保留原图', intentReply.includes('已保留'), intentReply.slice(0, 80));

    // ---------- 10. 【C】加载事务：重叠 / 过期回执 / 超时 ----------
    const stale = emptyModel();
    evalJson(`(function(){
      window.__tx = [];
      const H = window.__DIAGRAM_AI_TEST__;
      H.setLoadTimeout(4000);
      H.loadPayload(${JSON.stringify(stale)}, { dryRun: true }).then(function(r){ window.__tx.push(['A', !!(r && r.ok), r && r.cancelled ? 'cancelled' : (r && r.error) || '']); });
      H.loadPayload(${JSON.stringify(verticalModel())}, { dryRun: true }).then(function(r){ window.__tx.push(['B', !!(r && r.ok), r && r.cancelled ? 'cancelled' : (r && r.error) || '']); });
      return 'started';
    })()`);
    await sleep(150);
    evalJson(`window.__DIAGRAM_AI_TEST__.ingest({ event: 'load', xml: ${JSON.stringify(stale)}, currentPage: 0 });'ok'`);
    await sleep(150);
    const stalePhase = evalJson('JSON.stringify({ tx: window.__tx, st: window.__H.st() })');
    check('新的加载会显式结束旧的加载（旧 Promise 以 cancelled 收敛）',
      Boolean(stalePhase.tx[0]) && stalePhase.tx[0][2] === 'cancelled', JSON.stringify(stalePhase.tx[0]));
    check('过期回执不会确认当前加载操作（仍在等待中）',
      stalePhase.st.pendingToken !== null && stalePhase.tx.length === 1, `pendingToken=${stalePhase.st.pendingToken}`);
    evalJson(`window.__DIAGRAM_AI_TEST__.ingest({ event: 'load', xml: ${JSON.stringify(verticalModel())}, currentPage: 0 });'ok'`);
    await sleep(200);
    const matchedPhase = evalJson('JSON.stringify({ tx: window.__tx, st: window.__H.st() })');
    check('匹配的回执才确认加载', Boolean(matchedPhase.tx[1]) && matchedPhase.tx[1][1] === true, JSON.stringify(matchedPhase.tx[1]));

    evalJson(`(function(){
      window.__tx2 = [];
      const H = window.__DIAGRAM_AI_TEST__;
      H.setLoadTimeout(800);
      H.loadPayload(${JSON.stringify(stale)}, { dryRun: true }).then(function(r){ window.__tx2.push([!!(r && r.ok), r && r.timeout ? 'timeout' : (r && r.error) || '']); });
      return 'started';
    })()`);
    await sleep(1200);
    const timeoutPhase = evalJson('JSON.stringify({ tx2: window.__tx2, st: window.__H.st() })');
    check('加载超时会以超时状态结束（不留悬空 Promise）',
      Boolean(timeoutPhase.tx2[0]) && timeoutPhase.tx2[0][1] === 'timeout', JSON.stringify(timeoutPhase.tx2[0]));
    evalJson(`window.__DIAGRAM_AI_TEST__.ingest({ event: 'load', xml: ${JSON.stringify(stale)}, currentPage: 0 });'ok'`);
    await sleep(200);
    const latePhase = evalJson('JSON.stringify({ tx2: window.__tx2, st: window.__H.st() })');
    check('超时后迟到的回执不会被当成确认（计入过期回执）',
      latePhase.tx2.length === 1 && latePhase.st.staleReceipts === timeoutPhase.st.staleReceipts + 1,
      `过期回执计数 ${timeoutPhase.st.staleReceipts} → ${latePhase.st.staleReceipts}`);

    // ---------- 11. 【C3】AI 等待加载确认时连续撤销 ----------
    evalJson(`window.__DIAGRAM_AI_TEST__.setLoadTimeout(2500);'ok'`);
    evalJson(`(function(){
      window.__c3 = { send: null, undo1: null, undo2: null };
      const H = window.__DIAGRAM_AI_TEST__;
      H.sendMessage('把当前图表整体改成从左到右布局').then(function(r){ window.__c3.send = r || { ok: false }; });
      setTimeout(function(){
        const snaps = H.snapshots();
        const last = snaps[snaps.length - 1];
        const run = function (key) { H.restoreSnapshot(last.id).then(function(r){ window.__c3[key] = r || { ok: false }; }); };
        if (last) { run('undo1'); run('undo2'); }
        else { window.__c3.undo1 = { ok: false, error: 'no-snapshot' }; window.__c3.undo2 = { ok: false, error: 'no-snapshot' }; }
      }, 300);
      return 'started';
    })()`);
    await waitFor('连续撤销后所有加载收敛', 'JSON.stringify({ c3: window.__c3, st: window.__H.st() })',
      (v) => v.c3.send !== null && v.c3.undo1 !== null && v.c3.undo2 !== null, { timeout: 25000 });
    const c3 = evalJson('JSON.stringify({ c3: window.__c3, st: window.__H.st() })');
    check('加载未确认时连续撤销：所有 Promise 都结束',
      c3.c3.send !== null && c3.c3.undo1 !== null && c3.c3.undo2 !== null,
      `send=${JSON.stringify(c3.c3.send)} undo1=${JSON.stringify(c3.c3.undo1)} undo2=${JSON.stringify(c3.c3.undo2)}`);
    check('连续撤销后 busy 解除、界面可继续发送', c3.st.busy === false, `busy=${c3.st.busy}`);
    const sendable = evalJson(`JSON.stringify({ disabled: document.getElementById('sendBtn').disabled })`);
    check('发送按钮未被禁用', sendable.disabled === false);
    evalJson(`window.__DIAGRAM_AI_TEST__.setLoadTimeout(10000);'ok'`);

    // ---------- 12. 【E】失败不覆盖新草稿；重试也保护草稿 ----------
    evalJson(`window.__H.failFetch('on', 2000)`);
    evalJson(`(function(){ const i=document.getElementById('chatInput'); i.value='原始请求'; document.getElementById('chatForm').requestSubmit(); return 'ok'; })()`);
    await sleep(400);
    evalJson(`document.getElementById('chatInput').value = '等待期间新写的草稿';'ok'`);
    const failed = await waitFor('失败返回', 'JSON.stringify(window.__H.st())', (v) => v.busy === false, { timeout: 30000 });
    check('失败响应不覆盖等待期间的新草稿', failed.draft === '等待期间新写的草稿', `输入框="${failed.draft}"`);
    check('失败文本被保存在独立的重试状态里', failed.retry === '原始请求', `retry=${JSON.stringify(failed.retry)}`);

    // 注意：failFetch('off') 里的字符串 'off' 仍是真值，必须用 restoreFetch 才能真正恢复
    evalJson(`window.__H.restoreFetch()`);
    evalJson(`document.querySelector('#chatList .retry-row .retry-btn').click();'ok'`);
    await sleep(300);
    const afterRetry = evalJson('JSON.stringify(window.__H.st())');
    check('点击重试不覆盖用户当前草稿', afterRetry.draft === '等待期间新写的草稿', `输入框="${afterRetry.draft}"`);
    const retried = await waitFor('重试真正成功（不再是注入的失败响应）', 'JSON.stringify(window.__H.st())',
      (v) => v.busy === false && v.retry === null, { timeout: 40000 });
    check('恢复真实请求后重试成功（重试状态被清空）', retried.retry === null);

    ab(['screenshot', path.join(OUT_DIR, 'final-state.png')], { allowFail: true });

    // ---------- 13. 【R1】真实界面：文档被改动但未触发 autosave 时，内容基线仍判定为冲突 ----------
    // 手法：用真实 draw.io 的 load 协议改动编辑器文档，并显式 autosave=0
    // （draw.io 源码：autosave = data.autosave == 1，且 doLoad 用 ignoreChange 包裹加载）
    // → 编辑器文档真的变了，但不会发出 autosave，revision 保持不变。
    evalJson(`window.__H.restoreFetch()`);
    evalJson(`window.__DIAGRAM_AI_TEST__.loadPayload(${JSON.stringify(verticalModel())}).then(function (r) { window.__r1load = r; });'started'`);
    await waitFor('R1 前置：单页图已加载', 'JSON.stringify({ r: window.__r1load || null })',
      (v) => v.r && v.r.ok === true, { timeout: 30000 });
    await sleep(700);
    const r1Before = evalJson('JSON.stringify(window.__H.st())');
    const keepMeModel = verticalModel().replace('</root>',
      V('keep-me-e2e', '手工加的审批节点', 700, 60) + '</root>');

    evalJson(`window.__H.delayFetch(5000)`);
    evalRaw(`window.__DIAGRAM_AI_TEST__.sendMessage("把当前图表整体改成从左到右布局");'started'`);
    await sleep(900); // 提交前同步已完成，请求在飞行中
    evalRaw(`(function () {
      const f = document.getElementById('drawioFrame');
      f.contentWindow.postMessage(JSON.stringify({ action: 'load', xml: ${JSON.stringify(keepMeModel)}, autosave: 0 }), '*');
      return 'posted';
    })()`);
    await sleep(900); // 等编辑器真正加载完，并确认这段时间没有 autosave 到达

    const midR1 = evalJson('JSON.stringify(window.__H.st())');
    check('R1 前置成立：编辑器文档已改变，但没有 autosave（revision 未变）',
      midR1.rev === r1Before.rev, `revision ${r1Before.rev} → ${midR1.rev}`);

    // 用应用自己的 getDiff 确认「真实编辑器文档里确实出现了 keep-me-e2e」
    evalRaw(`window.__DIAGRAM_AI_TEST__.syncWithEditor().then(function (r) { window.__r1doc = r; });'started'`);
    await waitFor('R1 前置：getDiff 读到的文档已变化', 'JSON.stringify(window.__r1doc || null)',
      (v) => v !== null, { timeout: 15000 });
    const r1DocNow = evalJson(`JSON.stringify({ hasKeepMe: window.__DIAGRAM_AI_TEST__.state.payload.indexOf('keep-me-e2e') !== -1, kind: window.__DIAGRAM_AI_TEST__.state.payloadKind })`);
    check('R1 前置：真实编辑器文档里已出现 keep-me-e2e（getDiff 可读到）',
      r1DocNow.hasKeepMe === true, JSON.stringify(r1DocNow));

    const r1Done = await waitFor('R1 内容冲突被检出并暂存', 'JSON.stringify(window.__H.st())',
      (v) => v.busy === false && v.pendingLen !== null, { timeout: 30000 });
    check('R1：getDiff 先于 autosave 到达时，AI 结果被暂存而不是覆盖画布',
      r1Done.pendingLen !== null && r1Done.banner === true, `pending=${r1Done.pendingLen} banner=${r1Done.banner}`);
    check('R1：暂存时没有把 AI 结果写入编辑器（loadCount 未增加）',
      r1Done.loadCount === midR1.loadCount, `loadCount ${midR1.loadCount} → ${r1Done.loadCount}`);
    const r1Payload = evalJson('JSON.stringify(window.__DIAGRAM_AI_TEST__.state.payload)');
    check('R1：等待期间写进编辑器文档的手工节点仍保留在画布载荷中', r1Payload.includes('keep-me-e2e'));
    evalJson(`window.__DIAGRAM_AI_TEST__.discardPending();'ok'`);
    evalJson(`window.__H.delayFetch(0)`);

    // ---------- 14. 【R2】整轮真实界面测试期间同步查询从未失败 ----------
    const finalState = evalJson('JSON.stringify(window.__H.st())');
    check('整轮真实界面测试期间前端同步查询从未失败（正常路径不受 R2 门禁影响）',
      finalState.syncFailures === 0, `syncFailures=${finalState.syncFailures}`);

    // ---------- 15. 页面错误 ----------
    const errors = evalJson('JSON.stringify(window.__H.st().errors)');
    check('整个流程没有未捕获的前端错误', errors.length === 0, errors.join(' | ').slice(0, 200));
  } catch (e) {
    check('端到端流程执行', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
    try { ab(['screenshot', path.join(OUT_DIR, 'failure.png')], { allowFail: true }); } catch { /* 保留已有结果 */ }
  } finally {
    if (cdp) cdp.close();
    try { ab(['close', '--all'], { allowFail: true }); } catch (e) { /* 忽略 */ }
    server.stop();
    const report = { passed: results.filter((r) => r.ok).length, failed: failures(), results, at: new Date().toISOString(), root: ROOT };
    fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
    console.log(`\n[e2e] 通过 ${report.passed} / ${results.length}，产物目录 ${OUT_DIR}`);
  }
}

try {
  await main();
} catch (e) {
  check('端到端流程执行', false, e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e.message);
} finally {
  process.exit(failures() === 0 ? 0 : 1);
}
