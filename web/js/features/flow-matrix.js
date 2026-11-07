// AutoGlow 2 - Flow Matrix page (/lighting/flow)
// A simple chart of how the light strips follow a match. Clicking any part opens one panel with
// everything needed to change it. A status line says what is off or missing. Edits are a draft until saved.

import { api } from '../core/api.js';
import { confirmDialog, promptDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { blendFlow, renderFlowFrame } from './flow-looks.js';
import { loadEffects, wledEffectPicker } from './idle-lighting.js';

const STRIP_LEDS = 48;
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const LIGHTING_PANE = 'tab-simulator';

const STEP_HELP = {
  bull_off: 'Plays while players throw for the bull to decide who starts.',
  game_start: 'A short intro when the match begins. The first turn waits for it.',
  turn: 'Shows whose turn it is in that player\'s colour. Every match comes back to this look.',
  takeout: 'Shows while darts are pulled from the board, until the next turn starts.',
  leg_won: 'Celebrates a won leg in the winner\'s colour. The next leg waits for it.',
  match_won: 'The finale. Afterwards the lights go back to waiting.'
};

const OFF_TEXT = {
  bull_off: 'the waiting lights stay on during the bull-off',
  game_start: 'the first turn comes in straight away',
  takeout: 'the lights change straight to the next player',
  leg_won: 'the next leg starts straight away',
  match_won: 'the lights go back to waiting when the match ends'
};

// The step that is usually showing before a step comes in (for transition previews)
const BEFORE = { bull_off: null, game_start: 'bull_off', turn: 'takeout', takeout: 'turn', leg_won: 'turn', match_won: 'turn' };

const OPTION_LABELS = {
  pulses: ['Pulses', { 1: '1', 2: '2', 3: '3' }],
  tail: ['Tail', { short: 'Short', long: 'Long' }],
  comets: ['Comets', { 1: 'One', 2: 'Two' }],
  sides: ['Fills from', { both: 'The top, both ways', one: 'The top, one way' }],
  palette: ['Colours', { vivid: 'Vivid', soft: 'Soft' }],
  amount: ['Amount', { few: 'Few', some: 'Some', many: 'Many' }]
};

const USES_BACKGROUND = new Set(['breathe', 'flash', 'chase', 'curtain', 'sparkle']);
const NO_COLOUR = new Set(['rainbow']);
const CAN_REVERSE = new Set(['chase', 'curtain', 'rainbow']);
const PLAYER_STEPS = new Set(['takeout', 'leg_won', 'match_won']);

const page = {
  root: null,
  overview: null,
  name: null,
  saved: null,
  draft: null,
  selected: { kind: 'step', id: 'turn' },
  live: null,
  liveHit: null,
  loading: false
};

// --- helpers -----------------------------------------------------------------

const clone = v => JSON.parse(JSON.stringify(v));
const isDirty = () => !!page.draft && JSON.stringify(page.draft) !== page.saved;
const hex = c => '#' + (c || [0, 0, 0]).map(v => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
const fromHex = s => [1, 3, 5].map(i => parseInt(String(s).slice(i, i + 2), 16) || 0);
const stepMeta = id => page.overview.steps.find(s => s.id === id);
const hitMeta = id => page.overview.hits.find(s => s.id === id);
const effectMeta = id => page.overview.catalog.effects.find(e => e.id === id);
const transitionLabel = id => page.overview.catalog.transitions.find(t => t.id === id)?.label || 'Fade';
const speedIndex = s => SPEEDS.reduce((best, v, i) => (Math.abs(v - s) < Math.abs(SPEEDS[best] - s) ? i : best), 3);
const seconds = s => `${Number(s).toFixed(s < 10 ? 1 : 0)} s`;

function playerColour(i = 0) {
  return page.draft.players[i % page.draft.players.length].color;
}

// The effect as it plays: player colour filled in (player 1 stands in for "the current player")
function resolved(effect, forcePlayer = false, player = 0) {
  const usePlayer = forcePlayer || effect.options?.colour_from === 'player';
  return usePlayer ? { ...effect, color_primary: playerColour(player) } : effect;
}

function stepLook(id) {
  const step = page.draft.steps[id];
  return resolved(step.effect, id === 'turn');
}

function lightsUsing(name) {
  return page.overview.profiles.find(p => p.name === name)?.used_by || [];
}

function allSegments() {
  return page.overview.lights.flatMap(dev => dev.segments.filter(s => !s.light_strip).map(s => ({ ...s, ip: dev.ip, controller: dev.name })));
}

// --- mini LED strips ---------------------------------------------------------

const strips = new Map();
let stripLoop = null;

function strip(getFrame, { leds = STRIP_LEDS, cls = 'fm-strip' } = {}) {
  const canvas = h('canvas', { class: cls, width: leds * 6, height: 10, 'aria-hidden': 'true' });
  strips.set(canvas, { getFrame, leds, born: performance.now() });
  if (!stripLoop) stripLoop = requestAnimationFrame(drawStrips);
  return canvas;
}

function drawStrips(now) {
  stripLoop = null;
  const pane = document.getElementById(LIGHTING_PANE);
  if (!pane?.classList.contains('active') || document.hidden) {
    setTimeout(() => { if (!stripLoop) stripLoop = requestAnimationFrame(drawStrips); }, 500);
    return;
  }
  for (const [canvas, s] of strips) {
    if (!canvas.isConnected) { strips.delete(canvas); continue; }
    const t = (now - s.born) / 1000;
    let frame;
    try { frame = s.getFrame(t, s.leds); } catch (err) { continue; }
    const ctx = canvas.getContext('2d');
    const w = canvas.width / s.leds;
    ctx.fillStyle = '#0b0c0f';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let i = 0; i < s.leds; i++) {
      ctx.fillStyle = `rgb(${frame[i * 3]},${frame[i * 3 + 1]},${frame[i * 3 + 2]})`;
      ctx.fillRect(i * w + 0.5, 1, w - 1, canvas.height - 2);
    }
  }
  if (strips.size) stripLoop = requestAnimationFrame(drawStrips);
}

// A timed look replays with a short pause, so the whole effect is visible
function loopTime(t, effect) {
  const d = Number(effect.duration) || 0;
  return d > 0 ? t % (d + 0.8) : t;
}

function lookFrame(effect) {
  return (t, n) => renderFlowFrame(effect, loopTime(t, effect), n);
}

function stepFrame(id) {
  return (t, n) => {
    const step = page.draft?.steps[id];
    if (!step) return new Uint8ClampedArray(n * 3);
    if (!step.effect.enabled) return new Uint8ClampedArray(n * 3);
    const eff = stepLook(id);
    return renderFlowFrame(eff, loopTime(t, eff), n);
  };
}

function transitionFrame(id) {
  return (t, n) => {
    const step = page.draft.steps[id];
    const tr = step.transition;
    const before = BEFORE[id] && page.draft.steps[BEFORE[id]].effect.enabled ? stepLook(BEFORE[id]) : null;
    const dur = tr.style === 'instant' ? 0 : tr.duration;
    const cycle = 0.7 + dur + 1.0;
    const u = t % cycle;
    const a = before ? renderFlowFrame(before, u, n) : new Uint8ClampedArray(n * 3);
    const b = renderFlowFrame(stepLook(id), Math.max(0, u - 0.7), n);
    if (u < 0.7) return a;
    if (dur <= 0 || u >= 0.7 + dur) return b;
    return blendFlow(a, b, (u - 0.7) / dur, tr.style, tr.accent_color || null);
  };
}

function styleFrame(style, id) {
  return (t, n) => {
    const step = page.draft.steps[id];
    const dur = style === 'instant' ? 0 : Math.max(0.3, step.transition.duration);
    const cycle = 0.5 + dur + 0.7;
    const u = t % cycle;
    const a = new Uint8ClampedArray(n * 3).fill(30);
    const b = renderFlowFrame(stepLook(id), 0, n);
    if (u < 0.5) return a;
    if (dur <= 0 || u >= 0.5 + dur) return b;
    return blendFlow(a, b, (u - 0.5) / dur, style, step.transition.accent_color || null);
  };
}

// --- loading & saving --------------------------------------------------------

async function loadOverview() {
  page.overview = await api.get('/api/flow/overview');
}

async function openProfile(name) {
  const data = await api.get(`/api/flow/profile?name=${encodeURIComponent(name)}`);
  page.name = data.flow.name;
  page.draft = data.flow;
  page.saved = JSON.stringify(data.flow);
}

async function refresh(name) {
  page.loading = true;
  try {
    await loadOverview();
    const want = name || page.name || page.overview.default;
    const exists = page.overview.profiles.some(p => p.name === want);
    await openProfile(exists ? want : page.overview.default);
    if (page.overview.live && page.overview.live.step !== 'waiting') page.live = page.overview.live;
  } catch (err) {
    toast.error(err, { onRetry: () => refresh(name) });
  } finally {
    page.loading = false;
  }
  render();
}

async function save() {
  if (!isDirty()) return true;
  try {
    const data = await api.post('/api/flow/profile/save', { flow: page.draft, old_name: page.name });
    page.overview = { ...page.overview, ...data };
    page.name = data.flow.name;
    page.draft = data.flow;
    page.saved = JSON.stringify(data.flow);
    toast.success(`Saved '${page.name}'`);
    idleWarning(data);
    render();
    return true;
  } catch (err) {
    toast.error(err);
    return false;
  }
}

function discard() {
  page.draft = JSON.parse(page.saved);
  render();
}

// The waiting look is written to the controllers on save; say which ones were not reachable
function idleWarning(data) {
  if (data?.idle_failed?.length) toast.warning(`Could not set the waiting lights on ${data.idle_failed.join(', ')}. They get them the next time the profile is saved.`);
}

function change(mutator, { rerender = true } = {}) {
  mutator(page.draft);
  if (rerender) render();
  else renderSavebar();
}

async function guardUnsaved() {
  if (!isDirty()) return true;
  return window.lightingGuard.confirmLeave({ what: 'flow', save, discard });
}

// --- profile actions ---------------------------------------------------------

function uniqueName(base) {
  const names = new Set(page.overview.profiles.map(p => p.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

// The profile dropdown holds your profiles and the presets; picking a preset makes a new profile from it
async function pickFromDropdown(value) {
  const [kind, ref] = splitPick(value);
  if (kind === 'preset') {
    const preset = page.overview.presets.find(p => p.id === ref);
    await createProfile({ title: `New profile from '${preset.name}'`, base: preset.name, source: { preset: ref } });
    render();
    return;
  }
  if (ref === page.name) return;
  if (!(await guardUnsaved())) { render(); return; }
  await openProfile(ref);
  render();
}

function splitPick(value) {
  const i = value.indexOf(':');
  return [value.slice(0, i), value.slice(i + 1)];
}

// A blank profile (default settings), or a copy of an existing one
async function newProfile() {
  const source = h('select', { class: 'ui-select', 'aria-label': 'Start from' },
    h('option', { value: 'preset:classic' }, 'Default settings'),
    ...page.overview.profiles.map(p => h('option', { value: `copy:${p.name}` }, `Copy of '${p.name}'`)));
  await createProfile({
    title: 'New flow profile', base: 'New profile',
    body: h('label', { class: 'fm-new-source' }, 'Start from', source),
    source: () => {
      const [kind, ref] = splitPick(source.value);
      return kind === 'copy' ? { copy_from: ref } : { preset: ref };
    }
  });
}

async function createProfile({ title, base, body, source }) {
  if (!(await guardUnsaved())) return;
  const name = await promptDialog({
    title, body, value: uniqueName(base), confirmLabel: 'Create', maxLength: 40,
    validate: v => (!v.trim() ? 'Give it a name.' : page.overview.profiles.some(p => p.name === v.trim()) ? 'That name is taken.' : null)
  });
  if (!name) return;
  try {
    const from = typeof source === 'function' ? source() : source;
    const data = await api.post('/api/flow/profile/create', { name: name.trim(), ...from });
    page.overview = { ...page.overview, ...data };
    await openProfile(data.flow.name);
    toast.success(`Created '${data.flow.name}'`);
    render();
  } catch (err) {
    toast.error(err);
  }
}

async function renameProfile() {
  const name = await promptDialog({
    title: 'Rename profile', value: page.name, confirmLabel: 'Rename', maxLength: 40,
    validate: v => (!v.trim() ? 'Give it a name.' : v.trim() !== page.name && page.overview.profiles.some(p => p.name === v.trim()) ? 'That name is taken.' : null)
  });
  if (!name || name.trim() === page.name) return;
  page.draft.name = name.trim();
  if (await save()) await refresh(page.draft.name);
}

async function deleteProfile() {
  const users = lightsUsing(page.name);
  const ok = await confirmDialog({
    title: `Delete '${page.name}'?`,
    body: users.length ? `${users.length} light strip(s) use it. They will use '${page.overview.default === page.name ? 'another profile' : page.overview.default}' instead.` : 'No light strip uses it.',
    confirmLabel: 'Delete', danger: true
  });
  if (!ok) return;
  try {
    const data = await api.post('/api/flow/profile/delete', { name: page.name });
    page.overview = { ...page.overview, ...data };
    idleWarning(data);
    page.saved = null;
    page.draft = null;
    await refresh(data.default);
    toast.success('Profile deleted');
  } catch (err) {
    toast.error(err);
  }
}

async function resetProfile() {
  const preset = page.overview.presets.find(p => p.id === (page.draft.preset || 'classic'));
  const ok = await confirmDialog({
    title: `Reset '${page.name}'?`,
    body: `Everything goes back to the ${preset?.name || 'Classic'} preset. Your changes to this profile are lost.`,
    confirmLabel: 'Reset', danger: true
  });
  if (!ok) return;
  try {
    const data = await api.post('/api/flow/profile/reset', { name: page.name });
    page.overview = { ...page.overview, ...data };
    idleWarning(data);
    page.draft = data.flow;
    page.saved = JSON.stringify(data.flow);
    render();
    toast.success('Profile reset');
  } catch (err) {
    toast.error(err);
  }
}

async function makeDefault() {
  try {
    const data = await api.post('/api/flow/profile/default', { name: page.name });
    page.overview = { ...page.overview, ...data };
    idleWarning(data);
    render();
    toast.success(`New controllers use '${page.name}'`);
  } catch (err) {
    toast.error(err);
  }
}

// --- trying on the lights ----------------------------------------------------

async function tryOnLights(kind, id, extra = {}) {
  if (!allSegments().length) {
    toast.warning('Add a controller in Setup first.');
    return;
  }
  try {
    await api.post('/api/flow/try', { flow: page.draft, kind, id, ...extra });
  } catch (err) {
    toast.error(err);
  }
}

// --- status line -------------------------------------------------------------

function statusNotes() {
  const notes = [];
  const flow = page.draft;
  const o = page.overview;
  if (!o.lights.length) {
    notes.push({ tone: 'warn', text: 'No controller yet.', link: ['Add one in Setup', '/setup/controllers'] });
  } else if (!lightsUsing(page.name).length) {
    notes.push({ tone: 'warn', text: 'No light strip plays this profile.', action: ['Choose strips', () => select({ kind: 'profile' })] });
  }
  if (o.lighting_mode !== 'flow') {
    notes.push({ tone: 'warn', text: 'Games use the legacy Event Matrix right now (not supported).', action: ['Use the Flow Matrix', () => window.switchLightingMode('flow')] });
  }
  if (o.match_running) notes.push({ tone: 'live', text: 'A match is running. The chart follows it live.' });
  for (const s of o.steps) {
    if (!s.always_on && !flow.steps[s.id].effect.enabled) {
      notes.push({ tone: 'off', text: `${s.label} is off · ${OFF_TEXT[s.id]}.`, select: { kind: 'step', id: s.id } });
    }
  }
  if (!Object.values(flow.hits).some(hh => hh.enabled)) {
    notes.push({ tone: 'off', text: 'No hit effects · darts don\'t light anything up.', select: { kind: 'hit', id: '180' } });
  }
  const seen = new Map();
  flow.players.slice(0, 4).forEach((p, i) => {
    const key = hex(p.color);
    if (seen.has(key)) notes.push({ tone: 'warn', text: `Player ${seen.get(key) + 1} and player ${i + 1} have the same colour.`, select: { kind: 'players' } });
    else seen.set(key, i);
  });
  if (!flow.camera_friendly && Object.values(flow.hits).some(hh => hh.enabled)) {
    notes.push({ tone: 'warn', text: 'Hits flash at full strength during turns. On some boards this disturbs dart detection.', select: { kind: 'profile' } });
  }
  return notes;
}

// --- chart -------------------------------------------------------------------
// The legacy flow layout: Waiting -> Bull-off -> Game starts -> [Player 1 <-> Pulling darts <-> Player 2] -> Match won /
// Leg won, with squared-off returns and the standby timers under Waiting. Nodes sit on fixed coordinates (one table per
// view) and every connector is an orthogonal SVG path computed from the same numbers, so wires always line up.

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEW_KEY = 'autoglow_flow_view';

function select(sel) {
  page.selected = sel;
  render();
}

function isSelected(kind, id) {
  return page.selected?.kind === kind && (id === undefined || page.selected.id === id);
}

// Chosen in Settings (per browser); narrow windows always get the vertical chart
function currentView() {
  if (window.matchMedia('(max-width: 1100px)').matches) return 'vertical';
  try { return localStorage.getItem(VIEW_KEY) === 'horizontal' ? 'horizontal' : 'vertical'; } catch (err) { return 'vertical'; }
}

// Node boxes ({x, y, w, h}), the match frame, where the hit chips and players go, per view
const LAYOUTS = {
  horizontal: (() => {
    const W = 150, H = 76, top = 70;
    return {
      width: 1700, height: 470,
      nodes: {
        waiting: { x: 20, y: top + 70, w: W, h: H },
        bull_off: { x: 255, y: top + 70, w: W, h: H },
        game_start: { x: 490, y: top + 70, w: W, h: H },
        p1: { x: 745, y: top + 70, w: W, h: H },
        takeout: { x: 990, y: top + 70, w: W, h: H },
        p2: { x: 1235, y: top + 70, w: W, h: H },
        match_won: { x: 1530, y: top + 0, w: W, h: H },
        leg_won: { x: 1530, y: top + 160, w: W, h: H },
        timeout: { x: 20, y: top + 215, w: W, h: 46 },
        auto_off: { x: 20, y: top + 315, w: W, h: 46 }
      },
      frame: { x: 710, y: top - 14, w: 720, h: 254 },
      chips: { x: 728, y: top - 2, w: 690 },
      players: { x: 990, y: top + 182 }
    };
  })(),
  vertical: (() => {
    const W = 196, H = 66, cx = 270;
    return {
      width: 1030, height: 1080,
      nodes: {
        waiting: { x: cx, y: 30, w: W, h: H },
        timeout: { x: cx + 346, y: 40, w: 124, h: 46 },
        auto_off: { x: cx + 620, y: 40, w: 124, h: 46 },
        bull_off: { x: cx, y: 165, w: W, h: H },
        game_start: { x: cx, y: 300, w: W, h: H },
        p1: { x: cx, y: 500, w: W, h: H },
        takeout: { x: cx, y: 640, w: W, h: H },
        p2: { x: cx, y: 780, w: W, h: H },
        match_won: { x: cx - 70, y: 970, w: W, h: H },
        leg_won: { x: cx + 230, y: 970, w: W, h: H }
      },
      frame: { x: cx - 50, y: 410, w: 640, h: 466 },
      chips: { x: cx + 132, y: 424, w: 440 },
      players: { x: cx + 245, y: 805 }
    };
  })()
};

// Connectors: [from node, side, along-offset] -> [to node, side, along-offset]; pill = the step whose
// "comes in with" transition the arrow plays (shared pills light up together), or a fixed label
const EDGES = {
  horizontal: [
    { from: ['waiting', 'r'], to: ['bull_off', 'l'], step: 'bull_off' },
    { from: ['bull_off', 'r'], to: ['game_start', 'l'], step: 'game_start' },
    { from: ['game_start', 'r'], to: ['p1', 'l'], step: 'turn' },
    { from: ['p1', 'r', -16], to: ['takeout', 'l', -16], step: 'takeout' },
    { from: ['takeout', 'l', 16], to: ['p1', 'r', 16], step: 'turn' },
    { from: ['takeout', 'r', -16], to: ['p2', 'l', -16], step: 'turn' },
    { from: ['p2', 'l', 16], to: ['takeout', 'r', 16], step: 'takeout' },
    { from: ['frame', 'r'], to: ['match_won', 'l'], step: 'match_won' },
    { from: ['frame', 'r'], to: ['leg_won', 'l'], step: 'leg_won' },
    { from: ['leg_won', 'b'], to: ['p1', 'b'], step: 'turn', label: 'next leg', out: 44 },
    { from: ['match_won', 't'], to: ['waiting', 't'], fixed: 'back to waiting', out: 36 },
    { from: ['waiting', 'b'], to: ['timeout', 't'], standby: 'dim' },
    { from: ['timeout', 'b'], to: ['auto_off', 't'], standby: 'off' }
  ],
  vertical: [
    { from: ['waiting', 'b'], to: ['bull_off', 't'], step: 'bull_off' },
    { from: ['bull_off', 'b'], to: ['game_start', 't'], step: 'game_start' },
    { from: ['game_start', 'b'], to: ['p1', 't'], step: 'turn', at: 0.22 },
    { from: ['p1', 'b', -50], to: ['takeout', 't', -50], step: 'takeout' },
    { from: ['takeout', 't', 50], to: ['p1', 'b', 50], step: 'turn' },
    { from: ['takeout', 'b', -50], to: ['p2', 't', -50], step: 'turn' },
    { from: ['p2', 't', 50], to: ['takeout', 'b', 50], step: 'takeout' },
    { from: ['frame', 'b'], to: ['match_won', 't'], step: 'match_won' },
    { from: ['frame', 'b'], to: ['leg_won', 't'], step: 'leg_won' },
    { from: ['leg_won', 'r'], to: ['p1', 'r'], step: 'turn', label: 'next leg', out: 60 },
    { from: ['match_won', 'l'], to: ['waiting', 'l'], fixed: 'back to waiting', out: 70 },
    { from: ['waiting', 'r'], to: ['timeout', 'l'], standby: 'dim' },
    { from: ['timeout', 'r'], to: ['auto_off', 'l'], standby: 'off' }
  ]
};

const NORMAL = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };

function anchor(box, side, along = 0) {
  if (side === 'l') return [box.x, box.y + box.h / 2 + along];
  if (side === 'r') return [box.x + box.w, box.y + box.h / 2 + along];
  if (side === 't') return [box.x + box.w / 2 + along, box.y];
  return [box.x + box.w / 2 + along, box.y + box.h];
}

// Orthogonal connector: straight runs joined by small rounded 90° corners. Same-side ends (r->r, l->l, ...) loop out
// `out` px past the outer anchor; opposite sides make a Z through the midpoint; perpendicular sides make an L.
const CORNER = 8;

function route(a, sa, b, sb, out = 40) {
  const vertA = NORMAL[sa][0] === 0;
  const vertB = NORMAL[sb][0] === 0;
  let pts;
  if (sa === sb) {
    if (vertA) {
      const y = sa === 'b' ? Math.max(a[1], b[1]) + out : Math.min(a[1], b[1]) - out;
      pts = [a, [a[0], y], [b[0], y], b];
    } else {
      const x = sa === 'r' ? Math.max(a[0], b[0]) + out : Math.min(a[0], b[0]) - out;
      pts = [a, [x, a[1]], [x, b[1]], b];
    }
  } else if (vertA === vertB) {
    if (vertA) {
      const y = (a[1] + b[1]) / 2;
      pts = [a, [a[0], y], [b[0], y], b];
    } else {
      const x = (a[0] + b[0]) / 2;
      pts = [a, [x, a[1]], [x, b[1]], b];
    }
  } else {
    pts = vertA ? [a, [a[0], b[1]], b] : [a, [b[0], a[1]], b];
  }
  // Drop zero-length runs and straight-through points
  pts = pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  pts = pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return true;
    const [q, r] = [pts[i - 1], pts[i + 1]];
    return !((q[0] === p[0] && p[0] === r[0]) || (q[1] === p[1] && p[1] === r[1]));
  });

  const len = (p, q) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]);
  const toward = (p, q, dist) => {
    const l = len(p, q) || 1;
    return [p[0] + (q[0] - p[0]) * dist / l, p[1] + (q[1] - p[1]) * dist / l];
  };
  let d = `M${a[0]},${a[1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, c, n] = [pts[i - 1], pts[i], pts[i + 1]];
    const r = Math.min(CORNER, len(p, c) / 2, len(c, n) / 2);
    const s = toward(c, p, r);
    const e = toward(c, n, r);
    d += ` L${s[0]},${s[1]} Q${c[0]},${c[1]} ${e[0]},${e[1]}`;
  }
  d += ` L${b[0]},${b[1]}`;

  const segs = pts.slice(1).map((q, i) => len(pts[i], q));
  const total = segs.reduce((x, y) => x + y, 0);
  const at = t => {
    let left = total * t;
    for (let i = 0; i < segs.length; i++) {
      if (left <= segs[i]) return toward(pts[i], pts[i + 1], left);
      left -= segs[i];
    }
    return b;
  };
  return { d, at };
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function stepOn(id) {
  return !!page.draft.steps[id]?.effect.enabled;
}

const NODE_STEP = { p1: 'turn', p2: 'turn' };

function nodeLabel(id) {
  if (id === 'p1') return 'Player 1';
  if (id === 'p2') return 'Player 2';
  return { waiting: 'Waiting/Idle', timeout: 'Dimmed', auto_off: 'Lights off' }[id] || stepMeta(id).label;
}

function dotStyle(effect, player = 0) {
  const eff = resolved(effect, false, player);
  if (eff.animation === 'rainbow') return 'background: conic-gradient(#ff3b3b, #ffb300, #39d353, #1fb6ff, #8b5cf6, #ff3b3b)';
  return `background:${hex(eff.color_primary)}`;
}

function chartNode(id, box) {
  const el = h('button', { type: 'button', class: 'fc-node' });
  el.style.left = `${box.x}px`;
  el.style.top = `${box.y}px`;
  el.style.width = `${box.w}px`;
  el.style.height = `${box.h}px`;
  const o = page.overview;

  if (id === 'waiting') {
    el.classList.add('fc-node-waiting');
    if (isSelected('waiting')) el.classList.add('is-selected');
    el.onclick = () => select({ kind: 'waiting' });
    el.append(h('span', { class: 'fc-title' }, h('span', { class: 'fc-dot fc-dot-idle' }), 'Waiting/Idle'),
      h('span', { class: 'fc-meta' }, idleSummary()));
    return el;
  }
  if (id === 'timeout' || id === 'auto_off') {
    const on = id === 'timeout' ? o.standby?.dim_on : o.standby?.off_on;
    el.classList.add('fc-node-standby');
    if (!on) el.classList.add('is-off');
    if (isSelected('standby')) el.classList.add('is-selected');
    el.onclick = () => select({ kind: 'standby' });
    el.append(h('span', { class: 'fc-title' }, nodeLabel(id)));
    return el;
  }

  const step = NODE_STEP[id] || id;
  const meta = stepMeta(step);
  const eff = page.draft.steps[step].effect;
  const on = eff.enabled;
  const player = id === 'p2' ? 1 : 0;
  const live = page.live?.step === step && (step !== 'turn' || (id === 'p1') === ((page.live.player || 0) % 2 === 0));
  el.dataset.step = step;
  el.dataset.node = id;
  if (!on) el.classList.add('is-off');
  if (isSelected('step', step)) el.classList.add('is-selected');
  if (live) el.classList.add('is-live');
  el.onclick = () => select({ kind: 'step', id: step });
  const timing = meta.timed ? seconds(eff.duration) : (step === 'turn' ? 'stays' : 'until next');
  const dot = h('span', { class: 'fc-dot' });
  dot.setAttribute('style', step === 'turn'
    ? `background:${hex(playerColour(player))}`
    : dotStyle(eff));
  el.append(
    h('span', { class: 'fc-title' }, dot, nodeLabel(id)),
    h('span', { class: 'fc-meta' }, on ? `${(effectMeta(eff.animation)?.label || 'Solid')} · ${timing}` : 'Off'),
    strip(step === 'turn' ? ((t, n) => renderFlowFrame(resolved(eff, true, player), t, n)) : stepFrame(step), { leds: 36, cls: 'fc-strip' }));
  return el;
}

function edgeLabel(edge) {
  if (edge.fixed) return page.overview.match_end_to_waiting ? 'back to waiting' : 'winner’s colour stays';
  if (edge.standby) {
    const s = page.overview.standby || {};
    return edge.standby === 'dim' ? (s.dim_on ? `after ${s.dim_minutes} min inactivity` : 'off') : (s.off_on ? `after ${s.off_minutes} min inactivity` : 'off');
  }
  const tr = page.draft.steps[edge.step].transition;
  const text = tr.style === 'instant' ? 'Cut' : `${transitionLabel(tr.style)} ${seconds(tr.duration)}`;
  return edge.label ? `${edge.label} · ${text}` : text;
}

function chart() {
  const view = currentView();
  const L = LAYOUTS[view];
  const boxes = { ...L.nodes, frame: L.frame };
  const stage = h('div', { class: `fc-stage fc-${view}` });
  stage.style.width = `${L.width}px`;
  stage.style.height = `${L.height}px`;

  // Match frame with the hit chips on top and the players inside
  const frame = h('div', { class: 'fc-frame' });
  Object.assign(frame.style, { left: `${L.frame.x}px`, top: `${L.frame.y}px`, width: `${L.frame.w}px`, height: `${L.frame.h}px` });
  stage.append(frame);
  const chips = hitsRow();
  Object.assign(chips.style, { left: `${L.chips.x}px`, top: `${L.chips.y}px`, width: `${L.chips.w}px` });
  stage.append(chips);
  const players = playersRow();
  Object.assign(players.style, { left: `${L.players.x}px`, top: `${L.players.y}px` });
  stage.append(players);

  const svg = svgEl('svg', { class: 'fc-wires', width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}` });
  const defs = svgEl('defs', {});
  for (const [name, cls] of [['fcArrow', ''], ['fcArrowOn', 'on'], ['fcArrowOff', 'off']]) {
    const m = svgEl('marker', { id: name, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    m.append(svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: `fc-arrowhead ${cls}`.trim() }));
    defs.append(m);
  }
  svg.append(defs);
  stage.append(svg);

  for (const edge of EDGES[view]) {
    const [fromId, fs, fa = 0] = edge.from;
    const [toId, ts, ta = 0] = edge.to;
    const a = anchor(boxes[fromId], fs, fa);
    const b = anchor(boxes[toId], ts, ta);
    const { d, at } = route(a, fs, b, ts, edge.out);
    const mid = at(edge.at ?? 0.5);
    const nodeStep = n => NODE_STEP[n] || n;
    const ends = [nodeStep(fromId), nodeStep(toId)].filter(n => page.draft.steps[n]);
    const skipped = (edge.step && !stepOn(edge.step)) || ends.some(n => !stepOn(n));
    const chosen = edge.step && isSelected('transition', edge.step);
    const cls = `fc-wire${skipped ? ' is-skipped' : ''}${chosen ? ' is-selected' : ''}${edge.fixed || edge.standby ? ' is-quiet' : ''}`;
    svg.append(svgEl('path', { d, class: cls, 'marker-end': `url(#${chosen ? 'fcArrowOn' : skipped ? 'fcArrowOff' : 'fcArrow'})` }));

    const pill = h('button', {
      type: 'button',
      class: `fc-pill${chosen ? ' is-selected' : ''}${skipped ? ' is-skipped' : ''}${edge.fixed || edge.standby ? ' is-quiet' : ''}`,
      title: edge.step ? `How ${stepMeta(edge.step).label} comes in (click to edit)` : ''
    }, skipped && edge.step ? 'skipped' : edgeLabel(edge));
    const [px, py] = mid;
    pill.style.left = `${px}px`;
    pill.style.top = `${py}px`;
    if (edge.step && !skipped) pill.onclick = () => select({ kind: 'transition', id: edge.step });
    else if (edge.standby) pill.onclick = () => select({ kind: 'standby' });
    else if (edge.fixed) pill.onclick = () => select({ kind: 'waiting' });
    else pill.disabled = true;
    stage.append(pill);
  }

  for (const [id, box] of Object.entries(L.nodes)) stage.append(chartNode(id, box));

  const sizer = h('div', { class: 'fc-sizer' }, stage);
  const scroller = h('div', { class: 'fc-scroller' }, sizer);
  // Fit wide charts into the card; below 80 % the chart scrolls sideways instead of shrinking further
  requestAnimationFrame(() => fitChart(scroller, sizer, stage, L));
  return h('div', { class: 'fc-wrap' }, scroller);
}

