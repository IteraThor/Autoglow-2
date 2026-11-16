/**
 * AutoGlow 2 - State Store
 * Shared UI state used by the classic scripts.
 */

var appState = {
  device: {},
  devices: [],
  autodarts: {},
  raw: {}
};

var lastFetchedLiveDeviceData = {};

// Attach all to window for global access
if (typeof window !== "undefined") {
  window.appState = appState;
  window.lastFetchedLiveDeviceData = lastFetchedLiveDeviceData;
}
