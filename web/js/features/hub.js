// AutoGlow 2 - Hub
// First-run checklist, the match in progress, and per controller: health, its profile and Wake / Dim / Off.

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { appStore } from '../core/store.js';
import { MODE_LABELS } from '../components/mode-switch.js';
import { toast } from '../core/toast.js';

const POLL_MS = 10000;
const AUTODARTS_URL = 'https://play.autodarts.com';
const HIDE_CHECKLIST_KEY = 'autoglow_hide_checklist';

const STEPS = {
  controller: { label: 'Add a WLED controller', href: '/setup/controllers' },
  autodarts: { label: 'Connect Autodarts', href: '/setup/connection' },
  lighting: { label: 'Choose effects for your events', href: '/lighting' }
};

const ACTIONS = {
  wake: { label: 'Wake', path: '/api/power/test_wake', done: 'Lights on' },
  dim: { label: 'Dim', path: '/api/power/test_dim', done: 'Lights dimmed' },
  off: { label: 'Off', path: '/api/power/test_off', done: 'Lights off' }
};

let inflight = false;
let refreshTimer = null;

const isVisible = () => !document.hidden && document.getElementById('tab-dashboard')?.classList.contains('active');

function checklistHidden() {
  try { return localStorage.getItem(HIDE_CHECKLIST_KEY) === '1'; } catch (err) { return false; }
}

function hideChecklist() {
  try { localStorage.setItem(HIDE_CHECKLIST_KEY, '1'); } catch (err) { /* private mode: hide for this visit */ }
  document.getElementById('hubChecklist').hidden = true;
}

function renderChecklist(checklist) {
  const host = document.getElementById('hubChecklist');
  if (!host) return;
  host.hidden = !checklist || checklist.complete || checklistHidden();
  if (host.hidden) return;
  host.replaceChildren(
    h('div', { class: 'card-head' },
      h('h2', { class: 'card-title' }, 'Get started'),
      h('button', { class: 'ui-btn ui-btn-sm ui-btn-quiet', type: 'button', onclick: hideChecklist }, 'Hide')
    ),
    h('ol', { class: 'hub-steps' }, checklist.steps.map((step, i) => {
      const meta = STEPS[step.id] || { label: step.id, href: '/hub' };
      return h('li', { class: 'hub-step', dataset: { done: String(step.done) } },
        h('span', { class: 'hub-step-mark', 'aria-hidden': 'true' }, step.done ? '✓' : String(i + 1)),
        step.done
          ? h('span', { class: 'hub-step-label' }, meta.label)
          : h('a', { class: 'hub-step-label', href: meta.href, 'data-link': true }, meta.label),
        h('span', { class: 'visually-hidden' }, step.done ? '(done)' : '(to do)')
      );
    }))
  );
}

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
  } else if (autodarts.tab_attached === false) {
    missing.push({ text: 'Open play.autodarts.com in your browser', href: STEPS.autodarts.href });
  }
  if (!done('lighting')) missing.push({ text: 'No effects switched on yet', href: STEPS.lighting.href });
  if (status.engine && !status.engine.running) missing.push({ text: 'AutoGlow engine is stopped', href: '/hub' });
  return missing;
}

