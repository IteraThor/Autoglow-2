// AutoGlow 2 - Studio: the building blocks of the Studio steps. Each builder returns an element bound to
// the live settings; edits go through change(), which saves them by itself.

import { api } from '../core/api.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import * as core from './studio-core.js';
import { change, focusText, icon, THEMES, themeSwatch } from './studio-core.js';

const S = () => core.settings;

export const section = (label, ...content) => h('section', { class: 'stu-section' }, h('h3', { class: 'stu-h' }, label), ...content);

// --- Segmented control with a sliding pill ---------------------------------------------------------
export function segmented(options, value, onPick, label = '') {
  const pill = h('span', { class: 'stu-seg-pill' });
  const root = h('div', { class: 'stu-seg', role: 'radiogroup', 'aria-label': label }, pill);
  const buttons = options.map(o => h('button', { type: 'button', role: 'radio', 'data-value': o.value, title: o.title || '' },
    o.icon ? icon(o.icon, 16) : null, o.label ?? null));
  root.append(...buttons);
  const set = v => {
    buttons.forEach(b => { const on = b.dataset.value === String(v); b.classList.toggle('is-on', on); b.setAttribute('aria-checked', String(on)); });
    const b = buttons.find(x => x.classList.contains('is-on'));
    if (b) requestAnimationFrame(() => { pill.style.left = `${b.offsetLeft}px`; pill.style.width = `${b.offsetWidth}px`; });
  };
  buttons.forEach(b => b.addEventListener('click', () => { set(b.dataset.value); onPick(b.dataset.value); }));
  set(value);
  new ResizeObserver(() => set(root.querySelector('.is-on')?.dataset.value)).observe(root);
  return root;
}

// A switch with its label, for one on/off setting
export function switchRow(label, key, onToggle = null) {
  const sw = h('input', { type: 'checkbox', class: 'stu-switch', checked: S()[key] !== false });
  sw.addEventListener('change', () => { change({ [key]: sw.checked }); onToggle?.(sw.checked); });
  return h('label', { class: 'stu-switch-row' }, sw, label);
}

