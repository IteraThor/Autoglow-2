// AutoGlow 2 - Players: the coach tabs of one member (overview card, progress, heat map, doubles,
// games with a report per game, compare). Data from /api/club/coach and /api/club/game
// (src/club/coach.rs). Board coordinates are 1.0 at the outer edge of the double ring, +y to the 20.

import { api } from '../core/api.js';
import { esc, h } from '../core/dom.js';
import { avatar, icon } from './studio-core.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const R = { bull: 6.35, b25: 15.9, tIn: 99, tOut: 107, dIn: 162, dOut: 170 };
const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '–');
const when = s => (s ? new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const short = s => (s ? new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const panel = (title, ...body) => h('div', { class: 'pl-panel' }, title ? h('h3', { class: 'stu-h' }, title) : null, ...body);
const muted = text => h('p', { class: 'pl-muted' }, text);
const NO_DARTS = 'Dart detail starts with games played from AutoGlow v0.47.0 on: every dart is saved with where it landed.';

// Practice drills the coach recommends
export const DRILLS = {
  grouping: { name: '20s grouping', what: '30 darts at the 20. Judge only how close together they land, not the score.' },
  ladder: { name: '40 → 20 → 10', what: 'Play out 40 like a match: a single 20 leaves D10, a single 10 leaves D5. Count the darts per finish.' },
  bobs27: { name: 'Bob’s 27', what: 'Start on 27. Three darts at each double from D1 to D20, then bull: a hit adds its value, three misses take the double off.' },
  doubles: { name: 'Doubles around the clock', what: 'D1 to D20 and bull in order: move on with each hit. Count the darts.' },
  scoring20: { name: 'T20 scoring, 30 darts', what: 'Ten visits at T20 with the same rhythm. Beat your total next time.' },
  scoring19: { name: 'T19 scoring, 30 darts', what: 'Ten visits at T19. With a wide group it scores more than T20.' }
};

// --- Board ---------------------------------------------------------------------------------------------
const pt = (r, deg) => [r * Math.sin(deg * Math.PI / 180), -r * Math.cos(deg * Math.PI / 180)];
function wedge(r1, r2, a0, a1) {
  const [x1, y1] = pt(r2, a0), [x2, y2] = pt(r2, a1), [x3, y3] = pt(r1, a1), [x4, y4] = pt(r1, a0);
  return `M${x1.toFixed(2)},${y1.toFixed(2)}A${r2},${r2} 0 0 1 ${x2.toFixed(2)},${y2.toFixed(2)}L${x3.toFixed(2)},${y3.toFixed(2)}A${r1},${r1} 0 0 0 ${x4.toFixed(2)},${y4.toFixed(2)}Z`;
}

// The board as SVG markup in mm (viewBox -200..200). `doubleFill(n)` may colour the double ring.
function boardSvg({ doubleFill = null } = {}) {
  let s = '';
  ORDER.forEach((n, i) => {
    const a0 = i * 18 - 9, a1 = a0 + 18, odd = i % 2;
    s += `<path d="${wedge(R.b25, R.tIn, a0, a1)}" class="pl-b-s${odd}"/><path d="${wedge(R.tOut, R.dIn, a0, a1)}" class="pl-b-s${odd}"/>`;
    s += `<path d="${wedge(R.tIn, R.tOut, a0, a1)}" class="pl-b-r${odd}"/>`;
    const fill = doubleFill?.(n);
    s += `<path d="${wedge(R.dIn, R.dOut, a0, a1)}" class="pl-b-r${odd}"${fill ? ` style="fill:${fill}"` : ''}/>`;
    const [tx, ty] = pt(184, i * 18);
    s += `<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" class="pl-b-num" text-anchor="middle" dominant-baseline="central">${n}</text>`;
  });
  const bullFill = doubleFill?.(25);
  s += `<circle r="${R.b25}" class="pl-b-r1"/><circle r="${R.bull}" class="pl-b-r0"${bullFill ? ` style="fill:${bullFill}"` : ''}/>`;
  return `<svg class="pl-board-svg" viewBox="-200 -200 400 400" xmlns="${SVGNS}" aria-hidden="true">${s}</svg>`;
}

// A sequential ramp (teal → yellow → red) as 256 [r,g,b]
const RAMP = (() => {
  const stops = [[0, [20, 184, 166]], [0.55, [250, 204, 21]], [1, [244, 63, 94]]];
  return Array.from({ length: 256 }, (_, i) => {
    const t = i / 255;
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const f = (t - t0) / (t1 - t0);
    return c0.map((c, j) => Math.round(c + (c1[j] - c) * f));
  });
})();
// Hit rates: red (poor) → amber → teal (good)
const GOOD = [[0, [244, 63, 94]], [0.5, [250, 204, 21]], [1, [20, 184, 166]]];
const goodCss = t => {
  t = Math.max(0, Math.min(1, t));
  const k = t > 0.5 ? 1 : 0, [t0, c0] = GOOD[k], [t1, c1] = GOOD[k + 1], f = (t - t0) / (t1 - t0);
  return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * f)).join(',')})`;
};
const rampCss = t => { const c = RAMP[Math.max(0, Math.min(255, Math.round(t * 255)))]; return `rgb(${c[0]},${c[1]},${c[2]})`; };

// The board, a canvas for heat on it, and marks on top of both
function boardBox(svg, canvas = true, marks = '') {
  const box = h('div', { class: 'pl-board' });
  box.innerHTML = svg;
  const c = canvas ? h('canvas', { class: 'pl-board-heat', width: 640, height: 640 }) : null;
  if (c) box.append(c);
  if (marks) box.insertAdjacentHTML('beforeend', `<svg class="pl-board-svg pl-board-top" viewBox="-200 -200 400 400" xmlns="${SVGNS}" aria-hidden="true">${marks}</svg>`);
  return { box, canvas: c };
}
// Board units (−1..1, +y up) to canvas pixels for a 400-mm viewBox
const toPx = (W, x, y) => [((x * 170) + 200) / 400 * W, ((-y * 170) + 200) / 400 * W];

function drawHeat(canvas, points, mode) {
  const W = canvas.width, ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, W);
  if (!points.length) return;
  if (mode === 'dots') {
    for (const [x, y, k] of points) {
      const [px, py] = toPx(W, x, y);
      ctx.beginPath();
      ctx.arc(px, py, 4.2, 0, Math.PI * 2);
      ctx.fillStyle = k === 1 ? 'rgba(250, 204, 21, .9)' : k === 2 ? 'rgba(161, 161, 170, .75)' : 'rgba(45, 212, 191, .9)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.stroke();
    }
    return;
  }
  // Density: soft blobs add up, then the sum is coloured with the ramp
  const off = document.createElement('canvas');
  off.width = off.height = W;
  const o = off.getContext('2d');
  const rad = W * (points.length > 600 ? 0.028 : 0.04);
  for (const [x, y] of points) {
    const [px, py] = toPx(W, x, y);
    const g = o.createRadialGradient(px, py, 0, px, py, rad);
    g.addColorStop(0, 'rgba(0,0,0,.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    o.fillStyle = g;
    o.fillRect(px - rad, py - rad, rad * 2, rad * 2);
  }
  const img = o.getImageData(0, 0, W, W), d = img.data;
  let max = 1;
  for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i];
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / max;
    if (a < 0.04) { d[i + 3] = 0; continue; }
    const c = RAMP[Math.round(a * 255)];
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
    d[i + 3] = Math.round(Math.min(1, 0.25 + a) * 215);
  }
  ctx.putImageData(img, 0, 0);
}

function drawAim(canvas, aim) {
  const W = canvas.width, ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, W);
  const n = aim.cells, vals = aim.map;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  ctx.save();
  ctx.beginPath();
  const [cx, cy] = toPx(W, 0, 0);
  ctx.arc(cx, cy, W * 170 / 400, 0, Math.PI * 2);
  ctx.clip();
  const cell = (W * 340 / 400) / n, x0 = W * 30 / 400;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const t = (vals[r * n + c] - lo) / (hi - lo || 1);
    ctx.fillStyle = rampCss(t);
    ctx.globalAlpha = 0.18 + 0.62 * t;
    ctx.fillRect(x0 + c * cell, x0 + r * cell, cell + 0.6, cell + 0.6);
  }
  ctx.restore();
}

// Marks drawn in SVG above the canvas: the spread ellipse, the drift arrow, targets
function overlay(detail, showAim) {
  let s = '';
  const sp = detail.spread, dr = detail.drift;
  const T20 = [0, -103];
  if (sp && !showAim) {
    const cx = T20[0] + (dr?.x || 0), cy = T20[1] - (dr?.y || 0);
    s += `<ellipse cx="${cx}" cy="${cy}" rx="${sp.x * 1.1774}" ry="${sp.y * 1.1774}" class="pl-ellipse"/>`;
    if (dr && Math.hypot(dr.x, dr.y) >= 3) s += `<line x1="${T20[0]}" y1="${T20[1]}" x2="${cx}" y2="${cy}" class="pl-drift"/><circle cx="${cx}" cy="${cy}" r="3" class="pl-drift-dot"/>`;
    s += `<circle cx="${T20[0]}" cy="${T20[1]}" r="2.5" class="pl-aim-dot"/>`;
  }
  if (showAim && detail.aim) {
    for (const t of detail.aim.targets) {
      const x = t.x * 170, y = -t.y * 170;
      s += `<circle cx="${x}" cy="${y}" r="4" class="pl-aim-dot"/><text x="${x + 8}" y="${y + 4}" class="pl-aim-lbl">${esc(t.label)} ${t.points.toFixed(1)}</text>`;
    }
    const b = detail.aim.best;
    s += `<circle cx="${b.x * 170}" cy="${-b.y * 170}" r="9" class="pl-aim-best"/>`;
  }
  return s;
}

// --- Small pieces --------------------------------------------------------------------------------------
function tile(label, value, hint, cls = '') {
  return h('div', { class: `pl-tile ${cls}` }, h('small', {}, label), h('b', {}, value), hint ? h('span', {}, hint) : null);
}

// "▲ 2.3" / "▼ 1.1", coloured by whether that is better
function delta(now, before, lowerBetter = false, d = 1) {
  if (typeof now !== 'number' || typeof before !== 'number') return null;
  const diff = now - before;
  if (Math.abs(diff) < 10 ** -d / 2) return h('span', { class: 'pl-delta' }, '±0');
  const good = lowerBetter ? diff < 0 : diff > 0;
  return h('span', { class: `pl-delta ${good ? 'is-good' : 'is-bad'}` }, `${diff > 0 ? '▲' : '▼'} ${Math.abs(diff).toFixed(d)}`);
}

function segmented(items, current, onPick, cls = '') {
  return h('div', { class: `pl-seg ${cls}`, role: 'tablist' }, items.map(([k, label]) =>
    h('button', { type: 'button', role: 'tab', class: k === current ? 'is-on' : '', 'aria-selected': String(k === current), onclick: () => onPick(k) }, label)));
}

function hbar(label, pctVal, note, cls = '') {
  return h('div', { class: `pl-hbar ${cls}` }, h('span', { class: 'pl-hbar-l' }, label),
    h('span', { class: 'pl-hbar-t' }, h('i', { style: `width:${Math.max(0, Math.min(100, pctVal || 0))}%` })),
    h('span', { class: 'pl-hbar-v' }, note));
}

// --- Overview: the coach card and personal bests ------------------------------------------------------------
export function coachCard(c) {
  const tips = c.tips || [];
  const work = tips.filter(t => t.kind === 'work'), good = tips.filter(t => t.kind === 'strength');
  const f = c.focus;
  const focus = f ? h('div', { class: 'pl-focus' },
    h('small', {}, 'This month’s focus'),
    h('div', { class: 'pl-focus-row' }, h('b', {}, f.metric.label),
      h('span', { class: 'pl-focus-num' }, typeof f.now === 'number' ? `${fmt(f.now)}${f.metric.unit === '%' ? '%' : f.metric.unit ? ` ${f.metric.unit}` : ''}` : '–'),
      delta(f.now, f.before, f.metric.better === 'down'),
      h('span', { class: 'pl-muted' }, typeof f.before === 'number' ? `last month ${fmt(f.before)}` : 'no games last month'))) : null;
  const tipEl = t => h('div', { class: `pl-tipcard is-${t.kind}` },
    h('span', { class: 'pl-tipcard-ic' }, icon(t.kind === 'strength' ? 'trophy' : 'target', 18)),
    h('div', {}, h('b', {}, t.title), h('p', {}, t.text),
      t.drill && DRILLS[t.drill] ? h('p', { class: 'pl-drill' }, h('b', {}, `Drill: ${DRILLS[t.drill].name}. `), DRILLS[t.drill].what) : null));
  const empty = !work.length && !good.length;
  return panel('Coach',
    focus,
    empty ? muted(c.detail?.darts ? 'Nothing stands out yet. The coach needs a few more games with darts to compare.' : NO_DARTS) : null,
    ...work.map(tipEl), ...good.map(tipEl));
}

export function recordsPanel(c, openGame) {
  const r = c.records || { bests: [], milestones: [] };
  const val = b => (b.key === 'average' || b.key === 'first9' ? fmt(b.value, 2) : b.key === 'best_leg' ? `${b.value} darts` : String(b.value));
  const bests = r.bests.length ? h('div', { class: 'pl-tiles is-wide' }, r.bests.map(b => {
    const t = tile(b.label, val(b), when(b.at), b.game ? 'is-link' : '');
    if (b.game) { t.tabIndex = 0; t.title = 'Open the game'; t.addEventListener('click', () => openGame(b.game)); }
    return t;
  })) : muted('No games yet.');
  const ms = r.milestones.length ? h('ul', { class: 'pl-miles' }, r.milestones.slice(0, 8).map(m => h('li', {}, icon('flag', 14), h('span', {}, m.label), h('small', {}, when(m.at))))) : null;
  return panel('Personal bests', bests, ms);
}

export function ratingTile(c) {
  const r = c.rating;
  if (!r) return tile('Club rating', '–', 'after the first game');
  return tile('Club rating', String(r.value), r.provisional ? `provisional · ${r.games} game${r.games === 1 ? '' : 's'}` : `${r.games} games`);
}

// --- Progress ------------------------------------------------------------------------------------------
const METRICS = [
  ['average', 'Average', 2, false], ['first9', 'First 9', 2, false], ['avg170', 'Until 170', 2, false],
  ['checkout_pct', 'Checkout %', 1, false], ['spread', 'Group radius (mm)', 1, true], ['treble_pct', 'Treble %', 1, false]
];
let progMetric = 'average';

function trendChart(points, unit, key, d, lowerBetter) {
  const box = h('div', { class: 'pl-form' });
  const pts = points.filter(p => typeof p[key] === 'number');
  if (pts.length < 2) {
    box.append(muted(pts.length ? `The line starts with the second ${unit}.` : (key === 'spread' || key === 'treble_pct' ? NO_DARTS : 'No games yet.')));
    return box;
  }
  const W = 600, H = 190, L = 40, Rr = 12, T = 12, B = 24;
  const vals = pts.map(p => p[key]);
  const step = key.endsWith('pct') ? 5 : key === 'spread' ? 5 : 10;
  const lo = Math.max(0, Math.floor((Math.min(...vals) - step / 2) / step) * step);
  const hi = Math.ceil((Math.max(...vals) + step / 2) / step) * step;
  const t0 = pts[0].at, t1 = pts[pts.length - 1].at;
  // Per game the points sit evenly (games on one evening would pile up on a time axis)
  const pos = new Map(pts.map((p, i) => [p, unit === 'game' ? i / (pts.length - 1) : (p.at - t0) / (t1 - t0 || 1)]));
  const xp = p => L + pos.get(p) * (W - L - Rr);
  const y = v => T + (H - T - B) * (1 - (v - lo) / (hi - lo || 1));
  const ticks = [lo, (lo + hi) / 2, hi];
  const line = pts.map(p => `${xp(p).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(key)} per ${unit}">
    ${ticks.map(t => `<line x1="${L}" x2="${W - Rr}" y1="${y(t)}" y2="${y(t)}" class="pl-grid-line"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" class="pl-axis">${+t.toFixed(1)}</text>`).join('')}
    <polyline points="${line}" class="pl-line"/>
    ${pts.map((p, i) => `<g class="pl-pt" data-i="${i}"><circle cx="${xp(p)}" cy="${y(p[key])}" r="12" class="pl-hit"/><circle cx="${xp(p)}" cy="${y(p[key])}" r="4" class="pl-dot is-won"/></g>`).join('')}
    <text x="${L}" y="${H - 5}" class="pl-axis">${esc(short(t0))}</text><text x="${W - Rr}" y="${H - 5}" text-anchor="end" class="pl-axis">${esc(short(t1))}</text>
    ${lowerBetter ? `<text x="${W - Rr}" y="${T}" text-anchor="end" class="pl-axis">lower is better</text>` : ''}
  </svg><div class="pl-tip" hidden></div>`;
  const tip = box.querySelector('.pl-tip');
  box.querySelectorAll('.pl-pt').forEach(g => {
    const p = pts[+g.dataset.i];
    g.addEventListener('mouseenter', () => {
      tip.hidden = false;
      tip.innerHTML = `<b>${fmt(p[key], d)}</b> · ${p.games} game${p.games === 1 ? '' : 's'}<br>${unit} of ${esc(short(p.at))}`;
      const r = g.getBoundingClientRect(), b = box.getBoundingClientRect();
      tip.style.left = `${r.left - b.left + r.width / 2}px`;
      tip.style.top = `${r.top - b.top}px`;
    });
    g.addEventListener('mouseleave', () => { tip.hidden = true; });
  });
  return box;
}

export function progressView(c) {
  const root = h('div', { class: 'pl-stats' });
  const draw = () => {
    const [key, label, d, lower] = METRICS.find(m => m[0] === progMetric) || METRICS[0];
    const per = c.trend.per_30_days;
    const proj = typeof per === 'number' && key === 'average'
      ? h('p', { class: 'pl-muted' }, `At this pace the average moves ${per >= 0 ? 'up' : 'down'} ${Math.abs(per).toFixed(1)} per month.`) : null;
    const m = c.month, mt = (k, l, dd, lb, unit = '') => tile(l, typeof m.this[k] === 'number' ? `${fmt(m.this[k], dd)}${unit}` : '–', null, 'pl-mtile');
    const mtiles = [['average', 'Average', 2, false], ['first9', 'First 9', 2, false], ['checkout_pct', 'Checkout', 1, false, '%'], ['spread', 'Group radius', 1, true, ' mm']].map(([k, l, dd, lb, unit]) => {
      const t = mt(k, l, dd, lb, unit);
      const dl = delta(m.this[k], m.last[k], lb, dd);
      t.append(h('span', {}, dl || '', typeof m.last[k] === 'number' ? ` vs ${fmt(m.last[k], dd)} last month` : ' · no games last month'));
      return t;
    });
    const v = c.detail.visits, total = v.total || 0;
    const BANDS = ['under 60', '60+', '100+', '140+', '180'];
    const bands = total ? h('div', { class: 'pl-hbars' }, v.bands.map((n, i) => hbar(BANDS[i], (n / total) * 100, `${Math.round((n / total) * 100)}%`))) : muted(NO_DARTS);
    const legs = c.detail.by_leg.length ? h('div', { class: 'pl-hbars' }, c.detail.by_leg.map(l => hbar(l.leg >= 5 ? 'Leg 5+' : `Leg ${l.leg}`, l.average, fmt(l.average, 1)))) : muted(NO_DARTS);
    const dd = c.detail.doubles, pr = dd.pressure, ca = dd.calm, de = dd.deciding, ot = dd.other_legs;
    const tb = c.detail.scoring.treble_by_dart;
    const pressure = h('div', { class: 'pl-tiles is-wide' },
      tile('Doubles, opponent ≤ 100 left', pr.attempts ? `${fmt(pr.pct)}%` : '–', pr.attempts ? `${pr.hits}/${pr.attempts} · otherwise ${fmt(ca.pct)}%` : 'no darts yet'),
      tile('Doubles in deciding legs', de.attempts ? `${fmt(de.pct)}%` : '–', de.attempts ? `${de.hits}/${de.attempts} · other legs ${fmt(ot.pct)}%` : 'no deciding legs yet'),
      tile('Consistency', typeof c.consistency === 'number' ? `± ${fmt(c.consistency)}` : '–', 'spread of match averages'),
      tile('Trebles by dart', tb.some(x => typeof x === 'number') ? tb.map(x => (typeof x === 'number' ? `${Math.round(x)}%` : '–')).join(' · ') : '–', '1st · 2nd · 3rd dart of a visit'));
    root.replaceChildren(
      panel(`Trend · per ${c.trend.unit}`, segmented(METRICS.map(([k, l]) => [k, l]), key, k => { progMetric = k; draw(); }, 'pl-seg-sm'), trendChart(c.trend.points, c.trend.unit, key, d, lower), proj),
      panel('This month', h('div', { class: 'pl-tiles is-wide' }, mtiles)),
      h('div', { class: 'pl-cols' }, panel('Scoring visits', bands, muted('Visits with more than 170 left.')), panel('Scoring by leg of the match', legs, muted('Does the scoring fade later in a match?'))),
      panel('Pressure and rhythm', pressure));
  };
  draw();
  return root;
}

// --- Heat map ----------------------------------------------------------------------------------------------
let heatKind = 'all', heatMode = 'heat';

export function heatView(c) {
  const d = c.detail;
  const root = h('div', { class: 'pl-stats' });
  const draw = () => {
    const showAim = heatMode === 'aim';
    const { box, canvas } = boardBox(boardSvg(), true, overlay(d, showAim));
    const pts = d.heat.filter(p => heatKind === 'all' || (heatKind === 'scoring' ? p[2] === 0 : p[2] === 1));
    const mode = heatMode === 'aim' ? 'aim' : heatMode === 'dots' || pts.length < 40 ? 'dots' : 'heat';
    requestAnimationFrame(() => (mode === 'aim' && d.aim ? drawAim(canvas, d.aim) : drawHeat(canvas, pts, mode)));
    const s = d.scoring, sp = d.spread, dr = d.drift;
    const side = dr ? [Math.abs(dr.y) >= 3 ? `${fmt(Math.abs(dr.y), 0)} mm ${dr.y < 0 ? 'low' : 'high'}` : null, Math.abs(dr.x) >= 3 ? `${fmt(Math.abs(dr.x), 0)} mm ${dr.x < 0 ? 'left' : 'right'}` : null].filter(Boolean).join(', ') || 'on target' : null;
    const stats = h('div', { class: 'pl-tiles is-wide' },
      tile('Group radius', sp ? `${fmt(sp.radius)} mm` : '–', sp ? 'half the darts land this close to their group centre' : 'needs 10 scoring visits'),
      tile('Up-down / left-right', sp ? `${fmt(sp.y)} / ${fmt(sp.x)} mm` : '–', sp ? (sp.y > sp.x * 1.4 ? 'mostly high and low misses' : sp.x > sp.y * 1.15 ? 'mostly sideways misses' : 'even') : ''),
      tile('Drift at T20', side || '–', dr ? 'where the group centre sits' : ''),
      tile('Trebles', s.darts ? `${fmt(s.treble_pct)}%` : '–', s.darts ? `T20 ${fmt(s.t20_pct)}% of ${s.darts} scoring darts` : ''),
      tile('In the 20', s.darts ? `${fmt(s.bed20_pct)}%` : '–', s.darts ? `1 and 5: ${fmt(s.beside20_pct)}%` : ''),
      tile('Scoring per visit', typeof s.average === 'number' ? fmt(s.average, 1) : '–', 'darts with more than 170 left'));
    const ranked = d.aim ? [...d.aim.targets].sort((a, b) => b.points - a.points) : [], bestAim = ranked[0];
    const aim = d.aim ? h('div', { class: 'pl-hbars' }, ranked.map(t => hbar(t.label, (t.points / 60) * 100, `${fmt(t.points, 1)} per dart`, t === bestAim ? 'is-best' : '')),
      h('p', { class: 'pl-muted' }, `Best spot for your spread: around ${d.aim.best.label}, ${fmt(d.aim.best.points, 1)} points per dart.`)) : muted('The aim map needs 10 scoring visits with darts.');
    const legend = mode === 'heat' ? h('div', { class: 'pl-legend' }, h('span', {}, 'fewer'), h('i', { class: 'pl-legend-ramp' }), h('span', {}, 'more darts'))
      : mode === 'aim' ? h('div', { class: 'pl-legend' }, h('span', {}, 'fewer points'), h('i', { class: 'pl-legend-ramp' }), h('span', {}, 'more points per dart'))
        : h('div', { class: 'pl-legend' }, h('b', { class: 'pl-key is-s' }), 'scoring', h('b', { class: 'pl-key is-d' }), 'at a double', h('b', { class: 'pl-key is-o' }), 'other');
    root.replaceChildren(
      h('div', { class: 'pl-heat' },
        h('div', { class: 'pl-heat-board' },
          h('div', { class: 'pl-heat-tools' },
            segmented([['heat', 'Heat'], ['dots', 'Dots'], ['aim', 'Aim map']], heatMode, k => { heatMode = k; draw(); }, 'pl-seg-sm'),
            heatMode === 'aim' ? null : segmented([['all', 'All'], ['scoring', 'Scoring'], ['doubles', 'At a double']], heatKind, k => { heatKind = k; draw(); }, 'pl-seg-sm')),
          box, legend,
          d.heat.length ? h('p', { class: 'pl-muted' }, `${pts.length} dart${pts.length === 1 ? '' : 's'} with a position${d.heat.length >= 3000 ? ' (the last 3000)' : ''}. The dashed ellipse holds half your scoring darts around their centre.`) : muted(NO_DARTS)),
        h('div', { class: 'pl-heat-side' }, panel('Grouping', stats), panel('Where to aim', aim,
          h('p', { class: 'pl-muted' }, 'From your own spread: the expected points per dart at each target (Tibshirani et al., “A Statistician Plays Darts”).')))));
  };
  draw();
  return root;
}

// --- Doubles -----------------------------------------------------------------------------------------------
let pickedDouble = null;

export function doublesView(c) {
  const d = c.detail.doubles, lv = c.detail.leaves;
  const rows = d.by_double;
  const root = h('div', { class: 'pl-stats' });
  if (!d.attempts) {
    root.append(panel('Doubles', muted(c.detail.darts ? 'No darts at a double yet (double-out X01 games only).' : NO_DARTS)));
    return root;
  }
  const byT = Object.fromEntries(rows.map(r => [r.target, r]));
  const fill = n => { const r = byT[n]; return r && r.attempts >= 3 ? goodCss((r.pct || 0) / 50) : null; };
  const draw = () => {
    const sel = rows.find(r => r.target === pickedDouble) || rows[0];
    const often = rows.filter(r => r.attempts >= 5);
    const best = often.length ? often.reduce((a, b) => (b.pct > a.pct ? b : a)) : null;
    const worst = often.length > 1 ? often.reduce((a, b) => (b.pct < a.pct ? b : a)) : null;
    const list = h('div', { class: 'pl-dlist' }, rows.slice(0, 14).map(r => {
      const b = h('button', { type: 'button', class: `pl-drow${r === sel ? ' is-on' : ''}`, onclick: () => { pickedDouble = r.target; draw(); } },
        h('b', {}, r.label), h('span', { class: 'pl-hbar-t' }, h('i', { style: `width:${Math.min(100, r.pct || 0)}%;background:${goodCss((r.pct || 0) / 50)}` })),
        h('span', { class: 'pl-hbar-v' }, `${fmt(r.pct, 0)}% · ${r.hits}/${r.attempts}`),
        r === best ? h('span', { class: 'pl-flag is-good' }, 'best') : r === worst ? h('span', { class: 'pl-flag is-bad' }, 'weakest') : null);
      return b;
    }));
    const misses = sel.attempts - sel.hits;
    const miss = h('div', { class: 'pl-hbars' },
      hbar('Hit', (sel.hits / sel.attempts) * 100, String(sel.hits)),
      hbar('Inside (single)', misses ? (sel.inside / sel.attempts) * 100 : 0, String(sel.inside)),
      hbar('Outside the board', misses ? (sel.outside / sel.attempts) * 100 : 0, String(sel.outside)),
      ...sel.wide.slice(0, 3).map(w => hbar(`Into the ${w.number}${w.beside ? '' : ' (not next to it)'}`, (w.count / sel.attempts) * 100, String(w.count))));
    const { box } = boardBox(boardSvg({ doubleFill: fill }), false);
    root.replaceChildren(
      h('div', { class: 'pl-tiles is-wide' },
        tile('At a double', `${fmt(d.pct)}%`, `${d.hits} of ${d.attempts} darts`),
        tile('Darts per checkout', fmt(d.darts_per_checkout), 'darts at a double for each finish'),
        tile('First dart at a double', `${fmt(d.first_dart_pct)}%`, `later darts ${fmt(d.later_dart_pct)}%`),
        tile('Bogey leaves', lv.range ? `${fmt(lv.bogey_pct, 0)}%` : '–', lv.range ? `of ${lv.range} visits into the finish` : ''),
        tile('Odd leaves ≤ 40', lv.setup ? `${fmt(lv.odd_pct, 0)}%` : '–', lv.setup ? 'cost a dart to set up' : ''),
        tile('Good leaves', lv.setup ? `${fmt(lv.good_pct, 0)}%` : '–', '40, 32, 16, 36, 24, 20 or 8')),
      h('div', { class: 'pl-heat' },
        h('div', { class: 'pl-heat-board' }, box, h('div', { class: 'pl-legend' }, h('span', {}, '0%'), h('i', { class: 'pl-legend-ramp is-good' }), h('span', {}, '50%+ hit')), muted('Doubles with 3 or more darts are coloured by how often they hit.')),
        h('div', { class: 'pl-heat-side' }, panel('Per double · most needed first', list), panel(`${sel.label}: where the darts went`, miss))));
  };
  draw();
  return root;
}

// --- Games and the report per game ------------------------------------------------------------------------
export function gamesView(recent, openGame) {
  if (!recent.length) return panel('Match history', muted('No matches in this period.'));
  const rows = recent.map(g => {
    const tr = h('tr', { class: g.counts ? '' : 'is-muted', tabindex: '0', title: 'Open the report' },
      h('td', {}, when(g.at)), h('td', {}, g.opponents.join(', ') || 'Solo'),
      h('td', {}, h('span', { class: `pl-res ${g.won ? 'is-won' : ''}` }, g.won ? 'W' : 'L'), ` ${g.score[0]}–${g.score[1]}`),
      h('td', { class: 'is-num' }, fmt(g.average, 2)), h('td', {}, g.variant), h('td', {}, g.board));
    tr.addEventListener('click', () => openGame(g.id));
    tr.addEventListener('keydown', e => { if (e.key === 'Enter') openGame(g.id); });
    return tr;
  });
  return panel('Match history', h('div', { class: 'pl-table-wrap' }, h('table', { class: 'pl-table' },
    h('thead', {}, h('tr', {}, ['Date', 'Opponent', 'Result', 'Average', 'Game', 'Board'].map(x => h('th', x === 'Average' ? { class: 'is-num' } : {}, x)))), h('tbody', {}, rows))),
  muted('Open a match for its legs, doubles and where the darts landed.'));
}

export async function gameReport(id, memberId, members, close, remove) {
  const box = h('div', { class: 'pl-stats' }, muted('Loading the game…'));
  try {
    const r = await api(`/api/club/game?id=${encodeURIComponent(id)}`);
    let who = Math.max(0, r.players.findIndex(p => p.member === memberId));
    const byId = Object.fromEntries(members.map(m => [m.id, m]));
    const draw = () => {
      const p = r.players[who];
      const { box: board, canvas } = boardBox(boardSvg());
      requestAnimationFrame(() => drawHeat(canvas, p.heat, 'dots'));
      const head = h('div', { class: 'pl-report-head' },
        r.players.map((x, i) => h('button', { type: 'button', class: `pl-rplayer${i === who ? ' is-on' : ''}${x.won ? ' is-won' : ''}`, onclick: () => { who = i; draw(); } },
          byId[x.member] ? avatar(byId[x.member]) : h('span', { class: 'stu-avatar' }, x.name.slice(0, 2)),
          h('span', {}, h('b', {}, x.name), h('small', {}, `${r.sets ? `${x.sets} sets` : `${x.legs} legs`} · ${fmt(x.average, 2)} avg${x.bot ? ' · bot' : ''}`)))));
      const legs = r.legs.length ? h('div', { class: 'pl-table-wrap' }, h('table', { class: 'pl-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Leg'), ...r.players.map(x => h('th', { colspan: 3 }, x.name)))),
        h('tbody', {}, r.legs.map(l => h('tr', {},
          h('td', {}, r.sets ? `${l.set}.${l.leg}` : String(l.leg)),
          ...l.players.flatMap((x, i) => [
            h('td', { class: `is-num${l.winner === i ? ' is-win' : ''}` }, x.darts ? `${x.darts} darts` : '–'),
            h('td', { class: 'is-num' }, fmt(x.average, 1)),
            h('td', { class: 'is-num' }, x.finish ? `out ${x.finish}` : x.at_double ? `${x.hit}/${x.at_double} D` : '')])))))) : muted(NO_DARTS);
      box.replaceChildren(
        h('div', { class: 'pl-report-bar' }, h('button', { type: 'button', class: 'pl-back', onclick: close }, '← Match history'),
          remove ? h('button', { type: 'button', class: 'stu-btn stu-del', onclick: () => remove(id) }, icon('trash', 16), 'Delete match') : null),
        panel(`${r.variant}${r.base ? ` ${r.base}` : ''} · ${when(r.at)} · ${r.board}`, head),
        h('div', { class: 'pl-tiles is-wide' },
          tile('Average', fmt(p.average, 2)), tile('First 9', fmt(p.first9, 2)), tile('Until 170', fmt(p.avg170, 2)),
          tile('Checkout', typeof p.checkout_pct === 'number' ? `${fmt(p.checkout_pct)}%` : '–', p.checkouts ? `${p.checkouts_hit}/${p.checkouts}` : ''),
          tile('180 / 140+ / 100+', `${p.t180} / ${p.t140} / ${p.t100}`), tile('Best checkout', p.best_checkout ? String(p.best_checkout) : '–')),
        h('div', { class: 'pl-heat' },
          h('div', { class: 'pl-heat-board' }, board, h('div', { class: 'pl-legend' }, h('b', { class: 'pl-key is-s' }), 'scoring', h('b', { class: 'pl-key is-d' }), 'at a double', h('b', { class: 'pl-key is-o' }), 'other'),
            p.heat.length ? null : muted(NO_DARTS)),
          h('div', { class: 'pl-heat-side' }, panel('Leg by leg', legs),
            p.detail.spread ? panel('Grouping this game', h('p', {}, `Up-down ${fmt(p.detail.spread.y)} mm, left-right ${fmt(p.detail.spread.x)} mm.`)) : null)));
    };
    draw();
  } catch (err) {
    box.replaceChildren(h('button', { type: 'button', class: 'pl-back', onclick: close }, '← Match history'), h('p', { class: 'pl-note is-warn' }, icon('info', 16), err.message));
  }
  return box;
}

// --- Compare -----------------------------------------------------------------------------------------------
const AXES = [
  ['Scoring', c => c.totals.avg170 ?? c.totals.average, v => (v - 20) / 70],
  ['Finishing', c => c.totals.checkout_pct, v => v / 50],
  ['Grouping', c => c.detail.spread?.radius, v => (60 - v) / 50],
  ['Consistency', c => c.consistency, v => (20 - v) / 17],
  ['Under pressure', c => c.detail.doubles.pressure.pct ?? c.totals.checkout_pct, v => v / 50]
];

function radar(a, b) {
  const S = 260, C = S / 2, Rr = 92;
  const pos = (i, t) => { const ang = (i / AXES.length) * Math.PI * 2 - Math.PI / 2; return [C + Math.cos(ang) * Rr * t, C + Math.sin(ang) * Rr * t]; };
  const poly = c => AXES.map(([, get, norm], i) => { const v = get(c); const t = typeof v === 'number' ? Math.max(0.04, Math.min(1, norm(v))) : 0.04; return pos(i, t).map(n => n.toFixed(1)).join(','); }).join(' ');
  const rings = [0.25, 0.5, 0.75, 1].map(t => `<polygon points="${AXES.map((_, i) => pos(i, t).join(',')).join(' ')}" class="pl-grid-line pl-radar-ring"/>`).join('');
  const labels = AXES.map(([l], i) => { const [x, y] = pos(i, 1.2); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" class="pl-axis">${l}</text>`; }).join('');
  const el = h('div', { class: 'pl-radar' });
  el.innerHTML = `<svg viewBox="-30 -10 ${S + 60} ${S + 20}" role="img" aria-label="Comparison">${rings}${labels}${b ? `<polygon points="${poly(b)}" class="pl-radar-b"/>` : ''}<polygon points="${poly(a)}" class="pl-radar-a"/></svg>`;
  return el;
}

