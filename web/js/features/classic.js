// AutoGlow 2 - Classic page: the original AutoGlow 1 (local Board Manager API -> WLED over USB)
// On/Off applies at once. Everything else is a draft until Save, like the Settings page.

import { api } from '../core/api.js';
import { h, showFieldError } from '../core/dom.js';
import { appStore } from '../core/store.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
import { confirmLeave } from './lighting-guard.js';

const PANE = 'tab-classic';
const POLL_MS = 2000;
const $ = id => document.getElementById(id);

let saved = null;     // settings as stored on the server
let draft = null;     // settings as edited on the page
let effects = [];
let statusNames = [];
let ports = [];
let pollTimer = null;
let saving = false;

const clone = value => JSON.parse(JSON.stringify(value));
const isDirty = () => !!saved && JSON.stringify(withoutEnabled(draft)) !== JSON.stringify(withoutEnabled(saved));

function withoutEnabled(settings) {
  const { enabled, ...rest } = settings || {};
  return rest;
}

const toHex = rgb => '#' + (rgb || [0, 0, 0]).map(c => Number(c).toString(16).padStart(2, '0')).join('');
const fromHex = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));

// --- rendering ---------------------------------------------------------------

function renderPower() {
  const on = !!saved?.enabled;
  document.querySelectorAll('#classicPower [data-power]').forEach(btn => {
    btn.setAttribute('aria-pressed', String((btn.dataset.power === 'on') === on));
    btn.disabled = saving || !saved;
  });
}

function setLine(id, tone, text) {
  const line = $(id);
  if (!line) return;
  line.replaceChildren(h('span', { class: 'status-dot', 'data-tone': tone, 'aria-hidden': 'true' }), h('span', {}, text));
}

function renderState(state) {
  if (!state || !saved) return;
  if (!saved.enabled) {
    setLine('classicUsbState', 'pending', 'Off');
    setLine('classicBmState', 'pending', 'Off');
  } else {
    if (!state.pyserial) setLine('classicUsbState', 'error', 'pyserial is not installed. Run setup again.');
    else if (state.serial_connected) setLine('classicUsbState', 'ok', `Connected on ${state.port}`);
    else setLine('classicUsbState', 'error', state.serial_error || 'Looking for the ESP32…');
    if (state.board_manager_connected) setLine('classicBmState', 'ok', `Connected to ${saved.board_manager_url}`);
    else setLine('classicBmState', 'error', state.board_manager_error || `Connecting to ${saved.board_manager_url}…`);
  }
  const last = $('classicLastStatus');
  if (last) last.textContent = state.last_status || '—';
  document.querySelectorAll('#classicStatusRows [data-status]').forEach(row => {
    row.classList.toggle('is-current', saved.enabled && row.dataset.status === state.last_status);
  });
}

function renderPorts() {
  const list = $('classicPortList');
  if (!list) return;
  list.replaceChildren(...ports.map(p => h('option', { value: p.device }, `${p.description}${p.esp32 ? ' (ESP32)' : ''}`)));
  const hint = $('classicPortHint');
  if (hint) {
    const found = ports.filter(p => p.esp32).map(p => p.device);
    hint.textContent = found.length
      ? `Leave empty to use the ESP32 found on ${found[0]}.`
      : 'Leave empty to find the ESP32 on its own. None is plugged in right now.';
  }
}

function renderFields() {
  $('classicBmUrl').value = draft.board_manager_url;
  $('classicPort').value = draft.manual_port;
  $('classicBrightness').value = draft.global_brightness;
  $('classicBrightnessValue').textContent = String(draft.global_brightness);
  $('classicStartup').checked = !!draft.startup_animation;
}

function statusRow(name) {
  const look = draft.statuses[name];
  const onChange = () => refresh();
  return h('tr', { dataset: { status: name } },
    h('th', { scope: 'row' }, name),
    h('td', {}, h('input', {
      type: 'checkbox', class: 'classic-check', 'aria-label': `${name} on`, checked: look.enabled,
      onchange: e => { look.enabled = e.target.checked; onChange(); }
    })),
    h('td', {}, h('select', {
      class: 'ui-select', 'aria-label': `${name} effect`,
      onchange: e => { look.fx = Number(e.target.value); onChange(); }
    }, effects.map(fx => h('option', { value: fx.id, selected: fx.id === look.fx }, fx.name)))),
    h('td', {}, h('input', {
      type: 'color', class: 'classic-color', 'aria-label': `${name} color`, value: toHex(look.color),
      oninput: e => { look.color = fromHex(e.target.value); onChange(); }
    })),
    h('td', {}, h('button', {
      type: 'button', class: 'ui-btn ui-btn-quiet', onclick: e => test(name, e.currentTarget)
    }, 'Test'))
  );
}

