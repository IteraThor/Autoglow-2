//! Unified async engine & event coordinator: Autodarts event ingestion, idle power management,
//! profile-driven lighting (Event Matrix) or the Flow Matrix runtime, and live UI telemetry.
//!
//! The engine also owns the current AppConfig; routes read and replace it through engine.cfg.

use crate::autodarts::AutodartsBridge;
use crate::flow_runtime::{self, FlowOutput, FlowRuntime, Segment};
use crate::game_flow::{FlowTransition, GameFlow, GameFlowStorage};
use crate::led_thread::wall;
use crate::models::*;
use crate::wled::{self, WledDriver};
use futures_util::future::BoxFuture;
use log::{error, info, warn};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

const IDLE_PRESET_ID: i64 = 1;
const IDLE_PRESET_NAME: &str = "AutoGlow Default";

use DartEventType::*;
const BULL_OFF_HOLD_ENDS: [DartEventType; 6] = [BullOffWon, GameStart, GameIdle, LegWon, MatchWon, GameFinish];
const INTRO_EVENTS: [DartEventType; 2] = [GameStart, BullOffStart];
const INTRO_ENDING_EVENTS: [DartEventType; 12] = [Single, Double, Triple, Bullseye, Bust, Score180, Takeout, TakeoutInProgress, LegWon, MatchWon, GameIdle, BullOffWon];
const MATCH_END_EVENTS: [DartEventType; 2] = [MatchWon, GameFinish];
const MATCHLESS_GAME_EVENTS: [DartEventType; 8] = [GameStart, BullOffStart, Single, Double, Triple, Bullseye, Score180, Bust];
const NON_GAME_EVENTS: [DartEventType; 3] = [Calibrating, ManualReset, GameIdle];

/// PWM white spotlight segments are driven by brightness, not by RGB effects
pub fn is_pwm_segment(seg: &SegmentConfig) -> bool {
    let t = seg.r#type.to_lowercase();
    t.contains("pwm") || t.contains("white") || seg.name.to_lowercase().contains("pwm")
}

/// The segments of a device that play effects; [None] when it has none, so all its LEDs play
pub fn effect_segment_ids(dev: &DeviceConfig) -> Vec<Option<i64>> {
    if dev.segments.is_empty() {
        vec![None]
    } else {
        dev.segments.iter().filter(|s| !is_pwm_segment(s)).map(|s| Some(s.id)).collect()
    }
}

fn abort(t: &mut Option<JoinHandle<()>>) -> bool {
    match t.take() {
        Some(h) if !h.is_finished() => {
            h.abort();
            true
        }
        _ => false,
    }
}

pub struct EngState {
    pub last_activity_time: f64,
    pub is_board_dimmed: bool,
    pub is_board_off: bool,
    /// Controllers switched off one at a time (bridge WLED menu); the next wake turns them back on
    pub off_ips: HashSet<String>,
    pub current_illumination: i64,
    pub last_event_name: String,
    pub previous_event_name: String,
    running: bool,
    game_start_end_time: f64,
    pending_throw: Option<DartEvent>,
    /// A held Bull-off Started effect (duration 0) stays on through the bull-off instead of the turn colours
    bull_off_hold: bool,
    /// Set when the Lighting page plays a test effect, so leaving the page can restore idle
    pub lighting_test_active: bool,
    pub flow_idle_pending: bool,
    idle_task: Option<JoinHandle<()>>,
    game_start_task: Option<JoinHandle<()>>,
    match_end_task: Option<JoinHandle<()>>,
}

pub struct Engine {
    pub cfg: Mutex<AppConfig>,
    pub config_path: PathBuf,
    drivers: Mutex<BTreeMap<String, Arc<WledDriver>>>,
    pub autodarts: Option<Arc<AutodartsBridge>>,
    pub flows: GameFlowStorage,
    runtime: OnceLock<Arc<FlowRuntime>>,
    pub st: Mutex<EngState>,
    telemetry: broadcast::Sender<String>,
    preview: Mutex<Option<(JoinHandle<()>, Arc<FlowRuntime>)>>,
}

impl Engine {
    pub fn new(cfg: AppConfig, config_path: PathBuf, autodarts: Option<Arc<AutodartsBridge>>) -> Arc<Engine> {
        let ill = cfg.primary_device().map_or(200, |d| d.default_pwm_brightness);
        let (tx, _) = broadcast::channel(512);
        let eng = Arc::new(Engine {
            cfg: Mutex::new(cfg),
            config_path,
            drivers: Mutex::new(BTreeMap::new()),
            autodarts,
            flows: GameFlowStorage::new(None),
            runtime: OnceLock::new(),
            st: Mutex::new(EngState {
                last_activity_time: wall(),
                is_board_dimmed: false,
                is_board_off: false,
                off_ips: HashSet::new(),
                current_illumination: ill,
                last_event_name: "Standby".into(),
                previous_event_name: "\u{2014}".into(),
                running: false,
                game_start_end_time: 0.0,
                pending_throw: None,
                bull_off_hold: false,
                lighting_test_active: false,
                flow_idle_pending: false,
                idle_task: None,
                game_start_task: None,
                match_end_task: None,
            }),
            telemetry: tx,
            preview: Mutex::new(None),
        });
        let out: Arc<dyn FlowOutput> = Arc::new(EngineFlowOutput { engine: Arc::downgrade(&eng), preview: None });
        let _ = eng.runtime.set(FlowRuntime::new(out));
        let c = eng.cfg_clone();
        eng.sync_drivers(&c);
        if let Some(ad) = &eng.autodarts {
            let weak = Arc::downgrade(&eng);
            ad.set_sink(Arc::new(move |e: DartEvent| {
                let w = weak.clone();
                Box::pin(async move {
                    if let Some(engine) = w.upgrade() {
                        engine.process_event(e).await;
                    }
                })
            }));
        }
        eng
    }

