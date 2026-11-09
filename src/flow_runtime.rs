//! Flow Matrix runtime: follows a match and drives the light strips.
//!
//!     Waiting -> Bull-off -> Game starts -> [Player's turn <-> Pulling darts] -> Leg won -> ... -> Match won -> Waiting
//!
//! - A step that is off is skipped: nothing plays for it and it adds no waiting time.
//! - Timed steps (Game starts, Leg won, Match won) play at least their time; a turn that starts meanwhile
//!   waits for them, then comes in.
//! - Hits play on top of the current look and fade back into it. They never count as a step change.
//! - The player's turn is always on; it is the look the match returns to.
//! - Waiting is the idle lighting (a WLED preset), so the strips switch to it without a blend.
//!
//! Each segment follows its own flow profile; the match itself (which step, whose turn) is shared. Player
//! colours stick to players, not positions: the runtime keeps a roster in the order players first appear.
//!
//! Also the match preview: a short made-up match played through its own runtime on the real lights.

use crate::game_flow::{player_colour_index, FlowTransition, GameFlow};
use crate::models::{DartEvent, DartEventType, EffectConfig, RGBColor};
use futures_util::future::BoxFuture;
use log::info;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const WAITING: &str = "waiting";
const BOARD_ORDER: [i64; 20] = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const CAMERA_FRIENDLY_STRENGTH: f64 = 0.5;
const CAMERA_FRIENDLY_MAX_HIT: f64 = 1.0;
const TURN_STEPS: [&str; 3] = ["turn", "takeout", "bull_off"];

/// (controller ip, segment id or None, role)
pub type Segment = (String, Option<i64>, String);

/// Where the runtime sends its decisions (the engine's drivers, or the preview)
pub trait FlowOutput: Send + Sync {
    fn segments(&self) -> Vec<Segment>;
    fn flow_for(&self, ip: &str, seg_id: Option<i64>) -> Arc<GameFlow>;
    fn match_players(&self) -> Vec<String>;
    fn match_end_to_waiting(&self) -> bool;
    fn ensure_streaming(&self) -> BoxFuture<'_, ()>;
    fn show(&self, ip: &str, seg_id: Option<i64>, effect: &EffectConfig, transition: &FlowTransition);
    fn hit(&self, ip: &str, seg_id: Option<i64>, effect: &EffectConfig, strength: f64);
    fn locate(&self, ip: &str, seg_id: Option<i64>, position: f64, color: RGBColor);
    fn can_locate(&self, ip: &str, seg_id: Option<i64>) -> bool;
    fn to_waiting(&self) -> BoxFuture<'_, ()>;
    fn broadcast(&self, message: Value) -> BoxFuture<'_, ()>;
}

fn hit_name(t: DartEventType) -> Option<&'static str> {
    match t {
        DartEventType::Single => Some("single"),
        DartEventType::Double => Some("double"),
        DartEventType::Triple => Some("triple"),
        DartEventType::Bullseye => Some("bullseye"),
        DartEventType::Score180 => Some("180"),
        _ => None,
    }
}

/// Which hit of the flow an event plays (a score tier wins over the dart that completed it)
pub fn hit_key(event: &DartEvent, flow: &GameFlow) -> Option<String> {
    if event.kind() == DartEventType::Bust {
        return Some(if event.segment_number == Some(0) { "miss" } else { "bust" }.into());
    }
    let key = hit_name(event.kind())?;
    if key != "180" {
        if let Some(total) = event.round_score {
            let tier = if (140..180).contains(&total) {
                Some("ton40")
            } else if (100..140).contains(&total) {
                Some("ton")
            } else {
                None
            };
            if let Some(t) = tier {
                if flow.hit(t).enabled {
                    return Some(t.into());
                }
            }
        }
    }
    Some(key.into())
}

/// Where a board number's centre sits around the board: 0 = top (the 20), going clockwise
pub fn board_position(n: Option<i64>) -> Option<f64> {
    let n = n?;
    BOARD_ORDER.iter().position(|b| *b == n).map(|i| i as f64 / BOARD_ORDER.len() as f64)
}

fn clock() -> f64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

#[derive(Clone, Debug)]
pub struct Snapshot {
    pub step: String,
    pub player: i64,
    pub bull_off: bool,
    pub hit: Option<String>,
}

