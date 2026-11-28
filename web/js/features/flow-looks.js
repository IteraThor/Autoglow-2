// AutoGlow 2 - Flow Matrix looks in the browser
// The same math as core/effects/flow (renderers.py, transitions.py), so a preview shows exactly what the
// light strip does. tests/test_flow_looks_js.py compares both frame by frame.

const SPEED_MIN = 0.25;
const SPEED_MAX = 4.0;
const MAX_FLASH_HZ = 3.0;
const MIN_FLASH_PERIOD = 1.0 / MAX_FLASH_HZ;
const BREATHE_PERIOD = 4.0;
const CHASE_LAP = 2.5;
const RAINBOW_LAP = 6.0;
const SPARKLE_SLOT = 0.9;
const FLASH_REPEAT = 2.0;
const TAIL_SHARE = { short: 0.12, long: 0.35 };
const SPARKLE_CHANCE = { few: 0.05, some: 0.12, many: 0.25 };
const EDGE_SHARE = 0.06;
const FLASH_RISE = 0.2;
const WAVE_PERIOD = 3.0;
const METEOR_FASTEST = 0.75;
const METEOR_SLOWEST = 0.3;
const FIREWORK_PERIOD = 1.7;
const CONFETTI_SLOT = 0.8;
const RIPPLE_PERIOD = 1.4;
const FIRE_FLICKER = 2.2;
const FIRE_FLICKER_FINE = 5.0;
const SWEEP_GLOW = 0.045;
const DISSOLVE_SPREAD = 0.25;
const GOLD = [255, 215, 140];
const CONFETTI_COLOURS = [[255, 60, 90], [255, 200, 40], [60, 220, 120], [200, 90, 255]];

const OPTION_DEFAULTS = {
  solid: {},
  breathe: {},
  flash: { pulses: [1, [1, 2, 3]] },
  chase: { tail: ['short', ['short', 'long']], comets: [1, [1, 2]] },
  rainbow: { palette: ['vivid', ['vivid', 'soft']] },
  sparkle: { amount: ['some', ['few', 'some', 'many']] },
  wave: { waves: [2, [1, 2, 3]], edges: ['soft', ['soft', 'sharp']] },
  meteors: { amount: ['some', ['few', 'some', 'many']] },
  fireworks: {},
  confetti: { amount: ['some', ['few', 'some', 'many']] },
  ripple: {},
  fire: {},
  aurora: {}, plasma: {}, lava: {}, lightning: {}, glitch: {}, kaleido: {}, pendulum: {}, moire: {}
};

export function normalizeOptions(id, options = {}) {
  const spec = OPTION_DEFAULTS[id] || {};
  const out = {};
  for (const [key, [def, allowed]] of Object.entries(spec)) {
    const v = options?.[key];
    out[key] = allowed.includes(v) ? v : def;
  }
  return out;
}

const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);
const speedOf = eff => {
  const s = Number(eff.speed);
  return Number.isFinite(s) ? Math.max(SPEED_MIN, Math.min(SPEED_MAX, s)) : 1;
};
const rgb = c => (Array.isArray(c) ? [c[0] | 0, c[1] | 0, c[2] | 0] : [0, 0, 0]);
// Python's int(x + 0.5) for x >= 0
const round = x => Math.floor(x + 0.5);
// Python's % (result has the sign of the divisor)
const mod = (a, n) => {
  const r = a % n;
  return r !== 0 && (r < 0) !== (n < 0) ? r + n : r;
};

function mix(a, b, t) {
  t = clamp01(t);
  return [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t), round(a[2] + (b[2] - a[2]) * t)];
}

function fill(count, c) {
  const out = new Uint8ClampedArray(count * 3);
  for (let i = 0; i < count; i++) out.set(c, i * 3);
  return out;
}

function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

