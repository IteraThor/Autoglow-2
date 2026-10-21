// AutoGlow 2 - App shell: rail highlight, sub-tabs of the current page and the "Not playing" banner

import { h } from '../core/dom.js';
import { appStore } from '../core/store.js';
import { MODE_LABELS, setLightingMode } from './mode-switch.js';

function renderRail(route) {
  document.querySelectorAll('#appRail [data-view]').forEach(link => {
    if (link.dataset.view === route.view.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function renderViewBar(route, playingMode) {
  const bar = document.getElementById('viewBar');
  if (!bar) return;
  bar.replaceChildren();
  bar.hidden = !route.view.subs;
  if (!route.view.subs) return;

  const tabs = h('nav', { class: 'view-tabs', 'aria-label': route.view.label },
    route.view.subs.map(sub => h('a', {
      class: 'view-tab',
      href: `${route.view.path}/${sub.id}`,
      'data-link': true,
      'aria-current': sub.id === route.sub.id ? 'page' : null
    },
    sub.label,
    sub.mode && sub.mode === playingMode && h('span', { class: 'playing-badge' }, 'Playing')
    ))
  );
  bar.append(tabs);

  const notPlaying = route.sub.mode && playingMode && route.sub.mode !== playingMode;
  if (notPlaying) {
    bar.append(h('div', { class: 'not-playing-banner', role: 'status' },
      h('span', { class: 'not-playing-text' }, `Not playing · ${MODE_LABELS[playingMode]} is active`),
      h('button', { class: 'ui-btn ui-btn-primary ui-btn-sm', type: 'button', onclick: () => setLightingMode(route.sub.mode) }, 'Play this')
    ));
  }
  document.querySelector('.main-content')?.toggleAttribute('data-not-playing', !!notPlaying);
}

function render() {
  const { route, lightingMode } = appStore.get();
  if (!route) return;
  renderRail(route);
  renderViewBar(route, lightingMode);
}

export function initShell() {
  appStore.subscribe(s => s.route, render);
  appStore.subscribe(s => s.lightingMode, render);
}