struct RtState {
    step: String,
    player: i64,
    roster: Vec<String>,
    in_bull_off: bool,
    hold_until: f64,
    hold_step: Option<String>,
    queued_turn: Option<i64>,
    timer: Option<tokio::task::JoinHandle<()>>,
    timer_id: u64,
    last_hit: Option<String>,
}

pub struct FlowRuntime {
    pub out: Arc<dyn FlowOutput>,
    st: tokio::sync::Mutex<RtState>,
    snap: Mutex<Snapshot>,
}

impl FlowRuntime {
    pub fn new(out: Arc<dyn FlowOutput>) -> Arc<FlowRuntime> {
        Arc::new(FlowRuntime {
            out,
            st: tokio::sync::Mutex::new(RtState {
                step: WAITING.into(),
                player: 0,
                roster: Vec::new(),
                in_bull_off: false,
                hold_until: 0.0,
                hold_step: None,
                queued_turn: None,
                timer: None,
                timer_id: 0,
                last_hit: None,
            }),
            snap: Mutex::new(Snapshot { step: WAITING.into(), player: 0, bull_off: false, hit: None }),
        })
    }

    /// The step the match is in, without waiting for a running event
    pub fn snapshot(&self) -> Snapshot {
        self.snap.lock().unwrap().clone()
    }

    pub fn step(&self) -> String {
        self.snapshot().step
    }

    fn publish(&self, s: &RtState) {
        *self.snap.lock().unwrap() = Snapshot { step: s.step.clone(), player: s.player, bull_off: s.in_bull_off, hit: s.last_hit.clone() };
    }

    pub async fn reset(&self, keep_roster: bool) {
        let mut s = self.st.lock().await;
        Self::reset_state(&mut s, keep_roster);
        self.publish(&s);
    }

    fn reset_state(s: &mut RtState, keep_roster: bool) {
        Self::cancel_timer(s);
        s.step = WAITING.into();
        s.player = 0;
        if !keep_roster {
            s.roster.clear();
        }
        s.in_bull_off = false;
        s.hold_until = 0.0;
        s.hold_step = None;
        s.queued_turn = None;
    }

    /// Seconds until a playing timed step lets the next turn come in (0 when nothing holds)
    pub async fn hold_remaining(&self) -> f64 {
        let s = self.st.lock().await;
        if s.hold_step.is_some() {
            (s.hold_until - clock()).max(0.0)
        } else {
            0.0
        }
    }

    pub async fn handle(self: &Arc<Self>, event: &DartEvent) {
        let mut s = self.st.lock().await;
        self.handle_locked(&mut s, event).await;
        self.publish(&s);
    }

    async fn handle_locked(self: &Arc<Self>, s: &mut RtState, event: &DartEvent) {
        use DartEventType::*;
        match event.kind() {
            GameIdle => self.to_waiting(s).await,
            BullOffStart => {
                // A PDC tie starts another bull-off round: keep the players seen so far
                let keep = s.in_bull_off;
                Self::reset_state(s, keep);
                s.in_bull_off = true;
                self.enter(s, "bull_off", None).await;
            }
            BullOffWon => {} // the bull-off look stays until the first leg starts
            GameStart => {
                Self::cancel_timer(s);
                s.queued_turn = None;
                if !s.in_bull_off {
                    s.roster.clear(); // a new match without a bull-off; after one, its players keep their colours
                }
                s.in_bull_off = false;
                self.timed(s, "game_start", None).await;
            }
            Throw => {
                let p = self.slot(s, event.player_index, event.player_name.as_deref());
                self.turn(s, p).await;
            }
            Takeout | TakeoutInProgress => {
                if s.step == "turn" && !Self::held(s) {
                    self.enter(s, "takeout", None).await;
                }
            }
            LegWon => {
                s.queued_turn = None;
                let w = self.slot(s, event.player_index, event.player_name.as_deref());
                self.timed(s, "leg_won", Some(w)).await;
            }
            MatchWon | GameFinish => {
                s.queued_turn = None;
                let w = if event.player_name.is_some() || event.player_index.is_some() {
                    self.slot(s, event.player_index, event.player_name.as_deref())
                } else {
                    s.player
                };
                if !self.timed(s, "match_won", Some(w)).await {
                    self.finish_match(s).await;
                }
            }
            Single | Double | Triple | Bullseye | Score180 | Bust => self.hit(s, event).await,
            _ => {} // CALIBRATING and MANUAL_RESET don't change the flow
        }
    }

