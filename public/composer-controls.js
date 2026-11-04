(function () {
  'use strict';
  let picker;
  const glyph = '<svg class="model-glyph" viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="4" width="12" height="12" rx="3"/><path d="M7 1v3m6-3v3M7 16v3m6-3v3M1 7h3m-3 6h3m12-6h3m-3 6h3M8 8h4v4H8Z"/></svg>';
  window.DiagramModelPicker = {
    sync(select) {
      if (!picker) picker = create(select);
      picker.sync();
    },
  };
  function create(select) {
    const wrap = select.parentElement;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'model-select'; button.id = 'chatModelSelectBtn';
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', 'chatModelDropdown');
    button.innerHTML = glyph + '<span class="model-select-copy"><span class="model-select-names"></span><span class="model-select-source"></span></span><span class="caret" aria-hidden="true">⌄</span>';
    const menu = document.createElement('div'); menu.className = 'model-dropdown'; menu.id = 'chatModelDropdown'; menu.hidden = true; menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', '选择模型');
    menu.innerHTML = '<div class="model-menu-heading">选择模型<span>用于下一条消息</span></div><input class="model-search" type="search" placeholder="搜索模型…" aria-label="搜索模型" autocomplete="off"><div class="model-groups"></div>';
    wrap.append(button, menu); select.hidden = true;
    const search = menu.querySelector('input'), groups = menu.querySelector('.model-groups');
    const name = button.querySelector('.model-select-names'), source = button.querySelector('.model-select-source');
    function close(focus = false) { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); }
    function render() {
      groups.replaceChildren();
      const query = search.value.trim().toLocaleLowerCase(), sections = new Map();
      const options = [...select.options].sort((a, b) => Number(b.dataset.group === '免费模型') - Number(a.dataset.group === '免费模型'));
      for (const option of options) {
        if (option.disabled || !option.value || !`${option.textContent} ${option.dataset.modelId || ''} ${option.dataset.providerName || ''} ${option.dataset.group || ''}`.toLocaleLowerCase().includes(query)) continue;
        const group = option.dataset.group || '其他模型';
        if (!sections.has(group)) {
          const section = document.createElement('div'); section.className = 'model-group';
          const title = document.createElement('div'); title.className = 'model-group-title'; title.textContent = group;
          section.append(title); groups.append(section); sections.set(group, section);
        }
        const row = document.createElement('button'); row.type = 'button'; row.className = 'model-option'; row.classList.toggle('active', option.selected); row.setAttribute('aria-pressed', String(option.selected));
        const copy = document.createElement('span'); copy.className = 'model-option-copy';
        const label = document.createElement('span'); label.className = 'model-option-name'; label.textContent = option.dataset.name || option.textContent;
        const id = document.createElement('span'); id.className = 'model-option-id'; id.textContent = [option.dataset.modelId, option.dataset.providerName || option.dataset.source].filter(Boolean).join(' · '); row.title = id.textContent;
        copy.append(label, id); const check = document.createElement('span'); check.className = 'model-check'; check.textContent = option.selected ? '✓' : '';
        row.append(copy, check); row.onclick = () => {
          if (select.disabled) return;
          select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); close(true);
        };
        sections.get(group).append(row);
      }
      if (!sections.size) { const empty = document.createElement('div'); empty.className = 'model-empty'; empty.textContent = '没有匹配的模型'; groups.append(empty); }
    }
    function open() { if (select.disabled) return; search.value = ''; render(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); search.focus(); }
    button.onclick = () => menu.hidden ? open() : close();
    button.addEventListener('keydown', event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); } });
    search.addEventListener('input', render);
    menu.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target === search) { event.preventDefault(); groups.querySelector('button')?.focus(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Escape') { event.stopPropagation(); close(true); return; }
      const rows = [...groups.querySelectorAll('button')], index = rows.indexOf(document.activeElement);
      if (!rows.length) return;
      rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
    });
    document.addEventListener('click', event => { if (!wrap.contains(event.target)) close(); });
    wrap.addEventListener('focusout', event => { if (!wrap.contains(event.relatedTarget)) close(); });
    return { sync() {
      const option = select.selectedOptions[0];
      name.textContent = option?.dataset.name || option?.textContent || '选择模型';
      source.textContent = option?.dataset.source || '模型';
      button.title = option?.textContent || '选择模型'; button.disabled = select.disabled;
      if (select.disabled) close(); else if (!menu.hidden) render();
      window.DiagramComposerSummary.sync();
    } };
  }
  function closeSettings(details, focus = false) {
    details.open = false;
    const extra = details.querySelector('.composer-extra'); if (extra) extra.open = false;
    for (const menu of details.querySelectorAll('.model-dropdown')) {
      if (menu.id === 'chatModelDropdown') menu.hidden = true;
      else menu.classList.add('hidden');
    }
    details.querySelector('.model-select')?.setAttribute('aria-expanded', 'false');
    if (focus) details.querySelector('summary').focus();
  }
  window.DiagramComposerSummary = {
    sync() {
      const details = document.querySelector('.composer-settings');
      if (!details) return;
      const model = details.querySelector('.model-select-names')?.textContent || '选择模型';
      const slider = details.querySelector('.reasoning-slider');
      const effort = slider?.querySelector('.rs-value')?.textContent || '默认';
      const off = /关/.test(details.querySelector('#thinkingLabel,#thinkingToggleLabel')?.textContent || '');
      details.querySelector('.compose-summary-model').textContent = model;
      details.querySelector('.compose-summary-effort').textContent = off ? '思考关' : effort === '未配置' ? '无强度' : effort;
      details.classList.toggle('is-max', !!slider?.classList.contains('is-max') && !off);
      details.querySelector('.compose-summary-effort').style.color = off ? '' : slider?.style.getPropertyValue('--rs-value-color') || '';
      details.querySelector('summary').title = `${model} · ${off ? '思考关' : effort}，点击调整模型与思考设置`;
    },
  };
  for (const details of document.querySelectorAll('.composer-settings')) {
    details.querySelector('.composer-panel-close')?.addEventListener('click', () => closeSettings(details, true));
    details.addEventListener('toggle', () => { if (!details.open) closeSettings(details); });
  }
  document.addEventListener('click', event => {
    for (const details of document.querySelectorAll('.composer-settings[open]')) if (!event.composedPath().includes(details)) closeSettings(details);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    for (const details of document.querySelectorAll('.composer-settings[open]')) closeSettings(details, true);
  });
})();