function hash01(a, b = 0) {
  let h = (Math.imul(a, 0x9e3779b1) + Math.imul(b, 0x85ebca77) + 0x165667b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function renderSolid(eff, t, n) {
  return fill(n, rgb(eff.color_primary));
}

function renderBreathe(eff, t, n) {
  const period = BREATHE_PERIOD / speedOf(eff);
  const p = mod(t / period, 1);
  const level = 0.5 * (1 + Math.cos(2 * Math.PI * p));
  return fill(n, mix(rgb(eff.color_secondary), rgb(eff.color_primary), level));
}

export function flashLevel(eff, t, pulses) {
  const duration = Number(eff.duration) || 0;
  let pulseLen, k, tt;
  if (duration > 0) {
    if (t >= duration) return 0;
    const count = Math.max(1, Math.min(pulses, Math.floor(duration * MAX_FLASH_HZ + 1e-9)));
    pulseLen = Math.min(duration / count, 0.7 / speedOf(eff));
    pulseLen = Math.max(MIN_FLASH_PERIOD, pulseLen);
    k = Math.floor(t / pulseLen);
    if (k >= count) return 0;
    tt = t - k * pulseLen;
  } else {
    pulseLen = Math.max(MIN_FLASH_PERIOD, 0.45 / speedOf(eff));
    const repeat = Math.max(pulses * pulseLen + 0.4, FLASH_REPEAT / speedOf(eff));
    const inGroup = mod(t, repeat);
    k = Math.floor(inGroup / pulseLen);
    if (k >= pulses) return 0;
    tt = inGroup - k * pulseLen;
  }
  const attack = Math.min(0.04, pulseLen * 0.15);
  if (tt < attack) return tt / attack;
  return Math.pow(1 - (tt - attack) / (pulseLen - attack), 2.2);
}

function renderFlash(eff, t, n, o) {
  const level = flashLevel(eff, t, Number(o.pulses));
  return fill(n, mix(rgb(eff.color_secondary), rgb(eff.color_primary), level));
}

function renderChase(eff, t, n, o, line) {
  const head = rgb(eff.color_primary);
  const bg = rgb(eff.color_secondary);
  const lap = CHASE_LAP / speedOf(eff);
  const progress = mod(t / lap, 1);
  const tail = Math.max(1, n * TAIL_SHARE[o.tail]);
  if (line) {
    // A line has ends to bounce off: the strip is unfolded to twice its length, so the tail folds back too
    const len = 2 * n;
    const first = mod(t / lap, 2) * n + (eff.reverse ? n : 0);
    const starts = Number(o.comets) === 2 ? [first, first + n] : [first];
    const out = new Uint8ClampedArray(n * 3);
    for (let i = 0; i < n; i++) {
      const centre = i + 0.5;
      let level = 0;
      for (const h of starts) {
        for (const at of [centre, len - centre]) {
          const behind = mod(h - at, len);
          let lv;
          if (behind > len - 1) lv = 1 - (len - behind);
          else if (behind <= tail) lv = Math.pow(1 - behind / tail, 1.5);
          else lv = 0;
          if (lv > level) level = lv;
        }
      }
      out.set(mix(bg, head, level), i * 3);
    }
    return out;
  }
  const dir = eff.reverse ? -1 : 1;
  const heads = [mod(progress * n * dir, n)];
  const dirs = [dir];
  if (Number(o.comets) === 2) {
    heads.push(mod(-progress * n * dir, n));
    dirs.push(-dir);
  }
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const centre = i + 0.5;
    let level = 0;
    for (let k = 0; k < heads.length; k++) {
      const behind = mod((heads[k] - centre) * dirs[k], n);
      let lv;
      if (behind > n - 1) lv = 1 - (n - behind);
      else if (behind <= tail) lv = Math.pow(1 - behind / tail, 1.5);
      else lv = 0;
      if (lv > level) level = lv;
    }
    out.set(mix(bg, head, level), i * 3);
  }
  return out;
}

// From both sides a loop starts at its start point and meets on the far side; a line opens from its middle.
// Reverse turns that round.
export function curtainDistance(i, n, sides, reverse, line = false) {
  const centre = i + 0.5;
  if (sides === 'one') {
    const d = centre / n;
    return reverse ? 1 - d : d;
  }
  const d = Math.min(centre, n - centre) / (n / 2);
  return !!line !== !!reverse ? 1 - d : d;
}

const VIVID = [[0, [255, 0, 0]], [0.14, [255, 70, 0]], [0.28, [255, 190, 0]], [0.42, [0, 255, 20]],
  [0.57, [0, 210, 230]], [0.71, [0, 40, 255]], [0.86, [190, 0, 210]], [1, [255, 0, 0]]];
const SOFT = [[0, [255, 90, 110]], [0.14, [255, 150, 90]], [0.28, [255, 215, 110]], [0.42, [120, 255, 150]],
  [0.57, [100, 225, 255]], [0.71, [120, 140, 255]], [0.86, [210, 120, 255]], [1, [255, 90, 110]]];

function paletteLut(stops) {
  const lut = [];
  for (let k = 0; k < 512; k++) {
    const pos = k / 512;
    for (let s = 0; s < stops.length - 1; s++) {
      const [p0, c0] = stops[s];
      const [p1, c1] = stops[s + 1];
      if (p0 <= pos && pos <= p1) {
        const t = (pos - p0) / (p1 - p0);
        lut.push(mix(c0, c1, 0.5 * (1 - Math.cos(Math.PI * t))));
        break;
      }
    }
  }
  return lut;
}

const PALETTES = { vivid: paletteLut(VIVID), soft: paletteLut(SOFT) };

function renderRainbow(eff, t, n, o) {
  const lut = PALETTES[o.palette];
  const size = lut.length;
  let progress = mod(t / (RAINBOW_LAP / speedOf(eff)), 1);
  if (eff.reverse) progress = -progress;
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    out.set(lut[mod(Math.floor(mod((i + 0.5) / n + progress, 1) * size), size)], i * 3);
  }
  return out;
}

function renderSparkle(eff, t, n, o) {
  const spark = rgb(eff.color_primary);
  const bg = rgb(eff.color_secondary);
  const chance = SPARKLE_CHANCE[o.amount];
  const slot = SPARKLE_SLOT / speedOf(eff);
  const out = fill(n, bg);
  for (let i = 0; i < n; i++) {
    const tt = t / slot + hash01(i, 7919);
    const k = Math.floor(tt);
    if (hash01(i, k) >= chance) continue;
    const start = hash01(k, i) * 0.4;
    const u = (tt - k - start) / 0.6;
    if (u < 0 || u >= 1) continue;
    const level = u < 0.12 ? u / 0.12 : Math.exp(-4.5 * (u - 0.12));
    out.set(mix(bg, spark, level), i * 3);
  }
  return out;
}

const wrapDist = (x, p) => {
  const d = Math.abs(x - p);
  return Math.min(d, 1 - d);
};

// How far a pixel is from where a ripple or a spread begins: 0 at the origin, 1 at the farthest point.
// A loop spreads both ways round from the origin (the start point without one); a line from its middle.
function originDistance(x, origin, line) {
  if (line) return Math.abs(x - 0.5) * 2;
  return wrapDist(x, mod(origin ?? 0, 1)) * 2;
}

