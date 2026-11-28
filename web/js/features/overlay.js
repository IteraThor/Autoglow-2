// AutoGlow 2 - Overlay page: how Autodarts' match page looks on every board while it plays a Local
// Tournament match (drawn by the Bridge, chrome_extension/match.js). The look (the one look Studio,
// Dashboard and Overlay share, kept in the Studio settings), the whole page restyled or only panels on top, the
// style, and for each screen shape (landscape, portrait) its own parts and where its boxes stand.
// Pictures instead of notes: the preview is the Bridge's own code on a stand-in match page
// (web/studio/overlay.html) at a board screen's real size. In it a click selects a part, a drag moves
// a box, the handles size and widen it; the Layout tab edits the selected box. Changes save by
// themselves (/api/overlay) and the boards of a tournament this PC hosts follow at once. Score & board:
// Autodarts' own parts drawn anew (overlay.face): the score, the cards, the darts, the dartboard.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import * as studio from './studio-core.js';
import { icon } from './studio-core.js';
import { lookPicker, section, segmented } from './studio-parts.js';

const $ = id => document.getElementById(id);
const SAVE_DELAY_MS = 500;
const STATUS_MS = 3000;
// Each look's page and bar colours for the little pictures (chrome_extension/match.js LOOKS)
const SWATCH = {
  autodarts: { bg: '#01040b', row: '#1b1f29' }, arena: { bg: '#060a14', row: '#1a2440' }, mono: { bg: '#000000', row: '#3a3a3a' },
  gazette: { bg: '#f4efe4', row: '#1a1814' }, blueprint: { bg: '#12449a', row: '#eaf2ff' }, pop: { bg: '#ffd60a', row: '#141414' },
  worldcup: { bg: '#1a0b3d', row: '#ff4fa3' }
};
// key, name, icon, what it is
const PARTS = [
  ['intro', 'Walk-on', 'play', 'Both players, full screen, when the match starts'],
  ['header', 'Stage', 'flag', 'Event, round and match'],
  ['race', 'Legs', 'bars', 'The race to the winning leg'],
  ['seeds', 'Seeds', 'frame', 'Seed and a frame on each player card'],
  ['run', 'Run', 'list', 'Each player\'s results so far'],
  ['stake', 'At stake', 'target', 'What the winner goes on to, or the group table'],
  ['next', 'Up next', 'next', 'Other boards and the next matches'],
  ['winner', 'Winner', 'trophy', 'Banner for the winner, with Start next match'],
  ['ticker', 'Ticker', 'ticker', 'Results, other boards and what\'s next along an edge'],
  ['logo', 'Logo', 'image', 'The event logo from Dashboard › Event'],
  ['clock', 'Clock', 'clock', 'The time, or how long the match runs'],
  ['note', 'Note', 'edit', 'A line of your own'],
  ['glow', 'Board glow', 'zap', 'A ring of light around the dartboard']
];
const PART_NAME = Object.fromEntries(PARTS.map(p => [p[0], p[1]]));
// The boxes that move: key, name, the part that switches it
const BOXES = [['header', 'Stage', 'header'], ['race', 'Legs', 'race'], ['runL', 'Run left', 'run'], ['runR', 'Run right', 'run'], ['stake', 'At stake', 'stake'],
  ['next', 'Up next', 'next'], ['winner', 'Winner', 'winner'], ['clock', 'Clock', 'clock'], ['note', 'Note', 'note']];
const BOX = Object.fromEntries(BOXES.map(b => [b[0], b]));
const SCENES = [{ value: 'intro', icon: 'play', title: 'Walk-on: the match starts' }, { value: 'play', icon: 'target', title: 'Playing' }, { value: 'won', icon: 'trophy', title: 'Won' }];
const ORIENTS = [{ value: 'landscape', icon: 'landscape', title: 'Landscape screen' }, { value: 'portrait', icon: 'portrait', title: 'Portrait screen' }];
const FORMATS = [{ value: 'ko', label: 'KO', title: 'A knockout match' }, { value: 'groups', label: 'Groups', title: 'A group match' }];
// Board screens the preview can be: the screen this page runs on first, then common ones
const COMMON_SIZES = {
  landscape: [[1920, 1080], [2560, 1440]],
  portrait: [[1080, 1920], [1440, 2560]]
};
const sizesFor = orient => {
  const long = Math.max(window.screen.width, window.screen.height) || 1920;
  const short = Math.min(window.screen.width, window.screen.height) || 1080;
  const own = orient === 'portrait' ? [short, long] : [long, short];
  return [own, ...COMMON_SIZES[orient].filter(([w, hh]) => w !== own[0] || hh !== own[1])];
};
const ORIENT_NAME = { landscape: 'Landscape', portrait: 'Portrait' };
// Ready-made sets of parts (where the boxes stand is left to the layout, or to you)
const DEFAULT_PARTS = { intro: true, seeds: true, header: true, race: true, run: true, stake: true, next: true, winner: true, ticker: false, logo: true, clock: false, note: false, glow: false };
const PRESETS = [
  { id: 'auto', name: 'Standard', ico: 'layout', title: 'The usual parts, each where it fits', parts: DEFAULT_PARTS },
  { id: 'clean', name: 'Clean', ico: 'minus', title: 'Only the stage, the legs and the seeds', parts: { ...DEFAULT_PARTS, run: false, stake: false, next: false, logo: false } },
  { id: 'show', name: 'Full show', ico: 'flame', title: 'Everything: ticker, clock and the board glowing', parts: { ...DEFAULT_PARTS, ticker: true, clock: true, glow: true } },
  { id: 'calm', name: 'Board only', ico: 'target', title: 'Nothing around the board but the walk-on and the winner', parts: Object.fromEntries(Object.keys(DEFAULT_PARTS).map(k => [k, k === 'intro' || k === 'winner'])) }
];
const viewKey = 'autoglow-overlay-view';

