// AutoGlow 2 - App shell: rail highlight, sub-tabs of the current page and the "Not playing" banner

import { h } from '../core/dom.js';
import { appStore } from '../core/store.js';

function renderRail(route) {
  document.querySelectorAll('#appRail [data-view]').forEach(link => {
    if (link.dataset.view === route.view.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function renderViewBar(route) {
  const bar = document.getElementById('viewBar');
  if (!bar) return;
  bar.replaceChildren();
  // Lighting has no tabs: the engine is chosen in Settings
  const subs = route.view.id === 'lighting' ? null : route.view.subs;
  bar.hidden = !subs;
  if (!subs) return;
  bar.append(h('nav', { class: 'view-tabs', 'aria-label': route.view.label },
    subs.map(sub => h('a', {
      class: 'view-tab',
      href: `${route.view.path}/${sub.id}`,
      'data-link': true,
      'aria-current': sub.id === route.sub.id ? 'page' : null
    }, sub.label))
  ));
}

function render() {
  const { route } = appStore.get();
  if (!route) return;
  renderRail(route);
  renderViewBar(route);
}

export function initShell() {
  appStore.subscribe(s => s.route, render);
}
