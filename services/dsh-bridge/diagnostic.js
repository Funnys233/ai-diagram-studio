'use strict';
// Diagnostic entry point: no DSH adapter, model requests or persistent jobs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const tokenFile = process.env.DSH_BRIDGE_TOKEN_FILE;
const portText = process.env.DSH_BRIDGE_PORT || '47318';
try {
  if (!path.isAbsolute(tokenFile || '') || !/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw Error('invalid configuration');
  const info = fs.lstatSync(tokenFile);
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw Error('invalid token file');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw Error('invalid token');
  const hash = value => crypto.createHash('sha256').update(value).digest();
  const expected = hash(`Bearer ${token}`);
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    req.resume();
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const authenticated = crypto.timingSafeEqual(hash(authorization), expected);
    let status = 404, body = { error: 'not found' };
    if (!authenticated) { status = 401; body = { error: 'unauthorized' }; }
    else if (!/^[a-zA-Z0-9_-]{1,64}$/.test(req.headers['x-site-owner'] || '')) { status = 400; body = { error: 'invalid owner' }; }
    else if (req.method === 'GET' && req.url === '/v1/health') { status = 200; body = { status: 'ready', mode: 'diagnostic', version: 1, jobsAvailable: false }; }
    else if (req.method === 'POST' && req.url === '/v1/jobs') { status = 503; body = { error: 'DSH adapter unavailable' }; }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(Number(portText), '127.0.0.1', () => console.log(`DSH bridge diagnostic listening on 127.0.0.1:${portText}; model jobs disabled`));
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; server.close(() => { process.exitCode = 0; }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  server.on('error', () => { console.error('DSH bridge could not listen'); process.exitCode = 1; });
} catch (_) { console.error('DSH bridge configuration is invalid'); process.exitCode = 1; }
