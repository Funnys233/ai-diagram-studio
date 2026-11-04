(() => {
  'use strict';
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const format = value => value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function resetTime(value, weekly) {
    const date = new Date(value);
    if (!value || !Number.isFinite(date.getTime())) return '恢复时间暂未知';
    const options = { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false };
    if (weekly) { options.month = 'numeric'; options.day = 'numeric'; }
    return new Intl.DateTimeFormat('zh-CN', options).format(date) + ' 恢复（北京时间）';
  }
  function create(host) {
    if (!host) return null;
    host.replaceChildren(); host.classList.add('quota-meter');
    const membership = element('div', undefined, 'qm-membership'); membership.hidden = true;
    const badge = element('span', '', 'qm-member-badge'), expiry = element('span', '', 'qm-member-expiry'); membership.append(badge, expiry); host.append(membership);
    const rows = {};
    for (const [key, label] of [['free', '全站免费 · 今日'], ['weekly', '我的周额度']]) {
      const row = element('div', undefined, 'qm-pool'); row.dataset.pool = key;
      const heading = element('div', undefined, 'qm-heading');
      const name = element('span', label, 'qm-label');
      const current = element('span', '当前', 'qm-current'); current.hidden = true;
      const value = element('span', '读取中…', 'qm-value');
      const track = element('div', undefined, 'qm-track'); track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', label); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100');
      const fill = element('span', undefined, 'qm-fill'); track.appendChild(fill);
      const note = element('span', '正在读取额度…', 'qm-note');
      heading.append(name, current, value); row.append(heading, track, note); host.appendChild(row);
      rows[key] = { row, current, value, track, fill, note };
    }
    const status = element('p', '本站额度，与 ChatGPT 官方用量分别计算。', 'qm-status'); status.setAttribute('role', 'status');
    host.appendChild(status);
    let snapshot = null, selected = null, failed = false;
    function select(selection) {
      selected = selection;
      const providerId = selected?.providerId || '';
      const source = selected?.source || (providerId.startsWith('personal:') ? 'personal' : providerId.startsWith('platform:') ? 'platform' : providerId.startsWith('chatgpt') ? 'chatgpt' : '');
      const personal = source === 'personal';
      const free = !personal && Array.isArray(snapshot?.free?.models) && snapshot.free.models.some(model => model.providerId === providerId && model.modelId === selected?.modelId);
      const pool = !selected || personal || providerId === 'mock' ? '' : free ? 'free' : ['platform', 'chatgpt'].includes(source) ? 'weekly' : '';
      for (const key of ['free', 'weekly']) { rows[key].row.classList.toggle('is-current', pool === key); rows[key].current.hidden = pool !== key; }
      status.classList.toggle('is-error', failed);
      status.textContent = failed ? snapshot ? '额度更新失败，当前显示上次结果。' : '额度暂不可用，请稍后刷新。' : snapshot?.membership?.plan==='trial' ? '体验用户仅支持三个全站免费模型，共用每日次数。' : personal ? '当前使用个人 API，仅统计调用，不扣以上额度。' : '本站额度，与 ChatGPT 官方用量分别计算。';
    }
    function paint(key, used, limit, resetAt, reserved = 0) {
      const view = rows[key];
      if (!number(used) || !number(limit) || limit <= 0 || !number(reserved)) {
        view.value.textContent = '暂不可用'; view.note.textContent = '未能读取额度'; view.track.removeAttribute('aria-valuenow'); view.track.setAttribute('aria-valuetext', '额度未知'); view.fill.style.width = '0%'; view.row.classList.add('is-unknown'); return;
      }
      const percent = Math.min(100, (used + reserved) / limit * 100);
      view.row.classList.remove('is-unknown'); view.row.classList.toggle('is-exhausted', used + reserved >= limit);
      view.value.textContent = `${format(used)} / ${format(limit)} ${key === 'free' ? '次' : '点'}`;
      view.track.setAttribute('aria-valuenow', String(Math.round(percent * 10) / 10));
      view.track.setAttribute('aria-valuetext', view.value.textContent + (reserved ? `，另预留 ${format(reserved)} 点` : ''));
      view.fill.style.width = percent + '%';
      view.note.textContent = `${reserved ? `另预留 ${format(reserved)} 点 · ` : ''}${resetTime(resetAt, key === 'weekly')}`;
      view.row.title = view.note.textContent;
    }
    return {
      render(usage, selection = selected) {
        snapshot = usage; failed = false;
        const member = usage?.membership; membership.hidden = !member;
        if (member) { badge.textContent = member.name || '普通用户'; badge.dataset.plan = member.plan; const term = member.expired ? '原会员已到期' : !['trial','free'].includes(member.plan) && member.expiresAt ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(member.expiresAt)) + ' 到期' : '每周额度'; expiry.textContent = member.plan==='trial' ? '仅三个全站免费模型' : (number(usage?.weekly?.remainingPoints) ? '剩余 ' + format(usage.weekly.remainingPoints) + ' 点 · ' : '') + term; }
        rows.weekly.row.hidden=member?.plan==='trial';
        paint('free', usage?.free?.calls, usage?.free?.limit, usage?.free?.resetAt);
        paint('weekly', usage?.weekly?.usedPoints, usage?.weekly?.limitPoints, usage?.weekly?.resetAt, usage?.weekly?.reservedPoints ?? 0);
        select(selection);
      },
      select,
      error() { failed = true; if (!snapshot) { for (const key of ['free', 'weekly']) paint(key); } select(selected); },
      local(text) { host.replaceChildren(element('p', text, 'qm-local')); },
    };
  }
  window.DiagramQuotaMeter = { create };
})();
