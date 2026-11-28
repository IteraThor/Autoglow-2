//! Port of core/effects/flow (Flow Matrix looks and transitions) and of the hit overlay / hit locator
//! helpers in core/wled_driver.py (_composite, _draw_locator).
//!
//! Same rules as effects.rs: Python's order of operations, float modulo, floor division and int()
//! truncation, so both engines give the same bytes. Options arrive already normalized by Python
//! (normalize_options), so only the plain values are handled here.

use crate::effects::{pymod, Effect, Rgb};
use std::f64::consts::PI;

#[derive(Clone, Debug, PartialEq)]
pub struct FlowOpts {
    pub pulses: i64,
    pub comets: i64,
    pub tail: String,
    pub palette: String,
    pub amount: String,
    pub waves: i64,
    pub edges: String,
}

const SPEED_MIN: f64 = 0.25;
const SPEED_MAX: f64 = 4.0;
const MAX_FLASH_HZ: f64 = 3.0;
const BREATHE_PERIOD: f64 = 4.0;
const CHASE_LAP: f64 = 2.5;
const RAINBOW_LAP: f64 = 6.0;
const SPARKLE_SLOT: f64 = 0.9;
const FLASH_REPEAT: f64 = 2.0;
pub const EDGE_SHARE: f64 = 0.06;
const FLASH_RISE: f64 = 0.2;
const LOCATOR_WIDTH: f64 = 1.0 / 20.0;
const WAVE_PERIOD: f64 = 3.0;
const METEOR_FASTEST: f64 = 0.75;
const METEOR_SLOWEST: f64 = 0.3;
const FIREWORK_PERIOD: f64 = 1.7;
const CONFETTI_SLOT: f64 = 0.8;
const RIPPLE_PERIOD: f64 = 1.4;
const FIRE_FLICKER: f64 = 2.2;
const FIRE_FLICKER_FINE: f64 = 5.0;
const SWEEP_GLOW: f64 = 0.045;
const DISSOLVE_SPREAD: f64 = 0.25;
const GOLD: Color = (255, 215, 140);
const CONFETTI_COLOURS: [Color; 4] = [(255, 60, 90), (255, 200, 40), (60, 220, 120), (200, 90, 255)];

type Color = (i64, i64, i64);

fn min_flash_period() -> f64 {
    1.0 / MAX_FLASH_HZ
}

/// Python float `a // b`
fn py_floordiv(vx: f64, wx: f64) -> f64 {
    let mut m = vx % wx;
    let mut div = (vx - m) / wx;
    if m != 0.0 && ((wx < 0.0) != (m < 0.0)) {
        m += wx;
        div -= 1.0;
    }
    let _ = m;
    if div != 0.0 {
        let mut fd = div.floor();
        if div - fd > 0.5 {
            fd += 1.0;
        }
        fd
    } else {
        0.0f64.copysign(vx / wx)
    }
}

#[inline]
fn pmax(a: f64, b: f64) -> f64 {
    if b > a {
        b
    } else {
        a
    }
}

#[inline]
fn pmin(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}

#[inline]
fn clamp01(t: f64) -> f64 {
    if t < 0.0 {
        0.0
    } else if t > 1.0 {
        1.0
    } else {
        t
    }
}

#[inline]
fn byte(v: i64) -> u8 {
    v.max(0).min(255) as u8
}

fn speed(e: &Effect) -> f64 {
    pmax(SPEED_MIN, pmin(SPEED_MAX, e.speed))
}

fn rgb(c: Rgb) -> Color {
    (c.r, c.g, c.b)
}

/// t = 0 -> a, t = 1 -> b
fn mix(a: Color, b: Color, t: f64) -> Color {
    let t = clamp01(t);
    (
        (a.0 as f64 + (b.0 - a.0) as f64 * t + 0.5) as i64,
        (a.1 as f64 + (b.1 - a.1) as f64 * t + 0.5) as i64,
        (a.2 as f64 + (b.2 - a.2) as f64 * t + 0.5) as i64,
    )
}

fn fill(count: usize, c: Color) -> Vec<u8> {
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        put(&mut out, i, c);
    }
    out
}

#[inline]
fn put(out: &mut [u8], i: usize, c: Color) {
    out[i * 3] = byte(c.0);
    out[i * 3 + 1] = byte(c.1);
    out[i * 3 + 2] = byte(c.2);
}

pub fn smoothstep(t: f64) -> f64 {
    let t = clamp01(t);
    t * t * (3.0 - 2.0 * t)
}

fn hash01(a: i64, b: i64) -> f64 {
    let mut h = (a as u32)
        .wrapping_mul(0x9E37_79B1)
        .wrapping_add((b as u32).wrapping_mul(0x85EB_CA77))
        .wrapping_add(0x1656_67B1);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2C1B_3C6D);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297A_2D39);
    h ^= h >> 15;
    h as f64 / 4294967296.0
}

// --- Looks ---------------------------------------------------------------------------------------

fn breathe(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let period = BREATHE_PERIOD / speed(e);
    let p = pymod(elapsed / period, 1.0);
    let level = 0.5 * (1.0 + (2.0 * PI * p).cos());
    fill(count, mix(rgb(e.c2), rgb(e.c1), level))
}

fn flash_level(e: &Effect, elapsed: f64, pulses: i64) -> f64 {
    let duration = e.duration;
    let (pulse_len, t) = if duration > 0.0 {
        if elapsed >= duration {
            return 0.0;
        }
        let n = pulses.min((duration * MAX_FLASH_HZ + 1e-9) as i64).max(1);
        let pulse_len = pmax(min_flash_period(), pmin(duration / n as f64, 0.7 / speed(e)));
        let k = py_floordiv(elapsed, pulse_len) as i64;
        if k >= n {
            return 0.0;
        }
        (pulse_len, elapsed - k as f64 * pulse_len)
    } else {
        let pulse_len = pmax(min_flash_period(), 0.45 / speed(e));
        let repeat = pmax(pulses as f64 * pulse_len + 0.4, FLASH_REPEAT / speed(e));
        let in_group = pymod(elapsed, repeat);
        let k = py_floordiv(in_group, pulse_len) as i64;
        if k >= pulses {
            return 0.0;
        }
        (pulse_len, in_group - k as f64 * pulse_len)
    };
    let attack = pmin(0.04, pulse_len * 0.15);
    if t < attack {
        return t / attack;
    }
    (1.0 - (t - attack) / (pulse_len - attack)).powf(2.2)
}

fn flash(e: &Effect, elapsed: f64, count: usize, o: &FlowOpts) -> Vec<u8> {
    let level = flash_level(e, elapsed, o.pulses);
    fill(count, mix(rgb(e.c2), rgb(e.c1), level))
}

