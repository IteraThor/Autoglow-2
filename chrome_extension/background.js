// AutoGlow Bridge - background service worker.
// Keeps a WebSocket open to the local AutoGlow server and relays game data from one
// play.autodarts.com tab (the oldest open one, so two tabs never double-fire events).

// 127.0.0.1, not "localhost": localhost can resolve to IPv6 ::1 first.
// AutoGlow only accepts the extension from Chrome on the same computer, on its default port
const SERVER_URL = 'http://127.0.0.1:8080';
const BRIDGE_URL = 'ws://127.0.0.1:8080/ws/autodarts-bridge';
const PING_MS = 20000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const QUEUE_LIMIT = 50;
const QUEUE_MAX_AGE_MS = 5000; // Older game data would light the board for something already over
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

let socket = null;
let socketOpen = false;
let lastError = '';
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let pingTimer = null;
let queue = [];
// Newest match state of the primary tab. Resent (as a replay, so it lights nothing) whenever AutoGlow
// connects, so the Studio scoreboard is complete right away instead of after the next dart.
let matchSnapshot = null; // { at, payload }
// Same for the lobby the tab has open, so the Studio shows the picked players after a reconnect
let lobbySnapshot = null; // { at, payload }

const tabs = new Map(); // tabId -> { port, url }
let primaryTabId = null;

// -----------------------------------------------------------------------------
// AutoGlow connection
// -----------------------------------------------------------------------------
function connect() {
  if (socket) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const ws = new WebSocket(BRIDGE_URL);
  socket = ws;

  ws.onopen = () => {
    socketOpen = true;
    lastError = '';
    reconnectDelay = RECONNECT_MIN_MS;
    sendNow({ type: 'hello', version: chrome.runtime.getManifest().version });
    sendNow(primaryTabState());
    const now = Date.now();
    for (const snap of [lobbySnapshot, matchSnapshot]) {
      if (snap && now - snap.at <= SNAPSHOT_MAX_AGE_MS) sendNow({ ...snap.payload, replay: true });
    }
    for (const item of queue) {
      if (now - item.at <= QUEUE_MAX_AGE_MS) sendNow(item.payload);
    }
    queue = [];
    pingTimer = setInterval(() => sendNow({ type: 'ping' }), PING_MS);
    updateBadge();
  };

  ws.onclose = (ev) => {
    if (socket !== ws) return;
    if (!socketOpen) {
      lastError = ev.code === 1006
        ? 'AutoGlow not reachable (is it running?)'
        : `Connection closed (${ev.code})`;
    }
    socket = null;
    socketOpen = false;
    clearInterval(pingTimer);
    pingTimer = null;
    updateBadge();
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose follows and handles reconnecting
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
}

function reconnectNow() {
  if (socket) {
    const old = socket;
    socket = null;
    socketOpen = false;
    clearInterval(pingTimer);
    old.close();
  }
  reconnectDelay = RECONNECT_MIN_MS;
  connect();
}

function sendNow(payload) {
  if (socket && socketOpen) socket.send(JSON.stringify(payload));
}

function relay(payload) {
  if (socket && socketOpen) {
    sendNow(payload);
    return;
  }
  queue.push({ at: Date.now(), payload });
  if (queue.length > QUEUE_LIMIT) queue.shift();
  connect();
}

function rememberSnapshot(msg) {
  const m = msg.type === 'ws' ? msg.message : null;
  if (m && m.channel === 'autodarts.matches' && typeof m.topic === 'string' && m.topic.endsWith('.state')) {
    matchSnapshot = { at: Date.now(), payload: msg };
  } else if (m && m.channel === 'autodarts.lobbies' && typeof m.topic === 'string' && m.topic.endsWith('.state')) {
    lobbySnapshot = { at: Date.now(), payload: msg };
  } else if (msg.type === 'http' && /\/gs\/v\d+\/lobbies\/[^/?#]+\/?(\?|$)/.test(msg.url || '') && msg.body && msg.body.id) {
    lobbySnapshot = { at: Date.now(), payload: msg };
  } else if (msg.type === 'http' && /\/gs\/v\d+\/matches\/[^/?#]+\/?(\?|$)/.test(msg.url || '') && msg.body && msg.body.id) {
    // The match the Autodarts app loaded, e.g. after a page reload in the middle of a game
    matchSnapshot = {
      at: Date.now(),
      payload: { type: 'ws', message: { channel: 'autodarts.matches', topic: `${msg.body.id}.state`, data: msg.body } }
    };
  }
}

// -----------------------------------------------------------------------------
// Autodarts tabs
// -----------------------------------------------------------------------------
function primaryTabState() {
  const tab = primaryTabId !== null ? tabs.get(primaryTabId) : null;
  return tab ? { type: 'tab', attached: true, url: tab.url } : { type: 'tab', attached: false };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'autodarts-tab' || !port.sender || !port.sender.tab) return;
  const tabId = port.sender.tab.id;
  tabs.set(tabId, { port, url: port.sender.url || '' });
  if (primaryTabId === null) primaryTabId = tabId;

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'tab') {
      const tab = tabs.get(tabId);
      if (tab) tab.url = msg.url || tab.url;
    }
    if (tabId !== primaryTabId) return;
    rememberSnapshot(msg);
    relay(msg);
    updateBadge();
  });

  port.onDisconnect.addListener(() => {
    const tab = tabs.get(tabId);
    if (tab && tab.port === port) tabs.delete(tabId);
    if (primaryTabId === tabId && !tabs.has(tabId)) {
      primaryTabId = tabs.size ? tabs.keys().next().value : null;
      matchSnapshot = null;
      lobbySnapshot = null;
      relay(primaryTabState());
    }
    updateBadge();
  });

  connect();
  updateBadge();
});

