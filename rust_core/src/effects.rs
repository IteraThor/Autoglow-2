//! Port of core/effects (render_animation_frame + blend_frames).
//!
//! Every formula follows the Python source in the same order of operations, with Python's float
//! modulo, int() truncation and round() (half to even), so both engines produce the same bytes.
//! Keep core/effects and this file in step: tests/test_rust_core.py compares them.

use crate::flow::{render_flow, FlowOpts};
use crate::pyrandom::PyRandom;
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rgb {
    pub r: i64,
    pub g: i64,
    pub b: i64,
}

impl Rgb {
    pub const BLACK: Rgb = Rgb { r: 0, g: 0, b: 0 };
    pub fn is_black(&self) -> bool {
        self.r == 0 && self.g == 0 && self.b == 0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Anim {
    Solid,
    Chase,
    Rainbow,
    PastelRainbow,
    Flash,
    Curtain,
    Heartbeat,
    DualComet,
    Sparkle,
    Fire,
    Radar,
    Breathe,
    Pulse,
    Wipe,
    Scan,
    Comet,
    Off,
    /// A name AutoGlow does not know: drawn like Solid, but it is not Solid where the loop compares
    Unknown,
}

impl Anim {
    pub fn parse(s: &str) -> Anim {
        match s {
            "chase" => Anim::Chase,
            "rainbow" => Anim::Rainbow,
            "pastel_rainbow" => Anim::PastelRainbow,
            "flash" => Anim::Flash,
            "curtain" => Anim::Curtain,
            "heartbeat" => Anim::Heartbeat,
            "dual_comet" => Anim::DualComet,
            "sparkle" => Anim::Sparkle,
            "fire" => Anim::Fire,
            "radar" => Anim::Radar,
            "breathe" => Anim::Breathe,
            "pulse" => Anim::Pulse,
            "wipe" => Anim::Wipe,
            "scan" => Anim::Scan,
            "comet" => Anim::Comet,
            "off" => Anim::Off,
            "solid" => Anim::Solid,
            _ => Anim::Unknown,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Effect {
    pub anim: Anim,
    /// The animation name as Python has it (Flow looks dispatch on it)
    pub name: String,
    /// Flow Matrix options (EffectConfig.options normalized); Some = render with the Flow looks
    pub flow: Option<FlowOpts>,
    pub c1: Rgb,
    pub c2: Rgb,
    pub dynamic_secondary: bool,
    pub duration: f64,
    pub speed: f64,
    pub reverse: bool,
    pub brightness: Option<i64>,
    pub transition: String,
    pub transition_duration: f64,
}

impl Effect {
    /// `brightness / 100.0` when it is set and within 0..100, else None
    fn bri_scale(&self) -> Option<f64> {
        match self.brightness {
            Some(b) if (0..=100).contains(&b) => Some(b as f64 / 100.0),
            _ => None,
        }
    }
}

/// Fire keeps a heat buffer between frames (like the module-level buffer in fire.py)
#[derive(Default)]
pub struct FireState {
    heat: Vec<f64>,
}

impl FireState {
    pub const fn new() -> FireState {
        FireState { heat: Vec::new() }
    }
}

// ---------------------------------------------------------------------------------------------
// Python number semantics
// ---------------------------------------------------------------------------------------------

/// Python float `a % b` (result has the sign of b)
#[inline]
pub fn pymod(a: f64, b: f64) -> f64 {
    let m = a % b;
    if m != 0.0 {
        if (b < 0.0) != (m < 0.0) {
            m + b
        } else {
            m
        }
    } else {
        0.0f64.copysign(b)
    }
}

/// Python `int(x)` for a float (truncates toward zero)
#[inline]
fn ti(x: f64) -> i64 {
    x as i64
}

/// Python `round(x)` for a float: half to even
fn round_half_even(x: f64) -> f64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 {
        2.0 * (x / 2.0).round()
    } else {
        r
    }
}

#[inline]
fn fmax(a: f64, b: f64) -> f64 {
    // Python max(a, b): a unless b is greater
    if b > a {
        b
    } else {
        a
    }
}

#[inline]
fn fmin(a: f64, b: f64) -> f64 {
    if b < a {
        b
    } else {
        a
    }
}

#[inline]
fn byte(v: i64) -> u8 {
    // Python would raise for values outside 0..255; the engine clamps instead
    if v < 0 {
        0
    } else if v > 255 {
        255
    } else {
        v as u8
    }
}

#[inline]
fn put(p: &mut [u8], i: usize, r: i64, g: i64, b: i64) {
    p[i * 3] = byte(r);
    p[i * 3 + 1] = byte(g);
    p[i * 3 + 2] = byte(b);
}

fn fill(count: usize, r: i64, g: i64, b: i64) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    for i in 0..count {
        put(&mut p, i, r, g, b);
    }
    p
}

fn normalized_progress(elapsed: f64, duration: f64, speed: f64, reverse: bool) -> f64 {
    let safe_dur = fmax(0.05, duration);
    let safe_speed = fmax(0.01, speed);
    let raw = pymod(elapsed / safe_dur * safe_speed, 1.0);
    if reverse {
        pymod(1.0 - raw, 1.0)
    } else {
        raw
    }
}

fn interpolate_rgb(c1: Rgb, c2: Rgb, factor: f64) -> (i64, i64, i64) {
    let f = fmax(0.0, fmin(1.0, factor));
    let inv = 1.0 - f;
    (
        ti(c1.r as f64 * f + c2.r as f64 * inv),
        ti(c1.g as f64 * f + c2.g as f64 * inv),
        ti(c1.b as f64 * f + c2.b as f64 * inv),
    )
}

/// `int(c1 * f + c2 * (1.0 - f))` per channel (the legacy effects inline this)
#[inline]
fn mix(a: i64, b: i64, f: f64) -> i64 {
    ti(a as f64 * f + b as f64 * (1.0 - f))
}

// ---------------------------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------------------------

pub fn render(e: &Effect, frame: i64, elapsed: f64, count: usize, fire: &mut FireState) -> Vec<u8> {
    if count == 0 {
        return Vec::new();
    }
    // Flow Matrix effects carry options and use the curated, LED-count independent looks
    if let Some(o) = &e.flow {
        return render_flow(e, &e.name, o, elapsed, count);
    }
    match e.anim {
        Anim::Chase => chase(e, elapsed, count),
        Anim::Rainbow => wheel(e, elapsed, count, &RAINBOW_STOPS, (255.0, 0.0, 0.0)),
        Anim::PastelRainbow => wheel(e, elapsed, count, &PASTEL_STOPS, (255.0, 105.0, 115.0)),
        Anim::Flash => flash(e, elapsed, count),
        Anim::Curtain => curtain(e, elapsed, count),
        Anim::Heartbeat => heartbeat(e, elapsed, count),
        Anim::DualComet => dual_comet(e, elapsed, count),
        Anim::Sparkle => sparkle(e, elapsed, count),
        Anim::Fire => fire_effect(e, frame, elapsed, count, fire),
        Anim::Radar => radar(e, elapsed, count),
        Anim::Breathe => breathe(e, elapsed, count),
        Anim::Pulse => legacy_pulse(e, elapsed, count),
        Anim::Wipe => legacy_wipe(e, elapsed, count),
        Anim::Scan => legacy_scan(e, frame, count),
        Anim::Comet => legacy_comet(e, frame, count),
        Anim::Solid | Anim::Off | Anim::Unknown => fill(count, e.c1.r, e.c1.g, e.c1.b),
    }
}

fn chase(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let progress = normalized_progress(elapsed, e.duration, e.speed, false);
    let trail_len = fmax(2.5, count as f64 * 0.28);
    let f_count = count as f64;
    let head_pos = if !e.reverse {
        progress * f_count
    } else {
        pymod(f_count - progress * f_count, f_count)
    };
    for i in 0..count {
        let dist = if !e.reverse {
            pymod(head_pos - i as f64, f_count)
        } else {
            pymod(i as f64 - head_pos, f_count)
        };
        let factor = if dist < trail_len { fmax(0.0, 1.0 - dist / trail_len).powf(1.4) } else { 0.0 };
        let (r, g, b) = interpolate_rgb(e.c1, e.c2, factor);
        put(&mut p, i, r, g, b);
    }
    p
}

type Stop = (f64, (f64, f64, f64));

const RAINBOW_STOPS: [Stop; 9] = [
    (0.00, (255.0, 0.0, 0.0)),
    (0.12, (255.0, 0.0, 0.0)),
    (0.24, (255.0, 60.0, 0.0)),
    (0.36, (255.0, 180.0, 0.0)),
    (0.48, (0.0, 255.0, 10.0)),
    (0.60, (0.0, 220.0, 220.0)),
    (0.74, (0.0, 30.0, 240.0)),
    (0.88, (180.0, 0.0, 180.0)),
    (1.00, (255.0, 0.0, 0.0)),
];

const PASTEL_STOPS: [Stop; 9] = [
    (0.000, (255.0, 35.0, 20.0)),
    (0.125, (255.0, 100.0, 10.0)),
    (0.250, (255.0, 175.0, 5.0)),
    (0.375, (15.0, 240.0, 70.0)),
    (0.500, (5.0, 185.0, 255.0)),
    (0.625, (30.0, 90.0, 255.0)),
    (0.750, (160.0, 25.0, 255.0)),
    (0.875, (255.0, 20.0, 120.0)),
    (1.000, (255.0, 35.0, 20.0)),
];

/// Rainbow and Pastel Rainbow (same code, different colour stops)
fn wheel(e: &Effect, elapsed: f64, count: usize, stops: &[Stop], fallback: (f64, f64, f64)) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let f_count = count as f64;
    let cycle_dur = if e.duration > 0.0 { e.duration } else { 2.0 };
    let progress = normalized_progress(elapsed, cycle_dur, e.speed, false);
    let bri = e.bri_scale().unwrap_or(1.0);
    for i in 0..count {
        let base_pos = i as f64 / f_count;
        let pos = if !e.reverse { pymod(base_pos + progress, 1.0) } else { pymod(base_pos - progress, 1.0) };
        let (mut rf, mut gf, mut bf) = fallback;
        for s in 0..stops.len() - 1 {
            let (p0, c0) = stops[s];
            let (p1, c1) = stops[s + 1];
            if p0 <= pos && pos <= p1 {
                let t = if p1 > p0 { (pos - p0) / (p1 - p0) } else { 0.0 };
                let smooth_t = 0.5 * (1.0 - (t * PI).cos());
                rf = (c0.0 + (c1.0 - c0.0) * smooth_t) * bri;
                gf = (c0.1 + (c1.1 - c0.1) * smooth_t) * bri;
                bf = (c0.2 + (c1.2 - c0.2) * smooth_t) * bri;
                break;
            }
        }
        put(&mut p, i, ti(rf).clamp(0, 255), ti(gf).clamp(0, 255), ti(bf).clamp(0, 255));
    }
    p
}

fn scaled(rgb: (i64, i64, i64), scale: Option<f64>) -> (i64, i64, i64) {
    match scale {
        Some(s) => (ti(rgb.0 as f64 * s), ti(rgb.1 as f64 * s), ti(rgb.2 as f64 * s)),
        None => rgb,
    }
}

fn flash(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let speed = fmax(0.1, e.speed);
    let duration = e.duration;
    let alpha = if duration > 0.0 {
        let total_cycles = (round_half_even(speed) as i64).max(1);
        let norm = fmin(1.0, fmax(0.0, elapsed / duration));
        if norm >= 1.0 {
            0.0
        } else {
            (1.0 - pymod(norm * total_cycles as f64, 1.0)).powf(2.5)
        }
    } else {
        (1.0 - pymod(elapsed * speed, 1.0)).powf(2.5)
    };
    let (r, g, b) = scaled(interpolate_rgb(e.c1, e.c2, alpha), e.bri_scale());
    fill(count, r, g, b)
}

fn curtain(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let speed = fmax(0.1, e.speed);
    let duration = e.duration;
    let norm = if duration > 0.0 {
        fmin(1.0, fmax(0.0, (elapsed * speed) / duration))
    } else {
        pymod(elapsed * speed * 0.5, 1.0)
    };
    let half_count = count as f64 / 2.0;
    let feather = 1.5 / fmax(1.0, half_count);
    let span = 1.0 + feather;
    let bri = e.bri_scale().unwrap_or(1.0);
    let (pp, closing) = if norm <= 0.5 {
        ((norm * 2.0) * span - feather, false)
    } else {
        (((norm - 0.5) * 2.0) * span - feather, true)
    };
    for i in 0..count {
        let symmetric = fmin(i as f64, (count - i) as f64) / fmax(1.0, half_count);
        let dist = if e.reverse { 1.0 - symmetric } else { symmetric };
        let alpha = if !closing {
            if dist <= pp {
                1.0
            } else if dist >= pp + feather {
                0.0
            } else {
                (pp + feather - dist) / feather
            }
        } else if dist <= pp {
            0.0
        } else if dist >= pp + feather {
            1.0
        } else {
            (dist - pp) / feather
        };
        let alpha = fmax(0.0, fmin(1.0, alpha));
        let (mut r, mut g, mut b) = interpolate_rgb(e.c1, e.c2, alpha);
        if bri < 1.0 {
            r = ti(r as f64 * bri);
            g = ti(g as f64 * bri);
            b = ti(b as f64 * bri);
        }
        put(&mut p, i, r, g, b);
    }
    p
}

fn heartbeat_alpha(p: f64) -> f64 {
    if !(0.0..1.0).contains(&p) {
        return 0.0;
    }
    if p < 0.14 {
        let phase = (p / 0.14) * PI;
        return 0.65 * phase.sin().powf(2.0);
    }
    if p < 0.20 {
        return 0.0;
    }
    if p < 0.38 {
        let phase = ((p - 0.20) / 0.18) * PI;
        return 1.00 * phase.sin().powf(2.0);
    }
    0.0
}

fn heartbeat(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let speed = fmax(0.1, e.speed);
    let duration = e.duration;
    let alpha = if duration > 0.0 {
        let total_cycles = (round_half_even(duration * speed) as i64).max(1);
        let norm = fmin(1.0, fmax(0.0, elapsed / duration));
        if norm >= 1.0 {
            0.0
        } else {
            heartbeat_alpha(pymod(norm * total_cycles as f64, 1.0))
        }
    } else {
        heartbeat_alpha(pymod(elapsed * speed, 1.0))
    };
    let (r, g, b) = scaled(interpolate_rgb(e.c1, e.c2, alpha), e.bri_scale());
    fill(count, r, g, b)
}

fn dual_comet(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let speed = fmax(0.1, e.speed);
    let n = count as i64;
    let trail_len = (n / 6).min(20).max(6);
    let pos_a = pymod(elapsed * speed * count as f64 * 0.5, count as f64);
    let pos_b = count as f64 - pymod(elapsed * speed * count as f64 * 0.5, count as f64);
    let mut rb = vec![0.0f64; count];
    let mut gb = vec![0.0f64; count];
    let mut bb = vec![0.0f64; count];
    let mut paint = |head: f64, c: Rgb| {
        let head_i = ti(head);
        for t in 0..trail_len {
            let pos = (head_i - t).rem_euclid(n) as usize;
            let mut f = fmax(0.0, 1.0 - (t as f64 / trail_len as f64)).powf(1.6);
            if t == 0 {
                f = fmin(1.0, f * 1.3);
            }
            rb[pos] += c.r as f64 * f;
            gb[pos] += c.g as f64 * f;
            bb[pos] += c.b as f64 * f;
        }
    };
    paint(pos_a, e.c1);
    paint(pos_b, e.c2);
    let scale = e.bri_scale().unwrap_or(1.0);
    for i in 0..count {
        put(&mut p, i, ti(rb[i] * scale).min(255), ti(gb[i] * scale).min(255), ti(bb[i] * scale).min(255));
    }
    p
}

fn sparkle(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let speed = fmax(0.1, e.speed);
    let (c1, c2) = (e.c1, e.c2);
    let n_active = ti(count as f64 * 0.15).max(1);
    // sparkle.py paints a first pass that the background pass below fully replaces; only the
    // background pass decides the output, so only it is ported
    let mut bg = fill(count, c2.r, c2.g, c2.b);
    for k in 0..n_active {
        let phase = elapsed * speed * 7.3 + k as f64 * 137.5;
        let mut rng = PyRandom::new(ti(phase));
        let pos = rng.randint(0, count as i64 - 1) as usize;
        let frac = pymod(phase, 1.0);
        let alpha = if frac < 0.1 { frac / 0.1 } else { (-5.0 * (frac - 0.1)).exp() };
        let ch = |a: i64, b: i64| ti(b as f64 + (a - b) as f64 * alpha).max(0).min(255);
        if alpha > 0.05 {
            put(&mut bg, pos, ch(c1.r, c2.r), ch(c1.g, c2.g), ch(c1.b, c2.b));
        }
    }
    let scale = e.bri_scale().unwrap_or(1.0);
    let mut p = vec![0u8; count * 3];
    for i in 0..count * 3 {
        p[i] = byte(ti(bg[i] as f64 * scale).min(255));
    }
    p
}

fn heat_to_color(heat: f64, hot: Rgb, base: Rgb) -> (i64, i64, i64) {
    let heat = fmax(0.0, fmin(1.0, heat));
    if heat < 0.4 {
        let t = heat / 0.4;
        (ti(base.r as f64 * t), ti(base.g as f64 * t), ti(base.b as f64 * t))
    } else {
        let t = (heat - 0.4) / 0.6;
        (
            ti(base.r as f64 + (hot.r - base.r) as f64 * t),
            ti(base.g as f64 + (hot.g - base.g) as f64 * t),
            ti(base.b as f64 + (hot.b - base.b) as f64 * t),
        )
    }
}

fn fire_effect(e: &Effect, frame: i64, elapsed: f64, count: usize, st: &mut FireState) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let speed = fmax(0.1, e.speed);
    if st.heat.len() != count {
        st.heat = vec![0.0; count];
    }
    let heat = &mut st.heat;
    let step_interval = ti(50.0 / fmax(0.1, speed * 3.0)).max(1);
    if frame.rem_euclid(step_interval) == 0 {
        let mut rng = PyRandom::new(frame * 1337 + ti(elapsed * 100.0));
        let cooling = 0.02 + 0.06 * (1.0 - fmin(1.0, speed));
        for h in heat.iter_mut() {
            *h = fmax(0.0, *h - rng.uniform(0.0, cooling));
        }
        let mut i = count as i64 - 1;
        while i > 1 {
            let u = i as usize;
            heat[u] = heat[u] * 0.3 + heat[u - 1] * 0.5 + heat[u - 2] * 0.2;
            i -= 1;
        }
        let spark_count = ti(count as f64 * 0.08).max(1);
        for _ in 0..spark_count {
            let pos = rng.randint(0, (count as i64 / 8).max(0)) as usize;
            heat[pos] = fmin(1.0, heat[pos] + rng.uniform(0.6, 1.0));
        }
    }
    let scale = e.bri_scale().unwrap_or(1.0);
    for i in 0..count {
        let (r, g, b) = heat_to_color(heat[i], e.c1, e.c2);
        put(&mut p, i, ti(r as f64 * scale).min(255), ti(g as f64 * scale).min(255), ti(b as f64 * scale).min(255));
    }
    p
}

fn radar(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let speed = fmax(0.1, e.speed);
    let (c1, c2) = (e.c1, e.c2);
    let n = count as i64;
    let sweep = pymod(elapsed * speed * count as f64 * 0.5, count as f64);
    let head = if e.reverse { count as f64 - sweep } else { sweep };
    let head_i = ti(head);
    let trail_len = ti(count as f64 * 0.4).max(4);
    let scale = e.bri_scale().unwrap_or(1.0);
    for i in 0..count {
        let dist_behind = (head_i - i as i64).rem_euclid(n);
        let (r, g, b) = if dist_behind == 0 {
            (
                ti(c1.r as f64 * 1.2 + 40.0).min(255),
                ti(c1.g as f64 * 1.2 + 40.0).min(255),
                ti(c1.b as f64 * 1.2 + 40.0).min(255),
            )
        } else if dist_behind <= trail_len {
            let t = dist_behind as f64 / trail_len as f64;
            let fade = (1.0 - t).powf(1.8);
            (mix(c1.r, c2.r, fade), mix(c1.g, c2.g, fade), mix(c1.b, c2.b, fade))
        } else {
            (c2.r, c2.g, c2.b)
        };
        put(&mut p, i, ti(r as f64 * scale).min(255), ti(g as f64 * scale).min(255), ti(b as f64 * scale).min(255));
    }
    p
}

fn breathe_alpha(p: f64) -> f64 {
    let p = fmax(0.0, fmin(1.0, p));
    if p < 0.45 {
        let phase = (p / 0.45) * (PI / 2.0);
        phase.sin().powf(1.5)
    } else if p < 0.55 {
        1.0
    } else {
        let t = (p - 0.55) / 0.45;
        (t * (PI / 2.0)).cos().powf(1.8)
    }
}

fn breathe(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let speed = fmax(0.05, e.speed);
    let alpha = breathe_alpha(pymod(elapsed * speed, 1.0));
    let (r, g, b) = scaled(interpolate_rgb(e.c1, e.c2, alpha), e.bri_scale());
    fill(count, r, g, b)
}

fn legacy_pulse(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let speed = fmax(0.01, e.speed);
    let f = 0.5 * (1.0 + (elapsed * speed * 6.0).sin());
    fill(count, mix(e.c1.r, e.c2.r, f), mix(e.c1.g, e.c2.g, f), mix(e.c1.b, e.c2.b, f))
}

fn legacy_wipe(e: &Effect, elapsed: f64, count: usize) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let speed = fmax(0.01, e.speed);
    let progress = pymod(elapsed * speed * 0.8, 1.0);
    let fill_leds = ti(count as f64 * progress);
    for i in 0..count {
        let idx = if e.reverse { count - 1 - i } else { i };
        let c = if (i as i64) <= fill_leds { e.c1 } else { e.c2 };
        put(&mut p, idx, c.r, c.g, c.b);
    }
    p
}