fn chase(e: &Effect, elapsed: f64, count: usize, o: &FlowOpts) -> Vec<u8> {
    let c_head = rgb(e.c1);
    let c_bg = rgb(e.c2);
    let lap = CHASE_LAP / speed(e);
    let progress = pymod(elapsed / lap, 1.0);
    let share = if o.tail == "long" { 0.35 } else { 0.12 };
    let tail = pmax(1.0, count as f64 * share);
    let n = count as f64;
    let mut out = vec![0u8; count * 3];
    if e.line {
        // A line has ends to bounce off: the strip is unfolded to twice its length, so the tail folds back too
        let l = 2.0 * n;
        let first = pymod(elapsed / lap, 2.0) * n + if e.reverse { n } else { 0.0 };
        let heads = if o.comets == 2 { vec![first, first + n] } else { vec![first] };
        for i in 0..count {
            let centre = i as f64 + 0.5;
            let mut level = 0.0;
            for &head in &heads {
                for at in [centre, l - centre] {
                    let behind = pymod(head - at, l);
                    let lv = if behind > l - 1.0 {
                        1.0 - (l - behind)
                    } else if behind <= tail {
                        (1.0 - behind / tail).powf(1.5)
                    } else {
                        0.0
                    };
                    if lv > level {
                        level = lv;
                    }
                }
            }
            put(&mut out, i, mix(c_bg, c_head, level));
        }
        return out;
    }
    let direction = if e.reverse { -1.0 } else { 1.0 };
    let mut heads = vec![(pymod(progress * n * direction, n), direction)];
    if o.comets == 2 {
        heads.push((pymod(-progress * n * direction, n), -direction));
    }
    for i in 0..count {
        let centre = i as f64 + 0.5;
        let mut level = 0.0;
        for &(head, d) in &heads {
            let behind = pymod((head - centre) * d, n);
            let lv = if behind > n - 1.0 {
                1.0 - (n - behind)
            } else if behind <= tail {
                (1.0 - behind / tail).powf(1.5)
            } else {
                0.0
            };
            if lv > level {
                level = lv;
            }
        }
        put(&mut out, i, mix(c_bg, c_head, level));
    }
    out
}

/// How far a pixel is from where a wipe or curtain transition starts, 0 (start) to 1 (last to fill). From both sides a loop
/// starts at its start point and meets on the far side; a line opens from its middle. Reverse turns that round.
pub fn curtain_distance(i: usize, count: usize, one_side: bool, reverse: bool, line: bool) -> f64 {
    let centre = i as f64 + 0.5;
    if one_side {
        let d = centre / count as f64;
        return if reverse { 1.0 - d } else { d };
    }
    let d = pmin(centre, count as f64 - centre) / (count as f64 / 2.0);
    if line != reverse {
        1.0 - d
    } else {
        d
    }
}

type Stop = (f64, Color);

const VIVID: [Stop; 8] = [
    (0.00, (255, 0, 0)),
    (0.14, (255, 70, 0)),
    (0.28, (255, 190, 0)),
    (0.42, (0, 255, 20)),
    (0.57, (0, 210, 230)),
    (0.71, (0, 40, 255)),
    (0.86, (190, 0, 210)),
    (1.00, (255, 0, 0)),
];
const SOFT: [Stop; 8] = [
    (0.00, (255, 90, 110)),
    (0.14, (255, 150, 90)),
    (0.28, (255, 215, 110)),
    (0.42, (120, 255, 150)),
    (0.57, (100, 225, 255)),
    (0.71, (120, 140, 255)),
    (0.86, (210, 120, 255)),
    (1.00, (255, 90, 110)),
];

fn palette_lut(stops: &[Stop]) -> Vec<Color> {
    let mut lut = Vec::with_capacity(512);
    for k in 0..512 {
        let pos = k as f64 / 512.0;
        for s in 0..stops.len() - 1 {
            let (p0, c0) = stops[s];
            let (p1, c1) = stops[s + 1];
            if p0 <= pos && pos <= p1 {
                let t = (pos - p0) / (p1 - p0);
                lut.push(mix(c0, c1, 0.5 * (1.0 - (PI * t).cos())));
                break;
            }
        }
    }
    lut
}

fn rainbow(e: &Effect, elapsed: f64, count: usize, o: &FlowOpts) -> Vec<u8> {
    let lut = palette_lut(if o.palette == "soft" { &SOFT } else { &VIVID });
    let size = lut.len() as i64;
    let mut progress = pymod(elapsed / (RAINBOW_LAP / speed(e)), 1.0);
    if e.reverse {
        progress = -progress;
    }
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let pos = pymod((i as f64 + 0.5) / count as f64 + progress, 1.0);
        let idx = ((pos * size as f64) as i64).rem_euclid(size) as usize;
        put(&mut out, i, lut[idx]);
    }
    out
}

fn sparkle(e: &Effect, elapsed: f64, count: usize, o: &FlowOpts) -> Vec<u8> {
    let c_spark = rgb(e.c1);
    let c_bg = rgb(e.c2);
    let chance = match o.amount.as_str() {
        "few" => 0.05,
        "many" => 0.25,
        _ => 0.12,
    };
    let slot = SPARKLE_SLOT / speed(e);
    let mut out = fill(count, c_bg);
    for i in 0..count {
        let ii = i as i64;
        let t = elapsed / slot + hash01(ii, 7919);
        let k = t as i64;
        if hash01(ii, k) >= chance {
            continue;
        }
        let start = hash01(k, ii) * 0.4;
        let u = (t - k as f64 - start) / 0.6;
        if !(0.0..1.0).contains(&u) {
            continue;
        }
        let level = if u < 0.12 { u / 0.12 } else { (-4.5 * (u - 0.12)).exp() };
        put(&mut out, i, mix(c_bg, c_spark, level));
    }
    out
}

fn wrap_dist(x: f64, p: f64) -> f64 {
    let d = (x - p).abs();
    pmin(d, 1.0 - d)
}

/// How far a pixel is from where a ripple or a spread begins: 0 at the origin, 1 at the farthest point.
/// A loop spreads both ways round from the origin (the start point without one) and meets opposite;
/// a line always spreads from its middle to both ends.
fn origin_distance(x: f64, origin: Option<f64>, line: bool) -> f64 {
    if line {
        (x - 0.5).abs() * 2.0
    } else {
        wrap_dist(x, pymod(origin.unwrap_or(0.0), 1.0)) * 2.0
    }
}

fn wave(e: &Effect, elapsed: f64, count: usize, o: &FlowOpts) -> Vec<u8> {
    let (c_wave, c_bg) = (rgb(e.c1), rgb(e.c2));
    let dir = if e.reverse { -1.0 } else { 1.0 };
    let phase = dir * elapsed * speed(e) / WAVE_PERIOD;
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let mut s = 0.5 + 0.5 * (2.0 * PI * (x * o.waves as f64 - phase)).sin();
        if o.edges == "sharp" {
            s = clamp01((s - 0.5) * 8.0 + 0.5);
        }
        put(&mut out, i, mix(c_bg, c_wave, s));
    }
    out
}