function renderWave(eff, t, n, o) {
  const c = rgb(eff.color_primary);
  const bg = rgb(eff.color_secondary);
  const phase = (eff.reverse ? -1 : 1) * t * speedOf(eff) / WAVE_PERIOD;
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    let s = 0.5 + 0.5 * Math.sin(2 * Math.PI * (x * Number(o.waves) - phase));
    if (o.edges === 'sharp') s = clamp01((s - 0.5) * 8 + 0.5);
    out.set(mix(bg, c, s), i * 3);
  }
  return out;
}

function renderMeteors(eff, t, n, o, line) {
  const head = rgb(eff.color_primary);
  const bg = rgb(eff.color_secondary);
  const meteors = { few: 2, some: 4, many: 6 }[o.amount];
  const sp = speedOf(eff);
  const level = new Array(n).fill(0);
  for (let m = 0; m < meteors; m++) {
    const v = (METEOR_SLOWEST + (METEOR_FASTEST - METEOR_SLOWEST) * hash01(m, 11)) * sp;
    const len = Math.max(0.12 + 0.2 * hash01(m, 23), 1.5 / n);
    const cycle = line ? 1 + len + 0.2 + 0.6 * hash01(m, 31) : 1;
    const pos = mod(hash01(m, 5) * cycle + t * v, cycle);
    for (let i = 0; i < n; i++) {
      let x = (i + 0.5) / n;
      if (eff.reverse) x = 1 - x;
      const behind = line ? pos - x : mod(pos - x, 1);
      if (behind < 0 || behind >= len) continue;
      const flicker = behind > 0.03 ? 0.7 + 0.3 * hash01(i, Math.floor(t * 24) + m * 7) : 1;
      const lv = Math.pow(1 - behind / len, 1.6) * flicker;
      if (lv > level[i]) level[i] = lv;
    }
  }
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) out.set(mix(bg, head, level[i]), i * 3);
  return out;
}

function renderFireworks(eff, t, n, o, line) {
  const bg = rgb(eff.color_secondary);
  const colours = [rgb(eff.color_primary), mix(rgb(eff.color_primary), [255, 255, 255], 0.6), GOLD];
  // Three bursts overlap, so at most three open per second, however fast it is set
  const period = Math.max(FIREWORK_PERIOD / speedOf(eff), 3 * MIN_FLASH_PERIOD);
  const out = fill(n, bg);
  const cur = i => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
  for (let s = 0; s < 3; s++) {
    const tt = t / period + s / 3;
    const k = Math.floor(tt);
    const u = tt - k;
    const centre = line ? 0.2 + 0.6 * hash01(k, s * 13 + 1) : hash01(k, s * 13 + 1);
    const col = colours[Math.floor(hash01(k, s + 77) * 3)];
    let u2 = u;
    if (line) {
      if (u < 0.3) {
        // The rocket runs up from the start to where the burst will open
        const pos = centre * smoothstep(u / 0.3);
        const width = Math.max(0.06, 1.5 / n);
        for (let i = 0; i < n; i++) {
          const b = pos - (i + 0.5) / n;
          if (b >= 0 && b < width) out.set(mix(cur(i), col, 0.8 * (1 - b / width)), i * 3);
        }
        continue;
      }
      u2 = (u - 0.3) / 0.7;
    }
    const r = (1 - Math.pow(1 - u2, 3)) * 0.17;
    const bright = Math.pow(1 - u2, 1.4);
    const flick = Math.floor(t * 30) + k;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) / n;
      const d = line ? Math.abs(x - centre) : wrapDist(x, centre);
      if (d > r + 0.5 / n) continue;
      const level = bright * (0.35 + 0.65 * Math.pow(d / Math.max(r, 1e-6), 2)) * (0.6 + 0.4 * hash01(i, flick));
      out.set(mix(cur(i), col, level), i * 3);
    }
  }
  return out;
}

function renderConfetti(eff, t, n, o) {
  const bg = rgb(eff.color_secondary);
  const palette = [rgb(eff.color_primary), ...CONFETTI_COLOURS];
  const chance = { few: 0.08, some: 0.18, many: 0.3 }[o.amount];
  const slot = CONFETTI_SLOT / speedOf(eff);
  const out = fill(n, bg);
  for (let i = 0; i < n; i++) {
    const tt = t / slot + hash01(i, 7919);
    const k = Math.floor(tt);
    if (hash01(i, k) >= chance) continue;
    const u = (tt - k - hash01(k, i) * 0.4) / 0.6;
    if (u < 0 || u >= 1) continue;
    const level = u < 0.12 ? u / 0.12 : Math.exp(-3.5 * (u - 0.12));
    out.set(mix(bg, palette[Math.floor(hash01(i * 3 + 1, k) * 5)], level), i * 3);
  }
  return out;
}

function renderRipple(eff, t, n, o, line, origin) {
  const c = rgb(eff.color_primary);
  const bg = rgb(eff.color_secondary);
  // Rings never follow each other faster than a flash may repeat
  const tt = t / Math.max(RIPPLE_PERIOD / speedOf(eff), MIN_FLASH_PERIOD);
  const u = tt - Math.floor(tt);
  const front = u * 1.15;
  const fade = Math.pow(1 - u, 0.8);
  // One LED is 2/count wide in these units, so the ring is never thinner than that
  const width = Math.max(0.09, 2 / n);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const d = originDistance((i + 0.5) / n, origin, line);
    let l = Math.exp(-Math.pow((d - front) / width, 2)) * fade;
    if (d < front) l += 0.22 * Math.pow(1 - u, 2);
    out.set(mix(bg, c, l), i * 3);
  }
  return out;
}

// Smooth noise 0..1 along x
function vnoise(x, seed) {
  const k = Math.floor(x);
  const a = hash01(k, seed);
  return a + (hash01(k + 1, seed) - a) * smoothstep(x - k);
}

