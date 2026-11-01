// AutoGlow Studio output - bull-off before the first leg: the rule, each player's dart (distance to the
// bull centre), who is closest, a zoomed bull target with the darts and their distance rings, and the
// winner who throws first. Data: /api/studio/state › bull_off (core/studio.py build_bull_off).

import { el, avatar, displayName, t, tn } from './ctx.js';
import { buildBoard, svg, R } from './dartboard.js';

const $ = id => document.getElementById(id);
// Marker colour per throwing order
const COLORS = ['var(--accent)', '#f5b301', '#22c55e', '#ef4444', '#a855f7', '#06b6d4'];
const BOARD_MM = 170;   // Autodarts coordinates: 1.0 = outer edge of the double ring
const MIN_VIEW_MM = 40; // the target never zooms in closer than this around the bull

const official = bo => String(bo.mode || '').toLowerCase() === 'official';
const fmtMm = d => `${d.toFixed(1)} mm`;

let target = null;      // { root, zoom, rings, darts } of the bull target
let seenDarts = new Set();
let key = '';

function ensureTarget() {
  if (target) return target;
  const { root, heat, darts } = buildBoard();
  root.classList.add('bo-svg');
  heat.remove();
  darts.remove();
  // Everything is zoomed together around the bull (the viewBox is centred on it)
  const zoom = svg('g', { class: 'bo-zoom' });
  while (root.firstChild) zoom.append(root.firstChild);
  const rings = svg('g', { class: 'bo-rings' });
  const marks = svg('g', { class: 'bo-marks' });
  zoom.append(rings, marks);
  root.append(zoom);
  target = { root, zoom, rings, marks };
  return target;
}

function dartResult(bo, p) {
  if (!p.thrown) return { big: '–', small: '' };
  const label = p.label ? String(p.label).toUpperCase() : '';
  // PDC rule: only Bull and 25 count, so the segment is the result; WDF: the distance
  if (official(bo)) return { big: label || fmtMm(p.distance), small: label ? fmtMm(p.distance) : '' };
  return { big: fmtMm(p.distance), small: label };
}

function playerRow(bo, p, i, fresh) {
  const row = el('div', 'bo-row');
  row.style.setProperty('--pc', COLORS[i % COLORS.length]);
  const decided = bo.decided && bo.winner !== null;
  row.classList.toggle('active', bo.active === i && !p.thrown);
  row.classList.toggle('leader', !decided && bo.leader === i);
  row.classList.toggle('winner', decided && bo.winner === i);
  row.classList.toggle('loser', decided && bo.winner !== i);
  const pic = el('div', 'bo-pic');
  pic.append(avatar(p, 'bo-img'));
  const who = el('div', 'bo-who');
  who.append(el('div', 'bo-name', displayName(p)));
  const badge = decided && bo.winner === i ? t('bulloff_first')
    : !decided && bo.leader === i ? t('bulloff_leader')
      : bo.active === i && !p.thrown ? t('bulloff_turn') : '';
  if (badge) who.append(el('div', 'bo-badge', badge));
  const res = dartResult(bo, p);
  const result = el('div', 'bo-result');
  result.append(el('strong', fresh.has(i) ? 'fresh' : null, res.big));
  if (res.small) result.append(el('span', null, res.small));
  row.append(el('i', 'bo-dot'), pic, who, result);
  return row;
}

function historyLine(bo) {
  if (!bo.history?.length) return null;
  const box = el('div', 'bo-history');
  for (const h of bo.history) {
    const darts = h.darts.map(d => (d.thrown ? (official(bo) ? (d.label || fmtMm(d.distance)) : fmtMm(d.distance)) : '–')).join('  ·  ');
    const line = el('div', null);
    line.append(el('span', null, tn('bulloff_round', h.round) || `#${h.round}`), el('strong', null, darts));
    if (t('bulloff_tie')) line.append(el('em', null, t('bulloff_tie')));
    box.append(line);
  }
  return box;
}

// How far the target zooms in: the farthest dart (or the outer bull) fills about 80 % of the view
function zoomFor(bo) {
  const far = Math.max(MIN_VIEW_MM, ...bo.players.filter(p => p.thrown).map(p => p.distance * 1.3));
  return Math.max(1, Math.min(9, (1.25 * BOARD_MM) / far));
}

