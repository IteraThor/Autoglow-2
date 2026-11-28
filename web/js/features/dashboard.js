// AutoGlow 2 - Dashboard page: what the Local Tournament TVs show (/tournament/live). The screen
// (layout, the scenes it rotates, what stays on screen), the look, the ticker and the event's name and
// logo. Pictures instead of notes: hovering a choice shows it in the preview, a click keeps it.
// Changes save by themselves (/api/dashboard) and every TV follows within a few seconds. "On all TVs
// now" holds one scene on every TV until it is set back to the rotation. The event preset at the top
// keeps all of it, with the Studio's look and texts, per event (web/js/features/event-presets.js).

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { icon, loadSettings as loadStudio } from './studio-core.js';
import { lookPicker, popover, section, segmented } from './studio-parts.js';
import { presetBar } from './event-presets.js';

const $ = id => document.getElementById(id);
const SAVE_DELAY_MS = 700;
const STATUS_MS = 3000;
const SAFE_FRAME_MS = 1500;
const SCENE_PEEK_MS = 6000;  // a scene switched on in the rotation shows in the preview this long
const draftChannel = 'BroadcastChannel' in window ? new BroadcastChannel('autoglow-dashboard-draft') : null;

// id: [name, icon, what it shows]
const SCENE_INFO = {
  bracket: ['Bracket', 'bracket', 'Knockout; winners and losers in a double KO'],
  tables: ['Tables', 'table', 'Groups, league table or Swiss standings'],
  results: ['Results', 'list', 'The latest matches'],
  leaders: ['Leaders', 'bars', 'Best averages, 180s, wins']
};
const scenesIn = (...ids) => ids.map(id => ({ id, secs: id === 'bracket' || id === 'tables' ? 14 : 10, on: true }));

