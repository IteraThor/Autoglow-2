// AutoGlow Bridge - page hook (runs in the play.autodarts.com page context).
// Passively observes the game data the Autodarts web app already receives and hands it to
// content.js. It never sends anything to Autodarts and never reads credentials or tokens.
(() => {
  if (window.__autoglowBridgeHooked) return;
  window.__autoglowBridgeHooked = true;

  const TAG = 'autoglow-bridge';
  const RELAYED_CHANNELS = new Set(['autodarts.boards', 'autodarts.matches']);
  const RELAYED_PATHS = [
    /^\/bs\/v\d+\/boards\/?$/,            // board list (names, online state)
    /^\/bs\/v\d+\/boards\/[^/]+\/?$/,     // single board
    /^\/gs\/v\d+\/matches\/[^/]+\/?$/     // match snapshot (players, turns)
  ];

  const post = (payload) => window.postMessage({ source: TAG, payload }, window.location.origin);

  function isRelayedUrl(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.href);
      return url.hostname.endsWith('autodarts.com') && RELAYED_PATHS.some((re) => re.test(url.pathname));
    } catch {
      return false;
    }
  }

  // --- WebSocket: relay board and match channels only ---
  function relaySocketFrame(raw) {
    if (typeof raw !== 'string') return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      if (msg && RELAYED_CHANNELS.has(msg.channel)) {
        post({ type: 'ws', message: { channel: msg.channel, topic: msg.topic, data: msg.data } });
      }
    }
  }

  const NativeWebSocket = window.WebSocket;
  class ObservedWebSocket extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      if (String(url).includes('autodarts.')) {
        this.addEventListener('message', (ev) => relaySocketFrame(ev.data));
      }
    }
  }
  window.WebSocket = ObservedWebSocket;

  // --- fetch: relay board/match REST responses ---
  const nativeFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const url = response.url || (args[0] && args[0].url) || String(args[0]);
      if (response.ok && isRelayedUrl(url)) {
        response.clone().json().then((body) => post({ type: 'http', url, body })).catch(() => {});
      }
    } catch {
      // Never interfere with the page's own request handling
    }
    return response;
  };

  // --- XMLHttpRequest: same as fetch, for libraries that use XHR ---
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__autoglowUrl = String(url);
    return nativeOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__autoglowUrl && isRelayedUrl(this.__autoglowUrl)) {
      this.addEventListener('load', () => {
        if (this.status < 200 || this.status >= 300) return;
        try {
          let body = null;
          if (this.responseType === 'json') body = this.response;
          else if (this.responseType === '' || this.responseType === 'text') body = JSON.parse(this.responseText);
          if (body) post({ type: 'http', url: this.responseURL || this.__autoglowUrl, body });
        } catch {
          // Non-JSON response: ignore
        }
      });
    }
    return nativeSend.apply(this, args);
  };
})();
