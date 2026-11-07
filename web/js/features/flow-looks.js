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

const OPTION_DEFAULTS = {
  solid: {},
  breathe: {},
  flash: { pulses: [1, [1, 2, 3]] },
  chase: { tail: ['short', ['short', 'long']], comets: [1, [1, 2]] },
  curtain: { sides: ['both', ['both', 'one']] },
  rainbow: { palette: ['vivid', ['vivid', 'soft']] },
  sparkle: { amount: ['some', ['few', 'some', 'many']] }
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

function renderChase(eff, t, n, o) {
  const head = rgb(eff.color_primary);
  const bg = rgb(eff.color_secondary);
  const lap = CHASE_LAP / speedOf(eff);
  const progress = mod(t / lap, 1);
  const tail = Math.max(1, n * TAIL_SHARE[o.tail]);
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

export function curtainDistance(i, n, sides, reverse) {
  const centre = i + 0.5;
  if (sides === 'one') {
    const d = centre / n;
    return reverse ? 1 - d : d;
  }
  return Math.min(centre, n - centre) / (n / 2);
}

function renderCurtain(eff, t, n, o) {
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
    const d = curtainDistance(i, n, o.sides, !!eff.reverse);
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

const RENDERERS = {
  solid: renderSolid, breathe: renderBreathe, flash: renderFlash, chase: renderChase,
  curtain: renderCurtain, rainbow: renderRainbow, sparkle: renderSparkle
};

// One frame of a look for `count` LEDs; effect is the saved JSON form ({animation, color_primary, ...})
export function renderFlowFrame(effect, elapsed, count) {
  if (count <= 0) return new Uint8ClampedArray(0);
  const id = RENDERERS[effect.animation] ? effect.animation : 'solid';
  const out = RENDERERS[id](effect, Math.max(0, elapsed), count, normalizeOptions(id, effect.options));
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
export function blendFlow(a, b, factor, style = 'crossfade', accent = null, reverse = false) {
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
  const sides = style === 'wipe' ? 'one' : 'both';
  const edge = Math.max(EDGE_SHARE, 1 / Math.max(1, count));
  const front = smoothstep(f) * (1 + edge);
  const out = new Uint8ClampedArray(n);
  for (let i = 0; i < count; i++) {
    const t = clamp01((front - curtainDistance(i, count, sides, reverse)) / edge);
    for (let c = 0; c < 3; c++) {
      const j = i * 3 + c;
      out[j] = round(a[j] + (b[j] - a[j]) * t);
    }
  }
  return out;
}
