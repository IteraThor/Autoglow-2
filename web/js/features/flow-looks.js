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
const CURTAIN_FILL = 1.0;
const CURTAIN_LOOP = 3.0;
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
  curtain: { sides: ['both', ['both', 'one']] },
  rainbow: { palette: ['vivid', ['vivid', 'soft']] },
  sparkle: { amount: ['some', ['few', 'some', 'many']] },
  wave: { waves: [2, [1, 2, 3]], edges: ['soft', ['soft', 'sharp']] },
  meteors: { amount: ['some', ['few', 'some', 'many']] },
  fireworks: {},
  confetti: { amount: ['some', ['few', 'some', 'many']] },
  ripple: {},
  fire: {}
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

function renderCurtain(eff, t, n, o, line) {
  const c = rgb(eff.color_primary);
  const bg = rgb(eff.color_secondary);
  const speed = speedOf(eff);
  const duration = Number(eff.duration) || 0;
  let closing = false;
  let q;
  if (duration > 0) {
    const fillTime = Math.min(CURTAIN_FILL / speed, duration * 0.6);
    q = fillTime > 0 ? smoothstep(t / fillTime) : 1;
  } else {
    const p = mod(t / (CURTAIN_LOOP / speed), 1);
    if (p < 0.4) q = smoothstep(p / 0.4);
    else if (p < 0.6) q = 1;
    else { q = smoothstep((p - 0.6) / 0.4); closing = true; }
  }
  const edge = Math.max(EDGE_SHARE, 1 / Math.max(1, n));
  const front = q * (1 + edge);
  const out = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < n; i++) {
    const d = curtainDistance(i, n, o.sides, !!eff.reverse, line);
    const covered = clamp01((front - d) / edge);
    out.set(mix(bg, c, closing ? 1 - covered : covered), i * 3);
  }
  return out;
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

const RENDERERS = {
  solid: renderSolid, breathe: renderBreathe, flash: renderFlash, chase: renderChase,
  curtain: renderCurtain, rainbow: renderRainbow, sparkle: renderSparkle, wave: renderWave, meteors: renderMeteors,
  fireworks: renderFireworks, confetti: renderConfetti, ripple: renderRipple, fire: renderFire
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

// Blend look a into look b; factor runs 0..1 over the transition
export function blendFlow(a, b, factor, style = 'crossfade', accent = null, reverse = false, line = false, origin = null) {
  const f = clamp01(factor);
  const n = Math.max(a.length, b.length);
  const count = Math.floor(n / 3);
  if (style === 'instant') return Uint8ClampedArray.from(f > 0 ? b : a);
  if (style === 'crossfade') return lerpAll(a, b, smoothstep(f));
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