function renderFire(eff, t, n, o, line) {
  const flame = rgb(eff.color_primary);
  const cold = rgb(eff.color_secondary);
  const hot = mix(flame, [255, 240, 200], 0.75);
  const sp = speedOf(eff);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    // h: 0 where it burns, 1 at the tips of the flames
    let h, seed;
    if (line) {
      h = eff.reverse ? 1 - x : x;
      seed = 1;
    } else {
      // Loop: it burns on the far side and licks up both halves towards the start point
      const far = Math.abs(1 - 2 * x);
      h = eff.reverse ? 1 - far : far;
      seed = x > 0.5 ? 2 : 1;
    }
    let heat = 1.15 - h * 1.3 + 0.6 * (vnoise(h * 5 - t * sp * FIRE_FLICKER, seed) - 0.5) + 0.3 * (vnoise(h * 14 - t * sp * FIRE_FLICKER_FINE, seed + 9) - 0.5);
    heat = Math.pow(clamp01(heat), 1.3);
    out.set(heat < 0.55 ? mix(cold, flame, heat / 0.55) : mix(flame, hot, (heat - 0.55) / 0.45), i * 3);
  }
  return out;
}


// --- Looks built from light alone: layered colour, blobs, storms, glitches, mirrors, beats ---
// Same maths as flow.rs.
const WHITE = [255, 255, 255];
const AURORA = [[40, 255, 140], [40, 190, 255], [170, 80, 255]];

function hsv(h, s, v) {
  h = mod(h, 1) * 6;
  const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [round(r * 255), round(g * 255), round(b * 255)];
}

function renderAurora(eff, t, n) {
  const tt = t * speedOf(eff);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const acc = [0, 6, 14];
    for (let j = 0; j < 3; j++) {
      const k = [2, 3, 5][j], sp = [0.21, -0.17, 0.3][j], ph = [0, 2.1, 4.2][j];
      const w = Math.sin(2 * Math.PI * k * x + 2 * Math.PI * sp * tt + ph + 1.5 * Math.sin(2 * Math.PI * x - 0.5 * tt + ph));
      const b = Math.pow(0.5 + 0.5 * w, 2.5);
      const m = 0.65 + 0.35 * Math.sin(0.4 * tt + j * 2);
      for (let c = 0; c < 3; c++) acc[c] += AURORA[j][c] * b * m * 0.9;
    }
    out.set([round(acc[0]), round(acc[1]), round(acc[2])], i * 3);
  }
  return out;
}

function renderPlasma(eff, t, n) {
  const tt = t * speedOf(eff);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const v = (Math.sin(2 * Math.PI * 2 * x + 1.1 * tt) + Math.sin(2 * Math.PI * 3 * x - 0.8 * tt) + Math.sin(2 * Math.PI * 5 * x + 0.7 * tt) + Math.sin(2 * Math.PI * 7 * x - 0.5 * tt)) / 4;
    const bright = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * x + tt));
    out.set(hsv(0.5 + 0.5 * v + 0.05 * tt, 0.9, bright), i * 3);
  }
  return out;
}

function renderLava(eff, t, n, o, line) {
  const tt = t * speedOf(eff);
  const c1 = rgb(eff.color_primary), c2 = rgb(eff.color_secondary);
  const hot = mix(c1, WHITE, 0.6);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    let field = 0;
    for (let j = 0; j < 4; j++) {
      const p = 0.5 + 0.4 * Math.sin(0.21 * (j + 1) * tt + 1.7 * j);
      const r = 0.07 + 0.025 * j;
      const d = line ? Math.abs(x - p) : wrapDist(x, p);
      field += (r * r) / (d * d + 0.0008);
    }
    out.set(mix(mix(c2, c1, smoothstep((field - 0.35) / 1.0)), hot, smoothstep((field - 1.6) / 1.5)), i * 3);
  }
  return out;
}

function renderLightning(eff, t, n, o, line) {
  const tt = t * speedOf(eff);
  const c2 = rgb(eff.color_secondary);
  const period = 1.8;
  const k = Math.floor(tt / period);
  const tau = tt - k * period;
  const strike = hash01(k, 1) < 0.8;
  const centre = hash01(k, 2);
  const len = 0.25 + 0.45 * hash01(k, 3);
  let flash = 0;
  if (strike) flash = tau < 0.1 ? 1 : tau >= 0.16 && tau < 0.24 ? 0.7 : tau >= 0.32 && tau < 0.38 ? 0.45 : 0;
  const after = strike && tau >= 0.1 ? Math.exp(-(tau - 0.1) * 2.2) * 0.35 : 0;
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const d = line ? Math.abs(x - centre) : wrapDist(x, centre);
    const bolt = flash * Math.exp(-Math.pow(d / (len / 2), 4)) * (0.45 + 0.55 * hash01(i, 500 + k));
    const wide = after * Math.exp(-Math.pow(d / len, 2));
    out.set(mix(mix(c2, [120, 60, 200], wide), [235, 240, 255], bolt), i * 3);
  }
  return out;
}

const glitchBase = (c1, c2, x, tt) => mix(c1, c2, 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * mod(x, 1) + 0.5 * tt));

