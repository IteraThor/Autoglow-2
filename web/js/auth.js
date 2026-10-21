// AutoGlow 2 - Access PIN Gate
// Shows a PIN prompt whenever the backend reports that a session is required.

var authState = {
  pinEnabled: false,
  waiters: []
};

// Any API call that comes back 401 re-opens the PIN prompt (e.g. after the PIN changed elsewhere)
(function installAuthFetchInterceptor() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    if (res.status === 401) {
      // Only the security middleware sets auth_required; other 401s (e.g. bad Autodarts login) are not PIN related
      res.clone().json().then(body => {
        if (body && body.auth_required) showPinPrompt();
      }).catch(() => {});
    }
    return res;
  };
})();

function showPinPrompt(message = '') {
  const backdrop = document.getElementById('pinModalBackdrop');
  if (!backdrop) return;
  backdrop.style.display = 'flex';
  const err = document.getElementById('pinModalError');
  if (err) err.textContent = message;
  const input = document.getElementById('pinModalInput');
  if (input) setTimeout(() => input.focus(), 50);
}

function hidePinPrompt() {
  const backdrop = document.getElementById('pinModalBackdrop');
  if (backdrop) backdrop.style.display = 'none';
}

async function submitPinLogin() {
  const input = document.getElementById('pinModalInput');
  const pin = input ? input.value.trim() : '';
  if (!pin) return;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      if (input) input.value = '';
      hidePinPrompt();
      const waiters = authState.waiters.splice(0);
      waiters.forEach(resolve => resolve());
      if (!waiters.length) window.location.reload();
    } else {
      showPinPrompt(data.message || 'Incorrect PIN.');
      if (input) input.select();
    }
  } catch (err) {
    showPinPrompt(`Network error: ${err.message || err}`);
  }
}

// Resolves once the browser holds a valid session (immediately if no PIN is set)
async function ensureAuthenticated() {
  try {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    const data = await res.json();
    authState.pinEnabled = !!data.pin_enabled;
    if (!data.pin_enabled || data.authenticated) return;
  } catch (err) {
    return; // Backend down: let the normal UI error handling report it
  }
  await new Promise(resolve => {
    authState.waiters.push(resolve);
    showPinPrompt();
  });
}

// --- Settings: set / change / remove the PIN ---
function renderPinSettings() {
  const status = document.getElementById('pinSettingsStatus');
  const currentGroup = document.getElementById('pinCurrentGroup');
  const removeBtn = document.getElementById('btnRemovePin');
  if (status) {
    status.textContent = authState.pinEnabled ? 'PIN protection is ON' : 'PIN protection is OFF (open on your network)';
    status.style.color = authState.pinEnabled ? 'var(--status-success)' : 'var(--status-warning)';
  }
  if (currentGroup) currentGroup.style.display = authState.pinEnabled ? 'flex' : 'none';
  if (removeBtn) removeBtn.style.display = authState.pinEnabled ? 'inline-flex' : 'none';
}

async function refreshPinSettings() {
  try {
    const res = await fetch('/api/auth/status', { cache: 'no-store' });
    const data = await res.json();
    authState.pinEnabled = !!data.pin_enabled;
  } catch (err) {
    // keep last known state
  }
  renderPinSettings();
}

async function savePinSettings(remove = false) {
  const current = (document.getElementById('pinCurrentInput') || {}).value || '';
  const next = remove ? '' : ((document.getElementById('pinNewInput') || {}).value || '').trim();
  const confirmVal = remove ? '' : ((document.getElementById('pinConfirmInput') || {}).value || '').trim();

  if (!remove) {
    if (!next) { showToast('Enter a new PIN.', 'error'); return; }
    if (next !== confirmVal) { showToast('PIN confirmation does not match.', 'error'); return; }
  } else if (!await window.confirmDialog({
    title: 'Remove the access PIN?',
    body: 'Anyone on your network will be able to control AutoGlow.',
    confirmLabel: 'Remove PIN',
    danger: true
  })) {
    return;
  }

  try {
    const res = await fetch('/api/auth/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current_pin: current.trim(), new_pin: next })
    });
    const data = await res.json();
    if (data.status === 'ok') {
      authState.pinEnabled = !!data.pin_enabled;
      ['pinCurrentInput', 'pinNewInput', 'pinConfirmInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      showToast(data.pin_enabled ? 'Access PIN saved. Other browsers must sign in.' : 'Access PIN removed.', 'success');
      renderPinSettings();
    } else {
      showToast(data.message || 'Could not update PIN.', 'error');
    }
  } catch (err) {
    showToast(`Network error: ${err.message || err}`, 'error');
  }
}

window.ensureAuthenticated = ensureAuthenticated;
window.submitPinLogin = submitPinLogin;
window.refreshPinSettings = refreshPinSettings;
window.savePinSettings = savePinSettings;
