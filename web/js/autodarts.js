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

    // 2. Step 3 of the checklist: is a match coming in?
    renderGameStep(data.match || {}, !!(data.bridge && data.bridge.tab_attached));

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

function setStep(id, state) {
  const el = document.getElementById(id);
  if (el) el.dataset.state = state;
}

let bridgeWasLinked = null;
function renderBridgePanel(bridge) {
  const linked = !!bridge.extension_connected;
  const tabOpen = linked && !!bridge.tab_attached;

  setStep('adStepExtension', linked ? 'done' : 'todo');
  setTextById('bridgeLinkText', linked
    ? `Connected${bridge.extension_version ? ` (v${bridge.extension_version})` : ''}`
    : 'Not connected: is the extension installed? Chrome must be running with the AutoGlow Bridge extension.');
  // The install steps open by themselves only when the extension goes missing; the user can still fold them
  const install = document.getElementById('bridgeInstall');
  if (install && bridgeWasLinked !== linked) install.open = !linked;
  bridgeWasLinked = linked;

  setStep('adStepTab', tabOpen ? 'done' : linked ? 'todo' : 'wait');
  setTextById('bridgeTabText', tabOpen ? (bridge.tab_url || 'play.autodarts.com').replace(/^https?:\/\//, '') : 'Not open');
  const open = document.getElementById('bridgeOpenAutodarts');
  if (open) open.hidden = tabOpen;

  loadBridgeSetupInfo();
}

function cleanEventName(text, fallback) {
  return (text || fallback).replace(/\(Ready.*\)/gi, '').replace(/\(Idle.*\)/gi, '').trim() || fallback;
}

// Step 3: no match yet, or the running match with its players and the last two events
function renderGameStep(match, tabOpen) {
  const live = !!match.active_match_id;
  setStep('adStepGame', live ? 'done' : tabOpen ? 'todo' : 'wait');
  const players = match.players || [];
  const active = match.active_player_idx ?? 0;
  setTextById('adGameDetail', live
    ? `Match running${players.length ? ` · ${players.map((p, i) => (i === active ? `● ${p}` : p)).join(' vs ')}` : ''}`
    : 'Waiting for a match. Start one in Autodarts.');
  const events = document.getElementById('adGameEvents');
  if (events) events.hidden = !live;
  setTextById('liveMatchLastEvent', cleanEventName(match.last_event, 'Standby'));
  setTextById('liveMatchPrevEvent', cleanEventName(match.previous_event, '—'));
  const link = document.getElementById('liveMatchLink');
  if (link) {
    link.hidden = !live;
    if (live) link.href = `https://play.autodarts.com/matches/${match.active_match_id}`;
  }
}

// Live events from the telemetry socket move the last/previous event along between status polls
function onAutodartsGameEvent(msg) {
  const last = document.getElementById('liveMatchLastEvent');
  const prev = document.getElementById('liveMatchPrevEvent');
  if (!last || !prev) return;
  if (msg.event === 'idle' || msg.event === 'game_idle') {
    renderGameStep({}, document.getElementById('adStepTab')?.dataset.state === 'done');
    return;
  }
  const shown = msg.event === 'takeout'
    ? 'Takeout'
    : msg.display_event || (msg.segment_name ? `${msg.event} ; ${msg.segment_name}` : msg.event);
  prev.innerText = msg.previous_event || (last.innerText !== 'Standby' ? last.innerText : '—');
  last.innerText = shown;
  setStep('adStepGame', 'done');
  const events = document.getElementById('adGameEvents');
  if (events) events.hidden = false;
}
window.onAutodartsGameEvent = onAutodartsGameEvent;

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

// Chrome refuses to open chrome:// links from a web page, so the link copies the address instead
function copyChromeExtensionsLink(event) {
  if (event) event.preventDefault();
  const value = 'chrome://extensions';
  const hint = 'Paste it into the Chrome address bar.';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value)
      .then(() => showToast(`${value} copied. ${hint}`, 'success'))
      .catch(() => showToast(`Open ${value} in the Chrome address bar.`, 'info'));
  } else {
    showToast(`Open ${value} in the Chrome address bar.`, 'info');
  }
  return false;
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
  window.copyChromeExtensionsLink = copyChromeExtensionsLink;
}



