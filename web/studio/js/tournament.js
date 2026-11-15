// AutoGlow Local Tournament dashboard for a TV: it runs by itself all evening. The lobby before the
// start, then the boards with their live scores, what is up next and a panel that rotates through
// bracket, tables, results and leaders, and the champion at the end. Reads /api/tournament/local (the
// host PC has every board's score; a joined board gets them from the host) and the Studio players for
// pictures and nicknames. Parts: tournament-model.js (the data), tournament-scenes.js (the HTML),
// tournament-dom.js (changing the page with animations).

import { derive, esc } from './tournament-model.js';
import { patch, reset, swap, syncNums, flyWinners } from './tournament-dom.js';
import * as S from './tournament-scenes.js';
import { tickerItems, makeTicker } from './tournament-ticker.js';

const POLL_MS = 1000;
const ROSTER_MS = 30000;
const SETTINGS_MS = 3000;
const $ = id => document.getElementById(id);
const screen = $('screen');

// What the TVs show, set on the Dashboard page and saved on the server (/api/dashboard). layout:
// overview (boards left, scene right), boards (a row per board), wall (the scene fills the screen,
// boards in a strip), single (one scene at a time). theme "studio" takes the Studio's look and accent.
// For trying, the address takes ?layout= and ?theme=; ?preview=1 is the Dashboard page's preview, which
// also shows edits before they are saved.
const DEFAULTS = {
  layout: 'overview', theme: 'arena', accent: '', photos: true, clock: true, boards: true, upnext: true, safe: 0, title: '', subtitle: '', logo: '',
  scenes: [{ id: 'bracket', secs: 14, on: true }, { id: 'tables', secs: 14, on: true }, { id: 'results', secs: 10, on: true }, { id: 'leaders', secs: 10, on: true }],
  ticker: true, ticker_speed: 'normal', ticker_items: {}, ticker_text: '', text: 'normal', calm: false
};
const LAYOUTS = ['overview', 'boards', 'wall', 'single'];
const THEMES = ['arena', 'flap', 'poster'];
// The Studio's looks, as the dashboard look closest to each
const STUDIO_LOOK = { autodarts: 'arena', neon: 'arena', velocity: 'arena', arena: 'flap', pub: 'flap', tv: 'poster', daylight: 'poster', glass: 'poster' };
const query = new URLSearchParams(location.search);
const preview = query.has('preview');
let saved = {};          // the settings from the server
let draft = null;        // unsaved edits from the Dashboard page (preview only)
let studioLook = { theme: 'autodarts', accent: '' };
let hold = '';           // a scene every TV shows now ("" = the rotation)
const cfg = { ...DEFAULTS };

// The settings in force: saved, edits in the preview, the Studio's look, the address
function resolveCfg() {
  const src = { ...DEFAULTS, ...saved, ...(draft || {}) };
  if (src.theme === 'studio') {
    src.theme = STUDIO_LOOK[studioLook.theme] || 'arena';
    src.accent = studioLook.accent || '';
  }
  if (LAYOUTS.includes(query.get('layout'))) src.layout = query.get('layout');
  if (THEMES.includes(query.get('theme'))) src.theme = query.get('theme');
  src.logo = src.logo ? `/api/dashboard/logo/${encodeURIComponent(src.logo)}` : '';
  src.scenes = (src.scenes || []).filter(x => x.on !== false);
  Object.keys(cfg).forEach(k => delete cfg[k]);
  Object.assign(cfg, src);
  applyCfg();
}