function renderRows() {
  $('classicStatusRows').replaceChildren(...statusNames.map(statusRow));
}

function refresh() {
  renderPower();
  const dirty = isDirty();
  $('classicSaveBar')?.classList.toggle('dirty', dirty);
  $('classicSaveNote').textContent = dirty ? 'Unsaved changes' : 'No unsaved changes';
  $('btnClassicSave').disabled = !dirty || saving;
  $('btnClassicDiscard').disabled = !dirty || saving;
}

function adopt(data, { keepDraft = false } = {}) {
  saved = data.settings;
  effects = data.effects || effects;
  statusNames = data.status_names || statusNames;
  ports = data.ports || ports;
  if (!keepDraft || !draft) {
    draft = clone(saved);
    renderFields();
    renderRows();
  } else {
    draft.enabled = saved.enabled;
  }
  renderPorts();
  renderState(data.state);
  refresh();
}

// --- actions -----------------------------------------------------------------

async function load({ keepDraft = false } = {}) {
  try {
    adopt(await api.get('/api/classic'), { keepDraft });
  } catch (err) {
    if (!keepDraft) toast.error(`Could not load Classic mode: ${err.message}`);
  }
}

async function setPower(on) {
  if (!saved || saving || saved.enabled === on) return;
  saving = true;
  refresh();
  try {
    adopt(await api.post('/api/classic', { enabled: on }, { timeout: 15000 }), { keepDraft: true });
    toast.success(on ? 'Classic mode is on' : 'Classic mode is off');
  } catch (err) {
    toast.error(err.message);
  } finally {
    saving = false;
    refresh();
  }
}

async function save() {
  if (saving || !isDirty()) return true;
  const { enabled, ...body } = draft;
  saving = true;
  refresh();
  try {
    adopt(await api.post('/api/classic', body, { timeout: 15000 }));
    toast.success('Classic mode saved');
    return true;
  } catch (err) {
    if (err.field === 'board_manager_url') showFieldError($('classicBmUrl'), err.message);
    else toast.error(err.message);
    return false;
  } finally {
    saving = false;
    refresh();
  }
}

function discard() {
  draft = clone(saved);
  renderFields();
  renderRows();
  refresh();
}

async function test(name, button) {
  button.setAttribute('aria-busy', 'true');
  try {
    await api.post('/api/classic/test', {
      status: name, look: draft.statuses[name], global_brightness: draft.global_brightness
    }, { timeout: 10000 });
    toast.success(`${name} is showing`);
  } catch (err) {
    toast.error(err.message);
  } finally {
    button.removeAttribute('aria-busy');
  }
}

// --- page lifecycle ------------------------------------------------------------

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => load({ keepDraft: true }), POLL_MS);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

const LEAVE_BODY = 'You changed Classic mode settings that are not saved yet. Save them, or discard to go back to the saved values.';

export function initClassic() {
  if (!$(PANE)) return;
  window.classicPage = { save, discard, isDirty };

  router.addLeaveGuard(from => (from.pane === PANE && isDirty()
    ? confirmLeave({ body: LEAVE_BODY, save, discard })
    : true));
  window.addEventListener('beforeunload', event => {
    if (isDirty()) event.preventDefault();
  });

  document.querySelectorAll('#classicPower [data-power]').forEach(btn => {
    btn.addEventListener('click', () => setPower(btn.dataset.power === 'on'));
  });
  $('classicBmUrl').addEventListener('input', e => { if (!draft) return; draft.board_manager_url = e.target.value.trim(); refresh(); });
  $('classicPort').addEventListener('input', e => { if (!draft) return; draft.manual_port = e.target.value.trim(); refresh(); });
  $('classicBrightness').addEventListener('input', e => {
    if (!draft) return;
    draft.global_brightness = Number(e.target.value);
    $('classicBrightnessValue').textContent = e.target.value;
    refresh();
  });
  $('classicStartup').addEventListener('change', e => { if (!draft) return; draft.startup_animation = e.target.checked; refresh(); });
  $('btnClassicSave').addEventListener('click', save);
  $('btnClassicDiscard').addEventListener('click', discard);

  appStore.subscribe(s => s.route?.pane, pane => {
    if (pane === PANE) {
      load({ keepDraft: isDirty() });
      startPolling();
    } else {
      stopPolling();
    }
  });
}
