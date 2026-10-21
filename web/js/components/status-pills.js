// AutoGlow 2 - Header status lights for Autodarts, the LED stream and board power
// Each light opens a small popover with one line of detail and the action that fixes or changes it.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { navigate } from '../core/router.js';
import { appStore } from '../core/store.js';
import { toast } from '../core/toast.js';

const POLL_MS = 5000;

const PILLS = {
  autodarts(state) {
    const ad = state.autodarts;
    if (!ad || !ad.connected) {
      return { tone: 'off', detail: 'Chrome extension not connected', actions: [['Open setup', () => navigate('/setup/connection')]] };
    }
    if (ad.source === 'extension' && !ad.tab_attached) {
      return { tone: 'warn', detail: 'No Autodarts game tab open', actions: [['Open setup', () => navigate('/setup/connection')]] };
    }
    return { tone: 'ok', detail: ad.match_active ? 'Match running' : 'Connected, waiting for a match', actions: [] };
  },
  stream(state) {
    const live = state.protocolMode === 'udp';
    return {
      tone: live ? 'ok' : 'off',
      detail: live ? 'Streaming effects to the controllers' : 'Idle, controllers show their own preset',
      actions: [[live ? 'Stop stream' : 'Start stream', () => window.toggleProtocolMode()]]
    };
  },
  power(state) {
    const power = state.powerState || 'on';
    const actions = [['Power settings', () => navigate('/power')]];
    if (power !== 'on') actions.unshift(['Wake', wake]);
    return {
      tone: power === 'on' ? 'ok' : (power === 'dimmed' ? 'warn' : 'off'),
      detail: { on: 'Lights on', dimmed: 'Dimmed after inactivity', off: 'Lights off' }[power] || power,
      actions
    };
  }
};

const LABELS = { autodarts: 'Autodarts', stream: 'Stream', power: 'Power' };

let popover = null;
let openPill = null;

async function wake() {
  try {
    await api.post('/api/power/test_wake');
    appStore.set({ powerState: 'on' });
  } catch (err) {
    toast.error(err, { onRetry: wake });
  }
}

function closePopover() {
  popover?.remove();
  popover = null;
  openPill?.setAttribute('aria-expanded', 'false');
  openPill = null;
}

function popoverContent(key) {
  const info = PILLS[key](appStore.get());
  return [
    h('div', { class: 'pill-popover-title' }, LABELS[key]),
    h('div', { class: 'pill-popover-detail' }, info.detail),
    info.actions.length > 0 && h('div', { class: 'pill-popover-actions' },
      info.actions.map(([label, run]) => h('button', {
        class: 'ui-btn ui-btn-sm',
        type: 'button',
        onclick: () => { closePopover(); run(); }
      }, label))
    )
  ].filter(Boolean);
}

function openPopover(pill, key) {
  const wasOpen = openPill === pill;
  closePopover();
  if (wasOpen) return;
  popover = h('div', { class: 'pill-popover', role: 'dialog', 'aria-label': LABELS[key] }, popoverContent(key));
  document.body.append(popover);
  const rect = pill.getBoundingClientRect();
  popover.style.top = `${rect.bottom + 6}px`;
  popover.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  openPill = pill;
  pill.setAttribute('aria-expanded', 'true');
}

// Pills are created once and updated in place, so an open popover survives status updates
function render() {
  const host = document.getElementById('statusPills');
  if (!host) return;
  const state = appStore.get();
  for (const key of Object.keys(PILLS)) {
    let pill = host.querySelector(`[data-pill="${key}"]`);
    if (!pill) {
      pill = h('button', { class: 'status-pill', type: 'button', dataset: { pill: key }, 'aria-haspopup': 'dialog', 'aria-expanded': 'false' },
        h('span', { class: 'status-dot' }), h('span', { class: 'status-label' }, LABELS[key]));
      pill.addEventListener('click', event => {
        event.stopPropagation();
        openPopover(pill, key);
      });
      host.append(pill);
    }
    const info = PILLS[key](state);
    pill.dataset.tone = info.tone;
    pill.title = `${LABELS[key]}: ${info.detail}`;
  }
  if (openPill && popover) popover.replaceChildren(...popoverContent(openPill.dataset.pill));
}

async function poll() {
  if (document.hidden) return;
  try {
    const data = await api.get('/api/status', { timeout: 4000 });
    appStore.set({
      lightingMode: data.lighting_mode,
      protocolMode: data.protocol_mode,
      powerState: data.power_state,
      autodarts: data.autodarts
    });
  } catch (err) {
    // The connection banner already reports an unreachable backend
  }
}

export function initStatusPills() {
  appStore.subscribe(s => JSON.stringify(s.autodarts ?? null), render);
  appStore.subscribe(s => s.protocolMode, render);
  appStore.subscribe(s => s.powerState, render);
  render();
  document.addEventListener('click', event => {
    if (popover && !popover.contains(event.target)) closePopover();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closePopover(); });
  appStore.subscribe(s => s.route, closePopover);
  document.addEventListener('visibilitychange', poll);
  poll();
  setInterval(poll, POLL_MS);
}
