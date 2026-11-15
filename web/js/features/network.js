// AutoGlow 2 - Settings → Club & PCs: this PC's name and Club sync (Off, Host or Client: the role
// alone/club/board in the API), every AutoGlow PC on the network (online or offline, renamed from
// here) and moving the club host.
// Data: /api/club/state (role, sync) and /api/club/network (PCs, remembered by the server).

import { api } from '../core/api.js';
import { confirmDialog } from '../core/dialog.js';
import { h } from '../core/dom.js';
import { toast } from '../core/toast.js';
import { icon } from './studio-core.js';

const $ = id => document.getElementById(id);
const ROLES = [
  ['alone', 'Off', 'Members and stats stay on this PC.'],
  ['club', 'Host', 'This PC keeps the members and every game. The other PCs sync with it.'],
  ['board', 'Client', 'Syncs the members from the club host and sends its games there.']
];
const ROLE_TAG = { club: 'Club host', board: 'Club client', alone: 'Not syncing' };

let club = {};          // /api/club/state
let pcs = [];           // /api/club/network
let renaming = null;    // node id of the PC being renamed
let picking = false;    // the client's club host picker is open
let handing = false;    // the hand-over list is open

const muted = text => h('p', { class: 'nw-muted' }, text);
const ago = s => (s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`);
const others = () => pcs.filter(p => !p.me);

async function call(path, body) {
  try {
    return await api(path, body ? { body, timeout: 90000 } : { timeout: 10000 });
  } catch (err) {
    toast.error(err.message);
    return null;
  }
}

async function setRole(role, target) {
  const body = { role, address: target?.address || '', club_name: target?.name || '', club_node: target?.node || '' };
  if (role === 'club' && !await confirmDialog({ title: 'Make this the club host?', body: 'The members and every game then live on this PC. PCs that don’t sync yet are offered to sync with it.', confirmLabel: 'Make club host' })) return;
  if (role === 'board' && !await confirmDialog({ title: `Sync with ${target.name || target.address}?`, body: 'This PC’s members are replaced by the club host’s. Games already recorded here are sent there.', confirmLabel: 'Sync' })) return;
  if (role === 'alone' && club.role !== 'alone' && !await confirmDialog({ title: 'Turn club sync off?', body: club.role === 'club' ? 'The clients stop finding a club host. Hand the club over first to keep it going.' : 'This PC keeps its copy of the members and records games for itself.', confirmLabel: 'Leave' })) return;
  const r = await call('/api/club/role', body);
  if (r) {
    club = r;
    picking = false;
    toast.success(role === 'board' ? `Syncing with ${target.name || target.address}.` : 'Saved.');
    load();
  }
}

// --- This PC ---------------------------------------------------------------------------------------
function nameRow() {
  const me = pcs.find(p => p.me) || {};
  const input = h('input', { class: 'ui-input nw-name', value: me.name || '', maxlength: 40, 'aria-label': 'This PC’s name' });
  const save = async () => {
    const name = input.value.trim();
    if (!name || name === me.name) return;
    const r = await call('/api/tournament/name', { name });
    if (r) { toast.success('Renamed.'); load(); }
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
  return h('div', { class: 'st-row' },
    h('span', { class: 'st-label' }, 'This PC’s name', h('span', { class: 'form-hint' }, 'Shown to the other PCs, in tournaments and in the Studio.')),
    h('div', { class: 'nw-inline' }, input, h('button', { type: 'button', class: 'ui-btn', onclick: save }, 'Rename')));
}

function roleRow() {
  const sw = h('div', { class: 'mode-switch st-switch', role: 'group', 'aria-label': 'Club sync' }, ROLES.map(([k, label]) =>
    h('button', { type: 'button', class: 'mode-option', 'aria-pressed': String(club.role === k), onclick: () => {
      if (k === club.role && k !== 'board') return;
      if (k === 'board') { picking = !picking || club.role !== 'board'; draw(); return; }
      setRole(k);
    } }, h('span', {}, label))));
  const hint = ROLES.find(r => r[0] === club.role)?.[2] || '';
  return h('div', { class: 'st-row' }, h('span', { class: 'st-label' }, 'Club sync', h('span', { class: 'form-hint' }, hint)), sw);
}

// Pick the club host to sync with: the ones found on the network, or an address typed in
function clubPicker() {
  const list = others().filter(p => p.online && p.role === 'club');
  const addr = h('input', { class: 'ui-input nw-name', placeholder: 'or its address, e.g. 192.168.2.91:8080' });
  return h('div', { class: 'nw-sub' },
    list.length ? list.map(p => h('div', { class: 'nw-pick' }, h('b', {}, p.name), h('small', {}, p.address),
      h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => setRole('board', p) }, 'Sync'))) : muted('No club host found on the network. Make one PC the host first, or type its address.'),
    h('div', { class: 'nw-inline' }, addr, h('button', { type: 'button', class: 'ui-btn', onclick: () => addr.value.trim() && setRole('board', { address: addr.value.trim() }) }, 'Sync')));
}

function statusNote() {
  let text;
  let warn = false;
  if (club.role === 'board') {
    warn = club.status === 'offline';
    text = warn ? `The club host ${club.club_name || club.address} isn’t reachable. Games wait here and are sent when it’s back.`
      : club.status === 'ok' ? `Syncing with the club host ${club.club_name || club.address}. Members last synced ${club.synced_ago ?? 0} s ago.` : 'Connecting to the club host…';
    if (club.outbox) text += ` ${club.outbox} game${club.outbox === 1 ? '' : 's'} waiting to be sent.`;
  } else if (club.role === 'club') {
    text = `${club.games} game${club.games === 1 ? '' : 's'} saved on this PC. The clients sync the members from here.`;
    if (club.other_club) { warn = true; text = `${club.other_club.name} (${club.other_club.address}) is a club host too. Keep one: make the other PC a client.`; }
  } else {
    text = club.offer ? `${club.offer.name} is the club host on this network. Sync with it to share members and stats.` : `${club.games} game${club.games === 1 ? '' : 's'} saved on this PC.`;
  }
  const join = club.role === 'alone' && club.offer ? h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: () => setRole('board', club.offer) }, 'Sync') : null;
  return h('div', { class: `nw-note${warn ? ' is-warn' : ''}` }, icon('info', 16), h('span', {}, text), join);
}

// --- PCs on the network --------------------------------------------------------------------------------
function pcRow(p) {
  const tag = p.me ? 'This PC' : ROLE_TAG[p.role] || '';
  let state;
  if (!p.online) state = `Offline · last seen ${ago(p.seen_ago)}`;
  else if (club.role === 'club' && p.role === 'board' && p.synced_ago !== undefined) state = p.outbox ? `${p.outbox} game${p.outbox === 1 ? '' : 's'} waiting` : `Synced ${ago(p.synced_ago)}`;
  else state = 'Online';
  if (renaming === p.node) {
    const input = h('input', { class: 'ui-input nw-name', value: p.name, maxlength: 40, 'aria-label': `New name for ${p.name}` });
    const save = async () => {
      const name = input.value.trim();
      if (!name) return;
      if (name !== p.name && !await call('/api/club/rename-pc', { node: p.node, name })) return;
      renaming = null;
      load();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { renaming = null; draw(); } });
    setTimeout(() => input.focus());
    return h('div', { class: 'nw-pc' }, h('span', { class: 'nw-dot is-on' }), input,
      h('button', { type: 'button', class: 'ui-btn ui-btn-primary', onclick: save }, 'Save'),
      h('button', { type: 'button', class: 'ui-btn', onclick: () => { renaming = null; draw(); } }, 'Cancel'));
  }
  return h('div', { class: `nw-pc${p.online ? '' : ' is-off'}` },
    h('span', { class: `nw-dot${p.online ? ' is-on' : ''}` }),
    h('span', { class: 'nw-pc-name' }, h('b', {}, p.name || 'AutoGlow'), h('small', {}, [p.address, p.version && `v${p.version}`].filter(Boolean).join(' · '))),
    tag ? h('span', { class: `nw-tag${p.role === 'club' ? ' is-club' : ''}` }, tag) : null,
    h('span', { class: 'nw-state' }, state),
    p.me ? h('span', { class: 'nw-act' }) : p.online
      ? h('button', { type: 'button', class: 'ui-btn nw-act', onclick: () => { renaming = p.node; draw(); } }, 'Rename')
      : h('button', { type: 'button', class: 'ui-btn nw-act', title: 'Stop listing this PC', onclick: async () => { if (await call('/api/club/forget-pc', { node: p.node })) load(); } }, 'Forget'));
}

// Make another PC the club host: members, names and every game move there; this PC becomes its client
function handover() {
  const list = others().filter(p => p.online);
  const go = async p => {
    if (!await confirmDialog({ title: `Hand the club over to ${p.name}?`, body: `${p.name} gets the members and every game and becomes the club host. This PC becomes one of its clients, and the other clients follow on their own.`, confirmLabel: 'Hand over' })) return;
    toast.info?.('Handing over…');
    const r = await call('/api/club/handover', { address: p.address, node: p.node, name: p.name });
    if (r) { club = r; handing = false; toast.success(`${p.name} is now the club host.`); load(); }
  };
  return h('div', { class: 'nw-sub' }, list.length
    ? list.map(p => h('div', { class: 'nw-pick' }, h('b', {}, p.name), h('small', {}, p.address), h('button', { type: 'button', class: 'ui-btn', onclick: () => go(p) }, 'Hand over')))
    : muted('No other PC is online.'));
}

function draw() {
  const host = $('networkSettings');
  if (!host) return;
  const rows = [nameRow(), roleRow()];
  if (picking) rows.push(clubPicker());
  rows.push(statusNote());
  rows.push(h('div', { class: 'st-row nw-head' }, h('span', { class: 'st-label' }, 'PCs on this network', h('span', { class: 'form-hint' }, 'Every AutoGlow seen here. Offline PCs stay listed until you forget them.')),
    h('button', { type: 'button', class: 'ui-btn', onclick: () => load(true) }, icon('refresh', 16), 'Search')));
  rows.push(h('div', { class: 'nw-list' }, pcs.map(pcRow)));
  if (club.role === 'club') {
    rows.push(h('div', { class: 'st-row' }, h('span', { class: 'st-label' }, 'Move the club host', h('span', { class: 'form-hint' }, 'Hand the club over to another PC. Nothing is lost: the games move along.')),
      h('button', { type: 'button', class: 'ui-btn', onclick: () => { handing = !handing; draw(); } }, handing ? 'Close' : 'Choose a PC…')));
    if (handing) rows.push(handover());
  }
  if (club.role !== 'board') {
    rows.push(h('div', { class: 'st-row' }, h('span', { class: 'st-label' }, 'Club games', h('span', { class: 'form-hint' }, 'Every recorded game as one file, for a backup.')),
      h('button', { type: 'button', class: 'ui-btn', onclick: async () => {
        const data = await call('/api/club/export');
        if (data) h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: 'autoglow-club-games.json' }).click();
      } }, icon('download', 16), 'Export')));
  }
  host.replaceChildren(...rows);
}

async function load(scan = false) {
  const [c, n] = await Promise.all([call('/api/club/state'), call(`/api/club/network${scan ? '?scan=1' : ''}`)]);
  if (c) club = c;
  if (n) pcs = n.pcs;
  draw();
}

export function renderNetwork() {
  load(true);
}

export function initNetwork() {
  window.renderNetwork = renderNetwork;
  // Keep online/offline and sync state current while Settings is open (not while renaming)
  setInterval(() => {
    const host = $('networkSettings');
    if (!document.hidden && host?.offsetParent && renaming === null && !host.contains(document.activeElement?.matches?.('input') ? document.activeElement : null)) load();
  }, 10000);
}
