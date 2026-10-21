// AutoGlow 2 - Main SPA Orchestrator & Telemetry Router
// Coordinates UI state, navigation routing, and live WebSocket telemetry.

// --- Tab Navigation & SPA Routing ---
function setupNavigation() {
  document.querySelectorAll('.nav-item[data-tab]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = link.getAttribute('data-tab');
      const targetRoute = link.getAttribute('data-route') || TAB_TO_ROUTE[targetId] || '/hub';
      
      if (window.location.pathname !== targetRoute) {
        window.history.pushState({ tab: targetId }, '', targetRoute);
      }
      switchToTab(targetId);
    });
  });
}

function handleInitialRoute() {
  const currentPath = window.location.pathname.toLowerCase().replace(/\/$/, '') || '/';
  const targetTab = ROUTE_MAP[currentPath] || 'tab-dashboard';
  switchToTab(targetTab);
}

function switchToTab(targetId) {
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  
  const navBtn = document.querySelector(`.nav-item[data-tab="${targetId}"]`);
  if (navBtn) navBtn.classList.add('active');

  const matrixGroup = document.getElementById('navMatrixGroup');
  const powerGroup = document.getElementById('navPowerGroup');

  // Collapse/Expand groups based on active tab
  if (targetId === 'tab-effects') {
    if (matrixGroup) matrixGroup.classList.add('open');
    if (powerGroup) powerGroup.classList.remove('open');
    const navEffects = document.getElementById('navEffects');
    if (navEffects && !selectedMatrixDeviceIp) navEffects.classList.add('active');
  } else if (targetId === 'tab-power') {
    if (powerGroup) powerGroup.classList.add('open');
    if (matrixGroup) matrixGroup.classList.remove('open');
    const navPower = document.getElementById('navPower');
    if (navPower && !idlePresetState.ip) navPower.classList.add('active');
  } else {
    // Leaving both matrix and power tabs -> collapse both accordion menus
    if (matrixGroup) matrixGroup.classList.remove('open');
    if (powerGroup) powerGroup.classList.remove('open');
  }

  const pane = document.getElementById(targetId);
  if (pane) pane.classList.add('active');

  if (targetId === 'tab-dashboard') renderDashboard();
  if (targetId === 'tab-devices') renderDevicesTab();
  if (targetId === 'tab-autodarts') renderAutodartsTab();
  if (targetId === 'tab-effects') renderEffectsTable();
  if (targetId === 'tab-power') renderPowerTab();
  if (targetId === 'tab-simulator') {
    if (window.renderSimulatorTab) renderSimulatorTab();
    if (typeof window.renderFlowHardwareToolbar === 'function') window.renderFlowHardwareToolbar();
  }
  if (targetId === 'tab-settings') {
    renderSettingsTab();
    if (typeof refreshPinSettings === 'function') refreshPinSettings();
  }
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
      if (idlePresetState.ip && !devicesList.find(d => d.ip === idlePresetState.ip)) {
        idlePresetState.ip = null;
        if (typeof localStorage !== 'undefined') localStorage.removeItem('autoglow_selected_power_device');
      }

      renderDashboard();
      renderDevicesTab();
      renderAutodartsTab();
      renderEffectsTable();
      renderMatrixSubmenu();
      renderPowerSubmenu();
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

async function saveAllConfig() {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(window.appState || appState)
    });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('Configuration saved successfully.', 'success');
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

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleTelemetryMessage(msg);
      } catch (e) {
        console.warn('[AutoGlow] Unparseable telemetry message:', event.data);
      }
    };

    ws.onclose = () => {
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

// --- Lighting Configuration Mode (Event Matrix vs Flow Matrix) ---
function updateLightingModeUI(mode) {
  const isFlow = (mode === 'flow');
  
  document.querySelectorAll('.btn-mode-classic').forEach(b => {
    b.classList.toggle('active', !isFlow);
  });
  document.querySelectorAll('.btn-mode-flow').forEach(b => {
    b.classList.toggle('active', isFlow);
  });

  const badgeMatrix = document.getElementById('sidebarModeBadgeMatrix');
  const badgeFlow = document.getElementById('sidebarModeBadgeFlow');
  if (badgeMatrix) badgeMatrix.style.display = isFlow ? 'none' : 'inline-block';
  if (badgeFlow) badgeFlow.style.display = isFlow ? 'inline-block' : 'none';

  // Grey out the inactive engine's nav item
  const navEffects = document.getElementById('navEffects');
  const navSimulator = document.getElementById('navSimulator');
  if (navEffects) navEffects.classList.toggle('nav-engine-inactive', isFlow);
  if (navSimulator) navSimulator.classList.toggle('nav-engine-inactive', !isFlow);
}

async function switchLightingMode(newMode) {
  const modeClean = (newMode === 'flow') ? 'flow' : 'matrix';
  if (window.appState) {
    window.appState.lighting_mode = modeClean;
  }
  updateLightingModeUI(modeClean);

  try {
    const res = await fetch('/api/flow/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: modeClean })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      if (typeof showToast === 'function') {
        const title = (modeClean === 'flow') ? 'Flow Matrix' : 'Classic Event Matrix';
        showToast(`Active lighting engine switched to ${title}`, 'success');
      }
    }
  } catch (err) {
    console.error('Failed to switch lighting mode:', err);
  }

  // Switch view seamlessly
  const targetTab = (modeClean === 'flow') ? 'tab-simulator' : 'tab-effects';
  const targetRoute = (modeClean === 'flow') ? '/simulator' : '/matrix';
  if (window.location.pathname !== targetRoute) {
    window.history.pushState({ tab: targetTab }, '', targetRoute);
  }
  switchToTab(targetTab);
}
window.switchLightingMode = switchLightingMode;
window.updateLightingModeUI = updateLightingModeUI;

// Document Ready Initialization
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  if (typeof ensureAuthenticated === 'function') await ensureAuthenticated();
  await loadConfig();
  if (typeof fetchProtocolMode === 'function') {
    fetchProtocolMode();
  }
  handleInitialRoute();
  initTelemetryWebSocket();
});
