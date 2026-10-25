// AutoGlow Bridge - toolbar popup: connection status and a reconnect button.
const $ = (id) => document.getElementById(id);

function setDot(id, state) {
  $(id).className = `dot ${state}`;
}

function render(st) {
  if (!st) return;
  $('version').textContent = `v${st.version}`;
  $('openAutoglow').href = st.serverUrl;

  if (st.connected) {
    setDot('dotServer', 'ok');
    $('serverStatus').textContent = 'Connected';
  } else if (st.connecting) {
    setDot('dotServer', 'warn');
    $('serverStatus').textContent = 'Connecting…';
  } else {
    setDot('dotServer', 'bad');
    $('serverStatus').textContent = 'Not connected';
  }

  if (st.tabAttached) {
    setDot('dotTab', 'ok');
    $('tabStatus').textContent = st.tabCount > 1 ? `Active (${st.tabCount} tabs, using 1)` : 'Active';
    $('tabStatus').title = st.tabUrl;
  } else {
    setDot('dotTab', 'bad');
    $('tabStatus').textContent = 'Not open';
  }

  $('error').hidden = !st.lastError || st.connected;
  $('error').textContent = st.lastError;
  $('hint').hidden = st.tabAttached;
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, render);
}

$('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, render);
});

refresh();
setInterval(refresh, 1000);