function renderGlitch(eff, t, n) {
  const tt = t * speedOf(eff);
  const c1 = rgb(eff.color_primary), c2 = rgb(eff.color_secondary);
  const g = Math.floor(tt * 8);
  const active = hash01(g, 9) < 0.55;
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    let col = glitchBase(c1, c2, x, tt);
    if (active) {
      for (let b = 0; b < 3; b++) {
        const start = hash01(g, 10 + b);
        const width = 0.05 + 0.2 * hash01(g, 20 + b);
        if (mod(x - start, 1) < width) {
          const shift = (hash01(g, 30 + b) - 0.5) * 0.4;
          if (hash01(g, 40 + b) < 0.25) col = [0, 0, 0];
          else {
            const r = glitchBase(c1, c2, x + shift + 0.02, tt)[0];
            const gg = glitchBase(c1, c2, x + shift, tt)[1];
            const bb = glitchBase(c1, c2, x + shift - 0.02, tt)[2];
            col = hash01(g, 50 + b) < 0.3 ? [255 - r, 255 - gg, 255 - bb] : [r, gg, bb];
          }
        }
      }
    }
    out.set(col, i * 3);
  }
  return out;
}

function renderKaleido(eff, t, n) {
  const tt = t * speedOf(eff);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = mod((i + 0.5) / n + 0.02 * tt, 1);
    const u = Math.abs(mod(x * 3, 1) * 2 - 1);
    const hue = 0.1 + 0.55 * u + 0.07 * tt;
    const bright = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * u - 1.3 * tt), 2);
    out.set(hsv(hue, 0.8, bright), i * 3);
  }
  return out;
}

function renderPendulum(eff, t, n) {
  const tt = mod((t * speedOf(eff)) / 30, 1);
  const c1 = rgb(eff.color_primary), c2 = rgb(eff.color_secondary);
  const swing = z => 0.5 + 0.5 * Math.sin(2 * Math.PI * (8 + z) * tt);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const pos = (1 - Math.abs(2 * x - 1)) * 12;
    const z0 = Math.min(11, Math.floor(pos));
    const b = swing(z0) + (swing(Math.min(11, z0 + 1)) - swing(z0)) * smoothstep(pos - z0);
    out.set(mix(c2, c1, smoothstep(b)), i * 3);
  }
  return out;
}

function renderMoire(eff, t, n) {
  const tt = t * speedOf(eff);
  const c1 = rgb(eff.color_primary), c2 = rgb(eff.color_secondary);
  const k1 = Math.max(4, Math.floor(n / 5));
  const k2 = k1 + 3;
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n;
    const v = Math.sin(2 * Math.PI * k1 * x + 0.6 * tt) * Math.sin(2 * Math.PI * k2 * x - 0.9 * tt);
    out.set(mix(c2, c1, smoothstep(0.5 + 0.5 * v)), i * 3);
  }
  return out;
}

const RENDERERS = {
  solid: renderSolid, breathe: renderBreathe, flash: renderFlash, chase: renderChase,
  rainbow: renderRainbow, sparkle: renderSparkle, wave: renderWave, meteors: renderMeteors,
  fireworks: renderFireworks, confetti: renderConfetti, ripple: renderRipple, fire: renderFire,
  aurora: renderAurora, plasma: renderPlasma, lava: renderLava, lightning: renderLightning, glitch: renderGlitch,
  kaleido: renderKaleido, pendulum: renderPendulum, moire: renderMoire
};

// One frame of a look for `count` LEDs; effect is the saved JSON form ({animation, color_primary, ...}).
// line: the segment is a straight strip with two ends, not a loop.
// origin: where the last dart landed, 0..1 round a loop from its start point (ripple); a line ignores it.
export function renderFlowFrame(effect, elapsed, count, line = false, origin = null) {
  if (count <= 0) return new Uint8ClampedArray(0);
  const id = RENDERERS[effect.animation] ? effect.animation : 'solid';
  const out = RENDERERS[id](effect, Math.max(0, elapsed), count, normalizeOptions(id, effect.options), line, origin);
  const bri = effect.brightness;
  if (bri !== undefined && bri !== null && bri >= 0 && bri < 100) {
    const scale = bri / 100;
    for (let i = 0; i < out.length; i++) out[i] = Math.floor(out[i] * scale);
  }
  return out;
}

function lerpAll(a, b, t) {
  if (t <= 0) return Uint8ClampedArray.from(a);
  if (t >= 1) return Uint8ClampedArray.from(b);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) out[i] = round(a[i] + (b[i] - a[i]) * t);
  return out;
}


// --- New transitions: the picture itself changes (size, turning, pieces, resolution, folds, order) ---
// Same maths as flow.rs: each works on both pictures by index only.
const sampleIdx = (p, count) => Math.max(0, Math.min(count - 1, Math.floor(p * count)));
const px = (buf, i) => [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]];

function squeeze(a, b, f, accent, line, origin) {
  const count = Math.floor(a.length / 3);
  const c = line ? 0.5 : mod(origin ?? 0, 1);
  const [src, s] = f < 0.5 ? [a, 1 - smoothstep(f / 0.5)] : [b, smoothstep((f - 0.5) / 0.5)];
  const light = accent || [255, 255, 255];
  const amp = 1 - Math.abs(2 * f - 1);
  const core = Math.max(1.5 / count, 0.03);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    let d = x - c;
    if (!line) {
      if (d > 0.5) d -= 1;
      else if (d < -0.5) d += 1;
    }
    let v = [0, 0, 0];
    if (s > 1e-9) {
      const rel = d / s;
      const p = c + rel;
      const inside = line ? p >= 0 && p < 1 : Math.abs(rel) <= 0.5;
      if (inside) v = px(src, sampleIdx(line ? p : mod(p, 1), count));
    }
    const g = Math.exp(-Math.pow(Math.abs(d) / core, 2)) * amp;
    for (let k = 0; k < 3; k++) out[i * 3 + k] = round(v[k] + (light[k] - v[k]) * g);
  }
  return out;
}

