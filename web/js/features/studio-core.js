// AutoGlow 2 - Studio: what all parts of the Studio page share. The settings object (one for the
// page's lifetime, so builders can keep references into it), automatic saving, the demo preview and
// the readiness checks. The broadcast itself is web/studio/live.html; it reads the same /api/studio.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';

export let settings = null;
export const imageUrl = name => `/api/studio/images/${encodeURIComponent(name)}`;
export const streamUrl = (camId, res) => `/api/studio/stream?cam=${encodeURIComponent(camId)}&res=${encodeURIComponent(res)}`;

// Saved values go into the objects the camera cards and dart zoom controls already hold, so their
// later edits still reach what is saved. The answer to our own save leaves those objects alone: the
// picture may have been dragged on while it was on its way.
function adopt(fresh, ownSave = false) {
  if (ownSave) {
    delete fresh.cameras;
    delete fresh.dart_zoom;
  }
  for (const [slot, cam] of Object.entries(fresh.cameras || {})) {
    if (settings.cameras?.[slot]) fresh.cameras[slot] = Object.assign(settings.cameras[slot], cam);
  }
  if (settings.dart_zoom && fresh.dart_zoom) fresh.dart_zoom = Object.assign(settings.dart_zoom, fresh.dart_zoom);
  Object.assign(settings, fresh, pending);
}

export async function loadSettings() {
  const fresh = await api('/api/studio');
  if (settings) adopt(fresh); else settings = fresh;
  return settings;
}

// --- Automatic saving ---------------------------------------------------------------------------
// Edits collect in `pending`; the demo preview shows them at once, the server gets them after a pause
const SAVE_DELAY_MS = 700;
const draftChannel = 'BroadcastChannel' in window ? new BroadcastChannel('autoglow-studio-draft') : null;
let pending = {};
let saveTimer = null;
const saveListeners = new Set();

export function onSaveState(fn) { saveListeners.add(fn); }
const emit = state => saveListeners.forEach(fn => fn(state));

export function change(values) {
  Object.assign(settings, values);
  Object.assign(pending, values);
  draftChannel?.postMessage({ type: 'draft', settings });
  emit('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
}

export async function flush() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const body = pending;
  pending = {};
  emit('saving');
  try {
    adopt(await api('/api/studio', { body }), true);
    emit(Object.keys(pending).length ? 'dirty' : 'saved');
  } catch (err) {
    pending = { ...body, ...pending };
    emit('error');
    toast.error(err.message);
  }
}

// The demo outputs go back to the saved settings
export function endDraft() { draftChannel?.postMessage({ type: 'clear' }); }

addEventListener('pagehide', () => {
  if (Object.keys(pending).length) navigator.sendBeacon?.('/api/studio', new Blob([JSON.stringify(pending)], { type: 'application/json' }));
  endDraft();
});

// The small save mark: a dot while editing, a spinner while sending, a tick when saved
export function saveMark() {
  const text = { dirty: 'Editing', saving: 'Saving', saved: 'Saved', error: 'Not saved' };
  const el = h('span', { class: 'stu-save', 'data-state': 'saved', 'aria-live': 'polite', title: 'Changes save by themselves' },
    h('span', { class: 'stu-save-icon', 'aria-hidden': 'true' }), h('span', {}, text.saved));
  onSaveState(state => {
    el.dataset.state = state;
    el.lastChild.textContent = text[state];
    el.classList.remove('is-pop');
    if (state === 'saved') { void el.offsetWidth; el.classList.add('is-pop'); }
  });
  return el;
}

// --- Preview and scenes ---------------------------------------------------------------------------
// play(): only the demo outputs in this browser (the preview). cue(): every open output, the TVs included.
export function play(scene) { draftChannel?.postMessage({ type: 'play', scene }); }
export function focusText(key, label = '') { draftChannel?.postMessage({ type: 'focus-text', key, label }); }

