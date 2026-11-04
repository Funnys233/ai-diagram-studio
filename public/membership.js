(() => {
  'use strict';
  const names = { trial: '体验用户', free: '普通用户', pro: 'Pro', max: 'Max' }, day = 86400000;
  const el = (tag, text, cls) => { const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node; };
  const localTime = value => { const date = new Date(value); return new Date(value - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  async function json(request, url, options) { const response = await request(url, options), data = await response.json(); if (!response.ok) throw Error(data.error?.message || '保存失败'); return data; }
  const put = body => ({ method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  function userForm(user, request, saved) {
    const member = user.membership || { plan: 'free', configuredPlan: 'free' };
    const section = el('details', null, 'cloud-membership-edit'); section.dataset.action = 'membership';
    section.append(el('summary', `${member.name || names[member.plan]} · ${member.plan === 'trial' ? '仅三个免费模型' : user.weeklyLimitPoints.toLocaleString('zh-CN') + ' 点/周'}${member.expired ? ' · 原会员已到期' : ''}`));
    const form = el('form', null, 'member-form');
    const planLabel = el('label', '会员等级'), plan = el('select'); plan.name = 'plan'; plan.setAttribute('aria-label', user.username + ' 的会员等级');
    for (const [value, name] of Object.entries(names).filter(([value])=>value!=='trial'||user.role!=='admin')) { const option = el('option', name); option.value = value; plan.append(option); } plan.value = member.plan;
    planLabel.append(plan);
    const expiryLabel = el('label', '到期时间（本地时间）'), expiry = el('input'); expiry.type = 'datetime-local'; expiry.name = 'expiresAt'; expiry.setAttribute('aria-label', user.username + ' 的会员到期时间');
    expiry.value = localTime(member.expiresAt > Date.now() ? member.expiresAt : Date.now() + 30 * day); expiryLabel.append(expiry);
    const controls = el('div', null, 'member-actions'), extend = el('button', '增加 30 天', 'ghost-btn small'), save = el('button', '保存会员', 'ghost-btn small'); extend.type = 'button'; save.type = 'submit';
    extend.onclick = () => { const base = plan.value === member.configuredPlan ? Math.max(Date.now(), new Date(expiry.value).getTime() || 0) : Date.now(); expiry.value = localTime(base + 30 * day); };
    const sync = () => { expiry.disabled = ['trial','free'].includes(plan.value); expiry.required = !expiry.disabled; extend.disabled = expiry.disabled; }; plan.onchange = sync; sync();
    const hint = el('p', user.customWeeklyLimitPoints != null ? '此账号设有特殊额度，修改会员后仍保留；可在下方恢复等级额度。' : '升级、续期不会清空本周已用额度。', 'check-note'); hint.setAttribute('role', 'status');
    controls.append(extend, save); form.append(planLabel, expiryLabel, controls, hint);
    form.onsubmit = async event => { event.preventDefault(); save.disabled = true; try { await json(request, '/api/users/' + user.id + '/membership', put({ plan: plan.value, expiresAt: ['trial','free'].includes(plan.value) ? null : new Date(expiry.value).getTime() })); hint.textContent = '会员已保存。'; await saved(); } catch (error) { hint.textContent = error.message; } finally { save.disabled = false; } };
    section.append(form); return section;
  }
  function settings(request, saved) {
    const section = el('details', null, 'cloud-member-settings'); section.id = 'cloudMemberSettings'; section.append(el('summary', '会员等级额度'));
    const body = el('div'); section.append(body);
    async function refresh() {
      const data = await json(request, '/api/membership'); body.replaceChildren();
      const form = el('form', null, 'member-form'); form.id = 'cloudMemberPlansForm';
      for (const [key, name] of Object.entries(names).filter(([key])=>key!=='trial')) { const label = el('label', name + ' · 每周点数'), input = el('input'); input.type = 'number'; input.min = '1'; input.max = '1000000'; input.step = '1'; input.required = true; input.name = key; input.value = data.plans[key]; input.setAttribute('aria-label', name + ' 默认周额度'); label.append(input); form.append(label); }
      const save = el('button', '保存等级额度', 'ghost-btn small'); save.type = 'submit'; const hint = el('p', '修改后立即生效，保留已用点数；特殊额度账号不受影响。', 'check-note'); hint.setAttribute('role', 'status'); form.append(save, hint);
      form.onsubmit = async event => { event.preventDefault(); save.disabled = true; try { const plans = Object.fromEntries(Object.keys(names).filter(key=>key!=='trial').map(key => [key, Number(form.elements[key].value)])); await json(request, '/api/membership', put({ plans })); hint.textContent = '等级额度已保存。'; await saved(); } catch (error) { hint.textContent = error.message; } finally { save.disabled = false; } };
      body.append(form, el('p', '体验用户：仅三个免费模型；普通用户：增加 Luna；Pro：增加 6.1 Sol、Grok、Claude；Max：再增加 Astra。会员到期自动恢复普通用户。', 'check-note'));
      const audit = el('details', null, 'member-audit'); audit.append(el('summary', '最近调整记录'));
      for (const entry of data.audit.slice(0, 10)) { const action = entry.action === 'delete-user' ? '删除账号（历史用量保留）' : entry.action === 'reset-cards' ? `发放 ${entry.after.granted} 张重置卡，现有 ${entry.after.balance} 张` : entry.action === 'weekly-reset' ? `${entry.after.useCard ? '使用重置卡' : '管理员重置'}，恢复 ${entry.after.restoredPoints} 点` : entry.action === 'membership' ? `会员改为 ${names[entry.after.plan]}` : entry.action === 'plans' ? '调整等级额度' : entry.after == null ? '恢复等级额度' : `特殊额度 ${entry.after} 点/周`; audit.append(el('p', `${new Date(entry.time).toLocaleString('zh-CN')} · ${entry.actorUsername || '管理员'} → ${entry.targetUsername || '全部等级'}：${action}`, 'check-note')); }
      if (!data.audit.length) audit.append(el('p', '暂无调整记录', 'check-note')); body.append(audit);
    }
    section.addEventListener('toggle', () => { if (section.open) refresh().catch(error => { body.textContent = error.message; }); });
    return section;
  }
  window.DiagramMembership = { userForm, settings };
})();