    pub fn cfg(&self) -> MutexGuard<'_, AppConfig> {
        self.cfg.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn cfg_clone(&self) -> AppConfig {
        self.cfg().clone()
    }

    pub fn state(&self) -> MutexGuard<'_, EngState> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn runtime(&self) -> &Arc<FlowRuntime> {
        self.runtime.get().expect("flow runtime")
    }

    /// The Flow Matrix step the match is in ("waiting" outside a match)
    pub fn flow_active_phase(&self) -> String {
        self.runtime().step()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.telemetry.subscribe()
    }

    pub async fn broadcast(&self, payload: Value) {
        let _ = self.telemetry.send(payload.to_string());
    }

    pub fn drivers(&self) -> Vec<Arc<WledDriver>> {
        self.drivers.lock().unwrap().values().cloned().collect()
    }

    pub fn driver_ips(&self) -> Vec<String> {
        self.drivers.lock().unwrap().keys().cloned().collect()
    }

    /// The primary device's driver (or any)
    pub fn driver(&self) -> Option<Arc<WledDriver>> {
        let primary = self.cfg().primary_device().map(|d| d.ip.clone()).unwrap_or_default();
        let d = self.drivers.lock().unwrap();
        d.get(&primary).cloned().or_else(|| d.values().next().cloned())
    }

    pub fn get_driver(&self, ip: Option<&str>) -> Option<Arc<WledDriver>> {
        let Some(ip) = ip.map(str::trim).filter(|i| !i.is_empty()) else { return self.driver() };
        if let Some(d) = self.drivers.lock().unwrap().get(ip) {
            return Some(Arc::clone(d));
        }
        let dev = self.cfg().devices.iter().find(|d| d.ip == ip).cloned()?;
        let drv = WledDriver::new(dev);
        self.drivers.lock().unwrap().insert(ip.into(), Arc::clone(&drv));
        Some(drv)
    }

    pub fn protocol_mode(&self) -> ProtocolMode {
        self.driver().map_or(ProtocolMode::IdleHttp, |d| d.protocol_mode())
    }

    fn any_not_streaming(&self) -> bool {
        self.drivers().iter().any(|d| d.protocol_mode() != ProtocolMode::ActiveUdp)
    }

    pub fn any_streaming(&self) -> bool {
        self.drivers().iter().any(|d| d.protocol_mode() == ProtocolMode::ActiveUdp)
    }

    /// Enabled devices with an IP
    pub fn active_devices(&self) -> Vec<DeviceConfig> {
        self.cfg().devices.iter().filter(|d| d.enabled && !d.ip.is_empty()).cloned().collect()
    }

    fn segment_flag(&self, ip: &str, seg_id: Option<i64>, f: fn(&SegmentConfig) -> bool) -> bool {
        let devs = self.active_devices();
        let Some(dev) = devs.iter().find(|d| d.ip == ip) else { return true };
        dev.segments.iter().find(|s| s.id == seg_id.unwrap_or(0)).map_or(true, f)
    }

    /// Whether a segment goes all the way around the board (only then can it show the hit locator)
    pub fn segment_locator(&self, ip: &str, seg_id: Option<i64>) -> bool {
        self.segment_flag(ip, seg_id, |s| s.locator)
    }

    pub fn segment_clockwise(&self, ip: &str, seg_id: Option<i64>) -> bool {
        self.segment_flag(ip, seg_id, |s| s.clockwise)
    }

    /// Bring the driver pool in line with the configured devices (and keep `cfg` as the current config)
    pub fn sync_drivers(&self, cfg: &AppConfig) {
        let mut d = self.drivers.lock().unwrap();
        let mut active = HashSet::new();
        for dev in &cfg.devices {
            let ip = dev.ip.trim().to_string();
            if !dev.enabled || ip.is_empty() {
                continue;
            }
            active.insert(ip.clone());
            match d.get(&ip) {
                Some(drv) => drv.set_config(dev.clone()),
                None => {
                    d.insert(ip, WledDriver::new(dev.clone()));
                }
            }
        }
        let stale: Vec<String> = d.keys().filter(|k| !active.contains(*k)).cloned().collect();
        for ip in stale {
            if let Some(drv) = d.remove(&ip) {
                drv.close();
            }
        }
    }

    /// Replace the current config and sync the drivers to it
    pub fn set_config(&self, cfg: AppConfig) {
        self.sync_drivers(&cfg);
        *self.cfg() = cfg;
    }

    pub fn is_flow_mode(&self) -> bool {
        self.cfg().lighting_mode == LightingMode::Flow
    }

    pub async fn set_lighting_mode(&self, mode: LightingMode) {
        let changed = self.cfg().lighting_mode != mode;
        if changed {
            self.runtime().reset(false).await;
            for drv in self.drivers() {
                drv.flow_clear();
            }
            let mut s = self.state();
            abort(&mut s.game_start_task);
            s.game_start_end_time = 0.0;
            s.pending_throw = None;
        }
        self.cfg().lighting_mode = mode;
        info!("AutoGlow Engine active lighting mode set to: {}", mode.as_str());
    }

    // --- lifecycle ---------------------------------------------------------------------------

    pub async fn start(self: &Arc<Self>) {
        if std::mem::replace(&mut self.state().running, true) {
            return;
        }
        info!("Starting AutoGlow Unified Async Engine...");
        for drv in self.drivers() {
            drv.ensure_wled_config().await;
        }
        for drv in self.drivers() {
            let b = drv.config().default_pwm_brightness;
            drv.set_board_light(b, None).await;
        }
        let ill = self.cfg().primary_device().map_or(200, |d| d.default_pwm_brightness);
        self.state().current_illumination = ill;
        let me = Arc::clone(self);
        self.state().idle_task = Some(tokio::spawn(async move { me.idle_monitor_loop().await }));
        info!("AutoGlow Engine is running and ready for game events.");
    }

    pub async fn stop(self: &Arc<Self>) {
        {
            let mut s = self.state();
            s.running = false;
            abort(&mut s.idle_task);
            abort(&mut s.match_end_task);
            abort(&mut s.game_start_task);
        }
        self.runtime().reset(false).await;
        if let Some((h, _)) = self.preview.lock().unwrap().take() {
            h.abort();
        }
        for drv in self.drivers() {
            drv.transition_to_http_mode(1).await;
            drv.close();
        }
        info!("AutoGlow Engine stopped.");
    }

    pub async fn set_protocol_mode(self: &Arc<Self>, mode: ProtocolMode) -> bool {
        let mut all = true;
        if mode == ProtocolMode::ActiveUdp {
            let spot = self.cfg().game_mode_spotlight_brightness;
            for drv in self.drivers() {
                all &= drv.transition_to_udp_mode(Some(spot));
            }
            self.broadcast(json!({"type": "protocol_state", "mode": "udp"})).await;
        } else {
            for drv in self.drivers() {
                all &= drv.transition_to_http_mode(1).await;
            }
            self.broadcast(json!({"type": "protocol_state", "mode": "http"})).await;
            let pending = std::mem::replace(&mut self.state().flow_idle_pending, false);
            if pending {
                // A profile's waiting look changed during the match: write it now that WLED plays its idle preset
                self.apply_idle(None, None).await;
            }
        }
        all
    }

    pub async fn set_board_light(&self, brightness: i64, target_ip: Option<&str>) -> bool {
        self.state().current_illumination = brightness.clamp(0, 255);
        if let Some(ip) = target_ip.filter(|i| !i.is_empty()) {
            return match self.get_driver(Some(ip)) {
                Some(d) => d.set_board_light(brightness, Some(ip.to_string())).await,
                None => false,
            };
        }
        let mut all = true;
        for drv in self.drivers() {
            all &= drv.set_board_light(brightness, None).await;
        }
        all
    }

    /// Wake the lights from dimmed / off: turn controllers on, then stream (ACTIVE_UDP) or restore preset 1
    pub async fn wake_up(self: &Arc<Self>, mode: ProtocolMode) -> bool {
        let (was_off, off_ips) = {
            let mut s = self.state();
            s.last_activity_time = wall();
            let was = s.is_board_off;
            s.is_board_off = false;
            s.is_board_dimmed = false;
            (was, std::mem::take(&mut s.off_ips))
        };
        let ips: Vec<String> = self.active_devices().into_iter().map(|d| d.ip).collect();
        let targets: Vec<String> = if was_off { ips } else { ips.into_iter().filter(|i| off_ips.contains(i)).collect() };
        for ip in targets {
            let mut payload = crate::obj! {"on" => true, "lor" => 0};
            if mode == ProtocolMode::IdleHttp {
                payload.insert("ps".into(), json!(1));
            }
            let ip2 = ip.clone();
            let r = tokio::task::spawn_blocking(move || wled::preview_wled_state(&ip2, &payload, 2.0)).await;
            if !matches!(r, Ok(Ok(_))) {
                error!("Error waking up WLED controller {}", ip);
            }
        }
        if mode == ProtocolMode::ActiveUdp {
            info!("Waking up board illumination and restoring Active UDP mode...");
            let spot = self.cfg().game_mode_spotlight_brightness;
            self.state().current_illumination = spot;
            for drv in self.drivers() {
                drv.transition_to_udp_mode(Some(spot));
            }
            self.broadcast(json!({"type": "protocol_state", "mode": "udp"})).await;
            self.broadcast(json!({"type": "power_state", "state": "active"})).await;
        } else {
            info!("Waking up board illumination and restoring Idle Preset 1 (IDLE_HTTP mode)...");
            let gb = self.cfg().global_brightness;
            self.state().current_illumination = gb;
            for drv in self.drivers() {
                drv.transition_to_http_mode(1).await;
                drv.set_board_light(gb, None).await;
            }
            self.broadcast(json!({"type": "protocol_state", "mode": "http"})).await;
            self.broadcast(json!({"type": "power_state", "state": "on"})).await;
        }
        true
    }

    /// Return the lights to idle after Lighting-page testing; never interrupts a running match
    pub async fn end_lighting_test(self: &Arc<Self>) -> bool {
        if !std::mem::replace(&mut self.state().lighting_test_active, false) {
            return false;
        }
        if self.autodarts.as_ref().map_or(false, |a| a.active_match_id().is_some()) {
            return false;
        }
        info!("Lighting test ended -> restoring idle");
        let (off, dim) = {
            let s = self.state();
            (s.is_board_off, s.is_board_dimmed)
        };
        if off || dim {
            for drv in self.drivers() {
                drv.transition_to_http_mode(1).await;
            }
            self.broadcast(json!({"type": "protocol_state", "mode": "http"})).await;
            return true;
        }
        self.wake_up(ProtocolMode::IdleHttp).await
    }

    fn profile_effect(&self, cfg: &AppConfig, ip: &str, seg: Option<i64>, key: &str) -> Option<EffectConfig> {
        cfg.profile_for(Some(ip), seg).get_effect(key).cloned()
    }

    fn max_effect_duration(&self, key: &str) -> f64 {
        let cfg = self.cfg_clone();
        let devs = self.active_devices();
        let mut m: f64 = 0.0;
        for d in &devs {
            for sid in effect_segment_ids(d) {
                if let Some(e) = self.profile_effect(&cfg, &d.ip, sid, key) {
                    if e.enabled && e.duration > 0.0 {
                        m = m.max(e.duration);
                    }
                }
            }
        }
        if m == 0.0 && devs.is_empty() {
            if let Some(e) = cfg.profile().get_effect(key) {
                if e.enabled && e.duration > 0.0 {
                    m = e.duration;
                }
            }
        }
        m
    }

    /// True when any segment's profile plays an effect for the event (Event Matrix only)
    fn is_event_enabled(&self, key: &str) -> bool {
        if self.is_flow_mode() {
            return false;
        }
        let cfg = self.cfg_clone();
        let devs = self.active_devices();
        if devs.is_empty() {
            return cfg.profile().get_effect(key).map_or(false, |e| e.enabled);
        }
        devs.iter().any(|d| effect_segment_ids(d).into_iter().any(|sid| self.profile_effect(&cfg, &d.ip, sid, key).map_or(false, |e| e.enabled)))
    }

    // --- events ------------------------------------------------------------------------------

    pub fn process_event(self: &Arc<Self>, event: DartEvent) -> BoxFuture<'static, ()> {
        let me = Arc::clone(self);
        Box::pin(async move { me.process_event_inner(event).await })
    }

    async fn process_event_inner(self: &Arc<Self>, event: DartEvent) {
        self.state().last_activity_time = wall();
        let key = event.kind().as_str();
        info!(
            "AutoGlow Engine processing event: '{}' (player='{}', score={}, seg='{}')",
            key,
            event.player_name.clone().unwrap_or_else(|| "None".into()),
            event.score,
            event.segment_name.clone().unwrap_or_else(|| "None".into())
        );
        if self.is_flow_mode() {
            self.process_flow_event(&event).await;
            return;
        }
        self.track_intro(&event);
        if event.kind() == Throw && self.hold_turn_color(&event).await {
            return;
        }
        let is_end = MATCH_END_EVENTS.contains(&event.kind());
        let is_idle = event.kind() == GameIdle;
        let teardown = self.cfg().disconnect_udp_on_match_end;
        let celebration = if is_end && teardown { self.max_effect_duration("match_won") } else { 0.0 };
        if !(is_idle || (is_end && teardown && celebration <= 0.0)) {
            self.wake_for(&event).await;
        }
        if is_idle || is_end {
            self.release_udp_after_match(is_idle, teardown, celebration).await;
        }
        self.record_event_name(&event);
        self.play_event_effect(&event, key).await;
        let t = self.game_event_telemetry(&event);
        self.broadcast(t).await;
    }

    fn track_intro(self: &Arc<Self>, event: &DartEvent) {
        let k = event.kind();
        if INTRO_EVENTS.contains(&k) {
            let dur = self.max_effect_duration(k.as_str());
            let mut s = self.state();
            abort(&mut s.game_start_task);
            abort(&mut s.match_end_task);
            s.pending_throw = None;
            if dur > 0.0 {
                s.game_start_end_time = wall() + dur;
                let me = Arc::clone(self);
                s.game_start_task = Some(tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs_f64(dur)).await;
                    let pending = {
                        let mut s = me.state();
                        s.game_start_end_time = 0.0;
                        s.pending_throw.take()
                    };
                    if let Some(p) = pending {
                        info!("Intro animation finished -> transitioning to active player throw color");
                        me.process_event(p).await;
                    }
                }));
            } else {
                s.game_start_end_time = 0.0;
            }
        } else if INTRO_ENDING_EVENTS.contains(&k) {
            let mut s = self.state();
            abort(&mut s.game_start_task);
            s.game_start_end_time = 0.0;
            s.pending_throw = None;
        }
        if k == BullOffStart {
            let hold = self.is_event_enabled(k.as_str()) && self.max_effect_duration(k.as_str()) <= 0.0;
            self.state().bull_off_hold = hold;
        } else if BULL_OFF_HOLD_ENDS.contains(&k) {
            self.state().bull_off_hold = false;
        }
    }

    /// True when a THROW's turn colour must wait (held bull-off animation, or the intro: then it is queued)
    async fn hold_turn_color(&self, event: &DartEvent) -> bool {
        {
            let mut s = self.state();
            if s.bull_off_hold {
                info!("Bull-off animation held -> skipping the turn color until the bull-off is decided");
            } else if wall() < s.game_start_end_time {
                info!("Intro animation playing ({:.1}s remaining) -> queued player throw color", s.game_start_end_time - wall());
                s.pending_throw = Some(event.clone());
            } else {
                return false;
            }
        }
        self.broadcast(json!({
            "type": "game_event", "event": event.kind().as_str(), "player_name": event.player_name, "player_index": event.player_index,
            "score": event.score, "multiplier": event.multiplier, "segment": event.segment_name.clone().unwrap_or_default(),
        }))
        .await;
        true
    }

    async fn wake_for(self: &Arc<Self>, event: &DartEvent) {
        let k = event.kind();
        let no_match = self.autodarts.as_ref().map_or(false, |a| a.active_match_id().is_none());
        let active_game = if no_match { MATCHLESS_GAME_EVENTS.contains(&k) } else { !NON_GAME_EVENTS.contains(&k) };
        let (off, dim) = {
            let s = self.state();
            (s.is_board_off, s.is_board_dimmed)
        };
        if active_game {
            if off || dim || self.any_not_streaming() {
                self.wake_up(ProtocolMode::ActiveUdp).await;
            }
        } else if off || dim {
            self.wake_up(ProtocolMode::IdleHttp).await;
        }
    }

    async fn release_udp_after_match(self: &Arc<Self>, aborted: bool, teardown: bool, celebration: f64) {
        abort(&mut self.state().match_end_task);
        if !teardown {
            return;
        }
        if aborted {
            info!("Match aborted / game idle -> releasing UDP mode and restoring Idle Preset 1 (disconnect_udp_on_match_end is True)");
            self.set_protocol_mode(ProtocolMode::IdleHttp).await;
        } else if celebration > 0.0 {
            info!("Match won celebration scheduled ({:.1}s) -> will disconnect UDP after effect", celebration);
            let me = Arc::clone(self);
            self.state().match_end_task = Some(tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs_f64(celebration)).await;
                info!("Match end celebration finished ({:.1}s) -> releasing UDP mode and restoring Idle Preset 1", celebration);
                me.set_protocol_mode(ProtocolMode::IdleHttp).await;
            }));
        } else {
            info!("Match won -> releasing UDP mode and restoring Idle Preset 1 immediately");
            self.set_protocol_mode(ProtocolMode::IdleHttp).await;
        }
    }

    fn event_effect(profile: &ProfileConfig, event: &DartEvent, key: &str, players: &[String]) -> Option<EffectConfig> {
        if event.kind() == Throw {
            return profile.resolve_player_effect(event.player_name.as_deref(), event.player_index, players);
        }
        profile.get_effect(key).cloned()
    }

    pub fn match_players(&self) -> Vec<String> {
        self.autodarts.as_ref().map(|a| a.current_players()).unwrap_or_default()
    }

    async fn play_event_effect(&self, event: &DartEvent, key: &str) {
        let cfg = self.cfg_clone();
        let players = self.match_players();
        let devs = self.active_devices();
        let last = self.state().last_event_name.clone();
        for d in &devs {
            let Some(drv) = self.get_driver(Some(&d.ip)) else { continue };
            for sid in effect_segment_ids(d) {
                let Some(eff) = Self::event_effect(cfg.profile_for(Some(&d.ip), sid), event, key, &players) else { continue };
                if !eff.enabled {
                    continue;
                }
                let where_ = sid.map_or_else(|| "all segments".to_string(), |s| format!("Segment #{}", s));
                info!("Dispatching effect '{}' on {} ({}) {} for '{}'", eff.animation, d.name, d.ip, where_, last);
                drv.play_effect(&eff, sid, false, None);
            }
        }
        if devs.is_empty() {
            if let Some(eff) = Self::event_effect(cfg.profile(), event, key, &players).filter(|e| e.enabled) {
                info!("Dispatching global effect '{}' for '{}'", eff.animation, last);
                for drv in self.drivers() {
                    drv.play_effect(&eff, None, false, None);
                }
            }
        }
    }

    fn record_event_name(&self, event: &DartEvent) {
        let key = event.kind().as_str();
        let mut s = self.state();
        if !s.last_event_name.is_empty() && s.last_event_name != "Standby" {
            s.previous_event_name = s.last_event_name.clone();
        }
        s.last_event_name = match &event.segment_name {
            Some(n) if !n.is_empty() => format!("{} ; {}", key, n),
            _ => key.to_string(),
        };
    }

    fn game_event_telemetry(&self, event: &DartEvent) -> Value {
        let (last, prev) = {
            let s = self.state();
            (s.last_event_name.clone(), s.previous_event_name.clone())
        };
        json!({
            "type": "game_event", "event": event.kind().as_str(), "display_event": last, "previous_event": prev,
            "segment_name": event.segment_name.clone().unwrap_or_default(), "score": event.score, "multiplier": event.multiplier,
            "timestamp": wall(), "players": self.match_players(),
            "active_player_idx": self.autodarts.as_ref().map_or(0, |a| a.active_player_idx()),
            "lighting_mode": self.cfg().lighting_mode.as_str(), "flow_phase": self.flow_active_phase(),
        })
    }

    async fn process_flow_event(self: &Arc<Self>, event: &DartEvent) {
        if matches!(event.kind(), Calibrating | ManualReset) {
            let (off, dim) = {
                let s = self.state();
                (s.is_board_off, s.is_board_dimmed)
            };
            if off || dim {
                self.wake_up(ProtocolMode::IdleHttp).await;
            }
        }
        self.runtime().handle(event).await;
        self.record_event_name(event);
        let t = self.game_event_telemetry(event);
        self.broadcast(t).await;
    }

    // --- idle & power ------------------------------------------------------------------------

    pub async fn power_off_all(self: &Arc<Self>) {
        {
            let mut s = self.state();
            s.is_board_off = true;
            s.is_board_dimmed = true;
            s.current_illumination = 0;
        }
        for drv in self.drivers() {
            if drv.protocol_mode() == ProtocolMode::ActiveUdp {
                drv.transition_to_http_mode(1).await;
            }
            drv.set_board_light(0, None).await;
        }
        self.broadcast(json!({"type": "protocol_state", "mode": "http"})).await;
        for d in self.active_devices() {
            let ip = d.ip.clone();
            let r = tokio::task::spawn_blocking(move || wled::preview_wled_state(&ip, &crate::obj! {"on" => false}, 2.0)).await;
            if !matches!(r, Ok(Ok(_))) {
                error!("Error turning off WLED controller {}", d.ip);
            }
        }
        self.broadcast(json!({"type": "power_state", "state": "off"})).await;
    }

    pub async fn dim_all(self: &Arc<Self>) {
        let dim = self.cfg().idle_dimming_brightness;
        {
            let mut s = self.state();
            s.is_board_dimmed = true;
            s.current_illumination = dim;
        }
        for drv in self.drivers() {
            drv.transition_to_http_mode(1).await;
            drv.set_board_light(dim, None).await;
        }
        self.broadcast(json!({"type": "protocol_state", "mode": "http"})).await;
        self.broadcast(json!({"type": "power_state", "state": "dimmed"})).await;
    }

    async fn idle_monitor_loop(self: Arc<Self>) {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if !self.state().running {
                break;
            }
            let (idle, off, dim) = {
                let s = self.state();
                (wall() - s.last_activity_time, s.is_board_off, s.is_board_dimmed)
            };
            let c = self.cfg_clone();
            let dim_limit = (c.inactivity_timeout_minutes * 60) as f64;
            let off_limit = (c.idle_power_off_minutes * 60) as f64;
            if c.idle_power_off_enabled && idle >= off_limit && !off {
                info!("Board idle for {}s (>= {}s). Turning all controllers and board light OFF.", idle as i64, off_limit as i64);
                self.power_off_all().await;
            } else if c.inactivity_timeout_enabled && idle >= dim_limit && !dim && !off {
                info!("Board idle for {}s (>= {}s). Dimming, releasing UDP, and restoring Idle Preset 1.", idle as i64, dim_limit as i64);
                self.dim_all().await;
            }
        }
    }

    // --- Flow Matrix waiting lights (idle preset) --------------------------------------------

    /// The idle preset's segments for one controller; `saved` keeps settings AutoGlow does not manage
    pub fn idle_preset_segments(&self, dev: &DeviceConfig, saved: &[Value]) -> Vec<Value> {
        let by_id: BTreeMap<i64, crate::py::Obj> = saved.iter().filter_map(|s| s.as_object()).filter_map(|s| s.get("id").and_then(Value::as_i64).map(|i| (i, s.clone()))).collect();
        let mut segs = dev.segments.clone();
        if segs.is_empty() {
            let mut s = SegmentConfig::new(0);
            s.name = if dev.name.is_empty() { "All LEDs".into() } else { dev.name.clone() };
            s.length = dev.rgb_count;
            s.r#type = String::new();
            s.offset = 0;
            segs.push(s);
        }
        let mut out = Vec::new();
        for seg in &segs {
            let mut e = by_id.get(&seg.id).cloned().unwrap_or_else(|| crate::obj! {"of" => seg.offset});
            e.insert("id".into(), json!(seg.id));
            e.insert("start".into(), json!(seg.start));
            e.insert("stop".into(), json!(seg.start + seg.length.max(1)));
            e.insert("n".into(), json!(wled::sanitize_wled_name(if seg.name.is_empty() { "" } else { &seg.name })).clone());
            if e["n"].as_str().map_or(true, str::is_empty) {
                e.insert("n".into(), json!(wled::sanitize_wled_name(&format!("Segment {}", seg.id))));
            }
            e.insert("sel".into(), json!(true));
            if is_pwm_segment(seg) {
                e.entry("on").or_insert(json!(true));
                e.entry("bri").or_insert(json!(181));
                e.insert("fx".into(), json!(0));
            } else {
                let flow = self.flows.get_for_segment(Some(&dev.ip), if dev.segments.is_empty() { None } else { Some(seg.id) });
                for (k, v) in flow.idle.wled_segment() {
                    e.insert(k, v);
                }
            }
            out.push(Value::Object(e));
        }
        out
    }

    fn plays(&self, dev: &DeviceConfig, profile: &str) -> bool {
        if dev.segments.is_empty() {
            return self.flows.profile_name_for(Some(&dev.ip), None) == profile;
        }
        dev.segments.iter().filter(|s| !is_pwm_segment(s)).any(|s| self.flows.profile_name_for(Some(&dev.ip), Some(s.id)) == profile)
    }

    /// Write the waiting look to the controllers (all, those in ips, or those playing `profile`).
    /// During a match it waits until the lights are back to waiting. Returns the controllers not reached.
    pub async fn apply_idle(self: &Arc<Self>, ips: Option<Vec<String>>, profile: Option<&str>) -> Vec<String> {
        if self.cfg().lighting_mode == LightingMode::Matrix {
            return Vec::new();
        }
        let devices: Vec<DeviceConfig> = self
            .active_devices()
            .into_iter()
            .filter(|d| ips.as_ref().map_or(true, |w| w.contains(&d.ip)))
            .filter(|d| profile.map_or(true, |p| self.plays(d, p)))
            .collect();
        if devices.is_empty() {
            return Vec::new();
        }
        if self.any_streaming() {
            self.state().flow_idle_pending = true;
            return Vec::new();
        }
        let mut handles = Vec::new();
        for dev in devices {
            let me = Arc::clone(self);
            handles.push(tokio::task::spawn_blocking(move || {
                let saved: Vec<Value> = wled::get_wled_preset(&dev.ip, IDLE_PRESET_ID, 1.5).ok().map(|p| crate::py::arr(p.get("seg")).to_vec()).unwrap_or_default();
                let segs = me.idle_preset_segments(&dev, &saved);
                let r = wled::save_wled_preset(&dev.ip, IDLE_PRESET_ID, IDLE_PRESET_NAME, Some(&segs), 255, true, 2.5);
                (dev, r)
            }));
        }
        let mut failed = Vec::new();
        for h in handles {
            if let Ok((dev, r)) = h.await {
                let name = if dev.name.is_empty() { dev.ip.clone() } else { dev.name.clone() };
                match r {
                    Ok(_) => info!("Idle lighting of {} set from its flow profiles", name),
                    Err(e) => {
                        warn!("Could not set the idle lighting of {}: {}", name, e);
                        failed.push(name);
                    }
                }
            }
        }
        failed
    }

    /// The RGB segments the Flow Matrix plays on
    pub fn flow_segments(self: &Arc<Self>) -> Vec<Segment> {
        EngineFlowOutput { engine: Arc::downgrade(self), preview: None }.segments()
    }

    /// Stream to every controller (waking it when dimmed or off)
    pub async fn ensure_streaming(self: &Arc<Self>) {
        EngineFlowOutput { engine: Arc::downgrade(self), preview: None }.ensure_streaming().await
    }

    // --- Flow Matrix match preview -----------------------------------------------------------

    pub async fn start_preview(self: &Arc<Self>, players: i64, bull_off: bool, legs: i64, flow: Option<GameFlow>) -> Value {
        self.stop_preview().await;
        let names: Vec<String> = (0..players).map(|i| format!("Player {}", i + 1)).collect();
        let out: Arc<dyn FlowOutput> = Arc::new(EngineFlowOutput { engine: Arc::downgrade(self), preview: Some((flow.map(Arc::new), names)) });
        let rt = FlowRuntime::new(out);
        self.state().lighting_test_active = true;
        let me = Arc::clone(self);
        let rt2 = Arc::clone(&rt);
        let h = tokio::spawn(async move {
            flow_runtime::run_preview(Arc::clone(&rt2), players, bull_off, legs).await;
            me.finish_preview(&rt2).await;
        });
        *self.preview.lock().unwrap() = Some((h, rt));
        info!("Flow preview started: {} players, bull-off {}, {} leg(s)", players, if bull_off { "on" } else { "off" }, legs);
        json!({"seconds": flow_runtime::preview_seconds(players, bull_off, legs)})
    }

    async fn finish_preview(&self, rt: &Arc<FlowRuntime>) {
        flow_runtime::end_preview(rt).await;
        {
            let mut p = self.preview.lock().unwrap();
            if p.as_ref().map_or(false, |(_, r)| Arc::ptr_eq(r, rt)) {
                *p = None;
            }
        }
        self.broadcast(json!({"type": "game_flow_state", "phase": "waiting", "preview": true, "ended": true})).await;
    }

    pub async fn stop_preview(&self) {
        let taken = self.preview.lock().unwrap().take();
        if let Some((h, rt)) = taken {
            if !h.is_finished() {
                h.abort();
                self.finish_preview(&rt).await;
            }
        }
    }

}