function fitChart(scroller, sizer, stage, L) {
  if (!scroller.isConnected) return;
  const scale = Math.max(0.8, Math.min(1, scroller.clientWidth / L.width));
  stage.style.transform = scale < 1 ? `scale(${scale})` : '';
  stage.style.transformOrigin = 'top left';
  sizer.style.width = `${Math.ceil(L.width * scale)}px`;
  sizer.style.height = `${Math.ceil(L.height * scale)}px`;
}

function playersRow() {
  const players = page.draft.players;
  const liveP = page.live && ['turn', 'takeout'].includes(page.live.step) ? page.live.player : null;
  return h('button', {
    type: 'button', class: `fc-players${isSelected('players') ? ' is-selected' : ''}`, onclick: () => select({ kind: 'players' }),
    title: 'Player colours'
  },
  h('span', { class: 'fc-row-label' }, 'Players'),
  ...players.map((p, i) => {
    const dot = h('span', { class: `fc-pdot${liveP === i ? ' is-live' : ''}`, title: p.name || `Player ${i + 1}` });
    dot.setAttribute('style', `background:${hex(p.color)}`);
    return dot;
  }));
}

function hitsRow() {
  return h('div', { class: 'fc-chips' },
    h('span', { class: 'fc-row-label' }, 'Hits'),
    ...page.overview.hits.map(meta => {
      const hit = page.draft.hits[meta.id];
      const chip = h('button', {
        type: 'button',
        class: `fc-chip${hit.enabled ? '' : ' is-off'}${isSelected('hit', meta.id) ? ' is-selected' : ''}${page.liveHit === meta.id ? ' is-flash' : ''}`,
        'data-hit': meta.id,
        title: hit.enabled ? `${meta.label}: ${effectMeta(hit.animation)?.label}` : `${meta.label}: off`,
        onclick: () => select({ kind: 'hit', id: meta.id })
      }, meta.label);
      if (hit.enabled) {
        const sw = h('span', { class: 'fc-chip-dot' });
        sw.setAttribute('style', dotStyle(hit));
        chip.prepend(sw);
      }
      return chip;
    }));
}

