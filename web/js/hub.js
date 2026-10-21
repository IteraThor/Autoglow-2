// AutoGlow 2 - Operational Hub
// Live overview of engine, Autodarts match, and per-controller hardware health.

const HUB_POLL_MS = 10000;
const HUB_MIN_REFRESH_GAP_MS = 2000;

var hubState = {
  snapshot: null,
  fetchedAt: 0,
  inFlight: false,
  pendingTimer: null
};

function isHubVisible() {
  const pane = document.getElementById('tab-dashboard');
  return !!(pane && pane.classList.contains('active') && document.visibilityState !== 'hidden');
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

function setHubTile(id, dotClass, label, hint) {
  const val = document.getElementById(`${id}Val`);
  const hintEl = document.getElementById(`${id}Hint`);
  if (val) {
    val.innerHTML = '';
    if (dotClass) {
      const dot = document.createElement('span');
      dot.className = `dot ${dotClass}`;
      val.appendChild(dot);
    }
    val.appendChild(document.createTextNode(label));
  }
  if (hintEl) hintEl.textContent = hint || '';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

async function refreshHub(force = false) {
  if (hubState.inFlight) return;
  if (!force && Date.now() - hubState.fetchedAt < HUB_MIN_REFRESH_GAP_MS) return;
  hubState.inFlight = true;
  try {
    const res = await fetch('/api/hub/status', { cache: 'no-store' });
    const data = await res.json();
    if (data.status === 'ok') {
      hubState.snapshot = data;
      hubState.fetchedAt = Date.now();
      renderHubSnapshot(data);
    }
  } catch (err) {
    setText('hubMeta', 'Backend unreachable - retrying...');
  } finally {
    hubState.inFlight = false;
  }
}

// Coalesce bursts of telemetry into a single refresh
function scheduleHubRefresh() {
  if (hubState.pendingTimer) return;
  const wait = Math.max(0, HUB_MIN_REFRESH_GAP_MS - (Date.now() - hubState.fetchedAt));
  hubState.pendingTimer = setTimeout(() => {
    hubState.pendingTimer = null;
    if (isHubVisible()) refreshHub(true);
  }, wait);
}

function renderHubSnapshot(data) {
  const eng = data.engine || {};
  const ad = data.autodarts || {};

  setText('hubMeta', `v${data.version}`);

  if (!eng.running) {
    setHubTile('hubEngine', 'dot-red', 'Stopped', 'Engine not running');
  } else {
    const isFlow = eng.lighting_mode === 'flow';
    setHubTile('hubEngine', 'dot-green', isFlow ? 'Flow Matrix' : 'Event Matrix', isFlow ? `Phase: ${eng.flow_phase || 'idle'}` : 'Classic per-event effects');
  }

  const streaming = eng.protocol_mode === 'udp';
  setHubTile('hubStream', streaming ? 'dot-green' : 'dot-gray', streaming ? 'UDP Active' : 'HTTP Idle',
    streaming ? 'Realtime DRGB on port 21324' : 'JSON API control, no stream');
  const streamBtn = document.getElementById('hubBtnStream');
  if (streamBtn) streamBtn.textContent = streaming ? 'Release to HTTP' : 'Connect UDP';

  renderHubPowerTile();

  if (!ad.configured) {
    setHubTile('hubAutodarts', 'dot-gray', 'Not linked', 'Local mode');
  } else if (ad.source === 'extension') {
    if (ad.connected && ad.tab_attached) {
      setHubTile('hubAutodarts', 'dot-green', 'Connected', 'Chrome extension · game tab open');
    } else if (ad.connected) {
      setHubTile('hubAutodarts', 'dot-yellow', 'No game tab', 'Open play.autodarts.com in Chrome');
    } else {
      setHubTile('hubAutodarts', 'dot-gray', 'Waiting', 'Chrome extension not connected');
    }
  } else if (ad.connected) {
    setHubTile('hubAutodarts', 'dot-green', 'Connected', ad.account || 'Listening for board events');
  } else {
    setHubTile('hubAutodarts', 'dot-yellow', 'Reconnecting', ad.account || 'Cloud connection retrying');
  }

  renderHubMatch({
    active: !!ad.match_active,
    players: ad.players || [],
    activeIdx: ad.active_player_idx || 0,
    last: eng.last_event,
    previous: eng.previous_event,
    phase: eng.flow_phase
  });

  renderHubDevices(data.devices || []);
}

function renderHubPowerTile() {
  const snap = hubState.snapshot;
  if (!snap || !snap.engine) return;
  const eng = snap.engine;
  const elapsed = (Date.now() - hubState.fetchedAt) / 1000;
  const labels = { on: 'On', dimmed: 'Dimmed', off: 'Off' };
  const dots = { on: 'dot-green', dimmed: 'dot-yellow', off: 'dot-gray' };
  let hint = 'Timers disabled';
  if (eng.power_state === 'off') {
    hint = 'Wakes on the next game event';
  } else if (eng.dim_in_seconds != null) {
    hint = `Dims in ${formatDuration(eng.dim_in_seconds - elapsed)}`;
  } else if (eng.off_in_seconds != null) {
    hint = `Turns off in ${formatDuration(eng.off_in_seconds - elapsed)}`;
  }
  setHubTile('hubPower', dots[eng.power_state] || 'dot-gray', labels[eng.power_state] || eng.power_state, hint);
}

function renderHubMatch(m) {
  const pill = document.getElementById('hubMatchPill');
  if (pill) {
    pill.textContent = m.active ? 'Live' : 'Standby';
    pill.classList.toggle('is-udp', m.active);
  }
  const playersEl = document.getElementById('hubMatchPlayers');
  if (playersEl) {
    playersEl.textContent = m.players.length
      ? m.players.map((p, i) => (i === m.activeIdx ? `> ${p}` : p)).join('  vs  ')
      : 'None';
  }
  setText('hubMatchLast', m.last || 'Standby');
  setText('hubMatchPrev', m.previous || '—');
  if (m.phase) setText('hubMatchPhase', m.phase);
}

function renderHubDevices(devices) {
  const container = document.getElementById('hubDevices');
  if (!container) return;
  container.innerHTML = '';

  if (!devices.length) {
    container.innerHTML = '<div class="hub-empty">No WLED controllers configured yet. <a href="/devices" onclick="event.preventDefault(); window.history.pushState({tab:\'tab-devices\'}, \'\', \'/devices\'); switchToTab(\'tab-devices\');">Add one on the Devices page.</a></div>';
    return;
  }

  devices.forEach(dev => {
    const card = document.createElement('div');
    card.className = 'hub-device';

    let dotClass = 'dot-gray';
    let statusText = 'Disabled';
    if (dev.enabled) {
      if (dev.streaming) { dotClass = 'dot-green'; statusText = 'Streaming'; }
      else if (dev.online) { dotClass = (dev.warnings && dev.warnings.length) ? 'dot-yellow' : 'dot-green'; statusText = 'Online'; }
      else { dotClass = 'dot-red'; statusText = 'Offline'; }
    }

    const head = document.createElement('div');
    head.className = 'hub-device-head';
    head.innerHTML = `
      <span class="hub-device-name"><span class="dot ${dotClass}"></span><span>${escapeHtml(dev.name || dev.ip)}</span></span>
      <span style="display: flex; align-items: center; gap: 8px;">
        <span class="hub-pill ${dev.protocol_mode === 'udp' ? 'is-udp' : ''}">${escapeHtml(dev.protocol_mode || 'http')}</span>
        <a class="hub-device-ip" href="http://${escapeHtml(dev.ip)}" target="_blank" rel="noopener noreferrer">${escapeHtml(dev.ip)} ↗</a>
      </span>`;
    card.appendChild(head);

    const stats = document.createElement('div');
    stats.className = 'hub-device-stats';
    if (dev.streaming) {
      stats.innerHTML = '<span>Health checks paused while the UDP stream owns the controller.</span>';
    } else if (dev.online) {
      stats.innerHTML = `
        <span>Status <b>${statusText}</b></span>
        <span>WLED <b>${escapeHtml(dev.version || '?')}</b></span>
        <span>Power <b>${dev.on ? 'on' : 'off'}</b></span>
        <span>Bri <b>${dev.bri ?? '?'}</b></span>
        <span>lor <b>${dev.lor ?? 0}</b></span>
        <span>Preset <b>${dev.preset ?? -1}</b></span>`;
    } else {
      stats.innerHTML = `<span>Status <b>${statusText}</b></span>${dev.error ? `<span>${escapeHtml(dev.error)}</span>` : ''}`;
    }
    card.appendChild(stats);

    if (dev.segments && dev.segments.length) {
      const segs = document.createElement('div');
      segs.className = 'hub-seg-list';
      dev.segments.forEach(seg => {
        const chip = document.createElement('span');
        chip.className = `hub-seg${seg.on === false ? ' is-off' : ''}`;
        chip.textContent = `#${seg.id} ${seg.name} [${seg.start}-${seg.stop}]`;
        segs.appendChild(chip);
      });
      card.appendChild(segs);
    }

    if (dev.warnings && dev.warnings.length) {
      const list = document.createElement('ul');
      list.className = 'hub-warnings';
      dev.warnings.forEach(w => {
        const li = document.createElement('li');
        li.textContent = w;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    container.appendChild(card);
  });
}

async function hubToggleStream() {
  const streaming = hubState.snapshot && hubState.snapshot.engine && hubState.snapshot.engine.protocol_mode === 'udp';
  const target = streaming ? 'http' : 'udp';
  try {
    const res = await fetch('/api/protocol/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: target })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      if (typeof updateProtocolUI === 'function') updateProtocolUI(data.mode);
      if (data.verified === false) {
        showToast(`Switched to ${data.mode.toUpperCase()}, but not every controller confirmed it.`, 'warning');
      } else {
        showToast(`Live stream: ${data.mode === 'udp' ? 'UDP active' : 'released to HTTP'}.`, 'success');
      }
    } else {
      showToast(`Error: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
  refreshHub(true);
}

async function hubRunAction(action) {
  const endpoints = { wake: '/api/power/test_wake', dim: '/api/power/test_dim', off: '/api/power/test_off' };
  if (action === 'off' && !confirm('Turn off all WLED controllers and the board light?')) return;
  try {
    const res = await fetch(endpoints[action], { method: 'POST' });
    const data = await res.json();
    const type = data.status === 'ok' ? 'success' : (data.status === 'warning' ? 'warning' : 'error');
    showToast(data.message || `Action ${action} finished.`, type);
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
  refreshHub(true);
}

// Called by app.js for every telemetry message
function onHubTelemetry(msg) {
  if (!isHubVisible()) return;
  if (msg.type === 'game_event' || msg.type === 'event') {
    setText('hubMatchLast', msg.display_event || msg.event || 'Event');
    if (msg.previous_event) setText('hubMatchPrev', msg.previous_event);
  }
  if (['game_event', 'event', 'protocol_state', 'power_state', 'lighting_mode_changed', 'game_flow_state'].includes(msg.type)) {
    scheduleHubRefresh();
  }
}

function renderHub() {
  refreshHub(true);
}

setInterval(() => {
  if (isHubVisible()) refreshHub();
}, HUB_POLL_MS);

// Tick the dim/off countdown between polls
setInterval(() => {
  if (isHubVisible()) renderHubPowerTile();
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (isHubVisible()) refreshHub(true);
});

window.renderHub = renderHub;
window.refreshHub = refreshHub;
window.onHubTelemetry = onHubTelemetry;
window.hubToggleStream = hubToggleStream;
window.hubRunAction = hubRunAction;