// --- Look: theme swatches and accent colours --------------------------------------------------------
// The same picker on the Studio, Dashboard and Overlay pages (/api/look, src/look.rs). The switch on top:
// the same look on all three (a change here changes the other two), or this page's own. onPick gets
// every page's look after a change, for the page's own preview.
const ACCENTS = ['#1fa34a', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308'];
let lookState = null;   // { sync, studio: {theme, accent}, dashboard: {…}, overlay: {…} } as the server has it

export function lookPicker({ page = 'studio', onPick = null } = {}) {
  const root = h('div', { class: 'stu-look-picker' });
  const send = async body => {
    const mine = lookState[page];
    if (body.theme) mine.theme = body.theme;
    if (body.accent) mine.accent = body.accent;
    if ('sync' in body) lookState.sync = body.sync;
    render();
    try {
      lookState = await api('/api/look', { body: { page, ...body } });
    } catch (err) {
      toast.error(err.message);
    }
    render();
    // The Studio's own look and the switch: its preview and other open pages show them at once
    core.showDraft({ theme: lookState.studio.theme, accent: lookState.studio.accent, look_sync: lookState.sync });
    onPick?.(lookState);
  };
  const render = () => {
    if (!lookState) return;
    const mine = lookState[page];
    const accent = mine.accent || '#3b82f6';
    const sw = h('input', { type: 'checkbox', class: 'stu-switch', checked: lookState.sync, 'data-fk': 'look-sync' });
    sw.addEventListener('change', () => send({ sync: sw.checked }));
    const grid = h('div', { class: 'stu-looks' }, ...THEMES.map(t => {
      const btn = h('button', { type: 'button', class: `stu-look${mine.theme === t.id ? ' is-on' : ''}`, title: t.name, 'data-fk': `look-${t.id}` },
        themeSwatch(t, accent), t.name);
      btn.addEventListener('click', () => send({ theme: t.id }));
      return btn;
    }));
    const custom = h('input', { type: 'color', value: accent, 'aria-label': 'Own colour' });
    custom.addEventListener('change', () => send({ accent: custom.value }));
    const accents = h('div', { class: 'stu-accents' }, ...ACCENTS.map(c => {
      const b = h('button', { type: 'button', class: `stu-accent${mine.accent.toLowerCase() === c ? ' is-on' : ''}`, style: `background:${c}`, 'aria-label': `Accent ${c}` });
      b.addEventListener('click', () => send({ accent: c }));
      return b;
    }), h('label', { class: `stu-accent stu-accent-custom${mine.accent && !ACCENTS.includes(mine.accent.toLowerCase()) ? ' is-on' : ''}`, title: 'Own colour' }, custom));
    root.replaceChildren(
      h('label', { class: 'stu-switch-row', title: 'On: a change here changes the Studio, the Dashboard and the Overlay. Off: each page keeps its own look.' },
        sw, 'Same look on Studio, Dashboard and Overlay'),
      section('Look', grid), section('Accent colour', accents));
  };
  render();
  api('/api/look').then(v => { lookState = v; render(); }).catch(err => toast.error(err.message));
  return root;
}

// --- Camera layout as little pictures; Auto = board while throwing, split at takeout -----------------
const LAYOUTS = {
  auto: { label: 'Auto', title: 'Board while throwing, split while the darts are pulled', boxes: [['10%', '20%', '35%', '60%'], ['55%', '20%', '35%', '60%']] },
  split: { label: 'Split', title: 'Board and player side by side', boxes: [['4%', '8%', '44%', '84%'], ['52%', '8%', '44%', '84%']] },
  board: { label: 'Board', title: 'Board full screen, player small', boxes: [['4%', '8%', '92%', '84%'], ['66%', '54%', '28%', '34%']] },
  player: { label: 'Player', title: 'Player full screen, board small', boxes: [['4%', '8%', '92%', '84%'], ['66%', '54%', '28%', '34%']] }
};

// A camera slot in use (same rule as the output, web/studio/js/cameras.js)
const hasCamera = cam => !!cam && (((cam.kind === 'server' || cam.kind === 'device') && !!cam.device_id) || (cam.kind === 'url' && !!cam.url));

export function layoutPicker() {
  const root = h('div', { class: 'stu-layouts', role: 'radiogroup', 'aria-label': 'Cameras on screen' });
  const render = () => {
    // One camera fills the screen and none shows the overlays on the background: no layout to pick
    const used = ['board', 'player'].filter(k => hasCamera(S().cameras?.[k]));
    if (used.length < 2) {
      root.replaceChildren(h('p', { class: 'stu-hint', title: 'Choose cameras in Studio › Cameras' }, used.length
        ? `Only the ${used[0]} camera: it fills the screen.`
        : 'No camera: the graphics show on the Studio background.'));
      return;
    }
    const cur = S().auto_direct ? 'auto' : S().layout;
    root.replaceChildren(...Object.entries(LAYOUTS).map(([id, l]) => {
      const pic = h('span', { class: 'stu-layout-pic' }, l.boxes.map(([left, top, w, hh]) => h('span', { style: `left:${left};top:${top};width:${w};height:${hh}` })));
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(cur === id), class: `stu-layout${cur === id ? ' is-on' : ''}`, 'data-layout': id, title: l.title }, pic, l.label);
      const values = id === 'auto' ? { auto_direct: true } : { auto_direct: false, layout: id };
      b.addEventListener('click', () => { change(values); render(); });
      return b;
    }));
  };
  render();
  return root;
}

// --- Texts ----------------------------------------------------------------------------------------
// The event title and subtitle are settings of their own; the other texts are overrides (empty = default)
const EVENT_GROUP = { name: 'Event', toggle: null, items: [{ key: 'event_title', label: 'Event title', setting: 'title' }, { key: 'event_subtitle', label: 'Subtitle (e.g. Final, Round 3)', setting: 'subtitle' }] };

const textGroups = names => {
  const all = [EVENT_GROUP, ...(S().text_groups || [])];
  return names.map(n => all.find(g => g.name === n)).filter(Boolean);
};

// The texts with these keys, as the editor lists them (the event title and subtitle included)
export function textItems(keys) {
  const all = [EVENT_GROUP, ...(S().text_groups || [])].flatMap(g => g.items);
  return keys.map(k => all.find(i => i.key === k)).filter(Boolean);
}

