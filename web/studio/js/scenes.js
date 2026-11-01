// AutoGlow Studio output - full-screen scenes: idle slides, versus intro, stinger, leg summary,
// match end and the big moments (180, game shot, bust). Only transform/opacity are animated.

import { el, fmt, fmtAvg, sleep, avatar, displayName, profile, pictureUrl, studioPlayersAsPlayers, t, eventTitle, eventSubtitle } from './ctx.js';

const $ = id => document.getElementById(id);
export const INTRO_MS = 7500;
export const LEG_CARD_MS = 6500;
export const SLIDE_MS = 8000;
export const STINGER_COVER_MS = 520;
export const STINGER_MS = 1250;

// --- Stinger: a short wipe that hides every scene change -------------------------------------
export async function stinger(onCover) {
  const box = $('stinger');
  box.classList.remove('run');
  void box.offsetWidth; // restart the animation
  box.classList.add('run');
  await sleep(STINGER_COVER_MS);
  if (onCover) onCover();
  await sleep(STINGER_MS - STINGER_COVER_MS);
  box.classList.remove('run');
}

// --- Idle: the event title; once two players are picked in the Autodarts lobby, the pre-match slides
// (versus card, then each player's card) -------------------------------------------------------
let slideTimer = null;
let slideIndex = 0;
let clockTimer = null;
let lobby = null;      // { players, variant, base_score, target } of the open Autodarts lobby
let lobbyKey = '';

function brandSlide() {
  const s = el('div', 'slide slide-brand');
  s.append(
    el('div', 'sb-kicker', t('idle_kicker')),
    el('div', 'sb-title', eventTitle()),
    el('div', 'sb-sub', eventSubtitle() || t('idle_tagline'))
  );
  return s;
}

function factRow(label, value) {
  if (!value || !label) return null;
  const row = el('div', 'fact');
  row.append(el('span', null, label), el('strong', null, value));
  return row;
}

function playerSlide(player) {
  const p = profile(player);
  const s = el('div', 'slide slide-player');
  const pic = el('div', 'sp-pic');
  pic.append(avatar(player, 'sp-img'));
  const info = el('div', 'sp-info');
  info.append(
    el('div', 'sp-kicker', p.club || t('idle_player_kicker')),
    el('div', 'sp-name', p.name),
    p.nickname ? el('div', 'sp-nick', `“${p.nickname}”`) : '',
    el('div', 'sp-facts', null)
  );
  info.lastChild.append(...[
    factRow(t('fact_from'), [p.hometown, p.country].filter(Boolean).join(', ')),
    factRow(t('fact_throws'), p.hand), factRow(t('fact_darts'), p.dartWeight && `${p.dartWeight} g`),
    factRow(t('stat_fav_double'), p.favouriteDouble), factRow(t('fact_since'), p.playingSince)
  ].filter(Boolean));
  const stats = el('div', 'sp-stats');
  for (const [label, value] of [[t('stat_average'), p.average], [t('stat_180s'), p.oneEighties], [t('stat_best_checkout'), p.bestCheckout]]) {
    if (!value || !label) continue;
    const b = el('div', 'sp-stat');
    b.append(el('strong', null, value), el('span', null, label));
    stats.append(b);
  }
  info.append(stats);
  s.append(pic, info);
  return s;
}

// The two players picked in the lobby, face to face, with the format
function versusSlide(a, b, info) {
  const s = el('div', 'slide slide-result slide-versus');
  s.append(el('div', 'sb-kicker', t('lobby_kicker')));
  const row = el('div', 'sr-row');
  for (const [i, p] of [a, b].entries()) {
    const side = el('div', 'sr-side won');
    side.append(avatar(p, 'sr-img'), el('div', 'sr-name', displayName(p)));
    const avg = profile(p).average;
    if (avg) side.append(el('div', 'sr-avg', `${avg} avg`));
    row.append(side);
    if (i === 0) row.append(el('div', 'sr-score', t('intro_vs') || 'VS'));
  }
  s.append(row);
  const format = [info?.variant, info?.base_score, info?.target].filter(Boolean).join(' · ');
  if (format) s.append(el('div', 'sb-sub', format));
  return s;
}

// Two picked players: the pre-match slides; otherwise only the title (other player counts are not handled yet)
function idleSlides() {
  const players = lobby?.players || [];
  if (players.length !== 2) return [brandSlide];
  const [a, b] = players;
  return [() => versusSlide(a, b, lobby), () => playerSlide(a), () => playerSlide(b)];
}

function showNextSlide() {
  const host = $('idleSlides');
  const slides = idleSlides();
  // A single slide stays put instead of replaying its entrance every few seconds
  if (slides.length === 1 && slideIndex > 0 && host.querySelector('.slide:not(.out)')) return;
  const slide = slides[slideIndex % slides.length]();
  slideIndex++;
  host.querySelectorAll('.slide').forEach(old => {
    old.classList.add('out');
    setTimeout(() => old.remove(), 700);
  });
  host.append(slide);
}

