// AutoGlow Studio output - checkout routes (used when Autodarts sends no checkout guide).
// Fewest darts first; among those the route players prefer: big trebles to set up, the common doubles to finish.

const BOGEY = new Set([169, 168, 166, 165, 163, 162, 159]);
const GOOD_DOUBLES = [20, 16, 8, 10, 12, 18];
const NUMBERS = Array.from({ length: 20 }, (_, i) => 20 - i);

// Setup darts with a cost: lower is more natural to throw
const SETUP = [
  ...NUMBERS.map(n => ({ label: `T${n}`, value: 3 * n, cost: (20 - n) * 2 })),
  ...NUMBERS.map(n => ({ label: `S${n}`, value: n, cost: 15 + (20 - n) })),
  { label: '25', value: 25, cost: 12 },
  { label: 'Bull', value: 50, cost: 30 },
  ...NUMBERS.map(n => ({ label: `D${n}`, value: 2 * n, cost: 40 }))
];

function doubleCost(n) {
  const good = GOOD_DOUBLES.indexOf(n);
  return good >= 0 ? good * 3 : 25 + (20 - n);
}

function finishers(outMode) {
  const doubles = [...NUMBERS.map(n => ({ label: `D${n}`, value: 2 * n, cost: doubleCost(n) })), { label: 'Bull', value: 50, cost: 20 }];
  if (outMode === 'Straight') return [...doubles, ...SETUP];
  if (outMode === 'Master') return [...doubles, ...SETUP.filter(d => d.label.startsWith('T'))];
  return doubles;
}

const cache = new Map();

// Route for `remaining` with `darts` darts left, e.g. ['T20', 'T19', 'D12'], or null when there is none
export function checkoutRoute(remaining, darts = 3, outMode = 'Double') {
  if (!Number.isFinite(remaining) || remaining < 2 || remaining > 170 || darts < 1) return null;
  if (outMode !== 'Straight' && BOGEY.has(remaining)) return null;
  const key = `${remaining}|${darts}|${outMode}`;
  if (cache.has(key)) return cache.get(key);
  const finish = finishers(outMode);
  let route = null;
  for (let n = 1; n <= Math.min(3, darts) && !route; n++) route = best(remaining, n, finish);
  cache.set(key, route);
  return route;
}

function best(remaining, n, finish) {
  let found = null;
  let foundCost = Infinity;
  const consider = (setup, last) => {
    const cost = setup.reduce((sum, d) => sum + d.cost, 0) + last.cost;
    if (cost < foundCost) { found = [...setup, last].map(d => d.label); foundCost = cost; }
  };
  for (const last of finish) {
    const rest = remaining - last.value;
    if (n === 1 && rest === 0) consider([], last);
    if (n === 2) for (const a of SETUP) if (a.value === rest) consider([a], last);
    if (n === 3) for (const a of SETUP) for (const b of SETUP) if (a.value + b.value === rest) consider(a.cost <= b.cost ? [a, b] : [b, a], last);
  }
  return found;
}
