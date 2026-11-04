#!/usr/bin/env node
'use strict';
// Run on the VM, with the application stopped and its environment loaded.
const fs = require('node:fs');
const path = require('node:path');
const { CloudRuntime } = require('../lib/cloud-runtime');
const { ChatGPTCloud } = require('../lib/chatgpt-cloud');
async function run(args = process.argv.slice(2), env = process.env) {
  const [command, ...options] = args;
  if (!['metadata', 'import', 'grant', 'share'].includes(command) || !options.includes('--confirm-stopped')) throw Error('停止应用后使用：metadata --confirm-stopped 、import --from 授权文件 --confirm-stopped 、grant --user 用户名 --model 模型ID --confirm-stopped 或 share --model 模型ID --confirm-stopped');
  if (env.APP_MODE !== 'cloud' || !env.CLOUD_CHATGPT_OWNER) throw Error('需要云端环境和 CLOUD_CHATGPT_OWNER。');
  const cloud = new CloudRuntime(env, path.resolve(__dirname, '..'));
  const runtime = new ChatGPTCloud({ cloud, ownerUsername: env.CLOUD_CHATGPT_OWNER });
  let result;
  if (command === 'metadata') result = { format: 'diagram-chatgpt-vm-target-v1', hostId: runtime.data.hostId, owner: env.CLOUD_CHATGPT_OWNER };
  else if (command === 'grant' || command === 'share') {
    const value = name => options.includes(name) ? options[options.indexOf(name) + 1] : undefined;
    result = command === 'share' ? runtime.shareModel(value('--model')) : runtime.grantModel(value('--user'), value('--model'));
  } else {
    const filename = options[options.indexOf('--from') + 1];
    if (!options.includes('--from') || !filename || filename.startsWith('--')) throw Error('需要 --from 授权文件');
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size > 131072 || (stat.mode & 0o077)) throw Error('授权文件必须为 600 权限的普通文件，且不超过 128KB。');
    result = await runtime.importConnection(JSON.parse(fs.readFileSync(filename, 'utf8')));
    fs.unlinkSync(filename); // Once transferred, only the VM owns refreshes.
  }
  // Root maintenance must not leave a file unreadable by the application user.
  if (process.getuid?.() === 0) {
    const owner = fs.statSync(cloud.directory);
    fs.chownSync(runtime.filePath, owner.uid, owner.gid);
  }
  return result;
}
if (require.main === module) run().then(result => console.log(JSON.stringify(result))).catch(() => { console.error('云端订阅操作未完成。请检查参数、文件权限、VM 归属和官方身份验证网络；原有连接保留。'); process.exitCode = 1; });
module.exports = { run };
