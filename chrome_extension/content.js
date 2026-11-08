// AutoGlow Bridge - content script (isolated world).
// Forwards what page_hook.js observed to the background service worker over a long-lived port.
const TAG = 'autoglow-bridge';
const KEEPALIVE_MS = 20000;

let port = null;

function getPort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: 'autodarts-tab' });
    port.onDisconnect.addListener(() => { port = null; });
    port.postMessage({ type: 'tab', attached: true, url: location.href });
  } catch {
    // Extension was reloaded or updated: this tab needs a page refresh to reconnect
    port = null;
  }
  return port;
}

function send(payload) {
  const p = getPort();
  if (!p) return;
  try {
    p.postMessage(payload);
  } catch {
    port = null;
  }
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !ev.data || ev.data.source !== TAG) return;
  send(ev.data.payload);
});

// Keeps the service worker awake while a game tab is open
setInterval(() => send({ type: 'tab', attached: true, url: location.href }), KEEPALIVE_MS);

// In-app navigation (lobby -> match -> back) is reported right away: AutoGlow uses the page to know
// whether a lobby is still open
let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  send({ type: 'tab', attached: true, url: lastUrl });
}, 1000);

getPort();

// -----------------------------------------------------------------------------
// WLED menu: a button left of the profile picture in the header that lists AutoGlow's
// WLED controllers and switches them off
// -----------------------------------------------------------------------------
const POWER_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>';
const BULB_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>';

const wledHost = document.createElement('span');
wledHost.style.display = 'contents';
const wledRoot = wledHost.attachShadow({ mode: 'open' });
wledRoot.innerHTML = `
<style>
  .trigger { all: unset; box-sizing: border-box; width: 32px; height: 32px; display: flex; align-items: center;
    justify-content: center; border-radius: 50%; color: #fff; cursor: pointer; transition: color .15s; }
  .trigger:hover, .trigger[aria-expanded="true"] { color: #6ea8ff; }
  .menu { position: fixed; z-index: 2147483000; width: 260px; padding: 8px; box-sizing: border-box;
    background: #202124; border: 1px solid #34363b; border-radius: 12px; color: #fff; font-size: 13px;
    box-shadow: 0 8px 24px rgba(0,0,0,.5); }
  .menu[hidden] { display: none; }
  .head { padding: 2px 4px 6px; font-size: 11px; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; color: #9aa0a6; }
  .row { display: flex; align-items: center; gap: 8px; padding: 4px; border-radius: 8px; }
  .row:hover { background: #2b2d31; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #6b7280; }
  .dot.on { background: #22c55e; }
  .dot.offline { background: #ef4444; }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { color: #9aa0a6; font-size: 12px; }
  .off { all: unset; box-sizing: border-box; width: 26px; height: 26px; display: flex; align-items: center;
    justify-content: center; border-radius: 6px; color: #fca5a5; cursor: pointer; flex: none; }
  .off:hover { background: #3a2a2c; color: #f87171; }
  .off.on { color: #86efac; }
  .off.on:hover { background: #1f3a2a; color: #4ade80; }
  .off:disabled { color: #4b5563; cursor: default; background: none; }
  .all { all: unset; box-sizing: border-box; display: flex; align-items: center; justify-content: center; gap: 6px;
    width: 100%; margin-top: 6px; padding: 6px; border-radius: 8px; background: #3a2a2c; color: #fca5a5;
    font-weight: 600; cursor: pointer; }
  .all:hover { background: #4a2c2f; color: #fecaca; }
  .all:disabled { opacity: .5; cursor: default; }
  .msg { padding: 6px 4px; color: #9aa0a6; }
  .msg.err { color: #fca5a5; }
</style>
<button class="trigger" type="button" title="AutoGlow lights" aria-label="AutoGlow lights" aria-haspopup="true" aria-expanded="false">${BULB_ICON}</button>
<div class="menu" role="menu" hidden>
  <div class="head">AutoGlow · WLED</div>
  <div class="list"></div>
</div>`;

