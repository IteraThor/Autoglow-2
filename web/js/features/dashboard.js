// AutoGlow 2 - Dashboard page: what the Local Tournament TVs show (/tournament/live). Presets, the
// scenes and what stays on screen, the look and the event's name and logo. Changes save by themselves
// (/api/dashboard) and every TV follows within a few seconds; the preview shows them at once.
// "On all TVs now" holds one scene on every TV until it is set back to the rotation. The ticker runs
// highlights and the event's own messages along the bottom of the TVs.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { icon } from './studio-core.js';
import { popover, section, segmented } from './studio-parts.js';

const $ = id => document.getElementById(id);
const SAVE_DELAY_MS = 700;
const STATUS_MS = 3000;
const draftChannel = 'BroadcastChannel' in window ? new BroadcastChannel('autoglow-dashboard-draft') : null;

const SCENE_INFO = {
  bracket: ['Bracket', 'Knockout; winners and losers in a double KO'],
  tables: ['Tables', 'Groups, league table or Swiss standings'],
  results: ['Results', 'The latest matches'],
  leaders: ['Leaders', 'Best averages, 180s, wins']
};
const scenesIn = (...ids) => ids.map(id => ({ id, secs: id === 'bracket' || id === 'tables' ? 14 : 10, on: true }));