fn meteors(e: &Effect, elapsed: f64, count: usize, o: &FlowOpts) -> Vec<u8> {
    let (c_head, c_bg) = (rgb(e.c1), rgb(e.c2));
    let n_meteors = match o.amount.as_str() {
        "few" => 2,
        "many" => 6,
        _ => 4,
    };
    let sp = speed(e);
    let mut level = vec![0.0f64; count];
    for m in 0..n_meteors {
        let v = (METEOR_SLOWEST + (METEOR_FASTEST - METEOR_SLOWEST) * hash01(m, 11)) * sp;
        let len = pmax(0.12 + 0.2 * hash01(m, 23), 1.5 / count as f64);
        // A loop is one lap; a line adds the tail running off the end and a pause before the next one
        let cycle = if e.line { 1.0 + len + 0.2 + 0.6 * hash01(m, 31) } else { 1.0 };
        let head = pymod(hash01(m, 5) * cycle + elapsed * v, cycle);
        for i in 0..count {
            let mut x = (i as f64 + 0.5) / count as f64;
            if e.reverse {
                x = 1.0 - x;
            }
            let behind = if e.line { head - x } else { pymod(head - x, 1.0) };
            if behind < 0.0 || behind >= len {
                continue;
            }
            let flicker = if behind > 0.03 { 0.7 + 0.3 * hash01(i as i64, (elapsed * 24.0).floor() as i64 + m * 7) } else { 1.0 };
            let lv = (1.0 - behind / len).powf(1.6) * flicker;
            if lv > level[i] {
                level[i] = lv;
            }
        }
    }
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        put(&mut out, i, mix(c_bg, c_head, level[i]));
    }
    out
}

fn fireworks(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let c_bg = rgb(e.c2);
    let colours = [rgb(e.c1), mix(rgb(e.c1), (255, 255, 255), 0.6), GOLD];
    // Three bursts overlap, so at most three open per second, however fast it is set
    let period = pmax(FIREWORK_PERIOD / speed(e), 3.0 * min_flash_period());
    let n = count as f64;
    let mut out = fill(count, c_bg);
    for s in 0..3i64 {
        let tt = elapsed / period + s as f64 / 3.0;
        let k = tt.floor() as i64;
        let u = tt - k as f64;
        let centre = if e.line { 0.2 + 0.6 * hash01(k, s * 13 + 1) } else { hash01(k, s * 13 + 1) };
        let col = colours[(hash01(k, s + 77) * 3.0) as usize];
        let mut u2 = u;
        if e.line {
            if u < 0.3 {
                // The rocket runs up from the start to where the burst will open
                let head = centre * smoothstep(u / 0.3);
                let width = pmax(0.06, 1.5 / n);
                for i in 0..count {
                    let b = head - (i as f64 + 0.5) / n;
                    if b >= 0.0 && b < width {
                        let cur = (out[i * 3] as i64, out[i * 3 + 1] as i64, out[i * 3 + 2] as i64);
                        put(&mut out, i, mix(cur, col, 0.8 * (1.0 - b / width)));
                    }
                }
                continue;
            }
            u2 = (u - 0.3) / 0.7;
        }
        let r = (1.0 - (1.0 - u2).powf(3.0)) * 0.17;
        let bright = (1.0 - u2).powf(1.4);
        let flick = (elapsed * 30.0).floor() as i64 + k;
        for i in 0..count {
            let x = (i as f64 + 0.5) / n;
            let d = if e.line { (x - centre).abs() } else { wrap_dist(x, centre) };
            if d > r + 0.5 / n {
                continue;
            }
            let level = bright * (0.35 + 0.65 * (d / pmax(r, 1e-6)).powf(2.0)) * (0.6 + 0.4 * hash01(i as i64, flick));
            let cur = (out[i * 3] as i64, out[i * 3 + 1] as i64, out[i * 3 + 2] as i64);
            put(&mut out, i, mix(cur, col, level));
        }
    }
    out
}

fn confetti(e: &Effect, elapsed: f64, count: usize, o: &FlowOpts) -> Vec<u8> {
    let c_bg = rgb(e.c2);
    let palette = [rgb(e.c1), CONFETTI_COLOURS[0], CONFETTI_COLOURS[1], CONFETTI_COLOURS[2], CONFETTI_COLOURS[3]];
    let chance = match o.amount.as_str() {
        "few" => 0.08,
        "many" => 0.3,
        _ => 0.18,
    };
    let slot = CONFETTI_SLOT / speed(e);
    let mut out = fill(count, c_bg);
    for i in 0..count {
        let ii = i as i64;
        let t = elapsed / slot + hash01(ii, 7919);
        let k = t as i64;
        if hash01(ii, k) >= chance {
            continue;
        }
        let u = (t - k as f64 - hash01(k, ii) * 0.4) / 0.6;
        if !(0.0..1.0).contains(&u) {
            continue;
        }
        let level = if u < 0.12 { u / 0.12 } else { (-3.5 * (u - 0.12)).exp() };
        let col = palette[(hash01(ii * 3 + 1, k) * 5.0) as usize];
        put(&mut out, i, mix(c_bg, col, level));
    }
    out
}

fn ripple(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let (c_ring, c_bg) = (rgb(e.c1), rgb(e.c2));
    // Rings never follow each other faster than a flash may repeat
    let tt = elapsed / pmax(RIPPLE_PERIOD / speed(e), min_flash_period());
    let u = tt - tt.floor();
    let front = u * 1.15;
    let fade = (1.0 - u).powf(0.8);
    // One LED is 2/count wide in these units, so the ring is never thinner than that
    let width = pmax(0.09, 2.0 / count as f64);
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let d = origin_distance((i as f64 + 0.5) / count as f64, e.origin, e.line);
        let mut l = (-((d - front) / width).powf(2.0)).exp() * fade;
        if d < front {
            l += 0.22 * (1.0 - u).powf(2.0);
        }
        put(&mut out, i, mix(c_bg, c_ring, l));
    }
    out
}

/// Smooth noise 0..1 along x
fn vnoise(x: f64, seed: i64) -> f64 {
    let k = x.floor();
    let a = hash01(k as i64, seed);
    a + (hash01(k as i64 + 1, seed) - a) * smoothstep(x - k)
}

fn fire(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let (c_flame, c_cold) = (rgb(e.c1), rgb(e.c2));
    let c_hot = mix(c_flame, (255, 240, 200), 0.75);
    let sp = speed(e);
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        // h: 0 where it burns, 1 at the tips of the flames
        let (h, seed) = if e.line {
            (if e.reverse { 1.0 - x } else { x }, 1)
        } else {
            // Loop: it burns on the far side and licks up both halves towards the start point
            let far = (1.0 - 2.0 * x).abs();
            (if e.reverse { 1.0 - far } else { far }, if x > 0.5 { 2 } else { 1 })
        };
        let heat = 1.15 - h * 1.3 + 0.6 * (vnoise(h * 5.0 - elapsed * sp * FIRE_FLICKER, seed) - 0.5) + 0.3 * (vnoise(h * 14.0 - elapsed * sp * FIRE_FLICKER_FINE, seed + 9) - 0.5);
        let heat = clamp01(heat).powf(1.3);
        let c = if heat < 0.55 { mix(c_cold, c_flame, heat / 0.55) } else { mix(c_flame, c_hot, (heat - 0.55) / 0.45) };
        put(&mut out, i, c);
    }
    out
}


// --- Looks built from light alone: layered colour, blobs, storms, glitches, mirrors, beats --------------------

const WHITE: Color = (255, 255, 255);
const AURORA: [Color; 3] = [(40, 255, 140), (40, 190, 255), (170, 80, 255)];

