// AutoGlow Bridge - content script (isolated world).
// Forwards what page_hook.js observed to the background service worker over a long-lived port.
const TAG = 'autoglow-bridge';
const { t } = window.agI18n;
const KEEPALIVE_MS = 20000;

let port = null;

function getPort() {
  if (port) return port;
  try {
    port = chrome.runtime.connect({ name: 'autodarts-tab' });
    port.onDisconnect.addListener(() => { port = null; });
    port.postMessage({ type: 'tab', attached: true, url: location.href, lang: window.agI18n.lang() });
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
setInterval(() => send({ type: 'tab', attached: true, url: location.href, lang: window.agI18n.lang() }), KEEPALIVE_MS);

// In-app navigation (lobby -> match -> back) is reported right away: AutoGlow uses the page to know
// whether a lobby is still open
let lastUrl = location.href;
setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  send({ type: 'tab', attached: true, url: lastUrl, lang: window.agI18n.lang() });
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
<button class="trigger" type="button" aria-haspopup="true" aria-expanded="false">${BULB_ICON}</button>
<div class="menu" role="menu" hidden>
  <div class="head">AutoGlow · WLED</div>
  <div class="list"></div>
</div>`;

const wledTrigger = wledRoot.querySelector('.trigger');
const wledMenu = wledRoot.querySelector('.menu');
const wledListEl = wledRoot.querySelector('.list');

function labelTrigger() {
  wledTrigger.title = t('AutoGlow lights');
  wledTrigger.setAttribute('aria-label', wledTrigger.title);
}
labelTrigger();
// Autodarts switched its language: the button's label, and the menu if it is open
window.agI18n.onChange(() => { labelTrigger(); if (!wledMenu.hidden) loadWled(); });

const RELOAD_NOTE = () => t('The AutoGlow Bridge was updated or restarted. Reload this page (F5).');

function ask(msg) {
  return new Promise((resolve) => {
    // Extension was reloaded: this tab's script is cut off from it until the page is refreshed
    if (!chrome.runtime || !chrome.runtime.id) return resolve({ ok: false, reload: true });
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : res || { ok: false, error: 'no answer' });
      });
    } catch {
      resolve({ ok: false, reload: true });
    }
  });
}

function failNote(res, what) {
  if (res.reload) return RELOAD_NOTE();
  return `${what} (${window.agI18n.srv(res.error) || t('unknown error')})`;
}

function stateOf(d) {
  if (d.online === false) return ['offline', t('offline')];
  if (d.on === false) return ['', t('off')];
  return ['on', d.online === null ? t('live') : t('on')]; // online null: AutoGlow streams to it right now
}

async function loadWled(note) {
  wledListEl.innerHTML = `<div class="msg">${t('Loading…')}</div>`;
  const res = await ask({ type: 'wledList' });
  if (!res.ok) {
    wledListEl.innerHTML = '<div class="msg err"></div>';
    wledListEl.firstChild.textContent = failNote(res, t('AutoGlow is not reachable'));
    return;
  }
  const devices = res.data;
  if (!devices.length) {
    wledListEl.innerHTML = `<div class="msg">${t('No WLED controllers set up in AutoGlow.')}</div>`;
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
    btn.title = t(turnOn ? 'Switch {name} on' : 'Switch {name} off', { name: d.name });
    btn.disabled = d.online === false;
    btn.addEventListener('click', () => setPower(btn, turnOn, d.ip));
    wledListEl.append(row);
  }
  if (devices.length > 1) {
    const all = document.createElement('button');
    all.className = 'all';
    all.type = 'button';
    all.innerHTML = `${POWER_ICON}<span>${t('All off')}</span>`;
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
  let note = '';
  if (!res.ok) note = failNote(res, t(on ? 'AutoGlow did not switch it on' : 'AutoGlow did not switch it off'));
  else if (res.data.status !== 'ok') note = t(on ? 'Sent, but not every controller confirmed it is on.' : 'Sent, but not every controller confirmed it is off.');
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

// The menu is centred in the header and our button widens the right-hand side, so on a narrow
// window they meet. Then the logo goes and the menu moves to the left edge to make room.
const tightStyle = document.createElement('style');
tightStyle.textContent = 'header[data-autoglow-tight] > a:first-child { visibility: hidden !important; } '
  + 'html[data-autoglow-home] main [class*="container/card"] { display: none !important; } ' // the account holder's stats card on the start page
  + 'header[data-autoglow-tight] > nav { left: var(--ag-nav-left, 16px) !important; transform: none !important; translate: none !important; } '
  // Still too narrow without the logo: less room between the items, then a smaller font
  + 'header[data-autoglow-squeeze] > nav { gap: 14px !important; } '
  + 'header[data-autoglow-squeeze="2"] > nav { gap: 10px !important; } header[data-autoglow-squeeze="2"] > nav { font-size: 15px !important; }';
document.documentElement.appendChild(tightStyle);
function fitHeader() {
  const header = document.querySelector('header');
  const nav = header && header.querySelector(':scope > nav');
  const right = wledHost.parentElement;
  if (!nav || !right || !nav.offsetParent) return;
  header.removeAttribute('data-autoglow-tight');
  header.removeAttribute('data-autoglow-squeeze');
  /** Where the menu's items start and end (the nav box itself can be cut short by Autodarts' centring) */
  const span = () => {
    const shown = [...nav.children].filter(c => c.offsetWidth);
    const r = nav.getBoundingClientRect();
    return shown.length ? [shown[0].getBoundingClientRect().left, shown[shown.length - 1].getBoundingClientRect().right] : [r.left, r.right];
  };
  const [navStart, navEnd] = span();
  // our button is the left-most thing on the right-hand side
  const free = wledTrigger.getBoundingClientRect().left - 12;
  const logo = header.querySelector(':scope > a:first-child');
  const logoEnd = logo && logo.offsetWidth ? logo.getBoundingClientRect().right + 12 : 0;
  // The menu runs into the icons on the right, or into the logo on the left (longer German labels)
  if (navEnd > free || navStart < logoEnd) {
    header.setAttribute('data-autoglow-tight', '');
    for (const level of ['', '1', '2']) {
      if (level) header.setAttribute('data-autoglow-squeeze', level);
      // centre the menu in the room the right-hand side leaves, not in the window
      const [a, b] = span();
      header.style.setProperty('--ag-nav-left', `${Math.max(16, Math.round((16 + free - (b - a)) / 2))}px`);
      if (b - a <= free - 16) break;
    }
  }
}
function markHome() {
  document.documentElement.toggleAttribute('data-autoglow-home', location.pathname === '/');
}
setInterval(() => { placeWledButton(); fitHeader(); markHome(); }, 500);
markHome();
window.addEventListener('resize', fitHeader);
document.addEventListener('DOMContentLoaded', placeWledButton);