// thumb: the screen as a little grid (CSS grid-template and its cells; a = a scene, b = boards)
const PRESETS = [
  { id: 'overview', name: 'Overview', note: 'Boards with live scores and up next on the left, one rotating scene on the right.',
    set: { layout: 'overview', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr 1fr 1fr / 42% 1fr', 'b', 'a:1/2/4/3', 'b', 'b'] },
  { id: 'boards', name: 'Live boards', note: 'Each board as one big row with both scores. Up next, the scenes and leaders below.',
    set: { layout: 'boards', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr 1fr 2fr / 1fr 2fr 1fr', 'b:1/1/2/4', 'b:2/1/3/4', '', 'a', ''] },
  { id: 'wall', name: 'Bracket wall', note: 'The bracket or table fills the screen; the boards run in a strip below.',
    set: { layout: 'wall', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr 24% / 1fr 1fr 1fr', 'a:1/1/2/4', 'b', 'b', 'b'] },
  { id: 'standings', name: 'Standings', note: 'Tables and standings first, then results and leaders; boards in a strip below.',
    set: { layout: 'wall', boards: true, upnext: true, scenes: scenesIn('tables', 'results', 'leaders', 'bracket') },
    thumb: ['1fr 1fr 24% / 1fr 1fr', 'a', 'a', 'a', 'a', 'b:3/1/4/3'] },
  { id: 'minimal', name: 'Minimal', note: 'One thing at a time at full size: the boards, then each scene. For small or far-away TVs.',
    set: { layout: 'single', boards: true, upnext: true, scenes: scenesIn('bracket', 'tables', 'results', 'leaders') },
    thumb: ['1fr / 1fr', 'a'] }
];
const LAYOUTS = [{ value: 'overview', label: 'Overview' }, { value: 'boards', label: 'Board rows' }, { value: 'wall', label: 'Wall' }, { value: 'single', label: 'One at a time' }];
// Swatches of the TV looks (web/studio/tournament*.css)
const LOOKS = [
  { id: 'studio', name: 'Same as Studio', bg: '#1b2330', a: '#004cff', row: '#2a3546' },
  { id: 'arena', name: 'Arena', bg: '#060a14', a: '#2f7bff', row: '#1a2440' },
  { id: 'flap', name: 'Flap board', bg: '#09090a', a: '#ffb000', row: '#2c2c31' },
  { id: 'poster', name: 'Poster', bg: '#efeae0', a: '#ff4a1c', row: '#14110f' },
  { id: 'mono', name: 'Mono', bg: '#000000', a: '#ffffff', row: '#3a3a3a' },
  { id: 'gazette', name: 'Gazette', bg: '#f4efe4', a: '#c41e1e', row: '#1a1814' },
  { id: 'blueprint', name: 'Blueprint', bg: '#12449a', a: '#ffd23f', row: '#eaf2ff' },
  { id: 'pop', name: 'Pop', bg: '#ffd60a', a: '#2f5bff', row: '#141414' },
  { id: 'worldcup', name: 'World Cup', bg: '#1a0b3d', a: '#f7c948', row: '#ff4fa3' }
];
const ACCENTS = ['#2f7bff', '#14b8a6', '#ff3b47', '#ffb000', '#a855f7', '#22c55e', '#ec4899'];
const TICKER_ITEMS = [
  ['t180', '180s', 'How many so far and who threw them'],
  ['averages', 'Averages', 'The best match average and the tournament averages'],
  ['results', 'Latest results', 'The last four matches'],
  ['upsets', 'Upsets and deciders', 'A low seed beating a high one; matches that went to the last leg'],
  ['next', 'Up next', 'The next three matches']
];
const SPEEDS = [{ value: 'slow', label: 'Slow' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }];
const TEXT_SIZES = [{ value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }];
const HOLDS = [{ value: '', label: 'Rotation' }, { value: 'boards', label: 'Boards' }, { value: 'bracket', label: 'Bracket' }, { value: 'tables', label: 'Tables' }, { value: 'results', label: 'Results' }, { value: 'leaders', label: 'Leaders' }];

let S = null;               // the settings, as the server has them plus edits on their way
let pending = {};
let saveTimer = null;
let page = null;
let statusTimer = null;
let tab = 'presets';
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

// layoutChange: a change that leaves the chosen preset
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

// --- Small parts -----------------------------------------------------------------------------------
function toggle(label, key, note = '', layoutChange = false) {
  const sw = h('input', { type: 'checkbox', class: 'stu-switch', checked: S[key] !== false });
  sw.addEventListener('change', () => change({ [key]: sw.checked }, layoutChange));
  return h('label', { class: 'dsh-row' }, h('span', { class: 'dsh-name' }, label, note ? h('small', {}, note) : null), sw);
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
      if (demo) chips = [['Demo tournament in the preview', true], [t ? 'A real tournament is on this PC' : 'No real tournament on this PC', !!t]];
      else if (!t) chips = [['No tournament on this PC', false]];
      else {
        const boards = (t.boards || []).filter(b => b.approved && !b.left).length;
        const ms = (t.matches || []).filter(m => !m.sides?.some(s => s.bye) && m.state !== 'skipped');
        const done = ms.filter(m => m.state === 'done').length;
        const live = ms.filter(m => m.state === 'live').length;
        chips = [
          [t.status === 'lobby' ? 'Lobby open' : t.status === 'finished' ? 'Tournament finished' : 'Tournament running', true],
          [`${boards} board${boards === 1 ? '' : 's'}`, boards > 0],
          [t.status === 'lobby' ? `${(t.players || []).length} players` : `${done} of ${ms.length} played${live ? ` · ${live} live` : ''}`, true]
        ];
        if (body.role === 'board') chips.push(['This PC is a board; the host has all scores', true]);
      }
    } catch (err) {
      chips = [['AutoGlow not reachable', false]];
    }
    const key = JSON.stringify(chips);
    if (root.dataset.key === key) return;
    root.dataset.key = key;
    root.replaceChildren(...chips.map(([label, ok]) => h('span', { class: 'stu-dot', 'data-state': ok ? 'ok' : 'wait' }, h('i'), label)));
  };
  return root;
}

function tvButton() {
  const btn = h('button', { type: 'button', class: 'stu-btn', title: 'The address to open on the TVs' }, icon('tv', 16), 'TV');
  btn.addEventListener('click', () => {
    const url = S.tv_url || `${location.origin}/tournament/live`;
    const copy = h('button', { type: 'button', class: 'stu-btn stu-iconbtn', title: 'Copy', 'aria-label': 'Copy the address' }, icon('copy', 16));
    copy.addEventListener('click', () => navigator.clipboard?.writeText(url).then(() => toast.success('Address copied.'), () => toast.info(url)));
    popover(btn, h('div', { class: 'stu-tv' },
      h('span', { class: 'stu-h' }, 'Open this on every TV'),
      h('div', { class: 'stu-tv-url' }, h('code', {}, url), copy),
      h('div', { class: 'stu-row' }, h('a', { class: 'stu-btn', href: '/tournament/live', target: '_blank', rel: 'noopener' }, icon('external', 14), 'Open here')),
      h('small', { class: 'stu-hint' }, 'Fills 1080p and 4K screens; double-click it for fullscreen. Every TV follows this page a few seconds after a change.')));
  });
  return btn;
}

// --- Tabs -------------------------------------------------------------------------------------------
function presetsTab() {
  const cards = PRESETS.map(p => {
    const b = h('button', { type: 'button', class: `dsh-preset${S.preset === p.id ? ' is-on' : ''}` }, thumb(p.thumb), h('b', {}, p.name), h('small', {}, p.note));
    b.addEventListener('click', () => change({ preset: p.id, ...structuredClone(p.set) }));
    return b;
  });
  if (S.preset === 'custom') {
    cards.push(h('div', { class: 'dsh-preset is-on is-custom' }, thumb(['1fr 1fr / 1fr 1fr 1fr', '', '', '', '', '', '']), h('b', {}, 'Custom'),
      h('small', {}, 'Your own mix from Content. Pick a preset to start again from it.')));
  }
  return [head('Presets', 'A ready-made setup for every TV. Fine-tune it under Content and Look.'), h('div', { class: 'dsh-presets' }, ...cards)];
}

function contentTab() {
  const rows = S.scenes.map((sc, i) => {
    const [name, note] = SCENE_INFO[sc.id];
    const move = d => {
      const list = S.scenes.slice();
      [list[i], list[i + d]] = [list[i + d], list[i]];
      change({ scenes: list }, true);
    };
    const up = h('button', { type: 'button', class: 'stu-btn stu-iconbtn dsh-move', title: 'Earlier', 'aria-label': `${name} earlier`, disabled: i === 0 }, '↑');
    const down = h('button', { type: 'button', class: 'stu-btn stu-iconbtn dsh-move', title: 'Later', 'aria-label': `${name} later`, disabled: i === S.scenes.length - 1 }, '↓');
    up.addEventListener('click', () => move(-1));
    down.addEventListener('click', () => move(1));
    const secs = h('input', { type: 'number', class: 'stu-input dsh-secs', min: 4, max: 60, value: sc.secs, 'aria-label': `${name} seconds` });
    secs.addEventListener('change', () => {
      const v = Math.max(4, Math.min(60, Math.round(Number(secs.value) || sc.secs)));
      change({ scenes: S.scenes.map((x, j) => (j === i ? { ...x, secs: v } : x)) }, true);
    });
    const sw = h('input', { type: 'checkbox', class: 'stu-switch', checked: sc.on !== false, 'aria-label': `Show ${name}` });
    sw.addEventListener('change', () => change({ scenes: S.scenes.map((x, j) => (j === i ? { ...x, on: sw.checked } : x)) }, true));
    return h('div', { class: `dsh-row${sc.on === false ? ' is-off' : ''}` }, h('span', { class: 'dsh-moves' }, up, down),
      h('span', { class: 'dsh-name' }, name, h('small', {}, note)), h('label', { class: 'dsh-num' }, secs, h('small', {}, 's')), sw);
  });
  return [head('Content', 'What the TVs show and for how long.'),
    section('Layout', segmented(LAYOUTS, S.layout, v => change({ layout: v }, true), 'Layout')),
    section('Scenes in the rotation', ...rows, h('p', { class: 'stu-hint' }, 'A scene the tournament does not have is skipped, like tables in a knockout.')),
    section('Always on screen',
      toggle('Boards with live scores', 'boards', '', true),
      toggle('Up next', 'upnext', '', true),
      toggle('Clock', 'clock'),
      toggle('Player photos', 'photos', 'From the club players; initials when a player has none'))];
}

function lookTab() {
  const looks = LOOKS.map(l => {
    const b = h('button', { type: 'button', class: `stu-look${S.theme === l.id ? ' is-on' : ''}` },
      h('span', { class: 'dsh-sw', style: `background:${l.bg}` }, h('i', { style: `background:${l.id === 'studio' || !S.accent ? l.a : S.accent}` }), h('i', { style: `background:${l.row}` })), l.name);
    b.addEventListener('click', () => change({ theme: l.id }));
    return b;
  });
  const studio = S.theme === 'studio';
  const own = h('input', { type: 'color', value: S.accent || '#2f7bff', 'aria-label': 'Own colour' });
  own.addEventListener('change', () => change({ accent: own.value }));
  const accents = h('div', { class: `stu-accents${studio ? ' is-off' : ''}` },
    h('button', { type: 'button', class: `stu-btn stu-chip${S.accent ? '' : ' is-on'}`, 'aria-pressed': String(!S.accent) }, 'The look\'s own'),
    ...ACCENTS.map(c => h('button', { type: 'button', class: `stu-accent${S.accent === c ? ' is-on' : ''}`, style: `background:${c}`, 'aria-label': `Accent ${c}`, 'data-c': c })),
    h('label', { class: `stu-accent stu-accent-custom${S.accent && !ACCENTS.includes(S.accent) ? ' is-on' : ''}`, title: 'Own colour' }, own));
  accents.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) change({ accent: b.dataset.c || '' });
  });
  const safe = h('input', { type: 'range', min: 0, max: 5, step: 1, value: S.safe, class: 'dsh-range', 'aria-label': 'Safe-area margin' });
  const safeVal = h('span', { class: 'dsh-val' }, `${S.safe} %`);
  safe.addEventListener('input', () => { safeVal.textContent = `${safe.value} %`; });
  safe.addEventListener('change', () => change({ safe: Number(safe.value) }));
  return [head('Look', 'Colours and type of the dashboard.'),
    section('Theme', h('div', { class: 'stu-looks dsh-looks' }, ...looks),
      studio ? h('p', { class: 'stu-hint' }, 'Follows the look and accent colour chosen in Studio › Look.') : null),
    section('Accent colour', accents),
    section('Screen',
      h('div', { class: 'dsh-row' }, h('span', { class: 'dsh-name' }, 'Text size', h('small', {}, 'Large: everything 15 % bigger, the bracket and tables in more pages')),
        segmented(TEXT_SIZES, S.text || 'normal', v => change({ text: v }), 'Text size')),
      toggle('Calm animations', 'calm', 'Nothing blinks or drifts; scenes fade instead of sliding'),
      h('div', { class: 'dsh-row' }, h('span', { class: 'dsh-name' }, 'Safe-area margin', h('small', {}, 'For TVs that cut off the edges')), safe, safeVal))];
}

function tickerTab() {
  const items = { ...(S.ticker_items || {}) };
  const rows = TICKER_ITEMS.map(([key, name, note]) => {
    const sw = h('input', { type: 'checkbox', class: 'stu-switch', checked: items[key] !== false });
    sw.addEventListener('change', () => change({ ticker_items: { ...S.ticker_items, [key]: sw.checked } }));
    return h('label', { class: 'dsh-row' }, h('span', { class: 'dsh-name' }, name, h('small', {}, note)), sw);
  });
  const text = h('textarea', { class: 'stu-input dsh-text', rows: 3, maxlength: 300, placeholder: 'Bar open until 2 am\nNext Friday: doubles night' }, S.ticker_text || '');
  text.addEventListener('input', () => change({ ticker_text: text.value }));
  const off = S.ticker === false;
  return [head('Ticker', 'Highlights running along the bottom of every TV. New ones come in when the line has gone round.'),
    toggle('Show the ticker', 'ticker'),
    h('div', { class: `dsh-group${off ? ' is-off' : ''}` },
      section('Speed', segmented(SPEEDS, S.ticker_speed || 'normal', v => change({ ticker_speed: v }), 'Ticker speed')),
      section('Highlights', ...rows, h('p', { class: 'stu-hint' }, 'From the match stats Autodarts sends; a highlight shows once there is something to tell.')),
      section('Own messages', h('label', { class: 'dsh-field' }, h('span', {}, 'One message per line, shown between the highlights'), text)))];
}

function eventTab() {
  const field = (label, key, placeholder, max) => {
    const input = h('input', { type: 'text', class: 'stu-input', value: S[key] || '', placeholder, maxlength: max });
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
    } catch (err) {
      toast.error(err.message);
    }
  };
  file.addEventListener('change', () => upload(file.files[0]));
  const drop = h('div', { class: 'dsh-logo', tabindex: 0, role: 'button', 'aria-label': 'Choose a logo' },
    S.logo ? h('img', { src: `/api/dashboard/logo/${encodeURIComponent(S.logo)}`, alt: '' }) : h('span', { class: 'dsh-logo-empty' }, icon('camera', 22)),
    h('span', {}, S.logo ? 'Drop or choose another picture to change it.' : 'Drop a picture here or choose a file. PNG, JPEG or WebP; a see-through PNG looks best.'),
    file);
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('is-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('is-over'); upload(e.dataTransfer.files[0]); });
  const remove = h('button', { type: 'button', class: 'stu-btn' }, icon('trash', 14), 'Remove logo');
  remove.addEventListener('click', () => change({ logo: '' }));
  return [head('Event', 'The name on the screens. Empty fields use the tournament\'s own name and rules.'),
    field('Title', 'title', 'The tournament\'s name', 60),
    field('Subtitle', 'subtitle', 'e.g. Club championship 2026', 80),
    section('Logo', drop, S.logo ? h('div', { class: 'stu-row' }, remove) : null,
      h('p', { class: 'stu-hint' }, 'Shown in the header and on the lobby screen.'))];
}

const head = (title, note) => h('div', { class: 'stu-title' }, h('div', {}, h('h2', {}, title), h('small', {}, note)));
const TABS = [['presets', 'Presets', presetsTab], ['content', 'Content', contentTab], ['look', 'Look', lookTab], ['ticker', 'Ticker', tickerTab], ['event', 'Event', eventTab]];

// --- The page ------------------------------------------------------------------------------------
function build(host) {
  const panel = h('div', { class: 'stu-panel dsh-panel' });
  const frame = h('iframe', { src: 'about:blank', title: 'Dashboard preview', tabindex: '-1' });
  const dots = statusChips();
  const tabs = h('div', { class: 'dsh-tabs', role: 'tablist' }, ...TABS.map(([id, label]) => {
    const b = h('button', { type: 'button', role: 'tab', 'data-id': id }, label);
    b.addEventListener('click', () => { tab = id; refresh(true); });
    return b;
  }));
  const holdNote = h('p', { class: 'stu-hint' });
  const holdSeg = segmented(HOLDS, S.hold?.scene || '', async v => {
    draftChannel?.postMessage({ type: 'hold', scene: v });
    try {
      S.hold = (await api('/api/dashboard/hold', { body: { scene: v } })).hold;
      toast.success(v ? 'Every TV shows this now.' : 'The TVs run their rotation again.');
    } catch (err) {
      toast.error(err.message);
    }
    note();
  }, 'On all TVs now');
  const note = () => {
    holdNote.textContent = S.hold?.scene
      ? 'Every TV holds this scene until you set it back to Rotation.'
      : 'The TVs run by themselves. Pick a scene to hold it on every TV right away.';
  };
  note();

  const demoSwitch = h('input', { type: 'checkbox', class: 'stu-switch', 'aria-label': 'Demo tournament' });
  demoSwitch.addEventListener('change', () => setDemo(demoSwitch.checked ? demo || { format: 'single_ko', state: 'running' } : null));
  const demoOptions = h('div', { class: 'dsh-demo-opts' });
  const demoBox = h('div', { class: 'dsh-demo' },
    h('label', { class: 'dsh-row' }, h('span', { class: 'dsh-name' }, 'Demo tournament', h('small', {}, 'Shows a made-up tournament in the preview. The TVs are not affected.')), demoSwitch),
    demoOptions);
  const demoRefresh = () => {
    demoSwitch.checked = !!demo;
    demoOptions.hidden = !demo;
    demoOptions.replaceChildren(...(demo ? [
      segmented(DEMO_FORMATS, demo.format, v => setDemo({ ...demo, format: v }), 'Demo format'),
      segmented(DEMO_STATES, demo.state, v => setDemo({ ...demo, state: v }), 'Demo state')] : []));
  };
  demoRefresh();

  // fresh: a new tab (animated in); otherwise the tab is rebuilt quietly after a change
  const refresh = (fresh = false) => {
    tabs.querySelectorAll('button').forEach(b => { const on = b.dataset.id === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
    const focused = document.activeElement;
    const typing = panel.contains(focused) && focused.matches('input[type=text], input[type=number], textarea');
    if (typing && !fresh) return;    // keep the field being typed in
    panel.classList.toggle('is-quiet', !fresh);
    panel.replaceChildren(...TABS.find(t => t[0] === tab)[2]().filter(Boolean));
  };

  host.replaceChildren(
    h('div', { class: 'stu-top' }, dots, h('span', { class: 'stu-spacer' }), saveMark(), tvButton()),
    tabs,
    h('div', { class: 'stu-body' },
      h('div', { class: 'stu-left' },
        h('div', { class: 'stu-screen' }, frame),
        demoBox,
        h('div', { class: 'dsh-now' }, h('span', { class: 'stu-h' }, 'On all TVs now'), holdSeg),
        holdNote,
        h('p', { class: 'stu-hint' }, 'The preview is the real TV page with this PC\'s tournament, or the demo when it is on.')),
      panel));
  return { frame, dots, refresh, demoRefresh };
}

async function renderDashboard() {
  const host = $('dashboardPage');
  try {
    const fresh = await api('/api/dashboard');
    if (S) Object.assign(S, fresh, pending); else S = fresh;
    page ||= build(host);
    page.frame.setAttribute('src', previewSrc());
    page.refresh(true);
    page.dots.refresh();
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