// --- inspector controls ------------------------------------------------------

function section(title, ...children) {
  return h('section', { class: 'fm-section' }, title && h('h3', { class: 'fm-section-title' }, title), ...children);
}

function onOff(checked, onchange, label) {
  return h('label', { class: 'fm-switch' },
    h('span', { class: 'switch' },
      h('input', { type: 'checkbox', checked, onchange: e => onchange(e.target.checked), 'aria-label': label }),
      h('span', { class: 'switch-slider' })),
    h('span', {}, checked ? 'On' : 'Off'));
}

function segmented(values, current, onpick, labels = {}) {
  return h('div', { class: 'fm-seg', role: 'radiogroup' }, ...values.map(v => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(v === current),
    class: `fm-seg-btn${v === current ? ' is-on' : ''}`, onclick: () => onpick(v)
  }, labels[v] ?? String(v))));
}

function colourField(label, value, onpick) {
  const input = h('input', { type: 'color', class: 'fm-colour', value: hex(value), 'aria-label': label,
    oninput: e => onpick(fromHex(e.target.value), false), onchange: e => onpick(fromHex(e.target.value), true) });
  return h('label', { class: 'fm-field' }, h('span', { class: 'form-label' }, label), input);
}

function rangeField(label, { min, max, step, value, format, onset }) {
  const out = h('span', { class: 'fm-range-value' }, format(value));
  const input = h('input', { type: 'range', class: 'ui-range', min, max, step, value,
    oninput: e => { out.textContent = format(Number(e.target.value)); onset(Number(e.target.value), false); },
    onchange: e => onset(Number(e.target.value), true) });
  return h('label', { class: 'fm-field' }, h('span', { class: 'form-label' }, label), h('span', { class: 'fm-range' }, input, out));
}