fn legacy_scan(e: &Effect, frame: i64, count: usize) -> Vec<u8> {
    let mut p = vec![0u8; count * 3];
    let speed = fmax(0.01, e.speed);
    let n = count as i64;
    let period = (2 * n - 2).max(1);
    let cycle_pos = ti(frame as f64 * speed * 2.0).rem_euclid(period);
    let mut head = if cycle_pos < n { cycle_pos } else { 2 * n - 2 - cycle_pos };
    if e.reverse {
        head = (n - 1) - head;
    }
    let tail_len = n.min(5);
    for i in 0..count {
        let dist = (i as i64 - head).abs();
        if dist < tail_len {
            let f = fmax(0.0, 1.0 - (dist as f64 / tail_len as f64));
            put(&mut p, i, mix(e.c1.r, e.c2.r, f), mix(e.c1.g, e.c2.g, f), mix(e.c1.b, e.c2.b, f));
        } else {
            put(&mut p, i, e.c2.r, e.c2.g, e.c2.b);
        }
    }
    p
}

fn legacy_comet(e: &Effect, frame: i64, count: usize) -> Vec<u8> {
    let speed = fmax(0.01, e.speed);
    let (c1, c2) = (e.c1, e.c2);
    let n = count as i64;
    let trail_len = n.min(10);
    let mut head = ti(frame as f64 * speed * 2.5).rem_euclid(n);
    if e.reverse {
        head = (n - 1) - head;
    }
    let mut p = fill(count, c2.r, c2.g, c2.b);
    for t in 0..trail_len {
        let pos = if e.reverse { (head + t).rem_euclid(n) } else { (head - t).rem_euclid(n) } as usize;
        if t == 0 {
            put(
                &mut p,
                pos,
                ti(c1.r as f64 * 1.2 + 60.0).min(255),
                ti(c1.g as f64 * 1.2 + 60.0).min(255),
                ti(c1.b as f64 * 1.2 + 60.0).min(255),
            );
        } else {
            let f = fmax(0.0, 1.0 - (t as f64 / trail_len as f64)).powf(1.8);
            put(&mut p, pos, mix(c1.r, c2.r, f), mix(c1.g, c2.g, f), mix(c1.b, c2.b, f));
        }
    }
    p
}