function spin(a, b, f, reverse) {
  const TURNS = 2, TAPS = 7;
  const count = Math.floor(a.length / 3);
  const dir = reverse ? -1 : 1;
  let src, shift, speed;
  if (f < 0.5) { const u = f / 0.5; src = a; shift = u * u * TURNS; speed = 2 * u * TURNS; }
  else { const v = (f - 0.5) / 0.5; src = b; shift = (1 - v) * (1 - v) * TURNS; speed = 2 * (1 - v) * TURNS; }
  const blur = speed * 0.08;
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    const sum = [0, 0, 0];
    for (let k = 0; k < TAPS; k++) {
      const off = (k / (TAPS - 1) - 0.5) * blur;
      const v = px(src, sampleIdx(mod(x - dir * (shift + off), 1), count));
      for (let c = 0; c < 3; c++) sum[c] += v[c];
    }
    for (let c = 0; c < 3; c++) out[i * 3 + c] = round(sum[c] / TAPS);
  }
  return out;
}

function shatter(a, b, f, reverse, line) {
  const count = Math.floor(a.length / 3);
  const size = Math.max(2, Math.floor(count / 12));
  const out = Uint8ClampedArray.from(b);
  for (let k = 0; k * size < count; k++) {
    const q = clamp01((f - 0.5 * hash01(k, 7)) / 0.5);
    if (q >= 1) continue;
    let dir, reach;
    if (line) { dir = reverse ? -1 : 1; reach = count; }
    else { const mid = (k * size + size / 2) / count; dir = mid < 0.5 ? 1 : -1; reach = count * 0.5; }
    const d = dir * Math.floor(q * q * reach + 0.5);
    const keep = 1 - q;
    for (let j = k * size; j < Math.min((k + 1) * size, count); j++) {
      let t = j + d;
      if (line) { if (t < 0 || t >= count) continue; }
      else t = ((t % count) + count) % count;
      for (let c = 0; c < 3; c++) out[t * 3 + c] = round(a[j * 3 + c] * keep);
    }
  }
  return out;
}

function pixelate(a, b, f) {
  const count = Math.floor(a.length / 3);
  const unit = Math.max(1, Math.floor(count / 40));
  let src, stage;
  if (f < 0.5) { src = a; stage = Math.min(4, Math.floor((f / 0.5) * 5)); }
  else { src = b; stage = 4 - Math.min(4, Math.floor(((f - 0.5) / 0.5) * 5)); }
  const block = stage === 0 ? 1 : [1, 2, 4, 8, 16][stage] * unit;
  const out = new Uint8ClampedArray(a.length);
  for (let start = 0; start < count; start += block) {
    const len = Math.min(block, count - start);
    const sum = [0, 0, 0];
    for (let i = start; i < start + len; i++) for (let c = 0; c < 3; c++) sum[c] += src[i * 3 + c];
    for (let i = start; i < start + len; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = round(sum[c] / len);
  }
  return out;
}

function fold(a, b, f, line, origin) {
  const count = Math.floor(a.length / 3);
  const c = line ? 0 : mod(origin ?? 0, 1);
  const [src, z] = f < 0.5 ? [a, 1 + 7 * smoothstep(f / 0.5)] : [b, 1 + 7 * smoothstep(1 - (f - 0.5) / 0.5)];
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    const y = mod(x - c, 1) * z;
    let p = 1 - Math.abs(mod(y, 2) - 1);
    if (!line) p = mod(p + c, 1);
    const j = sampleIdx(p, count);
    for (let k = 0; k < 3; k++) out[i * 3 + k] = src[j * 3 + k];
  }
  return out;
}

function sortOrder(buf) {
  const count = Math.floor(buf.length / 3);
  const lum = i => buf[i * 3] * 3 + buf[i * 3 + 1] * 6 + buf[i * 3 + 2];
  const order = Array.from({ length: count }, (_, i) => i).sort((x, y) => lum(x) - lum(y) || x - y);
  const rank = new Array(count);
  order.forEach((i, r) => { rank[i] = r; });
  return [order, rank];
}

function shuffle(a, b, f) {
  const count = Math.floor(a.length / 3);
  const [orderA, rankA] = sortOrder(a);
  const [orderB, rankB] = sortOrder(b);
  const out = new Uint8ClampedArray(a.length);
  const place = (src, i, pos) => {
    const t = Math.max(0, Math.min(count - 1, Math.floor(pos + 0.5)));
    for (let c = 0; c < 3; c++) out[t * 3 + c] = src[i * 3 + c];
  };
  if (f < 0.45) {
    const e = smoothstep(f / 0.45);
    for (let i = 0; i < count; i++) place(a, i, i + (rankA[i] - i) * e);
  } else if (f < 0.55) {
    const t = smoothstep((f - 0.45) / 0.1);
    for (let r = 0; r < count; r++) for (let c = 0; c < 3; c++) {
      const va = a[orderA[r] * 3 + c], vb = b[orderB[r] * 3 + c];
      out[r * 3 + c] = round(va + (vb - va) * t);
    }
  } else {
    const e = smoothstep((f - 0.55) / 0.45);
    for (let i = 0; i < count; i++) place(b, i, rankB[i] + (i - rankB[i]) * e);
  }
  return out;
}


// --- More transitions: sliding, slats, interlacing, wobbling, growing ink, turning hues (same maths as flow.rs) ---
function blendPx(a, b, out, i, t) {
  for (let c = 0; c < 3; c++) out[i * 3 + c] = round(a[i * 3 + c] + (b[i * 3 + c] - a[i * 3 + c]) * t);
}

