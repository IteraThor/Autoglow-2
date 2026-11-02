//! The real-time LED loop on its own OS thread.
//!
//! Python hands over a snapshot of the scene (targets, LED layout, the effect on every segment)
//! whenever it changes; this thread renders and sends a DRGB frame every 20 ms from the latest
//! snapshot. It never takes the Python GIL, so a busy AutoGlow event loop (camera relay, web
//! requests, game events) can no longer delay or skip LED frames.
//!
//! compose() is the frame body of WLEDDriver._run_master_broadcast_loop, step for step.

use crate::effects::{blend, render, Anim, Effect, FireState, Rgb};
use crate::flow::{blend_flow, composite, draw_locator};
use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const FPS: u64 = 50;
const DRGB_TIMEOUT_S: u8 = 2;
/// WLED realtime UDP limits: one DRGB packet holds 490 LEDs, one DNRGB packet 489
const DRGB_MAX_LEDS: usize = 490;
const DNRGB_MAX_LEDS: usize = 489;
/// A Flow hit fades back into the current look over its last 0.3 s
const FLOW_HIT_FADE_BACK: f64 = 0.3;
const ERROR_LOG_INTERVAL: Duration = Duration::from_secs(5);
const RESOLVE_RETRY: Duration = Duration::from_secs(5);
const MAX_PENDING_ERRORS: usize = 50;

#[derive(Clone, Debug)]
pub struct Channel {
    pub id: i64,
    pub start: i64,
    pub stop: i64,
    pub offset: i64,
    pub baseline: Option<Effect>,
    pub baseline_start: f64,
    pub transient: Option<Effect>,
    pub transient_start: f64,
    pub transient_duration: f64,
    pub last_color: Option<Rgb>,
    /// Flow Matrix channel (WLEDDriver.flow_show / flow_hit / flow_locate)
    pub flow: bool,
    /// Changes whenever Python clears the channel's flow state, so an older last picture is not reused
    pub flow_session: i64,
    pub fade: Option<Fade>,
    pub overlay: Option<Overlay>,
    pub locator: Option<Locator>,
}

/// A look blending in from the previous picture (frozen frame) or the previous look
#[derive(Clone, Debug)]
pub struct Fade {
    pub start: f64,
    pub duration: f64,
    pub style: String,
    pub accent: Option<(u8, u8, u8)>,
    pub frame: Option<Vec<u8>>,
    pub effect: Option<Effect>,
    pub effect_start: f64,
}

/// A hit on top of the look: `layer` shows as much as `mask`'s brightness says
#[derive(Clone, Debug)]
pub struct Overlay {
    pub start: f64,
    pub duration: f64,
    pub strength: f64,
    pub layer: Effect,
    pub mask: Effect,
    pub brightness: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Locator {
    pub start: f64,
    pub duration: f64,
    pub position: f64,
    pub color: Rgb,
}

#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub targets: Vec<String>,
    pub port: u16,
    pub total: usize,
    pub pwm_indices: Vec<i64>,
    pub pwm_value: u8,
    pub channels: Vec<Channel>,
}

/// time.time()
pub fn wall() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// WLEDDriver._resolve_effective_config: Match Previous takes the secondary colour from the
/// baseline, else the channel's last active colour, else black
fn resolve(effect: &Effect, baseline: Option<&Effect>, last: Option<Rgb>) -> Effect {
    let mut e = effect.clone();
    if !effect.dynamic_secondary {
        return e;
    }
    let mut bg = None;
    if let Some(b) = baseline {
        if b.anim != Anim::Off && !b.c1.is_black() {
            bg = Some(b.c1);
        }
    }
    if bg.is_none() {
        if let Some(c) = last {
            if !c.is_black() {
                bg = Some(c);
            }
        }
    }
    e.c2 = bg.unwrap_or(Rgb::BLACK);
    e
}

/// Rotate a segment frame so its first LED lands `offset` LEDs after the segment start
fn apply_offset(seg: Vec<u8>, offset: i64) -> Vec<u8> {
    let seg_len = (seg.len() / 3) as i64;
    let offset = if seg_len > 0 { offset.rem_euclid(seg_len) } else { 0 };
    if offset == 0 {
        return seg;
    }
    let cut = ((seg_len - offset) * 3) as usize;
    let mut out = Vec::with_capacity(seg.len());
    out.extend_from_slice(&seg[cut..]);
    out.extend_from_slice(&seg[..cut]);
    out
}

