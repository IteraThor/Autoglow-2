// AutoGlow Studio output - live overlays: scoreboard, visit strip (darts, checkout zone, 9-darter) and player card

import { ctx, el, fmt, fmtAvg, avatar, displayName, studioPlayer, t, tn, eventTitle, eventSubtitle } from './ctx.js';
import { checkoutRoute } from './checkout.js';

const $ = id => document.getElementById(id);

export function renderBoard(state, prev) {
  const showSets = state.uses_sets;
  $('scoreboard').classList.toggle('no-sets', !showSets);
  $('boardTarget').textContent = state.target || state.variant || '';
  $('boardSetsLabel').textContent = t('board_sets');
  $('boardLegsLabel').textContent = t('board_legs');

  const rows = state.players.map((p, i) => {
    const row = el('div', 'board-row');
    if (i === state.active && !state.finished) row.classList.add('active');
    if (state.finished && state.winner === i) row.classList.add('winner');

    const name = el('div', 'board-name');
    name.append(avatar(p));
    name.append(el('span', 'name', displayName(p)));
    const country = studioPlayer(p)?.country || p.country;
    if (country) name.append(el('span', 'country', country));

    const sets = el('div', 'board-cell sets', showSets ? p.sets : '');
    const legs = el('div', 'board-cell', p.legs);
    const score = el('div', 'board-cell score', fmt(p.remaining));
    const old = prev?.players?.[i];
    if (old && old.remaining !== p.remaining) score.classList.add('flash');
    if (old && (old.legs !== p.legs || old.sets !== p.sets)) { legs.classList.add('flash'); sets.classList.add('flash'); }

    row.append(name, sets, legs, score, el('span', 'marker'));
    return row;
  });
  $('boardRows').replaceChildren(...rows);

  const parts = [eventTitle(''), eventSubtitle()].filter(Boolean);
  const progress = [state.uses_sets && state.set ? tn('board_set', state.set) : '', state.leg ? tn('board_leg', state.leg) : ''].filter(Boolean).join(' · ');
  $('boardTitle').textContent = [parts.join(' – '), progress].filter(Boolean).join('   |   ');
}

// Darts the player at the board still has in this visit
function dartsLeft(state) {
  const turn = state.turn || {};
  if (turn.player !== state.active || turn.busted) return 3;
  return Math.max(0, 3 - (turn.darts || []).length);
}

// "9-darter on": a 501 leg where every visit so far could still lead to a nine-dart finish
export function nineDarterOn(state, player) {
  if (state.base_score !== 501 || !player) return false;
  const darts = player.leg_stats?.dartsThrown;
  const rem = player.remaining;
  // Six darts score at most 180 + 170
  if (darts === 3) return rem <= 350 && rem >= 2;
  if (darts === 6) return !!checkoutRoute(rem, 3, state.out_mode || 'Double');
  return false;
}

export function renderVisit(state) {
  const visit = $('visit');
  const turn = state.turn || {};
  const darts = turn.darts || [];
  const active = state.players[state.active];
  const showCheckout = ctx.settings?.show_checkout !== false;
  let route = [];
  if (showCheckout && active && !state.finished) {
    route = state.checkout?.length ? state.checkout : (checkoutRoute(active.remaining, dartsLeft(state), state.out_mode || 'Double') || []);
  }
  const nine = active && !state.finished && nineDarterOn(state, active);
  if (state.finished || (!darts.length && !route.length && !nine)) { visit.hidden = true; return; }

  const items = [];
  for (let i = 0; i < 3; i++) items.push(el('div', darts[i] ? 'dart' : 'dart empty', darts[i] || '•'));
  if (darts.length) items.push(el('div', turn.busted ? 'total bust' : 'total', turn.busted ? t('visit_bust') || fmt(turn.points) : fmt(turn.points)));
  if (route.length) {
    const co = el('div', 'checkout');
    if (t('visit_checkout')) co.append(el('small', null, tn('visit_checkout', fmt(active.remaining))));
    co.append(document.createTextNode(route.join(' ')));
    items.push(co);
  }
  if (nine && t('visit_nine')) items.push(el('div', 'nine', t('visit_nine')));
  visit.replaceChildren(...items);
  visit.hidden = false;
}

export function renderPlayerCard(state) {
  const card = $('playerCard');
  if (ctx.settings?.show_player_card === false || state.players.length !== 2) { card.hidden = true; return; }
  const head = el('div', 'pc-head', state.variant ? `${state.variant}${state.base_score ? ' ' + state.base_score : ''}` : 'Match');
  const faces = el('div', 'pc-faces');
  const values = el('div', 'pc-values');
  state.players.forEach((p, i) => {
    const face = el('div', 'pc-face');
    if (i === state.active && !state.finished) face.classList.add('active');
    face.append(avatar(p, 'pc-img'), el('span', 'pc-name', displayName(p)));
    faces.append(face);
    const v = el('div', null, fmtAvg(p.average));
    v.append(el('small', null, t('card_avg')));
    values.append(v);
  });
  const foot = el('div', 'pc-foot', (state.round && tn('card_round', state.round)) || eventTitle(''));
  card.replaceChildren(head, faces, values, foot);
  card.hidden = false;
}