function push(a, b, f, reverse) {
  const count = Math.floor(a.length / 3);
  const dir = reverse ? -1 : 1;
  const sh = smoothstep(f);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const q = (i + 0.5) / count - dir * sh;
    const [src, p] = q >= 0 && q < 1 ? [a, q] : [b, mod(q, 1)];
    const j = sampleIdx(p, count);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = src[j * 3 + c];
  }
  return out;
}

function blinds(a, b, f, reverse) {
  const EDGE = 0.15;
  const count = Math.floor(a.length / 3);
  const g = smoothstep(f) * (1 + EDGE);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    let fr = mod(((i + 0.5) / count) * 6, 1);
    if (reverse) fr = 1 - fr;
    blendPx(a, b, out, i, clamp01((g - fr) / EDGE));
  }
  return out;
}

function interlace(a, b, f) {
  const count = Math.floor(a.length / 3);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) blendPx(a, b, out, i, i % 2 === 0 ? smoothstep(f * 2) : smoothstep(f * 2 - 1));
  return out;
}

function liquid(a, b, f, line) {
  const count = Math.floor(a.length / 3);
  const amp = 0.08 * Math.sin(Math.PI * f);
  const w = smoothstep((f - 0.35) / 0.3);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    const d = amp * Math.sin(2 * Math.PI * 3 * x + 8 * Math.PI * f);
    const j = sampleIdx(line ? clamp01(x + d) : mod(x + d, 1), count);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = round(a[j * 3 + c] + (b[j * 3 + c] - a[j * 3 + c]) * w);
  }
  return out;
}

function pnoise(x, len, seed) {
  const y = x * len;
  const k = Math.floor(y);
  const fr = y - k;
  const v0 = hash01(((k % len) + len) % len, seed);
  const v1 = hash01((((k + 1) % len) + len) % len, seed);
  return v0 + (v1 - v0) * smoothstep(fr);
}

function ink(a, b, f) {
  const count = Math.floor(a.length / 3);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    const n = 0.6 * pnoise(x, 6, 3) + 0.4 * pnoise(x, 14, 5);
    blendPx(a, b, out, i, clamp01((f * 1.25 - n) / 0.25));
  }
  return out;
}

function hueTurn(buf, i, theta) {
  const ca = Math.cos(theta), sa = Math.sin(theta);
  const m = [
    [0.213 + ca * 0.787 - sa * 0.213, 0.715 - ca * 0.715 - sa * 0.715, 0.072 - ca * 0.072 + sa * 0.928],
    [0.213 - ca * 0.213 + sa * 0.143, 0.715 + ca * 0.285 + sa * 0.14, 0.072 - ca * 0.072 - sa * 0.283],
    [0.213 - ca * 0.213 - sa * 0.787, 0.715 - ca * 0.715 + sa * 0.715, 0.072 + ca * 0.928 + sa * 0.072]
  ];
  const v = px(buf, i);
  return m.map(r => Math.max(0, Math.min(255, r[0] * v[0] + r[1] * v[1] + r[2] * v[2])));
}

function colourWheel(a, b, f) {
  const count = Math.floor(a.length / 3);
  const w = smoothstep(f);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const ca = hueTurn(a, i, 4 * Math.PI * f);
    const cb = hueTurn(b, i, -4 * Math.PI * (1 - f));
    for (let c = 0; c < 3; c++) out[i * 3 + c] = round(ca[c] + (cb[c] - ca[c]) * w);
  }
  return out;
}


// --- Five more: split colours, smear, negative, crushed colours, glitch cut (same maths as flow.rs) ---
const edgeP = (p, line) => (line ? clamp01(p) : mod(p, 1));

function prism(a, b, f, line) {
  const count = Math.floor(a.length / 3);
  const d = 0.12 * Math.sin(Math.PI * f);
  const w = smoothstep((f - 0.4) / 0.2);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    for (let c = 0; c < 3; c++) {
      const j = sampleIdx(edgeP(x + (c - 1) * d, line), count);
      out[i * 3 + c] = round(a[j * 3 + c] + (b[j * 3 + c] - a[j * 3 + c]) * w);
    }
  }
  return out;
}

function melt(a, b, f, reverse, line) {
  const TAPS = 8;
  const count = Math.floor(a.length / 3);
  const dir = reverse ? -1 : 1;
  const len = 0.3 * Math.sin(Math.PI * f);
  const w = smoothstep((f - 0.3) / 0.5);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    const sa = [0, 0, 0], sb = [0, 0, 0];
    for (let k = 0; k < TAPS; k++) {
      const j = sampleIdx(edgeP(x - (dir * len * k) / (TAPS - 1), line), count);
      for (let c = 0; c < 3; c++) { sa[c] += a[j * 3 + c]; sb[c] += b[j * 3 + c]; }
    }
    for (let c = 0; c < 3; c++) {
      const va = sa[c] / TAPS, vb = sb[c] / TAPS;
      out[i * 3 + c] = round(va + (vb - va) * w);
    }
  }
  return out;
}

function negative(a, b, f) {
  const w = smoothstep((f - 0.4) / 0.2);
  const k = smoothstep(1 - Math.abs(2 * f - 1));
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = a[i] + (b[i] - a[i]) * w;
    out[i] = round(v * (1 - k) + (255 - v) * k);
  }
  return out;
}

function crush(a, b, f) {
  const src = f < 0.5 ? a : b;
  const k = smoothstep(1 - Math.abs(2 * f - 1));
  const levels = 256 - Math.floor(254 * k);
  const step = 255 / (levels - 1);
  const out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) out[i] = round(Math.floor(src[i] / step + 0.5) * step);
  return out;
}