fn hsv(h: f64, s: f64, v: f64) -> Color {
    let h = pymod(h, 1.0) * 6.0;
    let i = h.floor();
    let f = h - i;
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - s * f), v * (1.0 - s * (1.0 - f)));
    let (r, g, b) = match (i as i64) % 6 {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    };
    ((r * 255.0 + 0.5) as i64, (g * 255.0 + 0.5) as i64, (b * 255.0 + 0.5) as i64)
}

/// Northern lights: three soft curtains of green, blue and violet drift and breathe through each other
fn aurora(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = elapsed * speed(e);
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let mut acc = [0.0, 6.0, 14.0];
        for j in 0..3 {
            let k = [2.0, 3.0, 5.0][j];
            let sp = [0.21, -0.17, 0.3][j];
            let ph = [0.0, 2.1, 4.2][j];
            let w = (2.0 * PI * k * x + 2.0 * PI * sp * tt + ph + 1.5 * (2.0 * PI * x - 0.5 * tt + ph).sin()).sin();
            let b = (0.5 + 0.5 * w).powf(2.5);
            let m = 0.65 + 0.35 * (0.4 * tt + j as f64 * 2.0).sin();
            acc[0] += AURORA[j].0 as f64 * b * m * 0.9;
            acc[1] += AURORA[j].1 as f64 * b * m * 0.9;
            acc[2] += AURORA[j].2 as f64 * b * m * 0.9;
        }
        put(&mut out, i, ((acc[0] + 0.5) as i64, (acc[1] + 0.5) as i64, (acc[2] + 0.5) as i64));
    }
    out
}

/// Plasma: four sine waves added up and run through every colour, the way old demos did it
fn plasma(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = elapsed * speed(e);
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let v = ((2.0 * PI * 2.0 * x + 1.1 * tt).sin() + (2.0 * PI * 3.0 * x - 0.8 * tt).sin() + (2.0 * PI * 5.0 * x + 0.7 * tt).sin() + (2.0 * PI * 7.0 * x - 0.5 * tt).sin()) / 4.0;
        let bright = 0.55 + 0.45 * (0.5 + 0.5 * (2.0 * PI * 3.0 * x + tt).sin());
        put(&mut out, i, hsv(0.5 + 0.5 * v + 0.05 * tt, 0.9, bright));
    }
    out
}

/// Lava lamp: soft blobs drift, stretch towards each other and merge into one glowing mass
fn lava(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = elapsed * speed(e);
    let (c1, c2) = (rgb(e.c1), rgb(e.c2));
    let hot = mix(c1, WHITE, 0.6);
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let mut field = 0.0;
        for j in 0..4 {
            let p = 0.5 + 0.4 * (0.21 * (j + 1) as f64 * tt + 1.7 * j as f64).sin();
            let r = 0.07 + 0.025 * j as f64;
            let d = if e.line { (x - p).abs() } else { wrap_dist(x, p) };
            field += r * r / (d * d + 0.0008);
        }
        let glow = smoothstep((field - 0.35) / 1.0);
        let core = smoothstep((field - 1.6) / 1.5);
        put(&mut out, i, mix(mix(c2, c1, glow), hot, core));
    }
    out
}

/// A storm: now and then a jagged bolt flickers three times and leaves a violet afterglow
fn lightning(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = elapsed * speed(e);
    let c2 = rgb(e.c2);
    let period = 1.8;
    let k = (tt / period).floor() as i64;
    let tau = tt - k as f64 * period;
    let strike = hash01(k, 1) < 0.8;
    let centre = hash01(k, 2);
    let len = 0.25 + 0.45 * hash01(k, 3);
    let flash = if !strike {
        0.0
    } else if tau < 0.10 {
        1.0
    } else if (0.16..0.24).contains(&tau) {
        0.7
    } else if (0.32..0.38).contains(&tau) {
        0.45
    } else {
        0.0
    };
    let after = if strike && tau >= 0.1 { (-(tau - 0.1) * 2.2).exp() * 0.35 } else { 0.0 };
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let d = if e.line { (x - centre).abs() } else { wrap_dist(x, centre) };
        let bolt = flash * (-(d / (len / 2.0)).powf(4.0)).exp() * (0.45 + 0.55 * hash01(i as i64, 500 + k));
        let wide = after * (-(d / len).powf(2.0)).exp();
        put(&mut out, i, mix(mix(c2, (120, 60, 200), wide), (235, 240, 255), bolt));
    }
    out
}

fn glitch_base(c1: Color, c2: Color, x: f64, tt: f64) -> Color {
    mix(c1, c2, 0.5 + 0.5 * (2.0 * PI * 2.0 * pymod(x, 1.0) + 0.5 * tt).sin())
}

/// A broken screen: a calm gradient, torn by shifted blocks, split colour channels, inverted patches and dead gaps
fn glitch(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = elapsed * speed(e);
    let (c1, c2) = (rgb(e.c1), rgb(e.c2));
    let g = (tt * 8.0).floor() as i64;
    let active = hash01(g, 9) < 0.55;
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let mut col = glitch_base(c1, c2, x, tt);
        if active {
            for b in 0..3i64 {
                let start = hash01(g, 10 + b);
                let width = 0.05 + 0.2 * hash01(g, 20 + b);
                let off = pymod(x - start, 1.0);
                if off < width {
                    let shift = (hash01(g, 30 + b) - 0.5) * 0.4;
                    if hash01(g, 40 + b) < 0.25 {
                        col = (0, 0, 0);
                    } else {
                        let r = glitch_base(c1, c2, x + shift + 0.02, tt).0;
                        let gg = glitch_base(c1, c2, x + shift, tt).1;
                        let bb = glitch_base(c1, c2, x + shift - 0.02, tt).2;
                        col = if hash01(g, 50 + b) < 0.3 { (255 - r, 255 - gg, 255 - bb) } else { (r, gg, bb) };
                    }
                }
            }
        }
        put(&mut out, i, col);
    }
    out
}

/// A kaleidoscope: the strip is mirrored into cells and a drifting colour pattern lives inside them
fn kaleido(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = elapsed * speed(e);
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = pymod((i as f64 + 0.5) / count as f64 + 0.02 * tt, 1.0);
        let u = (pymod(x * 3.0, 1.0) * 2.0 - 1.0).abs();
        let hue = 0.1 + 0.55 * u + 0.07 * tt;
        let bright = 0.35 + 0.65 * (0.5 + 0.5 * (2.0 * PI * 2.0 * u - 1.3 * tt).sin()).powf(2.0);
        put(&mut out, i, hsv(hue, 0.8, bright));
    }
    out
}

/// Pendulum wave: every part of the strip swings at a slightly different speed; waves form, fan out and snap back into line
fn pendulum(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = pymod(elapsed * speed(e) / 30.0, 1.0);
    let (c1, c2) = (rgb(e.c1), rgb(e.c2));
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let pos = (1.0 - (2.0 * x - 1.0).abs()) * 12.0;
        let z0 = (pos.floor() as usize).min(11);
        let swing = |z: usize| 0.5 + 0.5 * (2.0 * PI * (8 + z) as f64 * tt).sin();
        let b = swing(z0) + (swing((z0 + 1).min(11)) - swing(z0)) * smoothstep(pos - z0 as f64);
        put(&mut out, i, mix(c2, c1, smoothstep(b)));
    }
    out
}

