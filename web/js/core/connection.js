// AutoGlow 2 - Backend connection state
// api() and the telemetry socket report here; one banner shows while AutoGlow is unreachable.

import { h } from './dom.js';
import { appStore } from './store.js';

// A server restart takes about a second; only show the banner for outages longer than that
const SHOW_AFTER_MS = 1500;

let banner = null;
let showTimer = null;

function getBanner() {
  if (!banner) {
    banner = h('div', { class: 'conn-banner', role: 'status', 'aria-live': 'polite', hidden: true },
      h('span', { class: 'conn-banner-dot' }),
      'Reconnecting to AutoGlow…'
    );
    document.body.append(banner);
  }
  return banner;
}

appStore.subscribe(state => state.connected, connected => {
  clearTimeout(showTimer);
  if (connected) {
    getBanner().hidden = true;
  } else {
    showTimer = setTimeout(() => { getBanner().hidden = false; }, SHOW_AFTER_MS);
  }
});

export const connection = {
  reportDown: () => appStore.set({ connected: false }),
  reportUp: () => appStore.set({ connected: true }),
  get isUp() { return appStore.get().connected; }
};