/// The flow runtime's output on the engine's real WLED drivers (and, with `preview`, the match preview)
struct EngineFlowOutput {
    engine: Weak<Engine>,
    /// Preview: the flow to play everywhere (None = each segment's own) and the made-up players
    preview: Option<(Option<Arc<GameFlow>>, Vec<String>)>,
}

impl EngineFlowOutput {
    fn eng(&self) -> Option<Arc<Engine>> {
        self.engine.upgrade()
    }
}

impl FlowOutput for EngineFlowOutput {
    fn segments(&self) -> Vec<Segment> {
        let Some(e) = self.eng() else { return Vec::new() };
        let mut out = Vec::new();
        for d in e.active_devices() {
            if d.segments.is_empty() {
                out.push((d.ip.clone(), None, "dartboard_ring".to_string()));
            } else {
                for s in d.segments.iter().filter(|s| !is_pwm_segment(s)) {
                    out.push((d.ip.clone(), Some(s.id), s.role.clone()));
                }
            }
        }
        out
    }

    fn flow_for(&self, ip: &str, seg_id: Option<i64>) -> Arc<GameFlow> {
        if let Some((Some(f), _)) = &self.preview {
            return Arc::clone(f);
        }
        match self.eng() {
            Some(e) => e.flows.get_for_segment(Some(ip), seg_id),
            None => Arc::new(crate::game_flow::create_default_game_flow()),
        }
    }