/// Moire: two fine stripe patterns slide against each other and make slow bands where they line up
fn moire(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let tt = elapsed * speed(e);
    let (c1, c2) = (rgb(e.c1), rgb(e.c2));
    let k1 = ((count / 5).max(4)) as f64;
    let k2 = k1 + 3.0;
    let mut out = vec![0u8; count * 3];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let v = (2.0 * PI * k1 * x + 0.6 * tt).sin() * (2.0 * PI * k2 * x - 0.9 * tt).sin();
        put(&mut out, i, mix(c2, c1, smoothstep(0.5 + 0.5 * v)));
    }
    out
}

/// render_flow_frame: one frame of a Flow Matrix look
pub fn render_flow(e: &Effect, anim: &str, o: &FlowOpts, elapsed: f64, count: usize) -> Vec<u8> {
    if count == 0 {
        return Vec::new();
    }
    let elapsed = pmax(0.0, elapsed);
    let mut out = match anim {
        "breathe" => breathe(e, elapsed, count),
        "flash" => flash(e, elapsed, count, o),
        "chase" => chase(e, elapsed, count, o),
        "rainbow" => rainbow(e, elapsed, count, o),
        "sparkle" => sparkle(e, elapsed, count, o),
        "wave" => wave(e, elapsed, count, o),
        "meteors" => meteors(e, elapsed, count, o),
        "fireworks" => fireworks(e, elapsed, count),
        "confetti" => confetti(e, elapsed, count, o),
        "ripple" => ripple(e, elapsed, count),
        "fire" => fire(e, elapsed, count),
        "aurora" => aurora(e, elapsed, count),
        "plasma" => plasma(e, elapsed, count),
        "lava" => lava(e, elapsed, count),
        "lightning" => lightning(e, elapsed, count),
        "glitch" => glitch(e, elapsed, count),
        "kaleido" => kaleido(e, elapsed, count),
        "pendulum" => pendulum(e, elapsed, count),
        "moire" => moire(e, elapsed, count),
        _ => fill(count, rgb(e.c1)),
    };
    if let Some(bri) = e.brightness {
        if (0..100).contains(&bri) {
            let scale = bri as f64 / 100.0;
            for v in out.iter_mut() {
                *v = byte((*v as f64 * scale) as i64);
            }
        }
    }
    out
}

// --- Transitions ---------------------------------------------------------------------------------

fn lerp_all(a: &[u8], b: &[u8], t: f64) -> Vec<u8> {
    if t <= 0.0 {
        return a.to_vec();
    }
    if t >= 1.0 {
        return b.to_vec();
    }
    a.iter()
        .zip(b.iter())
        .map(|(&va, &vb)| byte((va as f64 + (vb as f64 - va as f64) * t + 0.5) as i64))
        .collect()
}


// --- New transitions: the picture itself changes (size, turning, pieces, resolution, folds, order) --------------
// Each works on both pictures by index only, so the browser twin in flow-looks.js gives the same bytes.

fn sample_idx(p: f64, count: usize) -> usize {
    let i = (p * count as f64).floor() as i64;
    i.max(0).min(count as i64 - 1) as usize
}

fn px(buf: &[u8], i: usize) -> [f64; 3] {
    [buf[i * 3] as f64, buf[i * 3 + 1] as f64, buf[i * 3 + 2] as f64]
}

/// The old picture shrinks to one bright dot where the dart landed (the middle of a line), the new one grows out of it
fn squeeze(a: &[u8], b: &[u8], f: f64, accent: Option<(u8, u8, u8)>, line: bool, origin: Option<f64>) -> Vec<u8> {
    let count = a.len() / 3;
    let c = if line { 0.5 } else { pymod(origin.unwrap_or(0.0), 1.0) };
    let (src, s) = if f < 0.5 { (a, 1.0 - smoothstep(f / 0.5)) } else { (b, smoothstep((f - 0.5) / 0.5)) };
    let light = accent.map(|c| [c.0 as f64, c.1 as f64, c.2 as f64]).unwrap_or([255.0, 255.0, 255.0]);
    let amp = 1.0 - (2.0 * f - 1.0).abs();
    let core = pmax(1.5 / count as f64, 0.03);
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let mut d = x - c;
        if !line {
            if d > 0.5 {
                d -= 1.0;
            } else if d < -0.5 {
                d += 1.0;
            }
        }
        let mut v = [0.0; 3];
        if s > 1e-9 {
            let rel = d / s;
            let p = c + rel;
            let inside = if line { (0.0..1.0).contains(&p) } else { rel.abs() <= 0.5 };
            if inside {
                v = px(src, sample_idx(if line { p } else { pymod(p, 1.0) }, count));
            }
        }
        let g = (-(d.abs() / core).powf(2.0)).exp() * amp;
        for k in 0..3 {
            out[i * 3 + k] = byte((v[k] + (light[k] - v[k]) * g + 0.5) as i64);
        }
    }
    out
}

/// The whole picture turns round (a line scrolls round), blurred at speed: the old one spins up, the new one spins down
fn spin(a: &[u8], b: &[u8], f: f64, reverse: bool) -> Vec<u8> {
    const TURNS: f64 = 2.0;
    const TAPS: usize = 7;
    let count = a.len() / 3;
    let dir = if reverse { -1.0 } else { 1.0 };
    let (src, shift, speed) = if f < 0.5 {
        let u = f / 0.5;
        (a, u * u * TURNS, 2.0 * u * TURNS)
    } else {
        let v = (f - 0.5) / 0.5;
        (b, (1.0 - v) * (1.0 - v) * TURNS, 2.0 * (1.0 - v) * TURNS)
    };
    let blur = speed * 0.08;
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let mut sum = [0.0; 3];
        for k in 0..TAPS {
            let off = (k as f64 / (TAPS - 1) as f64 - 0.5) * blur;
            let v = px(src, sample_idx(pymod(x - dir * (shift + off), 1.0), count));
            for c in 0..3 {
                sum[c] += v[c];
            }
        }
        for c in 0..3 {
            out[i * 3 + c] = byte((sum[c] / TAPS as f64 + 0.5) as i64);
        }
    }
    out
}

/// The old picture breaks into pieces that fall (to the bottom of a loop, to one end of a line) and fade, showing the new one
fn shatter(a: &[u8], b: &[u8], f: f64, reverse: bool, line: bool) -> Vec<u8> {
    let count = a.len() / 3;
    let size = (count / 12).max(2);
    let mut out = b.to_vec();
    let mut k = 0usize;
    while k * size < count {
        let q = clamp01((f - 0.5 * hash01(k as i64, 7)) / 0.5);
        if q < 1.0 {
            let (dir, reach) = if line {
                (if reverse { -1i64 } else { 1 }, count as f64)
            } else {
                let mid = ((k * size) as f64 + size as f64 / 2.0) / count as f64;
                (if mid < 0.5 { 1 } else { -1 }, count as f64 * 0.5)
            };
            let d = dir * ((q * q * reach + 0.5).floor() as i64);
            let keep = 1.0 - q;
            for j in (k * size)..((k + 1) * size).min(count) {
                let t = j as i64 + d;
                let t = if line {
                    if t < 0 || t >= count as i64 {
                        continue;
                    }
                    t as usize
                } else {
                    t.rem_euclid(count as i64) as usize
                };
                for c in 0..3 {
                    out[t * 3 + c] = byte((a[j * 3 + c] as f64 * keep + 0.5) as i64);
                }
            }
        }
        k += 1;
    }
    out
}