function flowLookGrid(effect, setEffect, forcePlayer) {
  return h('div', { class: 'fm-effects' }, ...page.overview.catalog.effects.map(meta => {
    const on = effect.animation === meta.id;
    const sample = { ...effect, animation: meta.id, duration: effect.duration || 0 };
    return h('button', {
      type: 'button', class: `fm-effect${on ? ' is-on' : ''}`, 'aria-pressed': String(on),
      onclick: () => setEffect(e => { e.animation = meta.id; e.options = { colour_from: e.options?.colour_from || 'custom' }; })
    },
    strip(lookFrame(resolved(sample, forcePlayer)), { leds: 24, cls: 'fm-strip fm-strip-sm' }),
    h('span', { class: 'fm-effect-name' }, meta.label),
    h('span', { class: 'fm-effect-job' }, meta.job));
  }));
}

function lookEditor(effect, { setEffect, timed, forcePlayer = false, playerChoice = false, playerWord = 'Player colour', isHit = false }) {
  const meta = effectMeta(effect.animation);
  const parts = [flowLookGrid(effect, setEffect, forcePlayer)];

  for (const opt of meta.options) {
    const [label, names] = OPTION_LABELS[opt.key] || [opt.key, {}];
    const current = effect.options?.[opt.key] ?? opt.default;
    parts.push(h('div', { class: 'fm-field' }, h('span', { class: 'form-label' }, label),
      segmented(opt.values, current, v => setEffect(e => { e.options = { ...e.options, [opt.key]: v }; }), names)));
  }

  const colours = [];
  if (!NO_COLOUR.has(effect.animation)) {
    if (forcePlayer) {
      colours.push(h('p', { class: 'form-hint fm-inline-note' }, 'Uses each player\'s colour. ',
        h('button', { type: 'button', class: 'ui-btn-link', onclick: () => select({ kind: 'players' }) }, 'Change player colours')));
    } else {
      const fromPlayer = effect.options?.colour_from === 'player';
      if (playerChoice) {
        colours.push(h('div', { class: 'fm-field' }, h('span', { class: 'form-label' }, 'Colour'),
          segmented(['player', 'custom'], fromPlayer ? 'player' : 'custom',
            v => setEffect(e => { e.options = { ...e.options, colour_from: v }; }),
            { player: playerWord, custom: 'Pick a colour' })));
      }
      if (!fromPlayer) {
        colours.push(colourField(playerChoice ? 'Pick a colour' : 'Colour', effect.color_primary,
          (c, done) => setEffect(e => { e.color_primary = c; }, done)));
      }
    }
    if (USES_BACKGROUND.has(effect.animation) && !isHit) {
      colours.push(colourField('Background', effect.color_secondary, (c, done) => setEffect(e => { e.color_secondary = c; }, done)));
    }
  }
  if (colours.length) parts.push(h('div', { class: 'fm-colours' }, ...colours));

  if (effect.animation !== 'solid') {
    parts.push(rangeField('Speed', {
      min: 0, max: SPEEDS.length - 1, step: 1, value: speedIndex(effect.speed),
      format: i => (i < 3 ? 'Slow' : i === 3 ? 'Normal' : i < 6 ? 'Fast' : 'Very fast'),
      onset: (i, done) => setEffect(e => { e.speed = SPEEDS[i]; }, done)
    }));
  }
  if (timed) {
    parts.push(rangeField(isHit ? 'Lasts' : 'Plays for at least', {
      min: isHit ? 0.3 : 0.5, max: isHit ? 5 : 15, step: isHit ? 0.1 : 0.5, value: effect.duration,
      format: seconds, onset: (v, done) => setEffect(e => { e.duration = v; }, done)
    }));
  }

  const more = h('details', { class: 'fm-more' }, h('summary', {}, 'More'),
    rangeField('Brightness', {
      min: 10, max: 100, step: 5, value: effect.brightness ?? 100, format: v => `${v} %`,
      onset: (v, done) => setEffect(e => { e.brightness = v >= 100 ? null : v; }, done)
    }),
    CAN_REVERSE.has(effect.animation) && h('div', { class: 'fm-field' }, h('span', { class: 'form-label' }, 'Direction'),
      segmented([false, true], !!effect.reverse, v => setEffect(e => { e.reverse = v; }), { false: 'Clockwise', true: 'Anticlockwise' })));
  parts.push(more);
  return parts;
}

