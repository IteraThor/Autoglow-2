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
  // Stored as 0-255, shown as a percentage
  const dimPct = document.getElementById('idleDimmingPercentInput');
  if (dimPct) dimPct.value = Math.round(((appState.idle_dimming_brightness ?? 50) / 255) * 100);

  handleInactivityToggleChange();
  handleStandbyToggleChange();
  handleMatchEndDisconnectToggleChange();
  handleInactivityTimeoutChange();
  renderPowerClock();
}

// The clock bar: live until dimming, dimmed until switch-off, then off; drawn to scale from the entered minutes
function renderPowerClock() {
  const clock = document.getElementById('powerClock');
  if (!clock) return;
  const d = readPowerDraft();
  const dimAt = d.inactivity_timeout_enabled ? d.inactivity_timeout_minutes : null;
  const offAt = d.idle_power_off_enabled ? d.idle_power_off_minutes : null;
  // The bar ends a little after the last event so "off" has room; with no timer it shows 30 min of live lights
  const end = Math.max(offAt ?? dimAt ?? 30, dimAt ?? 0) * 1.12;
  const live = dimAt ?? offAt ?? end;
  const dimEnd = offAt ?? end;
  const parts = { live: live / end, dim: dimAt !== null ? (dimEnd - dimAt) / end : 0, off: offAt !== null ? (end - offAt) / end : 0 };
  clock.querySelectorAll('.pw-clock-bar [data-phase]').forEach(el => { el.style.flexGrow = String(parts[el.dataset.phase]); });
  // A legend under the bar (positioned labels collide when dimming comes after only a minute or two)
  const item = (phase, label) => {
    const el = document.createElement('span');
    el.className = 'pw-legend-item';
    const key = document.createElement('span');
    key.className = 'pw-key';
    key.dataset.phase = phase;
    el.append(key, label);
    return el;
  };
  const items = [item('live', dimAt !== null || offAt !== null ? `Live · 0–${live} min` : 'Live, no timer')];
  if (dimAt !== null) items.push(item('dim', offAt !== null ? `Dimmed · ${dimAt}–${offAt} min` : `Dimmed · from ${dimAt} min`));
  if (offAt !== null) items.push(item('off', `Off · after ${offAt} min`));
  clock.querySelector('.pw-clock-ticks').replaceChildren(...items);
}
window.renderPowerClock = renderPowerClock;

// The percentage field as the 0-255 value the engine uses; an unchanged field keeps the exact saved value
function dimmingFromPercent(raw) {
  const saved = window.appState?.idle_dimming_brightness ?? 50;
  const pct = parseInt(raw, 10);
  if (Number.isNaN(pct)) return saved;
  const clamped = Math.max(0, Math.min(100, pct));
  if (clamped === Math.round((saved / 255) * 100)) return saved;
  return Math.round((clamped / 100) * 255);
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
    disconnect_udp_on_match_end: val('disconnectUdpOnMatchEndToggle') ? val('disconnectUdpOnMatchEndToggle').checked : false,
    idle_dimming_brightness: dimmingFromPercent(val('idleDimmingPercentInput')?.value)
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