function renderReadiness(status, checklist) {
  const host = document.getElementById('hubReadiness');
  if (!host) return;
  const missing = missingForEffects(status, checklist);
  const { engine = {}, autodarts = {} } = status;
  const startMatch = h('a', { class: 'ui-btn ui-btn-sm hub-ready-start', href: AUTODARTS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Start a match');
  host.hidden = false;
  host.dataset.tone = missing.length ? 'warn' : 'ok';
  if (missing.length) {
    host.replaceChildren(
      h('div', { class: 'hub-ready-head' },
        h('span', { class: 'status-dot', dataset: { tone: 'warn' } }),
        h('h2', { class: 'card-title' }, missing.length === 1 ? '1 thing missing' : `${missing.length} things missing`),
        startMatch
      ),
      h('ul', { class: 'hub-steps' }, missing.map(item =>
        h('li', { class: 'hub-step' }, h('a', { class: 'hub-step-label', href: item.href, 'data-link': true }, item.text))))
    );
    return;
  }
  const note = autodarts.match_active ? 'Match running'
    : engine.power_state === 'off' ? 'Lights are off and wake when a game starts'
    : engine.power_state === 'dimmed' ? 'Lights are dimmed and wake when a game starts'
    : '';
  host.replaceChildren(
    h('div', { class: 'hub-ready-head' },
      h('span', { class: 'status-dot', dataset: { tone: 'ok' } }),
      h('h2', { class: 'card-title' }, autodarts.match_active ? 'Ready. Effects are running' : 'Ready. Waiting for a game to start'),
      !autodarts.match_active && startMatch
    ),
    note && h('p', { class: 'hub-ready-note' }, note)
  );
}

let idleDeadline = null;

function renderIdleCountdown() {
  const row = document.getElementById('hubIdleRow');
  if (idleDeadline === null) { row.hidden = true; return; }
  const secs = Math.max(0, Math.round((idleDeadline - Date.now()) / 1000));
  row.hidden = false;
  document.getElementById('hubIdleIn').textContent = secs === 0 ? 'any moment' : secs <= 60 ? '< 1 min' : `${Math.ceil(secs / 60)} min`;
}

function renderMatch(engine = {}, autodarts = {}) {
  const waiting = !autodarts.match_active && engine.power_state === 'on' && engine.dim_in_seconds != null;
  idleDeadline = waiting ? Date.now() + engine.dim_in_seconds * 1000 : null;
  renderIdleCountdown();
  const players = autodarts.players || [];
  document.getElementById('hubMatchState').textContent = autodarts.match_active ? 'Match running' : 'No match';
  document.getElementById('hubMatchState').dataset.live = String(!!autodarts.match_active);
  document.getElementById('hubMatchPlayers').replaceChildren(...(players.length
    ? players.map((name, i) => h('span', { class: i === autodarts.active_player_idx ? 'hub-player is-active' : 'hub-player' }, name))
    : ['—']));
  document.getElementById('hubMatchLast').textContent = engine.last_event || '—';
  const isFlow = engine.lighting_mode === 'flow';
  if (engine.lighting_mode) document.getElementById('hubEngine').textContent = MODE_LABELS[isFlow ? 'flow' : 'matrix'];
  document.getElementById('hubPhaseRow').hidden = !isFlow;
  document.getElementById('hubMatchPhase').textContent = engine.flow_phase || 'idle';
}

function deviceState(dev) {
  if (!dev.enabled) return { tone: 'off', text: 'Disabled' };
  if (dev.streaming) return { tone: 'ok', text: 'Streaming' };
  if (!dev.online) return { tone: 'error', text: 'Offline' };
  if (dev.warnings?.length) return { tone: 'warn', text: 'Needs attention' };
  return { tone: 'ok', text: 'Online' };
}

const PLAYING_LABELS = { effects: 'Playing: Effects', idle: 'Playing: Idle', off: 'Lights off' };

function renderDevices(devices = []) {
  const host = document.getElementById('hubDevices');
  if (!host) return;
  if (!devices.length) {
    host.replaceChildren(h('div', { class: 'hub-empty' }, 'No controllers yet. ', h('a', { href: '/setup/controllers', 'data-link': true }, 'Add one')));
    return;
  }
  host.replaceChildren(...devices.map(dev => {
    const state = deviceState(dev);
    return h('div', { class: 'hub-device' },
      h('div', { class: 'hub-device-row' },
        h('span', { class: 'status-dot', dataset: { tone: state.tone } }),
        h('span', { class: 'hub-device-name' }, dev.name || dev.ip),
        PLAYING_LABELS[dev.playing] && h('span', { class: 'hub-device-playing', dataset: { playing: dev.playing } }, PLAYING_LABELS[dev.playing]),
        h('span', { class: 'hub-device-state' }, state.text),
        h('a', { class: 'ctl-ip', href: `http://${dev.ip}`, target: '_blank', rel: 'noopener noreferrer' }, dev.ip),
        dev.enabled && h('div', { class: 'hub-device-actions', role: 'group', 'aria-label': `Lights on ${dev.name || dev.ip}` },
          Object.entries(ACTIONS).map(([key, action]) =>
            h('button', { class: 'ui-btn ui-btn-sm', type: 'button', onclick: () => runAction(key, dev) }, action.label)))
      ),
      dev.enabled && dev.online && dev.warnings?.length > 0 && h('ul', { class: 'hub-warnings' }, dev.warnings.map(w => h('li', {}, w)))
    );
  }));
}

export async function refreshHub() {
  if (inflight || !isVisible()) return;
  inflight = true;
  try {
    const [status, checklist] = await Promise.all([
      api.get('/api/hub/status', { timeout: 10000 }),
      api.get('/api/setup/checklist')
    ]);
    renderReadiness(status, checklist);
    renderChecklist(checklist);
    renderMatch(status.engine, status.autodarts);
    renderDevices(status.devices);
  } catch (err) {
    // An unreachable backend is already shown by the connection banner
    if (err.code !== 'NETWORK') console.warn('[AutoGlow] Hub refresh failed:', err);
  } finally {
    inflight = false;
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshHub, 1500);
}

async function runAction(key, dev) {
  const name = dev.name || dev.ip;
  if (key === 'off' && !await confirmDialog({
    title: `Turn off ${name}?`,
    body: 'The RGB strip and light strip on this controller switch off.',
    confirmLabel: 'Turn off',
    danger: true
  })) return;
  try {
    const data = await api.post(ACTIONS[key].path, { ip: dev.ip });
    if (data.status === 'warning') toast.warning(data.message);
    else toast.success(`${ACTIONS[key].done} on ${name}`);
  } catch (err) {
    toast.error(err, { onRetry: () => runAction(key, dev) });
  }
  refreshHub();
}

function onTelemetry(msg) {
  if (!isVisible()) return;
  if (msg.type === 'game_event' || msg.type === 'event') {
    document.getElementById('hubMatchLast').textContent = msg.display_event || msg.event || '—';
  }
  if (['game_event', 'event', 'protocol_state', 'power_state', 'lighting_mode_changed', 'game_flow_state'].includes(msg.type)) {
    scheduleRefresh();
  }
}

export function initHub() {
  window.renderHub = refreshHub;
  window.onHubTelemetry = onTelemetry;
  appStore.subscribe(s => s.lightingMode, mode => {
    if (mode) document.getElementById('hubEngine').textContent = MODE_LABELS[mode];
  });
  setInterval(refreshHub, POLL_MS);
  setInterval(renderIdleCountdown, 5000);
  document.addEventListener('visibilitychange', refreshHub);
}