    /// The roster position of a player (added on first sight); falls back to the position given
    fn slot(&self, s: &mut RtState, player_index: Option<i64>, player_name: Option<&str>) -> i64 {
        let idx = player_index.filter(|i| *i >= 0).unwrap_or(0);
        let mut name = player_name.unwrap_or("").trim().to_string();
        if name.is_empty() {
            let players = self.out.match_players();
            name = players.get(idx as usize).map(|p| p.trim().to_string()).unwrap_or_default();
        }
        if name.is_empty() {
            return idx;
        }
        let key = name.to_lowercase();
        if let Some(i) = s.roster.iter().position(|n| n.to_lowercase() == key) {
            return i as i64;
        }
        s.roster.push(name);
        (s.roster.len() - 1) as i64
    }

    async fn turn(self: &Arc<Self>, s: &mut RtState, p: i64) {
        if s.in_bull_off {
            return; // bull-off darts are not turns
        }
        if Self::held(s) {
            s.queued_turn = Some(p);
            return;
        }
        if s.step == "turn" && s.player == p {
            return;
        }
        s.player = p;
        self.enter(s, "turn", Some(p)).await;
    }

    /// Enter a timed step where it is on. False when it is off everywhere (skipped).
    async fn timed(self: &Arc<Self>, s: &mut RtState, step_id: &str, winner: Option<i64>) -> bool {
        let segs = self.segments_with(step_id);
        if segs.is_empty() {
            return false;
        }
        Self::cancel_timer(s);
        let hold = segs.iter().map(|(ip, sid, _)| self.out.flow_for(ip, *sid).step(step_id).effect.duration).fold(f64::MIN, f64::max);
        self.enter(s, step_id, winner).await;
        s.hold_step = Some(step_id.into());
        s.hold_until = clock() + hold;
        s.timer_id += 1;
        let id = s.timer_id;
        let me = Arc::clone(self);
        let step = step_id.to_string();
        s.timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs_f64(hold.max(0.0))).await;
            me.release_after(&step, id).await;
        }));
        true
    }

    async fn release_after(self: &Arc<Self>, step_id: &str, id: u64) {
        let mut s = self.st.lock().await;
        if s.timer_id != id || s.hold_step.as_deref() != Some(step_id) {
            return;
        }
        s.hold_step = None;
        s.hold_until = 0.0;
        s.timer = None;
        if step_id == "match_won" {
            self.finish_match(&mut s).await;
        } else if let Some(p) = s.queued_turn.take() {
            s.player = p;
            self.enter(&mut s, "turn", Some(p)).await;
        }
        self.publish(&s);
    }

    async fn finish_match(self: &Arc<Self>, s: &mut RtState) {
        if self.out.match_end_to_waiting() {
            self.to_waiting(s).await;
        } else {
            // Lights stay on the winner's colour until the next game or the idle timer
            let p = s.player;
            self.enter(s, "turn", Some(p)).await;
        }
    }

    async fn to_waiting(self: &Arc<Self>, s: &mut RtState) {
        let was = s.step.clone();
        // The roster stays: a paused match that continues keeps its colours
        Self::reset_state(s, true);
        if was != WAITING {
            info!("Flow -> waiting lights (idle lighting from Setup)");
        }
        self.out.to_waiting().await;
        self.announce(s, None).await;
    }

    fn held(s: &RtState) -> bool {
        s.hold_step.is_some() && clock() < s.hold_until
    }

    fn cancel_timer(s: &mut RtState) {
        if let Some(t) = s.timer.take() {
            t.abort();
        }
        s.timer_id += 1;
        s.hold_step = None;
        s.hold_until = 0.0;
    }

    fn segments_with(&self, step_id: &str) -> Vec<Segment> {
        self.out.segments().into_iter().filter(|(ip, sid, _)| self.out.flow_for(ip, *sid).step(step_id).enabled()).collect()
    }

    async fn enter(self: &Arc<Self>, s: &mut RtState, step_id: &str, player: Option<i64>) {
        let segs = self.segments_with(step_id);
        if segs.is_empty() {
            return; // off everywhere: skipped, the strips keep their current look
        }
        self.out.ensure_streaming().await;
        for (ip, sid, _) in &segs {
            let flow = self.out.flow_for(ip, *sid);
            let step = flow.step(step_id);
            let eff = self.coloured(s, &step.effect, &flow, player, step_id == "turn");
            self.out.show(ip, *sid, &eff, &step.transition);
        }
        if let Some(p) = player {
            s.player = p;
        }
        s.step = step_id.into();
        if ["turn", "takeout", "leg_won", "match_won"].contains(&step_id) {
            info!("Flow -> {} (player {})", step_id, s.player + 1);
        } else {
            info!("Flow -> {}", step_id);
        }
        self.announce(s, None).await;
    }

    /// Which of the flow's colours a roster player gets (a colour tied to their name wins)
    fn colour_slot(s: &RtState, flow: &GameFlow, player: Option<i64>) -> usize {
        player_colour_index(&s.roster, Some(player.unwrap_or(s.player)), flow)
    }

    fn coloured(&self, s: &RtState, effect: &EffectConfig, flow: &GameFlow, player: Option<i64>, force_player: bool) -> EffectConfig {
        let wants = force_player || effect.options.as_ref().and_then(|o| o.get("colour_from")) == Some(&json!("player"));
        if !wants {
            return effect.clone();
        }
        EffectConfig { color_primary: flow.players[Self::colour_slot(s, flow, player)].color, ..effect.clone() }
    }

    async fn hit(self: &Arc<Self>, s: &mut RtState, event: &DartEvent) {
        if s.step == WAITING && !s.in_bull_off {
            return;
        }
        let mut played: Option<String> = None;
        let mut all: Vec<String> = Vec::new();
        let mut streaming = false;
        for (ip, sid, role) in self.out.segments() {
            let flow = self.out.flow_for(&ip, sid);
            let Some(key) = hit_key(event, &flow) else { continue };
            let effect = flow.hit(&key);
            let gentle = flow.camera_friendly && TURN_STEPS.contains(&s.step.as_str());
            if effect.enabled {
                if !streaming {
                    self.out.ensure_streaming().await;
                    streaming = true;
                }
                let mut eff = self.coloured(s, effect, &flow, None, false);
                if gentle && eff.duration > CAMERA_FRIENDLY_MAX_HIT {
                    eff.duration = CAMERA_FRIENDLY_MAX_HIT;
                }
                self.out.hit(&ip, sid, &eff, if gentle { CAMERA_FRIENDLY_STRENGTH } else { 1.0 });
                played = Some(key.clone());
                all.push(format!("{}{}", key, if gentle { " (gentle)" } else { "" }));
            }
            let pos = board_position(event.segment_number);
            if flow.hit_locator && role != "ambient" && ["single", "double", "triple", "ton", "ton40"].contains(&key.as_str()) {
                if let Some(pos) = pos {
                    if self.out.can_locate(&ip, sid) {
                        if !streaming {
                            self.out.ensure_streaming().await;
                            streaming = true;
                        }
                        let colour = flow.players[Self::colour_slot(s, &flow, None)].color;
                        self.out.locate(&ip, sid, pos, colour);
                        if played.is_none() {
                            played = Some("locator".into());
                        }
                        all.push("locator".into());
                    }
                }
            }
        }
        if let Some(p) = played {
            let mut uniq: Vec<String> = Vec::new();
            for a in all {
                if !uniq.contains(&a) {
                    uniq.push(a);
                }
            }
            info!("Flow hit: {}", uniq.join(", "));
            s.last_hit = Some(p.clone());
            self.announce(s, Some(&p)).await;
        }
    }

    async fn announce(&self, s: &RtState, hit: Option<&str>) {
        let mut msg = crate::obj! {"type" => "game_flow_state", "phase" => s.step, "player" => s.player};
        let segs = self.out.segments();
        if let Some(first) = segs.first() {
            if !s.roster.is_empty() {
                let f = self.out.flow_for(&first.0, first.1);
                msg.insert("colour".into(), json!(Self::colour_slot(s, &f, None)));
            }
        }
        if let Some(h) = hit {
            msg.insert("hit".into(), json!(h));
        }
        self.publish(s);
        self.out.broadcast(Value::Object(msg)).await;
    }
}

