(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const sourceNames = { platform: '平台模型', personal: '个人 API', chatgpt: 'ChatGPT 订阅' };
  const statusNames = { started: '进行中', success: '成功', failed: '失败', cancelled: '已取消' };
  const format = number => Number(number).toLocaleString('zh-CN');
  const duration = value => value === null ? '未知' : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} 秒`;
  const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
  let account, page = 1, controller, lastReport;
  const quotaMeter = window.DiagramQuotaMeter?.create($('quotaNote'));
  function element(tag, value, className) { const node = document.createElement(tag); if (value !== undefined) node.textContent = value; if (className) node.className = className; return node; }
  function tokens(row, type) {
    const known = row[type + 'Tokens'], unknown = row[type + 'UnknownCalls'];
    return known === null ? '未知' : format(known) + (unknown ? `（${unknown} 次未知）` : '');
  }
  function cacheText(cache) {
    if (!cache || cache.cachedTokens === null) return '缓存未提供';
    return `缓存 ${format(cache.cachedTokens)} token` + (cache.hitRate !== null ? ` · ${cache.hitRate.toLocaleString('zh-CN',{maximumFractionDigits:1})}%` : '') + (cache.unknownCalls ? '（部分记录）' : '');
  }
  function quotaCost(event) {
    const quota = event.quota;
    if (!quota) return '旧记录';
    if (quota.pool === 'free') return '免费池 1 次';
    if (quota.pool === 'personal' || quota.pool === 'catalog') return '只统计';
    if (quota.pool !== 'weekly') return '未知';
    const multiplier = [0.5, 1, 5, 10, 15, 20, 25, 30, 80, 100, 150, 300].includes(quota.modelMultiplier) ? `（×${quota.modelMultiplier}）` : '';
    if (typeof quota.points === 'number' && Number.isFinite(quota.points) && quota.points >= 0) return `${quota.estimated ? '估算 ' : ''}${format(quota.points)} 点${multiplier}`;
    if (typeof quota.reservedPoints === 'number' && Number.isFinite(quota.reservedPoints) && quota.reservedPoints >= 0) return `预留 ${format(quota.reservedPoints)} 点${multiplier}`;
    return event.status === 'started' ? '待结算' : '未知';
  }
  async function request(route, signal) {
    const response = await fetch(route, { signal });
    if (response.status === 401) { location.replace('/login.html?next=%2Fusage.html'); throw new Error('请先登录'); }
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '无法读取用量'); return data;
  }
  function options(id, items, firstLabel) {
    const select = $(id), selected = select.value;
    select.replaceChildren(new Option(firstLabel, ''));
    for (const item of items) select.appendChild(new Option(item.label, item.id));
    if (selected && ![...select.options].some(option => option.value === selected)) select.appendChild(new Option(selected + '（当前范围无记录）', selected));
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }
  function groups(id, rows, label) {
    const host = $(id); host.replaceChildren();
    if (!rows.length) { host.appendChild(element('p', '当前筛选范围暂无调用记录。', 'empty')); return; }
    for (const row of rows) {
      const entry = element('div', undefined, 'group-row');
      entry.append(element('span', label(row), 'group-name'), element('span', `${format(row.calls)} 次`, 'group-count'),
        element('span', `成功 ${row.success} · 失败 ${row.failed} · 取消 ${row.cancelled} · 进行中 ${row.pending} · 输入 ${tokens(row, 'input')} / 输出 ${tokens(row, 'output')} token · ${cacheText(row.cache)} · 平均 ${duration(row.averageElapsedMs)}`, 'group-note'));
      host.appendChild(entry);
    }
  }
  function render(data) {
    lastReport = data;
    options('userId', data.filters.users.map(user => ({ id: user.id, label: user.username })), '全部用户');
    options('modelId', data.filters.models.map(id => ({ id: id || '__catalog__', label: id || '获取模型列表' })), '全部模型');
    $('cards').replaceChildren();
    for (const [title, value, note] of [
      ['调用次数', format(data.summary.calls), `成功 ${data.summary.success} · 失败 ${data.summary.failed} · 取消 ${data.summary.cancelled} · 进行中 ${data.summary.pending}`],
      ['输入 token', data.summary.inputTokens === null ? '未知' : format(data.summary.inputTokens), `${data.summary.inputKnownCalls} 次有返回 · ${data.summary.inputUnknownCalls} 次未知`],
      ['输出 token', data.summary.outputTokens === null ? '未知' : format(data.summary.outputTokens), `${data.summary.outputKnownCalls} 次有返回 · ${data.summary.outputUnknownCalls} 次未知`],
      ['平均耗时', duration(data.summary.averageElapsedMs), '仅统计有完整耗时记录的请求'],
      ['缓存命中 token', data.summary.cache?.cachedTokens == null ? '未提供' : format(data.summary.cache.cachedTokens), data.summary.cache?.knownCalls ? `${data.summary.cache.knownCalls} 次有数据 · ${data.summary.cache.unknownCalls} 次未提供` : '接口未返回或旧记录未保存'],
      ['缓存命中率', data.summary.cache?.hitRate == null ? '未提供' : data.summary.cache.hitRate.toLocaleString('zh-CN',{maximumFractionDigits:1})+'%', '按有缓存数据的输入 token 加权；不改变扣点'],
    ]) { const card = element('article', undefined, 'card'); card.append(element('h2', title), element('strong', value), element('p', note)); $('cards').appendChild(card); }
    groups('sources', data.sources, row => sourceNames[row.id]);
    groups('users', data.users, row => row.label);
    groups('models', data.models, row => row.label || '获取模型列表');
    const maximum = Math.max(1, ...data.daily.map(day => day.calls)); $('daily').replaceChildren();
    for (const day of data.daily) {
      const column = element('div', undefined, 'day'); column.title = `${day.date}（UTC）· ${day.calls} 次`;
      const bar = element('div', undefined, 'day-bar'); bar.style.height = `${Math.max(2, day.calls / maximum * 90)}px`;
      column.append(element('span', String(day.calls), 'day-count'), bar, element('span', day.date.slice(5), 'day-label')); $('daily').appendChild(column);
    }
    $('events').replaceChildren();
    for (const event of data.events) {
      const row = element('tr');
      row.append(element('td', time(event.time)), element('td', event.username));
      const model = element('td', sourceNames[event.source], 'model'); model.appendChild(element('small', event.modelId || '获取模型列表')); row.appendChild(model);
      const status = element('td'); status.appendChild(element('span', statusNames[event.status], 'badge ' + event.status));
      if (event.errorCode) status.appendChild(element('small', event.errorCode)); row.appendChild(status);
      row.append(element('td', event.inputTokens === null ? '未知' : format(event.inputTokens)), element('td', event.outputTokens === null ? '未知' : format(event.outputTokens)), element('td', cacheText(event.cache)), element('td', quotaCost(event)), element('td', duration(event.elapsedMs))); $('events').appendChild(row);
    }
    if (!data.events.length) { const row = element('tr'), cell = element('td', '当前筛选范围暂无调用记录。', 'empty'); cell.colSpan = 9; row.appendChild(cell); $('events').appendChild(row); }
    $('detailCount').textContent = `共 ${format(data.pagination.total)} 条`;
    $('pageLabel').textContent = `${data.pagination.page} / ${data.pagination.pages}`;
    $('previousBtn').disabled = page <= 1; $('nextBtn').disabled = page >= data.pagination.pages;
    $('coverage').textContent = `完整统计自 ${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(data.trackingSince))} 起；此前仅迁移可恢复的调用记录。`;
    $('report').hidden = false;
  }
  async function load() {
    controller?.abort(); const current = new AbortController(); controller = current;
    $('refreshBtn').disabled = true; $('status').className = ''; $('status').textContent = '正在更新…';
    const params = new URLSearchParams({ range: $('range').value, scope: $('scope').value, page: String(page) });
    for (const id of ['userId', 'source', 'modelId']) if ($(id).value) params.set(id, $(id).value);
    try {
      const [data, quota] = await Promise.all([request('/api/usage/report?' + params, current.signal), request('/api/usage', current.signal)]);
      if (controller !== current) return;
      render(data);
      quotaMeter?.render(quota.usage);
      $('status').textContent = `${data.from} 至 ${data.to}（UTC）· ${data.scope === 'subscription' ? '你的订阅被所有授权用户使用的合计' : data.scope === 'all' ? '全站所有来源，每次调用计一次' : '仅显示你的调用记录'}`;
    } catch (error) { if (error.name !== 'AbortError') { $('status').textContent = error.message; $('status').className = 'error'; $('report').hidden = true; quotaMeter?.error(); } }
    finally { if (controller === current) $('refreshBtn').disabled = false; }
  }
  async function boot() {
    try {
      const session = await request('/api/auth/session');
      if (session.mode === 'local') { $('status').textContent = '本地模式没有网站用量统计，请返回绘图工作台。'; $('filters').hidden = true; $('quotaNote').hidden = true; $('refreshBtn').hidden = true; return; }
      if (!session.user) { location.replace('/login.html?next=%2Fusage.html'); return; }
      account = session.user; $('accountName').textContent = account.username;
      const admin = account.role === 'admin'; $('scopeField').hidden = !admin; $('userField').hidden = !admin; $('scope').value = admin ? 'all' : 'mine';
      await load();
    } catch (error) { $('status').textContent = error.message; $('status').className = 'error'; }
  }
  $('filters').addEventListener('submit', event => event.preventDefault());
  $('filters').addEventListener('change', event => { page = 1; if (event.target.id === 'scope') { $('userId').value = ''; $('modelId').value = ''; } $('userField').hidden = account.role !== 'admin' || $('scope').value === 'mine'; load(); });
  $('refreshBtn').onclick = () => load();
  $('previousBtn').onclick = () => { if (page > 1) { page--; load(); } };
  $('nextBtn').onclick = () => { if (lastReport && page < lastReport.pagination.pages) { page++; load(); } };
  window.addEventListener('pagehide', () => controller?.abort());
  boot();
})();
