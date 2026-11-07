// AutoGlow 2 - Settings page: every field is a draft until the single Save button writes it.
// Discard (or leaving the page and choosing Discard) puts everything back to what is saved.

import { confirmLegacyMatrix, setLightingMode } from '../components/mode-switch.js';
import { appStore } from '../core/store.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';
import { confirmLeave } from './lighting-guard.js';

const PIN_FIELDS = ['pinCurrentInput', 'pinNewInput', 'pinConfirmInput'];
const $ = id => document.getElementById(id);

let draftMode = null;      // engine picked on the page, null while it matches the saved one
let removePin = false;     // "Remove PIN" armed, applied on Save
let saving = false;

const savedMode = () => appStore.get().lightingMode;
const pinValue = id => $(id)?.value ?? '';

const modeChanged = () => draftMode !== null && draftMode !== savedMode();
const pinChanged = () => removePin || PIN_FIELDS.some(id => pinValue(id) !== '');

export const isDirty = () => modeChanged() || pinChanged();

function renderMode() {
  const active = draftMode ?? savedMode();
  document.querySelectorAll('#modeSwitch [data-mode]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === active));
    btn.disabled = saving;
  });
}

function renderRemove() {
  const btn = $('btnRemovePin');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(removePin));
  btn.textContent = removePin ? 'PIN will be removed on save' : 'Remove PIN';
  // New-PIN fields make no sense while removing
  ['pinNewInput', 'pinConfirmInput'].forEach(id => { if ($(id)) $(id).disabled = removePin; });
}

function refresh() {
  renderMode();
  renderRemove();
  const dirty = isDirty();
  $('settingsSaveBar')?.classList.toggle('dirty', dirty);
  if ($('settingsSaveNote')) $('settingsSaveNote').textContent = dirty ? 'Unsaved changes' : 'No unsaved changes';
  if ($('btnSettingsSave')) $('btnSettingsSave').disabled = !dirty || saving;
  if ($('btnSettingsDiscard')) $('btnSettingsDiscard').disabled = !dirty || saving;
}

// Put every field back to the saved value
export function reset() {
  draftMode = null;
  removePin = false;
  PIN_FIELDS.forEach(id => { if ($(id)) $(id).value = ''; });
  refresh();
}

// Returns an error message, or null when the PIN fields are fine
function pinProblem() {
  if (!pinChanged()) return null;
  const enabled = window.isPinEnabled?.();
  if (enabled && !pinValue('pinCurrentInput').trim()) return 'Enter your current PIN.';
  if (removePin) return null;
  const next = pinValue('pinNewInput').trim();
  if (!next) return 'Enter a new PIN.';
  if (next !== pinValue('pinConfirmInput').trim()) return 'PIN confirmation does not match.';
  return null;
}

// Resolves true when everything that changed was saved
export async function save() {
  if (saving || !isDirty()) return true;
  const problem = pinProblem();
  if (problem) {
    toast.error(problem);
    return false;
  }
  if (removePin && !await window.confirmDialog({
    title: 'Remove the access PIN?',
    body: 'Anyone on your network will be able to control AutoGlow.',
    confirmLabel: 'Remove PIN',
    danger: true
  })) return false;

  saving = true;
  refresh();
  let ok = true;
  try {
    if (modeChanged()) {
      ok = await setLightingMode(draftMode, { quiet: true, confirmed: true });
      if (ok) draftMode = null;
    }
    if (ok && pinChanged()) {
      ok = await window.savePinSettings(removePin);
      if (ok) {
        removePin = false;
        PIN_FIELDS.forEach(id => { if ($(id)) $(id).value = ''; });
      }
    }
  } finally {
    saving = false;
    refresh();
  }
  if (ok) toast.success('Settings saved');
  return ok;
}

const LEAVE_BODY = 'You changed settings that are not saved yet. Save them, or discard to go back to the saved values.';

// Interface size: a per-browser view preference, so it applies at once instead of waiting for Save
const SCALE_KEY = 'autoglow.uiScale';

function currentScale() {
  try { return parseFloat(localStorage.getItem(SCALE_KEY)) || 1; } catch { return 1; }
}

function applyScale(scale) {
  document.documentElement.style.setProperty('--ui-scale', String(scale));
  try { localStorage.setItem(SCALE_KEY, String(scale)); } catch { /* private window: this visit only */ }
  document.querySelectorAll('#uiScaleSwitch [data-scale]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(parseFloat(btn.dataset.scale) === scale));
  });
}

// Flow Matrix chart direction: also per browser; the Flow Matrix reads it each time it draws
const FLOW_VIEW_KEY = 'autoglow_flow_view';

function applyFlowView(view) {
  try { localStorage.setItem(FLOW_VIEW_KEY, view); } catch { /* private window: this visit only */ }
  document.querySelectorAll('#flowViewSwitch [data-view]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.view === view));
  });
}

function currentFlowView() {
  try { return localStorage.getItem(FLOW_VIEW_KEY) === 'horizontal' ? 'horizontal' : 'vertical'; } catch { return 'vertical'; }
}

// Offline controllers in Lighting's segment bar: also per browser; Lighting reads it each time it draws
const OFFLINE_KEY = 'autoglow_show_offline';

function applyOffline(choice) {
  try { localStorage.setItem(OFFLINE_KEY, choice); } catch { /* private window: this visit only */ }
  document.querySelectorAll('#offlineSwitch [data-offline]').forEach(btn => {
    btn.setAttribute('aria-pressed', String(btn.dataset.offline === choice));
  });
}

function currentOffline() {
  try { return localStorage.getItem(OFFLINE_KEY) === 'show' ? 'show' : 'hide'; } catch { return 'hide'; }
}

export function initSettings() {
  window.settingsPage = { save, reset, isDirty };
  window.settingsDraftMode = () => draftMode;

  router.addLeaveGuard((from) => (from.pane === 'tab-settings' && isDirty()
    ? confirmLeave({ body: LEAVE_BODY, save, discard: reset })
    : true));
  window.addEventListener('beforeunload', event => {
    if (isDirty()) event.preventDefault();
  });

  const pane = $('tab-settings');
  pane.addEventListener('input', refresh);
  pane.addEventListener('change', refresh);
  document.querySelectorAll('#modeSwitch [data-mode]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      const current = draftMode ?? savedMode();
      // Picking the legacy engine needs a yes to the "not supported" warning first
      if (mode === 'matrix' && current !== 'matrix' && !await confirmLegacyMatrix()) return;
      draftMode = mode === savedMode() ? null : mode;
      refresh();
    });
  });
  $('btnRemovePin')?.addEventListener('click', () => {
    removePin = !removePin;
    refresh();
  });
  document.querySelectorAll('#uiScaleSwitch [data-scale]').forEach(btn => {
    btn.addEventListener('click', () => applyScale(parseFloat(btn.dataset.scale)));
  });
  applyScale(currentScale());
  document.querySelectorAll('#flowViewSwitch [data-view]').forEach(btn => {
    btn.addEventListener('click', () => applyFlowView(btn.dataset.view));
  });
  applyFlowView(currentFlowView());
  document.querySelectorAll('#offlineSwitch [data-offline]').forEach(btn => {
    btn.addEventListener('click', () => applyOffline(btn.dataset.offline));
  });
  applyOffline(currentOffline());
  $('btnSettingsSave').addEventListener('click', save);
  $('btnSettingsDiscard').addEventListener('click', reset);

  // The engine can also change elsewhere (another browser); follow it unless the user is mid-edit
  appStore.subscribe(s => s.lightingMode, () => {
    if (draftMode === savedMode()) draftMode = null;
    refresh();
  });
  refresh();
}