// --- Match preview -----------------------------------------------------------------------------

pub const DART_GAP: f64 = 0.9;
pub const TAKEOUT_TIME: f64 = 1.4;

fn ev(kind: DartEventType) -> DartEvent {
    DartEvent::new(kind)
}

/// Three darts per visit (event, segment number, multiplier); visits rotate through these
const VISITS: [[(DartEventType, i64, i64); 3]; 5] = [
    [(DartEventType::Single, 20, 1), (DartEventType::Triple, 20, 3), (DartEventType::Single, 5, 1)],
    [(DartEventType::Triple, 19, 3), (DartEventType::Triple, 19, 3), (DartEventType::Single, 19, 1)],
    [(DartEventType::Double, 16, 2), (DartEventType::Bust, 0, 0), (DartEventType::Bullseye, 25, 2)],
    [(DartEventType::Triple, 20, 3), (DartEventType::Triple, 20, 3), (DartEventType::Score180, 20, 3)],
    [(DartEventType::Single, 1, 1), (DartEventType::Single, 18, 1), (DartEventType::Double, 4, 2)],
];

fn visit_events(visit_no: usize, player: i64) -> Vec<DartEvent> {
    let darts = VISITS[visit_no % VISITS.len()];
    let mut total = 0;
    let mut out = Vec::new();
    for (k, (kind, num, mult)) in darts.iter().enumerate() {
        let points = if *kind != DartEventType::Bust { num * mult } else { 0 };
        total += points;
        let last = k == darts.len() - 1;
        let mut e = ev(*kind);
        e.player_index = Some(player);
        match kind {
            DartEventType::Score180 => e.score = 180,
            DartEventType::Bust => {
                e.multiplier = 0;
                e.segment_number = Some(0);
                e.segment_name = Some("Miss".into());
            }
            _ => {
                e.score = points;
                e.multiplier = *mult;
                e.segment_number = Some(*num);
                e.round_score = if last { Some(total) } else { None };
            }
        }
        out.push(e);
    }
    out
}