// -----------------------------------------------------------------------------
// Toolbar badge & popup
// -----------------------------------------------------------------------------
function updateBadge() {
  let text = 'OFF';
  let color = '#dc2626';
  if (socketOpen && primaryTabId !== null) {
    text = 'ON';
    color = '#16a34a';
  } else if (socketOpen) {
    text = '•';
    color = '#d97706';
  }
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function status() {
  const tab = primaryTabId !== null ? tabs.get(primaryTabId) : null;
  return {
    serverUrl: SERVER_URL,
    connected: socketOpen,
    connecting: !!socket && !socketOpen,
    lastError,
    tabAttached: !!tab,
    tabUrl: tab ? tab.url : '',
    tabCount: tabs.size,
    version: chrome.runtime.getManifest().version
  };
}

// -----------------------------------------------------------------------------
// WLED menu in the play.autodarts.com header (content.js). The https page may not call localhost,
// so the requests go through here.
// -----------------------------------------------------------------------------
async function api(path, options) {
  const res = await fetch(SERVER_URL + path, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function wledList() {
  const hub = await api('/api/hub/status');
  return (hub.devices || [])
    .filter(d => d.enabled && d.ip)
    .map(d => ({ name: d.name || d.ip, ip: d.ip, online: d.online, on: d.on }));
}

function wledPower(on, ip) {
  // No ip: every controller, and AutoGlow treats the lights as switched off (standby)
  return api(on ? '/api/power/test_wake' : '/api/power/test_off', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ip ? { ip } : {})
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && (msg.type === 'wledList' || msg.type === 'wledPower')) {
    (msg.type === 'wledList' ? wledList() : wledPower(msg.on, msg.ip))
      .then(data => sendResponse({ ok: true, data }))
      .catch(() => sendResponse({ ok: false }));
    return true; // Answered asynchronously
  }
  if (msg && msg.type === 'getStatus') {
    connect();
    sendResponse(status());
  } else if (msg && msg.type === 'reconnect') {
    // Sent by the popup's Reconnect button
    reconnectNow();
    sendResponse(status());
  }
});

// -----------------------------------------------------------------------------
// Startup: stay connected in the background whenever Chrome is running
// -----------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('autoglow-keepalive', { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('autoglow-keepalive', { periodInMinutes: 1 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'autoglow-keepalive') connect();
});

updateBadge();
connect();
