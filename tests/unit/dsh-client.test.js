'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { DshClient } = require('../../lib/dsh-client');
const crypto = require('node:crypto');
test('bridge client pins a loopback destination, protects the token and sanitizes upstream errors', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-')), tokenFile = path.join(dir, 'token'), token = 'b'.repeat(64); fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  let mode = 'healthy'; const gateway = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + token); assert.equal(req.headers['x-site-owner'], 'owner'); req.resume();
    if (mode === 'stalled') return;
    if (mode === 'error') { res.writeHead(500); return res.end(JSON.stringify({ error: token + ' private-path' })); }
    if (mode === 'invalid') return res.end('{invalid');
    if (mode === 'wrong-job') return res.end(JSON.stringify({ id: 'another', conversationId: 'c', status: 'running', output: '' }));
    res.end(JSON.stringify({ status: 'ready', version: 1, mode: 'diagnostic', jobsAvailable: false }));
  }); await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = new DshClient({ url: 'http://127.0.0.1:' + gateway.address().port, tokenFile, timeoutMs: 80 });
  for (const url of ['http://evil.example', 'https://127.0.0.1', 'http://127.0.0.1/api', 'http://u:p@127.0.0.1']) assert.throws(() => new DshClient({ url, tokenFile }));
  assert.equal((await client.health('owner')).jobsAvailable, false);
  mode = 'error'; await assert.rejects(client.health('owner'), error => !error.message.includes(token) && !error.message.includes('private-path'));
  mode = 'invalid'; await assert.rejects(client.health('owner'), { code: 'agent-protocol' });
  mode = 'wrong-job'; await assert.rejects(client.get('owner', 'id'), { code: 'agent-protocol' });
  mode = 'stalled'; await assert.rejects(client.health('owner'), { code: 'agent-connection' });
});
test('recovery sends only the bound fingerprint, never the prompt, and validates the returned task', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-recovery-client-')), tokenFile = path.join(dir, 'token'), token = 'c'.repeat(64);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const job = { id: crypto.randomUUID(), conversationId: crypto.randomUUID(), prompt: 'sensitive prompt' };
  const digest = value => crypto.createHash('sha256').update(value).digest('hex'); let calls = 0;
  const gateway = http.createServer(async (req, res) => {
    calls++; assert.equal(req.url, '/v1/jobs/' + job.id + '/recover'); assert.equal(req.method, 'POST'); assert.equal(req.headers['x-site-owner'], 'owner');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const identity = [digest('owner'), job.conversationId, job.prompt]; if (job.parentTaskId) identity.push(job.parentTaskId);
    assert.ok(!raw.includes(job.prompt)); assert.deepEqual(JSON.parse(raw), { conversationId: job.conversationId, fingerprint: digest(JSON.stringify(identity)) });
    res.end(JSON.stringify({ id: job.id, conversationId: job.conversationId, status: 'failed', output: '', recoveryReason: 'not-accepted' }));
  }); await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const client = new DshClient({ url: 'http://127.0.0.1:' + gateway.address().port, tokenFile });
  const result = await client.recover('owner', job); assert.equal(result.recoveryReason, 'not-accepted'); assert.equal(result.status, 'failed'); assert.equal(calls, 1);
  job.parentTaskId = crypto.randomUUID(); await client.recover('owner', job); assert.equal(calls, 2);
});
test('valid bounded output files remain readable at worst-case JSON expansion', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-expanded-files-')), tokenFile = path.join(directory, 'token');
  fs.writeFileSync(tokenFile, 'd'.repeat(64), { mode: 0o600 });
  const id = crypto.randomUUID(), conversationId = crypto.randomUUID(), artifacts = Array.from({ length: 4 }, (_, index) => ({ id: crypto.randomUUID(), name: 'file-' + index + '.txt', text: '\u0001'.repeat(256 * 1024) }));
  const body = { id, conversationId, status: 'completed', output: '\u0002'.repeat(256 * 1024), artifacts };
  const serialized = JSON.stringify(body); assert.ok(Buffer.byteLength(serialized) > 7 * 1024 * 1024);
  const gateway = http.createServer((req, res) => { req.resume(); res.setHeader('Content-Type', 'application/json'); res.end(serialized); });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(async () => { gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const client = new DshClient({ url: 'http://127.0.0.1:' + gateway.address().port, tokenFile });
  const result = await client.get('owner', id); assert.equal(result.artifacts.length, 4); assert.equal(result.artifacts[3].text.length, 256 * 1024);
});
