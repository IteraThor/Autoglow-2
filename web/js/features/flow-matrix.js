// AutoGlow 2 - Flow Matrix page (/lighting/flow)
// A simple chart of how the light strips follow a match. Clicking any part opens one panel with
// everything needed to change it. A status line says what is off or missing. Edits are a draft until saved.

import { api } from '../core/api.js';
import { choiceDialog, confirmDialog, promptDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { blendFlow, compositeHit, renderFlowFrame } from './flow-looks.js';

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
  preview: { open: false, running: false, players: 2, bullOff: true, legs: 1 },
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

function hitFrame(id) {
  return (t, n) => {
    const hit = resolved(page.draft.hits[id]);
    const base = renderFlowFrame(stepLook('turn'), t, n);
    const cycle = (Number(hit.duration) || 1) + 0.8;
    const u = t % cycle;
    return compositeHit(base, hit, u, n);
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

async function switchProfile(name) {
  if (name === page.name) return;
  if (!(await guardUnsaved())) { render(); return; }
  await openProfile(name);
  render();
}

async function newProfile() {
  if (!(await guardUnsaved())) return;
  const choices = page.overview.presets.map(p => ({ value: p.id, label: p.name }));
  choices.push({ value: '__copy', label: `Copy of '${page.name}'` });
  const pick = await choiceDialog({
    title: 'New flow profile',
    body: h('div', { class: 'fm-preset-list' },
      h('p', {}, 'Start from a preset (from calm to loud) and change anything afterwards.'),
      ...page.overview.presets.map(p => h('p', { class: 'fm-preset-line' }, h('strong', {}, p.name), ` · ${p.summary}`))),
    choices
  });
  if (!pick) return;
  const base = pick === '__copy' ? `${page.name} copy` : page.overview.presets.find(p => p.id === pick).name;
  const name = await promptDialog({
    title: 'Name the profile', value: uniqueName(base), confirmLabel: 'Create', maxLength: 40,
    validate: v => (!v.trim() ? 'Give it a name.' : page.overview.profiles.some(p => p.name === v.trim()) ? 'That name is taken.' : null)
  });
  if (!name) return;
  try {
    const body = pick === '__copy' ? { name: name.trim(), copy_from: page.name } : { name: name.trim(), preset: pick };
    const data = await api.post('/api/flow/profile/create', body);
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

async function startPreview() {
  const p = page.preview;
  try {
    const data = await api.post('/api/flow/preview', { flow: page.draft, players: p.players, bull_off: p.bullOff, legs: p.legs });
    p.running = true;
    p.open = false;
    toast.info(`Preview running (about ${data.seconds} s)`);
    render();
  } catch (err) {
    toast.error(err);
  }
}

async function stopPreview() {
  try { await api.post('/api/flow/preview/stop', {}); } catch (err) { toast.error(err); }
  page.preview.running = false;
  page.live = null;
  render();
}

// --- status line -------------------------------------------------------------

function statusNotes() {
  const notes = [];
  const flow = page.draft;
  const o = page.overview;
  if (!o.lights.length) {
    notes.push({ tone: 'warn', text: 'No controller yet.', link: ['Add one in Setup', '/setup/controllers'] });
  } else if (!lightsUsing(page.name).length) {
    notes.push({ tone: 'warn', text: 'No light strip plays this profile.', link: ['Choose it for a controller in Setup', '/setup/controllers'] });
  }
  if (o.lighting_mode !== 'flow') {
    notes.push({ tone: 'warn', text: 'Games use the Event Matrix right now.', action: ['Use the Flow Matrix', () => window.switchLightingMode('flow')] });
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

function select(sel) {
  page.selected = sel;
  render();
  document.getElementById('fmInspector')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function isSelected(kind, id) {
  return page.selected?.kind === kind && (id === undefined || page.selected.id === id);
}

function node(id) {
  const meta = stepMeta(id);
  const step = page.draft.steps[id];
  const on = step.effect.enabled;
  const effectName = effectMeta(step.effect.animation)?.label || 'Solid';
  const timing = meta.timed ? seconds(step.effect.duration) : (id === 'bull_off' ? 'until the game starts' : id === 'takeout' ? 'until the next turn' : 'stays');
  const live = page.live?.step === id;
  return h('button', {
    type: 'button',
    class: `fm-node${on ? '' : ' is-off'}${isSelected('step', id) ? ' is-selected' : ''}${live ? ' is-live' : ''}`,
    'data-step': id,
    'aria-pressed': isSelected('step', id) ? 'true' : 'false',
    onclick: () => select({ kind: 'step', id })
  },
  h('span', { class: 'fm-node-title' }, meta.label, live && h('span', { class: 'fm-live-dot', title: 'Playing now' })),
  strip(stepFrame(id)),
  h('span', { class: 'fm-node-meta' }, on ? `${effectName} · ${timing}` : 'Off'));
}

function waitingNode(end = false) {
  const live = page.live?.step === 'waiting' && !end && page.preview.running;
  return h('button', {
    type: 'button',
    class: `fm-node fm-node-waiting${isSelected('waiting') ? ' is-selected' : ''}${live ? ' is-live' : ''}`,
    onclick: () => select({ kind: 'waiting' })
  },
  h('span', { class: 'fm-node-title' }, end ? 'Waiting again' : 'Waiting'),
  h('span', { class: 'fm-node-idle', 'aria-hidden': 'true' }),
  h('span', { class: 'fm-node-meta' }, 'Idle lighting from Setup'));
}

function arrow(targetId, { back = false, down = false, label = null } = {}) {
  if (label) {
    return h('div', { class: `fm-arrow fm-arrow-static${down ? ' is-down' : ''}` }, h('span', { class: 'fm-arrow-label' }, label), h('span', { class: 'fm-arrow-line', 'aria-hidden': 'true' }));
  }
  const step = page.draft.steps[targetId];
  const skipped = !step.effect.enabled;
  const tr = step.transition;
  const text = skipped ? 'skipped' : tr.style === 'instant' ? 'Cut' : `${transitionLabel(tr.style)} ${seconds(tr.duration)}`;
  return h('button', {
    type: 'button',
    class: `fm-arrow${back ? ' is-back' : ''}${down ? ' is-down' : ''}${skipped ? ' is-skipped' : ''}${isSelected('transition', targetId) ? ' is-selected' : ''}`,
    title: skipped ? `${stepMeta(targetId).label} is off` : `How ${stepMeta(targetId).label} comes in`,
    disabled: skipped,
    onclick: () => select({ kind: 'transition', id: targetId })
  }, h('span', { class: 'fm-arrow-label' }, text), h('span', { class: 'fm-arrow-line', 'aria-hidden': 'true' }));
}

function playersRow() {
  const players = page.draft.players;
  const liveP = page.live && ['turn', 'takeout'].includes(page.live.step) ? page.live.player : null;
  return h('button', {
    type: 'button', class: `fm-players${isSelected('players') ? ' is-selected' : ''}`, onclick: () => select({ kind: 'players' })
  },
  h('span', { class: 'fm-row-label' }, 'Players'),
  h('span', { class: 'fm-dots' }, ...players.map((p, i) => h('span', {
    class: `fm-dot${liveP === i ? ' is-live' : ''}`, title: p.name ? `${p.name}` : `Player ${i + 1}`
  }, h('span', { class: 'fm-dot-swatch', style: `background:${hex(p.color)}` }), h('span', { class: 'fm-dot-num' }, String(i + 1))))));
}

function hitsRow() {
  return h('div', { class: 'fm-hits' },
    h('span', { class: 'fm-row-label' }, 'On a hit'),
    h('div', { class: 'fm-chips' }, ...page.overview.hits.map(meta => {
      const hit = page.draft.hits[meta.id];
      const flash = page.liveHit === meta.id;
      return h('button', {
        type: 'button',
        class: `fm-chip${hit.enabled ? '' : ' is-off'}${isSelected('hit', meta.id) ? ' is-selected' : ''}${flash ? ' is-flash' : ''}`,
        title: hit.enabled ? `${meta.label}: ${effectMeta(hit.animation)?.label}` : `${meta.label}: off`,
        onclick: () => select({ kind: 'hit', id: meta.id })
      }, hit.enabled && h('span', { class: 'fm-chip-swatch', style: `background:${hex(resolved(hit).color_primary)}` }), meta.label);
    })));
}

function chart() {
  return h('div', { class: 'fm-chart', role: 'group', 'aria-label': 'Game flow' },
    h('div', { class: 'fm-stage' },
      h('span', { class: 'fm-stage-label' }, 'Before the match'),
      h('div', { class: 'fm-lane' },
        waitingNode(),
        arrow('bull_off'),
        node('bull_off'),
        arrow('game_start'),
        node('game_start'))),
    arrow('turn', { down: true }),
    h('div', { class: 'fm-match' },
      h('div', { class: 'fm-match-title' }, 'The match · repeats for every turn'),
      h('div', { class: 'fm-loop' },
        node('turn'),
        h('div', { class: 'fm-loop-arrows' }, arrow('takeout'), arrow('turn', { back: true })),
        node('takeout')),
      playersRow(),
      hitsRow(),
      h('div', { class: 'fm-leg' },
        h('span', { class: 'fm-leg-caption' }, 'After the last dart of a leg'),
        arrow('leg_won'),
        node('leg_won'),
        h('span', { class: 'fm-leg-caption' }, '↺ then the next leg starts'))),
    arrow('match_won', { down: true }),
    h('div', { class: 'fm-stage' },
      h('span', { class: 'fm-stage-label' }, 'After the last leg'),
      h('div', { class: 'fm-lane' },
        node('match_won'),
        arrow(null, { label: page.overview.match_end_to_waiting ? 'then' : 'winner\'s colour stays' }),
        waitingNode(true))));
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

function effectPicker(effect, setEffect, forcePlayer) {
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
  const parts = [effectPicker(effect, setEffect, forcePlayer)];

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
      h('h2', { class: 'fm-panel-title' }, meta.label),
      !meta.always_on && onOff(step.effect.enabled, v => setEffect(e => { e.enabled = v; }), `${meta.label} on or off`)),
    h('p', { class: 'fm-panel-help' }, STEP_HELP[id]),
    !step.effect.enabled && h('p', { class: 'fm-off-note' }, `Off: ${OFF_TEXT[id]}.`),
    h('div', { class: step.effect.enabled ? '' : 'fm-dim' },
      section('Look', ...lookEditor(step.effect, {
        setEffect, timed: meta.timed, forcePlayer: id === 'turn', playerChoice: PLAYER_STEPS.has(id),
        playerWord: id === 'takeout' ? 'Player colour' : 'Winner\'s colour'
      })),
      section('Comes in with', ...transitionEditor(id)),
      h('div', { class: 'fm-panel-actions' },
        h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => tryOnLights('step', id) }, '▶ Try on my lights'),
        h('label', { class: 'fm-copy' }, h('span', { class: 'visually-hidden' }, 'Copy look from'),
          h('select', { class: 'ui-select', onchange: e => {
            const from = e.target.value;
            if (from) change(d => { d.steps[id].effect = { ...clone(d.steps[from].effect), enabled: d.steps[id].effect.enabled, duration: d.steps[id].effect.duration }; });
          } }, h('option', { value: '' }, 'Copy look from…'), ...others.map(s => h('option', { value: s.id }, s.label))))))];
}

function transitionPanel(id) {
  const meta = stepMeta(id);
  return [
    h('div', { class: 'fm-panel-head' }, h('h2', { class: 'fm-panel-title' }, `How ${meta.label} comes in`)),
    h('p', { class: 'fm-panel-help' }, `Every time ${meta.label.toLowerCase()} starts, the strip changes from what it showed to this look with this transition.`),
    section(null, ...transitionEditor(id)),
    h('div', { class: 'fm-panel-actions' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => tryOnLights('step', id) }, '▶ Try on my lights'),
      h('button', { type: 'button', class: 'ui-btn', onclick: () => select({ kind: 'step', id }) }, `Edit ${meta.label}`))
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
        h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => tryOnLights('hit', id) }, '▶ Try on my lights'),
        h('div', { class: 'fm-hit-preview' }, strip(hitFrame(id)))))
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

function waitingPanel() {
  const first = page.overview.lights[0];
  return [
    h('div', { class: 'fm-panel-head' }, h('h2', { class: 'fm-panel-title' }, 'Waiting')),
    h('p', { class: 'fm-panel-help' }, 'Outside a match the strips show each controller\'s idle lighting. It is set per controller in Setup, so it is the same in every profile. Switching to it happens without a transition.'),
    h('p', {}, first
      ? h('a', { class: 'card-link', href: `/setup/controllers/${encodeURIComponent(first.ip)}`, 'data-link': true }, 'Change the idle lighting in Setup')
      : h('a', { class: 'card-link', href: '/setup/controllers', 'data-link': true }, 'Add a controller in Setup')),
    h('p', { class: 'form-hint' }, 'Inactivity and auto-off timers are in Settings.')
  ];
}

function locatorCheck() {
  const rings = allSegments().filter(s => s.role !== 'ambient');
  if (!rings.length) return h('p', { class: 'form-hint' }, 'Add a controller to check the hit locator.');
  return h('div', { class: 'fm-locator' },
    h('p', { class: 'form-hint' }, 'Check it once: "Show 20" should light the top of the board, "Show 6" the right side. If 6 lights up on the left, switch the direction.'),
    ...rings.map(seg => h('div', { class: 'fm-locator-row' },
      h('span', { class: 'fm-locator-name' }, `${seg.controller} · ${seg.name}`),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => tryOnLights('locator', 'turn', { number: 20, ip: seg.ip, segment_id: seg.id }) }, 'Show 20'),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: () => tryOnLights('locator', 'turn', { number: 6, ip: seg.ip, segment_id: seg.id }) }, 'Show 6'),
      seg.id !== null && segmented([true, false], seg.clockwise !== false, async v => {
        try {
          await api.post('/api/flow/segment-direction', { ip: seg.ip, segment_id: seg.id, clockwise: v });
          await loadOverview();
          render();
        } catch (err) { toast.error(err); }
      }, { true: 'Clockwise', false: 'Anticlockwise' }))));
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
    section('Used by',
      users.length
        ? h('ul', { class: 'fm-users' }, ...users.map(u => h('li', {}, `${u.controller} · ${u.segment_name}`)))
        : h('p', { class: 'form-hint' }, 'No light strip uses this profile.'),
      h('a', { class: 'card-link', href: '/setup/controllers', 'data-link': true }, 'Choose profiles per light in Setup'),
      page.overview.default !== page.name
        ? h('p', {}, h('button', { type: 'button', class: 'ui-btn-link', onclick: makeDefault }, 'Use this profile for lights without a choice'))
        : h('p', { class: 'form-hint' }, 'Lights without their own choice use this profile.'))
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
  else body = profilePanel();
  return h('aside', { class: 'fm-inspector card', id: 'fmInspector', 'aria-label': 'Edit' },
    sel.kind !== 'profile' && h('button', { type: 'button', class: 'ui-btn-link fm-back', onclick: () => select({ kind: 'profile' }) }, '← Profile settings'),
    ...body);
}