function transitionEditor(id) {
  const tr = page.draft.steps[id].transition;
  const setTr = (fn, done = true) => change(d => fn(d.steps[id].transition), { rerender: done });
  return [
    h('div', { class: 'fm-effects fm-transitions' }, ...page.overview.catalog.transitions.map(t => h('button', {
      type: 'button', class: `fm-effect${tr.style === t.id ? ' is-on' : ''}`, 'aria-pressed': String(tr.style === t.id),
      onclick: () => setTr(x => { x.style = t.id; if (t.id !== 'instant' && !x.duration) x.duration = 0.5; })
    }, strip(styleFrame(t.id, id), { leds: 24, cls: 'fm-strip fm-strip-sm' }), h('span', { class: 'fm-effect-name' }, t.label)))),
    tr.style !== 'instant' && rangeField('Takes', {
      min: 0.1, max: 2, step: 0.1, value: tr.duration || 0.5, format: seconds,
      onset: (v, done) => setTr(x => { x.duration = v; }, done)
    }),
    tr.style === 'flash' && h('details', { class: 'fm-more' }, h('summary', {}, 'More'),
      colourField('Flash colour', tr.accent_color || [255, 255, 255], (c, done) => setTr(x => { x.accent_color = c; }, done)))
  ];
}

// --- inspector panels --------------------------------------------------------

