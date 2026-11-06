// AutoGlow 2 - Main SPA Orchestrator & Telemetry Router
// Coordinates UI state, navigation routing, and live WebSocket telemetry.

// --- Pane rendering ---
// URLs, the rail and sub-tabs belong to web/js/core/router.js; it calls this to show and refresh a pane.
function activatePane(targetId) {
  const studioOpen = !!document.querySelector('.studio-page.active');
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  if (studioOpen && !targetId.startsWith('tab-studio') && window.leaveStudio) window.leaveStudio();

  const pane = document.getElementById(targetId);
  if (pane) pane.classList.add('active');

  if (targetId === 'tab-devices') renderDevicesTab();
  if (targetId === 'tab-autodarts') renderAutodartsTab();
  if (targetId === 'tab-effects') renderEffectsTable();
  if (targetId.startsWith('tab-studio') && window.renderStudio) window.renderStudio(targetId);
  if (targetId === 'tab-simulator') {
    if (window.renderFlowMatrix) window.renderFlowMatrix();
    if (window.renderSimulatorTab) renderSimulatorTab();
  }
  if (targetId === 'tab-settings') {
    if (typeof refreshPinSettings === 'function') refreshPinSettings();
    // Anything left unsaved from an earlier visit is dropped
    if (window.settingsPage) window.settingsPage.reset();
  }
}
window.activatePane = activatePane;

// Older code opens a pane by id; route it through the router so the URL and navigation follow
function switchToTab(targetId) {
  window.router.showPane(targetId);
}


// --- REST API Config ---
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.status === 'ok') {
      appState = data;
      window.appState = data;

      // Validate persisted device selections against loaded devices
      const devicesList = Array.isArray(appState.devices) ? appState.devices : [];
      if (selectedMatrixDeviceIp && !devicesList.find(d => d.ip === selectedMatrixDeviceIp)) {
        selectedMatrixDeviceIp = null;
        if (typeof localStorage !== 'undefined') localStorage.removeItem('autoglow_selected_matrix_device');
      }

      renderDevicesTab();
      renderAutodartsTab();
      renderEffectsTable();
      updateLightingModeUI(appState.lighting_mode || 'matrix');

      // Background fetch Autodarts status to resolve account details for player slot prefilling
      fetch('/api/autodarts/status')
        .then(r => r.json())
        .then(adData => {
          if (adData && adData.status === 'ok' && adData.account) {
            window.lastFetchedAutodartsAccount = adData.account;
            if (!appState.autodarts) appState.autodarts = {};
            appState.autodarts.email = adData.account.email;
            appState.autodarts.name = adData.account.name;
            appState.autodarts.username = adData.account.username;
            const effectsPane = document.getElementById('tab-effects');
            if (effectsPane && effectsPane.classList.contains('active')) {
              renderEffectsTable();
            }
          }
        })
        .catch(err => {
          console.warn('[AutoGlow] Could not fetch Autodarts account status:', err);
        });
    }
  } catch (err) {
    showToast(`Could not load configuration: ${err.message || err}`, 'error');
  }
}

// fields: the setting names this save changes. The server keeps every other setting as it is now, so an
// old copy in this tab cannot undo what other pages or tabs saved.
async function saveAllConfig({ quiet = false, fields = null } = {}) {
  try {
    const state = window.appState || appState;
    const body = fields ? Object.fromEntries(fields.filter(k => k in state).map(k => [k, state[k]])) : state;
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.status === 'ok') {
      if (!quiet) showToast('Configuration saved successfully.', 'success');
      return true;
    } else {
      showToast(`Save failed: ${data.message}`, 'error');
      return false;
    }
  } catch (err) {
    showToast(`Network error saving config: ${err.message || err}`, 'error');
    return false;
  }
}
window.saveAllConfig = saveAllConfig;
window.loadConfig = loadConfig;

// --- Live Telemetry WebSocket ---
function initTelemetryWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws/telemetry`;

  try {
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => window.connection.reportUp();

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleTelemetryMessage(msg);
      } catch (e) {
        console.warn('[AutoGlow] Unparseable telemetry message:', event.data);
      }
    };

    ws.onclose = () => {
      window.connection.reportDown();
      setTimeout(initTelemetryWebSocket, 3000);
    };
  } catch (err) {
    console.error('WebSocket connection error:', err);
  }
}

function handleTelemetryMessage(msg) {
  if (typeof window.onHubTelemetry === 'function') window.onHubTelemetry(msg);

  if (msg.type === 'protocol_state') {
    if (typeof updateProtocolUI === 'function') {
      updateProtocolUI(msg.mode);
    }
    return;
  }

  if (msg.type === 'power_state') {
    window.appStore.set({ powerState: msg.state === 'active' ? 'on' : msg.state });
    return;
  }

  if (msg.type === 'lighting_mode_changed') {
    if (window.appState) window.appState.lighting_mode = msg.mode;
    updateLightingModeUI(msg.mode);
    return;
  }

  if (msg.type === 'game_flow_state') {
    if (typeof window.onFlowTelemetry === 'function') window.onFlowTelemetry(msg);
    return;
  }

  if (msg.type === 'event' || msg.type === 'game_event') {
    if (typeof window.onAutodartsGameEvent === 'function') window.onAutodartsGameEvent(msg);
  }
}

// --- Lighting mode (Event Matrix vs Flow Matrix) ---
// The header switch and the Lighting page read the mode from the shared store
function updateLightingModeUI(mode) {
  window.appStore.set({ lightingMode: mode === 'flow' ? 'flow' : 'matrix' });
}
window.updateLightingModeUI = updateLightingModeUI;

// Document Ready Initialization
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof ensureAuthenticated === 'function') await ensureAuthenticated();
  await loadConfig();
  if (typeof fetchProtocolMode === 'function') {
    fetchProtocolMode();
  }
  window.router.start();
  initTelemetryWebSocket();
});