function glitchCut(a, b, f, line) {
  const count = Math.floor(a.length / 3);
  const k = Math.sin(Math.PI * f);
  const g = Math.floor(f * 14);
  const active = hash01(g, 9) < 0.9 * k;
  const out = Uint8ClampedArray.from(f < 0.5 ? a : b);
  if (!active) return out;
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) / count;
    for (let blk = 0; blk < 3; blk++) {
      if (mod(x - hash01(g, 10 + blk), 1) < 0.05 + 0.2 * hash01(g, 20 + blk)) {
        const shift = (hash01(g, 30 + blk) - 0.5) * 0.4 * k;
        const src = hash01(g, 40 + blk) < 0.5 ? a : b;
        const flip = hash01(g, 50 + blk) < 0.2;
        for (let c = 0; c < 3; c++) {
          const j = sampleIdx(edgeP(x + shift + (c - 1) * 0.02 * k, line), count);
          out[i * 3 + c] = flip ? 255 - src[j * 3 + c] : src[j * 3 + c];
        }
      }
    }
  }
  return out;
}

// Blend look a into look b; factor runs 0..1 over the transition
export function blendFlow(a, b, factor, style = 'crossfade', accent = null, reverse = false, line = false, origin = null) {
  const f = clamp01(factor);
  const n = Math.max(a.length, b.length);
  const count = Math.floor(n / 3);
  if (style === 'instant') return Uint8ClampedArray.from(f > 0 ? b : a);
  if (style === 'crossfade') return lerpAll(a, b, smoothstep(f));
  if (['squeeze', 'spin', 'shatter', 'pixelate', 'fold', 'shuffle', 'push', 'blinds', 'interlace', 'liquid', 'ink', 'wheel', 'prism', 'melt', 'negative', 'crush', 'glitchcut'].includes(style)) {
    const pad = x => { const y = new Uint8ClampedArray(n); y.set(x); return y; };
    const [pa, pb] = [pad(a), pad(b)];
    if (style === 'squeeze') return squeeze(pa, pb, f, accent, line, origin);
    if (style === 'spin') return spin(pa, pb, f, reverse);
    if (style === 'shatter') return shatter(pa, pb, f, reverse, line);
    if (style === 'pixelate') return pixelate(pa, pb, f);
    if (style === 'fold') return fold(pa, pb, f, line, origin);
    if (style === 'push') return push(pa, pb, f, reverse);
    if (style === 'blinds') return blinds(pa, pb, f, reverse);
    if (style === 'interlace') return interlace(pa, pb, f);
    if (style === 'liquid') return liquid(pa, pb, f, line);
    if (style === 'ink') return ink(pa, pb, f);
    if (style === 'wheel') return colourWheel(pa, pb, f);
    if (style === 'prism') return prism(pa, pb, f, line);
    if (style === 'melt') return melt(pa, pb, f, reverse, line);
    if (style === 'negative') return negative(pa, pb, f);
    if (style === 'crush') return crush(pa, pb, f);
    if (style === 'glitchcut') return glitchCut(pa, pb, f, line);
    return shuffle(pa, pb, f);
  }
  if (style === 'flash') {
    const peak = fill(count, accent || [255, 255, 255]);
    if (f < FLASH_RISE) return lerpAll(a, peak, smoothstep(f / FLASH_RISE));
    const u = (f - FLASH_RISE) / (1 - FLASH_RISE);
    return lerpAll(peak, b, 1 - Math.pow(1 - u, 2.4));
  }
  if (style === 'sweep') {
    if (f <= 0) return Uint8ClampedArray.from(a);
    if (f >= 1) return Uint8ClampedArray.from(b);
    const light = accent || [255, 255, 255];
    const edge = Math.max(EDGE_SHARE, 1 / Math.max(1, count));
    const front = smoothstep(f) * (1 + edge);
    const amp = Math.pow(Math.sin(Math.PI * f), 0.4);
    const glow = Math.max(SWEEP_GLOW, 1 / count);
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < count; i++) {
      const d = curtainDistance(i, count, 'one', reverse, line);
      const t = clamp01((front - d) / edge);
      const g = Math.exp(-Math.pow((d - front) / glow, 2)) * amp;
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        const v = a[j] + (b[j] - a[j]) * t;
        out[j] = round(v + (light[c] - v) * g);
      }
    }
    return out;
  }
  if (style === 'spread') {
    const edge = Math.max(EDGE_SHARE, 1 / Math.max(1, count));
    const front = smoothstep(f) * (1 + edge);
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < count; i++) {
      const t = clamp01((front - originDistance((i + 0.5) / count, origin, line)) / edge);
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        out[j] = round(a[j] + (b[j] - a[j]) * t);
      }
    }
    return out;
  }
  if (style === 'dissolve') {
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < count; i++) {
      const t = clamp01((f * (1 + DISSOLVE_SPREAD) - hash01(i, 991)) / DISSOLVE_SPREAD);
      for (let c = 0; c < 3; c++) {
        const j = i * 3 + c;
        out[j] = round(a[j] + (b[j] - a[j]) * t);
      }
    }
    return out;
  }
  if (style === 'dip') {
    const src = f < 0.5 ? a : b;
    const level = smoothstep(Math.abs(f - 0.5) * 2);
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) out[i] = round(src[i] * level);
    return out;
  }
  const sides = style === 'wipe' ? 'one' : 'both';
  const edge = Math.max(EDGE_SHARE, 1 / Math.max(1, count));
  const front = smoothstep(f) * (1 + edge);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < count; i++) {
    const t = clamp01((front - curtainDistance(i, count, sides, reverse, line)) / edge);
    for (let c = 0; c < 3; c++) {
      const j = i * 3 + c;
      out[j] = round(a[j] + (b[j] - a[j]) * t);
    }
  }
  return out;
}
