import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const output = path.join(ROOT, 'acceptance/dsh-quota'); fs.mkdirSync(output, { recursive: true });
const fixture = spawn(process.execPath, ['tests/helpers/agent-quota-live-browser-fixture.cjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = await new Promise((resolve, reject) => {
  let text = '', errors = ''; const timer = setTimeout(() => reject(Error('Live quota fixture timeout: ' + errors)), 20000);
  fixture.stdout.on('data', chunk => { text += chunk; const line = text.split('\n').find(value => value.startsWith('AGENT_QUOTA_LIVE_FIXTURE_READY ')); if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('AGENT_QUOTA_LIVE_FIXTURE_READY '.length))); } });
  fixture.stderr.on('data', chunk => errors += chunk);
  fixture.once('exit', () => { clearTimeout(timer); reject(Error('Live quota fixture exited: ' + errors)); });
});
const { ab, evalRaw, evalJson, waitFor } = makeBrowser('agent-quota-live-' + Date.now());
const { check, results, failures } = makeChecker();
const state = `JSON.stringify({status:document.getElementById('agentTaskState')?.dataset.state,usage:document.getElementById('agentTurnUsage')?.textContent,previous:document.getElementById('agentPreviousTurns')?.textContent,model:document.getElementById('agentModelSelect')?.value,modelDisabled:document.getElementById('agentModelSelect')?.disabled,modelVisible:!document.getElementById('agentModelControl')?.hidden,models:[...document.getElementById('agentModelSelect')?.options||[]].map(option=>option.textContent),submitDisabled:document.getElementById('submitAgentTask')?.disabled,notice:document.getElementById('agentNotice')?.textContent})`;
const sol = JSON.stringify(['platform:demo', 'gpt-6.1-sol']);
async function request(url) { evalRaw(`window.quotaLiveResponse=null;fetch(${JSON.stringify(url)}).then(async response=>({status:response.status,data:await response.json()})).then(data=>window.quotaLiveResponse=data);true`); return waitFor('实际网站接口', 'window.quotaLiveResponse', value => value !== null); }
async function submit(text) { ab(['fill', '#agentPrompt', text]); await waitFor('可提交', state, value => !value.submitDisabled); ab(['click', '#submitAgentTask']); }
const expectedPoints = task => Math.max(0.1 * task.modelSelection.multiplier, Math.ceil((task.usage.inputTokens + 5 * task.usage.outputTokens) * task.modelSelection.multiplier) / 1000);
try {
  ab(['set', 'viewport', '1280', '1000']); ab(['open', ready.origin + '/agent.html']);
  await waitFor('真实登录门禁', 'location.pathname', value => value === '/login.html');
  ab(['fill', '#loginUsername', ready.username]); ab(['fill', '#loginPassword', 'fixture-password-123']); ab(['click', '#loginBtn']);
  const initial = await waitFor('Pro模型目录', state, value => value.modelVisible && value.models.some(name => name.includes('gpt-6.1-sol')));
  check('真实Pro会员通过登录并只看到Luna和Sol，Astra未授权', initial.models.length === 2 && !initial.models.some(name => name.includes('astra')));
  check('模型倍率来自实际对话相同的后端策略', initial.models.some(name => name.includes('x15')) && initial.models.some(name => name.includes('x0.5')));
  const reference = path.join(output, 'live-reference.txt'); fs.writeFileSync(reference, '项目：松林\n预算：73021\n请整理清单。');
  ab(['select', '#agentModelSelect', sol]); ab(['upload', '#agentFileInput', reference]);
  await waitFor('真实上传资料就绪', 'JSON.stringify({files:document.getElementById("agentDraftAttachments")?.textContent,status:document.getElementById("agentUploadStatus")?.hidden})', value => value.status && value.files?.includes('live-reference.txt'));
  await submit('读取资料后，整理可下载清单。');
  await waitFor('实际DSH模拟任务完成并结算', state, value => value.status === 'completed' && value.usage.includes('本轮消耗'));
  const firstStats = (await request('/fixture-stats')).data;
  const firstId = firstStats.submissions[0].id, first = (await request('/api/agent/tasks/' + firstId)).data.task;
  check('DSH多步调用返回真实用量，并按一整轮累计扣点', first.usage.calls === 3 && first.quota.status === 'settled' && first.quota.points === expectedPoints(first) && firstStats.agentCalls.length === 1);
  check('模型来源和缓存与已结算账本展示一致', evalJson(state).usage.includes('x15') && evalJson(state).usage.includes('累计 3 次') && firstStats.weekly.usedPoints === first.quota.points);
  ab(['screenshot', '--full', path.join(output, 'quota-live-desktop.png')]);
  ab(['reload']); await waitFor('刷新保持结算和固定模型', state, value => value.status === 'completed' && value.usage.includes('本轮消耗') && value.modelDisabled);
  const refreshed = (await request('/fixture-stats')).data;
  check('刷新不重复扣费、不重新执行', refreshed.executions.length === 1 && refreshed.weekly.usedPoints === firstStats.weekly.usedPoints && refreshed.agentCalls.length === 1);
  await submit('继续使用前面的资料，再整理一次。');
  await waitFor('追问保留前轮消耗并完成本轮', state, value => value.status === 'completed' && value.previous.includes('本轮消耗'));
  const secondStats = (await request('/fixture-stats')).data, secondId = secondStats.submissions[1].id, second = (await request('/api/agent/tasks/' + secondId)).data.task;
  check('同会话追问保持Sol，单独增加一笔账单', second.modelSelection.modelId === 'gpt-6.1-sol' && second.parentTaskId === first.id && second.quota.points === expectedPoints(second) && secondStats.agentCalls.length === 2);
  const account = await request('/api/usage');
  check('账号周额度与每轮消耗合计一致', account.status === 200 && Math.round(account.data.usage.weekly.usedPoints * 1000) === Math.round((first.quota.points + second.quota.points) * 1000) && account.data.usage.weekly.reservedPoints === 0);
  ab(['set', 'viewport', '390', '844']);
  check('真实账本用量手机布局不溢出', evalJson('JSON.stringify(document.documentElement.scrollWidth <= innerWidth)'));
  ab(['screenshot', '--full', path.join(output, 'quota-live-mobile.png')]);
  check('全链路浏览器验证没有真实模型调用', secondStats.modelRequests === 0);
} catch (error) { check('真实额度浏览器验收流程', false, error.stack); }
finally { fs.writeFileSync(path.join(output, 'live-browser-results.json'), JSON.stringify({ checks: results, realCloudMembershipAndLedger: true, realBridgeProtocol: true, simulatedDshModel: true, modelRequests: 0 }, null, 2)); ab(['close'], { allowFail: true }); fixture.kill('SIGTERM'); }
console.log(`${results.length - failures()}/${results.length} passed; ${output}`);
if (failures()) process.exitCode = 1;