async fn sleep(s: f64) {
    tokio::time::sleep(Duration::from_secs_f64(s)).await;
}

/// Plays the made-up match; the caller resets the runtime and returns to waiting afterwards
pub async fn run_preview(runtime: Arc<FlowRuntime>, players: i64, bull_off: bool, legs: i64) {
    let send = |e: DartEvent| {
        let rt = Arc::clone(&runtime);
        async move { rt.handle(&e).await }
    };
    let wait_timed = || {
        let rt = Arc::clone(&runtime);
        async move { sleep(rt.hold_remaining().await + 0.6).await }
    };
    if bull_off {
        send(ev(DartEventType::BullOffStart)).await;
        sleep(1.5).await;
        for p in 0..players {
            let mut t = ev(DartEventType::Throw);
            t.player_index = Some(p);
            send(t).await;
            let mut b = ev(DartEventType::Single);
            b.score = 25;
            b.segment_number = Some(25);
            b.player_index = Some(p);
            send(b).await;
            sleep(1.2).await;
        }
        let mut w = ev(DartEventType::BullOffWon);
        w.player_index = Some(0);
        send(w).await;
        sleep(1.5).await;
    }
    send(ev(DartEventType::GameStart)).await;
    wait_timed().await;
    let mut visit = 0;
    let mut starter = 0;
    for leg in 0..legs {
        for rnd in 0..2 {
            for k in 0..players {
                let p = (starter + k) % players;
                let mut t = ev(DartEventType::Throw);
                t.player_index = Some(p);
                send(t).await;
                sleep(DART_GAP).await;
                for d in visit_events(visit, p) {
                    send(d).await;
                    sleep(DART_GAP).await;
                }
                visit += 1;
                let final_visit = rnd == 1 && k == players - 1;
                if !final_visit {
                    let mut t = ev(DartEventType::TakeoutInProgress);
                    t.player_index = Some(p);
                    send(t).await;
                    sleep(TAKEOUT_TIME).await;
                }
            }
        }
        let winner = (starter + players - 1) % players;
        if leg < legs - 1 {
            let mut e = ev(DartEventType::LegWon);
            e.player_index = Some(winner);
            send(e).await;
            wait_timed().await;
            starter = (starter + 1) % players;
        } else {
            let mut e = ev(DartEventType::MatchWon);
            e.player_index = Some(winner);
            send(e).await;
        }
    }
    sleep(12.0).await; // let the celebration finish, then back to waiting
}

/// After the preview (finished or stopped): back to waiting
pub async fn end_preview(runtime: &Arc<FlowRuntime>) {
    runtime.reset(false).await;
    runtime.out.to_waiting().await;
}

pub fn preview_seconds(players: i64, bull_off: bool, legs: i64) -> i64 {
    let visit = 4.0 * DART_GAP + TAKEOUT_TIME;
    let s = (if bull_off { 8.0 } else { 0.0 }) + legs as f64 * 2.0 * players as f64 * visit + 15.0;
    crate::py::py_round(s)
}