// Ready-made screens. thumb: the screen as a little grid (CSS grid-template and its cells; a = a scene, b = boards)
const LAYOUTS = [
  { id: 'overview', name: 'Overview', note: 'Boards with live scores and up next on the left, one rotating scene on the right',
    set: { layout: 'overview', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr 1fr 1fr / 42% 1fr', 'b', 'a:1/2/4/3', 'b', 'b'] },
  { id: 'boards', name: 'Live boards', note: 'Each board as one big row with both scores; up next, the scenes and leaders below',
    set: { layout: 'boards', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr 1fr 2fr / 1fr 2fr 1fr', 'b:1/1/2/4', 'b:2/1/3/4', '', 'a', ''] },
  { id: 'wall', name: 'Bracket wall', note: 'The bracket or table fills the screen; the boards run in a strip below',
    set: { layout: 'wall', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr 24% / 1fr 1fr 1fr', 'a:1/1/2/4', 'b', 'b', 'b'] },
  { id: 'standings', name: 'Standings', note: 'Tables first, then results and leaders; boards in a strip below',
    set: { layout: 'wall', boards: true, upnext: true, scenes: scenesIn('tables', 'results', 'leaders', 'bracket') },
    thumb: ['1fr 1fr 24% / 1fr 1fr', 'a', 'a', 'a', 'a', 'b:3/1/4/3'] },
  { id: 'minimal', name: 'One at a time', note: 'One thing at a time at full size: the boards, then each scene. For small or far-away TVs',
    set: { layout: 'single', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr / 1fr', 'a'] }
];
// key, name, icon, what it tells
const TICKER_ITEMS = [
  ['t180', '180s', 'flame', 'How many so far and who threw them'],
  ['averages', 'Averages', 'gauge', 'The best match average and the tournament averages'],
  ['results', 'Results', 'list', 'The last four matches'],
  ['upsets', 'Upsets', 'zap', 'A low seed beating a high one; matches that went to the last leg'],
  ['next', 'Up next', 'next', 'The next three matches']
];
const SPEEDS = [{ value: 'slow', label: '›', title: 'Slow' }, { value: 'normal', label: '››', title: 'Normal' }, { value: 'fast', label: '›››', title: 'Fast' }];
// "On all TVs now": the rotation or one scene held on every TV
const HOLDS = [
  { value: '', icon: 'refresh', title: 'Rotation: the TVs run by themselves' },
  { value: 'boards', icon: 'target', title: 'Hold the boards on every TV' },
  ...Object.entries(SCENE_INFO).map(([id, [name, ico]]) => ({ value: id, icon: ico, title: `Hold ${name} on every TV` }))
];

let S = null;               // the settings, as the server has them plus edits on their way
let pending = {};
let saveTimer = null;
let page = null;
let statusTimer = null;
let tab = 'screen';
// The demo switch: the preview shows a made-up tournament, so a change can be judged with none running
const DEMO_FORMATS = [{ value: 'single_ko', label: 'Single KO' }, { value: 'double_ko', label: 'Double KO' }, { value: 'groups', label: 'Groups' }, { value: 'league', label: 'League' }, { value: 'swiss', label: 'Swiss' }];
const DEMO_STATES = [{ value: 'running', label: 'Running' }, { value: 'finished', label: 'Finished' }];
const demoKey = 'autoglow-dashboard-demo';
let demo = null;   // { format, state } while the switch is on
try { demo = JSON.parse(localStorage.getItem(demoKey)); } catch (err) { /* off */ }
const previewSrc = () => `/tournament/live?preview=1${demo ? `&demo=${demo.format}:${demo.state}` : ''}`;
function setDemo(next) {
  demo = next;
  try { next ? localStorage.setItem(demoKey, JSON.stringify(next)) : localStorage.removeItem(demoKey); } catch (err) { /* not remembered */ }
  page?.frame.setAttribute('src', previewSrc());
  page?.demoRefresh();
}

// --- Saving -------------------------------------------------------------------------------------
const saveListeners = new Set();
const emit = state => saveListeners.forEach(fn => fn(state));

function draft() {
  draftChannel?.postMessage({ type: 'draft', settings: S });
}

// layoutChange: a change that leaves the chosen ready-made screen
function change(values, layoutChange = false) {
  if (layoutChange) values = { ...values, preset: 'custom' };
  Object.assign(S, values);
  Object.assign(pending, values);
  draft();
  emit('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  page?.refresh();
}

async function flush() {
  clearTimeout(saveTimer);
  if (!Object.keys(pending).length) return;
  const body = pending;
  pending = {};
  emit('saving');
  try {
    const fresh = await api('/api/dashboard', { body });
    Object.assign(S, fresh, pending);
    emit(Object.keys(pending).length ? 'dirty' : 'saved');
  } catch (err) {
    pending = { ...body, ...pending };
    emit('error');
    toast.error(err.message);
  }
}

addEventListener('pagehide', () => {
  if (Object.keys(pending).length) navigator.sendBeacon?.('/api/dashboard', new Blob([JSON.stringify(pending)], { type: 'application/json' }));
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

// --- A scene shown in the preview only, for a moment (null: back to what the TVs hold) ----------------
let peekTimer = null;
function peekScene(scene) {
  clearTimeout(peekTimer);
  draftChannel?.postMessage({ type: 'peek', scene });
  if (scene !== null) peekTimer = setTimeout(() => peekScene(null), SCENE_PEEK_MS);
}

// --- Small parts -----------------------------------------------------------------------------------
// An on/off setting as a picture tile
function tile(label, key, ico, note, layoutChange = false) {
  const on = S[key] !== false;
  const b = h('button', { type: 'button', class: `stu-tile${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: note || label, 'data-fk': `tile-${key}` },
    icon(ico, 22), h('span', {}, label));
  b.addEventListener('click', () => change({ [key]: !on }, layoutChange));
  return b;
}

function thumb(t) {
  const [template, ...cells] = t;
  return h('span', { class: 'dsh-thumb', style: `grid-template:${template}`, 'aria-hidden': 'true' },
    ...cells.map(c => {
      const [kind, area] = c.split(':');
      return h('i', { class: kind ? `is-${kind}` : '', style: area ? `grid-area:${area}` : '' });
    }));
}

// --- The tournament on the TVs, as dots ------------------------------------------------------------
function statusChips() {
  const root = h('div', { class: 'stu-dots dsh-dots', 'aria-live': 'polite' });
  root.refresh = async () => {
    let chips;
    try {
      const body = await api('/api/tournament/local');
      const t = body.tournament;
      if (demo) chips = [['Demo in the preview', true, 'A made-up tournament; the TVs are not affected'], [t ? 'Tournament on this PC' : 'No tournament', !!t]];
      else if (!t) chips = [['No tournament on this PC', false]];
      else {
        const boards = (t.boards || []).filter(b => b.approved && !b.left).length;
        const ms = (t.matches || []).filter(m => !m.sides?.some(s => s.bye) && m.state !== 'skipped');
        const done = ms.filter(m => m.state === 'done').length;
        const live = ms.filter(m => m.state === 'live').length;
        chips = [
          [t.status === 'lobby' ? 'Lobby open' : t.status === 'finished' ? 'Finished' : 'Running', true],
          [`${boards} board${boards === 1 ? '' : 's'}`, boards > 0],
          [t.status === 'lobby' ? `${(t.players || []).length} players` : `${done}/${ms.length} played${live ? ` · ${live} live` : ''}`, true]
        ];
        if (body.role === 'board') chips.push(['Board PC', true, 'This PC is a board; the host has all scores']);
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

function tvButton() {
  const btn = h('button', { type: 'button', class: 'stu-btn', 'data-pop': '', title: 'The address to open on the TVs' }, icon('tv', 16), 'TV');
  btn.addEventListener('click', () => {
    const url = S.tv_url || `${location.origin}/tournament/live`;
    const copy = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Copy', 'aria-label': 'Copy the address' }, icon('copy', 16));
    copy.addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast.success('Address copied.'), () => toast.info(url)));
    popover(btn, h('div', { class: 'stu-tv' },
      h('span', { class: 'stu-h' }, 'Open this on every TV'),
      h('div', { class: 'stu-tv-url' }, h('code', {}, url), copy),
      h('div', { class: 'stu-row' }, h('a', { class: 'stu-btn', href: '/tournament/live', target: '_blank', rel: 'noopener', title: '1080p and 4K; double-click for fullscreen' }, icon('external', 14), 'Open here'))));
  });
  return btn;
}

// --- Tabs -------------------------------------------------------------------------------------------
// The rotation as a strip: each scene as wide as its seconds; a click skips it, or puts it back and
// shows it in the preview
function rotationStrip() {
  const strip = h('div', { class: 'dsh-strip', role: 'list', 'aria-label': 'Scenes in the rotation' });
  S.scenes.forEach((sc, i) => {
    const [name, ico, note] = SCENE_INFO[sc.id];
    const on = sc.on !== false;
    const set = patch => change({ scenes: S.scenes.map((x, j) => (j === i ? { ...x, ...patch } : x)) }, true);
    const move = d => {
      const list = S.scenes.slice();
      [list[i], list[i + d]] = [list[i + d], list[i]];
      change({ scenes: list }, true);
    };
    const main = h('button', { type: 'button', class: 'dsh-block-main', 'aria-pressed': String(on), title: `${note}\n${on ? 'Click to skip it' : 'Click to show it'}`, 'data-fk': `sc-${sc.id}` },
      icon(ico, 20), h('b', {}, name), h('span', { class: 'dsh-block-secs' }, on ? `${sc.secs}s` : 'off'));
    main.addEventListener('click', () => { set({ on: !on }); if (!on) peekScene(sc.id); });
    const btn = (ic, label, fn, disabled) => {
      const b = h('button', { type: 'button', class: 'dsh-block-btn', title: label, 'aria-label': `${name}: ${label}`, disabled, 'data-fk': `sc-${sc.id}-${ic}` }, icon(ic, 14));
      b.addEventListener('click', fn);
      return b;
    };
    const tools = h('span', { class: 'dsh-block-tools' },
      btn('left', 'Earlier', () => move(-1), i === 0),
      on ? btn('minus', 'Shorter', () => set({ secs: Math.max(4, sc.secs - 2) }), sc.secs <= 4) : null,
      on ? btn('plus', 'Longer', () => set({ secs: Math.min(60, sc.secs + 2) }), sc.secs >= 60) : null,
      btn('right', 'Later', () => move(1), i === S.scenes.length - 1));
    strip.append(h('div', { class: `dsh-block${on ? '' : ' is-off'}`, role: 'listitem', style: `flex-grow:${on ? sc.secs : 5}` }, main, tools));
  });
  const total = S.scenes.filter(x => x.on !== false).reduce((a, x) => a + x.secs, 0);
  return h('div', { class: 'dsh-rotation' }, strip,
    h('small', { class: 'dsh-strip-total', title: 'One round of the rotation. A scene the tournament does not have is skipped, like tables in a knockout.' }, icon('refresh', 12), `${total} s`));
}

function screenTab() {
  const cards = LAYOUTS.map(p => {
    const on = S.preset === p.id;
    const b = h('button', { type: 'button', class: `dsh-preset${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: p.note, 'data-fk': `lay-${p.id}` }, thumb(p.thumb), h('b', {}, p.name));
    b.addEventListener('click', () => change({ preset: p.id, ...structuredClone(p.set) }));
    return b;
  });
  if (S.preset === 'custom') {
    cards.push(h('div', { class: 'dsh-preset is-on is-custom', title: 'Your own mix. Pick a picture to start again from it.' },
      thumb(['1fr 1fr / 1fr 1fr 1fr', '', '', '', '', '', '']), h('b', {}, 'Custom')));
  }
  return [
    section('Layout', h('div', { class: 'dsh-presets' }, ...cards)),
    section('Rotation', rotationStrip()),
    section('Always on screen', h('div', { class: 'stu-tiles' },
      tile('Boards', 'boards', 'target', 'Boards with live scores', true),
      tile('Up next', 'upnext', 'next', 'The next matches', true),
      tile('Clock', 'clock', 'clock'),
      tile('Photos', 'photos', 'image', 'Player photos from the club players; initials when a player has none')))
  ];
}

function lookTab() {
  const size = v => {
    const on = (S.text || 'normal') === v;
    const b = h('button', { type: 'button', class: `stu-tile dsh-aa${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: v === 'large' ? 'Everything 15 % bigger; the bracket and tables in more pages' : 'Normal text', 'data-fk': `text-${v}` },
      h('b', { class: v === 'large' ? 'is-large' : '' }, 'Aa'), h('span', {}, v === 'large' ? 'Large' : 'Normal'));
    b.addEventListener('click', () => change({ text: v }));
    return b;
  };
  const safe = h('input', { type: 'range', min: 0, max: 5, step: 1, value: S.safe, class: 'dsh-range', 'aria-label': 'Safe-area margin' });
  const safeVal = h('span', { class: 'dsh-val' }, `${S.safe} %`);
  safe.addEventListener('input', () => { safeVal.textContent = `${safe.value} %`; page.safeFrame(Number(safe.value)); });
  safe.addEventListener('change', () => change({ safe: Number(safe.value) }));
  safe.addEventListener('pointerdown', () => page.safeFrame(Number(safe.value)));
  return [
    // The look the Studio and the Overlay share; the TVs follow the Studio settings
    lookPicker(),
    section('Screen', h('div', { class: 'stu-tiles' }, size('normal'), size('large'),
      tile('Calm', 'calm', 'waves', 'Nothing blinks or drifts; scenes fade instead of sliding')),
    h('label', { class: 'dsh-safe', title: 'A margin for TVs that cut off the edges' }, icon('frame', 18), safe, safeVal))
  ];
}

function tickerTab() {
  const off = S.ticker === false;
  const chips = TICKER_ITEMS.map(([key, name, ico, note]) => {
    const on = S.ticker_items?.[key] !== false;
    const b = h('button', { type: 'button', class: `stu-btn stu-chip dsh-tchip${on ? ' is-on' : ''}`, 'aria-pressed': String(on), title: note, 'data-fk': `tk-${key}` }, icon(ico, 14), name);
    b.addEventListener('click', () => change({ ticker_items: { ...S.ticker_items, [key]: !on } }));
    return b;
  });
  const text = h('textarea', { class: 'stu-input dsh-text', rows: 3, maxlength: 300, placeholder: 'One per line\nBar open until 2 am', 'aria-label': 'Own messages, one per line' }, S.ticker_text || '');
  text.addEventListener('input', () => change({ ticker_text: text.value }));
  return [
    h('div', { class: 'stu-tiles' }, tile('Ticker', 'ticker', 'ticker', 'Highlights running along the bottom of every TV')),
    h('div', { class: `dsh-group${off ? ' is-off' : ''}` },
      section('Speed', segmented(SPEEDS, S.ticker_speed || 'normal', v => change({ ticker_speed: v }), 'Ticker speed')),
      section('Highlights', h('div', { class: 'stu-row' }, ...chips)),
      section('Own messages', text))
  ];
}

function eventTab() {
  const field = (label, key, placeholder, max) => {
    const input = h('input', { type: 'text', class: 'stu-input', value: S[key] || '', placeholder, maxlength: max, 'aria-label': label, 'data-fk': `ev-${key}` });
    input.addEventListener('input', () => change({ [key]: input.value }));
    return h('label', { class: 'dsh-field' }, h('span', {}, label), input);
  };
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  const upload = async f => {
    if (!f) return;
    await flush();
    const form = new FormData();
    form.append('logo', f, f.name);
    try {
      Object.assign(S, await api('/api/dashboard/logo', { body: form, timeout: 30000 }));
      draft();
      page.refresh();
      page.bar.refresh();
    } catch (err) {
      toast.error(err.message);
    }
  };
  file.addEventListener('change', () => upload(file.files[0]));
  const drop = h('div', { class: 'dsh-logo', tabindex: 0, role: 'button', 'aria-label': 'Choose a logo', title: 'PNG, JPEG or WebP; a see-through PNG looks best. Drop it here or click.' },
    S.logo ? h('img', { src: `/api/dashboard/logo/${encodeURIComponent(S.logo)}`, alt: '' }) : h('span', { class: 'dsh-logo-empty' }, icon('image', 22)),
    h('span', {}, S.logo ? 'Change' : 'Drop or choose a logo'),
    file);
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('is-over'); upload(e.dataTransfer.files[0]); });
  const remove = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Remove the logo', 'aria-label': 'Remove the logo' }, icon('trash', 14));
  remove.addEventListener('click', () => { change({ logo: '' }); page.bar.refresh(); });
  return [
    field('Title', 'title', 'The tournament\'s name', 60),
    field('Subtitle', 'subtitle', 'e.g. Club championship 2026', 80),
    section('Logo', h('div', { class: 'dsh-logo-row' }, drop, S.logo ? remove : null))
  ];
}

// id, label, builder, icon, hover note
const TABS = [
  ['screen', 'Screen', screenTab, 'layout', 'Layout, the scenes it rotates, what stays on screen'],
  ['look', 'Look', lookTab, 'palette', 'Colours and text size of the TVs'],
  ['ticker', 'Ticker', tickerTab, 'ticker', 'Highlights along the bottom'],
  ['event', 'Event', eventTab, 'trophy', 'Name and logo']
];

// --- The page ------------------------------------------------------------------------------------
function build(host) {
  const panel = h('div', { class: 'stu-panel dsh-panel' });
  const frame = h('iframe', { src: 'about:blank', title: 'Dashboard preview', tabindex: '-1' });
  const dots = statusChips();
  const bar = presetBar({
    beforeSwitch: flush,
    afterSwitch: async () => { draftChannel?.postMessage({ type: 'clear' }); await renderDashboard(); },
    suggestName: () => S.title || ''
  });
  const tabs = h('div', { class: 'stu-group dsh-rail', role: 'tablist', 'aria-label': 'Dashboard' }, h('span', { class: 'stu-pill' }),
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
    // On a narrow screen the tabs scroll sideways: keep the chosen one in view
    if (tabs.scrollWidth > tabs.clientWidth) tabs.scrollTo({ left: btn.offsetLeft - tabs.clientWidth / 2 + btn.offsetWidth / 2, behavior: 'smooth' });
  };
  new ResizeObserver(placePill).observe(tabs);

  // On all TVs now: the rotation or one held scene, as icons
  const holdSeg = segmented(HOLDS, S.hold?.scene || '', async v => {
    peekScene(null);
    draftChannel?.postMessage({ type: 'hold', scene: v });
    try {
      S.hold = (await api('/api/dashboard/hold', { body: { scene: v } })).hold;
      toast.success(v ? 'Every TV shows this now.' : 'The TVs run their rotation again.');
    } catch (err) {
      toast.error(err.message);
    }
  }, 'On all TVs now');
  holdSeg.classList.add('dsh-holds');

  // The safe-area margin drawn over the preview while it is changed
  const safeEl = h('div', { class: 'dsh-safe-frame', hidden: true });
  let safeTimer = null;
  const safeFrame = pct => {
    safeEl.hidden = false;
    safeEl.style.inset = `${pct}%`;
    clearTimeout(safeTimer);
    safeTimer = setTimeout(() => { safeEl.hidden = true; }, SAFE_FRAME_MS);
  };

  // The demo tournament: a pill on the preview
  const demoBtn = h('button', { type: 'button', class: 'dsh-demo-pill', 'data-pop': '', title: 'A made-up tournament in the preview; the TVs are not affected' });
  const demoRefresh = () => {
    demoBtn.classList.toggle('is-on', !!demo);
    demoBtn.replaceChildren(h('i'), demo ? `Demo · ${DEMO_FORMATS.find(f => f.value === demo.format)?.label || ''}` : 'Demo');
  };
  demoBtn.addEventListener('click', () => {
    const sw = h('input', { type: 'checkbox', class: 'stu-switch', checked: !!demo, 'aria-label': 'Demo tournament' });
    const opts = h('div', { class: 'dsh-demo-opts' });
    const fill = () => opts.replaceChildren(...(demo ? [
      segmented(DEMO_FORMATS, demo.format, v => setDemo({ ...demo, format: v }), 'Demo format'),
      segmented(DEMO_STATES, demo.state, v => setDemo({ ...demo, state: v }), 'Demo state')] : []));
    sw.addEventListener('change', () => { setDemo(sw.checked ? demo || { format: 'single_ko', state: 'running' } : null); fill(); });
    fill();
    popover(demoBtn, h('div', { class: 'dsh-demo' }, h('label', { class: 'stu-switch-row' }, sw, 'Demo tournament in the preview'), opts));
  });
  demoRefresh();

  // fresh: a new tab (animated in); otherwise the tab is rebuilt quietly after a change
  const refresh = (fresh = false) => {
    tabs.querySelectorAll('.stu-stage').forEach(b => { const on = b.dataset.id === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    placePill();
    const focused = document.activeElement;
    const typing = panel.contains(focused) && focused.matches('input[type=text], input[type=number], textarea');
    if (typing && !fresh) return;    // keep the field being typed in
    const fk = panel.contains(focused) ? focused.dataset?.fk : null;
    panel.classList.toggle('is-quiet', !fresh);
    panel.replaceChildren(...TABS.find(t => t[0] === tab)[2]().filter(Boolean));
    // The rebuilt control keeps the keyboard focus
    if (fk) panel.querySelector(`[data-fk="${fk}"]`)?.focus();
  };

  host.replaceChildren(
    h('div', { class: 'stu-top' }, bar, dots, h('span', { class: 'stu-spacer' }), saveMark(), tvButton()),
    tabs,
    h('div', { class: 'stu-body' },
      h('div', { class: 'stu-left' },
        h('div', { class: 'stu-screen' }, frame, safeEl, demoBtn),
        h('div', { class: 'dsh-now' }, h('span', { class: 'stu-h', title: 'Holds one scene on every TV until it is set back to the rotation' }, 'On all TVs now'), holdSeg)),
      panel));
  return { frame, dots, bar, refresh, demoRefresh, safeFrame };
}

async function renderDashboard() {
  const host = $('dashboardPage');
  try {
    const [fresh] = await Promise.all([api('/api/dashboard'), loadStudio()]);
    if (S) Object.assign(S, fresh, pending); else S = fresh;
    page ||= build(host);
    page.frame.setAttribute('src', previewSrc());
    page.refresh(true);
    page.dots.refresh();
    page.bar.refresh();
    clearInterval(statusTimer);
    statusTimer = setInterval(page.dots.refresh, STATUS_MS);
  } catch (err) {
    toast.error(`Could not load the Dashboard: ${err.message}`);
  }
}

function leaveDashboard() {
  if (!page) return;
  clearInterval(statusTimer);
  page.frame.setAttribute('src', 'about:blank');
  flush();
  document.querySelector('.stu-pop')?.remove();
}

export function initDashboard() {
  window.renderDashboard = renderDashboard;
  window.leaveDashboard = leaveDashboard;
}