let S = null;               // the settings as the server has them, plus edits on their way
let pending = {};
let saveTimer = null;
let page = null;
let statusTimer = null;
let tab = 'look';
let picked = null;          // the part selected in the preview: { key, part, box, moved }
let view = { orient: 'landscape', scene: 'play', format: 'ko', size: {}, grid: false };
try { Object.assign(view, JSON.parse(localStorage.getItem(viewKey)) || {}); } catch (err) { /* defaults */ }

// --- Saving -------------------------------------------------------------------------------------
const saveListeners = new Set();
const emit = state => saveListeners.forEach(fn => fn(state));

function change(values, { quiet = false } = {}) {
  // style and a screen: the whole object goes, the server keeps the rest
  for (const k of ['style', 'face', 'landscape', 'portrait']) if (values[k]) values = { ...values, [k]: { ...S[k], ...values[k] } };
  Object.assign(S, values);
  Object.assign(pending, values);
  emit('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  if (!quiet) page?.refresh();
  sendPreview();
}
/** The screen shown in the preview: its parts and boxes */
const scr = () => S[view.orient] || { parts: {}, boxes: {} };
const partOn = k => scr().parts?.[k] !== false;
const changeScreen = (patch, opts) => change({ [view.orient]: patch }, opts);
function setBox(key, box, opts) {
  const boxes = { ...scr().boxes };
  if (box) boxes[key] = { x: box.x, y: box.y, w: box.w, s: box.s }; else delete boxes[key];
  changeScreen({ boxes }, opts);
}

async function flush() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const body = pending;
  pending = {};
  emit('saving');
  try {
    const fresh = await api('/api/overlay', { body });
    Object.assign(S, fresh, pending);
    emit(Object.keys(pending).length ? 'dirty' : 'saved');
  } catch (err) {
    pending = { ...body, ...pending };
    emit('error');
    toast.error(err.message);
  }
}

addEventListener('pagehide', () => {
  if (Object.keys(pending).length) navigator.sendBeacon?.('/api/overlay', new Blob([JSON.stringify(pending)], { type: 'application/json' }));
});

function saveMark() {
  const text = { dirty: 'Editing', saving: 'Saving', saved: 'Saved', error: 'Not saved' };
  const el = h('span', { class: 'stu-save', 'data-state': 'saved', 'aria-live': 'polite', title: 'Changes save by themselves' },
    h('span', { class: 'stu-save-icon', 'aria-hidden': 'true' }), h('span', {}, text.saved));
  saveListeners.add(state => {
    el.dataset.state = state;
    el.lastChild.textContent = text[state];
    el.classList.remove('is-pop');
    if (state === 'saved') { void el.offsetWidth; el.classList.add('is-pop'); }
  });
  return el;
}

