import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const output = path.join(ROOT, 'acceptance/dsh-followup'); fs.mkdirSync(output, { recursive: true });
const fixture = spawn(process.execPath, ['tests/helpers/agent-followup-browser-fixture.cjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = await new Promise((resolve, reject) => {
  let text = '', errors = ''; const timer = setTimeout(() => reject(Error('Follow-up fixture timeout: ' + errors)), 15000);
  fixture.stdout.on('data', chunk => { text += chunk; const line = text.split('\n').find(value => value.startsWith('AGENT_FOLLOWUP_FIXTURE_READY ')); if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('AGENT_FOLLOWUP_FIXTURE_READY '.length))); } });
  fixture.stderr.on('data', chunk => errors += chunk);
  fixture.once('exit', () => { clearTimeout(timer); reject(Error('Follow-up fixture exited: ' + errors)); });
});
const { ab, evalRaw, evalJson, waitFor } = makeBrowser('agent-followup-' + Date.now());
const { check, results, failures } = makeChecker();
const state = `JSON.stringify({status:document.getElementById('agentTaskState')?.dataset.state,output:document.getElementById('agentOutput')?.textContent,previous:document.getElementById('agentPreviousTurns')?.textContent,turns:document.getElementById('agentTurnCount')?.textContent,list:document.querySelectorAll('.task-list-item').length,submitDisabled:document.getElementById('submitAgentTask')?.disabled,submitText:document.getElementById('submitAgentTask')?.textContent,hint:document.getElementById('agentConversationHint')?.textContent,draft:document.getElementById('agentPrompt')?.value,welcome:!document.getElementById('agentWelcome')?.hidden})`;
async function stats() { evalRaw(`window.followupFixtureStats=null;fetch('/fixture-stats').then(r=>r.json()).then(data=>window.followupFixtureStats=data);true`); return waitFor('验收统计', 'window.followupFixtureStats', value => value !== null); }
async function submit(text) { ab(['fill', '#agentPrompt', text]); await waitFor('可提交', state, value => !value.submitDisabled); ab(['click', '#submitAgentTask']); }
try {
  ab(['set', 'viewport', '1280', '1000']); ab(['open', ready.origin + '/agent.html']);
  await waitFor('新任务界面', state, value => value.welcome && value.hint.includes('独立上下文'));
  await submit('把需求整理成三步实施计划');
  await waitFor('首轮完成', state, value => value.status === 'completed' && value.output.includes('交付建议') && value.hint.includes('继续当前对话'));
  check('首轮完成后默认进入追问，保留独立新任务入口', evalJson(state).submitText.includes('发送追问'));
  const first = await stats();
  await submit('将第二步展开，并保持其余两步不变');
  const secondView = await waitFor('二轮完成并显示历史', state, value => value.status === 'completed' && value.turns.includes('2 轮') && value.output.includes('将第二步展开'));
  check('同一会话展示两轮完整请求和结果，侧栏只占一行', secondView.previous.includes('把需求整理成三步实施计划') && secondView.previous.includes('交付建议') && secondView.list === 1);
  const second = await stats(), a = second.submissions[0], b = second.submissions[1];
  check('追问绑定上一轮标识和同一会话，不上传历史正文', b.parentTaskId === a.id && b.conversationId === a.conversationId && b.prompt === '将第二步展开，并保持其余两步不变' && Object.keys(b).sort().join(',') === 'conversationId,id,parentTaskId,prompt');
  check('执行端确实沿用会话，首轮与追问各执行一次', second.executions.length === 2 && second.executions[0].sessionId === second.executions[1].sessionId && second.executions[1].continuation);
  ab(['screenshot', '--full', path.join(output, 'two-turns-desktop.png')]);
  ab(['reload']);
  const restored = await waitFor('刷新保留完整对话', state, value => value.turns.includes('2 轮') && value.previous.includes('交付建议') && value.output.includes('将第二步展开'));
  check('刷新后显示多轮结果并可继续追问', restored.hint.includes('继续当前对话') && (await stats()).executions.length === 2);
  evalRaw(`window.followupReadHeld=false;window.followupReleaseRead=null;window.followupOriginalFetch=window.fetch;window.fetch=function(url,options){if(String(url).startsWith('/api/agent/conversations/')){window.followupReadHeld=true;return new Promise(resolve=>{window.followupReleaseRead=()=>resolve(window.followupOriginalFetch.call(window,url,options));});}return window.followupOriginalFetch.call(window,url,options);};document.getElementById('refreshAgent').click();true`);
  await waitFor('延迟读取会话正文', 'window.followupReadHeld', value => value === true);
  ab(['fill', '#agentPrompt', '慢网络下继续输入']);
  const duringRead = evalJson(state);
  check('慢网络刷新期间输入仍保留历史和当前正文', duringRead.previous.includes('交付建议') && duringRead.output.includes('将第二步展开'));
  evalRaw(`window.fetch=window.followupOriginalFetch;window.followupReleaseRead();true`);
  await waitFor('读取对话完成', state, value => value.hint.includes('继续当前对话'));
  ab(['fill', '#agentPrompt', '未发送的追问草稿']); ab(['reload']);
  await waitFor('刷新保留追问草稿', state, value => value.draft === '未发送的追问草稿');
  check('追问草稿随当前会话保留', evalJson(state).draft === '未发送的追问草稿');
  ab(['click', '#newAgentTask']); ab(['reload']);
  const newView = await waitFor('新任务刷新后仍是新任务', state, value => value.welcome && value.hint.includes('独立上下文'));
  check('点击新任务后刷新保持空白新任务，不跳回旧会话', newView.draft === '');
  await submit('另一个完全独立的问题');
  await waitFor('新会话完成', state, value => value.status === 'completed' && value.list === 2 && value.previous === '');
  const third = await stats(), c = third.submissions[2];
  check('新任务创建独立上下文，不携带旧会话内容', c.conversationId !== a.conversationId && !c.parentTaskId && third.executions[2].sessionId !== third.executions[0].sessionId && !third.executions[2].continuation);
  ab(['click', '.task-list-item:last-child']);
  await waitFor('回到原会话', state, value => value.turns.includes('2 轮') && value.draft === '未发送的追问草稿');
  await submit('把这份计划缩短为一段话');
  await waitFor('第三轮完成', state, value => value.status === 'completed' && value.turns.includes('3 轮') && value.output.includes('缩短为一段话'));
  const fourth = await stats();
  check('切回旧会话后追问接着最新一轮，历史继续保留', fourth.submissions[3].parentTaskId === b.id && evalJson(state).previous.includes('将第二步展开'));
  ab(['set', 'viewport', '390', '844']);
  check('手机宽度无横向溢出', evalJson('JSON.stringify(document.documentElement.scrollWidth <= innerWidth)'));
  ab(['screenshot', '--full', path.join(output, 'three-turns-mobile.png')]);
  ab(['set', 'viewport', '1280', '1000']); ab(['click', '#removeAgentTask']);
  check('清理前明确提示删除整段会话', evalJson(`JSON.stringify(!document.getElementById('agentRemoveConfirm').hidden && document.getElementById('agentRemoveConfirm').textContent.includes('所有轮次及上下文'))`));
  ab(['click', '#confirmRemoveAgent']);
  await waitFor('整段对话已清理', state, value => value.welcome && value.list === 1);
  const final = await stats();
  check('清理删除整段会话并释放执行端上下文', final.releases === 1 && final.executions.length === 4 && final.modelRequests === 0);
  ab(['reload']); await waitFor('清理后刷新仍无旧对话', state, value => value.welcome && value.list === 1);
  check('清理后刷新不会恢复已删除正文', evalJson(state).welcome);
} catch (error) { check('连续追问浏览器验收流程', false, error.stack); }
finally {
  fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ checks: results, modelRequests: 0, isolatedLocalBrowser: true }, null, 2));
  ab(['close'], { allowFail: true }); fixture.kill('SIGTERM');
}
console.log(`${results.length - failures()}/${results.length} passed; ${output}`);
if (failures()) process.exitCode = 1;
