// AutoGlow 2 - Page router
// One table maps every URL to a view (rail item), an optional sub-view (tab) and the pane that shows it.
// Older links are redirected to their canonical page. Back/Forward work through popstate.

import { appStore } from './store.js';

export const VIEWS = [
  { id: 'hub', label: 'Hub', path: '/hub', pane: 'tab-dashboard' },
  {
    id: 'setup', label: 'Setup', path: '/setup',
    subs: [
      // /setup/controllers/<ip> opens one controller's page (route.param)
      { id: 'controllers', label: 'Controllers', pane: 'tab-devices', detail: true },
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
  { id: 'settings', label: 'Settings', path: '/settings', pane: 'tab-settings' }
];

const ALIASES = {
  '/': '/hub', '/index.html': '/hub', '/home': '/hub', '/dashboard': '/hub',
  '/devices': '/setup/controllers', '/wled-devices': '/setup/controllers',
  '/autodarts': '/setup/connection', '/autodarts-account': '/setup/connection',
  '/matrix': '/lighting/matrix', '/event-matrix': '/lighting/matrix',
  '/simulator': '/lighting/flow', '/led-simulator': '/lighting/flow',
  '/power': '/settings', '/power-timers': '/settings', '/idle': '/settings', '/idle-mode': '/settings',
  '/updates': '/settings', '/updates-backups': '/settings', '/backups': '/settings'
};

function defaultSub(view) {
  if (view.id === 'lighting') {
    const mode = appStore.get().lightingMode;
    return view.subs.find(s => s.mode === mode) || view.subs[0];
  }
  return view.subs[0];
}

// Turn any path into { view, sub, param, pane, path } with path being the canonical URL
export function resolve(rawPath) {
  const clean = (rawPath || '/').toLowerCase().replace(/\/+$/, '') || '/';
  const path = ALIASES[clean] || clean;
  const [, viewId, subId, rawParam] = path.split('/');
  const view = VIEWS.find(v => v.id === viewId) || VIEWS[0];
  if (!view.subs) return { view, sub: null, param: null, pane: view.pane, path: view.path };
  // Lighting always shows the engine selected in Settings
  const sub = view.id === 'lighting' ? defaultSub(view) : view.subs.find(s => s.id === subId) || defaultSub(view);
  const param = sub.detail && sub.id === subId && rawParam ? decodeURIComponent(rawParam) : null;
  const subPath = `${view.path}/${sub.id}`;
  return { view, sub, param, pane: sub.pane, path: param ? `${subPath}/${encodeURIComponent(param)}` : subPath };
}

function pathForPane(paneId) {
  for (const view of VIEWS) {
    if (view.pane === paneId) return view.path;
    const sub = view.subs?.find(s => s.pane === paneId);
    if (sub) return `${view.path}/${sub.id}`;
  }
  return '/hub';
}

// A page can veto leaving it: guard(fromRoute, toRoute) returns true to allow, or a promise of true/false
const leaveGuards = [];

// Lighting-page tests leave the lights in a test state; going idle again is the server's job
function endLightingTest() {
  fetch('/api/test/end', { method: 'POST', keepalive: true }).catch(() => {});
}

function enter(route, replace) {
  const previous = appStore.get().route;
  if (previous?.view.id === 'lighting' && route.view.id !== 'lighting') endLightingTest();
  if (route.path !== location.pathname) {
    history[replace ? 'replaceState' : 'pushState']({ path: route.path }, '', route.path);
  }
  appStore.set({ route });
  // Rendering a pane is still owned by the classic app.js
  window.activatePane(route.pane);
  return route;
}

export function navigate(path, { replace = false, fromHistory = false } = {}) {
  const route = resolve(path);
  const current = appStore.get().route;
  if (leaveGuards.length && current && current.path !== route.path) {
    const verdicts = leaveGuards.map(guard => guard(current, route));
    if (verdicts.some(verdict => verdict !== true)) {
      Promise.all(verdicts).then(all => all.every(v => v === true)).then(ok => {
        if (ok) enter(route, replace);
        // Back/Forward already changed the URL; put it back
        else if (fromHistory) history.pushState({ path: current.path }, '', current.path);
      });
      return current;
    }
  }
  return enter(route, replace);
}

export const router = {
  navigate,
  resolve,
  showPane: paneId => navigate(pathForPane(paneId)),
  addLeaveGuard(fn) { leaveGuards.push(fn); },
  start() {
    window.addEventListener('pagehide', () => {
      if (appStore.get().route?.view.id === 'lighting') navigator.sendBeacon('/api/test/end');
    });
    window.addEventListener('popstate', () => navigate(location.pathname, { replace: true, fromHistory: true }));
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