// --- The preview ---------------------------------------------------------------------------------
/** The settings as a board gets them: the shared look (Studio settings), the event's name and logo */
function resolved() {
  const ev = S.event || {};
  return {
    ...S,
    look: S.studio_look?.look || 'autodarts',
    accent: S.studio_look?.accent || '',
    title: ev.title || '', subtitle: ev.subtitle || '', logo: ev.logo || '',
    logo_url: ev.logo ? `/api/dashboard/logo/${encodeURIComponent(ev.logo)}` : ''
  };
}
let previewReady = false;
function sendPreview(replay = false, select, moment) {
  const win = page?.frame.contentWindow;
  if (!win || !previewReady) return;
  const msg = { type: 'ag-preview', overlay: resolved(), scene: view.scene, format: view.format, replay, grid: !!view.grid };
  if (select !== undefined) msg.select = select;
  if (moment) msg.moment = moment;
  win.postMessage(msg, location.origin);
}
// The picked size is kept as "1920x1080"; anything else (or none) means this screen
const sizeIndex = () => Math.max(0, sizesFor(view.orient).findIndex(([w, hh]) => `${w}x${hh}` === view.size?.[view.orient]));
const screenSize = () => sizesFor(view.orient)[sizeIndex()];
function setView(patch) {
  view = { ...view, ...patch };
  try { localStorage.setItem(viewKey, JSON.stringify(view)); } catch (err) { /* not remembered */ }
  if (patch.orient || patch.size) { picked = null; page?.fit(); page?.refresh(); }
  sendPreview(patch.scene === 'intro', patch.orient || patch.size ? null : undefined);
}
/** Select a box (or part) in the preview from the page */
function pick(key, part) {
  picked = key || part ? { key, part: part || BOX[key]?.[2] || key, box: null, moved: !!(key && scr().boxes?.[key]) } : null;
  tab = 'layout';
  page?.refresh();
  sendPreview(false, picked ? { key: picked.key, part: picked.part } : null);
}
addEventListener('message', ({ data, origin }) => {
  if (origin !== location.origin || !data || !page) return;
  if (data.type === 'ag-ready') { previewReady = true; sendPreview(); }
  // The preview between two screen shapes: its messages are for the other one
  if (data.orient && data.orient !== view.orient) return;
  if (data.type === 'ag-select') {
    picked = data.part ? { key: data.key, part: data.part, box: data.box, moved: data.moved } : null;
    if (picked) tab = 'layout';
    page.refresh();
  }
  if (data.type === 'ag-move' && data.key) {
    picked = { key: data.key, part: BOX[data.key]?.[2] || data.key, box: data.box, moved: true };
    setBox(data.key, data.box);
  }
  if (data.type === 'ag-hide' && data.part) {
    changeScreen({ parts: { ...scr().parts, [data.part]: false } });
    toast.info(`${PART_NAME[data.part] || data.part} off on ${ORIENT_NAME[view.orient].toLowerCase()} screens.`);
  }
});

// --- Status: where the overlay is in use ------------------------------------------------------------
function statusChips() {
  const root = h('div', { class: 'stu-dots dsh-dots', 'aria-live': 'polite' });
  root.refresh = async () => {
    let chips;
    try {
      const body = await api('/api/tournament/local');
      const t = body.tournament;
      if (!t) chips = [['No tournament on this PC', false, 'The boards get these settings with the next tournament this PC hosts']];
      else if (body.role === 'board') chips = [['Board PC', false, 'This PC is a board: the host\'s Overlay settings apply here']];
      else {
        const boards = (t.boards || []).filter(b => b.approved && !b.left).length;
        chips = [[t.status === 'lobby' ? 'Lobby open' : t.status === 'finished' ? 'Finished' : 'Running', true], [`${boards} board${boards === 1 ? '' : 's'} follow`, boards > 0, 'Every board of this tournament shows these settings']];
      }
    } catch (err) {
      chips = [['AutoGlow not reachable', false]];
    }
    const key = JSON.stringify(chips);
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    root.replaceChildren(...chips.map(([label, ok, note]) => h('span', { class: 'stu-dot', 'data-state': ok ? 'ok' : 'wait', title: note || '' }, h('i'), label)));
  };
  return root;
}

