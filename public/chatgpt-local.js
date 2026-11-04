(() => {
  'use strict';
  const mounts = Array.from(document.querySelectorAll('[data-chatgpt-mount]'));
  if (!mounts.length) return;
  let busy = false, poll = null, status = null, session = null;
  const selfHosted = () => status?.mode === 'self-hosted';
  async function request(route, body) {
    const response = await fetch('/api/chatgpt' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session?.csrf ? { 'X-CSRF-Token': session.csrf } : {}) }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || 'ChatGPT 连接暂不可用'); return data;
  }
  function changed() { window.dispatchEvent(new Event('chatgpt-models-changed')); }
  function note(message) { for (const mount of mounts) { const element = mount.querySelector('.chatgpt-note'); if (element) element.textContent = message; } }
  function render() {
    for (const mount of mounts) {
      const select = mount.querySelector('select'); const previous = select.value;
      select.replaceChildren(new Option(selfHosted() ? '尚未导入服务器授权' : '添加新的 ChatGPT 账号', ''));
      for (const account of status.accounts) select.appendChild(new Option(account.label + (!account.connected ? '（已断开）' : !account.planEnabled ? '（未授权额度）' : ''), account.id));
      select.value = mount.dataset.activeId !== (status.activeId || '') ? status.activeId || '' : previous;
      mount.dataset.activeId = status.activeId || '';
      const active = status.accounts.find(a => a.id === status.activeId);
      mount.querySelector('.chatgpt-state').textContent = active?.connected ? active.planEnabled ? '已连接' : '待授权' : '未连接';
      mount.querySelector('.chatgpt-connect').textContent = selfHosted() ? '连接说明' : active?.connected && select.value ? '重新授权' : 'Continue with ChatGPT';
      mount.querySelector('.chatgpt-description').textContent = selfHosted() ? '订阅凭证加密保存在服务器，由你管理；指定用户仅能使用获准的模型。' : '连接自己的 ChatGPT，使用订阅额度。授权仅保存在本机。';
      for (const element of mount.querySelectorAll('button, select')) element.disabled = busy;
      const selected = status.accounts.find(a => a.id === select.value);
      mount.querySelector('.chatgpt-refresh').disabled = busy || !selected?.connected || !selected.planEnabled;
      mount.querySelector('.chatgpt-disconnect').disabled = busy || !selected?.connected;
    }
  }
  async function refreshStatus() { status = await request(''); render(); }
  async function action(callback) {
    if (busy) return; busy = true; render();
    try { await callback(); } catch (error) { note(error.message); }
    finally { busy = false; await refreshStatus().catch(() => {}); }
  }
  async function fetchModels(accountId) {
    note('正在获取此账号可用的模型…');
    const data = await request('/models', { accountId });
    note(data.count ? `已获取 ${data.count} 个模型，可以在模型选择器中使用。` : '账号未返回可展示的模型，请确认订阅与工作区权限。');
    status = data; render(); changed();
  }
  async function start(accountId) {
    if (busy) return;
    const popup = window.open('about:blank', '_blank');
    if (!popup) { note('浏览器阻止了登录窗口，请允许此站点打开弹出窗口后重试。'); return; }
    popup.opener = null;
    await action(async () => {
      try {
        const data = await request('/connect', { accountId: accountId || undefined });
        const url = new URL(data.authorizationUrl); if (url.origin !== 'https://auth.openai.com') throw new Error('无法验证登录地址');
        popup.location.replace(url.href); note('请在新窗口完成官方登录；完成后这里会自动更新。');
        clearInterval(poll); let checking = false;
        poll = setInterval(async () => {
          if (checking) return; checking = true;
          try {
            await refreshStatus();
            if (status.auth.phase !== 'pending') {
              clearInterval(poll); poll = null; note(status.auth.message);
              if (status.auth.phase === 'connected') {
                const active = status.accounts.find(a => a.id === status.activeId);
                if (active?.planEnabled) await action(() => fetchModels(active.id)); else changed();
              }
            }
          } catch { note('暂时无法确认连接状态，请检查本地服务。'); }
          finally { checking = false; }
        }, 2000);
      } catch (error) { popup.close(); throw error; }
    });
  }
  (async () => {
    try {
      session = await (await fetch('/api/auth/session')).json();
      if (session.mode !== 'local' && session.user?.role !== 'admin') return;
      status = await request('');
      for (const mount of mounts) {
        mount.innerHTML = '<details class="chatgpt-panel"><summary><span class="chatgpt-symbol" aria-hidden="true">◎</span><strong>我的 ChatGPT</strong><span class="chatgpt-state">未连接</span><span class="chatgpt-chevron" aria-hidden="true">⌄</span></summary><div class="chatgpt-content"><p class="chatgpt-description">连接自己的 ChatGPT，使用订阅额度。授权仅保存在本机。</p><label class="chatgpt-account-label">账号<select aria-label="ChatGPT 账号"></select></label><div class="chatgpt-actions"><button class="chatgpt-connect" type="button">Continue with ChatGPT</button><button class="chatgpt-refresh" type="button">获取模型</button><button class="chatgpt-disconnect" type="button">断开</button></div><div class="chatgpt-guide" hidden><p>① 在本机打开官方页面，为此服务器单独授权。</p><p>② 由服务器管理员通过 SSH 导入授权文件。</p><p>③ 点击「检查连接」，获取模型后即可对话与绘图。</p><p>本机与云端分别授权；云端负责此连接的后续续期。</p><button type="button" class="chatgpt-check">检查连接</button></div><p class="chatgpt-note" role="status">登录后，绘图和纯对话共用此连接；可用性以账号授权结果为准。</p><a href="https://chatgpt.com/#settings" target="_blank" rel="noopener noreferrer">在 ChatGPT 中管理用量 ↗</a></div></details>';
        mount.hidden = false;
        const select = mount.querySelector('select');
        mount.querySelector('.chatgpt-connect').onclick = () => {
          if (selfHosted()) { const guide = mount.querySelector('.chatgpt-guide'); guide.hidden = !guide.hidden; }
          else start(select.value);
        };
        mount.querySelector('.chatgpt-check').onclick = () => action(async () => {
          await refreshStatus();
          if (status.activeId) await fetchModels(status.activeId);
          else note('服务器尚未导入授权。请先在本机完成官方授权并导入。');
        });
        mount.querySelector('.chatgpt-refresh').onclick = () => action(() => fetchModels(select.value));
        mount.querySelector('.chatgpt-disconnect').onclick = () => action(async () => {
          clearInterval(poll); poll = null;
          const result = await request('/disconnect', { accountId: select.value }); note(result.message); changed();
        });
        select.onchange = () => action(async () => { if (select.value) { await request('/select', { accountId: select.value }); changed(); } });
      }
      render();
      if (selfHosted()) note('绘图与纯对话共用此个人订阅连接，其他用户继续使用各自的 API。');
      if (status.auth.phase === 'error') note(status.auth.message);
    } catch { for (const mount of mounts) mount.hidden = true; }
  })();
  window.addEventListener('pagehide', () => clearInterval(poll));
})();