// The open lobby from the game state; a different set of players restarts the slides with the versus card
export function setLobby(next) {
  const key = JSON.stringify((next?.players || []).map(p => [p.name, p.studio_id || '']).concat([next?.target || '', next?.base_score || '']));
  lobby = next;
  if (key === lobbyKey) return;
  lobbyKey = key;
  if (slideTimer) startIdle();
}

export const lobbyReady = () => (lobby?.players || []).length === 2;

function tickClock() {
  const now = new Date();
  $('idleClock').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function startIdle() {
  stopIdle();
  slideIndex = 0;
  showNextSlide();
  slideTimer = setInterval(showNextSlide, SLIDE_MS);
  tickClock();
  clockTimer = setInterval(tickClock, 10000);
}

// One idle slide kept on screen (preview of the texts): brand, player or the pre-match versus card
export function showIdleSlide(kind, sample) {
  stopIdle();
  const players = sample?.players?.length >= 2 ? sample.players : studioPlayersAsPlayers();
  const make = kind === 'player' && players.length ? () => playerSlide(players[0])
    : kind === 'versus' && players.length >= 2 ? () => versusSlide(players[0], players[1], sample)
      : brandSlide;
  $('idleSlides').replaceChildren(make());
  tickClock();
}

export function stopIdle() {
  clearInterval(slideTimer);
  clearInterval(clockTimer);
  slideTimer = null;
}

// --- Versus intro ----------------------------------------------------------------------------
function introSide(player, side) {
  const p = profile(player);
  const box = el('div', `intro-side ${side}`);
  const pic = el('div', 'intro-pic');
  pic.append(avatar(player, 'intro-img'));
  const info = el('div', 'intro-info');
  info.append(
    p.club ? el('div', 'intro-club', p.club) : '',
    el('div', 'intro-name', p.name),
    p.nickname ? el('div', 'intro-nick', `“${p.nickname}”`) : '',
    el('div', 'intro-meta', [p.hometown, p.country, p.hand && `${p.hand}-handed`, p.dartWeight && `${p.dartWeight} g`].filter(Boolean).join('  ·  '))
  );
  box.append(pic, info);
  return box;
}

function introStats(a, b) {
  const pa = profile(a);
  const pb = profile(b);
  const rows = [[t('stat_average'), pa.average, pb.average], [t('stat_180s'), pa.oneEighties, pb.oneEighties],
    [t('stat_best_checkout'), pa.bestCheckout, pb.bestCheckout], [t('stat_fav_double'), pa.favouriteDouble, pb.favouriteDouble]]
    .filter(([label, x, y]) => label && (x || y));
  const box = el('div', 'intro-stats');
  for (const [label, x, y] of rows) {
    const row = el('div', 'is-row');
    const nx = parseFloat(x);
    const ny = parseFloat(y);
    const both = Number.isFinite(nx) && Number.isFinite(ny) && nx + ny > 0;
    const left = el('div', 'is-val left', x || '–');
    const right = el('div', 'is-val right', y || '–');
    const mid = el('div', 'is-label', label);
    if (both) {
      // Bars from the centre, longer for the better value
      const bar = el('div', 'is-bar');
      const l = el('i', 'l');
      const r = el('i', 'r');
      l.style.setProperty('--w', `${(nx / (nx + ny)) * 100}%`);
      r.style.setProperty('--w', `${(ny / (nx + ny)) * 100}%`);
      bar.append(l, r);
      mid.append(bar);
    }
    row.append(left, mid, right);
    box.append(row);
  }
  return box;
}

export async function playIntro(state) {
  const box = $('intro');
  const [a, b] = state.players;
  const top = el('div', 'intro-top');
  top.append(el('span', null, eventTitle()),
    el('strong', null, [state.variant, state.base_score, state.target].filter(Boolean).join(' · ') || 'Match'));
  const parts = [top, introSide(a, 'left')];
  if (b) parts.push(el('div', 'intro-vs', t('intro_vs')), introSide(b, 'right'), introStats(a, b));
  box.replaceChildren(...parts);
  box.classList.toggle('solo', !b);
  box.hidden = false;
  box.classList.remove('out');
  void box.offsetWidth;
  box.classList.add('in');
  await sleep(INTRO_MS);
}

export function hideIntro() {
  const box = $('intro');
  box.classList.remove('in');
  box.hidden = true;
}

// --- Leg summary ------------------------------------------------------------------------------
// hold: stay on screen until hideLegCard() (preview of the texts)
export async function showLegCard(info, { hold = false } = {}) {
  const box = $('legCard');
  const head = el('div', 'lc-head');
  head.append(el('span', null, info.label), el('strong', null, info.title));
  const who = el('div', 'lc-who');
  who.append(avatar(info.player, 'lc-img'), el('div', 'lc-name', displayName(info.player)));
  const grid = el('div', 'lc-grid');
  for (const [label, value] of [[t('stat_darts'), info.darts], [t('stat_leg_average'), info.average], [t('stat_checkout'), info.checkout], [t('stat_180s'), info.oneEighties]]) {
    if (value === null || value === undefined || value === '' || !label) continue;
    const cell = el('div', 'lc-cell');
    cell.append(el('strong', null, value), el('span', null, label));
    grid.append(cell);
  }
  box.replaceChildren(head, who, grid);
  box.hidden = false;
  box.classList.remove('out');
  void box.offsetWidth;
  box.classList.add('in');
  if (hold) return;
  await sleep(LEG_CARD_MS);
  hideLegCard();
}

export async function hideLegCard() {
  const box = $('legCard');
  if (box.hidden) return;
  box.classList.add('out');
  await sleep(450);
  box.hidden = true;
  box.classList.remove('in', 'out');
}

// --- Match end --------------------------------------------------------------------------------
export function showMatchCard(state, extra) {
  const box = $('matchCard');
  const winner = state.players[state.winner ?? 0];
  const pic = el('div', 'mc-pic');
  pic.append(avatar(winner, 'mc-img'));
  const side = el('div', 'mc-side');
  const score = state.players.map(p => (state.uses_sets ? p.sets : p.legs)).join(' – ');
  side.append(el('div', 'mc-kicker', t('match_winner')), el('div', 'mc-name', displayName(winner)), el('div', 'mc-score', score));

  const table = el('div', 'mc-table');
  const head = el('div', 'mc-row mc-headrow');
  head.append(el('span', null, ''), ...state.players.map(p => el('strong', null, displayName(p))));
  table.append(head);
  const stat = (p, key) => p.match_stats?.[key];
  const rows = [
    [t('stat_average'), p => fmtAvg(p.average)],
    [t('stat_first9'), p => fmtAvg(stat(p, 'first9Average'))],
    [t('stat_180s'), p => fmt(stat(p, 'total180') ?? 0)],
    [t('stat_140'), p => fmt(stat(p, 'plus140') ?? 0)],
    [t('stat_100'), p => fmt(stat(p, 'plus100') ?? 0)],
    [t('stat_checkout_pct'), p => (typeof stat(p, 'checkoutPercent') === 'number' ? `${Math.round(stat(p, 'checkoutPercent') * (stat(p, 'checkoutPercent') <= 1 ? 100 : 1))}%` : '–')],
    [t('stat_best_checkout'), p => fmt(extra.bestCheckout[p.index]) || '–'],
    [t('stat_darts'), p => fmt(stat(p, 'dartsThrown')) || '–']
  ];
  for (const [label, value] of rows) {
    if (!label) continue;
    const row = el('div', 'mc-row');
    row.append(el('span', null, label), ...state.players.map(p => el('strong', null, value(p))));
    table.append(row);
  }
  side.append(table);
  box.replaceChildren(pic, side);
  box.hidden = false;
  void box.offsetWidth;
  box.classList.add('in');
}

export function hideMatchCard() {
  const box = $('matchCard');
  box.classList.remove('in');
  box.hidden = true;
}

// --- Big moments ------------------------------------------------------------------------------
let momentTimer = null;

export function hideMoment() {
  clearTimeout(momentTimer);
  $('moment').hidden = true;
}

// hold: stay on screen until hideMoment() (preview of the texts)
export function showMoment(kind, big, sub, player, { hold: keep = false } = {}) {
  // Its text switched off in the Studio: no banner (the text preview still shows where it would be)
  if (!big && !keep) return Promise.resolve();
  const box = $('moment');
  clearTimeout(momentTimer);
  box.className = `moment ${kind}`;
  const children = [];
  if (player && (kind === 'match' || kind === 'nine' || kind === 'bulloff') && pictureUrl(player)) {
    const img = el('img', 'm-pic');
    img.src = pictureUrl(player);
    img.onerror = () => img.remove();
    children.push(img);
  }
  children.push(el('div', 'm-big', big));
  if (sub) children.push(el('div', 'm-sub', sub));
  box.replaceChildren(...children);
  box.hidden = false;
  if (keep) return Promise.resolve();
  const hold = kind === 'match' || kind === 'nine' ? 6000 : kind === 'bulloff' ? 4500 : kind === 'bust' ? 1800 : 3200;
  momentTimer = setTimeout(() => {
    box.classList.add('out');
    momentTimer = setTimeout(() => { box.hidden = true; }, 400);
  }, hold);
  return sleep(hold + 400);
}