fn clamp_byte(v: i64) -> u8 {
    v.max(0).min(255) as u8
}

/// WLEDDriver._render_flow_channel: the look (fading in), a hit on top, the hit locator.
/// Returns the segment frame and the look's own picture (last_base), or None without a look.
fn render_flow_channel(ch: &Channel, now: f64, count: usize, fire: &mut FireState) -> Option<(Vec<u8>, Vec<u8>)> {
    let base_eff = ch.baseline.as_ref()?;
    let mut base = render(base_eff, 0, now - ch.baseline_start, count, fire);
    if let Some(fade) = &ch.fade {
        let f = (now - fade.start) / fade.duration;
        if f < 1.0 {
            let mut src = match (&fade.frame, &fade.effect) {
                (Some(fr), _) => Some(fr.clone()),
                (None, Some(e)) => Some(render(e, 0, now - fade.effect_start, count, fire)),
                (None, None) => None,
            };
            if src.as_ref().map_or(true, |s| s.len() != count * 3) {
                src = Some(vec![0u8; count * 3]);
            }
            base = blend_flow(&src.unwrap(), &base, f, &fade.style, fade.accent, false);
        }
    }
    let last_base = base.clone();
    let mut out = base;
    if let Some(ov) = &ch.overlay {
        let el = now - ov.start;
        let dur = ov.duration;
        if el < dur {
            let back = if dur * 0.4 < FLOW_HIT_FADE_BACK { dur * 0.4 } else { FLOW_HIT_FADE_BACK };
            let r = (dur - el) / back;
            let mut scale = ov.strength * if r < 1.0 { r } else { 1.0 };
            if let Some(bri) = ov.brightness {
                if (0..100).contains(&bri) {
                    scale *= bri as f64 / 100.0;
                }
            }
            let layer = render(&ov.layer, 0, el, count, fire);
            let mask = render(&ov.mask, 0, el, count, fire);
            out = composite(&out, &layer, &mask, scale);
        }
    }
    if let Some(loc) = &ch.locator {
        let el = now - loc.start;
        if el < loc.duration {
            out = draw_locator(&out, count, loc.position, loc.color, (1.0 - el / loc.duration).powf(1.5));
        }
    }
    Some((out, last_base))
}

pub struct FrameOut {
    pub buf: Vec<u8>,
    /// Whether any segment is still active
    pub any_active: bool,
    /// Last active colours SOLID segments recorded
    pub solid_updates: Vec<(i64, Rgb)>,
    /// (segment, flow session, the look's picture) of every Flow segment drawn
    pub last_bases: Vec<(i64, i64, Vec<u8>)>,
}

