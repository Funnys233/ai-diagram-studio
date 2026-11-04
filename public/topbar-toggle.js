(() => {
  'use strict';
  const key = 'diagram-studio.topbar-collapsed';
  const root = document.documentElement;
  root.classList.add('topbar-toggle-ready');
  let collapsed = false;
  try { collapsed = localStorage.getItem(key) === 'true'; } catch { /* 当前页面仍可切换。 */ }
  root.classList.toggle('topbar-collapsed', collapsed);

  function init() {
    const header = document.querySelector('.topbar, .chat-topbar');
    if (!header) return;
    const pane = document.getElementById('aiPane');
    const workspace = document.getElementById('workspace');
    header.id ||= 'workspaceTopbar';
    const button = document.createElement('button');
    button.id = 'topbarToggle';
    button.className = 'topbar-toggle';
    button.type = 'button';
    button.setAttribute('aria-controls', [header.id, pane?.id].filter(Boolean).join(' '));
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path class="focus-enter" d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/><path class="focus-leave" d="M3 8h5V3m13 5h-5V3M3 16h5v5m13-5h-5v5"/></svg>';
    function render() {
      root.classList.toggle('topbar-collapsed', collapsed);
      if (pane) pane.hidden = collapsed;
      workspace?.classList.toggle('ai-pane-collapsed', collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      button.title = pane
        ? (collapsed ? '恢复菜单与 AI 面板' : '一键隐藏菜单与 AI 面板')
        : (collapsed ? '展开顶部菜单' : '收起顶部菜单');
      button.setAttribute('aria-label', button.title);
      if (collapsed) {
        header.querySelectorAll('details[open]').forEach(menu => { menu.open = false; });
        pane?.querySelectorAll('details[open]').forEach(menu => { menu.open = false; });
        if (header.contains(document.activeElement) || pane?.contains(document.activeElement)) button.focus();
      }
    }
    button.addEventListener('click', () => {
      collapsed = !collapsed;
      render();
      try { localStorage.setItem(key, String(collapsed)); } catch { /* 当前页面仍可切换。 */ }
    });
    window.addEventListener('storage', event => {
      if (event.key === key || event.key === null) {
        collapsed = event.key === key && event.newValue === 'true';
        render();
      }
    });
    document.body.appendChild(button);
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
