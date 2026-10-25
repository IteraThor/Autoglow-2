// AutoGlow 2 - Main SPA Orchestrator & Telemetry Router
// Coordinates UI state, navigation routing, and live WebSocket telemetry.

// --- Pane rendering ---
// URLs, the rail and sub-tabs belong to web/js/core/router.js; it calls this to show and refresh a pane.
function activatePane(targetId) {
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

  const pane = document.getElementById(targetId);
  if (pane) pane.classList.add('active');

  if (targetId === 'tab-dashboard') renderDashboard();
  if (targetId === 'tab-devices') renderDevicesTab();
  if (targetId === 'tab-autodarts') renderAutodartsTab();
  if (targetId === 'tab-effects') renderEffectsTable();
  if (targetId === 'tab-simulator') {
    if (window.renderSimulatorTab) renderSimulatorTab();
    if (typeof window.renderFlowHardwareToolbar === 'function') window.renderFlowHardwareToolbar();
  }
  if (targetId === 'tab-settings') {
    renderPowerTab();
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

      renderDashboard();
      renderDevicesTab();
      renderAutodartsTab();
      renderEffectsTable();
      renderPowerTab();
      if (typeof window.renderFlowHardwareToolbar === 'function') window.renderFlowHardwareToolbar();
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

async function saveAllConfig({ quiet = false } = {}) {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.appState || appState)
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

// --- Dashboard View ---
function renderDashboard() {
  if (typeof window.renderHub === 'function') window.renderHub();
}

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
    if (typeof window.highlightFlowPhase === 'function') {
      window.highlightFlowPhase(msg.phase);
    }
    if (msg.lighting_mode) {
      updateLightingModeUI(msg.lighting_mode);
    }
    return;
  }

  if (msg.type === 'event' || msg.type === 'game_event') {
    const evName = msg.event?.toUpperCase() || 'MATCH';
    const matchLastEvent = document.getElementById('liveMatchLastEvent');
    const matchPrevEvent = document.getElementById('liveMatchPrevEvent');
    const matchBadge = document.getElementById('liveMatchBadge');
    const matchName = document.getElementById('liveMatchName');
    const matchPlayers = document.getElementById('liveMatchPlayers');

    if (msg.event === 'idle' || msg.event === 'game_idle') {
      if (matchLastEvent) {
        matchLastEvent.innerText = 'Standby';
        matchLastEvent.style.color = 'var(--text-primary)';
      }
      if (matchPrevEvent) {
        matchPrevEvent.innerText = '—';
        matchPrevEvent.style.color = 'var(--text-muted)';
      }
      if (matchBadge) {
        matchBadge.innerHTML = `<span class="dot dot-gray" style="display: inline-block; width: 7px; height: 7px; margin-right: 4px;"></span>Standby`;
      }
      if (matchName) {
        matchName.innerText = 'No Match in Progress';
        matchName.style.color = 'var(--text-primary)';
      }
      if (matchPlayers) {
        matchPlayers.innerHTML = `<span style="color: var(--text-muted); font-family: var(--font-mono); font-size: 12px;">None</span>`;
      }
      const matchLinkContainer = document.getElementById('liveMatchLinkContainer');
      if (matchLinkContainer) matchLinkContainer.style.display = 'none';
    } else if (msg.event === 'takeout') {
      if (matchPrevEvent && matchLastEvent && matchLastEvent.innerText !== 'Standby') {
        matchPrevEvent.innerText = matchLastEvent.innerText;
        matchPrevEvent.style.color = 'var(--text-secondary)';
      }
      if (matchLastEvent) {
        matchLastEvent.innerText = 'TAKEOUT (Fired)';
        matchLastEvent.style.color = 'var(--accent-primary)';
      }
    } else {
      const displayEv = msg.display_event || (msg.segment_name ? `${msg.event} ; ${msg.segment_name}` : msg.event);
      if (matchPrevEvent) {
        const prev = msg.previous_event || (matchLastEvent && matchLastEvent.innerText !== 'Standby' ? matchLastEvent.innerText : '—');
        matchPrevEvent.innerText = prev;
        matchPrevEvent.style.color = 'var(--text-secondary)';
      }
      if (matchLastEvent) {
        matchLastEvent.innerText = displayEv;
        matchLastEvent.style.color = 'var(--accent-primary)';
      }
      if (matchBadge) {
        matchBadge.innerHTML = `<span class="dot dot-green" style="display: inline-block; width: 8px; height: 8px; margin-right: 4px;"></span><span style="color: var(--status-success); font-weight: bold;">LIVE IN MATCH</span>`;
      }
      if (matchName) {
        matchName.innerText = 'Match Active';
        matchName.style.color = 'var(--status-success)';
      }
      if (matchPlayers && msg.players && msg.players.length > 0) {
        const activeIdx = msg.active_player_idx ?? 0;
        matchPlayers.innerHTML = formatPlayerNamePlates(msg.players, activeIdx);
      }
    }
  }
}

function formatPlayerNamePlates(players, activeIdx = 0) {
  if (!players || players.length === 0) {
    return `<span style="color: var(--text-muted); font-family: var(--font-mono); font-size: 12px;">None</span>`;
  }
  return players.map((name, idx) => {
    const isActive = (idx === activeIdx);
    if (isActive) {
      return `<span style="color: var(--status-success); font-family: var(--font-mono); font-size: 12px; font-weight: 700;">● ${escapeHtml(name)}</span>`;
    } else {
      return `<span style="color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px; font-weight: 500;">${escapeHtml(name)}</span>`;
    }
  }).join('<span style="color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; opacity: 0.6; margin: 0 6px;">vs</span>');
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