// One text: an eye that hides it on the screens, then its field (empty = the default wording).
// labelled: the label above it (the field on its own, opened from the preview). onLeave: called when
// no text field has focus any more.
export function textRow(item, { onLeave = () => focusText(null), labelled = false } = {}) {
  const defaults = S().text_defaults || {};
  const hidden = () => new Set(S().hidden_texts || []);
  const value = item.setting ? S()[item.setting] : (S().texts?.[item.key] || '');
  const input = h('input', { type: 'text', maxlength: 80, value: value || '', placeholder: defaults[item.key] || item.label, 'aria-label': item.label, title: item.label });
  input.dataset.key = item.key;
  const isHidden = hidden().has(item.key);
  const eye = h('button', { type: 'button', class: 'stu-eye', title: 'Show or hide on the screens', 'aria-label': `Show ${item.label}`, 'aria-pressed': String(!isHidden) }, icon(isHidden ? 'eyeOff' : 'eye', 16));
  const row = h('div', { class: `stu-trow${isHidden ? ' is-hidden' : ''}` }, eye, input);
  row.dataset.key = item.key;
  // The same text may be open twice (the preview's field and the list): both follow
  const twins = () => [...document.querySelectorAll(`.stu-trow[data-key="${item.key}"]`)].filter(r => r !== row);
  input.addEventListener('focus', () => focusText(item.key, item.label));
  input.addEventListener('blur', () => setTimeout(() => { if (!document.activeElement?.closest?.('.stu-trow')) onLeave(); }, 200));
  input.addEventListener('input', () => {
    if (item.setting) change({ [item.setting]: input.value.trim() });
    else {
      const texts = { ...(S().texts || {}) };
      if (input.value.trim()) texts[item.key] = input.value.trim(); else delete texts[item.key];
      change({ texts });
    }
    twins().forEach(r => { r.querySelector('input').value = input.value; });
  });
  const showEye = (r, off) => {
    r.classList.toggle('is-hidden', off);
    const e = r.querySelector('.stu-eye');
    e.replaceChildren(icon(off ? 'eyeOff' : 'eye', 16));
    e.setAttribute('aria-pressed', String(!off));
  };
  eye.addEventListener('click', () => {
    const set = hidden();
    const nowHidden = !set.has(item.key);
    if (nowHidden) set.add(item.key); else set.delete(item.key);
    change({ hidden_texts: [...set] });
    [row, ...twins()].forEach(r => showEye(r, nowHidden));
  });
  return labelled ? h('label', { class: 'stu-tfield' }, h('span', {}, item.label), row) : row;
}

// One folding group per overlay part: a field per text with an eye that hides it; toggles: the part's
// own switch on top (off where the step shows the parts as tiles).
export function textsEditor(names, { onLeave = () => focusText(null), toggles = true } = {}) {
  const root = h('div', { class: 'stu-texts' });
  const groups = textGroups(names);
  const inputs = [];
  root.append(...groups.map((g, i) => {
    const t = toggles ? g.toggle : null;
    const sw = t ? h('input', { type: 'checkbox', class: 'stu-switch', checked: S()[t.key] !== false, title: t.label, 'aria-label': `${g.name}: ${t.label}` }) : null;
    const node = h('details', { class: 'stu-tgroup', open: groups.length <= 2 || i === 0 },
      h('summary', {}, icon('play', 12), h('span', { class: 'stu-tgroup-name' }, g.name),
        g.items.length ? h('span', { class: 'stu-tgroup-n' }, String(g.items.length)) : null, sw));
    node.querySelector('summary .stu-icon').classList.add('stu-chev');
    if (g.where) node.title = `Shown: ${g.where}`;
    if (sw) {
      sw.addEventListener('click', e => e.stopPropagation());
      const sync = () => node.classList.toggle('is-off', t.show && !sw.checked);
      sw.addEventListener('change', () => { change({ [t.key]: sw.checked }); sync(); });
      sync();
    }
    if (g.items.length) {
      node.append(h('div', { class: 'stu-trows' }, g.items.map(item => {
        const row = textRow(item, { onLeave });
        inputs.push(row.querySelector('input'));
        return row;
      })));
    }
    return node;
  }).filter(node => toggles || node.querySelector('.stu-trow')));
  // Back to the default wording of these groups' texts (the event title and subtitle stay)
  const overrides = inputs.filter(i => !EVENT_GROUP.items.some(e => e.key === i.dataset.key));
  if (overrides.length) {
    const reset = h('button', { type: 'button', class: 'stu-link' }, icon('reset', 14), 'Default wording');
    reset.addEventListener('click', () => {
      const texts = { ...(S().texts || {}) };
      overrides.forEach(i => { delete texts[i.dataset.key]; i.value = ''; });
      change({ texts });
    });
    root.append(h('div', { class: 'stu-texts-foot' }, reset));
  }
  return root;
}