let compareWith = '';

export function compareView(p, c, members, period, onOpen) {
  const root = h('div', { class: 'pl-stats' });
  const others = members.filter(m => m.id !== p.id).sort((x, y) => x.name.localeCompare(y.name));
  const draw = async () => {
    const pick = h('select', { class: 'pl-sort', 'aria-label': 'Compare with', onchange: e => { compareWith = e.target.value; draw(); } },
      h('option', { value: '' }, 'Club average'), others.map(m => h('option', { value: m.id, selected: m.id === compareWith }, m.name)));
    let o = null;
    const other = others.find(m => m.id === compareWith);
    if (other) {
      root.replaceChildren(h('div', { class: 'pl-bar-row is-left' }, pick), muted('Loading…'));
      try { o = await api(`/api/club/coach?id=${encodeURIComponent(other.id)}&period=${period}`); } catch { o = null; }
    }
    const club = c.club;
    const rows = [
      ['Average', x => x.totals.average, club.average, 2, false], ['First 9', x => x.totals.first9, club.first9, 2, false],
      ['Checkout %', x => x.totals.checkout_pct, club.checkout_pct, 1, false], ['At a double %', x => x.detail.doubles.pct, club.double_pct, 1, false],
      ['Group radius (mm)', x => x.detail.spread?.radius, club.spread, 1, true], ['Treble %', x => x.detail.scoring.treble_pct, club.treble_pct, 1, false],
      ['Consistency (±)', x => x.consistency, null, 1, true], ['Club rating', x => x.rating?.value, null, 0, false], ['Games', x => x.totals.games, null, 0, false]
    ];
    const better = (a, b, lower) => typeof a === 'number' && typeof b === 'number' && a !== b && (lower ? a < b : a > b);
    const table = h('div', { class: 'pl-table-wrap' }, h('table', { class: 'pl-table pl-compare' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'is-num' }, p.name), h('th', { class: 'is-num' }, other ? other.name : `Club (${club.members} members)`))),
      h('tbody', {}, rows.map(([l, get, clubV, d, lower]) => {
        const a = get(c), b = other ? (o ? get(o) : null) : clubV;
        return h('tr', {}, h('td', {}, l), h('td', { class: `is-num${better(a, b, lower) ? ' is-better' : ''}` }, fmt(a, d)), h('td', { class: `is-num${better(b, a, lower) ? ' is-better' : ''}` }, fmt(b, d)));
      }))));
    root.replaceChildren(
      h('div', { class: 'pl-bar-row is-left' }, h('span', { class: 'pl-muted' }, 'Compare with'), pick, other ? h('button', { type: 'button', class: 'stu-btn', onclick: () => onOpen(other.id) }, `Open ${other.name}`) : null),
      h('div', { class: 'pl-cols' },
        panel('Side by side', table),
        panel('Shape of the game', radar(c, o), h('div', { class: 'pl-legend' }, h('b', { class: 'pl-key is-s' }), p.name, o ? [h('b', { class: 'pl-key is-b' }), other.name] : null),
          muted('Each axis runs from weak at the centre to strong at the edge. Missing numbers sit at the centre.'))));
  };
  draw();
  return root;
}