const wledTrigger = wledRoot.querySelector('.trigger');
const wledMenu = wledRoot.querySelector('.menu');
const wledListEl = wledRoot.querySelector('.list');

function ask(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false } : res));
    } catch {
      resolve({ ok: false, reload: true }); // Extension was reloaded: this tab needs a page refresh
    }
  });
}

function stateOf(d) {
  if (d.online === false) return ['offline', 'offline'];
  if (d.on === false) return ['', 'off'];
  return ['on', d.online === null ? 'live' : 'on']; // online null: AutoGlow streams to it right now
}

async function loadWled(note) {
  wledListEl.innerHTML = '<div class="msg">Loading…</div>';
  const res = await ask({ type: 'wledList' });
  if (!res || !res.ok) {
    wledListEl.innerHTML = `<div class="msg">${res && res.reload ? 'Reload this page to use AutoGlow.' : 'AutoGlow is not reachable.'}</div>`;
    return;
  }
  const devices = res.data;
  if (!devices.length) {
    wledListEl.innerHTML = '<div class="msg">No WLED controllers set up in AutoGlow.</div>';
    return;
  }
  wledListEl.textContent = '';
  for (const d of devices) {
    const [cls, label] = stateOf(d);
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<span class="dot ${cls}"></span><span class="name"></span><span class="state">${label}</span>
      <button class="off" type="button">${POWER_ICON}</button>`;
    row.querySelector('.name').textContent = d.name;
    row.querySelector('.name').title = d.ip;
    const btn = row.querySelector('.off');
    const turnOn = d.on === false;
    btn.classList.toggle('on', turnOn);
    btn.title = `Switch ${d.name} ${turnOn ? 'on' : 'off'}`;
    btn.disabled = d.online === false;
    btn.addEventListener('click', () => setPower(btn, turnOn, d.ip));
    wledListEl.append(row);
  }
  if (devices.length > 1) {
    const all = document.createElement('button');
    all.className = 'all';
    all.type = 'button';
    all.innerHTML = `${POWER_ICON}<span>All off</span>`;
    all.addEventListener('click', () => setPower(all, false, null));
    wledListEl.append(all);
  }
  if (note) {
    const msg = document.createElement('div');
    msg.className = 'msg err';
    msg.textContent = note;
    wledListEl.append(msg);
  }
}

async function setPower(btn, on, ip) {
  btn.disabled = true;
  const res = await ask({ type: 'wledPower', on, ip });
  const word = on ? 'on' : 'off';
  let note = '';
  if (!res || !res.ok) note = `AutoGlow did not switch it ${word}.`;
  else if (res.data.status !== 'ok') note = `Sent, but not every controller confirmed it is ${word}.`;
  loadWled(note);
}

function placeMenu() {
  const r = wledTrigger.getBoundingClientRect();
  wledMenu.style.top = `${r.bottom + 10}px`;
  wledMenu.style.right = `${Math.max(8, window.innerWidth - r.right - 60)}px`;
}

function setMenuOpen(open) {
  wledMenu.hidden = !open;
  wledTrigger.setAttribute('aria-expanded', String(open));
  if (open) {
    placeMenu();
    loadWled();
  }
}

wledTrigger.addEventListener('click', () => setMenuOpen(wledMenu.hidden));
document.addEventListener('click', (ev) => {
  if (!wledMenu.hidden && !ev.composedPath().includes(wledHost)) setMenuOpen(false);
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !wledMenu.hidden) setMenuOpen(false);
});
window.addEventListener('resize', () => { if (!wledMenu.hidden) placeMenu(); });

// The Autodarts app re-renders its header, so the button is put back whenever it went missing
function placeWledButton() {
  const avatar = document.querySelector('header button [data-slot="avatar"]');
  const profileBtn = avatar && avatar.closest('button');
  if (!profileBtn) return;
  if (wledHost.nextElementSibling !== profileBtn) profileBtn.before(wledHost);
}
setInterval(placeWledButton, 1000);
document.addEventListener('DOMContentLoaded', placeWledButton);
