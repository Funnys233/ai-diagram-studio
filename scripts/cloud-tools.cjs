#!/usr/bin/env node
'use strict';
// Offline operations. Never prints API keys, passwords or master keys.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { codec, atomic } = require('../lib/cloud-runtime');
const ROOT = path.resolve(__dirname, '..');
const FILE = /^(state|providers-(platform|[a-f0-9-]{36})|chatgpt-vm)\.enc$/;
function options(args) {
  const result = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) throw Error('参数必须使用 --名称');
    const name = args[i].slice(2);
    result[name] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return result;
}
function exclusive(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { flag: 'wx', mode: 0o600 });
}
function key(env) {
  const k = Buffer.from(env.CLOUD_MASTER_KEY || '', 'base64');
  if (k.length !== 32 || k.toString('base64') !== env.CLOUD_MASTER_KEY) throw Error('需要正确的 CLOUD_MASTER_KEY');
  return codec(k);
}
function bundle(directory, cipher) {
  const files = {};
  for (const name of fs.readdirSync(directory).filter(n => FILE.test(n))) {
    const file = path.join(directory, name);
    if (!fs.lstatSync(file).isFile()) throw Error('数据文件必须是普通文件');
    const raw = fs.readFileSync(file, 'utf8');
    cipher.decode(raw); // Fail before producing a backup if any file is corrupt.
    files[name] = raw;
  }
  if (!files['state.enc']) throw Error('缺少 state.enc');
  return { format: 'diagram-cloud-backup-v1', createdAt: new Date().toISOString(), files };
}
function unpack(archive, cipher) {
  if (archive.format !== 'diagram-cloud-backup-v1' || !archive.files || typeof archive.files !== 'object' || !archive.files['state.enc']) throw Error('备份格式不合法');
  const result = {};
  for (const [name, raw] of Object.entries(archive.files)) {
    if (!FILE.test(name) || typeof raw !== 'string') throw Error('备份中含非法路径或文件');
    result[name] = cipher.decode(raw);
  }
  if (result['state.enc'].version !== 1 || !Array.isArray(result['state.enc'].users)) throw Error('备份数据版本不支持');
  return result;
}
function writeDirectory(out, files, cipher) {
  if (!out) throw Error('请提供 --out 新数据目录');
  const target = path.resolve(out);
  if (fs.existsSync(target)) throw Error('目标目录已存在，恢复和轮换不会覆盖现有数据');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const stage = fs.mkdtempSync(target + '.staging-');
  try {
    for (const [name, data] of Object.entries(files)) atomic(path.join(stage, name), cipher.encode(data));
    fs.renameSync(stage, target);
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true }); }
  return target;
}
function run(argv = process.argv.slice(2), env = process.env) {
  const [command, ...args] = argv;
  const opt = options(args);
  if (command === 'setup') {
    const u = new URL(opt.origin);
    if (u.protocol !== 'https:' || u.origin !== opt.origin || u.username || u.password) throw Error('--origin 必须为完整 HTTPS origin，例如 https://draw.example.com');
    const username = opt.username || 'admin';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,39}$/.test(username)) throw Error('管理员账号格式不合法');
    const out = path.resolve(opt.out || '.env.cloud');
    exclusive(out, `APP_MODE=cloud\nPUBLIC_ORIGIN=${u.origin}\nHOST=127.0.0.1\nPORT=8080\nCLOUD_DATA_DIR=./data/cloud\nCLOUD_MASTER_KEY=${crypto.randomBytes(32).toString('base64')}\nCLOUD_ADMIN_USERNAME=${username}\nCLOUD_ADMIN_PASSWORD=${crypto.randomBytes(24).toString('base64url')}\nCLOUD_PLATFORM_DAILY_LIMIT=200\nCLOUD_WEEKLY_POINTS=1000\nCLOUD_FREE_MODELS='[]'\nCLOUD_USER_CONCURRENCY=1\nCLOUD_TOTAL_CONCURRENCY=4\nREQUEST_TIMEOUT_MS=300000\n`);
    fs.appendFileSync(out, 'DSH_AGENT_ENABLED=false\nDSH_PUBLIC_ENABLED=false\n');
    return { environmentFile: out };
  }
  if (!['backup', 'restore', 'rekey', 'reset-password'].includes(command)) throw Error('命令：setup / backup / restore / rekey / reset-password，详见 DEPLOYMENT.md');
  if (opt['confirm-stopped'] !== true) throw Error('请停止唯一应用实例后使用 --confirm-stopped，以确保数据一致');
  const cipher = key(env), directory = path.resolve(env.CLOUD_DATA_DIR || path.join(ROOT, 'data', 'cloud'));
  if (command === 'backup') {
    if (!opt.out) throw Error('请提供 --out 备份文件');
    exclusive(opt.out, JSON.stringify(bundle(directory, cipher)));
    return { backup: path.resolve(opt.out) };
  }
  if (command === 'restore') {
    if (!opt.from) throw Error('请提供 --from 备份文件');
    const files = unpack(JSON.parse(fs.readFileSync(opt.from, 'utf8')), cipher);
    files['state.enc'].sessions = []; // Restoring a backup never revives an old login.
    return { dataDirectory: writeDirectory(opt.out, files, cipher) };
  }
  if (command === 'rekey') {
    if (!opt['key-out'] || !opt.out || fs.existsSync(opt.out) || fs.existsSync(opt['key-out'])) throw Error('请提供尚不存在的 --out 数据目录与 --key-out 主密钥文件');
    const files = unpack(bundle(directory, cipher), cipher), nextKey = crypto.randomBytes(32);
    files['state.enc'].sessions = [];
    exclusive(opt['key-out'], nextKey.toString('base64') + '\n');
    try { return { dataDirectory: writeDirectory(opt.out, files, codec(nextKey)), masterKeyFile: path.resolve(opt['key-out']) }; }
    catch (e) { fs.unlinkSync(opt['key-out']); throw e; }
  }
  const archive = bundle(directory, cipher), state = cipher.decode(archive.files['state.enc']);
  const user = state.users.find(u => u.username === String(opt.username || '').toLowerCase());
  if (!user) throw Error('账号不存在');
  const password = env.CLOUD_RECOVERY_PASSWORD;
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) throw Error('通过受保护环境文件设置 CLOUD_RECOVERY_PASSWORD，长度 8–128；不要写到命令行参数');
  const backup = path.join(directory, 'pre-password-reset-' + Date.now() + '.backup');
  exclusive(backup, JSON.stringify(archive));
  user.salt = crypto.randomBytes(16).toString('hex');
  user.kdf = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
  user.hash = crypto.scryptSync(password, user.salt, 64, user.kdf).toString('hex');
  state.sessions = state.sessions.filter(s => s.userId !== user.id);
  atomic(path.join(directory, 'state.enc'), cipher.encode(state));
  return { username: user.username, backup };
}
if (require.main === module) {
  try { console.log(JSON.stringify(run())); }
  catch { console.error('云端运维操作失败：请检查参数、环境配置、数据完整性和目标路径；详见 DEPLOYMENT.md。'); process.exitCode = 1; }
}
module.exports = { run, bundle, unpack };
