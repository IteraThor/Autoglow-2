// AutoGlow 2 - Settings page: every field is a draft until the single Save button writes it.
// Discard (or leaving the page and choosing Discard) puts everything back to what is saved.

import { setLightingMode } from '../components/mode-switch.js';
import { appStore } from '../core/store.js';
import { router } from '../core/router.js';
import { toast } from '../core/toast.js';

const PIN_FIELDS = ['pinCurrentInput', 'pinNewInput', 'pinConfirmInput'];
const $ = id => document.getElementById(id);

let draftMode = null;      // engine picked on the page, null while it matches the saved one
let removePin = false;     // "Remove PIN" armed, applied on Save
let saving = false;

const savedMode = () => appStore.get().lightingMode;
const pinValue = id => $(id)?.value ?? '';

function timersChanged() {
  if (!window.readPowerDraft || !window.appState) return false;
  const draft = window.readPowerDraft();
  const saved = window.appState;
  return (
    draft.inactivity_timeout_enabled !== (saved.inactivity_timeout_enabled ?? true) ||
    draft.inactivity_timeout_minutes !== (saved.inactivity_timeout_minutes ?? 5) ||
    draft.idle_power_off_enabled !== (saved.idle_power_off_enabled ?? true) ||
    draft.idle_power_off_minutes !== (saved.idle_power_off_minutes ?? 30) ||
    draft.disconnect_udp_on_match_end !== (saved.disconnect_udp_on_match_end ?? false)
  );
}

const modeChanged = () => draftMode !== null && draftMode !== savedMode();
const pinChanged = () => removePin || PIN_FIELDS.some(id => pinValue(id) !== '');

export const isDirty = () => timersChanged() || modeChanged() || pinChanged();

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
  if (typeof window.renderPowerTab === 'function') window.renderPowerTab();
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
    if (timersChanged()) {
      const previous = { ...window.appState };
      Object.assign(window.appState, window.readPowerDraft(), { auto_connect_udp_on_game_start: true });
      if (await window.saveAllConfig({ quiet: true })) {
        window.renderPowerTab();
      } else {
        window.appState = Object.assign(window.appState, previous);
        ok = false;
      }
    }
    if (ok && modeChanged()) {
      ok = await setLightingMode(draftMode, { quiet: true });
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

async function confirmLeave() {
  const choice = await window.choiceDialog({
    title: 'Unsaved changes',
    body: 'You changed settings that are not saved yet. Save them, or discard to go back to the saved values.',
    choices: [
      { value: 'stay', label: 'Keep editing' },
      { value: 'discard', label: 'Discard', danger: true },
      { value: 'save', label: 'Save', primary: true }
    ]
  });
  if (choice === 'save') return save();
  if (choice === 'discard') {
    reset();
    return true;
  }
  return false;
}

export function initSettings() {
  window.settingsPage = { save, reset, isDirty };
  window.settingsDraftMode = () => draftMode;

  router.addLeaveGuard((from) => (from.pane === 'tab-settings' && isDirty() ? confirmLeave() : true));
  window.addEventListener('beforeunload', event => {
    if (isDirty()) event.preventDefault();
  });

  const pane = $('tab-settings');
  pane.addEventListener('input', refresh);
  pane.addEventListener('change', refresh);
  document.querySelectorAll('#modeSwitch [data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      draftMode = btn.dataset.mode === savedMode() ? null : btn.dataset.mode;
      refresh();
    });
  });
  $('btnRemovePin')?.addEventListener('click', () => {
    removePin = !removePin;
    refresh();
  });
  $('btnSettingsSave').addEventListener('click', save);
  $('btnSettingsDiscard').addEventListener('click', reset);

  // The engine can also change elsewhere (another browser); follow it unless the user is mid-edit
  appStore.subscribe(s => s.lightingMode, () => {
    if (draftMode === savedMode()) draftMode = null;
    refresh();
  });
  refresh();
}
