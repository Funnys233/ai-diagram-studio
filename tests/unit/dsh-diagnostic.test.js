'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

test('diagnostic bridge requires authentication and never runs jobs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-diagnostic-'));
  const file = path.join(dir, 'token');
  const token = crypto.randomBytes(32).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  const port = 49000 + crypto.randomInt(10000);
  const child = spawn(process.execPath, [path.join(__dirname, '../../services/dsh-bridge/diagnostic.js')], {
    env: { ...process.env, DSH_BRIDGE_TOKEN_FILE: file, DSH_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('diagnostic startup timed out')), 5000);
      child.stdout.once('data', () => { clearTimeout(timer); resolve(); });
      child.once('exit', code => { clearTimeout(timer); reject(Error(`diagnostic exited: ${code}`)); });
      child.once('error', reject);
    });
    const request = (method, endpoint, headers = {}) => new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method, path: endpoint, headers }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      });
      req.on('error', reject); req.end();
    });
    const auth = { authorization: `Bearer ${token}`, 'x-site-owner': 'diagnostic' };
    assert.equal((await request('GET', '/v1/health')).status, 401);
    assert.equal((await request('GET', '/v1/health', { ...auth, authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await request('GET', '/v1/health', { authorization: auth.authorization })).status, 400);
    assert.deepEqual((await request('GET', '/v1/health', auth)).body, { status: 'ready', mode: 'diagnostic', version: 1, jobsAvailable: false });
    assert.equal((await request('POST', '/v1/jobs', auth)).status, 503);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