/// The picture turns into blocks of more and more LEDs, swaps at the coarsest, then sharpens into the new one
fn pixelate(a: &[u8], b: &[u8], f: f64) -> Vec<u8> {
    let count = a.len() / 3;
    let unit = (count / 40).max(1);
    let (src, stage) = if f < 0.5 {
        (a, ((f / 0.5 * 5.0).floor() as usize).min(4))
    } else {
        (b, 4 - ((((f - 0.5) / 0.5) * 5.0).floor() as usize).min(4))
    };
    let block = if stage == 0 { 1 } else { [1usize, 2, 4, 8, 16][stage] * unit };
    let mut out = vec![0u8; a.len()];
    let mut start = 0;
    while start < count {
        let len = block.min(count - start);
        let mut sum = [0.0; 3];
        for i in start..start + len {
            let v = px(src, i);
            for c in 0..3 {
                sum[c] += v[c];
            }
        }
        for i in start..start + len {
            for c in 0..3 {
                out[i * 3 + c] = byte((sum[c] / len as f64 + 0.5) as i64);
            }
        }
        start += block;
    }
    out
}

/// The strip folds like paper into more and more mirrored copies, swaps, then unfolds into the new picture
fn fold(a: &[u8], b: &[u8], f: f64, line: bool, origin: Option<f64>) -> Vec<u8> {
    let count = a.len() / 3;
    let c = if line { 0.0 } else { pymod(origin.unwrap_or(0.0), 1.0) };
    let (src, z) = if f < 0.5 { (a, 1.0 + 7.0 * smoothstep(f / 0.5)) } else { (b, 1.0 + 7.0 * smoothstep(1.0 - (f - 0.5) / 0.5)) };
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let y = pymod(x - c, 1.0) * z;
        let mut p = 1.0 - (pymod(y, 2.0) - 1.0).abs();
        if !line {
            p = pymod(p + c, 1.0);
        }
        let j = sample_idx(p, count);
        out[i * 3..i * 3 + 3].copy_from_slice(&src[j * 3..j * 3 + 3]);
    }
    out
}

/// order[r] = the LED that holds the r-th darkest colour (ties by position); rank[i] = where LED i lands
fn sort_order(buf: &[u8]) -> (Vec<usize>, Vec<usize>) {
    let count = buf.len() / 3;
    let lum = |i: usize| buf[i * 3] as i64 * 3 + buf[i * 3 + 1] as i64 * 6 + buf[i * 3 + 2] as i64;
    let mut order: Vec<usize> = (0..count).collect();
    order.sort_by_key(|&i| (lum(i), i));
    let mut rank = vec![0usize; count];
    for (r, &i) in order.iter().enumerate() {
        rank[i] = r;
    }
    (order, rank)
}

/// The old LEDs slide into colour order, the order swaps to the new colours, and they slide back out into the new picture
fn shuffle(a: &[u8], b: &[u8], f: f64) -> Vec<u8> {
    let count = a.len() / 3;
    let (order_a, rank_a) = sort_order(a);
    let (order_b, rank_b) = sort_order(b);
    let mut out = vec![0u8; a.len()];
    let place = |out: &mut Vec<u8>, src: &[u8], i: usize, pos: f64| {
        let t = ((pos + 0.5).floor() as i64).max(0).min(count as i64 - 1) as usize;
        out[t * 3..t * 3 + 3].copy_from_slice(&src[i * 3..i * 3 + 3]);
    };
    if f < 0.45 {
        let e = smoothstep(f / 0.45);
        for i in 0..count {
            place(&mut out, a, i, i as f64 + (rank_a[i] as f64 - i as f64) * e);
        }
    } else if f < 0.55 {
        let t = smoothstep((f - 0.45) / 0.1);
        for r in 0..count {
            for c in 0..3 {
                let va = a[order_a[r] * 3 + c] as f64;
                let vb = b[order_b[r] * 3 + c] as f64;
                out[r * 3 + c] = byte((va + (vb - va) * t + 0.5) as i64);
            }
        }
    } else {
        let e = smoothstep((f - 0.55) / 0.45);
        for i in 0..count {
            place(&mut out, b, i, rank_b[i] as f64 + (i as f64 - rank_b[i] as f64) * e);
        }
    }
    out
}

// --- More transitions: sliding, slats, interlacing, wobbling, growing ink, turning hues ---------------------------

fn blend_px(a: &[u8], b: &[u8], out: &mut [u8], i: usize, t: f64) {
    for c in 0..3 {
        let va = a[i * 3 + c] as f64;
        out[i * 3 + c] = byte((va + (b[i * 3 + c] as f64 - va) * t + 0.5) as i64);
    }
}

/// The new picture pushes the old one off the strip (round a loop, along a line)
fn push(a: &[u8], b: &[u8], f: f64, reverse: bool) -> Vec<u8> {
    let count = a.len() / 3;
    let dir = if reverse { -1.0 } else { 1.0 };
    let sh = smoothstep(f);
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let q = (i as f64 + 0.5) / count as f64 - dir * sh;
        let (src, p) = if (0.0..1.0).contains(&q) { (a, q) } else { (b, pymod(q, 1.0)) };
        let j = sample_idx(p, count);
        out[i * 3..i * 3 + 3].copy_from_slice(&src[j * 3..j * 3 + 3]);
    }
    out
}

/// Venetian blinds: the strip is six slats and every slat turns to the new picture at once, each from its own start
fn blinds(a: &[u8], b: &[u8], f: f64, reverse: bool) -> Vec<u8> {
    const EDGE: f64 = 0.15;
    let count = a.len() / 3;
    let g = smoothstep(f) * (1.0 + EDGE);
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let mut fr = pymod(x * 6.0, 1.0);
        if reverse {
            fr = 1.0 - fr;
        }
        blend_px(a, b, &mut out, i, clamp01((g - fr) / EDGE));
    }
    out
}

/// Every other LED turns first, the rest follow: a comb of old and new for a moment
fn interlace(a: &[u8], b: &[u8], f: f64) -> Vec<u8> {
    let count = a.len() / 3;
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let t = if i % 2 == 0 { smoothstep(f * 2.0) } else { smoothstep(f * 2.0 - 1.0) };
        blend_px(a, b, &mut out, i, t);
    }
    out
}

