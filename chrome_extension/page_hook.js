// AutoGlow Bridge - page hook (runs in the play.autodarts.com page context).
// Passively observes the game and lobby data the Autodarts web app already receives and hands it to
// content.js. The one exception is the Local Tournament's "Start game": when a person presses it, this
// sets up and starts that local game through Autodarts' API with the page's own login. The login
// stays in this page and only ever goes to api.autodarts.com.
(() => {
  if (window.__autoglowBridgeHooked) return;
  window.__autoglowBridgeHooked = true;

  const TAG = 'autoglow-bridge';
  const RELAYED_CHANNELS = new Set(['autodarts.boards', 'autodarts.matches', 'autodarts.lobbies']);
  const RELAYED_PATHS = [
    /^\/bs\/v\d+\/boards\/?$/,            // board list (names, online state)
    /^\/bs\/v\d+\/boards\/[^/]+\/?$/,     // single board
    /^\/gs\/v\d+\/matches\/[^/]+\/?$/,    // match snapshot (players, turns)
    /^\/gs\/v\d+\/lobbies\/[^/]+\/?$/     // lobby (players picked before the match starts)
  ];

  const post = (payload) => window.postMessage({ source: TAG, payload }, window.location.origin);

  // The Local Tournament's Start game opens Play from the match page through Autodarts' own router,
  // like its links do: no page load, so no "Leave site?" question. Play is the only page it opens.
  // A finished match skips Autodarts' "End this game?" question, as its own Finish button does.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'autoglow-nav' || ev.data.to !== '/play') return;
    const router = window.__TSR_ROUTER__;
    if (router && typeof router.navigate === 'function') router.navigate({ to: '/play', ignoreBlocker: ev.data.finished === true });
  });

  // --- Local Tournament "Start game" (the user allowed this on 2026-11-14) ---
  const API = 'https://api.autodarts.com';
  let auth = ''; // the Authorization header of the app's own latest API request

  const tokenTtl = () => {
    try {
      return JSON.parse(atob(auth.split(' ')[1].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp - Date.now() / 1000;
    } catch {
      return 0;
    }
  };

  const fresh = async (ms) => {
    for (let t = 0; t < ms && tokenTtl() <= 30; t += 100) await new Promise((r) => setTimeout(r, 100));
    return tokenTtl() > 30;
  };

  /** A login with some life left: else get the app to make a request, which renews it first.
   *  Reloading the page's data does that on most pages; the match page asks for nothing, so then
   *  it goes to Play (behind the cover; the new match opens next anyway). */
  async function login(finished) {
    if (tokenTtl() > 30) return auth;
    const router = window.__TSR_ROUTER__;
    if (router && typeof router.invalidate === 'function') router.invalidate();
    if (!(await fresh(1500)) && router && typeof router.navigate === 'function') {
      router.navigate({ to: '/play', ignoreBlocker: finished === true });
      await fresh(5000);
    }
    if (tokenTtl() <= 30) throw new Error('Autodarts login not found. Reload the page and try again.');
    return auth;
  }

  async function call(method, path, body) {
    const r = await nativeFetch(API + path, {
      method,
      headers: { Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      let msg = '';
      try { msg = JSON.parse(txt).message || JSON.parse(txt).error || ''; } catch { msg = txt.slice(0, 120); }
      throw new Error(`Autodarts said ${r.status}${msg ? `: ${msg}` : ''}`);
    }
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  }

  /** game: {settings: {base_score, in_mode, out_mode, legs, sets, bull_off}, players: [{name}]} */
  async function startGame(game, finished) {
    const board = localStorage.getItem('selectedBoard');
    if (!board) throw new Error('No board picked in Autodarts yet. Pick your board on the Play page once.');
    await login(finished);
    const s = game.settings;
    const lobby = await call('POST', '/gs/v0/lobbies', {
      variant: 'X01',
      settings: { baseScore: s.base_score, inMode: s.in_mode, outMode: s.out_mode, bullMode: '25/50', maxRounds: 50 },
      bullOffMode: s.bull_off, isPrivate: true, legs: s.legs, ...(s.sets ? { sets: s.sets } : {}), hasReferee: false,
    });
    try {
      const me = lobby.host || {};
      // Local players are always guests: they are added by name, never with an Autodarts account
      for (const p of game.players) {
        await call('POST', `/gs/v0/lobbies/${lobby.id}/players`, { name: p.name.trim().toUpperCase(), hostId: me.id, boardId: board });
      }
      await call('POST', `/gs/v0/lobbies/${lobby.id}/start`);
    } catch (e) {
      call('DELETE', `/gs/v0/lobbies/${lobby.id}`).catch(() => {});
      throw e;
    }
    const router = window.__TSR_ROUTER__;
    if (router && typeof router.navigate === 'function') router.navigate({ to: `/matches/${lobby.id}`, ignoreBlocker: finished === true });
    else window.location.assign(`/matches/${lobby.id}`);
    return lobby.id;
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.source !== 'autoglow-start' || !ev.data.game) return;
    const reply = (r) => window.postMessage({ source: 'autoglow-start-result', id: ev.data.id, ...r }, window.location.origin);
    startGame(ev.data.game, ev.data.finished).then((match) => reply({ ok: true, match }), (e) => reply({ ok: false, error: e.message }));
  });

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
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (/^authorization$/i.test(name) && /^Bearer /.test(value) && new URL(this.__autoglowUrl || '', window.location.href).origin === API) auth = value;
    } catch {
      // Never interfere with the page's own request handling
    }
    return nativeSetHeader.call(this, name, value);
  };
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