// --- page --------------------------------------------------------------------

function profileBar() {
  const o = page.overview;
  const users = lightsUsing(page.name);
  const usedText = users.length ? `Used by ${users.map(u => u.segment_name).join(', ')}` : 'Not used by any light';
  return h('div', { class: 'fm-profile-bar' },
    h('label', { class: 'fm-profile-pick' }, h('span', { class: 'form-label' }, 'Profile'),
      h('select', { class: 'ui-select', onchange: e => switchProfile(e.target.value) },
        ...o.profiles.map(p => h('option', { value: p.name, selected: p.name === page.name }, p.name + (p.name === o.default ? ' (default)' : ''))))),
    h('span', { class: 'fm-used' }, usedText),
    h('div', { class: 'fm-profile-actions' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: newProfile }, '+ New'),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: renameProfile }, 'Rename'),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: resetProfile, title: 'Back to the preset it started from' }, 'Reset'),
      h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-quiet', onclick: deleteProfile, disabled: o.profiles.length <= 1 }, 'Delete')),
    h('div', { class: 'fm-preview-wrap' },
      page.preview.running
        ? h('button', { type: 'button', class: 'ui-btn ui-btn-sm', onclick: stopPreview }, '■ Stop preview')
        : h('button', { type: 'button', class: 'ui-btn ui-btn-sm ui-btn-primary', disabled: o.match_running,
          title: o.match_running ? 'Not while a match is running' : 'Play a made-up match on your lights',
          onclick: () => { page.preview.open = !page.preview.open; render(); } }, '▶ Preview a match'),
      page.preview.open && previewPanel()));
}