/// The picture wobbles like water, more and more, swaps in the middle of the shaking, then settles
fn liquid(a: &[u8], b: &[u8], f: f64, line: bool) -> Vec<u8> {
    let count = a.len() / 3;
    let amp = 0.08 * (PI * f).sin();
    let w = smoothstep((f - 0.35) / 0.3);
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let d = amp * (2.0 * PI * 3.0 * x + 8.0 * PI * f).sin();
        let p = if line { clamp01(x + d) } else { pymod(x + d, 1.0) };
        let j = sample_idx(p, count);
        for c in 0..3 {
            let va = a[j * 3 + c] as f64;
            out[i * 3 + c] = byte((va + (b[j * 3 + c] as f64 - va) * w + 0.5) as i64);
        }
    }
    out
}

/// Looping value noise: lattice of `len` cells that wraps round
fn pnoise(x: f64, len: i64, seed: i64) -> f64 {
    let y = x * len as f64;
    let k = y.floor() as i64;
    let fr = y - k as f64;
    let v0 = hash01(k.rem_euclid(len), seed);
    let v1 = hash01((k + 1).rem_euclid(len), seed);
    v0 + (v1 - v0) * smoothstep(fr)
}

/// The new picture grows in patches like ink spreading in water
fn ink(a: &[u8], b: &[u8], f: f64) -> Vec<u8> {
    let count = a.len() / 3;
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let n = 0.6 * pnoise(x, 6, 3) + 0.4 * pnoise(x, 14, 5);
        blend_px(a, b, &mut out, i, clamp01((f * 1.25 - n) / 0.25));
    }
    out
}

fn hue_turn(buf: &[u8], i: usize, theta: f64) -> [f64; 3] {
    let (ca, sa) = (theta.cos(), theta.sin());
    let m = [
        [0.213 + ca * 0.787 - sa * 0.213, 0.715 - ca * 0.715 - sa * 0.715, 0.072 - ca * 0.072 + sa * 0.928],
        [0.213 - ca * 0.213 + sa * 0.143, 0.715 + ca * 0.285 + sa * 0.140, 0.072 - ca * 0.072 - sa * 0.283],
        [0.213 - ca * 0.213 - sa * 0.787, 0.715 - ca * 0.715 + sa * 0.715, 0.072 + ca * 0.928 + sa * 0.072],
    ];
    let v = px(buf, i);
    [0, 1, 2].map(|r| (m[r][0] * v[0] + m[r][1] * v[1] + m[r][2] * v[2]).max(0.0).min(255.0))
}

/// The old colours spin round the colour wheel twice while the new ones spin in and slow to a stop
fn colour_wheel(a: &[u8], b: &[u8], f: f64) -> Vec<u8> {
    let count = a.len() / 3;
    let w = smoothstep(f);
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let ca = hue_turn(a, i, 4.0 * PI * f);
        let cb = hue_turn(b, i, -4.0 * PI * (1.0 - f));
        for c in 0..3 {
            out[i * 3 + c] = byte((ca[c] + (cb[c] - ca[c]) * w + 0.5) as i64);
        }
    }
    out
}

// --- Five more: split colours, smear, negative, crushed colours, glitch cut --------------------------------------

fn edge_p(p: f64, line: bool) -> f64 {
    if line {
        clamp01(p)
    } else {
        pymod(p, 1.0)
    }
}

/// The three colour channels slide apart, the picture swaps while they are split, and they slide back together
fn prism(a: &[u8], b: &[u8], f: f64, line: bool) -> Vec<u8> {
    let count = a.len() / 3;
    let d = 0.12 * (PI * f).sin();
    let w = smoothstep((f - 0.4) / 0.2);
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        for c in 0..3 {
            let j = sample_idx(edge_p(x + (c as f64 - 1.0) * d, line), count);
            let va = a[j * 3 + c] as f64;
            out[i * 3 + c] = byte((va + (b[j * 3 + c] as f64 - va) * w + 0.5) as i64);
        }
    }
    out
}

/// The picture melts: it smears along the strip, longer and longer, and runs into the new one
fn melt(a: &[u8], b: &[u8], f: f64, reverse: bool, line: bool) -> Vec<u8> {
    const TAPS: usize = 8;
    let count = a.len() / 3;
    let dir = if reverse { -1.0 } else { 1.0 };
    let len = 0.3 * (PI * f).sin();
    let w = smoothstep((f - 0.3) / 0.5);
    let mut out = vec![0u8; a.len()];
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        let (mut sa, mut sb) = ([0.0; 3], [0.0; 3]);
        for k in 0..TAPS {
            let j = sample_idx(edge_p(x - dir * len * k as f64 / (TAPS - 1) as f64, line), count);
            let (va, vb) = (px(a, j), px(b, j));
            for c in 0..3 {
                sa[c] += va[c];
                sb[c] += vb[c];
            }
        }
        for c in 0..3 {
            let (va, vb) = (sa[c] / TAPS as f64, sb[c] / TAPS as f64);
            out[i * 3 + c] = byte((va + (vb - va) * w + 0.5) as i64);
        }
    }
    out
}

/// Like a photographic negative: the colours invert, the picture swaps, and they turn back
fn negative(a: &[u8], b: &[u8], f: f64) -> Vec<u8> {
    let count = a.len() / 3;
    let w = smoothstep((f - 0.4) / 0.2);
    let k = smoothstep(1.0 - (2.0 * f - 1.0).abs());
    let mut out = vec![0u8; a.len()];
    for i in 0..count * 3 {
        let v = a[i] as f64 + (b[i] as f64 - a[i] as f64) * w;
        out[i] = byte((v * (1.0 - k) + (255.0 - v) * k + 0.5) as i64);
    }
    out
}

/// The colours lose their depth down to a few flat shades, the picture swaps, and the depth comes back
fn crush(a: &[u8], b: &[u8], f: f64) -> Vec<u8> {
    let src = if f < 0.5 { a } else { b };
    let k = smoothstep(1.0 - (2.0 * f - 1.0).abs());
    let levels = 256.0 - (254.0 * k).floor();
    let step = 255.0 / (levels - 1.0);
    src.iter().map(|&v| byte(((v as f64 / step + 0.5).floor() * step + 0.5) as i64)).collect()
}

/// A glitch cut: blocks jump between old and new with torn colour channels and flipped colours, then it settles on the new picture
fn glitch_cut(a: &[u8], b: &[u8], f: f64, line: bool) -> Vec<u8> {
    let count = a.len() / 3;
    let k = (PI * f).sin();
    let g = (f * 14.0).floor() as i64;
    let active = hash01(g, 9) < 0.9 * k;
    let base = if f < 0.5 { a } else { b };
    let mut out = base.to_vec();
    if !active {
        return out;
    }
    for i in 0..count {
        let x = (i as f64 + 0.5) / count as f64;
        for blk in 0..3i64 {
            let off = pymod(x - hash01(g, 10 + blk), 1.0);
            if off < 0.05 + 0.2 * hash01(g, 20 + blk) {
                let shift = (hash01(g, 30 + blk) - 0.5) * 0.4 * k;
                let src = if hash01(g, 40 + blk) < 0.5 { a } else { b };
                let flip = hash01(g, 50 + blk) < 0.2;
                for c in 0..3 {
                    let j = sample_idx(edge_p(x + shift + (c as f64 - 1.0) * 0.02 * k, line), count);
                    let v = src[j * 3 + c];
                    out[i * 3 + c] = if flip { 255 - v } else { v };
                }
            }
        }
    }
    out
}

