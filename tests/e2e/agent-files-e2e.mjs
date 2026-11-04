import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const output = path.join(ROOT, 'acceptance/dsh-files'); fs.mkdirSync(output, { recursive: true });
const fixture = spawn(process.execPath, ['tests/helpers/agent-files-browser-fixture.cjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = await new Promise((resolve, reject) => {
  let text = '', errors = ''; const timer = setTimeout(() => reject(Error('Files fixture timeout: ' + errors)), 15000);
  fixture.stdout.on('data', chunk => { text += chunk; const line = text.split('\n').find(value => value.startsWith('AGENT_FILES_FIXTURE_READY ')); if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('AGENT_FILES_FIXTURE_READY '.length))); } });
  fixture.stderr.on('data', chunk => errors += chunk);
  fixture.once('exit', () => { clearTimeout(timer); reject(Error('Files fixture exited: ' + errors)); });
});
const { ab, evalRaw, evalJson, waitFor } = makeBrowser('agent-files-' + Date.now());
const { check, results, failures } = makeChecker();
const state = `JSON.stringify({status:document.getElementById('agentTaskState')?.dataset.state,output:document.getElementById('agentOutput')?.textContent,previous:document.getElementById('agentPreviousTurns')?.textContent,turns:document.getElementById('agentTurnCount')?.textContent,list:document.querySelectorAll('.task-list-item').length,submitDisabled:document.getElementById('submitAgentTask')?.disabled,submitText:document.getElementById('submitAgentTask')?.textContent,hint:document.getElementById('agentConversationHint')?.textContent,draft:document.getElementById('agentPrompt')?.value,welcome:!document.getElementById('agentWelcome')?.hidden,fileButtonVisible:!document.getElementById('attachAgentFiles')?.hidden,fileButtonDisabled:document.getElementById('attachAgentFiles')?.disabled,draftFiles:document.querySelectorAll('#agentDraftAttachments .agent-file-card').length,draftNames:document.getElementById('agentDraftAttachments')?.textContent,taskFiles:document.querySelectorAll('#agentTaskAttachments .agent-file-card').length,artifactCount:document.querySelectorAll('#agentArtifacts .agent-file-card').length,artifactText:document.getElementById('agentArtifacts')?.textContent,notice:document.getElementById('agentNotice')?.textContent,uploading:!document.getElementById('agentUploadStatus')?.hidden})`;
async function stats() { evalRaw(`window.agentFileStats=null;fetch('/fixture-stats').then(r=>r.json()).then(data=>window.agentFileStats=data);true`); return waitFor('验收统计', 'window.agentFileStats', value => value !== null); }
function chooseFiles(expression) {
  evalRaw(`(()=>{const data=new DataTransfer();for(const file of (${expression}))data.items.add(file);const input=document.getElementById('agentFileInput');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`);
}
async function sampleFiles(indices) {
  evalRaw(`window.agentSampleFiles=null;fetch('/fixture-files').then(r=>r.json()).then(data=>window.agentSampleFiles=data);true`);
  await waitFor('本地样本文件', 'window.agentSampleFiles', value => Array.isArray(value));
  chooseFiles(`${JSON.stringify(indices)}.map(index=>{const file=window.agentSampleFiles[index];return new File([Uint8Array.from(atob(file.data),c=>c.charCodeAt(0))],file.name);})`);
}
async function submit(text) { ab(['fill', '#agentPrompt', text]); await waitFor('可发送任务', state, value => !value.submitDisabled); ab(['click', '#submitAgentTask']); }
async function download(selector, label) {
  evalRaw(`window.agentDownloadReceipt=null;fetch(document.querySelector(${JSON.stringify(selector)}).href).then(async r=>({status:r.status,text:await r.text(),disposition:r.headers.get('content-disposition'),mime:r.headers.get('content-type'),nosniff:r.headers.get('x-content-type-options')})).then(data=>window.agentDownloadReceipt=data);true`);
  return waitFor(label, 'window.agentDownloadReceipt', value => value !== null);
}
try {
  ab(['set', 'viewport', '1280', '1000']); ab(['open', ready.origin + '/agent.html']);
  await waitFor('文件能力入口', state, value => value.welcome && value.fileButtonVisible && !value.fileButtonDisabled);
  check('文件能力就绪后显示添加资料入口和5MB/50页说明', evalJson(`JSON.stringify(document.getElementById('agentFileHint').textContent.includes('5 MB')&&document.getElementById('agentFileHint').textContent.includes('50 页'))`));
  chooseFiles(`[new File([new Uint8Array(5*1024*1024+1)],'过大.txt')]`);
  await waitFor('过大文件提示', state, value => value.notice.includes('5 MB'));
  check('前端拒绝过大文件，不发送上传请求', (await stats()).uploads === 0);
  chooseFiles(`[new File(['fake'],'image.png')]`);
  await waitFor('图片不支持提示', state, value => value.notice.includes('暂不支持图片'));
  check('图片格式明确提示，不假装已读取', evalJson(state).draftFiles === 0 && (await stats()).uploads === 0);
  chooseFiles(`Array.from({length:6},(_,i)=>new File(['small'],'file'+i+'.txt'))`);
  await waitFor('最多五份提示', state, value => value.notice.includes('最多添加 5'));
  check('一次超过五份时阻止上传', (await stats()).uploads === 0);
  await sampleFiles([0, 1, 2]);
  const uploaded = await waitFor('文字、PDF、Word读取完成', state, value => value.draftFiles === 3 && !value.uploading);
  check('三种真实格式顺序上传并显示资料卡', uploaded.draftNames.includes('项目资料.txt') && uploaded.draftNames.includes('参考说明.pdf') && uploaded.draftNames.includes('实施要求.docx') && uploaded.draftNames.includes('2 页'));
  ab(['fill', '#agentPrompt', '请读取这些资料，整理成可下载的 CSV 清单。']);
  ab(['reload']);
  const restored = await waitFor('刷新恢复附件草稿', state, value => value.draftFiles === 3 && !value.uploading && value.draft.includes('可下载'));
  check('刷新保留文字和已上传附件，且不重复上传', restored.draftFiles === 3 && (await stats()).uploads === 3);
  ab(['click', '#agentDraftAttachments .agent-file-card:last-child .remove-file']);
  await waitFor('移除未发送Word', state, value => value.draftFiles === 2);
  check('移除未发送资料会删除服务器暂存', (await stats()).retainedFiles === 2);
  const beforeSubmit = await stats();
  evalRaw(`window.agentBrowserSubmissions=[];window.agentDropReply=true;window.agentOriginalFetch=window.fetch;window.fetch=async function(url,options){const reply=await window.agentOriginalFetch.call(window,url,options);if(String(url)==='/api/agent/tasks'&&options?.method==='POST'){window.agentBrowserSubmissions.push(JSON.parse(options.body));if(window.agentDropReply){window.agentDropReply=false;throw Error('simulated lost browser submit response');}}return reply;};true`);
  await submit('请读取这些资料，整理成可下载的 CSV 清单。');
  const first = await waitFor('资料处理与产物完成', state, value => value.status === 'completed' && value.artifactCount === 1 && value.taskFiles === 2 && value.output.includes('73021'));
  check('读取真实提取正文并展示可下载产物', first.output.includes('项目资料.txt') && first.output.includes('参考说明.pdf') && first.artifactText.includes('资料清单.csv'));
  const afterSubmit = await stats(), firstJob = afterSubmit.submissions.at(-1), browserBodies = evalJson('JSON.stringify(window.agentBrowserSubmissions)');
  check('网页只发送附件编号，丢回复后核对原任务不重复执行', afterSubmit.executions.length === beforeSubmit.executions.length + 1 && browserBodies.length === 1 && browserBodies[0].attachmentIds.length === 2 && !browserBodies[0].documents);
  const original = await download('#agentTaskAttachments a', '原件下载');
  check('上传原件可从本站下载且内容保持原样', original.status === 200 && original.text.includes('预算：73021 元') && original.disposition.startsWith('attachment;') && original.nosniff === 'nosniff');
  const generated = await download('#agentArtifacts a', '生成CSV下载');
  check('生成文件是真实服务器内容并强制附件下载', generated.status === 200 && generated.text.includes('文件名,字符数') && generated.text.includes('项目资料.txt') && generated.disposition.startsWith('attachment;') && generated.mime === 'application/octet-stream');
  ab(['screenshot', '--full', path.join(output, 'files-desktop.png')]);
  ab(['reload']); await waitFor('刷新保留资料和产物', state, value => value.status === 'completed' && value.taskFiles === 2 && value.artifactCount === 1);
  check('刷新后资料和生成文件仍可下载，不调用模型', (await download('#agentArtifacts a', '刷新后CSV下载')).text === generated.text && (await stats()).executions.length === afterSubmit.executions.length);
  await submit('继续使用前面的资料，再保存一份更新后的文件。');
  const continued = await waitFor('接着资料继续追问', state, value => value.status === 'completed' && value.turns.includes('2 轮') && value.artifactCount === 1);
  const afterFollowup = await stats();
  check('追问复用原会话，历史资料和首轮产物保留', continued.previous.includes('项目资料.txt') && continued.previous.includes('资料清单.csv') && afterFollowup.submissions.at(-1).parentTaskId === firstJob.id && afterFollowup.executions.at(-1).sessionId === afterFollowup.executions[0].sessionId && afterFollowup.executions.at(-1).documents.length === 0);
  const continuedFile = await download('#agentArtifacts a', '追问产物下载');
  check('后续轮可以继续使用此前上传的资料生成文件', continuedFile.status === 200 && continuedFile.text.includes('参考说明.pdf'));
  ab(['set', 'viewport', '390', '844']);
  check('手机宽度资料与产物卡不横向溢出', evalJson('JSON.stringify(document.documentElement.scrollWidth<=innerWidth)'));
  ab(['screenshot', '--full', path.join(output, 'files-mobile.png')]);
  ab(['set', 'viewport', '1280', '1000']);
  const oldArtifact = evalJson(`JSON.stringify(document.querySelector('#agentArtifacts a').getAttribute('href'))`);
  ab(['click', '#removeAgentTask']);
  check('清理确认明确包含资料和生成文件', evalJson(`JSON.stringify(document.getElementById('agentRemoveConfirm').textContent.includes('资料和生成文件'))`));
  ab(['click', '#confirmRemoveAgent']); await waitFor('完整文件会话已清理', state, value => value.welcome && value.list === 0);
  evalRaw(`window.agentOldDownloadStatus=null;fetch(${JSON.stringify(oldArtifact)}).then(r=>window.agentOldDownloadStatus=r.status);true`);
  check('清理同时删除资料、产物并使旧下载失效', await waitFor('旧文件下载失效', 'window.agentOldDownloadStatus', value => value !== null) === 410 && (await stats()).retainedFiles === 0);
  await sampleFiles([0]); await waitFor('过期资料测试草稿', state, value => value.draftFiles === 1 && !value.uploading);
  evalRaw(`window.agentExpiryDone=false;fetch('/fixture-expire-drafts',{method:'POST'}).then(()=>window.agentExpiryDone=true);true`);
  await waitFor('样本资料过期', 'window.agentExpiryDone', value => value);
  ab(['reload']); const expired = await waitFor('刷新识别过期草稿', state, value => value.draftFiles === 0 && !value.uploading && value.notice.includes('过期'));
  check('过期未发送资料明确提示重新添加，不静默沿用失效编号', expired.notice.includes('重新添加'));
  await sampleFiles([0]); await waitFor('提交前失效测试资料', state, value => value.draftFiles === 1 && !value.uploading);
  evalRaw(`window.agentExpiryDone=false;fetch('/fixture-expire-drafts',{method:'POST'}).then(()=>window.agentExpiryDone=true);true`);
  await waitFor('提交前资料失效', 'window.agentExpiryDone', value => value);
  await submit('附件已过期的任务草稿');
  const rejected = await waitFor('明确404拒绝后保留草稿', state, value => value.notice.includes('不存在或已过期') && value.draft === '附件已过期的任务草稿' && !value.submitText.includes('核对'));
  check('附件提交404后清除待核对状态，保留草稿并允许新任务', rejected.draft === '附件已过期的任务草稿' && evalJson(`JSON.stringify(sessionStorage.getItem('diagram.agent.local.pending')===null&&!document.getElementById('newAgentTask').disabled)`));
  ab(['click', '#newAgentTask']); await waitFor('404拒绝后可回到新任务', state, value => value.welcome && value.draftFiles === 0 && !value.uploading);
  check('全部文件浏览器验收未调用真实模型', (await stats()).modelRequests === 0);
} catch (error) { check('文件输入产出浏览器验收流程', false, error.stack); }
finally {
  fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ checks: results, modelRequests: 0, isolatedLocalBrowser: true }, null, 2));
  ab(['close'], { allowFail: true }); fixture.kill('SIGTERM');
}
console.log(`${results.length - failures()}/${results.length} passed; ${output}`);
if (failures()) process.exitCode = 1;
