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
