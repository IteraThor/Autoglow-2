// AutoGlow 2 - Main SPA Orchestrator & Telemetry Router
// Coordinates UI state, navigation routing, and live WebSocket telemetry.

// --- Pane rendering ---
// URLs, the rail and sub-tabs belong to web/js/core/router.js; it calls this to show and refresh a pane.
function activatePane(targetId) {
  const studioOpen = !!document.querySelector('.studio-page.active');
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  if (studioOpen && !targetId.startsWith('tab-studio') && window.leaveStudio) window.leaveStudio();
  const dashboardOpen = !!document.querySelector('.dashboard-page.active');
  if (dashboardOpen && targetId !== 'tab-dashboard' && window.leaveDashboard) window.leaveDashboard();

  const pane = document.getElementById(targetId);
  if (pane) pane.classList.add('active');

  if (targetId === 'tab-devices') renderDevicesTab();
  if (targetId === 'tab-autodarts') renderAutodartsTab();
  if (targetId.startsWith('tab-studio') && window.renderStudio) window.renderStudio(targetId);
  if (targetId === 'tab-dashboard' && window.renderDashboard) window.renderDashboard();
  if (targetId === 'tab-players' && window.renderPlayers) window.renderPlayers();
  if (targetId === 'tab-settings' && window.renderNetwork) window.renderNetwork();
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


// --- REST API Config ---
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.status === 'ok') {
      appState = data;
      window.appState = data;

      renderDevicesTab();
      renderAutodartsTab();
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

  if (msg.type === 'game_flow_state') {
    if (typeof window.onFlowTelemetry === 'function') window.onFlowTelemetry(msg);
    return;
  }

  if (msg.type === 'event' || msg.type === 'game_event') {
    if (typeof window.onAutodartsGameEvent === 'function') window.onAutodartsGameEvent(msg);
  }
}

// --- Stream light (UDP vs HTTP) ---
let currentProtocolMode = 'http';

async function fetchProtocolMode() {
  try {
    const res = await fetch('/api/protocol/mode');
    const data = await res.json();
    if (data.status === 'ok') updateProtocolUI(data.mode);
  } catch (err) {
    console.debug('Failed to fetch protocol mode:', err);
  }
}

async function toggleProtocolMode() {
  const targetMode = currentProtocolMode === 'udp' ? 'http' : 'udp';
  try {
    const data = await window.api.post('/api/protocol/mode', { mode: targetMode });
    updateProtocolUI(data.mode);
    window.toast.info(data.mode === 'udp' ? 'Stream started' : 'Stream stopped');
  } catch (err) {
    window.toast.error(err, { onRetry: toggleProtocolMode });
  }
}
window.toggleProtocolMode = toggleProtocolMode;

// The header's Stream light shows the mode from the shared store
function updateProtocolUI(mode) {
  currentProtocolMode = mode;
  window.appStore.set({ protocolMode: mode });
}

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
