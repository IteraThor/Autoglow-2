// AutoGlow 2 - Page router
// One table maps every URL to a view (rail item), an optional sub-view (tab) and the pane that shows it.
// Older links are redirected to their canonical page. Back/Forward work through popstate.

import { appStore } from './store.js';

export const VIEWS = [
  { id: 'hub', label: 'Hub', path: '/hub', pane: 'tab-dashboard' },
  {
    id: 'setup', label: 'Setup', path: '/setup',
    subs: [
      { id: 'controllers', label: 'Controllers', pane: 'tab-devices' },
      { id: 'connection', label: 'Autodarts', pane: 'tab-autodarts' }
    ]
  },
  {
    id: 'lighting', label: 'Lighting', path: '/lighting',
    subs: [
      { id: 'matrix', label: 'Event Matrix', pane: 'tab-effects', mode: 'matrix' },
      { id: 'flow', label: 'Flow Matrix', pane: 'tab-simulator', mode: 'flow' }
    ]
  },
  { id: 'power', label: 'Power', path: '/power', pane: 'tab-power' },
  { id: 'settings', label: 'Settings', path: '/settings', pane: 'tab-settings' }
];

const ALIASES = {
  '/': '/hub', '/index.html': '/hub', '/home': '/hub', '/dashboard': '/hub',
  '/devices': '/setup/controllers', '/wled-devices': '/setup/controllers',
  '/autodarts': '/setup/connection', '/autodarts-account': '/setup/connection',
  '/matrix': '/lighting/matrix', '/event-matrix': '/lighting/matrix',
  '/simulator': '/lighting/flow', '/led-simulator': '/lighting/flow',
  '/power-timers': '/power', '/idle': '/power', '/idle-mode': '/power',
  '/updates': '/settings', '/updates-backups': '/settings', '/backups': '/settings'
};

function defaultSub(view) {
  if (view.id === 'lighting') {
    const mode = appStore.get().lightingMode;
    return view.subs.find(s => s.mode === mode) || view.subs[0];
  }
  return view.subs[0];
}

// Turn any path into { view, sub, pane, path } with path being the canonical URL
export function resolve(rawPath) {
  const clean = (rawPath || '/').toLowerCase().replace(/\/+$/, '') || '/';
  const path = ALIASES[clean] || clean;
  const [, viewId, subId] = path.split('/');
  const view = VIEWS.find(v => v.id === viewId) || VIEWS[0];
  if (!view.subs) return { view, sub: null, pane: view.pane, path: view.path };
  const sub = view.subs.find(s => s.id === subId) || defaultSub(view);
  return { view, sub, pane: sub.pane, path: `${view.path}/${sub.id}` };
}

function pathForPane(paneId) {
  for (const view of VIEWS) {
    if (view.pane === paneId) return view.path;
    const sub = view.subs?.find(s => s.pane === paneId);
    if (sub) return `${view.path}/${sub.id}`;
  }
  return '/hub';
}

export function navigate(path, { replace = false } = {}) {
  const route = resolve(path);
  if (route.path !== location.pathname) {
    history[replace ? 'replaceState' : 'pushState']({ path: route.path }, '', route.path);
  }
  appStore.set({ route });
  // Rendering a pane is still owned by the classic app.js
  window.activatePane(route.pane);
  return route;
}

export const router = {
  navigate,
  resolve,
  showPane: paneId => navigate(pathForPane(paneId)),
  start() {
    window.addEventListener('popstate', () => navigate(location.pathname, { replace: true }));
    // Links with data-link navigate without a page load
    document.addEventListener('click', event => {
      const link = event.target.closest('a[data-link]');
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      navigate(link.getAttribute('href'));
    });
    return navigate(location.pathname, { replace: true });
  }
};