/// blend_flow (style already normalized by Python; anything unknown fades)
pub fn blend_flow(buf_a: &[u8], buf_b: &[u8], factor: f64, style: &str, accent: Option<(u8, u8, u8)>, reverse: bool, line: bool, origin: Option<f64>) -> Vec<u8> {
    let n_bytes = buf_a.len().max(buf_b.len());
    if n_bytes == 0 {
        return Vec::new();
    }
    let mut a = buf_a.to_vec();
    a.resize(n_bytes, 0);
    let mut b = buf_b.to_vec();
    b.resize(n_bytes, 0);
    let f = clamp01(factor);
    let count = n_bytes / 3;
    match style {
        "instant" => {
            if f > 0.0 {
                b
            } else {
                a
            }
        }
        "flash" => {
            let c = accent.unwrap_or((255, 255, 255));
            let mut peak = Vec::with_capacity(count * 3);
            for _ in 0..count {
                peak.extend_from_slice(&[c.0, c.1, c.2]);
            }
            if f < FLASH_RISE {
                lerp_all(&a, &peak, smoothstep(f / FLASH_RISE))
            } else {
                let u = (f - FLASH_RISE) / (1.0 - FLASH_RISE);
                lerp_all(&peak, &b, 1.0 - (1.0 - u).powf(2.4))
            }
        }
        "wipe" | "curtain" => {
            let one = style == "wipe";
            let edge = pmax(EDGE_SHARE, 1.0 / count.max(1) as f64);
            let front = smoothstep(f) * (1.0 + edge);
            let mut out = vec![0u8; n_bytes];
            for i in 0..count {
                let d = curtain_distance(i, count, one, reverse, line);
                let t = clamp01((front - d) / edge);
                for c in 0..3 {
                    let j = i * 3 + c;
                    let va = a[j] as f64;
                    out[j] = byte((va + (b[j] as f64 - va) * t + 0.5) as i64);
                }
            }
            out
        }
        "sweep" => {
            if f <= 0.0 {
                return a;
            }
            if f >= 1.0 {
                return b;
            }
            let light = accent.map(|c| (c.0 as f64, c.1 as f64, c.2 as f64)).unwrap_or((255.0, 255.0, 255.0));
            let light = [light.0, light.1, light.2];
            let edge = pmax(EDGE_SHARE, 1.0 / count.max(1) as f64);
            let front = smoothstep(f) * (1.0 + edge);
            let amp = (PI * f).sin().powf(0.4);
            let glow = pmax(SWEEP_GLOW, 1.0 / count as f64);
            let mut out = vec![0u8; n_bytes];
            for i in 0..count {
                let d = curtain_distance(i, count, true, reverse, line);
                let t = clamp01((front - d) / edge);
                let g = (-((d - front) / glow).powf(2.0)).exp() * amp;
                for c in 0..3 {
                    let j = i * 3 + c;
                    let va = a[j] as f64;
                    let v = va + (b[j] as f64 - va) * t;
                    out[j] = byte((v + (light[c] - v) * g + 0.5) as i64);
                }
            }
            out
        }
        "spread" => {
            let edge = pmax(EDGE_SHARE, 1.0 / count.max(1) as f64);
            let front = smoothstep(f) * (1.0 + edge);
            let mut out = vec![0u8; n_bytes];
            for i in 0..count {
                let d = origin_distance((i as f64 + 0.5) / count as f64, origin, line);
                let t = clamp01((front - d) / edge);
                for c in 0..3 {
                    let j = i * 3 + c;
                    let va = a[j] as f64;
                    out[j] = byte((va + (b[j] as f64 - va) * t + 0.5) as i64);
                }
            }
            out
        }
        "dissolve" => {
            let mut out = vec![0u8; n_bytes];
            for i in 0..count {
                let t = clamp01((f * (1.0 + DISSOLVE_SPREAD) - hash01(i as i64, 991)) / DISSOLVE_SPREAD);
                for c in 0..3 {
                    let j = i * 3 + c;
                    let va = a[j] as f64;
                    out[j] = byte((va + (b[j] as f64 - va) * t + 0.5) as i64);
                }
            }
            out
        }
        "dip" => {
            let src = if f < 0.5 { &a } else { &b };
            let level = smoothstep((f - 0.5).abs() * 2.0);
            src.iter().map(|&v| byte((v as f64 * level + 0.5) as i64)).collect()
        }
        "squeeze" => squeeze(&a, &b, f, accent, line, origin),
        "spin" => spin(&a, &b, f, reverse),
        "shatter" => shatter(&a, &b, f, reverse, line),
        "pixelate" => pixelate(&a, &b, f),
        "fold" => fold(&a, &b, f, line, origin),
        "shuffle" => shuffle(&a, &b, f),
        "push" => push(&a, &b, f, reverse),
        "blinds" => blinds(&a, &b, f, reverse),
        "interlace" => interlace(&a, &b, f),
        "liquid" => liquid(&a, &b, f, line),
        "ink" => ink(&a, &b, f),
        "wheel" => colour_wheel(&a, &b, f),
        "prism" => prism(&a, &b, f, line),
        "melt" => melt(&a, &b, f, reverse, line),
        "negative" => negative(&a, &b, f),
        "crush" => crush(&a, &b, f),
        "glitchcut" => glitch_cut(&a, &b, f, line),
        _ => lerp_all(&a, &b, smoothstep(f)),
    }
}

// --- Hit overlay and hit locator (wled_driver._composite / _draw_locator) ------------------------

pub fn composite(base: &[u8], layer: &[u8], mask: &[u8], scale: f64) -> Vec<u8> {
    let mut out = base.to_vec();
    let len = out.len();
    let mut i = 0;
    while i + 2 < len {
        let m = mask[i].max(mask[i + 1]).max(mask[i + 2]);
        if m != 0 {
            let a = m as f64 / 255.0 * scale;
            for c in i..i + 3 {
                out[c] = byte((base[c] as f64 + (layer[c] as f64 - base[c] as f64) * a + 0.5) as i64);
            }
        }
        i += 3;
    }
    out
}

pub fn draw_locator(base: &[u8], count: usize, position: f64, color: Rgb, level: f64) -> Vec<u8> {
    let mut out = base.to_vec();
    if count == 0 {
        return out;
    }
    let (hi, lo) = (color.r.max(color.g).max(color.b), color.r.min(color.g).min(color.b));
    let col: [i64; 3] = if hi - lo < 40 {
        [255; 3]
    } else {
        [hi + lo - color.r, hi + lo - color.g, hi + lo - color.b]
    };
    // one dart section wide, in whole LEDs (45 LEDs -> 2), centred on the hit
    let n = ((count as f64 * LOCATOR_WIDTH).round() as i64).max(1);
    let first = (position * count as f64 - n as f64 / 2.0).round() as i64;
    for k in 0..n {
        let j = (first + k).rem_euclid(count as i64) as usize * 3;
        for c in 0..3 {
            let v = out[j + c] as f64;
            out[j + c] = byte((v + (col[c] as f64 - v) * level + 0.5) as i64);
        }
    }
    out
}