function stepPanel(id) {
  const meta = stepMeta(id);
  const step = page.draft.steps[id];
  const setEffect = (fn, done = true) => change(d => fn(d.steps[id].effect), { rerender: done });
  const others = page.overview.steps.filter(s => s.id !== id);
  return [
    h('div', { class: 'fm-panel-head' },
      h('div', {}, h('span', { class: 'fm-kicker' }, 'Step · look'), h('h2', { class: 'fm-panel-title' }, meta.label)),
      !meta.always_on && onOff(step.effect.enabled, v => setEffect(e => { e.enabled = v; }), `${meta.label} on or off`)),
    h('p', { class: 'fm-panel-help' }, STEP_HELP[id]),
    !step.effect.enabled && h('p', { class: 'fm-off-note' }, `Off: ${OFF_TEXT[id]}.`),
    h('div', { class: step.effect.enabled ? '' : 'fm-dim' },
      section('Look', ...lookEditor(step.effect, {
        setEffect, timed: meta.timed, forcePlayer: id === 'turn', playerChoice: PLAYER_STEPS.has(id),
        playerWord: id === 'takeout' ? 'Player colour' : 'Winner\'s colour'
      })),
      h('button', { type: 'button', class: 'fm-link-row', onclick: () => select({ kind: 'transition', id }) },
        h('span', { class: 'fm-link-label' }, 'Comes in with'),
        h('span', { class: 'fm-link-value' }, transitionSummary(id)),
        h('span', { class: 'fm-link-go', 'aria-hidden': 'true' }, 'Edit ›')),
      h('div', { class: 'fm-panel-actions' },
        h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => tryOnLights('step', id) }, '▶ Try on my lights'),
        h('label', { class: 'fm-copy' }, h('span', { class: 'visually-hidden' }, 'Copy look from'),
          h('select', { class: 'ui-select', onchange: e => {
            const from = e.target.value;
            if (from) change(d => { d.steps[id].effect = { ...clone(d.steps[from].effect), enabled: d.steps[id].effect.enabled, duration: d.steps[id].effect.duration }; });
          } }, h('option', { value: '' }, 'Copy look from…'), ...others.map(s => h('option', { value: s.id }, s.label))))))];
}

function transitionSummary(id) {
  const tr = page.draft.steps[id].transition;
  return tr.style === 'instant' ? 'Cut' : `${transitionLabel(tr.style)} · ${seconds(tr.duration)}`;
}

function transitionPanel(id) {
  const meta = stepMeta(id);
  const view = currentView();
  const arrows = EDGES[view].filter(e => e.step === id).length;
  const before = BEFORE[id] ? stepMeta(BEFORE[id]).label : 'Waiting';
  return [
    h('div', { class: 'fm-panel-head' },
      h('div', {}, h('span', { class: 'fm-kicker' }, 'Transition'), h('h2', { class: 'fm-panel-title' }, `Into ${meta.label}`))),
    h('p', { class: 'fm-panel-help' }, `How the strip changes to the ${meta.label.toLowerCase()} look, whatever it showed before.`
      + (arrows > 1 ? ` This is shared by the ${arrows} arrows into ${meta.label} (they are highlighted).` : '')),
    h('div', { class: 'fm-hero' },
      h('div', { class: 'fm-hero-labels' }, h('span', {}, before), h('span', {}, '→'), h('span', {}, meta.label)),
      strip(transitionFrame(id), { leds: 60, cls: 'fm-strip fm-strip-hero' })),
    section('Style', ...transitionEditor(id)),
    h('div', { class: 'fm-panel-actions' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => tryOnLights('step', id) }, '▶ Try on my lights'),
      h('button', { type: 'button', class: 'ui-btn', onclick: () => select({ kind: 'step', id }) }, `Edit the ${meta.label} look`))
  ];
}

// Save the standby timers (shared with Settings > Power) and redraw the chart
async function saveStandby(patch) {
  const o = page.overview;
  const s = { ...(o.standby || {}), match_end_to_waiting: !!o.match_end_to_waiting, ...patch };
  try {
    const r = await api.post('/api/flow/standby', s);
    o.standby = { dim_on: r.inactivity_timeout_enabled, dim_minutes: r.inactivity_timeout_minutes,
      off_on: r.idle_power_off_enabled, off_minutes: r.idle_power_off_minutes, dim_brightness: r.idle_dimming_brightness };
    o.match_end_to_waiting = r.disconnect_udp_on_match_end;
    if (window.appState) {
      for (const k of ['inactivity_timeout_enabled', 'inactivity_timeout_minutes', 'idle_power_off_enabled',
        'idle_power_off_minutes', 'disconnect_udp_on_match_end', 'idle_dimming_brightness']) window.appState[k] = r[k];
    }
    toast.success('Standby saved');
  } catch (err) { toast.error(err); }
  render();
}

function minutesField(label, value, enabled, onset) {
  const input = h('input', { type: 'number', class: 'input-text fm-minutes', min: 1, max: 240, value, disabled: !enabled,
    'aria-label': label,
    onchange: e => { const v = Math.max(1, Math.min(240, parseInt(e.target.value, 10) || value)); if (v !== value) onset(v); else e.target.value = value; } });
  return h('label', { class: 'fm-minutes-row' }, input, h('span', {}, 'minutes'));
}

// Dimmed brightness is stored 0-255 and shown as a percentage; an unchanged percentage keeps the exact value
function dimPercentField(s) {
  const saved = s.dim_brightness ?? 50;
  const shown = Math.round((saved / 255) * 100);
  const input = h('input', { type: 'number', class: 'input-text fm-minutes', min: 0, max: 100, value: shown, disabled: !s.dim_on,
    'aria-label': 'Light strip brightness when dimmed, in percent',
    onchange: e => {
      const pct = Math.max(0, Math.min(100, parseInt(e.target.value, 10)));
      if (Number.isNaN(pct) || pct === shown) { e.target.value = shown; return; }
      saveStandby({ dim_brightness: Math.round((pct / 100) * 255) });
    } });
  return h('div', { class: 'fm-standby-row fm-dim-level' },
    h('label', { class: 'fm-minutes-row' }, h('span', {}, 'Light strips at'), input, h('span', {}, '%')));
}

// The same actions the timers run, on the real lights right now
async function standbyTest(kind) {
  const done = { dim: 'Lights dimmed', off: 'Lights switched off', wake: 'Lights back on' }[kind];
  try {
    const r = await api.post(`/api/power/test_${kind}`, {});
    if (r?.status === 'warning') toast.warning(r.message || done);
    else toast.success(done);
  } catch (err) { toast.error(err); }
}

function standbyPanel() {
  const s = page.overview.standby || {};
  return [
    h('div', { class: 'fm-panel-head' }, h('div', {}, h('span', { class: 'fm-kicker' }, 'Standby'), h('h2', { class: 'fm-panel-title' }, 'When nobody plays'))),
    h('p', { class: 'fm-panel-help' }, 'After a while without darts the lights dim, and later switch off. These apply to every profile. Changes save right away.'),
    section('Dim', h('div', { class: 'fm-standby-row' },
      onOff(!!s.dim_on, v => saveStandby({ dim_on: v }), 'Dimming on or off'),
      minutesField('Dim after minutes', s.dim_minutes, s.dim_on, v => saveStandby({ dim_minutes: v }))),
      dimPercentField(s)),
    section('Lights off', h('div', { class: 'fm-standby-row' },
      onOff(!!s.off_on, v => saveStandby({ off_on: v }), 'Switching off on or off'),
      minutesField('Switch off after minutes', s.off_minutes, s.off_on, v => saveStandby({ off_minutes: v }))),
      h('p', { class: 'fm-panel-help' }, 'Counted from the last dart, never sooner than dimming.')),
    section('When a match ends', h('div', { class: 'fm-standby-row' },
      onOff(!!page.overview.match_end_to_waiting, v => saveStandby({ match_end_to_waiting: v }), 'Back to waiting when a match ends'),
      h('span', { class: 'fm-panel-help' }, 'Go straight back to Waiting'))),
    section('Test on my lights',
      h('div', { class: 'fm-panel-actions' },
        h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => standbyTest('dim'), title: 'Same as when the dim timer runs out' }, 'Dim now'),
        h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => standbyTest('off'), title: 'Same as when the switch-off timer runs out' }, 'Switch off now'),
        h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => standbyTest('wake') }, 'Turn back on')))
  ];
}

function hitPanel(id) {
  const meta = hitMeta(id);
  const hit = page.draft.hits[id];
  const setEffect = (fn, done = true) => change(d => fn(d.hits[id]), { rerender: done });
  const help = {
    single: 'Any single.', double: 'Any double.', triple: 'Any triple.', bullseye: 'The bullseye (50).',
    miss: 'A dart that misses the board.', bust: 'A bust.', ton: 'A visit of 100 to 139. Plays instead of its last dart.',
    ton40: 'A visit of 140 to 179. Plays instead of its last dart.', '180': 'Three triple 20s.'
  }[id];
  return [
    h('div', { class: 'fm-panel-head' }, h('h2', { class: 'fm-panel-title' }, `Hit: ${meta.label}`),
      onOff(hit.enabled, v => setEffect(e => { e.enabled = v; }), `${meta.label} on or off`)),
    h('p', { class: 'fm-panel-help' }, `${help} Plays on top of the current look and fades back into it.`),
    h('div', { class: hit.enabled ? '' : 'fm-dim' },
      section('Look', ...lookEditor(hit, { setEffect, timed: true, playerChoice: true, playerWord: 'Player colour', isHit: true })),
      h('div', { class: 'fm-panel-actions' },
        h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => tryOnLights('hit', id) }, '▶ Try on my lights')))
  ];
}

