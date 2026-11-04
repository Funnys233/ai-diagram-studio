#!/usr/bin/env node
'use strict';
// Dedicated local OAuth session for one VM. Never reads an existing token store.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { ChatGPTLocal } = require('../lib/chatgpt-local');
async function authorize({ hostId, out, request, onReady = data => console.log(JSON.stringify(data)) }) {
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hostId || '')) throw Error('需要服务器专属 hostId。');
  if (!out || fs.existsSync(out)) throw Error('请选择尚不存在的授权输出文件。');
  const target = path.resolve(out), parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  if ((fs.statSync(parent).mode & 0o077)) throw Error('授权输出目录权限必须为 700。');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-vm-oauth-'));
  fs.chmodSync(temporary, 0o700);
  const runtime = new ChatGPTLocal({ filePath: path.join(temporary, 'session.json'), ...(request ? { request } : {}) });
  runtime.data.hostId = hostId; runtime.loaded = true;
  let timer, completing = false, cancelled = false, callbackDone, settle;
  const completed = new Promise(resolve => { settle = resolve; });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const expected = `127.0.0.1:${server.address().port}`;
    if (req.headers.host !== expected || req.headers.origin && req.headers.origin !== `http://${expected}`) { res.writeHead(403); return res.end('Forbidden'); }
    const url = new URL(req.url, `http://${expected}`);
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404); return res.end('Not found'); }
    if (completing) { res.writeHead(409); return res.end('Authorization already processing'); }
    completing = true;
    let finishCallback;
    callbackDone = new Promise(resolve => { finishCallback = resolve; });
    try {
      await runtime.callback(url);
      if (cancelled) throw Error('Cancelled');
      const account = runtime.account();
      if (!account?.scopes?.includes('chatgpt.tokens.use.direct') || !account.refreshToken) throw Error('No subscription grant');
      fs.writeFileSync(target, JSON.stringify({ format: 'diagram-chatgpt-vm-v1', hostId, account }), { mode: 0o600, flag: 'wx' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>服务器授权已准备</title><body><h2>服务器授权已准备</h2><p>可以关闭此窗口。导入服务器后，绘图和对话即可使用此连接。</p></body></html>');
      settle(true);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('授权未完成。请回到本机工具重新开始；原有连接不受影响。');
      settle(false);
    } finally { finishCallback(); }
  });
  const cancel = () => { cancelled = true; settle(false); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const { authorizationUrl } = runtime.start(server.address().port);
    onReady({ authorizationUrl, hostId }); // Public OAuth URL only; never tokens.
    timer = setTimeout(cancel, 600000);
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    const success = await completed;
    if (!success) throw Error('授权取消、超时或校验失败，请重新开始。');
    return { ready: true, file: target };
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    await callbackDone;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
    runtime.data.accounts = []; // This helper never performs token refreshes.
  }
}
if (require.main === module) {
  const args = process.argv.slice(2), value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  authorize({ hostId: value('--host-id'), out: value('--out') }).then(result => console.log(JSON.stringify(result))).catch(() => { console.error('本机授权未完成。请检查 hostId、私有输出目录和官方授权页面，重新运行。'); process.exitCode = 1; });
}
module.exports = { authorize };