// The number of texts in these groups
export const textCount = names => textGroups(names).reduce((n, g) => n + g.items.length, 0);

// --- Parts of the overlay as picture tiles: a click switches one, hovering outlines it in the preview --
// id: [label, setting, icon, what it is]
const PARTS = {
  overlay: ['Overlay', 'show_overlay', 'layers', 'Scoreboard and graphics. Off: only the cameras'],
  player_card: ['Player card', 'show_player_card', 'user', 'Pictures and averages of the players'],
  visit: ['Darts', 'show_checkout', 'list', 'The darts of the visit, the checkout hint and the 9-darter alert'],
  dartboard: ['Mini board', 'show_dartboard', 'target', 'A small dartboard with where the darts landed'],
  intro: ['Intro', 'show_intro', 'swords', 'The versus intro when a match starts'],
  blur: ['Camera behind', 'idle_blur', 'blur', 'The board camera, blurred, behind the idle screen']
};

export function partTiles(ids) {
  return h('div', { class: 'stu-tiles' }, ids.map(id => {
    const [label, key, ico, note] = PARTS[id];
    const b = h('button', { type: 'button', class: 'stu-tile', title: note }, icon(ico, 22), h('span', {}, label));
    const show = () => { const on = S()[key] !== false; b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on)); };
    b.addEventListener('click', () => { change({ [key]: S()[key] === false }); show(); });
    show();
    return b;
  }));
}

// A small (i) that opens a longer explanation in a popover
export function infoTip(...content) {
  const b = h('button', { type: 'button', class: 'stu-info', 'data-pop': '', 'aria-label': 'More about this', title: 'More about this' }, icon('info', 14));
  b.addEventListener('click', e => {
    e.preventDefault();
    popover(b, h('div', { class: 'stu-info-text' }, ...content));
  });
  return b;
}

// --- Readiness dots; a missing one pulses and opens its fix ----------------------------------------
let pop = null;
const closePop = () => { pop?.remove(); pop = null; };
export const closePopover = closePop;
// The path as it was when clicked: a button inside the popover that rebuilds it is still inside
document.addEventListener('click', e => { if (pop && !e.composedPath().includes(pop) && !e.target.closest('[data-pop]')) closePop(); });
addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
// It sits where its button was: scrolling the page closes it
addEventListener('scroll', e => { if (pop && !pop.contains(e.target)) closePop(); }, true);

// A small popover under an element (the readiness fixes, the TV address)
export function popover(anchor, ...content) {
  const wasOpen = pop?.anchor === anchor;
  closePop();
  if (wasOpen) return;
  const r = anchor.getBoundingClientRect();
  pop = h('div', { class: 'stu-pop', role: 'dialog' }, ...content);
  pop.anchor = anchor;
  pop.style.top = `${r.bottom + 6}px`;
  document.body.append(pop);
  // Keep it inside the window
  pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
}

// refresh() reads the status; onState gets the game state too (the Up next step lists its players)
export function statusDots(onState = null) {
  const root = h('div', { class: 'stu-dots', 'aria-live': 'polite' });
  root.refresh = async () => {
    try {
      const { state, checks } = await core.readStatus();
      onState?.(state);
      // Rebuilt only when something changed, so a dot keeps hover and focus
      const key = JSON.stringify(checks);
      if (root.dataset.key === key) return;
      root.dataset.key = key;
      root.replaceChildren(...checks.map(c => {
        const todo = !c.ok && !c.wait;
        const dot = h(todo ? 'button' : 'span', { class: 'stu-dot', 'data-state': c.ok ? 'done' : c.wait ? 'wait' : 'todo', title: c.detail, 'data-pop': '' },
          h('i'), h('span', {}, c.label));
        if (todo) dot.addEventListener('click', () => {
          const fix = c.action === 'start'
            ? h('button', { type: 'button', class: 'stu-btn is-primary', onclick: async () => { closePop(); await core.startAutodarts(); root.refresh(); } }, 'Start Autodarts')
            : c.id === 'tab' ? h('a', { class: 'stu-btn', href: 'https://play.autodarts.com/', target: '_blank', rel: 'noopener' }, icon('external', 14), 'Open') : null;
          popover(dot, h('span', {}, c.detail), fix);
        });
        return dot;
      }));
    } catch {
      // Shown again on the next refresh
    }
  };
  return root;
}
