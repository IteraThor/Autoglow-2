// AutoGlow 2 - Header mode switch: chooses what the engine plays (Event Matrix or Flow Matrix)
// The switch changes only after the server confirms; a failed switch leaves the old mode selected.

import { api } from '../core/api.js';
import { navigate } from '../core/router.js';
import { appStore } from '../core/store.js';
import { toast } from '../core/toast.js';

export const MODE_LABELS = { matrix: 'Event Matrix', flow: 'Flow Matrix' };

let pending = null;

export async function setLightingMode(mode) {
  const target = mode === 'flow' ? 'flow' : 'matrix';
  if (pending || appStore.get().lightingMode === target) return;
  pending = target;
  render();
  try {
    await api.post('/api/flow/mode', { mode: target });
    if (window.appState) window.appState.lighting_mode = target;
    appStore.set({ lightingMode: target });
    toast.success(`${MODE_LABELS[target]} is playing`);
    // On the Lighting page, show the workspace that now plays
    if (appStore.get().route?.view.id === 'lighting') navigate(`/lighting/${target}`);
  } catch (err) {
    toast.error(err, { onRetry: () => setLightingMode(target) });
  } finally {
    pending = null;
    render();
  }
}

function render() {
  const active = appStore.get().lightingMode;
  document.querySelectorAll('#modeSwitch [data-mode]').forEach(btn => {
    const mode = btn.dataset.mode;
    btn.setAttribute('aria-pressed', String(mode === active));
    btn.toggleAttribute('aria-busy', mode === pending);
    btn.disabled = !!pending;
  });
}

export function initModeSwitch() {
  document.querySelectorAll('#modeSwitch [data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setLightingMode(btn.dataset.mode));
  });
  appStore.subscribe(s => s.lightingMode, render);
  render();
}