/// One frame of WLEDDriver._compose_frame
pub fn compose(scene: &Scene, frame: i64, t0: f64, fire: &mut FireState, last_colors: &HashMap<i64, Rgb>) -> FrameOut {
    let total = scene.total as i64;
    let mut buf = vec![0u8; scene.total * 3];
    let mut any_active = false;
    let mut ranges: Vec<(i64, i64)> = Vec::new();
    let mut solid_updates: Vec<(i64, Rgb)> = Vec::new();
    let mut last_bases: Vec<(i64, i64, Vec<u8>)> = Vec::new();

    for ch in &scene.channels {
        let start = ch.start.max(0);
        let stop = ch.stop.min(total);
        let seg_len = stop - start;
        if seg_len <= 0 {
            continue;
        }

        if ch.flow {
            if let Some((out, last_base)) = render_flow_channel(ch, t0, seg_len as usize, fire) {
                any_active = true;
                ranges.push((start, stop));
                let seg = apply_offset(out, ch.offset);
                buf[(start * 3) as usize..(stop * 3) as usize].copy_from_slice(&seg);
                last_bases.push((ch.id, ch.flow_session, last_base));
            }
            continue;
        }

        let mut active: Option<&Effect> = None;
        let mut eff_elapsed = 0.0;
        let mut blend_with_baseline = false;
        let mut blend_factor = 0.0;

        if let Some(t) = &ch.transient {
            let elapsed = t0 - ch.transient_start;
            let dur = ch.transient_duration;
            if elapsed < dur {
                active = Some(t);
                eff_elapsed = elapsed;
                let t_dur = t.transition_duration;
                if t_dur > 0.0 && ch.baseline.is_some() && (dur - elapsed) <= t_dur {
                    blend_with_baseline = true;
                    let x = (dur - elapsed) / t_dur;
                    blend_factor = 1.0 - if x < 0.0 { 0.0 } else if x > 1.0 { 1.0 } else { x };
                }
            }
        }
        if active.is_none() {
            if let Some(b) = &ch.baseline {
                active = Some(b);
                eff_elapsed = t0 - ch.baseline_start;
            }
        }
        let active = match active {
            Some(a) if a.anim != Anim::Off => a,
            _ => continue,
        };

        any_active = true;
        ranges.push((start, stop));
        let last = last_colors.get(&ch.id).copied().or(ch.last_color);
        let (s, e) = ((start * 3) as usize, (stop * 3) as usize);

        if blend_with_baseline {
            let (t, b) = (ch.transient.as_ref().unwrap(), ch.baseline.as_ref().unwrap());
            let t_buf = render(&resolve(t, Some(b), last), frame, eff_elapsed, seg_len as usize, fire);
            let base_elapsed = t0 - ch.baseline_start;
            let b_buf = render(&resolve(b, None, last), frame, base_elapsed, seg_len as usize, fire);
            let seg = apply_offset(blend(&t_buf, &b_buf, blend_factor, &t.transition, None), ch.offset);
            buf[s..e].copy_from_slice(&seg);
        } else if active.anim == Anim::Solid {
            let c = active.c1;
            if !c.is_black() {
                solid_updates.push((ch.id, c));
            }
            for idx in start..stop {
                let i = (idx * 3) as usize;
                buf[i] = clamp_byte(c.r);
                buf[i + 1] = clamp_byte(c.g);
                buf[i + 2] = clamp_byte(c.b);
            }
        } else {
            let seg = render(&resolve(active, ch.baseline.as_ref(), last), frame, eff_elapsed, seg_len as usize, fire);
            let seg = apply_offset(seg, ch.offset);
            buf[s..e].copy_from_slice(&seg);
        }
    }

    // Light strips without an active matrix event keep the default spotlight brightness
    for &idx in &scene.pwm_indices {
        if idx < 0 || idx >= total || ranges.iter().any(|&(a, b)| a <= idx && idx < b) {
            continue;
        }
        let i = (idx * 3) as usize;
        buf[i] = scene.pwm_value;
        buf[i + 1] = scene.pwm_value;
        buf[i + 2] = scene.pwm_value;
    }
    FrameOut { buf, any_active, solid_updates, last_bases }
}

