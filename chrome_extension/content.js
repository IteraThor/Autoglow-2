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

// Keeps the service worker awake while a game tab is open and reports in-app navigation
setInterval(() => send({ type: 'tab', attached: true, url: location.href }), KEEPALIVE_MS);

getPort();
