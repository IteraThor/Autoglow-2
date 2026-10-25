// AutoGlow 2 - Header mode switch: chooses what the engine plays (Event Matrix or Flow Matrix)
// The switch changes only after the server confirms; a failed switch leaves the old mode selected.

import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { appStore } from '../core/store.js';
import { toast } from '../core/toast.js';

export const MODE_LABELS = { matrix: 'Event Matrix', flow: 'Flow Matrix' };

let pending = null;

// Resolves true when the engine now plays the mode. quiet skips the success toast (the Settings page reports its own).
export async function setLightingMode(mode, { quiet = false } = {}) {
  const target = mode === 'flow' ? 'flow' : 'matrix';
  if (pending) return false;
  if (appStore.get().lightingMode === target) return true;
  pending = target;
  render();
  try {
    await api.post('/api/flow/mode', { mode: target });
    if (window.appState) window.appState.lighting_mode = target;
    appStore.set({ lightingMode: target });
    if (!quiet) toast.success(`${MODE_LABELS[target]} is playing`);
    return true;
  } catch (err) {
    toast.error(err, { onRetry: () => setLightingMode(target) });
    return false;
  } finally {
    pending = null;
    render();
  }
}

function render() {
  // The Settings page shows its draft choice until it is saved
  const active = window.settingsDraftMode?.() ?? appStore.get().lightingMode;
  document.querySelectorAll('#modeSwitch [data-mode]').forEach(btn => {
    const mode = btn.dataset.mode;
    btn.setAttribute('aria-pressed', String(mode === active));
    btn.toggleAttribute('aria-busy', mode === pending);
    btn.disabled = !!pending;
  });
}

export function initModeSwitch() {
  appStore.subscribe(s => s.lightingMode, () => {
    render();
    // On the Lighting page, show the workspace of the engine that now plays
    const route = appStore.get().route;
    if (route?.view.id === 'lighting' && route.sub.mode !== appStore.get().lightingMode) navigate('/lighting', { replace: true });
  });
  render();
}