    fn match_players(&self) -> Vec<String> {
        if let Some((_, p)) = &self.preview {
            return p.clone();
        }
        self.eng().map(|e| e.match_players()).unwrap_or_default()
    }

    fn match_end_to_waiting(&self) -> bool {
        self.preview.is_some() || self.eng().map_or(false, |e| e.cfg().disconnect_udp_on_match_end)
    }

    fn ensure_streaming(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let Some(e) = self.eng() else { return };
            let (off, dim) = {
                let s = e.state();
                (s.is_board_off, s.is_board_dimmed)
            };
            if off || dim || e.any_not_streaming() {
                e.wake_up(ProtocolMode::ActiveUdp).await;
            }
        })
    }

    fn show(&self, ip: &str, seg_id: Option<i64>, effect: &EffectConfig, t: &FlowTransition) {
        if let Some(d) = self.eng().and_then(|e| e.get_driver(Some(ip))) {
            d.flow_show(seg_id, effect, &t.style, t.duration, t.accent_color.map(|c| c.tuple()));
        }
    }

    fn hit(&self, ip: &str, seg_id: Option<i64>, effect: &EffectConfig, strength: f64) {
        if let Some(d) = self.eng().and_then(|e| e.get_driver(Some(ip))) {
            d.flow_hit(seg_id, effect, strength);
        }
    }

    fn locate(&self, ip: &str, seg_id: Option<i64>, position: f64, color: RGBColor) {
        if let Some(e) = self.eng() {
            if let Some(d) = e.get_driver(Some(ip)) {
                d.flow_locate(seg_id, position, color, 1.2, e.segment_clockwise(ip, seg_id));
            }
        }
    }

    fn can_locate(&self, ip: &str, seg_id: Option<i64>) -> bool {
        self.eng().map_or(false, |e| e.segment_locator(ip, seg_id))
    }

    fn to_waiting(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let Some(e) = self.eng() else { return };
            for d in e.drivers() {
                d.flow_clear();
            }
            if e.any_streaming() {
                e.set_protocol_mode(ProtocolMode::IdleHttp).await;
            }
        })
    }

    fn broadcast(&self, mut message: Value) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let Some(e) = self.eng() else { return };
            message["lighting_mode"] = json!("flow");
            if self.preview.is_some() {
                message["preview"] = json!(true);
            }
            e.broadcast(message).await;
        })
    }
}