// The screen is 192 x 108 rem: 1rem is a 192nd of the width (or a 108th of the height on a wider
// screen), so text and lines are drawn at the TV's own resolution, 4K included, instead of a scaled
// 1080p picture. cfg.safe keeps a margin for TVs that crop the edges. Large text makes the screen
// 166.4 x 93.6 rem: everything is 15 % bigger and the scenes fit less on a page.
let fitted = '';
function fit() {
  const k = 1 - (2 * cfg.safe) / 100;
  const [w, h] = cfg.text === 'large' ? [166.4, 93.6] : [192, 108];
  const root = document.documentElement;
  root.style.setProperty('--sw', w);
  root.style.setProperty('--sh', h);
  root.style.fontSize = `${Math.min((innerWidth * k) / w, (innerHeight * k) / h)}px`;
  const key = `${root.style.fontSize}|${w}`;
  if (key !== fitted) {
    fitted = key;
    ticker?.relayout();
  }
}
function applyCfg() {
  const root = document.documentElement;
  root.dataset.theme = cfg.theme;
  root.classList.toggle('no-pics', !cfg.photos);
  // Calm: nothing blinks or drifts, scenes cross-fade (tournament-dom.js reads the class too)
  root.classList.toggle('calm', !!cfg.calm);
  // The accent as "r, g, b": the looks also use it see-through
  const hex = /^#?([0-9a-f]{6})$/i.exec(cfg.accent || '');
  if (hex) root.style.setProperty('--accent-rgb', [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)).join(', '));
  else root.style.removeProperty('--accent-rgb');
  fit();
}
let ticker = null;
addEventListener('resize', fit);
resolveCfg();
ticker = makeTicker($('tk'));
// The line is measured in its fonts: once they have loaded, measure it again
document.fonts?.ready.then(() => ticker.relayout());
if (preview) $('hint').hidden = true;
document.addEventListener('dblclick', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
setTimeout(() => $('hint').classList.add('gone'), 4000);

// --- The frame of each layout: where boards, up next and the rotating scene sit ---------------------------
const HEAD = '<header class="hd" id="hd"></header>';
const SCENE = '<section class="sc" id="sc"><div class="sc-top"><div class="sc-tabs" id="tabs"></div><div class="sc-bar" id="bar"></div></div><div class="sc-wrap"><div class="sc-body" id="body"></div></div></section>';
const FRAMES = {
  full: '<div class="full" id="full"></div>',
  overview: `${HEAD}<main class="mn"><section class="lv"><h2 id="lvh"></h2><div class="bds" id="boards"></div><h2 id="nxh">Up next</h2><div class="nxs" id="next"></div></section>${SCENE}</main>`,
  boards: `${HEAD}<main class="mn"><div class="bds" id="boards"></div><div class="lw"><section class="pnl" id="nxp"><h3>Up next</h3><div class="nxs" id="next"></div></section>${SCENE}<section class="pnl" id="side"></section></div></main>`,
  wall: `${HEAD}<main class="mn">${SCENE}<div class="bds" id="boards"></div></main>`,
  single: `${HEAD}<main class="mn">${SCENE}</main>`
};

let data = null;
let roster = [];
let mounted = '';
let frame = '';
let cur = { id: '', at: 0, fresh: false };   // the scene on screen and since when

// The layout this screen uses: one held scene fills the screen; without boards and up next the
// overview has nothing for its left side
function layoutNow() {
  if (hold) return 'single';
  if (cfg.layout === 'overview' && !cfg.boards && !cfg.upnext) return 'single';
  if (cfg.layout === 'boards' && !cfg.boards) return 'single';
  return cfg.layout;
}

function mount(kind) {
  frame = kind === 'run' ? layoutNow() : kind === 'end' ? 'single' : 'full';
  screen.dataset.kind = kind;
  screen.dataset.layout = frame;
  screen.innerHTML = FRAMES[frame];
  screen.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 700, easing: 'ease-out' });
  cur = { id: '', at: 0, fresh: false };
}

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// How many "up next" lines fit beside this many boards
function nextRows(n) {
  if (frame === 'boards') return 4;
  return n <= 1 ? 6 : n === 2 ? 4 : n === 3 ? 2 : n === 4 ? 1 : 0;
}

function sidePanel(M) {
  const tiles = S.leaderTiles(M);
  const top = M.stats.byAvg.slice(0, Math.max(0, 4 - tiles.length));
  if (!tiles.length) return '<h3>Leaders</h3><div class="mnote">After the first match</div>';
  return `<h3>Leaders</h3>${tiles.map(([k, v, p]) => `<div class="lr" data-k="lr-${k}" data-in>${S.av(p)}<div><small>${k}</small><b>${esc(p?.name || '')}</b></div><span class="num lrv" data-num="${v}" data-pad="${String(v).length}"></span></div>`).join('')}` +
    top.map((r, i) => `<div class="lr" data-k="la-${r.id}" data-in>${S.av(M.players.get(r.id))}<div><small>Average · ${i + 1}</small><b>${esc(M.players.get(r.id)?.name || '')}</b></div><span class="num lrv" data-num="${r.avg.toFixed(1)}" data-pad="${r.avg.toFixed(1).length}"></span></div>`).join('');
}

// --- The rotating scene -----------------------------------------------------------------------------------
function scene(M, kind) {
  const body = $('body');
  const rem = parseFloat(document.documentElement.style.fontSize) || 10;
  const size = { w: body.clientWidth / rem, h: body.clientHeight / rem };
  if (size.w < 10 || size.h < 10) return;
  const own = frame === 'single' && kind === 'run' && cfg.boards ? [{ id: 'boards', secs: 14 }, ...cfg.scenes] : cfg.scenes;
  // A held scene stays on screen; one this tournament doesn't have leaves the rotation running
  const held = hold && kind === 'run' ? S.scenes(M, size, { ...cfg, scenes: [{ id: hold, secs: 3600 }] }) : [];
  let list = held.length ? held : S.scenes(M, size, { ...cfg, scenes: own });
  if (kind === 'end' && M.champion) list = [{ id: 'champion', kind: 'champion', name: 'Champion', part: '', secs: 20, html: () => S.champion(M) }, ...list];
  if (!list.length) {
    patch($('tabs'), '');
    $('bar').replaceChildren();
    patch(body, '<div class="mnote">The first results show here</div>');
    cur = { id: '', at: 0, fresh: false };
    return;
  }
  const now = Date.now();
  let ix = list.findIndex(s => s.id === cur.id);
  if (ix < 0) ix = 0;
  else if (now - cur.at > list[ix].secs * 1000 && list.length > 1) ix = (ix + 1) % list.length;
  if (list[ix].id !== cur.id) cur = { id: list[ix].id, at: now, fresh: true };
  const sc = list[ix];
  const names = [...new Set(list.map(s => s.name))];
  patch($('tabs'), names.map(n => `<span class="${n === sc.name ? 'on' : ''}" data-k="${n}">${n}${n === sc.name && sc.part ? `<small>${sc.part}</small>` : ''}</span>`).join(''));
  const fill = () => {
    patch(body, sc.html());
    if (sc.kind === 'bracket') flyWinners(body);
  };
  if (!cur.fresh) return fill();
  // A new scene: the line under the tabs runs for as long as it stays
  cur.fresh = false;
  $('bar').innerHTML = list.length > 1 ? `<i style="animation-duration:${sc.secs}s"></i>` : '';
  body.dataset.scene = sc.kind;
  swap(body, fill);
}