function playersPanel() {
  const rows = page.draft.players.map((p, i) => h('div', { class: 'fm-player' },
    h('span', { class: 'fm-player-num' }, String(i + 1)),
    h('input', { type: 'color', class: 'fm-colour', value: hex(p.color), 'aria-label': `Player ${i + 1} colour`,
      onchange: e => change(d => { d.players[i].color = fromHex(e.target.value); }) }),
    h('input', { type: 'text', class: 'ui-input fm-player-name', value: p.name || '', placeholder: 'Any player', maxlength: 40,
      'aria-label': `Name for colour ${i + 1}`,
      oninput: e => change(d => { d.players[i].name = e.target.value; }, { rerender: false }),
      onchange: () => render() }),
    h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => tryOnLights('step', 'turn', { player: i }) }, 'Try')));
  return [
    h('div', { class: 'fm-panel-head' }, h('h2', { class: 'fm-panel-title' }, 'Player colours')),
    h('p', { class: 'fm-panel-help' }, 'Players get these colours in match order. Type a name to keep a colour for that player (part of the name is enough). With more than six players the colours repeat.'),
    section(null, ...rows)
  ];
}

function idleSummary() {
  const idle = page.draft.idle || IDLE_DEFAULT;
  if (!idle.on) return 'Off';
  wledEffects();
  return page.wledEffects?.find(e => e.id === idle.fx)?.name || (idle.fx === 0 ? 'Solid' : 'WLED effect');
}

// Waiting: the profile's idle effect, one from the WLED library. WLED plays it itself between games;
// every segment that gets this profile in Setup is set to it (and again whenever the profile is saved).
const IDLE_DEFAULT = { on: true, fx: 9, speed: 128, intensity: 128, brightness: 100, colors: [[0, 255, 157], [0, 0, 0], [0, 0, 0]] };

function wledEffects() {
  if (page.wledEffects) return page.wledEffects;
  if (!page.wledEffectsLoading) {
    page.wledEffectsLoading = true;
    // Any controller's library will do (they share WLED's list); without one the bundled list is used
    loadEffects(page.overview.lights?.[0]?.ip || '').then(list => {
      page.wledEffects = list;
      if (page.selected?.kind === 'waiting') render();
    });
  }
  return null;
}

function waitingPanel() {
  const head = [
    h('div', { class: 'fm-panel-head' }, h('h2', { class: 'fm-panel-title' }, 'Waiting/Idle')),
    h('p', { class: 'fm-panel-help' }, 'What the strips show between games: an effect from the controller\'s WLED library. The controller plays it on its own. Every strip that plays this profile (Setup) gets it when you save.')
  ];
  page.draft.idle ||= structuredClone(IDLE_DEFAULT);
  const idle = page.draft.idle;
  const effects = wledEffects();
  if (!effects) return [...head, h('p', { class: 'form-hint' }, 'Loading the WLED effects…')];
  const meta = effects.find(e => e.id === idle.fx) || { id: idle.fx, name: `Effect ${idle.fx}`, colorSlots: [], speed: true, intensity: true };
  const slots = meta.colorSlots || [];
  return [...head,
    section('Lights between games',
      h('div', { class: 'fm-toggle-row' }, onOff(idle.on, v => change(d => { d.idle.on = v; }), 'Lights on between games')),
      !idle.on && h('p', { class: 'form-hint' }, 'The strips stay dark between games.')),
    idle.on && section('Effect',
      h('div', { class: 'fm-field' }, h('span', { class: 'form-label' }, 'Effect'),
        wledEffectPicker(effects, idle.fx, effect => change(d => { d.idle.fx = effect.id; }))),
      ...(slots.length
        ? slots.map(slot => colourField(slot.label || 'Colour', idle.colors[slot.slot] || [0, 0, 0],
          (rgb, done) => change(d => { d.idle.colors[slot.slot] = rgb; }, { rerender: done })))
        : [h('p', { class: 'form-hint' }, 'This effect uses its own colours.')]),
      rangeField('Brightness', { min: 0, max: 100, step: 1, value: idle.brightness, format: v => `${v}%`,
        onset: (v, done) => change(d => { d.idle.brightness = v; }, { rerender: done }) }),
      meta.speed && rangeField(meta.speedLabel || 'Speed', { min: 0, max: 255, step: 1, value: idle.speed, format: v => String(v),
        onset: (v, done) => change(d => { d.idle.speed = v; }, { rerender: done }) }),
      meta.intensity && rangeField(meta.intensityLabel || 'Intensity', { min: 0, max: 255, step: 1, value: idle.intensity, format: v => String(v),
        onset: (v, done) => change(d => { d.idle.intensity = v; }, { rerender: done }) }))
  ].filter(Boolean);
}

function locatorCheck() {
  const rings = allSegments().filter(s => s.role !== 'ambient');
  if (!rings.length) return h('p', { class: 'form-hint' }, 'Add a controller to check the hit locator.');
  return h('div', { class: 'fm-locator' },
    h('p', { class: 'form-hint' }, 'Check it once: "Show 20" should light the top of the board, "Show 6" the right side. If 6 lights up on the left, switch the direction. Strips that cover only part of the board: choose Off.'),
    ...rings.map(seg => h('div', { class: 'fm-locator-row' },
      h('span', { class: 'fm-locator-name' }, `${seg.controller} · ${seg.name}`),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => tryOnLights('locator', 'turn', { number: 20, ip: seg.ip, segment_id: seg.id }) }, 'Show 20'),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => tryOnLights('locator', 'turn', { number: 6, ip: seg.ip, segment_id: seg.id }) }, 'Show 6'),
      seg.id !== null && segmented(['cw', 'ccw', 'off'], seg.locator === false ? 'off' : seg.clockwise === false ? 'ccw' : 'cw', async v => {
        try {
          await api.post('/api/flow/segment-direction', { ip: seg.ip, segment_id: seg.id, direction: v });
          await window.loadConfig();
          await loadOverview();
          render();
        } catch (err) { toast.error(err); }
      }, { cw: 'Clockwise', ccw: 'Anticlockwise', off: 'Off (not around the board)' }))));
}

function profilePanel() {
  const flow = page.draft;
  const users = lightsUsing(page.name);
  return [
    h('div', { class: 'fm-panel-head' }, h('h2', { class: 'fm-panel-title' }, 'Profile settings')),
    h('p', { class: 'fm-panel-help' }, 'Click any part of the chart to change it. These settings apply to the whole profile.'),
    section('Camera-friendly',
      h('div', { class: 'fm-toggle-row' }, onOff(flow.camera_friendly, v => change(d => { d.camera_friendly = v; }), 'Camera-friendly')),
      h('p', { class: 'form-hint' }, 'Autodarts finds darts in camera images. With this on, hits during a turn play at half strength and for at most a second, so strong flashes don\'t disturb detection. Leg and match celebrations stay full.')),
    section('Hit locator',
      h('div', { class: 'fm-toggle-row' }, onOff(flow.hit_locator, v => change(d => { d.hit_locator = v; }), 'Hit locator')),
      h('p', { class: 'form-hint' }, 'Lights the part of the strip next to the number that was hit, in the player\'s colour.'),
      flow.hit_locator && locatorCheck()),
    section('Plays on',
      ...playsOnRows(),
      page.overview.default !== page.name
        ? h('p', {}, h('button', { type: 'button', class: 'ui-btn-link', onclick: makeDefault }, 'Use this profile for new lights'))
        : h('p', { class: 'form-hint' }, 'New lights play this profile until you choose another.'))
  ];
}

