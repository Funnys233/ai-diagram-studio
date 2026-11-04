import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const output = path.join(ROOT, 'acceptance/dsh-quota'); fs.mkdirSync(output, { recursive: true });
const fixture = spawn(process.execPath, ['tests/helpers/agent-quota-browser-fixture.cjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = await new Promise((resolve, reject) => {
  let text = '', errors = ''; const timer = setTimeout(() => reject(Error('Quota fixture timeout: ' + errors)), 15000);
  fixture.stdout.on('data', chunk => { text += chunk; const line = text.split('\n').find(value => value.startsWith('AGENT_QUOTA_FIXTURE_READY ')); if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('AGENT_QUOTA_FIXTURE_READY '.length))); } });
  fixture.stderr.on('data', chunk => errors += chunk);
  fixture.once('exit', () => { clearTimeout(timer); reject(Error('Quota fixture exited: ' + errors)); });
});
const { ab, evalRaw, evalJson, waitFor } = makeBrowser('agent-quota-' + Date.now());
const { check, results, failures } = makeChecker();
const state = `JSON.stringify({status:document.getElementById('agentTaskState')?.dataset.state,output:document.getElementById('agentOutput')?.textContent,usage:document.getElementById('agentTurnUsage')?.textContent,previous:document.getElementById('agentPreviousTurns')?.textContent,model:document.getElementById('agentModelSelect')?.value,modelDisabled:document.getElementById('agentModelSelect')?.disabled,modelVisible:!document.getElementById('agentModelControl')?.hidden,models:[...document.getElementById('agentModelSelect')?.options||[]].map(option=>option.textContent),note:document.getElementById('agentModelNote')?.textContent,submitDisabled:document.getElementById('submitAgentTask')?.disabled,submitText:document.getElementById('submitAgentTask')?.textContent,welcome:!document.getElementById('agentWelcome')?.hidden,notice:document.getElementById('agentNotice')?.textContent,footnote:document.getElementById('agentFootnote')?.textContent})`;
const luna = JSON.stringify(['platform:demo', 'gpt-6-luna']), sol = JSON.stringify(['platform:demo', 'gpt-6.1-sol']), personal = JSON.stringify(['personal:mine', 'gpt-6-luna']);
async function stats() { evalRaw(`window.quotaFixtureStats=null;fetch('/fixture-stats').then(r=>r.json()).then(data=>window.quotaFixtureStats=data);true`); return waitFor('验收统计', 'window.quotaFixtureStats', value => value !== null); }
async function control(body) { evalRaw(`window.quotaFixtureControl=null;fetch('/fixture-control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify(body)})}).then(r=>r.json()).then(data=>window.quotaFixtureControl=data);true`); await waitFor('调整验收状态', 'window.quotaFixtureControl', value => value?.ok); ab(['click', '#refreshAgent']); }
async function submit(text) { ab(['fill', '#agentPrompt', text]); await waitFor('可提交', state, value => !value.submitDisabled); ab(['click', '#submitAgentTask']); }
try {
  ab(['set', 'viewport', '1280', '1000']); ab(['open', ready.origin + '/agent.html']);
  const initial = await waitFor('会员模型选择就绪', state, value => value.modelVisible && value.model === luna && !value.modelDisabled);
  check('普通用户角色可以打开智能任务，不被前端管理员检查拦住', !initial.notice && initial.models.length === 3);
  check('模型选项沿用服务端授权列表和倍率，不出现未授权Astra', initial.models.some(name => name.includes('x0.5')) && initial.models.some(name => name.includes('x15')) && !initial.models.some(name => /astra/i.test(name)));
  check('普通账号看不到后台管理入口', evalJson(`JSON.stringify(document.querySelector('.agent-topbar a[href="/admin.html"]').hidden)`));
  ab(['select', '#agentModelSelect', sol]); ab(['reload']);
  await waitFor('模型偏好刷新后保留', state, value => value.model === sol && !value.modelDisabled);
  check('新任务选择模型后刷新保留选择', evalJson(state).model === sol);
  await submit('用 Sol 给我一个简短计划');
  const pending = await waitFor('本轮核算提示', state, value => value.status === 'running' && value.usage.includes('用量核算中'));
  check('运行期间模型固定且用量显示核算中', pending.modelDisabled && pending.model === sol && pending.note.includes('新建任务'));
  const first = await waitFor('首轮完成并显示完整用量', state, value => value.status === 'completed' && value.usage.includes('30 点'));
  check('每轮显示本次点数、来源和与对话一致的倍率', first.usage.includes('平台模型') && first.usage.includes('6.1 Sol') && first.usage.includes('x15') && first.usage.includes('本轮消耗：30 点'));
  check('用量显示输入输出缓存和多步累计次数', first.usage.includes('输入 1,000') && first.usage.includes('输出 200') && first.usage.includes('缓存命中 400') && first.usage.includes('累计 3 次模型调用'));
  check('界面不把DSH上游成本或整站余额作为本轮费用', !/\$|美元|剩余额度|剩余周额度/.test(first.usage));
  const before = await stats();
  check('提交只发送模型标识，不提交倍率或会员权限', before.submissions[0].modelSelection?.providerId === 'platform:demo' && before.submissions[0].modelSelection?.modelId === 'gpt-6.1-sol' && Object.keys(before.submissions[0].modelSelection).sort().join(',') === 'modelId,providerId');
  ab(['screenshot', '--full', path.join(output, 'quota-desktop.png')]);
  ab(['reload']); await waitFor('刷新后保存已结算用量', state, value => value.status === 'completed' && value.usage.includes('30 点') && value.modelDisabled);
  check('刷新显示同一笔消耗，不重新提交或执行', (await stats()).submissions.length === 1);
  await submit('接着上面的计划再精简一次');
  await waitFor('追问仍沿用同一模型', state, value => value.status === 'completed' && value.previous.includes('本轮消耗：30 点'));
  const after = await stats();
  check('追问模型固定且历史每轮各自保留用量', after.submissions.length === 2 && after.submissions[1].modelSelection.modelId === 'gpt-6.1-sol' && after.submissions[1].parentTaskId === after.submissions[0].id && evalJson(state).usage.includes('累计 3 次'));
  ab(['set', 'viewport', '390', '844']);
  check('手机模型与用量布局无横向溢出', evalJson('JSON.stringify(document.documentElement.scrollWidth <= innerWidth)'));
  ab(['screenshot', '--full', path.join(output, 'quota-mobile.png')]);
  ab(['set', 'viewport', '1280', '1000']); ab(['click', '#newAgentTask']);
  await waitFor('新任务可换模型', state, value => value.welcome && !value.modelDisabled);
  ab(['select', '#agentModelSelect', personal]); await submit('使用我自己的 API 做这项任务');
  await waitFor('个人API费用提示', state, value => value.status === 'completed' && value.usage.includes('个人 API，不扣本站周额度'));
  check('个人API不会被写成扣站内周额度', !evalJson(state).usage.includes('本轮消耗：0 点'));
  ab(['click', '#newAgentTask']); await control({ failure: true });
  await waitFor('失败估算场景模型就绪', state, value => value.modelVisible && !value.modelDisabled);
  ab(['select', '#agentModelSelect', luna]); await submit('测试中断保留用量');
  const failed = await waitFor('中断用量显示估算', state, value => value.status === 'failed' && value.usage.includes('含估算'));
  check('用量缺失时明确估算且不伪造缓存命中', failed.usage.includes('缓存数据未提供') && failed.usage.includes('用量未完整返回') && !failed.usage.includes('缓存命中 0'));
  await control({ empty: true }); ab(['fill', '#agentPrompt', '模型权限已变化']);
  const revoked = await waitFor('旧会话模型不再可用时阻止追问', state, value => value.note.includes('目前不可用') && value.submitDisabled);
  check('会员权限或模型变更后保留历史标记，阻止继续使用失效模型', revoked.model === luna && revoked.modelDisabled);
  ab(['click', '#newAgentTask']);
  ab(['fill', '#agentPrompt', '当前没有可用模型']);
  const none = await waitFor('没有权限模型时禁发', state, value => value.models[0] === '暂无可用模型' && value.submitDisabled);
  check('服务端没有可用模型时明确提示并阻止提交', none.note.includes('没有可用于智能任务的模型'));
  check('页脚说明按站内额度和多步累计计费，不再写个人专用Luna', none.footnote.includes('对话页一致') && none.footnote.includes('多步调用') && !none.footnote.includes('站长本人'));
  check('额度前端验收没有调用真实模型', (await stats()).modelRequests === 0);
} catch (error) { check('额度前端浏览器验收流程', false, error.stack); }
finally { fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ checks: results, modelRequests: 0, frontendContractFixture: true, isolatedLocalBrowser: true }, null, 2)); ab(['close'], { allowFail: true }); fixture.kill('SIGTERM'); }
console.log(`${results.length - failures()}/${results.length} passed; ${output}`);
if (failures()) process.exitCode = 1;
