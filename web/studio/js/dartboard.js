// AutoGlow Studio output - mini dartboard with the darts of the current visit and a session heatmap.
// Autodarts coordinates: 1.0 is the outer edge of the double ring, +y points to the 20 (checked against
// real throws), so a dart at (x, y) is drawn at (x, -y) in the SVG.

import { el } from './ctx.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
// Ring radii relative to the double ring (170 mm)
export const R = { bull: 6.35 / 170, outerBull: 15.9 / 170, trebleIn: 99 / 170, trebleOut: 107 / 170, doubleIn: 162 / 170, doubleOut: 1 };
const BED_RADIUS = { SingleInner: 0.36, Triple: 0.605, SingleOuter: 0.79, Double: 0.976 };

// Where a dart probably landed when Autodarts sent no coordinates (manual entry)
export function segmentPosition(number, bed, multiplier) {
  const jitter = () => (Math.random() - 0.5);
  if (number === 25) {
    const r = multiplier === 2 ? R.bull * 0.6 : (R.bull + R.outerBull) / 2;
    const a = Math.random() * Math.PI * 2;
    return { x: Math.sin(a) * r, y: Math.cos(a) * r };
  }
  const index = ORDER.indexOf(number);
  if (index < 0) {
    const a = Math.random() * Math.PI * 2; // A miss: just outside the scoring area
    return { x: Math.sin(a) * 1.08, y: Math.cos(a) * 1.08 };
  }
  const bedName = bed || (multiplier === 3 ? 'Triple' : multiplier === 2 ? 'Double' : 'SingleInner');
  const radius = (BED_RADIUS[bedName] ?? BED_RADIUS.SingleInner) + jitter() * 0.03;
  const angle = (index * 18 + jitter() * 12) * Math.PI / 180;
  return { x: Math.sin(angle) * radius, y: Math.cos(angle) * radius };
}

export function dartPosition(t) {
  if (typeof t.x === 'number' && typeof t.y === 'number') return { x: t.x, y: t.y };
  if (!t._pos) t._pos = segmentPosition(t.number, t.bed, t.multiplier);
  return t._pos;
}

export function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Ring sector between two radii and two angles (degrees, clockwise from the top)
function sector(r1, r2, a1, a2, fill) {
  const p = (r, a) => `${(Math.sin(a * Math.PI / 180) * r).toFixed(4)} ${(-Math.cos(a * Math.PI / 180) * r).toFixed(4)}`;
  const d = `M${p(r1, a1)} L${p(r2, a1)} A${r2} ${r2} 0 0 1 ${p(r2, a2)} L${p(r1, a2)} A${r1} ${r1} 0 0 0 ${p(r1, a1)}Z`;
  return svg('path', { d, fill });
}

export function buildBoard() {
  const root = svg('svg', { viewBox: '-1.32 -1.32 2.64 2.64', class: 'db-svg' });
  root.append(svg('circle', { cx: 0, cy: 0, r: 1.32, fill: '#0b0b0d' }));
  ORDER.forEach((number, i) => {
    const a1 = i * 18 - 9;
    const a2 = a1 + 18;
    const dark = i % 2 === 0;
    const single = dark ? '#16181c' : '#e9dfc4';
    const ring = dark ? '#d3302f' : '#1d8a4e';
    root.append(
      sector(R.outerBull, R.trebleIn, a1, a2, single),
      sector(R.trebleIn, R.trebleOut, a1, a2, ring),
      sector(R.trebleOut, R.doubleIn, a1, a2, single),
      sector(R.doubleIn, R.doubleOut, a1, a2, ring)
    );
    const a = i * 18 * Math.PI / 180;
    const label = svg('text', { x: (Math.sin(a) * 1.16).toFixed(3), y: (-Math.cos(a) * 1.16 + 0.055).toFixed(3), class: 'db-num' });
    label.textContent = number;
    root.append(label);
  });
  root.append(svg('circle', { cx: 0, cy: 0, r: R.outerBull, fill: '#1d8a4e' }));
  root.append(svg('circle', { cx: 0, cy: 0, r: R.bull, fill: '#d3302f' }));
  const heat = svg('g', { class: 'db-heat' });
  const darts = svg('g', { class: 'db-darts' });
  root.append(heat, darts);
  return { root, heat, darts };
}

export class MiniBoard {
  constructor(host) {
    this.host = host;
    const { root, heat, darts } = buildBoard();
    this.heat = heat;
    this.darts = darts;
    this.title = el('div', 'db-title');
    host.replaceChildren(this.title, root);
    this.key = '';
  }

  // throws: darts of the current visit; history: earlier darts of the same player this match
  update(playerName, throws, history) {
    const key = `${playerName}|${throws.map(t => t.id || t.label).join(',')}|${history.length}`;
    if (key === this.key) return;
    this.key = key;
    this.title.textContent = playerName || '';
    this.heat.replaceChildren(...history.slice(-120).map(t => {
      const { x, y } = dartPosition(t);
      return svg('circle', { cx: x.toFixed(4), cy: (-y).toFixed(4), r: 0.035, class: 'db-heat-dot' });
    }));
    this.darts.replaceChildren(...throws.map((t, i) => {
      const { x, y } = dartPosition(t);
      // The pop-in animation runs on an inner group, so it does not replace the position transform
      const g = svg('g', { transform: `translate(${x.toFixed(4)} ${(-y).toFixed(4)})` });
      const pop = svg('g', { class: 'db-dart' });
      pop.append(svg('circle', { r: 0.075, class: 'db-dart-dot' }));
      const n = svg('text', { y: 0.032, class: 'db-dart-num' });
      n.textContent = i + 1;
      pop.append(n);
      g.append(pop);
      return g;
    }));
  }
}