// Pick a controller and one of its sections (or all of them) to play this profile
async function applyToSection() {
  const lights = page.overview.lights
    .map(dev => ({ ...dev, segments: dev.segments.filter(seg => !seg.light_strip) }))
    .filter(dev => dev.segments.length);
  if (!lights.length) {
    toast.warning('Add a controller in Setup first.');
    return;
  }
  if (!(await guardUnsaved())) return;
  const controller = h('select', { class: 'ui-select', 'aria-label': 'Controller' },
    ...lights.map((dev, i) => h('option', { value: String(i) }, `${dev.name} (${dev.ip})`)));
  const section = h('select', { class: 'ui-select', 'aria-label': 'Section' });
  const fillSections = () => {
    const dev = lights[Number(controller.value)];
    section.replaceChildren(
      ...dev.segments.map(seg => h('option', { value: String(seg.id) },
        seg.profile && seg.profile !== page.name ? `${seg.name} (now: ${seg.profile})` : seg.profile === page.name ? `${seg.name} (already)` : seg.name)),
      dev.segments.length > 1 && h('option', { value: 'all' }, 'All sections'));
  };
  controller.onchange = fillSections;
  fillSections();
  const ok = await confirmDialog({
    title: `Apply '${page.name}' to a section`,
    confirmLabel: 'Apply',
    body: h('div', {},
      h('label', { class: 'fm-new-source' }, 'Controller', controller),
      h('label', { class: 'fm-new-source' }, 'Section', section))
  });
  if (!ok) return;
  const dev = lights[Number(controller.value)];
  const segs = section.value === 'all' ? dev.segments : dev.segments.filter(seg => String(seg.id) === section.value);
  try {
    let data = null;
    for (const seg of segs) data = await api.post('/api/flow/assign', { ip: dev.ip, segment_id: seg.id, name: page.name });
    page.overview = { ...page.overview, ...data };
    idleWarning(data);
    toast.success(segs.length > 1 ? `All sections of ${dev.name} play '${page.name}'` : `${dev.name} · ${segs[0].name} plays '${page.name}'`);
    render();
  } catch (err) {
    toast.error(err);
  }
}

// Which RGB strips play this profile. Change it with "Apply to section" or on the controller's page in Setup.
function playsOnRows() {
  const segs = allSegments();
  if (!segs.length) return [h('p', { class: 'form-hint' }, 'Add a controller in Setup first.')];
  const mine = segs.filter(seg => seg.profile === page.name);
  return [
    mine.length
      ? h('ul', { class: 'fm-plays-on' }, ...mine.map(seg => h('li', {},
        h('a', { href: `/setup/controllers/${encodeURIComponent(seg.ip)}`, 'data-link': true }, `${seg.controller} · ${seg.name}`))))
      : h('p', { class: 'form-hint' }, 'No strip plays this profile yet.'),
    h('p', { class: 'form-hint' }, 'Use "Apply to section" above the chart, or choose on the controller\'s page in Setup.')
  ];
}

function inspector() {
  const sel = page.selected || { kind: 'profile' };
  let body;
  if (sel.kind === 'step') body = stepPanel(sel.id);
  else if (sel.kind === 'transition') body = transitionPanel(sel.id);
  else if (sel.kind === 'hit') body = hitPanel(sel.id);
  else if (sel.kind === 'players') body = playersPanel();
  else if (sel.kind === 'waiting') body = waitingPanel();
  else if (sel.kind === 'standby') body = standbyPanel();
  else body = profilePanel();
  // Title, help and preview on one side; the controls on the other (side by side under a horizontal chart)
  const parts = [sel.kind !== 'profile' && h('button', { type: 'button', class: 'ui-btn-link fm-back', onclick: () => select({ kind: 'profile' }) }, '← Profile settings'), ...body].filter(Boolean);
  const isIntro = el => /\b(fm-back|fm-panel-head|fm-panel-help|fm-hero|fm-off-note)\b/.test(el.className || '');
  return h('aside', { class: `fm-inspector card fm-inspector-${currentView()}`, id: 'fmInspector', 'aria-label': 'Edit' },
    h('div', { class: 'fm-insp-intro' }, ...parts.filter(isIntro)),
    h('div', { class: 'fm-insp-body' }, ...parts.filter(el => !isIntro(el))));
}

// --- page --------------------------------------------------------------------

// Title, profile tools and status share one row (they wrap on narrow screens)
function profileBar() {
  const o = page.overview;
  // Same columns as the chart and edit panel below, so Apply to section ends where the chart box ends
  return h('header', { class: `fm-profile-bar fm-profile-bar-${currentView()}` },
    h('div', { class: 'fm-bar-main' },
      h('h1', { class: 'page-title fm-title' }, 'Flow Matrix'),
      h('label', { class: 'fm-profile-pick' }, h('span', { class: 'form-label' }, 'Profile'),
        h('select', { class: 'ui-select', onchange: e => pickFromDropdown(e.target.value) },
          h('optgroup', { label: 'Your profiles' },
            ...o.profiles.map(p => h('option', { value: `profile:${p.name}`, selected: p.name === page.name }, p.name + (p.name === o.default ? ' (default)' : '')))),
          h('optgroup', { label: 'New from preset' },
            ...o.presets.map(p => h('option', { value: `preset:${p.id}`, title: p.summary }, p.name))))),
      h('div', { class: 'fm-profile-actions' },
        h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: newProfile }, '+ New'),
        h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: renameProfile }, 'Rename'),
        h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: resetProfile, title: 'Back to the preset it started from' }, 'Reset'),
        h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-quiet', onclick: deleteProfile, disabled: o.profiles.length <= 1 }, 'Delete')),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-primary fm-apply', onclick: applyToSection, title: 'Choose a controller section that plays this profile' }, 'Apply to section')),
    h('div', { class: 'fm-top-end' }, statusLine()));
}

function statusLine() {
  const notes = statusNotes();
  // Nothing to say when all is well
  if (!notes.length) return null;
  return h('ul', { class: 'fm-status', 'aria-label': 'Status' }, ...notes.map(n => h('li', { class: `fm-note fm-note-${n.tone}` },
    n.select
      ? h('button', { type: 'button', class: 'fm-note-btn', onclick: () => select(n.select) }, n.text)
      : h('span', {}, n.text),
    n.link && h('a', { class: 'card-link', href: n.link[1], 'data-link': true }, n.link[0]),
    n.action && h('button', { type: 'button', class: 'ui-btn-link', onclick: n.action[1] }, n.action[0]))));
}

function renderSavebar() {
  const bar = document.getElementById('fmSavebar');
  if (bar) bar.hidden = !isDirty();
}

function render() {
  const root = page.root;
  if (!root) return;
  if (!page.overview || !page.draft) {
    root.replaceChildren(h('p', { class: 'detail-empty' }, page.loading ? 'Loading…' : 'The flow could not be loaded.'));
    return;
  }
  const scroll = document.getElementById('fmInspector')?.scrollTop || 0;
  root.replaceChildren(
    profileBar(),
    h('div', { class: `fm-layout fm-layout-${currentView()}` }, h('div', { class: 'fm-chart-card card' }, chart()), inspector()),
    h('div', { class: 'savebar', id: 'fmSavebar', hidden: !isDirty() },
      h('span', { class: 'savebar-note' }, 'Unsaved changes'),
      h('button', { type: 'button', class: 'ui-btn', onclick: discard }, 'Discard'),
      h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: save }, 'Save')));
  const insp = document.getElementById('fmInspector');
  if (insp) insp.scrollTop = scroll;
}

// --- live follow -------------------------------------------------------------

let hitTimer = null;

function onTelemetry(msg) {
  if (msg.type !== 'game_flow_state' || !page.root) return;
  page.live = msg.ended ? null : { step: msg.phase, player: msg.colour ?? msg.player };
  if (msg.hit) {
    page.liveHit = msg.hit;
    clearTimeout(hitTimer);
    hitTimer = setTimeout(() => { page.liveHit = null; updateLive(); }, 900);
  }
  updateLive();
}

// Update live highlights without rebuilding the page (keeps inputs and focus)
function updateLive() {
  const root = page.root;
  if (!root || !root.isConnected) return;
  const liveP = page.live && ['turn', 'takeout'].includes(page.live.step) ? page.live.player : null;
  root.querySelectorAll('.fc-node[data-step]').forEach(el => {
    let on = page.live?.step === el.dataset.step;
    if (on && el.dataset.step === 'turn') on = (el.dataset.node === 'p1') === ((page.live.player || 0) % 2 === 0);
    el.classList.toggle('is-live', on);
  });
  root.querySelectorAll('.fc-pdot').forEach((el, i) => el.classList.toggle('is-live', liveP === i));
  root.querySelectorAll('.fc-chip').forEach(el => el.classList.toggle('is-flash', page.liveHit === el.dataset.hit));
}

export function initFlowMatrix() {
  window.flowPage = { isDirty, save, discard };
  window.addEventListener('resize', () => {
    const wanted = currentView();
    if (page.root?.isConnected && !page.root.querySelector(`.fc-${wanted}`)) render();
  });
  window.renderFlowMatrix = () => {
    page.root = document.getElementById('flowMatrixRoot');
    refresh();
  };
  window.onFlowTelemetry = onTelemetry;
}
