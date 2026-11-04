import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const output = path.join(ROOT, 'acceptance/dsh-history'); fs.mkdirSync(output, { recursive: true });
const fixture = spawn(process.execPath, ['tests/helpers/agent-history-browser-fixture.cjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = await new Promise((resolve, reject) => {
  let text = '', errors = ''; const timer = setTimeout(() => reject(Error('History fixture timeout: ' + errors)), 30000);
  fixture.stdout.on('data', chunk => { text += chunk; const line = text.split('\n').find(value => value.startsWith('AGENT_HISTORY_FIXTURE_READY ')); if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('AGENT_HISTORY_FIXTURE_READY '.length))); } });
  fixture.stderr.on('data', chunk => errors += chunk);
  fixture.once('exit', () => { clearTimeout(timer); reject(Error('History fixture exited: ' + errors)); });
});
const { ab, evalRaw, evalJson, waitFor } = makeBrowser('agent-history-' + Date.now());
const { check, results, failures } = makeChecker();
const state = `JSON.stringify({status:document.getElementById('agentTaskState')?.dataset.state,title:document.getElementById('agentTaskTitle')?.textContent,output:document.getElementById('agentOutput')?.textContent,message:document.getElementById('agentTaskMessage')?.textContent,usage:document.getElementById('agentTurnUsage')?.textContent,retention:document.getElementById('agentRetention')?.textContent,capacity:document.getElementById('agentCapacity')?.textContent,pin:document.getElementById('pinAgentConversation')?.textContent,list:document.querySelectorAll('.task-list-item').length,listText:document.getElementById('agentTaskList')?.textContent,historyMore:!document.getElementById('agentHistoryMore')?.hidden,historyVisible:!document.getElementById('agentHistoryControls')?.hidden,filesVisible:!document.getElementById('manageAgentFiles')?.hidden,libraryOpen:document.getElementById('agentFilesDialog')?.open,libraryCount:document.querySelectorAll('.managed-file-row').length,libraryText:document.getElementById('agentLibraryList')?.textContent,libraryMore:!document.getElementById('agentLibraryMore')?.hidden,storage:document.getElementById('agentStorageUsage')?.textContent,notice:document.getElementById('agentNotice')?.textContent,submitDisabled:document.getElementById('submitAgentTask')?.disabled,welcome:!document.getElementById('agentWelcome')?.hidden})`;
async function read(url, init) {
  evalRaw(`window.agentHistoryRead=null;fetch(${JSON.stringify(url)},${JSON.stringify(init || {})}).then(async r=>({status:r.status,body:await r.text(),disposition:r.headers.get('content-disposition'),mime:r.headers.get('content-type'),nosniff:r.headers.get('x-content-type-options')})).then(data=>window.agentHistoryRead=data);true`);
  return waitFor('本地验收读取', 'window.agentHistoryRead', value => value !== null);
}
async function stats() { return JSON.parse((await read('/fixture-stats')).body); }
async function searchHistory(text, count) { ab(['fill', '#agentHistorySearch', text]); return waitFor('历史搜索 ' + text, state, value => value.list === count); }
async function searchFiles(text, count) { ab(['fill', '#agentLibrarySearch', text]); return waitFor('文件搜索 ' + text, state, value => value.libraryCount === count); }
try {
  ab(['set', 'viewport', '1280', '1000']); ab(['open', ready.origin + '/agent.html']);
  const queued = await waitFor('排队与历史入口', state, value => value.status === 'queued' && value.historyVisible && value.filesVisible && value.list === 20);
  check('排队显示顺序和并行容量，说明开始前不消耗额度', queued.message.includes('第 1 位') && queued.capacity.includes('2 个任务') && queued.usage.includes('不消耗模型额度') && queued.submitDisabled);
  check('历史按需分页，文件管理默认收起', queued.historyMore && !queued.libraryOpen);
  const before = await stats(); ab(['reload']);
  await waitFor('刷新恢复排队状态', state, value => value.status === 'queued' && value.message.includes('第 1 位'));
  check('排队刷新只读取原记录，不重新提交或执行', (await stats()).submissions.length === before.submissions.length && (await stats()).browserSubmissions === 0);
  evalRaw(`window.agentPollingDelays=[];window.agentNativeTimeout=window.setTimeout;window.setTimeout=function(fn,delay,...args){if(delay===1500||delay===8000)window.agentPollingDelays.push(delay);return window.agentNativeTimeout(fn,delay,...args);};true`);
  ab(['click', '#refreshAgent']); await waitFor('活动任务轮询间隔', 'window.agentPollingDelays.at(-1)', value => value === 1500);
  check('排队任务持续快速更新进度', evalJson('JSON.stringify(window.agentPollingDelays.at(-1))') === 1500);
  ab(['click', '#cancelAgentTask']);
  const cancelled = await waitFor('取消尚未执行的任务', state, value => value.status === 'cancelled' && value.usage.includes('未调用模型，不扣额度'));
  const afterCancel = await stats();
  check('取消排队显示零扣费，并且没有进入执行服务器', cancelled.usage.includes('输入 0') && afterCancel.cancels === 1 && afterCancel.localExecutions === before.localExecutions);
  await waitFor('空闲历史轮询间隔', 'window.agentPollingDelays.at(-1)', value => value === 8000);
  check('历史模式空闲时降低轮询频率', evalJson('JSON.stringify(window.agentPollingDelays.at(-1))') === 8000);
  await searchHistory('预算项目', 1); ab(['click', '#agentTaskList .task-list-item']);
  const budget = await waitFor('载入真实历史资料', state, value => value.status === 'completed' && value.output.includes('73021'));
  check('搜索可直接打开历史正文、资料及文件', budget.title.includes('预算项目') && evalJson(`JSON.stringify(document.querySelectorAll('#agentTaskAttachments .agent-file-card').length===1&&document.querySelectorAll('#agentArtifacts .agent-file-card').length===1)`));
  ab(['click', '#pinAgentConversation']);
  await waitFor('长期保存生效', state, value => value.pin === '取消长期保留' && value.retention.includes('直到你主动清理'));
  const saved = JSON.parse((await read('/api/agent/conversations/' + ready.budget.conversationId)).body);
  check('长期保留写入服务器并取消过期时间', saved.pinned === true && saved.expiresAt === null);
  ab(['click', '#manageAgentFiles']); await waitFor('打开文件管理', state, value => value.libraryOpen && value.libraryCount === 20);
  await searchFiles('预算项目资料', 1);
  check('长期保留同步到已绑定上传文件', evalJson(state).libraryText.includes('长期保留'));
  ab(['click', '#closeAgentFiles']);
  ab(['click', '#renameAgentConversation']); ab(['fill', '#agentConversationTitle', '松林实施方案']); ab(['click', '#saveAgentTitle']);
  await waitFor('新对话名保存', state, value => value.title === '松林实施方案');
  await searchHistory('松林实施方案', 1);
  check('对话重命名后可按新名称搜索', evalJson(state).listText.includes('松林实施方案'));
  ab(['reload']); await waitFor('刷新恢复新名称和长期保留', state, value => value.title === '松林实施方案' && value.pin === '取消长期保留');
  check('重命名和长期保留在刷新后仍存在', (await stats()).patches === 2);
  ab(['click', '#agentHistoryPinned']); await waitFor('只看长期保留', state, value => value.list === 1 && value.listText.includes('松林实施方案'));
  check('长期保留筛选只显示保存的对话', !evalJson(state).historyMore);
  ab(['click', '#pinAgentConversation']); await waitFor('取消长期保留', state, value => value.pin === '长期保留' && value.list === 0);
  const unpinned = JSON.parse((await read('/api/agent/conversations/' + ready.budget.conversationId)).body);
  check('取消长期保留恢复30天保存，并从保存筛选移除', unpinned.pinned === false && unpinned.expiresAt > Date.now() + 29 * 86400000 && evalJson(state).retention.includes('保留至'));
  ab(['click', '#agentHistoryAll']); await waitFor('全部历史第一页', state, value => value.list === 20 && value.historyMore);
  ab(['click', '#agentHistoryMore']); const history = await waitFor('历史下一页', state, value => value.list === 24 && !value.historyMore);
  check('历史翻页没有重复或漏失对话', history.list === new Set(evalJson(`JSON.stringify([...document.querySelectorAll('.task-list-item')].map(item=>item.dataset.task))`)).size);
  ab(['click', '#manageAgentFiles']);
  ab(['fill', '#agentLibrarySearch', '']); await waitFor('文件第一页', state, value => value.libraryOpen && value.libraryCount === 20 && value.libraryMore);
  ab(['click', '#agentLibraryMore']); const files = await waitFor('文件下一页', state, value => value.libraryCount === 23 && !value.libraryMore);
  check('文件管理分页显示本账号资料和产物，展示存储用量', files.storage.includes('已用') && /25(?:\.0)? MB/.test(files.storage) && !files.libraryText.includes('其他账号私有资料'), files.storage);
  evalRaw(`(()=>{const input=document.getElementById('agentLibrarySearch');for(const text of ['草稿','']){input.value=text;input.dispatchEvent(new Event('input',{bubbles:true}));}return true;})()`);
  await waitFor('快速清空搜索后第一页', state, value => value.libraryCount === 20 && value.libraryMore);
  ab(['click', '#agentLibraryMore']); await waitFor('快速清空搜索后的分页', state, value => value.libraryCount === 23 && !value.libraryMore);
  check('快速切换搜索后分页仍完整，不复用旧游标', new Set(evalJson(`JSON.stringify([...document.querySelectorAll('.managed-file-row')].map(item=>item.dataset.file))`)).size === 23);
  evalRaw(`document.getElementById('agentLibraryKind').value='artifact';document.getElementById('agentLibraryKind').dispatchEvent(new Event('change'));true`);
  await waitFor('筛选生成文件', state, value => value.libraryCount === 1 && value.libraryText.includes('资料清单.csv'));
  const artifactPath = evalJson(`JSON.stringify(document.querySelector('.managed-file-row a').getAttribute('href'))`), generated = await read(artifactPath);
  check('生成文件由服务器下载，内容和安全附件头正确', generated.status === 200 && generated.body.includes('文件名,字符数') && generated.body.includes('预算项目资料.txt') && generated.disposition.startsWith('attachment;') && generated.mime === 'application/octet-stream' && generated.nosniff === 'nosniff');
  check('已绑定生成文件提供查看对话，禁止单独删除', evalJson(`JSON.stringify(document.querySelectorAll('.managed-file-row .delete-draft').length===0&&document.querySelector('.managed-file-row').textContent.includes('查看对话'))`));
  evalRaw(`document.getElementById('agentLibraryKind').value='upload';document.getElementById('agentLibraryKind').dispatchEvent(new Event('change'));true`);
  await waitFor('筛选上传资料', state, value => value.libraryCount === 20);
  await searchFiles('预算项目资料', 1);
  const originalPath = evalJson(`JSON.stringify(document.querySelector('.managed-file-row a').getAttribute('href'))`), original = await read(originalPath);
  check('上传资料可下载原件，不丢失文件正文', original.status === 200 && original.body.includes('预算：73021 元') && original.nosniff === 'nosniff');
  ab(['set', 'viewport', '390', '844']);
  check('手机文件管理和背景页无横向溢出', evalJson(`JSON.stringify(document.documentElement.scrollWidth<=innerWidth&&document.querySelector('.files-dialog').getBoundingClientRect().width<=innerWidth)`));
  ab(['screenshot', '--full', path.join(output, 'history-files-mobile.png')]);
  ab(['set', 'viewport', '1280', '1000']);
  ab(['click', '.managed-file-row button']); await waitFor('文件关联对话', state, value => !value.libraryOpen && value.title === '松林实施方案');
  check('查看文件关联对话会关闭弹窗并显示对应正文', evalJson(state).output.includes('73021'));
  ab(['click', '#manageAgentFiles']); await searchFiles('未发送草稿', 1);
  ab(['click', '.managed-file-row .delete-draft']); await waitFor('删除未发送资料', state, value => value.libraryCount === 0);
  check('未发送草稿可独立删除，不影响会话文件', (await stats()).deletes === 1 && (await read(originalPath)).status === 200 && (await read(artifactPath)).status === 200);
  ab(['click', '#closeAgentFiles']); ab(['screenshot', '--full', path.join(output, 'history-desktop.png')]);
  ab(['click', '#removeAgentTask']); ab(['click', '#confirmRemoveAgent']); await waitFor('清理已存会话', state, value => value.welcome);
  check('整体清理使原件与生成文件一并失效', [404, 410].includes((await read(originalPath)).status) && [404, 410].includes((await read(artifactPath)).status));
  const final = await stats();
  check('全部验收使用真实本地服务，不请求真实模型', final.modelRequests === 0 && final.browserSubmissions === 0 && final.submissions.length === before.submissions.length);
} catch (error) { check('排队、长期历史与文件管理浏览器验收流程', false, error.stack); }
finally {
  fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ checks: results, modelRequests: 0, realLocalBackend: true }, null, 2));
  ab(['close'], { allowFail: true }); fixture.kill('SIGTERM');
}
console.log(`${results.length - failures()}/${results.length} passed; ${output}`);
if (failures()) process.exitCode = 1;
