// AutoGlow 2 - Readiness
// The line centered in the app header: ready for a game, or what still blocks effects (on every page).

import { api } from '../core/api.js';
import { h } from '../core/dom.js';

const POLL_MS = 10000;
const AUTODARTS_URL = 'https://play.autodarts.com';

const STEPS = {
  controller: { label: 'Add a WLED controller', href: '/setup/controllers' },
  autodarts: { label: 'Connect Autodarts', href: '/setup/connection' },
  lighting: { label: 'Choose effects for your events', href: '/lighting' }
};

let inflight = false;

// What still blocks effects, in the order to fix it. Empty list = only a game is missing.
function missingForEffects(status = {}, checklist = {}) {
  const done = id => checklist.steps?.find(s => s.id === id)?.done;
  const devices = status.devices || [];
  const autodarts = status.autodarts || {};
  const missing = [];
  if (!done('controller')) {
    missing.push({ text: 'Add a WLED controller', href: STEPS.controller.href });
  } else if (!devices.some(d => d.enabled && (d.online || d.streaming))) {
    const dev = devices.find(d => d.enabled);
    missing.push({ text: dev ? `${dev.name || dev.ip} is offline` : 'Enable a WLED controller', href: STEPS.controller.href });
  }
  if (!autodarts.connected) {
    missing.push({ text: 'AutoGlow Bridge extension not connected', href: STEPS.autodarts.href });
  }
  if (!done('lighting')) missing.push({ text: 'No effects switched on yet', href: STEPS.lighting.href });
  if (status.engine && !status.engine.running) missing.push({ text: 'AutoGlow engine is stopped' });
  return missing;
}

// Shown centered in the app header on every page
function renderReadiness(status, checklist) {
  const host = document.getElementById('hubReadiness');
  if (!host) return;
  const missing = missingForEffects(status, checklist);
  const { engine = {}, autodarts = {} } = status;
  const startMatch = !autodarts.match_active && h('a', { class: 'ui-btn ui-btn-sm header-ready-start', href: AUTODARTS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Start a match');
  host.hidden = false;
  host.dataset.tone = missing.length ? 'warn' : 'ok';
  if (missing.length) {
    // Keep the list open across refreshes while the user reads it
    const wasOpen = host.querySelector('details')?.open || false;
    host.replaceChildren(
      h('details', { class: 'header-ready-missing', open: wasOpen || null },
        h('summary', {},
          h('span', { class: 'status-dot', dataset: { tone: 'warn' } }),
          h('span', { class: 'header-ready-title' }, missing.length === 1 ? '1 thing missing' : `${missing.length} things missing`)
        ),
        h('ul', { class: 'header-ready-list' }, missing.map(item =>
          h('li', {}, item.href
            ? h('a', { href: item.href, 'data-link': true, onclick: e => { e.currentTarget.closest('details').open = false; } }, item.text)
            : h('span', {}, item.text))))
      ),
      startMatch
    );
    return;
  }
  const note = autodarts.match_active ? ''
    : engine.power_state === 'off' ? 'Lights are off and wake when a game starts'
    : engine.power_state === 'dimmed' ? 'Lights are dimmed and wake when a game starts'
    : '';
  host.replaceChildren(
    h('span', { class: 'status-dot', dataset: { tone: 'ok' } }),
    h('span', { class: 'header-ready-text' },
      h('span', { class: 'header-ready-title' }, autodarts.match_active ? 'Ready. Effects are running' : 'Ready. Waiting for a game to start'),
      note && h('span', { class: 'header-ready-note' }, note)
    ),
    startMatch
  );
}

async function refreshReadiness() {
  if (inflight || document.hidden) return;
  inflight = true;
  try {
    const [status, checklist] = await Promise.all([
      api.get('/api/hub/status', { timeout: 10000 }),
      api.get('/api/setup/checklist')
    ]);
    renderReadiness(status, checklist);
  } catch (err) {
    // An unreachable backend is already shown by the connection banner
    if (err.code !== 'NETWORK') console.warn('[AutoGlow] Readiness refresh failed:', err);
  } finally {
    inflight = false;
  }
}

export function initReadiness() {
  refreshReadiness();
  setInterval(refreshReadiness, POLL_MS);
  document.addEventListener('visibilitychange', refreshReadiness);
}