/// WLEDDriver._create_udp_packets: one DRGB packet, or DNRGB packets of 489 LEDs for longer strips
pub fn udp_packets(buf: &[u8]) -> Vec<Vec<u8>> {
    if buf.len() <= DRGB_MAX_LEDS * 3 {
        let mut p = Vec::with_capacity(buf.len() + 2);
        p.push(0x02);
        p.push(DRGB_TIMEOUT_S);
        p.extend_from_slice(buf);
        return vec![p];
    }
    buf.chunks(DNRGB_MAX_LEDS * 3)
        .enumerate()
        .map(|(n, chunk)| {
            let start = n * DNRGB_MAX_LEDS;
            let mut p = Vec::with_capacity(chunk.len() + 4);
            p.extend_from_slice(&[0x04, DRGB_TIMEOUT_S, ((start >> 8) & 0xFF) as u8, (start & 0xFF) as u8]);
            p.extend_from_slice(chunk);
            p
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Engine thread
// ---------------------------------------------------------------------------------------------

#[derive(Default, Clone)]
pub struct Stats {
    pub frames: u64,
    pub late_2ms: u64,
    pub late_5ms: u64,
    pub late_10ms: u64,
    pub max_dev_ms: f64,
    pub compute_total_us: f64,
    pub compute_max_us: f64,
    pub dropped_packets: u64,
}

struct State {
    scene: Arc<Scene>,
    gen: u64,
    /// Bumped by every start and stop; a thread runs only while the epoch it started with is current
    epoch: u64,
    running: bool,
    /// Last active colours SOLID segments recorded here (dropped when Python sends a new one)
    last_colors: HashMap<i64, Rgb>,
    unreported_colors: HashMap<i64, Rgb>,
    /// Flow segments' last look picture with the flow session it belongs to
    last_bases: HashMap<i64, (i64, Vec<u8>)>,
    latest: Option<Vec<u8>>,
    latest_seq: u64,
    taken_seq: u64,
    errors: Vec<String>,
    stats: Stats,
}

pub struct Shared {
    state: Mutex<State>,
    cv: Condvar,
}

impl Shared {
    pub fn new() -> Arc<Shared> {
        Arc::new(Shared {
            state: Mutex::new(State {
                scene: Arc::new(Scene::default()),
                gen: 0,
                epoch: 0,
                running: false,
                last_colors: HashMap::new(),
                unreported_colors: HashMap::new(),
                last_bases: HashMap::new(),
                latest: None,
                latest_seq: 0,
                taken_seq: 0,
                errors: Vec::new(),
                stats: Stats::default(),
            }),
            cv: Condvar::new(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // A panic while holding the lock leaves plain data behind; keep using it
        match self.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    pub fn update(&self, scene: Scene) {
        let mut s = self.lock();
        for ch in &scene.channels {
            let old = s.scene.channels.iter().find(|c| c.id == ch.id).and_then(|c| c.last_color);
            if old != ch.last_color {
                s.last_colors.remove(&ch.id);
            }
        }
        s.scene = Arc::new(scene);
        s.gen += 1;
    }

    /// Start the thread unless it runs. True when it was started.
    pub fn ensure_running(self: &Arc<Self>) -> bool {
        let mut s = self.lock();
        if s.running {
            return false;
        }
        s.epoch += 1;
        s.running = true;
        let epoch = s.epoch;
        drop(s);
        let me = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name("autoglow-led".into())
            .spawn(move || run(me, epoch));
        if let Err(e) = spawned {
            let mut s = self.lock();
            s.running = false;
            push_error(&mut s, format!("Could not start the LED thread: {}", e));
            return false;
        }
        true
    }

    pub fn stop(&self) {
        let mut s = self.lock();
        s.epoch += 1;
        s.running = false;
        drop(s);
        self.cv.notify_all();
    }

    pub fn running(&self) -> bool {
        self.lock().running
    }

    pub fn take_frame(&self) -> Option<Vec<u8>> {
        let mut s = self.lock();
        if s.latest_seq == s.taken_seq {
            return None;
        }
        s.taken_seq = s.latest_seq;
        s.latest.clone()
    }

    pub fn take_last_colors(&self) -> HashMap<i64, Rgb> {
        std::mem::take(&mut self.lock().unreported_colors)
    }

    /// The look picture a Flow segment showed last, if it belongs to this flow session
    pub fn last_base(&self, id: i64, session: i64) -> Option<Vec<u8>> {
        match self.lock().last_bases.get(&id) {
            Some((s, b)) if *s == session => Some(b.clone()),
            _ => None,
        }
    }

    pub fn take_errors(&self) -> Vec<String> {
        std::mem::take(&mut self.lock().errors)
    }

    pub fn stats(&self, reset: bool) -> Stats {
        let mut s = self.lock();
        let out = s.stats.clone();
        if reset {
            s.stats = Stats::default();
        }
        out
    }
}

fn push_error(s: &mut State, msg: String) {
    if s.errors.len() < MAX_PENDING_ERRORS {
        s.errors.push(msg);
    }
}

fn resolve_target(host: &str, port: u16) -> Option<SocketAddr> {
    if let Ok(ip) = host.parse::<Ipv4Addr>() {
        return Some(SocketAddr::V4(SocketAddrV4::new(ip, port)));
    }
    // Host names (e.g. wled.local); IPv4 only, like the Python AF_INET socket
    (host, port).to_socket_addrs().ok()?.find(|a| a.is_ipv4())
}

struct Targets {
    key: (Vec<String>, u16),
    addrs: Vec<(String, Option<SocketAddr>)>,
    resolved_at: Instant,
}

impl Targets {
    fn refresh(&mut self, scene: &Scene) {
        let key = (scene.targets.clone(), scene.port);
        let retry = self.addrs.iter().any(|(_, a)| a.is_none()) && self.resolved_at.elapsed() >= RESOLVE_RETRY;
        if key != self.key || retry {
            self.addrs = scene.targets.iter().map(|h| (h.clone(), resolve_target(h, scene.port))).collect();
            self.key = key;
            self.resolved_at = Instant::now();
        }
    }
}

fn run(shared: Arc<Shared>, epoch: u64) {
    let sock = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(e) => {
            let mut s = shared.lock();
            push_error(&mut s, format!("Could not open the UDP socket for the LED stream: {}", e));
            if s.epoch == epoch {
                s.running = false;
            }
            return;
        }
    };
    let _ = sock.set_nonblocking(true); // a full send buffer drops the frame instead of stalling the loop

    let dt = Duration::from_micros(1_000_000 / FPS);
    let mut fire = FireState::default();
    let mut targets = Targets { key: (Vec::new(), 0), addrs: Vec::new(), resolved_at: Instant::now() };
    let mut dropped: HashMap<String, u64> = HashMap::new();
    let mut last_error_log: HashMap<String, Instant> = HashMap::new();
    let mut frame: i64 = 0;
    let mut next = Instant::now();
    let mut last_start: Option<Instant> = None;

    loop {
        let (scene, gen, last_colors) = {
            let s = shared.lock();
            if s.epoch != epoch {
                return;
            }
            (Arc::clone(&s.scene), s.gen, s.last_colors.clone())
        };

        let started = Instant::now();
        let t0 = wall();
        let out = compose(&scene, frame, t0, &mut fire, &last_colors);
        let compute_us = started.elapsed().as_secs_f64() * 1e6;
        let any_active = out.any_active;

        targets.refresh(&scene);
        let packets = udp_packets(&out.buf);

        let mut new_errors: Vec<String> = Vec::new();
        let mut failed: u64 = 0;
        {
            let mut s = shared.lock();
            if s.epoch != epoch {
                return; // stopped while rendering: send nothing more
            }
            for (id, c) in &out.solid_updates {
                s.last_colors.insert(*id, *c);
                s.unreported_colors.insert(*id, *c);
            }
            for (id, session, b) in out.last_bases {
                s.last_bases.insert(id, (session, b));
            }
            s.latest = Some(out.buf);
            s.latest_seq += 1;
            let st = &mut s.stats;
            st.frames += 1;
            st.compute_total_us += compute_us;
            if compute_us > st.compute_max_us {
                st.compute_max_us = compute_us;
            }
            if let Some(prev) = last_start {
                let dev_ms = ((started - prev).as_secs_f64() - dt.as_secs_f64()).abs() * 1e3;
                if dev_ms > 2.0 {
                    st.late_2ms += 1;
                }
                if dev_ms > 5.0 {
                    st.late_5ms += 1;
                }
                if dev_ms > 10.0 {
                    st.late_10ms += 1;
                }
                if dev_ms > st.max_dev_ms {
                    st.max_dev_ms = dev_ms;
                }
            }
        }
        last_start = Some(started);

        for (host, addr) in &targets.addrs {
            // Like the Python loop: the first failing packet ends this frame for that controller
            let res = match addr {
                Some(a) => packets.iter().try_for_each(|p| sock.send_to(p, a).map(|_| ())),
                None => Err(std::io::Error::new(std::io::ErrorKind::NotFound, "address could not be resolved")),
            };
            if let Err(err) = res {
                failed += 1;
                let n = dropped.entry(host.clone()).or_insert(0);
                *n += 1;
                let due = last_error_log.get(host).map_or(true, |t| t.elapsed() >= ERROR_LOG_INTERVAL);
                if due {
                    last_error_log.insert(host.clone(), Instant::now());
                    new_errors.push(format!(
                        "Failed to send UDP DRGB packet to {}:{} ({} dropped frames): {}",
                        host, scene.port, n, err
                    ));
                    *n = 0;
                }
            }
        }
        if failed > 0 {
            let mut s = shared.lock();
            s.stats.dropped_packets += failed;
            for e in new_errors {
                push_error(&mut s, e);
            }
        }

        // Nothing left to show: stop, unless Python sent a new scene meanwhile
        if !any_active {
            let mut s = shared.lock();
            if s.epoch == epoch && s.gen == gen {
                s.running = false;
                return;
            }
        }

        frame += 1;
        next += dt;
        let now = Instant::now();
        if next <= now {
            if now - next > dt {
                next = now; // more than a frame behind (system suspend, overload): resync
            }
            continue;
        }
        let s = shared.lock();
        let wait = next - now;
        let (s, _) = match shared.cv.wait_timeout_while(s, wait, |s| s.epoch == epoch) {
            Ok(r) => r,
            Err(p) => p.into_inner(),
        };
        if s.epoch != epoch {
            return;
        }
    }
}