function previewPanel() {
  const p = page.preview;
  return h('div', { class: 'fm-preview card' },
    h('p', { class: 'fm-panel-help' }, 'Plays a short made-up match on your lights with your current (unsaved) settings.'),
    h('div', { class: 'fm-field' }, h('span', { class: 'form-label' }, 'Players'),
      segmented([1, 2, 3, 4, 5, 6], p.players, v => { p.players = v; render(); })),
    h('div', { class: 'fm-field' }, h('span', { class: 'form-label' }, 'Bull-off'),
      segmented([true, false], p.bullOff, v => { p.bullOff = v; render(); }, { true: 'With', false: 'Without' })),
    h('div', { class: 'fm-field' }, h('span', { class: 'form-label' }, 'Legs'),
      segmented([1, 2, 3], p.legs, v => { p.legs = v; render(); })),
    h('div', { class: 'fm-panel-actions' },
      h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: startPreview }, 'Start'),
      h('button', { type: 'button', class: 'ui-btn', onclick: () => { p.open = false; render(); } }, 'Cancel')));
}

function statusLine() {
  const notes = statusNotes();
  if (!notes.length) return h('p', { class: 'fm-status fm-status-ok' }, '✓ Everything is set up.');
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
    h('header', { class: 'page-head' },
      h('div', {},
        h('h1', { class: 'page-title' }, 'Flow Matrix'),
        h('p', { class: 'page-lead' }, 'How your light strips follow a match. Click any part to change it.'))),
    profileBar(),
    statusLine(),
    h('div', { class: 'fm-layout' }, h('div', { class: 'fm-chart-card card' }, chart()), inspector()),
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
  if (msg.preview && msg.ended) {
    page.preview.running = false;
    page.live = null;
  } else {
    page.live = { step: msg.phase, player: msg.player };
  }
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
  root.querySelectorAll('.fm-node[data-step]').forEach(el => el.classList.toggle('is-live', page.live?.step === el.dataset.step));
  const liveP = page.live && ['turn', 'takeout'].includes(page.live.step) ? page.live.player : null;
  root.querySelectorAll('.fm-dot').forEach((el, i) => el.classList.toggle('is-live', liveP === i));
  const labels = page.overview?.hits.map(hh => hh.id) || [];
  root.querySelectorAll('.fm-chip').forEach((el, i) => el.classList.toggle('is-flash', page.liveHit === labels[i]));
  const stop = root.querySelector('.fm-preview-wrap');
  if (stop && !page.preview.running && stop.textContent.includes('Stop')) render();
}

export function initFlowMatrix() {
  window.flowPage = { isDirty, save, discard };
  window.renderFlowMatrix = () => {
    page.root = document.getElementById('flowMatrixRoot');
    refresh();
  };
  window.onFlowTelemetry = onTelemetry;
}