export async function cue(scene) {
  try {
    await api('/api/studio/cue', { body: { scene } });
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

// --- Readiness: what the game data needs, as dots -------------------------------------------------
export async function readStatus() {
  const [st, ad] = await Promise.all([api('/api/studio/state'), api('/api/studio/autodarts').catch(() => null)]);
  const src = st.source || { connected: !!st.source_connected };
  const names = (st.players || []).map(p => p.name).join(' vs ');
  const lobby = st.lobby?.players?.map(p => p.name).join(' vs ') || '';
  return {
    state: st,
    checks: [
      { id: 'bridge', label: 'Bridge', ok: !!src.connected, detail: src.connected ? `Bridge extension connected${src.extension_version ? ` (v${src.extension_version})` : ''}` : 'The Bridge extension is not connected: open Chrome with it installed' },
      { id: 'tab', label: 'Autodarts tab', ok: !!src.tab_attached, wait: !src.connected, detail: src.tab_attached ? 'Autodarts tab open' : 'Open play.autodarts.com in that Chrome' },
      { id: 'board', label: 'Board', ok: !!ad?.running, detail: !ad?.reachable ? 'Autodarts Board Manager not found' : ad.running ? 'Autodarts detects darts' : 'Autodarts is stopped', action: ad?.reachable && !ad.running ? 'start' : null },
      { id: 'match', label: 'Match', ok: !!st.live, wait: !st.live, detail: st.live ? names || 'Running' : lobby ? `Lobby: ${lobby}` : names ? `Over: ${names}` : 'No match yet' }
    ]
  };
}

// The Autodarts Board Manager streams its cameras only while detection runs; this is its Start button
export const AUTODARTS_STOPPED = 'Autodarts is stopped';

export async function startAutodarts() {
  try {
    await api('/api/studio/autodarts/start', { method: 'POST', timeout: 20000 });
    toast.success('Autodarts started. The cameras come back in a moment.');
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

// --- Icons (inline, stroke style like the app menu) ------------------------------------------------
const PATHS = {
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1"/><path d="M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6"/>',
  swords: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2M9.5 6.5 14 2h3v3l-4.5 4.5M5 14l4 4M7 17l-3 3M3 19l2 2"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 1-1h13l-3 5 3 5H5"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>',
  flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 3-5 5-5 8a7 7 0 0 0 7 7z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/><path d="M12 21a2 2 0 0 1 0-4h1a3 3 0 0 0 3-3"/>',
  video: '<rect x="2" y="5" width="15" height="14" rx="2"/><polygon points="22 7 17 11 17 13 22 17 22 7"/>',
  tv: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.8M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0 1 16 0v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-11"/>',
  camera: '<path d="M4 7h3l2-3h6l2 3h3a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="4"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  mirror: '<path d="M12 3v18M8 7 3 12l5 5zM16 7l5 5-5 5z"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M3 21v-5h5"/>'
};

const svgParser = new DOMParser();

export function icon(name, size = 20) {
  const svg = svgParser.parseFromString(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`, 'image/svg+xml').documentElement;
  return h('span', { class: 'stu-icon', 'aria-hidden': 'true' }, document.importNode(svg, true));
}

// --- Looks, as swatches: a tiny scoreboard drawn in each look's colours (web/studio/live.css) --------
export const THEMES = [
  { id: 'autodarts', name: 'Autodarts', bg: '#1b2330', row: '#2a3546', text: '#e8eef6', accent: true },
  { id: 'tv', name: 'TV', bg: '#ffffff', row: '#111111', text: '#111111' },
  { id: 'arena', name: 'Arena', bg: '#0b0b0b', row: '#1a1608', text: '#e7c46a' },
  { id: 'neon', name: 'Neon', bg: '#0a0614', row: 'transparent', text: '#c7a6ff', outline: '#a26bff' },
  { id: 'velocity', name: 'Velocity', bg: '#121212', row: '#e2342d', text: '#ffffff', slant: true },
  { id: 'glass', name: 'Glass', bg: 'rgba(160,190,220,.35)', row: 'rgba(255,255,255,.35)', text: '#0d1b2a' },
  { id: 'pub', name: 'Pub', bg: '#2a3a2e', row: '#3a2a1a', text: '#f3ecd7', frame: '#6b4a2b' },
  { id: 'daylight', name: 'Daylight', bg: '#f4f5f7', row: '#ffffff', text: '#1d2430' }
];

export function themeSwatch(t, accent) {
  const row = () => h('span', { class: 'stu-sw-row', style: `background:${t.row};color:${t.text};${t.outline ? `border:1px solid ${t.outline};` : ''}` },
    h('i', { style: `background:${t.accent ? accent : t.text}` }), h('b'));
  return h('span', { class: `stu-sw${t.slant ? ' is-slant' : ''}`, style: `background:${t.bg};${t.frame ? `border:3px solid ${t.frame};` : ''}` }, row(), row());
}

// --- Players --------------------------------------------------------------------------------------
// Field names as the server stores them (core/studio.py PROFILE_FIELDS): [key, label, placeholder, maxlength]
export const PROFILE = [
  ['alias', 'Autodarts name', 'If different', 40], ['nickname', 'Nickname', 'The Power', 40], ['country', 'Country', 'NED', 3],
  ['club', 'Club', '', 60], ['hometown', 'Hometown', '', 60], ['hand', 'Throws', '', 0],
  ['dart_weight', 'Dart weight (g)', '23', 10], ['favourite_double', 'Favourite double', 'D16', 10], ['playing_since', 'Playing since', '2015', 10],
  ['stat_average', 'Average', '85.4', 10], ['stat_180s', '180s', '42', 10], ['stat_best_checkout', 'Best checkout', '161', 10]
];

export async function savePlayer(id, fields, files = {}) {
  await flush();
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v ?? '').trim());
  for (const [k, f] of Object.entries(files)) if (f) form.append(k, f, f.name);
  await api(id ? `/api/studio/players/${id}` : '/api/studio/players', { body: form, timeout: 30000 });
  await loadSettings();
}

export async function deletePlayer(id) {
  await flush();
  await api(`/api/studio/players/${id}`, { method: 'DELETE' });
  await loadSettings();
}

export function avatar(p, cls = '') {
  const initials = (p.name || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  return p.image
    ? h('span', { class: `stu-avatar ${cls}` }, h('img', { src: imageUrl(p.image), alt: '' }))
    : h('span', { class: `stu-avatar ${cls}`, style: `--hue:${[...p.name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360}` }, initials);
}
