// AutoGlow 2 - Players: the club roster with real stats. One card per member with a picture and
// profile; a player in an Autodarts game is recognised by their name or Autodarts name (alias).
// The roster is the Studio player list (/api/studio); games and stats come from /api/club/*. On a
// club client the roster is a copy of the club host's and the stats are the club host's.

import { api } from '../core/api.js';
import { choiceDialog, confirmDialog } from '../core/dialog.js';
import { esc, h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import * as core from './studio-core.js';
import { avatar, deletePlayer, icon, imageUrl, loadSettings, PROFILE, savePlayer } from './studio-core.js';

const $ = id => document.getElementById(id);
const roster = () => core.settings?.players || [];

let view = { tab: 'members', sort: 'name', dir: '', mode: '', member: null, editing: false, query: '', period: 'all', board: 'season' };
let club = { role: 'alone', can_edit: true };   // /api/club/state
let sums = {};                                  // member id → summary stats
let seq = 0;                                    // drops answers of views the user already left

const PERIODS = [['all', 'All time'], ['season', 'This year'], ['month', 'This month']];
const fmt = (v, d = 1) => (typeof v === 'number' && v > 0 ? v.toFixed(d) : '–');
const int = v => (typeof v === 'number' && v > 0 ? String(v) : '–');
const when = s => (s ? new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// --- Pictures: pick by click or drop ----------------------------------------------------------------
export function dropPicture(el, onFile) {
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('is-drop'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
  el.addEventListener('drop', e => {
    e.preventDefault();
    el.classList.remove('is-drop');
    const f = e.dataTransfer.files?.[0];
    if (f && /^image\//.test(f.type)) onFile(f);
  });
}

// A picture to pick by click or drop; returns { el, file() }
function picturePicker(cls, current, empty, label, title) {
  let file = null;
  const shown = h('span', { class: `stu-pic ${cls}` }, current ? h('img', { src: imageUrl(current), alt: '' }) : empty);
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  const show = f => {
    file = f;
    shown.replaceChildren(h('img', { src: URL.createObjectURL(f), alt: '' }));
    shown.animate([{ transform: 'scale(.85)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
  };
  input.addEventListener('change', () => input.files[0] && show(input.files[0]));
  const el = h('button', { type: 'button', class: 'stu-pic-pick', title }, shown, input, h('small', {}, label));
  el.addEventListener('click', () => input.click());
  dropPicture(el, show);
  return { el, file: () => file };
}

// A QR code to scan with a phone: opens the page where a player adds themselves
async function showJoinQr() {
  try {
    const r = await api('/api/club/join-qr');
    const box = h('div', { style: 'text-align:center' }, h('div', { style: 'background:#fff;border-radius:12px;padding:8px;width:min(260px,70vw);margin:0 auto' }), h('p', {}, 'Scan with your phone on the club WiFi and add yourself as a player.'));
    box.firstChild.innerHTML = r.svg;
    box.firstChild.firstElementChild.style.cssText = 'width:100%;height:auto;display:block';
    await choiceDialog({ title: 'Join the club', body: box, choices: [{ value: true, label: 'Okay', primary: true }] });
  } catch (e) { toast(e.message || 'Could not make the QR code', 'error'); }
}

const fieldsOf = p => Object.fromEntries([['name', p.name], ...PROFILE.map(([k]) => [k, p[k] || ''])]);
// The names a member is recognised by in Autodarts (guests show in capitals there)
const matchedNames = p => [...new Set([p.name, p.alias].filter(Boolean).map(n => n.trim().toUpperCase()))];

// --- The profile editor (a new member when p is null) -------------------------------------------------
function editor(p, done, prefill = '') {
  const picture = picturePicker('stu-avatar', p?.image, icon('camera', 28), 'Picture', 'Click or drop a picture');
  // Shown by the "Mockup" player camera in the Studio while this player is at the board
  const mockup = picturePicker('is-wide', p?.mockup, icon('video', 22), 'Mockup camera', 'Photo the Studio mockup player camera shows while this player is at the board');
  // Autodarts shows guests in capitals; a member's name reads better as "Sascha K"
  const nice = prefill.toLowerCase().replace(/(^|[\s-])\S/g, c => c.toUpperCase());
  const name = h('input', { class: 'stu-pcard-name', value: p?.name || nice, placeholder: 'Player name', maxlength: 40, 'aria-label': 'Player name' });
  const inputs = PROFILE.map(([k, label, placeholder, max]) => k === 'hand'
    ? h('label', {}, label, h('select', { 'data-k': k }, [['', '–'], ['Right', 'Right-handed'], ['Left', 'Left-handed']].map(([v, t]) => h('option', { value: v, selected: (p?.hand || '') === v }, t))))
    : h('label', {}, label, h('input', { 'data-k': k, value: p?.[k] || '', placeholder, maxlength: max })));
  const save = h('button', { type: 'button', class: 'stu-btn is-primary' }, icon('check', 16), p ? 'Save' : 'Add member');
  const close = h('button', { type: 'button', class: 'stu-btn' }, 'Cancel');
  const root = h('div', { class: 'stu-pcard pl-editor' },
    h('div', { class: 'stu-pcard-pics' }, picture.el, mockup.el),
    h('div', { class: 'stu-pcard-main' }, name, h('div', { class: 'stu-pfields' }, inputs), h('div', { class: 'stu-pcard-actions' }, save, close)));
  save.addEventListener('click', async () => {
    if (!name.value.trim()) { name.focus(); name.animate([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], { duration: 220 }); return; }
    const fields = { name: name.value };
    root.querySelectorAll('[data-k]').forEach(i => { fields[i.dataset.k] = i.value; });
    save.disabled = true;
    try {
      await savePlayer(p?.id, fields, { image: picture.file(), mockup: mockup.file() });
      const saved = roster().find(x => x.name.trim().toLowerCase() === name.value.trim().toLowerCase());
      toast.success(p ? 'Member saved.' : 'Member added.');
      done(saved?.id || p?.id || null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      save.disabled = false;
    }
  });
  close.addEventListener('click', () => done(p?.id || null));
  setTimeout(() => name.focus({ preventScroll: true }));
  return root;
}

// --- Small pieces ---------------------------------------------------------------------------------------
const back = () => h('button', { type: 'button', class: 'pl-back', onclick: () => open(null) }, '← All members');
const panel = (title, ...body) => h('div', { class: 'pl-panel' }, title ? h('h3', { class: 'stu-h' }, title) : null, ...body);
const muted = text => h('p', { class: 'pl-muted' }, text);

function segmented(items, current, onPick) {
  return h('div', { class: 'pl-seg', role: 'tablist' }, items.map(([k, label]) =>
    h('button', { type: 'button', role: 'tab', class: k === current ? 'is-on' : '', 'aria-selected': String(k === current), onclick: () => onPick(k) }, label)));
}

function tile(label, value, hint) {
  return h('div', { class: 'pl-tile' }, h('small', {}, label), h('b', {}, value), hint ? h('span', {}, hint) : null);
}

// Average over the last games: one accent line, a dot per game (filled when won), a tooltip per dot
function formChart(form) {
  const box = h('div', { class: 'pl-form' });
  if (form.length < 2) {
    box.append(muted(form.length ? 'The form line starts after the second game.' : 'No games yet.'));
    return box;
  }
  const W = 560, H = 160, L = 34, R = 10, T = 12, B = 22;
  const vals = form.map(f => f.average);
  const lo = Math.max(0, Math.floor((Math.min(...vals) - 5) / 10) * 10);
  const hi = Math.ceil((Math.max(...vals) + 5) / 10) * 10;
  const x = i => L + (i * (W - L - R)) / (form.length - 1);
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const ticks = [lo, (lo + hi) / 2, hi];
  const pts = form.map((f, i) => `${x(i).toFixed(1)},${y(f.average).toFixed(1)}`).join(' ');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Average of the last ${form.length} games">
    ${ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="pl-grid-line"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" class="pl-axis">${t}</text>`).join('')}
    <polyline points="${pts}" class="pl-line"/>
    ${form.map((f, i) => `<g class="pl-pt" data-i="${i}"><circle cx="${x(i)}" cy="${y(f.average)}" r="12" class="pl-hit"/><circle cx="${x(i)}" cy="${y(f.average)}" r="4.5" class="pl-dot${f.won ? ' is-won' : ''}"/></g>`).join('')}
    <text x="${L}" y="${H - 4}" class="pl-axis">${esc(when(form[0].at))}</text><text x="${W - R}" y="${H - 4}" text-anchor="end" class="pl-axis">${esc(when(form[form.length - 1].at))}</text>
  </svg><div class="pl-tip" hidden></div>`;
  const tip = box.querySelector('.pl-tip');
  box.querySelectorAll('.pl-pt').forEach(g => {
    const f = form[+g.dataset.i];
    g.addEventListener('mouseenter', () => {
      tip.hidden = false;
      tip.innerHTML = `<b>${fmt(f.average, 2)}</b> average<br>${f.won ? 'Won' : 'Lost'} · ${esc(when(f.at))}`;
      const r = g.getBoundingClientRect(), b = box.getBoundingClientRect();
      tip.style.left = `${r.left - b.left + r.width / 2}px`;
      tip.style.top = `${r.top - b.top}px`;
    });
    g.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
  return box;
}

// --- Members ------------------------------------------------------------------------------------------
function card(p, i) {
  const s = sums[p.id];
  const b = h('button', { type: 'button', class: 'pl-card', style: `animation-delay:${Math.min(i, 20) * 25}ms`, title: club.can_edit ? 'Open, or drop a picture here' : 'Open' },
    avatar(p),
    h('span', { class: 'pl-card-name' }, p.name),
    h('span', { class: 'pl-card-nick' }, p.nickname ? `“${p.nickname}”` : ' '),
    h('span', { class: 'pl-card-stats' }, s?.games ? [h('b', {}, fmt(s.average)), ' avg · ', `${s.games} game${s.games === 1 ? '' : 's'}`] : 'No games yet'),
    h('span', { class: 'pl-chips' }, ...matchedNames(p).map(n => h('span', { class: 'pl-chip' }, n))));
  b.addEventListener('click', () => open(p.id));
  if (club.can_edit) {
    dropPicture(b, async f => {
      try { await savePlayer(p.id, fieldsOf(p), { image: f }); render(); toast.success('Picture saved.'); } catch (err) { toast.error(err.message); }
    });
  }
  return b;
}

// Sortable columns: label, value getter, and the direction a first click uses (text up, numbers down)
const COLS = {
  name: ['Player', p => p.name.toLowerCase(), 'asc'],
  average: ['Average', p => sums[p.id]?.average || 0, 'desc'],
  first9: ['First 9', p => sums[p.id]?.first9 || 0, 'desc'],
  games: ['Games', p => sums[p.id]?.games || 0, 'desc'],
  win_pct: ['Win %', p => sums[p.id]?.win_pct || 0, 'desc'],
  t180: ['180s', p => sums[p.id]?.t180 || 0, 'desc'],
  best_checkout: ['Best checkout', p => sums[p.id]?.best_checkout || 0, 'desc'],
  last: ['Last played', p => sums[p.id]?.last_at || 0, 'desc']
};
const sortList = list => {
  const key = COLS[view.sort] ? view.sort : 'name', get = COLS[key][1];
  const dir = (view.dir || COLS[key][2]) === 'asc' ? 1 : -1;
  return list.sort((a, b) => { const x = get(a), y = get(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || a.name.localeCompare(b.name); });
};
const savedMode = () => { try { return localStorage.getItem('ag.players.mode') === 'table' ? 'table' : 'cards'; } catch { return 'cards'; } };

// --- Demo players: a fixed Norse set to try features with; one button adds them, the same button removes them
const DEMO = [
  ['Odin Borson', 'The Allfather', 'Asgard Darts Club', 'Asgard', 'Right', '24', 'D16', '2009', '79.4', '71', '164'],
  ['Freya Njordsdottir', 'Queen of Vanaheim', 'Vanaheim Valkyries', 'Vanaheim', 'Right', '21', 'D18', '2016', '74.8', '38', '141'],
  ['Heimdall', 'The Watchman', 'Bifrost Bullseyes', 'Himinbjorg', 'Right', '23', 'D12', '2013', '72.1', '22', '130'],
  ['Sif Golden-Hair', 'Goldilocks', 'Asgard Darts Club', 'Asgard', 'Left', '20', 'D10', '2018', '66.5', '9', '108'],
  ['Tyr One-Hand', 'God of Single Combat', 'Midgard Marksmen', 'Midgard', 'Left', '25', 'D8', '2012', '70.3', '17', '120'],
  ['Hela Lokisdottir', 'Queen of Hel', 'Jotunheim Tricksters', 'Helheim', 'Right', '19', 'D6', '2015', '77.2', '41', '150'],
  ['Thor Odinson', 'God of Thunder', 'Asgard Darts Club', 'Asgard', 'Right', '26', 'D20', '2010', '81.3', '88', '170'],
  ['Loki Laufeyson', 'The Trickster', 'Jotunheim Tricksters', 'Jotunheim', 'Left', '22', 'D4', '2014', '73.6', '30', '136']
];
const isDemo = p => DEMO.some(d => d[0] === p.name);

async function toggleDemo() {
  const present = roster().filter(isDemo);
  try {
    if (present.length) {
      for (const p of present) await deletePlayer(p.id);
    } else {
      for (const d of DEMO) {
        await savePlayer(null, { name: d[0], ...Object.fromEntries(['nickname', 'club', 'hometown', 'hand', 'dart_weight', 'favourite_double', 'playing_since', 'stat_average', 'stat_180s', 'stat_best_checkout'].map((k, i) => [k, d[i + 1]])) });
      }
    }
    await refresh();
    render();
    toast.success(present.length ? 'Demo players removed.' : 'Demo players added.');
  } catch (err) { toast.error(err.message); }
}

// The results: the card grid or the sortable table (headers sort; a second click flips the direction)
function results(list, q) {
  if (view.mode === 'table') {
    const heads = Object.entries(COLS).map(([k, [label]]) => {
      const on = view.sort === k, dir = view.dir || COLS[k][2];
      return h('th', { class: k === 'name' ? '' : 'is-num', 'aria-sort': on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none' },
        h('button', { type: 'button', class: on ? 'is-on' : '', onclick: () => { view.dir = on ? (dir === 'asc' ? 'desc' : 'asc') : COLS[k][2]; view.sort = k; render(); } }, label, on ? h('span', { class: 'pl-arrow' }, dir === 'asc' ? '▲' : '▼') : null));
    });
    const rows = list.map(p => {
      const s = sums[p.id];
      const tr = h('tr', { tabindex: '0', title: 'Open' },
        h('td', {}, h('span', { class: 'pl-trow-who' }, avatar(p), h('span', {}, h('b', {}, p.name), p.nickname ? h('small', {}, `“${p.nickname}”`) : null))),
        h('td', { class: 'is-num' }, fmt(s?.average)), h('td', { class: 'is-num' }, fmt(s?.first9)), h('td', { class: 'is-num' }, int(s?.games)),
        h('td', { class: 'is-num' }, s?.games ? `${Math.round(s.win_pct)}%` : '–'), h('td', { class: 'is-num' }, int(s?.t180)), h('td', { class: 'is-num' }, int(s?.best_checkout)),
        h('td', { class: 'is-num' }, s?.last_at ? when(s.last_at) : '–'));
      tr.addEventListener('click', () => open(p.id));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter') open(p.id); });
      return tr;
    });
    return h('div', { class: 'pl-results' }, h('div', { class: 'pl-table-wrap' }, h('table', { class: 'pl-table' }, h('thead', {}, h('tr', {}, ...heads)), h('tbody', {}, ...rows))),
      list.length || !q ? null : h('p', { class: 'pl-empty' }, `Nobody matches “${view.query}”.`));
  }
  const add = club.can_edit && !q ? h('button', { type: 'button', class: 'pl-card pl-add', onclick: () => open(null, true) }, h('span', { class: 'stu-avatar' }, icon('plus', 22)), h('span', { class: 'pl-card-name' }, 'New member')) : null;
  return h('div', { class: 'pl-results' }, h('div', { class: 'pl-grid' }, ...list.map(card), add),
    list.length || !q ? null : h('p', { class: 'pl-empty' }, `Nobody matches “${view.query}”.`));
}

function membersView() {
  view.mode = view.mode || savedMode();
  const q = view.query.trim().toLowerCase();
  const filtered = () => sortList(roster().filter(p => !q || [p.name, p.nickname, p.alias, p.club].some(v => (v || '').toLowerCase().includes(q))));
  const search = h('input', { class: 'pl-search', type: 'search', placeholder: 'Search members', value: view.query, 'aria-label': 'Search members' });
  search.addEventListener('input', () => {
    view.query = search.value;
    const qq = view.query.trim().toLowerCase();
    const list = sortList(roster().filter(p => !qq || [p.name, p.nickname, p.alias, p.club].some(v => (v || '').toLowerCase().includes(qq))));
    $('playersPage').querySelector('.pl-results').replaceWith(results(list, qq));
  });
  const sort = h('select', { class: 'pl-sort', 'aria-label': 'Sort by', onchange: e => { view.sort = e.target.value; view.dir = ''; render(); } },
    Object.entries(COLS).map(([v, [t]]) => h('option', { value: v, selected: (view.sort || 'name') === v }, `Sort: ${t === 'Player' ? 'Name' : t}`)));
  const modes = h('div', { class: 'pl-seg pl-modes', role: 'group', 'aria-label': 'View' },
    [['cards', 'grid', 'Cards'], ['table', 'list', 'Table']].map(([k, ic, label]) =>
      h('button', { type: 'button', class: view.mode === k ? 'is-on' : '', title: label, 'aria-pressed': String(view.mode === k), onclick: () => { view.mode = k; try { localStorage.setItem('ag.players.mode', k); } catch {} render(); } }, label)));
  const demoBtn = club.can_edit ? h('button', { type: 'button', class: 'stu-btn', onclick: toggleDemo }, roster().some(isDemo) ? 'Remove demo players' : 'Add demo players') : null;
  const qrBtn = h('button', { type: 'button', class: 'stu-btn', title: 'Players scan this with their phone to add themselves', onclick: showJoinQr }, 'Join QR code');
  return h('div', {},
    h('div', { class: 'pl-tools' }, search, sort, modes, qrBtn, demoBtn, h('span', { class: 'pl-count' }, `${roster().length} member${roster().length === 1 ? '' : 's'}`)),
    results(filtered(), q),
    h('p', { class: 'pl-note' }, icon('info', 16), h('span', {},
      'A player in an Autodarts game counts as a member when the name there matches their name or their Autodarts name, for example the guest ',
      h('b', {}, 'SASCHA'), '. Capitals don’t matter, and a close spelling still matches. Every finished local game is saved to their stats.')));
}

// --- One member ------------------------------------------------------------------------------------------
function statsBlock(st) {
  const t = st.totals;
  const box = h('div', {});
  box.append(panel(null,
    h('div', { class: 'pl-tiles is-wide' },
      tile('Average', fmt(t.average, 2), 'per 3 darts'), tile('First 9', fmt(t.first9, 2)), tile('Checkout', t.checkout_pct ? `${fmt(t.checkout_pct)}%` : '–'),
      tile('180s', String(t.t180 || 0)), tile('140+', String(t.t140 || 0)), tile('100+', String(t.t100 || 0)),
      tile('Best checkout', int(t.best_checkout)), tile('Best leg', t.best_leg ? `${t.best_leg} darts` : '–'),
      tile('Games', String(t.games || 0), t.games ? `${t.wins} won · ${Math.round(t.win_pct)}%` : ''))));
  const recent = st.recent.length
    ? h('table', { class: 'pl-table' }, h('thead', {}, h('tr', {}, ['Date', 'Opponent', 'Result', 'Average', 'Board'].map(x => h('th', {}, x)))),
      h('tbody', {}, st.recent.map(g => h('tr', { class: g.counts ? '' : 'is-muted', title: g.counts ? '' : (g.bot ? 'Against a bot: not counted' : 'Not counted') },
        h('td', {}, when(g.at)), h('td', {}, g.opponents.join(', ') || 'Solo'),
        h('td', {}, h('span', { class: `pl-res ${g.won ? 'is-won' : ''}` }, g.won ? 'W' : 'L'), ` ${g.score[0]}–${g.score[1]}`),
        h('td', {}, fmt(g.average, 2)), h('td', {}, g.board)))))
    : muted('No games in this period.');
  const h2h = st.head_to_head.length
    ? h('table', { class: 'pl-table' }, h('thead', {}, h('tr', {}, ['Opponent', 'Games', 'Won', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, st.head_to_head.slice(0, 12).map(o => h('tr', {}, h('td', {}, o.name), h('td', {}, o.games), h('td', {}, o.wins),
        h('td', {}, h('span', { class: 'pl-bar' }, h('i', { style: `width:${Math.round((o.wins / o.games) * 100)}%` })))))))
    : muted('Nobody played yet.');
  box.append(h('div', { class: 'pl-cols' }, panel('Form · average of the last games', formChart(st.form)), panel('Head-to-head', h2h)));
  box.append(h('div', { class: 'pl-cols' }, panel('Recent games', recent)));
  return box;
}

function memberView(p) {
  if (view.editing) return h('div', {}, back(), h('div', { class: 'pl-panel' }, editor(p, id => { view.editing = false; open(id); })));
  const facts = [
    p.country && ['Country', p.country], p.club && ['Club', p.club], p.hometown && ['Hometown', p.hometown],
    p.hand && ['Throws', `${p.hand}-handed`], p.dart_weight && ['Darts', `${p.dart_weight} g`],
    p.favourite_double && ['Favourite double', p.favourite_double], p.playing_since && ['Playing since', p.playing_since]
  ].filter(Boolean);
  const imported = [['Average', p.stat_average], ['180s', p.stat_180s], ['Best checkout', p.stat_best_checkout]].filter(([, v]) => v);
  const actions = club.can_edit ? [
    h('button', { type: 'button', class: 'stu-btn', onclick: () => { view.editing = true; render(); } }, icon('edit', 16), 'Edit profile'),
    h('button', { type: 'button', class: 'stu-btn stu-iconbtn stu-del', title: `Delete ${p.name}`, 'aria-label': `Delete ${p.name}`, onclick: async () => {
      const ok = await confirmDialog({ title: `Delete ${p.name}?`, body: 'The member and their pictures are removed. Their games stay and show up under Unassigned again.', confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      try { await deletePlayer(p.id); toast.success(`${p.name} deleted.`); open(null); } catch (err) { toast.error(err.message); }
    } }, icon('trash', 16))] : [];
  const names = h('div', { class: 'pl-matched' }, h('span', {}, 'Recognised in Autodarts as'), ...matchedNames(p).map(n => h('span', { class: 'pl-chip' }, n)));
  const statsBox = h('div', { class: 'pl-stats' }, muted('Loading stats…'));
  const mine = ++seq;
  api(`/api/club/member?id=${encodeURIComponent(p.id)}&period=${view.period}`).then(r => {
    if (mine !== seq) return;
    for (const n of r.names || []) {
      if (matchedNames(p).includes(n)) continue;
      const chip = h('span', { class: 'pl-chip is-extra', title: 'Given to this member from the unassigned names' }, n);
      if (club.can_edit) chip.append(h('button', { type: 'button', 'aria-label': `Forget ${n}`, onclick: async () => { await post('forget-name', { name: n }); render(); } }, '×'));
      names.append(chip);
    }
    statsBox.replaceChildren(statsBlock(r.stats));
  }).catch(err => { if (mine === seq) statsBox.replaceChildren(h('p', { class: 'pl-note is-warn' }, icon('info', 16), err.message)); });
  return h('div', {}, back(),
    h('div', { class: 'pl-panel pl-profile' },
      avatar(p, 'pl-big'),
      h('div', { class: 'pl-who' }, h('h2', {}, p.name), p.nickname ? h('div', { class: 'pl-nick' }, `“${p.nickname}”`) : null, names),
      h('div', { class: 'pl-actions' }, ...actions)),
    h('div', { class: 'pl-bar-row' }, segmented(PERIODS, view.period, k => { view.period = k; render(); })),
    statsBox,
    h('div', { class: 'pl-cols' },
      panel('Profile', facts.length ? h('dl', { class: 'pl-facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : muted('Nothing filled in yet.')),
      panel('Stats from before AutoGlow', imported.length ? h('div', { class: 'pl-tiles' }, ...imported.map(([k, v]) => tile(k, v))) : muted('None entered.'),
        muted('Typed in by hand. The Studio shows them until the member has played here.'))));
}

// --- Leaderboards ---------------------------------------------------------------------------------------------
const BOARDS = [
  ['average', 'Average', v => v.toFixed(2)], ['first9', 'First 9 average', v => v.toFixed(2)], ['checkout_pct', 'Checkout %', v => `${v.toFixed(1)}%`],
  ['win_pct', 'Win %', v => `${v.toFixed(0)}%`], ['t180', '180s', String], ['best_checkout', 'Best checkout', String],
  ['best_leg', 'Best leg', v => `${v} darts`], ['games', 'Most games', String]
];

function leaderboardsView() {
  const box = h('div', { class: 'pl-boards' }, muted('Loading…'));
  const mine = ++seq;
  api(`/api/club/leaderboards?period=${view.board}`).then(lb => {
    if (mine !== seq) return;
    const byId = Object.fromEntries(roster().map(p => [p.id, p]));
    box.replaceChildren(...BOARDS.map(([k, title, f]) => panel(title,
      lb[k]?.length ? h('ol', { class: 'pl-rank' }, lb[k].map((r, i) => h('li', { class: i === 0 ? 'is-top' : '', onclick: () => open(r.member) },
        h('span', { class: 'pl-pos' }, i + 1), byId[r.member] ? avatar(byId[r.member]) : null,
        h('span', { class: 'pl-rname' }, r.name || '?', h('small', {}, `${r.games} game${r.games === 1 ? '' : 's'}`)), h('b', {}, f(r.value)))))
        : muted(['average', 'first9', 'checkout_pct', 'win_pct'].includes(k) ? `Needs ${lb.min_games} games per member.` : 'No games yet.'))));
  }).catch(err => { if (mine === seq) box.replaceChildren(h('p', { class: 'pl-note is-warn' }, icon('info', 16), err.message)); });
  return h('div', {},
    h('div', { class: 'pl-bar-row' }, segmented([['season', 'This year'], ['month', 'This month'], ['all', 'All time']], view.board, k => { view.board = k; render(); })),
    box, h('p', { class: 'pl-muted' }, 'Games against a bot don’t count. Averages need a few games before a member is listed.'));
}

// --- Unassigned names -----------------------------------------------------------------------------------------
function unassignedView() {
  const box = h('div', {}, muted('Loading…'));
  const mine = ++seq;
  api('/api/club/unassigned').then(r => {
    if (mine !== seq) return;
    const members = [...roster()].sort((a, b) => a.name.localeCompare(b.name));
    const rows = r.names.map(n => {
      const pick = h('select', { 'aria-label': `Member for ${n.name}` }, h('option', { value: '' }, 'Give to member…'), members.map(m => h('option', { value: m.id }, m.name)));
      pick.addEventListener('change', async () => {
        if (!pick.value) return;
        await post('assign', { name: n.name, member: pick.value, remember: true });
        toast.success(`${n.name}'s games now count for ${members.find(m => m.id === pick.value)?.name}.`);
        render();
      });
      return h('div', { class: 'pl-un' },
        h('span', { class: 'stu-avatar' }, n.name.slice(0, 2)),
        h('div', { class: 'pl-un-who' }, h('b', {}, n.name), h('small', {}, `${n.games} game${n.games === 1 ? '' : 's'} · last on ${n.board || 'a board'}, ${when(n.last_at)}`)),
        h('div', { class: 'pl-un-act' }, pick,
          h('button', { type: 'button', class: 'stu-btn', onclick: () => { view.tab = 'members'; view.prefill = n.name; open(null, true); } }, icon('plus', 16), 'New member'),
          h('button', { type: 'button', class: 'stu-btn', title: 'A guest: hide this name', onclick: async () => { await post('ignore', { name: n.name, ignore: true }); render(); } }, 'Not a member')));
    });
    box.replaceChildren(...[
      rows.length ? panel(null, ...rows) : panel(null, muted('Every name that played is a member. New names show up here after their first game.')),
      r.ignored.length ? h('details', { class: 'pl-ignored' }, h('summary', {}, `Hidden names (${r.ignored.length})`),
        ...r.ignored.map(n => h('div', { class: 'pl-un' }, h('b', {}, n), h('button', { type: 'button', class: 'stu-btn', onclick: async () => { await post('ignore', { name: n, ignore: false }); render(); } }, 'Show again')))) : null].filter(Boolean));
  }).catch(err => { if (mine === seq) box.replaceChildren(h('p', { class: 'pl-note is-warn' }, icon('info', 16), err.message)); });
  return h('div', {}, h('p', { class: 'pl-lead' }, 'Names that played a game here but aren’t a member. Give them to a member and their games count from the first one; the name is recognised from then on.'), box);
}

// A PC that doesn't sync yet and found a club host on the network
function offerBanner() {
  const o = club.offer;
  if (!o || club.role !== 'alone') return null;
  return h('div', { class: 'pl-offer' }, icon('info', 18), h('span', {}, h('b', {}, o.name), ' is the club host on this network. Sync with it to share members and stats?'),
    h('button', { type: 'button', class: 'stu-btn is-primary', onclick: async () => {
      if (!await confirmDialog({ title: `Sync with ${o.name}?`, body: 'This PC’s members are replaced by the club host’s. Games already recorded here are sent there.', confirmLabel: 'Sync' })) return;
      if (await post('role', { role: 'board', address: o.address, club_name: o.name, club_node: o.node })) { toast.success(`Syncing with ${o.name}.`); renderPlayers(); }
    } }, 'Sync'),
    h('button', { type: 'button', class: 'stu-btn', onclick: async () => { if (await post('decline', { node: o.node })) render(); } }, 'Not now'));
}

// --- Page --------------------------------------------------------------------------------------------------
async function post(path, body) {
  try {
    club = await api(`/api/club/${path}`, { body });
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

function open(id, editing = false) {
  view.member = id;
  view.editing = editing;
  render();
  $('playersPage')?.scrollIntoView({ block: 'start' });
}

function render() {
  const host = $('playersPage');
  if (!host) return;
  const p = view.member ? roster().find(x => x.id === view.member) : null;
  const creating = view.editing && !view.member;
  const tabs = [['members', 'Members'], ['leaderboards', 'Leaderboards']];
  if (club.can_edit) tabs.push(['unassigned', club.unassigned ? `Unassigned · ${club.unassigned}` : 'Unassigned']);
  const head = h('div', { class: 'pl-head' },
    h('div', {}, h('h1', {}, 'Players'), h('p', {}, club.role === 'board'
      ? `Members and stats of the club host ${club.club_name || club.address}. Changes made here are saved there.`
      : 'The club roster with stats from every local game. The Studio, the light strip and the Local Tournament use this list.')),
    p || creating ? null : segmented(tabs, view.tab, k => { view.tab = k; view.member = null; render(); }));
  let body;
  if (creating) {
    const prefill = view.prefill || '';
    view.prefill = '';
    body = h('div', {}, back(), h('div', { class: 'pl-panel' }, editor(null, async id => {
      view.editing = false;
      // A new member made from an unassigned name takes that name's games along
      if (prefill && id) await post('assign', { name: prefill, member: id, remember: true });
      await refresh();
      open(id);
    }, prefill)));
  } else if (p) {
    body = memberView(p);
  } else {
    body = { members: membersView, leaderboards: leaderboardsView, unassigned: unassignedView }[view.tab]?.() || membersView();
  }
  host.replaceChildren(...[offerBanner(), head, body].filter(Boolean));
}

async function refresh() {
  const [c, m] = await Promise.all([api('/api/club/state'), api('/api/club/members'), loadSettings()]);
  club = c;
  sums = Object.fromEntries(m.players.filter(x => x.summary).map(x => [x.id, x.summary]));
}

async function renderPlayers() {
  try {
    await refresh();
    if (view.member && !roster().some(x => x.id === view.member)) view.member = null;
    if (!club.can_edit && view.tab === 'unassigned') view.tab = 'members';
    render();
  } catch (err) {
    toast.error(`Could not load the players: ${err.message}`);
  }
}

export function initPlayers() {
  window.renderPlayers = renderPlayers;
}