// --- Small controls ---------------------------------------------------------------------------------
/** A row of picture tiles for one choice: [value, name, icon name or picture, note] */
function choice(key, options, get, set) {
  return h('div', { class: 'stu-tiles ovl-choice' }, ...options.map(([v, name, p, note]) => {
    const on = get() === v;
    const b = h('button', { type: 'button', class: `stu-tile${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: note || name, 'data-fk': `${key}-${v}` },
      typeof p === 'string' ? icon(p, 22) : p, h('span', {}, name));
    b.addEventListener('click', () => set(v));
    return b;
  }));
}
/** A slider with its value; onInput while dragging, onChange when let go */
function slider(label, ico, min, max, step, value, fmt, onInput, onChange) {
  const r = h('input', { type: 'range', min, max, step, value, class: 'dsh-range', 'aria-label': label });
  const val = h('span', { class: 'dsh-val' }, fmt(value));
  r.addEventListener('input', () => { val.textContent = fmt(Number(r.value)); onInput?.(Number(r.value)); });
  r.addEventListener('change', () => onChange(Number(r.value)));
  return h('label', { class: 'dsh-safe ovl-slider', title: label }, icon(ico, 18), h('span', { class: 'ovl-sl-name' }, label), r, val);
}
/** A little picture for a style choice (web/css/overlay.css draws it) */
const pic = cls => h('span', { class: `ovl-pic ${cls}`, 'aria-hidden': 'true' }, h('i'));

// --- Tabs -------------------------------------------------------------------------------------------
// The two ways: the whole page in the look, or only panels on Autodarts' own page (little pictures)
function skinCard(id, name, note) {
  const on = S.skin === id;
  const p = h('span', { class: `ovl-skin-pic is-${id}`, 'aria-hidden': 'true' }, h('i', { class: 'c' }), h('i', { class: 'b' }), h('i', { class: 'c' }), h('i', { class: 'p' }), h('i', { class: 'p' }));
  const b = h('button', { type: 'button', class: `dsh-preset ovl-skin${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: note, 'data-fk': `skin-${id}` }, p, h('b', {}, name));
  b.addEventListener('click', () => change({ skin: id }));
  return b;
}

function lookTab() {
  const st = S.style || {};
  const font = (v, name, family) => [v, name, h('b', { class: 'ovl-aa', style: family ? `font-family:${family}` : '' }, 'Aa')];
  return [
    section('Screen', h('div', { class: 'dsh-presets ovl-skins' },
      skinCard('page', 'Whole page', 'Autodarts\' page turns into the tournament\'s: background, player cards, bars and buttons in the look'),
      skinCard('panels', 'Panels only', 'Autodarts\' page stays as it is; the tournament panels go around it'))),
    // The look Studio and Dashboard share: picked here, it changes there too
    lookPicker({ onPick: () => { S.studio_look = { look: studio.settings.theme, accent: studio.settings.accent }; sendPreview(); } }),
    section('Big letters', choice('font', [font('look', 'Look'), font('bebas', 'Bebas', '"Bebas Neue"'), font('oswald', 'Oswald', 'Oswald'), font('anton', 'Anton', 'Anton'),
      font('unbounded', 'Unbounded', 'Unbounded'), font('serif', 'Serif', '"DM Serif Display",serif'), font('black', 'Black', '"Archivo Black"')], () => st.font || 'look', v => change({ style: { font: v } })))
  ];
}

function styleTab() {
  const st = S.style || {};
  const whole = S.skin === 'page';
  const setStyle = k => v => change({ style: { [k]: v } });
  return [
    section('Panels', slider('See-through', 'blur', 30, 100, 2, st.opacity ?? 92, v => `${100 - v} %`, null, setStyle('opacity')),
      choice('corners', [['look', 'Look', pic('c-look')], ['square', 'Square', pic('c-square')], ['soft', 'Soft', pic('c-soft')], ['round', 'Round', pic('c-round')]],
        () => st.corners || 'look', setStyle('corners'))),
    section('Motion', choice('motion', [['fade', 'Fade', 'waves'], ['slide', 'Slide', 'next'], ['pop', 'Pop', 'zap'], ['none', 'Still', 'minus']], () => st.motion || 'fade', setStyle('motion'))),
    h('div', { class: `dsh-group${whole ? '' : ' is-off'}`, title: whole ? '' : 'For Look › Screen › Whole page' },
      section('Page background', choice('bg', [['look', 'Look', pic('b-look')], ['plain', 'Plain', pic('b-plain')], ['spot', 'Spotlight', pic('b-spot')], ['grid', 'Grid', pic('b-grid')],
        ['dots', 'Dots', pic('b-dots')], ['lines', 'Lines', pic('b-lines')]], () => st.bg || 'look', setStyle('bg'))),
      section('Player throwing', choice('card', [['fill', 'Filled', pic('k-fill')], ['outline', 'Outline', pic('k-outline')], ['glow', 'Glow', pic('k-glow')]], () => st.card || 'fill', setStyle('card'))))
  ];
}

/** The screen shape being edited: the same switch as under the preview */
function screenSwitch() {
  const seg = segmented(ORIENTS.map(o => ({ ...o, label: ORIENT_NAME[o.value] })), view.orient, v => page.orients.set(v), 'Screen');
  return h('div', { class: 'ovl-screenbar' }, seg);
}

function partsTab() {
  const tiles = PARTS.map(([key, name, ico, note]) => {
    const on = partOn(key);
    const b = h('button', { type: 'button', class: `stu-tile${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: note, 'data-fk': `part-${key}` }, icon(ico, 22), h('span', {}, name));
    b.addEventListener('click', () => {
      changeScreen({ parts: { ...scr().parts, [key]: !on } });
      // A part of another moment: the preview goes there
      const scene = key === 'intro' ? 'intro' : key === 'winner' ? 'won' : null;
      if (scene && scene !== view.scene) page.scenes.set(scene);
    });
    return b;
  });
  const other = view.orient === 'landscape' ? 'portrait' : 'landscape';
  const copy = h('button', { type: 'button', class: 'stu-btn ovl-copy', title: `The parts switched on as on ${ORIENT_NAME[other].toLowerCase()} screens` }, icon('copy', 14), `Same as ${ORIENT_NAME[other].toLowerCase()}`);
  copy.addEventListener('click', () => changeScreen({ parts: { ...S[other].parts } }));
  const presets = PRESETS.map(p => {
    const on = Object.keys(DEFAULT_PARTS).every(k => (scr().parts?.[k] !== false) === p.parts[k]);
    const b = h('button', { type: 'button', class: `stu-tile${on ? ' is-on' : ''}`, title: p.title, 'data-fk': `preset-${p.id}` }, icon(p.ico, 22), h('span', {}, p.name));
    b.addEventListener('click', () => changeScreen({ parts: { ...p.parts } }));
    return b;
  });
  const secs = segmented([2, 4, 6, 8].map(n => ({ value: String(n), label: `${n} s` })), String(S.intro_secs || 4), v => { change({ intro_secs: Number(v) }); if (view.scene === 'intro') sendPreview(true); else page.scenes.set('intro'); }, 'Walk-on length');
  const tkPos = segmented([{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }], S.style?.ticker_pos || 'bottom', v => change({ style: { ticker_pos: v } }), 'Ticker edge');
  const tkSpeed = segmented([{ value: 'slow', label: 'Slow' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }], S.ticker_speed || 'normal', v => change({ ticker_speed: v }), 'Ticker speed');
  const clock = segmented([{ value: 'time', label: 'Time' }, { value: 'match', label: 'Match time' }, { value: 'both', label: 'Both' }], S.clock || 'time', v => change({ clock: v }), 'Clock');
  const note = h('input', { type: 'text', class: 'stu-input ovl-note', maxlength: 140, value: S.note || '', placeholder: 'Bar open until 2 · Final at 22:00', 'aria-label': 'Note', 'data-fk': 'note-text' });
  note.addEventListener('input', () => change({ note: note.value }, { quiet: true }));
  // Writing a note switches it on
  note.addEventListener('focus', () => { if (!partOn('note')) changeScreen({ parts: { ...scr().parts, note: true } }); });
  const opt = (key, ...content) => h('div', { class: `ovl-opt${partOn(key) ? '' : ' is-off'}` }, section(PART_NAME[key], ...content));
  return [
    screenSwitch(),
    section('Ready-made', h('div', { class: 'stu-tiles ovl-tiles' }, ...presets)),
    section('Shown', h('div', { class: 'stu-tiles ovl-tiles' }, ...tiles), copy),
    opt('intro', secs),
    opt('ticker', h('div', { class: 'ovl-row' }, tkPos, tkSpeed)),
    opt('clock', clock),
    opt('note', note),
    h('a', { class: 'stu-btn ovl-event', href: '/dashboard', 'data-link': '', title: 'The event name and logo come from the Dashboard' }, icon('image', 14), S.event?.title || S.event?.logo ? `Event: ${S.event.title || 'logo'}` : 'Event name and logo: Dashboard › Event')
  ];
}

function layoutTab() {
  const boxes = scr().boxes || {};
  const sel = picked;
  const chips = h('div', { class: 'ovl-boxes' }, ...BOXES.map(([key, name, part]) => {
    const on = sel?.key === key;
    const b = h('button', { type: 'button', class: `stu-btn stu-chip ovl-box${on ? ' is-on' : ''}${partOn(part) ? '' : ' is-hidden'}`, 'aria-pressed': String(on), 'data-fk': `box-${key}` },
      boxes[key] ? h('i', { class: 'ovl-moved', title: 'Moved' }) : null, name);
    b.addEventListener('click', () => pick(on ? null : key));
    return b;
  }));
  const moved = Object.keys(boxes).length;
  const reset = h('button', { type: 'button', class: 'stu-btn', disabled: !moved, title: 'Every box back where the layout puts it' }, icon('reset', 14), 'All back to auto');
  reset.addEventListener('click', () => { changeScreen({ boxes: {} }); if (picked) picked.moved = false; toast.info(`${ORIENT_NAME[view.orient]}: every box back to auto.`); });
  const grid = h('button', { type: 'button', class: `stu-btn stu-chip${view.grid ? ' is-on' : ''}`, 'aria-pressed': String(!!view.grid), title: 'Lines every 5 % in the preview' }, icon('table', 14), 'Grid');
  grid.addEventListener('click', () => { setView({ grid: !view.grid }); page.refresh(); });

  const out = [screenSwitch(), section('Boxes', chips, h('div', { class: 'ovl-row' }, reset, grid))];
  if (!sel) {
    out.push(h('div', { class: 'ovl-hint' }, icon('frame', 28), h('span', {}, 'Drag a box in the preview. Corner: size. Side: width.')));
    return out;
  }
  const name = BOX[sel.key]?.[1] || PART_NAME[sel.part] || sel.part;
  const on = partOn(sel.part);
  const eye = h('button', { type: 'button', class: `stu-btn stu-chip${on ? ' is-on' : ''}`, 'aria-pressed': String(on) }, icon('eye', 14), on ? 'Shown' : 'Hidden');
  eye.addEventListener('click', () => changeScreen({ parts: { ...scr().parts, [sel.part]: !on } }));
  const head = h('div', { class: 'ovl-insp-head' }, h('b', {}, name), eye);
  const cur = sel.key ? boxes[sel.key] || sel.box : null;
  if (!cur) {
    out.push(h('div', { class: 'ovl-insp' }, head, sel.key ? null : h('div', { class: 'ovl-hint is-small' }, 'Stays where it belongs')));
    return out;
  }
  const base = () => ({ ...(scr().boxes?.[sel.key] || sel.box) });
  const put = (patch, opts) => { const b = { ...base(), ...patch }; picked = { ...sel, box: { ...sel.box, ...b }, moved: true }; setBox(sel.key, b, opts); };
  const size = slider('Size', 'frame', 40, 300, 5, Math.round((cur.s || 1) * 100), v => `${v} %`, v => put({ s: v / 100 }, { quiet: true }), v => put({ s: v / 100 }));
  const width = slider('Width', 'mirror', 6, 100, 1, Math.round(cur.w), v => `${v} %`, v => put({ w: v }, { quiet: true }), v => put({ w: v }));
  const align = (ico, title, fn) => { const b = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title, 'aria-label': title }, icon(ico, 16)); b.addEventListener('click', () => put(fn(base()))); return b; };
  const W = b => b.w * (b.s || 1);
  // The box's height as the preview measured it, at the size it has now
  const H = b => (sel.box?.h || 10) * ((b.s || 1) / (sel.box?.s || 1));
  const auto = h('button', { type: 'button', class: 'stu-btn', disabled: !boxes[sel.key], title: 'Back where the layout puts it' }, icon('reset', 14), 'Auto');
  auto.addEventListener('click', () => { picked = { ...sel, moved: false }; setBox(sel.key, null); });
  out.push(h('div', { class: 'ovl-insp' }, head,
    size, width,
    h('div', { class: 'ovl-align' },
      align('left', 'Left edge', () => ({ x: 1 })), align('mirror', 'Centre', b => ({ x: Math.max(0, (100 - W(b)) / 2) })), align('right', 'Right edge', b => ({ x: Math.max(0, 99 - W(b)) })),
      h('span', { class: 'ovl-sep' }),
      align('chevron', 'Top', () => ({ y: 1 })), align('minus', 'Middle', b => ({ y: Math.max(0, (100 - H(b)) / 2) })), align('download', 'Bottom', b => ({ y: Math.max(0, 99 - H(b)) })),
      h('span', { class: 'stu-spacer' }), auto),
    h('div', { class: 'ovl-hint is-small' }, `${boxes[sel.key] ? 'Moved' : 'Auto'} · arrows nudge, Shift further, Alt no snapping, Del hides`)));
  return out;
}


// Score & board: Autodarts' own parts, each choice a little picture of itself
const FACE_DEFAULT = { score: 'auto', card: 'classic', throws: 'classic', board: 'classic', frame: 'none', markers: 'look', checkout: true, target: true, moments: true, logos: true };
const FACE_AUTO = { autodarts: 'classic', arena: 'broadcast', mono: 'led', gazette: 'roll', blueprint: 'led', pop: 'roll', worldcup: 'neon' };
const SEG7 = { 1: 'bc', 4: 'fgbc', 0: 'abcdef' };
const segDigit = n => h('i', { class: 'ovl-7' }, ...'abcdefg'.split('').map(k => h('b', { class: `g-${k}${SEG7[n].includes(k) ? ' on' : ''}` })));
function scorePic(style) {
  if (style === 'auto') return h('span', { class: 'ovl-sc s-auto' }, icon('refresh', 18));
  if (style === 'led') return h('span', { class: 'ovl-sc s-led' }, segDigit(1), segDigit(4), segDigit(0));
  if (style === 'flap' || style === 'roll') return h('span', { class: `ovl-sc s-${style}` }, ...'140'.split('').map(c => h('i', {}, c)));
  return h('span', { class: `ovl-sc s-${style}` }, '140');
}
const cardPic = k => h('span', { class: `ovl-cd c-${k}`, 'aria-hidden': 'true' }, h('i', { class: 'n' }), h('i', { class: 's' }), h('i', { class: 'm' }));
const throwPic = k => h('span', { class: `ovl-th t-${k}`, 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('b'));
const BOARD_PIC = {
  classic: ['#E72946', '#009856', '#01040B', '#EAD3C4', '#060C1A'],
  mono: ['#f2f2f2', '#8c8c8c', '#0b0b0b', '#3a3a3a', '#000'],
  neon: ['#ff2bd6', '#19f0ff', '#05060c', '#141b30', '#030409'],
  wire: ['#ffd23f', '#eaf2ff', '#0a2a5e', '#0e3878', '#08224d'],
  gold: ['#f43c30', '#20ad4b', '#2a2a2a', '#4b4f52', '#2e2e2e']
};
function boardPic(k) {
  const src = SWATCH[resolved().look] || SWATCH.autodarts;
  const [r, g, d, l, sur] = k === 'look' ? [resolved().accent || '#3b82f6', '#d9d9d9', src.row, '#cfcfcf', src.bg] : BOARD_PIC[k];
  return h('span', { class: `ovl-bd b-${k}`, 'aria-hidden': 'true', style: `--r:${r};--g:${g};--d:${d};--l:${l};--sur:${sur}` });
}
const framePic = k => h('span', { class: `ovl-bd ovl-fr f-${k}`, 'aria-hidden': 'true', style: '--r:#E72946;--g:#009856;--d:#01040B;--l:#EAD3C4;--sur:#060C1A' });
const markPic = k => h('span', { class: `ovl-mk m-${k}`, 'aria-hidden': 'true' }, h('i', {}, k === 'look' ? '1' : ''), h('i', {}, k === 'look' ? '2' : ''));

function faceTab() {
  const f = { ...FACE_DEFAULT, ...(S.face || {}) };
  // A change here: the preview shows the match being played
  const set = (k) => (v) => { change({ face: { [k]: v } }); if (view.scene !== 'play') page.scenes.set('play'); };
  const look = resolved().look;
  const autoName = { classic: 'Autodarts', broadcast: 'TV', flap: 'Flap', roll: 'Roll', led: 'LED', neon: 'Neon' }[FACE_AUTO[look] || 'classic'];
  const toggles = [['checkout', 'Checkout', 'target', 'The way out at 170 or less, on the card of the player throwing'],
    ['target', 'Target', 'zap', 'The checkout\'s next dart lit on the board'],
    ['moments', 'Moments', 'flame', '180, 140+, 100+, bust and the leg\'s last dart, big over the board'],
    ['logos', 'Board logos', 'image', 'The logos printed on the dartboard']].map(([k, name, ico, note]) => {
    const on = f[k] !== false;
    const b = h('button', { type: 'button', class: `stu-tile${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: note, 'data-fk': `face-${k}` }, icon(ico, 22), h('span', {}, name));
    b.addEventListener('click', () => set(k)(!on));
    return b;
  });
  const showMoment = (k, label, ico) => {
    const b = h('button', { type: 'button', class: 'stu-btn', title: `Show it in the preview` }, icon(ico, 14), label);
    b.addEventListener('click', () => { if (view.scene !== 'play') page.scenes.set('play'); setTimeout(() => sendPreview(false, undefined, k), view.scene === 'play' ? 0 : 300); });
    return b;
  };
  return [
    section('Score', choice('fscore', [['auto', `Look · ${autoName}`, scorePic('auto'), 'The look\'s own score'], ['classic', 'Autodarts', scorePic('classic')], ['broadcast', 'TV', scorePic('broadcast')],
      ['flap', 'Flap', scorePic('flap')], ['roll', 'Roll', scorePic('roll')], ['led', 'LED', scorePic('led')], ['neon', 'Neon', scorePic('neon')]], () => f.score, set('score'))),
    section('Player cards', choice('fcard', [['classic', 'Autodarts', cardPic('classic')], ['strip', 'Strip', cardPic('strip')], ['lower', 'Lower third', cardPic('lower')], ['minimal', 'Minimal', cardPic('minimal')]],
      () => f.card, set('card'))),
    section('Darts', choice('fthrows', [['classic', 'Autodarts', throwPic('classic')], ['tiles', 'Tiles', throwPic('tiles')]], () => f.throws, set('throws'))),
    section('Dartboard', choice('fboard', [['classic', 'Autodarts', boardPic('classic')], ['look', 'Look', boardPic('look')], ['mono', 'Mono', boardPic('mono')], ['neon', 'Neon', boardPic('neon')], ['wire', 'Blueprint', boardPic('wire')], ['gold', 'Gold', boardPic('gold')]],
      () => f.board, set('board'))),
    section('Board frame', choice('fframe', [['none', 'No frame', framePic('none')], ['leds', 'Lights', framePic('leds')], ['rings', 'Rings', framePic('rings')]], () => f.frame, set('frame'))),
    section('Hit markers', choice('fmarkers', [['look', 'Darts 1-2-3', markPic('look')], ['classic', 'Autodarts darts', markPic('classic')]], () => f.markers, set('markers'))),
    section('Extras', h('div', { class: 'stu-tiles ovl-tiles' }, ...toggles),
      h('div', { class: 'ovl-row' }, showMoment('180', 'Show 180', 'flame'), showMoment('bust', 'Show bust', 'minus'), showMoment('leg', 'Show game shot', 'trophy')))
  ];
}

const TABS = [
  ['look', 'Look', lookTab, 'palette', 'The whole page or panels only, colours and fonts'],
  ['style', 'Style', styleTab, 'blur', 'Panels, corners, motion and the page'],
  ['face', 'Score & board', faceTab, 'gauge', 'Autodarts\' score, player cards, darts and dartboard in other looks'],
  ['parts', 'Parts', partsTab, 'layers', 'What shows, for each screen shape'],
  ['layout', 'Layout', layoutTab, 'layout', 'Where the boxes stand, for each screen shape']
];

// --- The page ------------------------------------------------------------------------------------
function build(host) {
  const panel = h('div', { class: 'stu-panel dsh-panel' });
  const frame = h('iframe', { src: '/overlay/preview', title: 'Board preview', class: 'ovl-frame' });
  const screen = h('div', { class: 'stu-screen ovl-screen' }, frame);
  const dots = statusChips();
  const tabs = h('div', { class: 'stu-group dsh-rail', role: 'tablist', 'aria-label': 'Overlay' }, h('span', { class: 'stu-pill' }),
    ...TABS.map(([id, label, , ico, note]) => {
      const b = h('button', { type: 'button', role: 'tab', class: 'stu-stage', 'data-id': id, title: note }, icon(ico, 22), h('span', {}, label));
      b.addEventListener('click', () => { tab = id; refresh(true); });
      return b;
    }));
  const placePill = () => {
    const btn = tabs.querySelector('.stu-stage.is-on');
    tabs.classList.toggle('has-pill', !!btn);
    if (!btn) return;
    const pill = tabs.querySelector('.stu-pill');
    pill.style.left = `${btn.offsetLeft}px`;
    pill.style.width = `${btn.offsetWidth}px`;
  };
  new ResizeObserver(placePill).observe(tabs);

  // The board screen at its real size, scaled into the preview box
  const fit = () => {
    const [w, hgt] = screenSize();
    screen.classList.toggle('is-portrait', view.orient === 'portrait');
    screen.style.aspectRatio = `${w} / ${hgt}`;
    const k = screen.clientWidth / w;
    frame.style.width = `${w}px`;
    frame.style.height = `${hgt}px`;
    frame.style.transform = `scale(${k})`;
  };
  new ResizeObserver(fit).observe(screen);

  const scenes = segmented(SCENES, view.scene, v => setView({ scene: v }), 'Moment');
  const sizes = h('div', { class: 'ovl-sizes' });
  sizes.update = () => {
    const seg = segmented(sizesFor(view.orient).map(([w, hh], i) => ({ value: String(i), label: `${w}×${hh}`, title: i ? 'A board screen of this size' : 'This screen' })), String(sizeIndex()),
      v => { const [w, hh] = sizesFor(view.orient)[Number(v)]; setView({ size: { ...view.size, [view.orient]: Number(v) ? `${w}x${hh}` : null } }); }, 'Screen size');
    sizes.replaceChildren(seg);
  };
  sizes.update();
  const orients = segmented(ORIENTS, view.orient, v => { setView({ orient: v }); sizes.update(); }, 'Screen');
  const formats = segmented(FORMATS, view.format, v => setView({ format: v }), 'Match');
  const replay = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Play the walk-on again', 'aria-label': 'Play the walk-on again' }, icon('refresh', 16));
  replay.addEventListener('click', () => { if (view.scene === 'intro') sendPreview(true); else scenes.set('intro'); });
  scenes.set = v => scenes.querySelector(`[data-value="${v}"]`)?.click();
  orients.set = v => orients.querySelector(`[data-value="${v}"]`)?.click();

  const refresh = (fresh = false) => {
    tabs.querySelectorAll('.stu-stage').forEach(b => { const on = b.dataset.id === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    placePill();
    const fk = panel.contains(document.activeElement) ? document.activeElement.dataset?.fk : null;
    panel.classList.toggle('is-quiet', !fresh);
    panel.replaceChildren(...TABS.find(t => t[0] === tab)[2]().filter(Boolean));
    if (fk) panel.querySelector(`[data-fk="${fk}"]`)?.focus();
  };

  host.replaceChildren(
    h('div', { class: 'stu-top' }, dots, h('span', { class: 'stu-spacer' }), saveMark()),
    tabs,
    h('div', { class: 'stu-body ovl-body' },
      h('div', { class: 'stu-left' },
        screen,
        h('div', { class: 'dsh-now ovl-view' }, orients, sizes, scenes, replay, formats)),
      panel));
  return { frame, dots, refresh, fit, scenes, orients };
}

async function renderOverlay() {
  const host = $('overlayPage');
  try {
    const [fresh] = await Promise.all([api('/api/overlay'), studio.loadSettings()]);
    if (S) Object.assign(S, fresh, pending); else S = fresh;
    if (!page) { previewReady = false; page = build(host); }
    page.refresh(true);
    page.fit();
    sendPreview();
    page.dots.refresh();
    clearInterval(statusTimer);
    statusTimer = setInterval(page.dots.refresh, STATUS_MS);
  } catch (err) {
    toast.error(`Could not load the Overlay: ${err.message}`);
  }
}

function leaveOverlay() {
  if (!page) return;
  clearInterval(statusTimer);
  flush();
}

export function initOverlay() {
  window.renderOverlay = renderOverlay;
  window.leaveOverlay = leaveOverlay;
}
