import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, makeBrowser, makeChecker } from './lib/browser-harness.mjs';
const output = path.join(ROOT, 'acceptance/dsh-recovery'); fs.mkdirSync(output, { recursive: true });
const fixture = spawn(process.execPath, ['tests/helpers/agent-recovery-browser-fixture.cjs'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
const ready = await new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(Error('Recovery browser fixture timeout')), 15000);
  fixture.stdout.on('data', chunk => {
    text += chunk;
    const line = text.split('\n').find(value => value.startsWith('AGENT_RECOVERY_FIXTURE_READY '));
    if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice('AGENT_RECOVERY_FIXTURE_READY '.length))); }
  });
  fixture.once('exit', () => { clearTimeout(timer); reject(Error('Recovery browser fixture exited')); });
});
const browser = makeBrowser('agent-recovery-' + Date.now()), { ab, evalRaw, evalJson, waitFor } = browser;
const { check, results, failures } = makeChecker();
const state = `JSON.stringify({status:document.getElementById('agentTaskState')?.dataset.state,buttonVisible:!document.getElementById('recoverAgentTask')?.hidden,buttonText:document.getElementById('recoverAgentTask')?.textContent,output:document.getElementById('agentOutput')?.textContent,submitDisabled:document.getElementById('submitAgentTask')?.disabled,notice:document.getElementById('agentNotice')?.textContent})`;
async function stats() {
  evalRaw(`window.recoveryFixtureStats=null;fetch('/fixture-stats').then(r=>r.json()).then(data=>window.recoveryFixtureStats=data);true`);
  return waitFor('本地验收统计', 'window.recoveryFixtureStats', value => value !== null);
}
try {
  ab(['set', 'viewport', '1280', '920']); ab(['open', ready.origin + '/agent.html']);
  const initial = await waitFor('异常任务恢复入口', state, value => value.status === 'unknown' && value.buttonVisible && value.output.includes(ready.partial));
  check('异常任务显示恢复任务状态按钮', initial.buttonText === '恢复任务状态');
  check('异常任务保留已收到正文并阻止重复提交', initial.output.includes(ready.partial) && initial.submitDisabled);
  ab(['screenshot', path.join(output, 'recovery-before.png')]);
  ab(['click', '#recoverAgentTask']);
  const recovered = await waitFor('状态恢复并保留正文', state, value => value.status === 'failed' && !value.buttonVisible && value.output.includes(ready.partial));
  check('点击后解除核对状态且保留正文', recovered.status === 'failed' && recovered.output.includes(ready.partial));
  const after = await stats();
  check('恢复释放占位且不重新提交任务或调用模型', after.recoveries === 1 && after.releasedLeases === 1 && after.submissions === 0 && after.modelRequests === 0);
  ab(['screenshot', path.join(output, 'recovery-after.png')]);
  ab(['reload']); await waitFor('刷新保留已恢复状态和正文', state, value => value.status === 'failed' && value.output.includes(ready.partial));
  check('刷新后仍保留正文和已恢复状态', !evalJson(state).buttonVisible);
  ab(['click', '#newAgentTask']);
  ab(['fill', '#agentPrompt', '新的本地验收任务']);
  await waitFor('新任务可提交', state, value => !value.submitDisabled);
  check('输入后新任务提交按钮可用', !evalJson(state).submitDisabled);
  ab(['click', '#submitAgentTask']);
  await waitFor('新任务已完成', state, value => value.status === 'completed' && value.output.includes('新任务可以正常提交'));
  const final = await stats();
  check('新任务确实可提交且恢复过程没有重复调用', final.submissions === 1 && final.recoveries === 1 && final.modelRequests === 0);
  ab(['screenshot', path.join(output, 'recovery-new-task.png')]);
} catch (error) {
  check('异常恢复浏览器验收流程', false, error.stack);
} finally {
  fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify({ checks: results, modelRequests: 0, isolatedLocalBrowser: true }, null, 2));
  ab(['close'], { allowFail: true }); fixture.kill('SIGTERM');
}
console.log(`${results.length - failures()}/${results.length} passed; ${output}`);
if (failures()) process.exitCode = 1;