function render() {
  const M = derive(data, roster);
  const kind = !M ? 'none' : M.lobby ? 'lobby' : M.finished ? 'end' : 'run';
  const key = `${kind}|${layoutNow()}|${cfg.theme}|${cfg.boards}|${cfg.upnext}`;
  if (key !== mounted) {
    mounted = key;
    mount(kind);
  }
  screen.classList.toggle('no-boards', !cfg.boards);
  screen.classList.toggle('no-next', !cfg.upnext);
  if (kind === 'none') patch($('full'), S.idle());
  else if (kind === 'lobby') patch($('full'), S.lobby(M, cfg));
  else {
    patch($('hd'), S.header(M, cfg, clock()));
    const n = M.playing.length;
    screen.dataset.n = Math.min(n, 9);
    const bds = cfg.boards ? $('boards') : null;
    if (bds) {
      // A row per board while they fit, else compact cards side by side
      const rows = frame === 'boards' && n <= 4;
      bds.classList.toggle('rows', rows);
      patch(bds, S.boards(M, rows));
    }
    if ($('lvh')) patch($('lvh'), `${M.progress.live ? '<i class="dot"></i>' : ''}${M.progress.live ? 'Live now' : 'On the boards'}<span>${M.boards.length ? `${M.playing.length} of ${M.boards.length} board${M.boards.length > 1 ? 's' : ''}` : ''}</span>`);
    if ($('next') && cfg.upnext) {
      const some = patchNext(M, n);
      if ($('nxh')) $('nxh').hidden = !some;
    }
    if ($('side')) patch($('side'), sidePanel(M));
    scene(M, kind);
  }
  syncNums(screen, cfg.theme === 'flap');
  const items = cfg.ticker && kind !== 'none' ? tickerItems(M, cfg) : [];
  ticker.update(items, cfg);
  $('stage').classList.toggle('with-tk', items.length > 0);
}

function patchNext(M, n) {
  const html = S.upNext(M, nextRows(n));
  patch($('next'), html || (frame === 'boards' ? '<div class="mnote">Nothing waiting</div>' : ''));
  return !!html;
}

async function loadRoster() {
  try {
    const r = await fetch('/api/studio', { cache: 'no-store' });
    if (r.ok) {
      const body = await r.json();
      const st = body.data ?? body;
      roster = st.players || [];
      const look = { theme: st.theme || 'autodarts', accent: st.accent || '' };
      if (look.theme !== studioLook.theme || look.accent !== studioLook.accent) {
        studioLook = look;
        resolveCfg();
      }
    }
  } catch (err) { /* the names still show, without pictures */ }
  setTimeout(loadRoster, ROSTER_MS);
}

async function poll() {
  try {
    const r = await fetch('/api/tournament/local', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status);
    const body = await r.json();
    data = body.data ?? body;
    $('offline').hidden = true;
  } catch (err) {
    $('offline').hidden = false;
  }
  try {
    render();
  } catch (err) {
    // One bad frame must not stop the screen for the evening: build it new on the next round
    console.error(err);
    mounted = '';
    reset(screen);
  }
  setTimeout(poll, POLL_MS);
}

// The Dashboard page's settings, and what every TV holds now
async function loadSettings() {
  try {
    const r = await fetch('/api/dashboard', { cache: 'no-store' });
    if (r.ok) {
      const body = await r.json();
      const { hold: h, ...rest } = body.data ?? body;
      saved = rest;
      hold = h?.scene || '';
      resolveCfg();
    }
  } catch (err) { /* keeps the last settings */ }
  setTimeout(loadSettings, SETTINGS_MS);
}

// The preview gets the Dashboard page's edits at once
if (preview && 'BroadcastChannel' in window) {
  new BroadcastChannel('autoglow-dashboard-draft').onmessage = e => {
    if (e.data?.type === 'draft') draft = e.data.settings;
    else if (e.data?.type === 'clear') draft = null;
    else if (e.data?.type === 'hold') hold = e.data.scene || '';
    resolveCfg();
    if (data) render();
  };
}

Promise.all([loadRoster(), loadSettings()]).then(poll);
