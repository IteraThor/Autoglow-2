// AutoGlow Bridge - toolbar popup: connection status and a reconnect button.
const $ = (id) => document.getElementById(id);
const { t, srv } = window.agI18n;

/** The fixed texts in popup.html; {link} keeps the play.autodarts.com link */
function paintStatic() {
  document.documentElement.lang = window.agI18n.lang();
  for (const el of document.querySelectorAll('[data-t]')) {
    const a = el.querySelector('a');
    if (a) el.innerHTML = t(el.dataset.t, { link: a.outerHTML });
    else el.textContent = t(el.dataset.t);
  }
}
window.agI18n.onChange(paintStatic);
paintStatic();

function setDot(id, state) {
  $(id).className = `dot ${state}`;
}

function render(st) {
  if (!st) return;
  if (st.lang) window.agI18n.set(st.lang);
  $('version').textContent = `v${st.version}`;
  $('openAutoglow').href = st.serverUrl;

  if (st.connected) {
    setDot('dotServer', 'ok');
    $('serverStatus').textContent = t('Connected');
  } else if (st.connecting) {
    setDot('dotServer', 'warn');
    $('serverStatus').textContent = t('Connecting…');
  } else {
    setDot('dotServer', 'bad');
    $('serverStatus').textContent = t('Not connected');
  }

  if (st.tabAttached) {
    setDot('dotTab', 'ok');
    $('tabStatus').textContent = st.tabCount > 1 ? t('Active ({n} tabs, using 1)', { n: st.tabCount }) : t('Active');
    $('tabStatus').title = st.tabUrl;
  } else {
    setDot('dotTab', 'bad');
    $('tabStatus').textContent = t('Not open');
  }

  $('error').hidden = !st.lastError || st.connected;
  $('error').textContent = srv(st.lastError);
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
