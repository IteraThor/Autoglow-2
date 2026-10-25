// AutoGlow 2 - Autodarts Authentication & Telemetry Tab Module

// --- Autodarts Tab ---
async function renderAutodartsTab() {
  try {
    const res = await fetch('/api/autodarts/status');
    const data = await res.json();
    if (data.status !== 'ok') return;

    // Game data comes from the Chrome extension while the direct cloud login is on hold
    const isExtension = data.source === 'extension';
    const extensionRow = document.getElementById('autodartsExtensionRow');
    const cloudRow = document.getElementById('autodartsCloudLoginRow');
    if (extensionRow) extensionRow.style.display = isExtension ? 'grid' : 'none';
    if (cloudRow) cloudRow.style.display = isExtension ? 'none' : 'grid';
    if (isExtension) renderBridgePanel(data.bridge || {});
    scheduleBridgePoll(isExtension);

    window.lastFetchedAutodartsAccount = data.account;
    if (data.account) {
      if (!appState.autodarts) appState.autodarts = {};
      appState.autodarts.email = data.account.email;
      appState.autodarts.name = data.account.name;
      appState.autodarts.username = data.account.username;
    }

    const isAuth = data.account.authenticated;
    const email = data.account.email;

    // 1. Account Panel
    const loginForm = document.getElementById('autodartsLoginForm');
    const connectedHUD = document.getElementById('autodartsConnectedHUD');
    const connectedUser = document.getElementById('autodartsConnectedUser');
    const accountBadge = document.getElementById('autodartsAccountBadge');

    if (accountBadge) {
      accountBadge.innerHTML = isAuth
        ? `<span class="dot dot-green" style="display: inline-block; width: 7px; height: 7px; margin-right: 4px;"></span><span style="color: var(--status-success);">Connected</span>`
        : `<span class="dot dot-gray" style="display: inline-block; width: 7px; height: 7px; margin-right: 4px;"></span><span style="color: var(--text-muted);">Disconnected</span>`;
    }

    if (!isAuth) {
      if (loginForm) loginForm.style.display = 'flex';
      if (connectedHUD) connectedHUD.style.display = 'none';
    } else {
      if (loginForm) loginForm.style.display = 'none';
      if (connectedHUD) connectedHUD.style.display = 'flex';
      if (connectedUser) connectedUser.innerText = email;

    }

    // 2. Live Match Status Panel
    const matchBadge = document.getElementById('liveMatchBadge');
    const matchName = document.getElementById('liveMatchName');
    const matchPlayers = document.getElementById('liveMatchPlayers');
    const matchLastEvent = document.getElementById('liveMatchLastEvent');
    const matchPrevEvent = document.getElementById('liveMatchPrevEvent');
    const matchLinkContainer = document.getElementById('liveMatchLinkContainer');
    const matchLink = document.getElementById('liveMatchLink');

    if (data.match && data.match.active_match_id) {
      if (matchBadge) {
        matchBadge.innerHTML = `<span class="dot dot-green" style="display: inline-block; width: 8px; height: 8px; margin-right: 4px;"></span><span style="color: var(--status-success); font-weight: bold;">LIVE IN MATCH</span>`;
      }
      if (matchName) {
        matchName.innerText = `Match Active`;
        matchName.style.color = `var(--status-success)`;
      }
      if (matchPlayers) {
        const players = data.match.players || [];
        const activeIdx = data.match.active_player_idx ?? 0;
        if (players.length > 0) {
          matchPlayers.innerHTML = formatPlayerNamePlates(players, activeIdx);
        } else {
          matchPlayers.innerHTML = formatPlayerNamePlates([email || 'Player'], 0);
        }
      }
      if (matchLinkContainer && matchLink) {
        matchLinkContainer.style.display = 'block';
        matchLink.href = `https://play.autodarts.com/matches/${data.match.active_match_id}`;
      }
    } else {
      if (matchBadge) {
        matchBadge.innerHTML = `<span class="dot dot-gray" style="display: inline-block; width: 7px; height: 7px; margin-right: 4px;"></span>Standby`;
      }
      if (matchName) {
        matchName.innerText = `No Match in Progress`;
        matchName.style.color = `var(--text-primary)`;
      }
      if (matchPlayers) {
        matchPlayers.innerHTML = `<span style="color: var(--text-muted); font-family: var(--font-mono); font-size: 11.5px;">None</span>`;
      }
      if (matchLinkContainer) {
        matchLinkContainer.style.display = 'none';
      }
    }

    if (matchLastEvent) {
      const lastEv = (data.match?.last_event || 'Standby').replace(/\(Ready.*\)/gi, '').replace(/\(Idle.*\)/gi, '').trim() || 'Standby';
      matchLastEvent.innerText = lastEv;
      if (data.match?.active_match_id && lastEv !== 'Standby') {
        matchLastEvent.style.color = 'var(--accent-primary)';
      } else {
        matchLastEvent.style.color = 'var(--text-primary)';
      }
    }

    if (matchPrevEvent) {
      const prevEv = (data.match?.previous_event || '—').replace(/\(Ready.*\)/gi, '').replace(/\(Idle.*\)/gi, '').trim() || '—';
      matchPrevEvent.innerText = prevEv;
      matchPrevEvent.style.color = 'var(--text-secondary)';
    }

  } catch (err) {
    console.error('Failed to render Autodarts status:', err);
  }
}