function drawTarget(bo, freshSet) {
  const { zoom, rings, marks } = ensureTarget();
  const k = zoomFor(bo);
  zoom.style.transform = `scale(${k.toFixed(3)})`;
  const ringEls = [];
  const markEls = [];
  bo.players.forEach((p, i) => {
    if (!p.thrown) return;
    const fresh = freshSet.has(i);
    const color = COLORS[i % COLORS.length];
    const winner = bo.decided && bo.winner === i;
    // Distance ring: how far from the bull centre the dart is (Autodarts draws the same)
    const ring = svg('circle', { r: (p.distance / BOARD_MM).toFixed(5), class: `bo-ring${fresh ? ' grow' : ''}${winner ? ' win' : ''}` });
    ring.style.stroke = color;
    ringEls.push(ring);
    const g = svg('g', { transform: `translate(${(p.x || 0).toFixed(5)} ${(-(p.y || 0)).toFixed(5)})` });
    const pop = svg('g', { class: `bo-mark${fresh ? ' pop' : ''}` });
    // Markers keep their size on screen whatever the zoom
    pop.style.transform = `scale(${(1 / k).toFixed(4)})`;
    const dot = svg('circle', { r: 0.075, class: 'bo-mark-dot' });
    dot.style.fill = color;
    const num = svg('text', { y: 0.034, class: 'bo-mark-num' });
    num.textContent = i + 1;
    pop.append(dot, num);
    g.append(pop);
    markEls.push(g);
  });
  rings.replaceChildren(...ringEls);
  marks.replaceChildren(...markEls);
}

// Draw the bull-off; called on every state, rebuilt only when something changed
export function renderBullOff(bo) {
  const box = $('bullOff');
  if (!box || !bo) return;
  const next = JSON.stringify([bo.match_id, bo.mode, bo.round, bo.active, bo.decided, bo.winner, bo.leader, bo.history?.length,
    bo.players.map(p => [displayName(p), p.thrown, p.distance, p.label, p.avatar_url, p.studio_id])]);
  if (next === key) return;
  key = next;
  // Darts not drawn before pop in; the others stay put when the scene is redrawn
  const fresh = new Set();
  bo.players.forEach((p, i) => {
    const id = `${bo.match_id}:${bo.round}:${i}:${p.distance}`;
    if (p.thrown && !seenDarts.has(id)) fresh.add(i);
    if (p.thrown) seenDarts.add(id);
  });
  const enter = !box.firstChild || box.dataset.match !== String(bo.match_id);
  box.dataset.match = String(bo.match_id);
  const head = el('div', 'bo-head');
  head.append(el('div', 'bo-kicker', t('bulloff_title')));
  const rule = official(bo) ? t('bulloff_rule_official') : t('bulloff_rule_normal');
  if (rule) head.append(el('div', 'bo-rule', rule));
  if (bo.round > 1 && t('bulloff_round')) head.append(el('div', 'bo-round', tn('bulloff_round', bo.round)));
  const panel = el('div', `bo-panel${enter ? ' enter' : ''}`);
  if (enter) head.classList.add('enter');
  panel.append(...bo.players.map((p, i) => playerRow(bo, p, i, fresh)));
  const hist = historyLine(bo);
  if (hist) panel.append(hist);
  const tgt = el('div', `bo-target${enter ? ' enter' : ''}`);
  drawTarget(bo, fresh);
  tgt.append(target.root);
  box.replaceChildren(head, panel, tgt);
}

// The darts of the round before a tie, kept on screen for the tie banner (Autodarts clears them at once)
export function tieView(bo) {
  const last = bo.history?.[bo.history.length - 1];
  if (!last) return bo;
  return {
    ...bo, round: last.round, active: null, leader: null, history: bo.history.slice(0, -1),
    players: bo.players.map((p, i) => ({ ...p, ...last.darts[i] }))
  };
}

// A new bull-off (or the scene shown again): its darts may pop in again
export function resetBullOff() {
  seenDarts = new Set();
  key = '';
  const box = $('bullOff');
  if (box) box.replaceChildren();
}
