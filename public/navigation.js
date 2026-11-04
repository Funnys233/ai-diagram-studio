(function () {
  'use strict';
  const nav = document.getElementById('workspaceNav');
  if (!nav) return;
  const menus = new Set();
  function closeExcept(current) {
    for (const menu of menus) if (menu !== current) menu.open = false;
  }
  function register(menu) {
    if (menus.has(menu)) return;
    menus.add(menu);
    const summary = menu.querySelector(':scope > summary');
    summary.setAttribute('aria-expanded', String(menu.open));
    // Close siblings before the native details toggle, including rapid clicks.
    summary.addEventListener('click', () => closeExcept(menu));
    menu.addEventListener('toggle', () => {
      summary.setAttribute('aria-expanded', String(menu.open));
      if (menu.open) closeExcept(menu);
    });
  }
  nav.querySelectorAll('.nav-menu').forEach(register);
  window.DiagramNavigation = { register };
  document.addEventListener('click', e => {
    const current = e.target.closest('#workspaceNav .nav-menu');
    closeExcept(current);
    if (e.target.closest('.nav-action:not(:disabled)')) closeExcept(null);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const current = [...menus].find(menu => menu.open);
    if (current) {
      closeExcept(null);
      current.querySelector(':scope > summary').focus();
    }
  });
  // A click inside the embedded editor does not bubble into this document.
  window.addEventListener('blur', () => {
    if (document.activeElement?.tagName === 'IFRAME') closeExcept(null);
  });
})();