async function refreshAutodartsStatus() {
  showToast('Refreshing Autodarts live API state...', 'info');
  await renderAutodartsTab();
  showToast('Autodarts API state updated.', 'success');
}

async function submitAutodartsLogin() {
  const emailInput = document.getElementById('autodartsEmail');
  const passwordInput = document.getElementById('autodartsPassword');
  const email = emailInput ? emailInput.value.trim() : '';
  const password = passwordInput ? passwordInput.value.trim() : '';

  if (!email || !password) {
    showToast('Please provide both Autodarts email and password.', 'error');
    return;
  }

  showToast('Connecting to api.autodarts.com...', 'info');
  try {
    const data = await ((await fetch('/api/autodarts/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })).json());
    if (data.status === 'ok') {
      showToast('Autodarts account connected!', 'success');
      logAutodartsStream('AUTH', `Connected account: ${email}`);
      await loadConfig();
      await renderAutodartsTab();
    } else {
      showToast(`Connection failed: ${data.message}`, 'error');
    }
  } catch (err) {
    showToast(`Autodarts login error: ${err.message || err}`, 'error');
  }
}

async function disconnectAutodarts() {
  if (!await window.confirmDialog({ title: 'Disconnect Autodarts?', body: 'AutoGlow returns to local mode.', confirmLabel: 'Disconnect', danger: true })) return;
  try {
    const data = await ((await fetch('/api/autodarts/logout', { method: 'POST' })).json());
    if (data.status === 'ok') {
      if (!appState.autodarts) appState.autodarts = {};
      if (!appState.raw) appState.raw = {};
      appState.raw.autodarts_email = '';
      appState.raw.autodarts_password = '';
      appState.raw.autodarts_access_token = false;
      appState.raw.autodarts_board_id = '';
      appState.autodarts.email = '';
      
      const emailInput = document.getElementById('autodartsEmail');
      const passwordInput = document.getElementById('autodartsPassword');
      if (emailInput) emailInput.value = '';
      if (passwordInput) passwordInput.value = '';

      showToast('Autodarts disconnected. Local mode active.', 'info');
      logAutodartsStream('DISCONNECT', 'Account unlinked. Operating in local mode.');
      await loadConfig();
      await renderAutodartsTab();
    }
  } catch (err) {
    showToast(`Disconnect error: ${err.message || err}`, 'error');
  }
}

window.submitAutodartsLogin = submitAutodartsLogin;
window.disconnectAutodarts = disconnectAutodarts;

function logAutodartsStream(tag, message) {
  const terminal = document.getElementById('autodartsLogTerminal');
  if (!terminal) return;

  const now = new Date().toTimeString().split(' ')[0];
  const row = document.createElement('div');
  row.className = 'term-row';

  const isGreen = tag === 'ONLINE' || tag === 'AUTH' || tag === 'WS' || tag === 'EVENT';
  const isDanger = tag === 'ERROR' || tag === 'DISCONNECT';
  const tagClass = isGreen ? 'term-tag-green' : (isDanger ? 'term-tag-danger' : 'term-tag');

  row.innerHTML = `
    <span class="term-ts">[${now}]</span>
    <span class="${tagClass}">[${tag}]</span>
    <span class="term-msg">${escapeHtml(message)}</span>
  `;

  terminal.appendChild(row);
  terminal.scrollTop = terminal.scrollHeight;
}

function clearAutodartsLogs() {
  const terminal = document.getElementById('autodartsLogTerminal');
  if (terminal) terminal.innerHTML = '';
}

function parseBoardIp(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') return { url: '', display: 'N/A' };
  
  // Autodarts boards often report comma-separated endpoints (e.g. "http://192.168.2.198:3180,https://192.168.2.198:3181")
  const parts = rawIp.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return { url: '', display: 'N/A' };

  // Prefer standard HTTP port 3180 (Board Manager) or first available endpoint
  const chosen = parts.find(p => p.startsWith('http://') || p.includes(':3180')) || parts[0];
  
  const url = chosen.startsWith('http://') || chosen.startsWith('https://')
    ? chosen
    : `http://${chosen}`;

  const display = chosen.replace(/^https?:\/\//i, '');
  return { url, display };
}

// --- Chrome Extension Bridge ---
const BRIDGE_POLL_MS = 3000;
let bridgePollTimer = null;

function setDot(id, dotClass) {
  const el = document.getElementById(id);
  if (el) el.className = `dot ${dotClass}`;
}

function setTextById(id, text) {
  const el = document.getElementById(id);
  if (el) el.innerText = text;
}

function renderBridgePanel(bridge) {
  const linked = !!bridge.extension_connected;
  const tabOpen = linked && !!bridge.tab_attached;

  const badge = document.getElementById('bridgeBadge');
  if (badge) {
    const [dot, color, label] = tabOpen
      ? ['dot-green', 'var(--status-success)', 'Receiving']
      : linked ? ['dot-yellow', 'var(--status-warning)', 'No game tab'] : ['dot-gray', 'var(--text-muted)', 'Waiting'];
    badge.innerHTML = `<span class="dot ${dot}" style="display: inline-block; width: 7px; height: 7px; margin-right: 4px;"></span><span style="color: ${color};">${label}</span>`;
  }

  setDot('bridgeLinkDot', linked ? 'dot-green' : 'dot-red');
  setTextById('bridgeLinkText', linked ? `Connected${bridge.extension_version ? ` (v${bridge.extension_version})` : ''}` : 'Not connected: is the extension installed?');

  setDot('bridgeTabDot', tabOpen ? 'dot-green' : (linked ? 'dot-yellow' : 'dot-gray'));
  setTextById('bridgeTabText', tabOpen ? (bridge.tab_url || 'play.autodarts.com').replace(/^https?:\/\//, '') : 'Not open');

  setTextById('bridgeMeta', linked ? '' : 'Chrome must be running with the AutoGlow Bridge extension.');

  loadBridgeSetupInfo();
}

let bridgeSetupLoaded = false;
async function loadBridgeSetupInfo(force = false) {
  if (bridgeSetupLoaded && !force) return;
  try {
    const data = await (await fetch('/api/autodarts/bridge')).json();
    if (data.status !== 'ok') return;
    bridgeSetupLoaded = true;
    setTextById('bridgeExtensionDir', data.extension_dir || 'chrome_extension');
  } catch (err) {
    console.warn('[AutoGlow] Could not load extension setup info:', err);
  }
}

function scheduleBridgePoll(enabled) {
  if (bridgePollTimer) clearTimeout(bridgePollTimer);
  bridgePollTimer = null;
  const pane = document.getElementById('tab-autodarts');
  if (!enabled || !pane || !pane.classList.contains('active')) return;
  // Local-only status (no cloud calls in extension mode), so a short interval is cheap
  bridgePollTimer = setTimeout(() => {
    bridgePollTimer = null;
    if (pane.classList.contains('active') && !document.hidden) renderAutodartsTab();
    else scheduleBridgePoll(true);
  }, BRIDGE_POLL_MS);
}

function copyBridgeValue(elementId, label) {
  const el = document.getElementById(elementId);
  const value = el ? el.innerText.trim() : '';
  if (!value || value === '—') return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value)
      .then(() => showToast(`${label} copied to clipboard.`, 'success'))
      .catch(() => showToast(`${label}: ${value}`, 'info'));
  } else {
    showToast(`${label}: ${value}`, 'info');
  }
}

let activeDeviceLinkPolling = null;
let activeDeviceLinkTimer = null;
let deviceLinkExpirySeconds = 0;

async function requestAutodartsDeviceCode() {
  const btn = document.getElementById('btnRequestDeviceCode');
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Requesting Code...';
  }

  try {
    const res = await fetch('/api/autodarts/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();

    if (data.status !== 'ok' || !data.user_code) {
      showToast(`Failed to generate link code: ${data.message || 'Unknown error'}`, 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Request Link Code</span>`;
      }
      return;
    }

    const userCode = data.user_code;
    const deviceCode = data.device_code;
    const intervalSec = Math.max(3, data.interval || 5);
    deviceLinkExpirySeconds = data.expires_in || 600;
    const directUrl = data.verification_uri_complete || data.verification_uri || 'https://auth.autodarts.com/link';

    const codeDisplay = document.getElementById('deviceLinkCodeDisplay');
    const openBtn = document.getElementById('deviceLinkOpenBtn');
    const urlDirect = document.getElementById('deviceLinkUrlDirect');
    const statusMsg = document.getElementById('deviceLinkStatusMsg');
    const timerElem = document.getElementById('deviceLinkExpiryTimer');

    if (codeDisplay) codeDisplay.innerText = userCode;
    if (openBtn) openBtn.href = directUrl;
    if (urlDirect) {
      urlDirect.href = directUrl;
      urlDirect.innerText = directUrl.includes('?') ? 'auth.autodarts.com/link (auto-filled) ↗' : 'auth.autodarts.com/link ↗';
    }
    if (statusMsg) statusMsg.innerText = 'Waiting for confirmation in browser...';

    // Switch views
    const initialView = document.getElementById('deviceLinkInitialView');
    const activeView = document.getElementById('deviceLinkActiveView');
    const connectedView = document.getElementById('deviceLinkConnectedView');
    if (initialView) initialView.style.display = 'none';
    if (activeView) activeView.style.display = 'flex';
    if (connectedView) connectedView.style.display = 'none';

    const deviceLinkBadge = document.getElementById('deviceLinkBadge');
    if (deviceLinkBadge) {
      deviceLinkBadge.innerHTML = `<span class="dot dot-green" style="display: inline-block; width: 7px; height: 7px; margin-right: 4px; animation: pulse 1.5s infinite;"></span><span style="color: var(--accent-primary);">Authorizing...</span>`;
    }

    // Start timer
    if (activeDeviceLinkTimer) clearInterval(activeDeviceLinkTimer);
    const updateTimerDisplay = () => {
      if (!timerElem) return;
      const m = Math.floor(deviceLinkExpirySeconds / 60);
      const s = deviceLinkExpirySeconds % 60;
      timerElem.innerText = `${m}:${s < 10 ? '0' : ''}${s}`;
    };
    updateTimerDisplay();
    activeDeviceLinkTimer = setInterval(() => {
      deviceLinkExpirySeconds--;
      if (deviceLinkExpirySeconds <= 0) {
        cancelDeviceLink('Link code expired. Please request a new one.');
      } else {
        updateTimerDisplay();
      }
    }, 1000);

    // Start Poller
    if (activeDeviceLinkPolling) clearInterval(activeDeviceLinkPolling);
    activeDeviceLinkPolling = setInterval(async () => {
      try {
        const pollRes = await fetch('/api/autodarts/device/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: deviceCode })
        });
        const pollData = await pollRes.json();

        if (pollData.status === 'ok' && pollData.authenticated) {
          clearInterval(activeDeviceLinkPolling);
          clearInterval(activeDeviceLinkTimer);
          activeDeviceLinkPolling = null;
          activeDeviceLinkTimer = null;

          showToast('Autodarts account linked successfully!', 'success');
          logAutodartsStream('LINK', `Device authorized! Account: ${pollData.user?.username || pollData.user?.email || 'Active'}`);
          await loadConfig();
          await renderAutodartsTab();
        } else if (pollData.status === 'expired') {
          cancelDeviceLink('Code expired on server. Please request a new code.');
        } else if (pollData.status === 'error') {
          cancelDeviceLink(`Linking error: ${pollData.message || pollData.error}`);
        }
      } catch (e) {
        console.warn('[AutoGlow] Device link polling transient error:', e);
      }
    }, intervalSec * 1000);

    showToast(`Link Code: ${userCode} generated!`, 'info');

  } catch (err) {
    showToast(`Error requesting device code: ${err.message || err}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg><span>Request Link Code</span>`;
    }
  }
}

function cancelDeviceLink(reason = null) {
  if (activeDeviceLinkPolling) clearInterval(activeDeviceLinkPolling);
  if (activeDeviceLinkTimer) clearInterval(activeDeviceLinkTimer);
  activeDeviceLinkPolling = null;
  activeDeviceLinkTimer = null;

  if (reason) showToast(reason, 'info');

  const initialView = document.getElementById('deviceLinkInitialView');
  const activeView = document.getElementById('deviceLinkActiveView');
  if (initialView) initialView.style.display = 'flex';
  if (activeView) activeView.style.display = 'none';

  const deviceLinkBadge = document.getElementById('deviceLinkBadge');
  if (deviceLinkBadge) {
    deviceLinkBadge.innerHTML = `<span class="dot dot-gray" style="display: inline-block; width: 7px; height: 7px; margin-right: 4px;"></span><span style="color: var(--text-muted);">Standby</span>`;
  }
}

function copyDeviceLinkCode() {
  const codeDisplay = document.getElementById('deviceLinkCodeDisplay');
  const code = codeDisplay ? codeDisplay.innerText.trim() : '';
  if (code && code !== '----') {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(() => {
        showToast(`Copied code "${code}" to clipboard!`, 'success');
      }).catch(() => {
        showToast(`Code: ${code}`, 'info');
      });
    } else {
      showToast(`Code: ${code}`, 'info');
    }
  }
}

if (typeof window !== "undefined") {
  window.parseBoardIp = parseBoardIp;
  window.renderAutodartsTab = renderAutodartsTab;
  window.refreshAutodartsStatus = refreshAutodartsStatus;
  window.submitAutodartsLogin = submitAutodartsLogin;
  window.disconnectAutodarts = disconnectAutodarts;
  window.logAutodartsStream = logAutodartsStream;
  window.clearAutodartsLogs = clearAutodartsLogs;
  window.requestAutodartsDeviceCode = requestAutodartsDeviceCode;
  window.cancelDeviceLink = cancelDeviceLink;
  window.copyDeviceLinkCode = copyDeviceLinkCode;
  window.copyBridgeValue = copyBridgeValue;
}



