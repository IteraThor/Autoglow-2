// AutoGlow 2 - Power timers (Settings). Idle lighting lives on each controller's page (web/js/features/idle-lighting.js).

// --- Power & Timers Tab ---
function handleInactivityToggleChange() {
  const toggle = document.getElementById('inactivityTimeoutEnabledToggle');
  const row = document.getElementById('inactivityTimeoutRow');
  const isEnabled = toggle ? toggle.checked : true;
  if (row) {
    row.classList.toggle('disabled', !isEnabled);
  }
}

function handleStandbyToggleChange() {
  const toggle = document.getElementById('idlePowerOffEnabledToggle');
  const row = document.getElementById('standbyTimeoutRow');
  const isEnabled = toggle ? toggle.checked : true;
  if (row) {
    row.classList.toggle('disabled', !isEnabled);
  }
}

function handleMatchEndDisconnectToggleChange() {
  const toggle = document.getElementById('disconnectUdpOnMatchEndToggle');
  const row = document.getElementById('matchEndDisconnectRow');
  const isEnabled = toggle ? toggle.checked : false;
  if (row) {
    row.classList.toggle('disabled', !isEnabled);
  }
}

function handleInactivityTimeoutChange() {
  const inactInp = document.getElementById('inactivityTimeoutMinInput');
  const standbyInp = document.getElementById('idlePowerOffMinInput');
  if (!inactInp || !standbyInp) return;

  let inactVal = parseInt(inactInp.value, 10);
  let standbyVal = parseInt(standbyInp.value, 10);

  if (isNaN(inactVal) || inactVal < 1) inactVal = 1;
  if (isNaN(standbyVal) || standbyVal < 1) standbyVal = 1;

  // Rule: Inactivity Timeout cannot be greater than Standby Timeout
  if (inactVal > standbyVal) {
    standbyInp.value = inactVal;
  }
  standbyInp.min = inactVal;
}

function handleStandbyTimeoutChange() {
  const inactInp = document.getElementById('inactivityTimeoutMinInput');
  const standbyInp = document.getElementById('idlePowerOffMinInput');
  if (!inactInp || !standbyInp) return;

  let inactVal = parseInt(inactInp.value, 10);
  let standbyVal = parseInt(standbyInp.value, 10);

  if (isNaN(inactVal) || inactVal < 1) inactVal = 1;
  if (isNaN(standbyVal) || standbyVal < 1) standbyVal = 1;

  // Rule: Standby Timeout cannot be lower than Inactivity Timeout
  if (standbyVal < inactVal) {
    inactInp.value = standbyVal;
  }
  standbyInp.min = inactInp.value;
}

function renderPowerTab() {
  const inactivityEnabled = appState.inactivity_timeout_enabled ?? true;
  const inactivityMin = appState.inactivity_timeout_minutes ?? 5;
  const idlePowerOffEnabled = appState.idle_power_off_enabled ?? true;
  const idlePowerOffMin = appState.idle_power_off_minutes ?? 30;
  const disconnectUdpOnMatchEnd = appState.disconnect_udp_on_match_end ?? false;

  const inactToggle = document.getElementById('inactivityTimeoutEnabledToggle');
  const inactMinInp = document.getElementById('inactivityTimeoutMinInput');
  const standbyToggle = document.getElementById('idlePowerOffEnabledToggle');
  const standbyMinInp = document.getElementById('idlePowerOffMinInput');
  const matchEndToggle = document.getElementById('disconnectUdpOnMatchEndToggle');

  if (inactToggle) inactToggle.checked = inactivityEnabled;
  if (inactMinInp) inactMinInp.value = inactivityMin;
  if (standbyToggle) standbyToggle.checked = idlePowerOffEnabled;
  if (standbyMinInp) standbyMinInp.value = idlePowerOffMin;
  if (matchEndToggle) matchEndToggle.checked = disconnectUdpOnMatchEnd;

  handleInactivityToggleChange();
  handleStandbyToggleChange();
  handleMatchEndDisconnectToggleChange();
  handleInactivityTimeoutChange();
}

// The timer values as currently entered on the Settings page (validated, not yet saved)
function readPowerDraft() {
  const val = id => document.getElementById(id);
  let inactivityMin = Math.max(1, parseInt(val('inactivityTimeoutMinInput')?.value, 10) || 5);
  let idlePowerOffMin = Math.max(1, parseInt(val('idlePowerOffMinInput')?.value, 10) || 30);
  // Rule: Inactivity cannot exceed Standby
  if (inactivityMin > idlePowerOffMin) idlePowerOffMin = inactivityMin;
  return {
    inactivity_timeout_enabled: val('inactivityTimeoutEnabledToggle') ? val('inactivityTimeoutEnabledToggle').checked : true,
    inactivity_timeout_minutes: inactivityMin,
    idle_power_off_enabled: val('idlePowerOffEnabledToggle') ? val('idlePowerOffEnabledToggle').checked : true,
    idle_power_off_minutes: idlePowerOffMin,
    disconnect_udp_on_match_end: val('disconnectUdpOnMatchEndToggle') ? val('disconnectUdpOnMatchEndToggle').checked : false
  };
}
window.readPowerDraft = readPowerDraft;

async function testInactivityDim() {
  try {
    const res = await fetch('/api/power/test_dim', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('▶ Inactivity Dim executed: Released UDP & restored Idle Preset 1.', 'warning');
    } else if (data.status === 'warning') {
      showToast(`Dim sent: ${data.message}`, 'warning');
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
}

async function testPowerOff() {
  try {
    const res = await fetch('/api/power/test_off', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('✓ Auto-Off verified on physical hardware (Lights off). Click "↺ Turn On" to restore.', 'info');
    } else if (data.status === 'warning') {
      showToast(`Auto-Off sent: ${data.message}`, 'warning');
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
}

async function testWakeBoard() {
  try {
    const res = await fetch('/api/power/test_wake', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'ok') {
      showToast('✓ Power restored & verified on hardware (Lights active).', 'success');
    } else if (data.status === 'warning') {
      showToast(`Turn On sent: ${data.message}`, 'warning');
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
}

if (typeof window !== "undefined") {
  window.renderPowerTab = renderPowerTab;
  window.handleInactivityToggleChange = handleInactivityToggleChange;
  window.handleStandbyToggleChange = handleStandbyToggleChange;
  window.handleMatchEndDisconnectToggleChange = handleMatchEndDisconnectToggleChange;
  window.handleInactivityTimeoutChange = handleInactivityTimeoutChange;
  window.handleStandbyTimeoutChange = handleStandbyTimeoutChange;
  window.testInactivityDim = testInactivityDim;
  window.testPowerOff = testPowerOff;
  window.testWakeBoard = testWakeBoard;
}