// ---------------------------------------------------------------------------------------------
// Transitions (core/effects/transitions.py blend_frames)
// ---------------------------------------------------------------------------------------------

pub fn blend(a: &[u8], b: &[u8], factor: f64, transition: &str, accent: Option<(u8, u8, u8)>) -> Vec<u8> {
    let factor = fmax(0.0, fmin(1.0, factor));
    let target_len = a.len().max(b.len());
    if target_len == 0 {
        return Vec::new();
    }
    let mut out = vec![0u8; target_len];
    let num_leds = target_len / 3;
    let at = |buf: &[u8], i: usize| -> f64 { buf.get(i).copied().unwrap_or(0) as f64 };
    let cross = |out: &mut [u8]| {
        let inv = 1.0 - factor;
        for i in 0..target_len {
            out[i] = byte(ti(at(a, i) * inv + at(b, i) * factor));
        }
    };
    match transition {
        "instant" => {
            let src = if factor >= 0.5 { b } else { a };
            for i in 0..target_len {
                out[i] = src.get(i).copied().unwrap_or(0);
            }
        }
        "wipe" => {
            let cutoff = ti(num_leds as f64 * factor);
            for i in 0..num_leds {
                let src = if (i as i64) < cutoff { b } else { a };
                for ch in 0..3 {
                    out[i * 3 + ch] = src.get(i * 3 + ch).copied().unwrap_or(0);
                }
            }
        }
        "curtain" => {
            let half = (num_leds / 2).max(1);
            let cutoff = ti(half as f64 * factor);
            for i in 0..num_leds {
                let edge = if i < half { i as i64 } else { num_leds as i64 - 1 - i as i64 };
                let src = if edge < cutoff { b } else { a };
                for ch in 0..3 {
                    out[i * 3 + ch] = src.get(i * 3 + ch).copied().unwrap_or(0);
                }
            }
        }
        "flash" => {
            if ti(factor * 12.0) % 2 == 1 {
                let c = accent.unwrap_or((255, 255, 255));
                for i in 0..num_leds {
                    out[i * 3] = c.0;
                    out[i * 3 + 1] = c.1;
                    out[i * 3 + 2] = c.2;
                }
            } else {
                cross(&mut out);
            }
        }
        "pulse" => {
            let dip = (factor - 0.5).abs() * 2.0;
            let (src, w) = if factor < 0.5 { (a, dip) } else { (b, (factor - 0.5) * 2.0) };
            for i in 0..num_leds {
                for ch in 0..3 {
                    let idx = i * 3 + ch;
                    let v = at(src, idx);
                    out[idx] = match accent {
                        Some(c) => {
                            let ac = [c.0, c.1, c.2][ch] as f64;
                            byte(ti(v * w + ac * (1.0 - w)))
                        }
                        None => byte(ti(v * w)),
                    };
                }
            }
        }
        _ => cross(&mut out),
    }
    out
}
