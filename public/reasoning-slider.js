/* Visual color/energy mapping adapted from dsh-codex-effort-slider (MIT).
 * Copyright (c) 2026 dsh-codex-effort-slider contributors.
 * Source: https://github.com/Microqian2th/dsh-codex-effort-slider/tree/d1bb67b20bc19d44be7d7694ffca92a6f2fcbe9b
 * License: third-party/dsh-codex-effort-slider-LICENSE.txt
 * Native range input handles pointer capture and accessibility; server preferences
 * are committed once on release, rather than sending a write on every boundary.
 */
(function () {
  'use strict';
  const controls = new WeakMap();
  const BOOST_KEY = 'diagramai.reasoning.visualBoost';
  const clamp = value => Math.max(0, Math.min(1, value));
  const mix = (from, to, amount) => `rgb(${from.map((value, index) => Math.round(value + (to[index] - value) * clamp(amount))).join(',')})`;
  function create(select) {
    const root = document.createElement('div'); root.className = 'reasoning-slider';
    root.innerHTML = '<div class="rs-head"><button class="rs-boost" type="button" aria-pressed="false" aria-label="加速动效" title="仅控制界面流动效果"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 1 3.5 9h4L7 15l5.5-8h-4Z"/></svg></button><span class="rs-caption"><span class="rs-cost-hint" hidden>会更快消耗额度</span><output class="rs-value" aria-live="polite"></output></span><span class="rs-meta"><button class="rs-reset" type="button" title="恢复默认强度" aria-label="恢复默认强度">↺</button></span></div><div class="rs-control"><div class="rs-track" aria-hidden="true"><span class="rs-fill"></span><span class="rs-energy"><i></i></span><span class="rs-stars"><span class="rs-starfield"></span></span></div><div class="rs-ticks" aria-hidden="true"></div><span class="rs-knob" aria-hidden="true"></span><input class="rs-input" type="range" min="0" max="1" step="1" value="0" aria-label="思考强度"></div>';
    select.insertAdjacentElement('afterend', root); select.hidden = true;
    const input = root.querySelector('.rs-input'), output = root.querySelector('.rs-value');
    const reset = root.querySelector('.rs-reset'), ticks = root.querySelector('.rs-ticks');
    const costHint = root.querySelector('.rs-cost-hint');
    const stars = root.querySelector('.rs-starfield'), boost = root.querySelector('.rs-boost');
    let boosted = false;
    try { boosted = localStorage.getItem(BOOST_KEY) === '1'; } catch { /* 本次交互仍可使用 */ }
    // Each particle has its own depth, phase and speed. Matching copies one
    // track-width apart keep every independent loop seamless. Randomize once,
    // never while painting or saving a preference, so particles don't jump.
    for (let index = 0; index < 22; index++) {
      const star = document.createElement('i'); star.className = 'rs-star';
      const depth = Math.random(), duration = 8.5 - depth * 4.7 + Math.random() * .8;
      star.style.top = `${12 + Math.random() * 76}%`;
      star.style.setProperty('--rs-brightness', String(.38 + depth * .5));
      star.style.setProperty('--rs-size', `${1.3 + depth * 1.6 + Math.random() * .35}px`);
      star.style.setProperty('--rs-duration', `${duration}s`);
      star.style.setProperty('--rs-delay', `${-Math.random() * duration}s`);
      const phase = Math.random();
      for (let tile = 0; tile < 2; tile++) {
        const dot = document.createElement('i'); dot.style.left = `${(phase + tile) * 100}%`; star.appendChild(dot);
      }
      stars.appendChild(star);
    }
    input.id = select.id + 'Range'; output.setAttribute('for', input.id);
    costHint.id = select.id + 'CostHint';
    let options = [], signature = '', highestActive = false, hintTimer = 0;
    const settings = root.closest('.composer-settings');
    function hideHint() {
      clearTimeout(hintTimer); hintTimer = 0;
      costHint.hidden = true; root.classList.remove('is-noticing');
    }
    function showHint() {
      clearTimeout(hintTimer);
      costHint.hidden = false; root.classList.add('is-noticing');
      hintTimer = setTimeout(hideHint, 2000);
    }
    settings?.addEventListener('toggle', () => {
      if (settings.open && highestActive) showHint();
      else hideHint();
    });
    const label = option => (option?.textContent.replace(/^强度[·：:]?/, '').trim() || '默认').split('·')[0];
    function paint(position) {
      const maximum = options.length - 1;
      const index = Math.max(0, Math.min(maximum, Math.round(position)));
      const pct = maximum > 0 ? index / maximum : 0;
      const level = options[index]?.value || '';
      const gold = level === 'high' || level === 'xhigh' || level === 'max';
      const deepGold = level === 'xhigh' || level === 'max';
      const highest = maximum > 0 && index === maximum;
      const inactive = maximum <= 0 || select.dataset.thinkingOff === 'true';
      const energy = index > 0 && !inactive ? .35 + .65 * pct : 0;
      const enteredHighest = highest && !inactive && !highestActive;
      highestActive = highest && !inactive;
      if (!highestActive) {
        hideHint(); input.removeAttribute('aria-describedby');
      } else {
        input.setAttribute('aria-describedby', costHint.id);
        if (enteredHighest && (!settings || settings.open)) showHint();
      }
      root.classList.toggle('is-busy', input.disabled && !inactive);
      root.style.setProperty('--rs-offset', `calc(${14 - pct * 28}px + ${pct * 100}%)`);
      root.style.setProperty('--rs-energy', String(energy));
      root.style.setProperty('--rs-start-color', highestActive ? '#bfe9e7' : gold ? '#edd395' : '#e1efd8');
      root.style.setProperty('--rs-end-color', highestActive ? '#c7b6e4' : gold ? deepGold ? '#b98128' : '#d4a449' : mix([210, 230, 199], [180, 208, 164], pct));
      root.style.setProperty('--rs-value-color', inactive ? '#667069' : highestActive ? '#70568e' : gold ? deepGold ? '#8f6316' : '#96681c' : '#5c7a4f');
      root.dataset.tone = highestActive ? 'prismatic' : gold ? 'gold' : 'green';
      root.dataset.energy = energy > 0 ? '1' : '0';
      root.classList.toggle('is-boosted', boosted);
      boost.setAttribute('aria-pressed', String(boosted));
      root.dataset.position = pct.toFixed(4);
      root.classList.toggle('is-max', maximum > 0 && index === maximum);
      root.classList.toggle('is-default', index === 0);
      const valueLabel = maximum > 0 ? label(options[index]) : '未配置';
      if (output.textContent !== valueLabel) output.textContent = valueLabel;
      input.setAttribute('aria-valuenow', String(index));
      input.setAttribute('aria-valuetext', output.textContent + (maximum > 0 && index === maximum ? '，当前模型最高档' : ''));
      reset.hidden = index === 0;
      [...ticks.children].forEach((tick, mark) => tick.classList.toggle('is-passed', mark < index));
      // Saving disables the input, not the starfield. Paint never rewrites timing.
      [...stars.children].forEach(star => { star.style.visibility = highest && !inactive ? 'visible' : 'hidden'; });
      window.DiagramComposerSummary?.sync();
    }
    function sync() {
      options = Array.from(select.options);
      const maximum = Math.max(0, options.length - 1);
      const index = Math.max(0, options.findIndex(option => option.value === select.value));
      input.max = String(Math.max(1, maximum)); input.value = String(index);
      input.setAttribute('aria-valuemax', String(maximum));
      input.disabled = select.disabled || !maximum; reset.disabled = input.disabled;
      root.classList.toggle('is-disabled', input.disabled); root.title = select.title;
      const next = options.map(option => option.value).join('|');
      if (signature !== next) {
        signature = next; ticks.replaceChildren();
        options.forEach((_, mark) => { const tick = document.createElement('i'); tick.style.left = `${maximum ? mark / maximum * 100 : 0}%`; ticks.appendChild(tick); });
      }
      paint(index);
    }
    function commit(index) {
      if (select.disabled) { sync(); return; }
      const option = options[index];
      input.value = String(index); paint(index);
      if (!option || select.value === option.value) return;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    input.addEventListener('input', () => { if (select.disabled) sync(); else paint(Number(input.value)); });
    input.addEventListener('change', () => commit(Math.round(Number(input.value))));
    input.addEventListener('keydown', event => {
      const index = Math.round(Number(input.value)), maximum = options.length - 1;
      let next;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, index - 1);
      else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = Math.min(maximum, index + 1);
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = maximum;
      else return;
      event.preventDefault(); commit(next);
    });
    boost.addEventListener('click', () => {
      boosted = !boosted;
      try { localStorage.setItem(BOOST_KEY, boosted ? '1' : '0'); } catch { /* 仅保存当前页视觉状态 */ }
      paint(Number(input.value));
    });
    input.addEventListener('pointercancel', sync);
    reset.addEventListener('click', () => commit(0));
    select.addEventListener('change', sync);
    return { sync };
  }
  window.DiagramReasoningSlider = {
    sync(select) {
      if (!controls.has(select)) controls.set(select, create(select));
      controls.get(select).sync();
    },
  };
})();
