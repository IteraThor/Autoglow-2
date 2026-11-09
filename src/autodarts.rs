//! Autodarts game data from the AutoGlow Bridge Chrome extension.
//!
//! The extension relays what play.autodarts.com already receives (board, match and lobby channels plus a
//! few HTTP replies). This module turns that into DartEvents for the engine: turns, hits, takeouts, leg and
//! match results and the bull-off. The direct cloud login stays on hold until Autodarts approves it, so
//! nothing here ever talks to the Autodarts cloud.
//!
//! Parsing is synchronous: events are collected while the state is locked and handed to the engine
//! afterwards, in order, so the engine can read the match state (players, active match) while it runs.

use crate::models::{DartEvent, DartEventType};
use crate::py::*;
use futures_util::future::BoxFuture;
use log::{debug, info};
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const CLOUD_API_HOLD_MESSAGE: &str = "Direct Autodarts login is on hold. Install the AutoGlow Chrome extension and play on play.autodarts.com; AutoGlow receives the game data from the extension.";
const RELAYED_CHANNELS: [&str; 3] = ["autodarts.boards", "autodarts.matches", "autodarts.lobbies"];
const LOBBY_CHANNEL: &str = "autodarts.lobbies";
const MATCH_CACHE_LIMIT: usize = 8;
const SOURCE_LOST_GRACE_SECONDS: f64 = 60.0;
const MAX_HTTP_SNAPSHOTS: usize = 8;
const LOBBY_END_EVENTS: [&str; 6] = ["delete", "deleted", "start", "started", "finish", "finished"];
const LOBBY_START_EVENTS: [&str; 2] = ["start", "started"];
const BULL_OFF_VARIANT: &str = "Bull-off";
const BULL_OFF_GAME_KEYS: [&str; 16] = [
    "variant", "settings", "gameScores", "gameFinished", "gameWinner", "scores", "stats", "state", "turns", "turnScore", "turnBusted", "skippedPlayers",
    "player", "round", "leg", "set",
];
const MATCH_FINISHED_WORDS: [&str; 4] = ["finish", "finished", "end", "ended"];
const MATCH_ABORTED_WORDS: [&str; 8] = ["abort", "aborted", "delete", "deleted", "stop", "cancel", "cancelled", "canceled"];
const BUST_EVENTS: [&str; 4] = ["bust", "busted", "miss", "outside"];
const LEG_WON_EVENTS: [&str; 4] = ["leg-won", "leg_won", "leg", "checkout"];
const MATCH_WON_EVENTS: [&str; 5] = ["match-won", "match_won", "game-won", "game_won", "winner"];
const BOARD_IDLE_STATUSES: [&str; 2] = ["stopped", "idle"];
const PLAYER_NAME_KEYS: [&str; 6] = ["name", "username", "userName", "nickname", "alias", "displayName"];
const BULL_NAMES: [&str; 6] = ["BULL", "DBULL", "DOUBLE BULL", "DOUBLE_BULL", "BULLSEYE", "50"];
const OUTER_BULL_NAMES: [&str; 5] = ["25", "SBULL", "SINGLE BULL", "SINGLE_BULL", "OUTER BULL"];
const MISS_NAMES: [&str; 5] = ["MISS", "OUTSIDE", "OFF", "0", "NONE"];
const NO_NAME: [&str; 5] = ["-1", "none", "null", "false", ""];

fn re(cell: &'static OnceLock<Regex>, pat: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pat).unwrap())
}
static BOARDS_LIST_RE: OnceLock<Regex> = OnceLock::new();
static BOARD_ITEM_RE: OnceLock<Regex> = OnceLock::new();
static MATCH_ITEM_RE: OnceLock<Regex> = OnceLock::new();
static LOBBY_ITEM_RE: OnceLock<Regex> = OnceLock::new();
static GAME_PAGE_RE: OnceLock<Regex> = OnceLock::new();

/// A JSON integer (not a float, not a bool), like isinstance(v, int) for parsed JSON
fn as_int(v: Option<&Value>) -> Option<i64> {
    v.and_then(|v| if v.is_i64() || v.is_u64() { v.as_i64() } else { None })
}

/// isinstance(v, (int, float)) without bools
fn as_num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|v| if v.is_number() { v.as_f64() } else { None })
}

pub fn is_match_over(state: &Obj) -> bool {
    state.get("finished") == Some(&Value::Bool(true)) || as_int(state.get("winner")).map_or(false, |w| w >= 0)
}

fn event_name(p: &Obj) -> String {
    non_empty(p.get("event")).or_else(|| non_empty(p.get("name"))).or_else(|| non_empty(p.get("type"))).map(py_str).unwrap_or_default().to_lowercase()
}

/// The step of the takeout cycle an event name reports; the first that matches wins
fn takeout_step(ev: &str) -> Option<&'static str> {
    if (ev.contains("takeout") || ev.contains("motion")) && ev.contains("start") {
        return Some("takeout_start");
    }
    if ["takeout finish", "takeout_finish", "darts-pulled", "darts_pulled", "motion finish"].iter().any(|w| ev.contains(w)) {
        return Some("takeout_finish");
    }
    if ev.contains("takeout") || ev.contains("take out") {
        return Some("takeout");
    }
    if ev.contains("calibrat") {
        return Some("calibrating");
    }
    if ev.contains("throw") {
        return Some("throw");
    }
    None
}

/// The winner a match event names, or None (Autodarts sends -1 for nobody)
fn named_winner(p: &Obj) -> Option<Value> {
    let w = non_empty(p.get("winner")).or_else(|| p.get("player")).cloned();
    w.filter(|w| !w.is_null() && py_str(w) != "-1")
}

fn first_number(values: &[Option<&Value>], default: i64) -> i64 {
    values.iter().find_map(|v| as_num(*v)).map(|f| f.trunc() as i64).unwrap_or(default)
}

/// (score, multiplier, label) of a throw, from whichever of the segment, score and bed fields it has
pub fn read_throw(t: &Obj) -> (i64, i64, String) {
    let seg = t.get("segment");
    let (mut seg_name, mut seg_number, mut seg_mult, mut seg_bed) = (String::new(), None, None, String::new());
    match seg {
        Some(Value::Object(s)) => {
            seg_name = non_empty(s.get("name")).map(py_str).unwrap_or_default().trim().to_string();
            seg_number = s.get("number").cloned();
            seg_mult = s.get("multiplier").cloned();
            seg_bed = non_empty(s.get("bed")).map(py_str).unwrap_or_default().trim().to_lowercase();
        }
        Some(Value::String(s)) => seg_name = s.trim().to_string(),
        Some(v) if v.is_number() => seg_number = Some(json!(v.as_f64().unwrap_or(0.0).trunc() as i64)),
        _ => {}
    }
    let mut score = first_number(&[seg_number.as_ref(), t.get("score"), t.get("points")], 0);
    let bed_mult = match seg_bed.as_str() {
        "triple" => 3,
        "double" => 2,
        "single" => 1,
        "outside" | "miss" | "off" => 0,
        _ => 1,
    };
    let mut mult = first_number(&[seg_mult.as_ref(), t.get("multiplier")], bed_mult);
    let u = seg_name.to_uppercase();
    let ring = match u.chars().next() {
        Some('T') => Some(3),
        Some('D') => Some(2),
        Some('S') => Some(1),
        _ => None,
    };
    let rest: String = u.chars().skip(1).collect();
    if ring.is_some() && !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
        mult = ring.unwrap();
        score = rest.parse().unwrap_or(0);
    } else if BULL_NAMES.contains(&u.as_str()) {
        mult = 2;
        score = 25;
        seg_name = "Bull".into();
    } else if OUTER_BULL_NAMES.contains(&u.as_str()) {
        mult = 1;
        score = 25;
        seg_name = "25".into();
    } else if MISS_NAMES.contains(&u.as_str()) {
        mult = 0;
        score = 0;
    }
    let label = if !seg_name.is_empty() {
        seg_name
    } else if score == 0 || mult == 0 {
        "Miss".into()
    } else if score == 25 && mult == 2 {
        "Bull".into()
    } else if score == 25 && mult == 1 {
        "25".into()
    } else {
        match mult {
            3 => format!("T{}", score),
            2 => format!("D{}", score),
            1 => format!("S{}", score),
            _ => score.to_string(),
        }
    };
    (score, mult, label)
}

/// (legs won in total, whether the state has leg data at all, legs won per player)
pub fn count_legs(state: &Obj) -> (i64, bool, Vec<i64>) {
    let mut total = 0;
    let mut has = false;
    if let Some(Value::Array(legs)) = state.get("legs") {
        has = true;
        let won = legs.iter().filter(|l| l.get("winner").map_or(false, |w| !w.is_null()) || l.get("finished") == Some(&Value::Bool(true))).count() as i64;
        total = total.max(won);
    }
    let mut counts: Vec<i64> = Vec::new();
    if let Some(Value::Array(players)) = state.get("players") {
        for p in players {
            let Some(p) = p.as_object() else { continue };
            let l = if p.get("legsWon").map_or(false, |v| !v.is_null()) {
                p.get("legsWon").cloned()
            } else if p.get("legs").map_or(false, |v| !v.is_null()) {
                p.get("legs").cloned()
            } else if let Some(Value::Object(st)) = p.get("stats") {
                st.get("legs").cloned()
            } else {
                None
            };
            match as_num(l.as_ref()) {
                Some(v) if (v.trunc() as i64) < 100 => {
                    counts.push(v.trunc() as i64);
                    has = true;
                }
                _ => counts.push(0),
            }
        }
        if !counts.is_empty() {
            total = total.max(counts.iter().sum());
        }
    }
    if let Some(Value::Array(scores)) = state.get("scores") {
        let mut sl = 0;
        for (i, s) in scores.iter().enumerate() {
            let Some(s) = s.as_object() else { continue };
            let lv = if s.get("legs").map_or(false, |v| !v.is_null()) {
                s.get("legs")
            } else if s.get("legsWon").map_or(false, |v| !v.is_null()) {
                s.get("legsWon")
            } else {
                s.get("legs_won")
            };
            if let Some(v) = as_num(lv).filter(|v| (v.trunc() as i64) < 100) {
                let v = v.trunc() as i64;
                sl += v;
                has = true;
                if i < counts.len() {
                    counts[i] = counts[i].max(v);
                } else {
                    counts.push(v);
                }
            }
        }
        if sl > total {
            total = sl;
        }
    }
    (total, has, counts)
}

/// Legs needed to win the match (1..30; point targets like 501 are never taken for it)
pub fn legs_to_win(state: &Obj) -> Option<i64> {
    let ok = |v: Option<&Value>| as_num(v).map(|f| f.trunc() as i64).filter(|n| (1..=30).contains(n));
    for k in ["targetLegs", "legsToWin"] {
        if let Some(n) = ok(state.get(k)) {
            return Some(n);
        }
    }
    let m = non_empty(state.get("match")).or_else(|| non_empty(state.get("settings"))).or_else(|| non_empty(state.get("game"))).or_else(|| non_empty(state.get("rules")));
    if let Some(Value::Object(m)) = m {
        for k in ["targetLegs", "legsToWin", "legs"] {
            if let Some(n) = ok(m.get(k)) {
                return Some(n);
            }
        }
    }
    None
}

#[derive(Clone, Default)]
struct SourceState {
    version: String,
    attached: bool,
    url: String,
    /// key -> message, oldest first
    snapshots: Vec<(String, Value)>,
}

/// Everything the parser knows about the running match
#[derive(Default)]
pub struct BridgeState {
    pub board_id: String,
    pub is_connected: bool,
    pub extension_version: String,
    pub tab_url: String,
    pub tab_attached: bool,
    sources: Vec<u64>,
    primary: Option<u64>,
    source_state: HashMap<u64, SourceState>,
    match_cache: Vec<(String, Value)>,
    lobby: Option<Obj>,
    source_lost_pending: bool,

    match_id: Option<String>,
    ended_match_ids: Vec<String>,
    paused_match_id: Option<String>,
    start_announced_at: f64,
    last_180_fired: bool,
    last_bust_fired: bool,
    last_total_legs_won: Option<i64>,
    last_match_finished: bool,
    last_throw_id: Option<String>,
    last_turn_id: Option<String>,
    last_leg_won_time: f64,
    last_match_won_time: f64,
    in_leg_break: bool,
    bull_off_phase: Option<String>,
    bull_off_round: i64,
    pub current_players: Vec<String>,
    pub active_player_idx: i64,
    pub last_match_state: Option<Obj>,
    pub last_match_state_at: f64,
    pub bull_off: Option<Obj>,
    pub board_states: BTreeMap<String, Obj>,
    boards_cache: Vec<Value>,
    own_board_ids: HashSet<String>,
    last_flow_state: Option<String>,

    pending: Vec<DartEvent>,
    replay_for: Option<u64>,
}

fn now() -> f64 {
    crate::led_thread::wall()
}

impl BridgeState {
    pub fn active_match_id(&self) -> Option<&str> {
        self.match_id.as_deref()
    }

    fn set_match(&mut self, v: Option<String>) {
        if v.is_none() {
            if let Some(m) = self.match_id.take() {
                self.ended_match_ids.retain(|x| x != &m);
                self.ended_match_ids.push(m);
                while self.ended_match_ids.len() > 20 {
                    self.ended_match_ids.remove(0);
                }
            }
        }
        self.match_id = v;
    }

    fn emit(&mut self, e: DartEvent) {
        self.pending.push(e);
    }

    fn ev(&self, t: DartEventType) -> DartEvent {
        let mut e = DartEvent::new(t);
        e.board_id = Some(self.board_id.clone()).filter(|b| !b.is_empty());
        e
    }

    fn current_player(&self) -> Option<String> {
        self.current_players.get(self.active_player_idx.max(0) as usize).cloned().filter(|_| self.active_player_idx >= 0)
    }

    fn emit_player(&mut self, t: DartEventType, name: Option<String>, board: Option<String>) {
        let mut e = DartEvent::new(t);
        e.player_name = name;
        e.player_index = Some(self.active_player_idx);
        e.board_id = board;
        self.emit(e);
    }

    fn board(&self) -> Option<String> {
        Some(self.board_id.clone()).filter(|b| !b.is_empty())
    }

    pub fn reset_match_state(&mut self) {
        self.last_180_fired = false;
        self.last_bust_fired = false;
        self.last_total_legs_won = None;
        self.last_match_finished = false;
        self.last_throw_id = None;
        self.last_turn_id = None;
        self.last_leg_won_time = 0.0;
        self.last_match_won_time = 0.0;
        self.in_leg_break = false;
        self.last_flow_state = None;
        self.bull_off_phase = None;
        self.bull_off_round = 0;
        self.bull_off = None;
        self.current_players.clear();
        self.active_player_idx = 0;
        self.last_match_state = None;
        self.last_match_state_at = 0.0;
    }

    fn adopt_match(&mut self, id: &str, reason: &str) {
        self.set_match(Some(id.into()));
        self.paused_match_id = None;
        self.reset_match_state();
        info!("{}", reason);
    }

    fn start_match(&mut self, id: &str, board: &str, reason: &str) {
        self.adopt_match(id, reason);
        // Bridge mode: the match details are what the tab fetched (match cache)
        if let Some(data) = self.match_cache.iter().find(|(k, _)| k == id).map(|(_, v)| v.clone()) {
            self.extract_and_set_players(&data);
            if let Some(o) = data.as_object() {
                info!("Successfully fetched initial match state for {} (players: {}, active_idx: {})", id, if self.current_players.is_empty() { "None".into() } else { self.current_players.join(", ") }, self.active_player_idx);
                self.parse_match_state(o);
            }
        }
        let mut e = DartEvent::new(DartEventType::GameStart);
        e.board_id = Some(board.into());
        self.emit(e);
    }

    /// The match is over without a result: back to idle. final=false when AutoGlow only lost sight of it.
    fn end_match(&mut self, board: Option<String>, flow_state: Option<&str>, final_: bool) {
        let mid = self.match_id.clone();
        self.set_match(None);
        if final_ {
            self.paused_match_id = None;
            self.reset_match_state();
        } else {
            if let Some(m) = &mid {
                self.ended_match_ids.retain(|x| x != m);
            }
            self.paused_match_id = mid;
        }
        self.last_flow_state = flow_state.map(str::to_string);
        let mut e = DartEvent::new(DartEventType::GameIdle);
        e.board_id = board;
        self.emit(e);
    }

    fn leave_match(&mut self, reason: &str) {
        info!("{}", reason);
        self.set_match(None);
        self.paused_match_id = None;
        self.reset_match_state();
    }

    fn resume_match(&mut self, id: &str) {
        self.set_match(Some(id.into()));
        self.paused_match_id = None;
        self.last_turn_id = None;
        self.last_flow_state = None;
        info!("Match {} is still running -> back to the game lighting", id);
    }

    fn is_own_board(&self, b: &str) -> bool {
        let mut own = self.own_board_ids.clone();
        if !self.board_id.is_empty() {
            own.insert(self.board_id.clone());
        }
        own.is_empty() || own.contains(b)
    }

    fn first_board(&self) -> Option<String> {
        self.board_states.keys().next().cloned()
    }

    pub fn handle_raw_message(&mut self, data: &Obj) {
        let channel = data.get("channel").map(py_str).unwrap_or_default();
        let topic = data.get("topic").map(py_str).unwrap_or_default();
        let Some(payload) = data.get("data").and_then(Value::as_object) else { return };
        debug!("Autodarts WS RAW: channel='{}', topic='{}', payload={}", channel, topic, Value::Object(payload.clone()));
        let head = topic.split('.').next().unwrap_or("").to_string();
        if channel == "autodarts.boards" {
            if !self.is_own_board(&head) {
                return;
            }
            if topic.ends_with(".matches") {
                self.on_board_matches(&head, payload);
            } else if topic.ends_with(".state") {
                self.on_board_state(&head, payload);
            } else if topic.ends_with(".events") {
                self.on_board_event(&head, payload);
            }
        } else if channel == "autodarts.matches" {
            self.on_match_message(&topic, payload);
        }
    }

    fn on_board_matches(&mut self, b: &str, p: &Obj) {
        let event = non_empty(p.get("event")).or_else(|| non_empty(p.get("type"))).map(py_str).unwrap_or_default().to_lowercase();
        let mid = non_empty(p.get("id")).or_else(|| non_empty(p.get("matchId"))).map(py_str);
        if MATCH_FINISHED_WORDS.contains(&event.as_str()) || MATCH_ABORTED_WORDS.contains(&event.as_str()) {
            info!("Match ended/stopped on board {}: {}", b, event);
            if MATCH_ABORTED_WORDS.contains(&event.as_str()) {
                self.end_match(Some(b.into()), None, true);
            } else if !self.last_match_finished {
                self.last_match_finished = true;
                self.in_leg_break = true;
                let w = non_empty(p.get("winner")).or_else(|| p.get("player")).cloned();
                self.emit_match_won(w);
            }
        } else if let Some(m) = mid {
            if Some(m.as_str()) != self.match_id.as_deref() {
                self.start_match(&m, b, &format!("Match started on board {}: {}", b, m));
            }
        }
    }

    fn on_board_state(&mut self, b: &str, p: &Obj) {
        self.board_states.insert(b.into(), p.clone());
        let mid = non_empty(p.get("matchId")).map(py_str);
        let status = p.get("status").map(py_str).unwrap_or_default();
        let sl = status.to_lowercase();
        let idle = BOARD_IDLE_STATUSES.contains(&sl.as_str());
        if mid.is_some() && mid.as_deref() != self.match_id.as_deref() {
            let m = mid.clone().unwrap();
            if !idle && Some(&m) == self.paused_match_id.as_ref() {
                self.resume_match(&m);
            } else if !idle {
                self.start_match(&m, b, &format!("Active match detected via board.state on {}: {}", b, m));
            }
        } else if idle && self.match_id.is_some() {
            if p.contains_key("matchId") && mid.is_none() {
                info!("Board {} left match {} ({}) -> emitting GAME_IDLE", b, self.match_id.clone().unwrap_or_default(), status);
                self.end_match(Some(b.into()), Some("idle"), false);
            } else if self.last_flow_state.as_deref() != Some("stopped") {
                self.last_flow_state = Some("stopped".into());
                info!("Board {} reports {} during match {} -> keeping the game lighting", b, status, self.match_id.clone().unwrap_or_default());
            }
        }
        let pn = self.current_player();
        let takeout = sl.contains("takeout") || sl.contains("take out");
        let bb = Some(b.to_string());
        if sl.contains("calibrat") {
            info!("Board calibration status detected: {}", status);
            let mut e = DartEvent::new(DartEventType::Calibrating);
            e.board_id = bb;
            self.emit(e);
        } else if takeout && sl.contains("progress") {
            if !self.in_leg_break && self.last_flow_state.as_deref() != Some("takeout_in_progress") {
                self.last_flow_state = Some("takeout_in_progress".into());
                info!("Board flow state -> TAKEOUT IN PROGRESS (Status: {})", status);
                self.emit_player(DartEventType::TakeoutInProgress, pn, bb);
            }
        } else if takeout {
            if !self.in_leg_break && self.last_flow_state.as_deref() != Some("takeout") {
                self.last_flow_state = Some("takeout".into());
                info!("Board flow state -> TAKEOUT (Waiting for player to takeout, Status: {})", status);
                self.emit_player(DartEventType::Takeout, pn, bb);
            }
        } else if (sl.contains("throw") || sl.contains("ready") || sl.contains("play"))
            && self.match_id.is_some()
            && !self.in_leg_break
            && self.last_flow_state.as_deref() != Some("throw")
        {
            self.last_flow_state = Some("throw".into());
            info!("Board flow state -> THROW (Waiting for player to throw, Status: {})", status);
            self.emit_player(DartEventType::Throw, pn, bb);
        }
    }

    fn on_board_event(&mut self, b: &str, p: &Obj) {
        let ev = event_name(p);
        info!("Board event received on {}: {}", b, ev);
        let pn = self.current_player();
        let bb = Some(b.to_string());
        if ev.contains("manual reset") || ev.contains("manual_reset") {
            if !self.in_leg_break {
                self.emit_player(DartEventType::ManualReset, pn.clone(), bb.clone());
                if self.match_id.is_some() {
                    self.last_flow_state = Some("throw".into());
                    info!("Board flow state -> THROW after manual reset");
                    self.emit_player(DartEventType::Throw, pn, bb);
                }
            }
            return;
        }
        let step = takeout_step(&ev);
        if step == Some("calibrating") {
            let mut e = DartEvent::new(DartEventType::Calibrating);
            e.board_id = bb;
            self.emit(e);
            return;
        }
        let Some(step) = step else { return };
        if self.in_leg_break {
            return;
        }
        match step {
            "takeout_start" => {
                self.last_flow_state = Some("takeout_in_progress".into());
                info!("Board flow state -> TAKEOUT IN PROGRESS (Event: {})", ev);
                self.emit_player(DartEventType::TakeoutInProgress, pn, bb);
            }
            "takeout_finish" => {
                self.last_flow_state = Some("takeout_finished".into());
                info!("Board flow state -> TAKEOUT FINISHED (Event: {})", ev);
            }
            "takeout" => {
                if self.last_flow_state.as_deref() != Some("takeout") {
                    self.last_flow_state = Some("takeout".into());
                    info!("Board flow state -> TAKEOUT (Event: {})", ev);
                    self.emit_player(DartEventType::Takeout, pn, bb);
                }
            }
            _ => {
                self.last_flow_state = Some("throw".into());
                info!("Board flow state -> THROW (Event: {})", ev);
                self.emit_player(DartEventType::Throw, pn, bb);
            }
        }
    }

    fn on_match_message(&mut self, topic: &str, p: &Obj) {
        let from_topic = if topic.contains('.') { Some(topic.split('.').next().unwrap_or("").to_string()) } else { None }.filter(|s| !s.is_empty());
        if from_topic.is_none() && self.match_id.is_none() && (topic == ".game-events" || topic == ".corrections") {
            let t = now();
            if t - self.start_announced_at > 3.0 {
                self.start_announced_at = t;
                info!("Match start signalled by id-less match topic");
                let b = self.first_board();
                let mut e = DartEvent::new(DartEventType::GameStart);
                e.board_id = b.clone();
                self.emit(e);
                let mut th = DartEvent::new(DartEventType::Throw);
                th.player_index = Some(0);
                th.board_id = b;
                self.emit(th);
            }
            return;
        }
        if let Some(m) = &from_topic {
            if self.ended_match_ids.contains(m) {
                debug!("Ignoring message for ended match {}", m);
                return;
            }
        }
        if self.last_match_finished && from_topic.is_some() && self.match_id.is_some() && self.match_id != from_topic {
            let r = format!("Match {} follows the finished match {}", from_topic.clone().unwrap(), self.match_id.clone().unwrap());
            self.leave_match(&r);
        }
        if self.match_id.is_none() && from_topic.is_some() && from_topic == self.paused_match_id {
            self.resume_match(&from_topic.clone().unwrap());
        } else if self.match_id.is_none() {
            if let Some(m) = from_topic.clone() {
                self.adopt_match(&m, &format!("Match started (first message on match topic): {}", m));
                if now() - self.start_announced_at > 120.0 {
                    let mut e = DartEvent::new(DartEventType::GameStart);
                    e.board_id = self.first_board();
                    self.emit(e);
                }
            }
        }
        if self.match_id.is_some() && from_topic.is_some() && from_topic != self.match_id {
            debug!("Ignoring message for inactive match {:?} (active: {:?})", from_topic, self.match_id);
            return;
        }
        if topic.ends_with(".state") {
            self.parse_match_state(p);
        } else if topic.ends_with(".events") {
            self.on_match_event(p);
        }
    }

    fn on_match_event(&mut self, p: &Obj) {
        let ev = event_name(p);
        let pn = self.current_player();
        let b = self.board();
        let step = takeout_step(&ev);
        if step == Some("calibrating") {
            info!("Match event '{}' received -> emitting CALIBRATING", ev);
            let e = self.ev(DartEventType::Calibrating);
            self.emit(e);
        } else if let Some(step) = step {
            if self.in_leg_break {
                return;
            }
            match step {
                "takeout_start" => {
                    self.last_flow_state = Some("takeout_in_progress".into());
                    info!("Match event '{}' received -> emitting TAKEOUT_IN_PROGRESS", ev);
                    self.emit_player(DartEventType::TakeoutInProgress, pn, b);
                }
                "takeout_finish" => {
                    self.last_flow_state = Some("takeout_finished".into());
                    info!("Match event '{}' received -> TAKEOUT FINISHED", ev);
                }
                "takeout" => {
                    if self.last_flow_state.as_deref() != Some("takeout") {
                        self.last_flow_state = Some("takeout".into());
                        info!("Match event '{}' received -> emitting TAKEOUT", ev);
                        self.emit_player(DartEventType::Takeout, pn, b);
                    }
                }
                _ => {
                    info!("Match event '{}' received -> emitting THROW", ev);
                    self.emit_player(DartEventType::Throw, pn, b);
                }
            }
        } else if ev == "180" && !self.last_180_fired {
            self.last_180_fired = true;
            let mut e = self.ev(DartEventType::Score180);
            e.score = 180;
            self.emit(e);
        } else if BUST_EVENTS.contains(&ev.as_str()) && !self.last_bust_fired {
            self.last_bust_fired = true;
            info!("Match event '{}' received -> emitting BUST", ev);
            let mut e = self.ev(DartEventType::Bust);
            e.multiplier = 0;
            e.segment_name = Some("Miss".into());
            self.emit(e);
        } else if LEG_WON_EVENTS.contains(&ev.as_str()) {
            if !self.last_match_finished {
                info!("Match event '{}' received -> emitting LEG_WON", ev);
                let pnum = as_int(p.get("player"));
                let winner = pnum.filter(|i| *i >= 0 && (*i as usize) < self.current_players.len()).map(|i| json!(self.current_players[i as usize]));
                self.emit_leg_won(winner, pnum);
            }
        } else if MATCH_WON_EVENTS.contains(&ev.as_str()) {
            info!("Match event '{}' received -> emitting MATCH_WON", ev);
            if let Some(w) = named_winner(p) {
                self.emit_match_won(Some(w));
            }
        } else if MATCH_FINISHED_WORDS.contains(&ev.as_str()) || MATCH_ABORTED_WORDS.contains(&ev.as_str()) {
            info!("Match event '{}' received", ev);
            if MATCH_ABORTED_WORDS.contains(&ev.as_str()) {
                let b = self.board();
                self.end_match(b, None, true);
            } else if !self.last_match_finished {
                if let Some(w) = named_winner(p) {
                    self.last_match_finished = true;
                    self.in_leg_break = true;
                    self.emit_match_won(Some(w));
                }
            }
        }
    }

    pub fn extract_and_set_players(&mut self, v: &Value) {
        if !truthy(v) {
            return;
        }
        let mut out: Vec<String> = Vec::new();
        fn add(val: Option<&Value>, out: &mut Vec<String>) {
            match val {
                Some(Value::String(s)) => {
                    let s = s.trim();
                    if !s.is_empty() && !out.iter().any(|x| x == s) {
                        out.push(s.into());
                    }
                }
                Some(Value::Object(o)) => {
                    let name = PLAYER_NAME_KEYS.iter().find_map(|k| non_empty(o.get(*k)));
                    if let Some(Value::String(n)) = name {
                        if !n.trim().is_empty() {
                            if !out.iter().any(|x| x == n.trim()) {
                                out.push(n.trim().into());
                            }
                            return;
                        }
                    }
                    let user = o.get("user");
                    let un = match user {
                        Some(Value::Object(u)) => non_empty(u.get("name")).or_else(|| u.get("username")).cloned(),
                        other => other.cloned(),
                    };
                    if let Some(Value::String(u)) = un {
                        if !u.trim().is_empty() && !out.iter().any(|x| x == u.trim()) {
                            out.push(u.trim().into());
                            return;
                        }
                    }
                    for k in ["players", "members", "participants"] {
                        if let Some(Value::Array(l)) = o.get(k) {
                            for s in l {
                                add(Some(s), out);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        match v {
            Value::Object(o) => {
                if let Some(i) = as_int(o.get("player")) {
                    self.active_player_idx = i;
                }
                for k in ["players", "participants", "playerNames", "users", "teams", "roster"] {
                    if let Some(Value::Array(l)) = o.get(k) {
                        for it in l {
                            add(Some(it), &mut out);
                        }
                    }
                }
                if let Some(Value::Array(turns)) = o.get("turns") {
                    for t in turns.iter().filter_map(Value::as_object) {
                        for k in ["player", "playerName", "user"] {
                            add(t.get(k), &mut out);
                        }
                    }
                }
            }
            Value::Array(l) => {
                for it in l {
                    add(Some(it), &mut out);
                }
            }
            _ => {}
        }
        if !out.is_empty() {
            info!("Identified match players ({}): {} (Active Idx: {})", out.len(), out.join(", "), self.active_player_idx);
            self.current_players = out;
        }
    }

    /// Keep the latest match state for the Studio; a message may carry only part of it, so merge
    pub fn remember_match_state(&mut self, state: &Obj) {
        let same = match &self.last_match_state {
            Some(prev) => !state.get("id").map_or(false, truthy) || prev.get("id") == state.get("id"),
            None => false,
        };
        let mut st = state.clone();
        if state.get("variant").and_then(Value::as_str) == Some(BULL_OFF_VARIANT) {
            self.remember_bull_off(state);
            st.retain(|k, _| !BULL_OFF_GAME_KEYS.contains(&k.as_str()));
            st.insert("bullOff".into(), json!(true));
        } else if state.get("gameScores").map_or(false, |v| !v.is_null()) {
            st.insert("bullOff".into(), json!(false));
        }
        self.last_match_state = Some(match (&self.last_match_state, same) {
            (Some(prev), true) => {
                let mut m = prev.clone();
                for (k, v) in st {
                    m.insert(k, v);
                }
                m
            }
            _ => st,
        });
        self.last_match_state_at = now();
    }

    pub fn begin_bull_off_view(&mut self, match_id: Value, mode: &str, lobby: Option<Obj>) {
        if self.bull_off.as_ref().map_or(true, |b| b.get("match_id") != Some(&match_id)) {
            self.bull_off = Some(crate::obj! {"match_id" => match_id, "mode" => mode, "lobby" => lobby, "state" => {}, "rounds" => {}});
        }
    }

    fn remember_bull_off(&mut self, state: &Obj) {
        let mid = state.get("id").cloned().unwrap_or(Value::Null);
        let need_new = match &self.bull_off {
            None => true,
            Some(b) => truthy(&mid) && !b.get("match_id").map_or(true, |m| m.is_null() || *m == mid),
        };
        if need_new {
            self.bull_off = Some(crate::obj! {"match_id" => mid.clone(), "mode" => "", "lobby" => Value::Null, "state" => {}, "rounds" => {}});
        }
        let bo = self.bull_off.as_mut().unwrap();
        let mut merged = obj_or_empty(bo.get("state"));
        for (k, v) in state {
            merged.insert(k.clone(), v.clone());
        }
        bo.insert("state".into(), Value::Object(merged.clone()));
        if !bo.get("match_id").map_or(false, truthy) {
            bo.insert("match_id".into(), mid);
        }
        if let Some(Value::Object(s)) = merged.get("settings") {
            if let Some(m) = non_empty(s.get("mode")) {
                bo.insert("mode".into(), json!(py_str(m)));
            }
        }
        let rnd = as_int(merged.get("round")).unwrap_or(1);
        let mut rounds = obj_or_empty(bo.get("rounds"));
        let key = rnd.to_string();
        let mut entry = rounds.get(&key).and_then(Value::as_object).cloned().unwrap_or_else(|| crate::obj! {"stats" => Value::Null, "throws" => {}});
        if let Some(Value::Array(s)) = state.get("stats") {
            entry.insert("stats".into(), Value::Array(s.clone()));
        }
        let players = arr(merged.get("players"));
        let ids: Vec<Value> = players.iter().map(|p| p.get("id").cloned().unwrap_or(Value::Null)).collect();
        let mut throws_map = obj_or_empty(entry.get("throws"));
        for turn in arr(state.get("turns")) {
            let Some(t) = turn.as_object() else { continue };
            let tr = t.get("round");
            if !(tr.map_or(true, Value::is_null) || as_int(tr) == Some(rnd)) {
                continue;
            }
            let throws: Vec<&Value> = arr(t.get("throws")).iter().filter(|x| x.is_object()).collect();
            if let (Some(last), Some(pid)) = (throws.last(), t.get("playerId")) {
                if let Some(i) = ids.iter().position(|x| x == pid) {
                    throws_map.insert(i.to_string(), (*last).clone());
                }
            }
        }
        entry.insert("throws".into(), Value::Object(throws_map));
        rounds.insert(key, Value::Object(entry));
        bo.insert("rounds".into(), Value::Object(rounds));
    }

    /// The bull-off while it runs or shows its result, until the first leg begins
    pub fn bull_off_view(&self) -> Option<&Obj> {
        let bo = self.bull_off.as_ref()?;
        if let Some(st) = &self.last_match_state {
            let id = st.get("id").cloned().unwrap_or(Value::Null);
            if !id.is_null() && Some(&id) != bo.get("match_id") {
                return None;
            }
        }
        if self.bull_off_phase.is_some() || self.last_match_state.as_ref().map_or(false, |s| s.get("bullOff") == Some(&Value::Bool(true))) {
            return Some(bo);
        }
        None
    }

    fn is_aborted(state: &Obj, status: &str) -> bool {
        ["aborted", "abort", "cancelled", "canceled", "cancel", "deleted", "delete", "stopped"].contains(&status)
            || ["aborted", "isAborted", "cancelled", "canceled"].iter().any(|k| state.get(*k) == Some(&Value::Bool(true)))
    }

    fn explicit_winner(&self, state: &Obj) -> Option<Value> {
        let mut raw = state.get("winner").cloned().filter(|v| !v.is_null());
        if raw.is_none() {
            if let Some(Value::Object(m)) = state.get("match") {
                raw = m.get("winner").cloned().filter(|v| !v.is_null());
            }
        }
        let n = self.current_players.len() as i64;
        if state.get("gameFinished") == Some(&Value::Bool(true)) {
            if let Some(g) = as_int(state.get("gameWinner")).filter(|g| *g >= 0 && *g < n) {
                raw = Some(json!(g));
            }
        }
        match &raw {
            Some(Value::Number(_)) if as_int(raw.as_ref()).map_or(false, |i| i >= 0 && i < n) => raw,
            Some(Value::String(s)) if !NO_NAME.contains(&s.trim().to_lowercase().as_str()) => raw,
            Some(Value::Object(o)) if ["name", "username", "displayName"].iter().any(|k| o.get(*k).map_or(false, truthy)) => raw,
            _ => None,
        }
    }

    pub fn parse_match_state(&mut self, state: &Obj) {
        self.remember_match_state(state);
        let status = state.get("status").map(py_str).unwrap_or_default().to_lowercase();
        if Self::is_aborted(state, &status) {
            info!("Match {:?} state reported aborted/cancelled (status: {}) -> emitting GAME_IDLE", self.match_id, status);
            let b = self.board();
            self.end_match(b, Some("idle"), true);
            return;
        }
        self.extract_and_set_players(&Value::Object(state.clone()));
        let variant = state.get("variant").filter(|v| truthy(v)).map(py_str);
        let is_bull_off = variant.as_deref() == Some(BULL_OFF_VARIANT);
        if is_bull_off {
            self.track_bull_off_round(state);
        } else if variant.is_some() && self.bull_off_phase.is_some() && !self.last_match_finished {
            self.bull_off_phase = None;
            info!("Bull-off over, first leg begins ({}) -> emitting GAME_START", variant.unwrap_or_default());
            let e = self.ev(DartEventType::GameStart);
            self.emit(e);
        }
        let turns: Vec<Value> = state.get("turns").and_then(Value::as_array).cloned().unwrap_or_default();
        self.check_turn_change(&turns);
        self.check_new_throw(&turns);
        if is_bull_off {
            self.check_bull_off_winner(state);
            return;
        }
        self.check_match_result(state, &status);
        self.check_turn_over(&turns);
    }

    fn check_turn_change(&mut self, turns: &[Value]) {
        let key = match turns.last() {
            Some(t) => {
                let raw = non_empty(t.get("id")).map(py_str).unwrap_or_else(|| format!("turn_{}", turns.len()));
                format!("{}_p{}", raw, self.active_player_idx)
            }
            None => format!("turn_0_p{}", self.active_player_idx),
        };
        if self.last_match_finished || Some(&key) == self.last_turn_id.as_ref() {
            return;
        }
        self.last_180_fired = false;
        self.last_bust_fired = false;
        self.in_leg_break = false;
        let pn = self.current_player();
        info!("Active player turn transition detected (turn_key='{}', player_idx={}, name='{}') -> dispatching THROW", key, self.active_player_idx, pn.clone().unwrap_or_else(|| "None".into()));
        let b = self.board();
        self.emit_player(DartEventType::Throw, pn, b);
        self.last_turn_id = Some(key);
    }

    fn check_new_throw(&mut self, turns: &[Value]) {
        let Some(last_turn) = turns.last().and_then(Value::as_object) else { return };
        let turn_id = last_turn.get("id").map(py_str).unwrap_or_else(|| format!("turn_{}", turns.len()));
        let throws = arr(last_turn.get("throws")).to_vec();
        let Some(last_throw) = throws.last().and_then(Value::as_object) else { return };
        let throw_id = last_throw.get("id").map(py_str).unwrap_or_else(|| format!("{}_{}", turn_id, throws.len()));
        if Some(&throw_id) == self.last_throw_id.as_ref() {
            return;
        }
        self.last_throw_id = Some(throw_id.clone());
        self.in_leg_break = false;
        let (score, mult, label) = read_throw(last_throw);
        self.emit_throw_events(last_turn, last_throw, throws.len(), &throw_id, score, mult, &label);
    }

    #[allow(clippy::too_many_arguments)]
    fn emit_throw_events(&mut self, last_turn: &Obj, last_throw: &Obj, n_throws: usize, throw_id: &str, score: i64, mult: i64, label: &str) {
        let tp = last_turn.get("points").cloned().unwrap_or(json!(0));
        let visit_total = if n_throws == 3 { as_int(Some(&tp)) } else { None };
        let is_true = |o: &Obj, k: &str| o.get(k) == Some(&Value::Bool(true));
        let lab = |d: &str| if label.is_empty() { d.to_string() } else { label.to_string() };
        if n_throws == 3 && as_num(Some(&tp)) == Some(180.0) && !self.last_180_fired {
            self.last_180_fired = true;
            let mut e = self.ev(DartEventType::Score180);
            e.score = 180;
            e.segment_name = Some("180".into());
            self.emit(e);
        } else if is_true(last_turn, "busted") || is_true(last_throw, "busted") || is_true(last_turn, "bust") || is_true(last_throw, "bust") {
            if !self.last_bust_fired {
                self.last_bust_fired = true;
                info!("Bust detected on throw {} (Turn busted)", throw_id);
                let mut e = self.ev(DartEventType::Bust);
                e.score = score;
                e.segment_name = Some(lab("Bust"));
                self.emit(e);
            }
        } else if (score == 0 && mult == 0) || ["miss", "outside", "off", "none"].contains(&label.to_lowercase().as_str()) {
            info!("Miss detected on throw {} (Score: {}, Multiplier: {}, Segment: {})", throw_id, score, mult, lab("Miss"));
            let mut e = self.ev(DartEventType::Bust);
            e.multiplier = 0;
            e.segment_number = Some(0);
            e.segment_name = Some(lab("Miss"));
            self.emit(e);
        } else {
            let (t, sc, m, sn) = if mult == 3 {
                info!("Triple hit detected on throw {}: {} (Multiplier: 3)", throw_id, label);
                (DartEventType::Triple, score * 3, 3, score)
            } else if (mult == 2 && score == 25) || label == "Bull" || label == "50" {
                info!("Bullseye hit detected on throw {}: Bull (50)", throw_id);
                (DartEventType::Bullseye, 50, 2, 25)
            } else if mult == 2 {
                info!("Double hit detected on throw {}: {} (Multiplier: 2)", throw_id, label);
                (DartEventType::Double, score * 2, 2, score)
            } else if mult == 1 {
                info!("Single hit detected on throw {}: {} (Multiplier: 1)", throw_id, label);
                (DartEventType::Single, score, 1, score)
            } else {
                return;
            };
            let mut e = self.ev(t);
            e.score = sc;
            e.multiplier = m;
            e.segment_number = Some(sn);
            e.segment_name = Some(label.to_string());
            e.round_score = visit_total;
            self.emit(e);
        }
    }

    fn check_match_result(&mut self, state: &Obj, status: &str) {
        let (total, has_info, counts) = count_legs(state);
        let ltw = legs_to_win(state);
        let winning = ltw.and_then(|l| counts.iter().position(|c| *c > 0 && *c >= l));
        let raw_winner = self.explicit_winner(state);
        let t = |k: &str| state.get(k) == Some(&Value::Bool(true));
        let finished = t("finished")
            || t("isFinished")
            || ["finished", "ended", "completed", "won"].contains(&status)
            || matches!(state.get("match"), Some(Value::Object(m)) if m.get("finished") == Some(&Value::Bool(true)))
            || (raw_winner.is_some() && state.get("finished") != Some(&Value::Bool(false)))
            || winning.is_some();
        if finished && !self.last_match_finished {
            self.last_match_finished = true;
            self.in_leg_break = true;
            self.last_total_legs_won = Some(total);
            let w = raw_winner.or_else(|| winning.map(|i| json!(i)));
            self.emit_match_won(w);
        } else if has_info && !self.last_match_finished {
            match self.last_total_legs_won {
                None => self.last_total_legs_won = Some(total),
                Some(prev) if total > prev => {
                    self.last_total_legs_won = Some(total);
                    match as_int(state.get("gameWinner")).filter(|g| *g >= 0 && (*g as usize) < self.current_players.len()) {
                        Some(g) => {
                            let n = self.current_players[g as usize].clone();
                            self.emit_leg_won(Some(json!(n)), Some(g));
                        }
                        None => self.emit_leg_won(None, None),
                    }
                }
                _ => {}
            }
        }
    }

    fn check_turn_over(&mut self, turns: &[Value]) {
        if self.in_leg_break || self.last_match_finished {
            return;
        }
        let Some(last) = turns.last().and_then(Value::as_object) else { return };
        let n = arr(last.get("throws")).len();
        let over = n >= 3 || last.get("busted") == Some(&Value::Bool(true)) || last.get("bust") == Some(&Value::Bool(true));
        if over && !matches!(self.last_flow_state.as_deref(), Some("takeout") | Some("takeout_in_progress")) {
            self.last_flow_state = Some("takeout".into());
            let pn = self.current_player();
            info!("Turn {:?} completed ({} darts) -> transitioning to TAKEOUT", self.last_turn_id, n);
            let b = self.board();
            self.emit_player(DartEventType::Takeout, pn, b);
        }
    }

    /// The match opens with a bull-off: play its animation now; Game Started follows with the first leg
    pub fn start_bull_off(&mut self) {
        if self.bull_off_phase.is_some() {
            return;
        }
        self.bull_off_phase = Some("running".into());
        self.bull_off_round = 1;
        info!("Bull-off started -> emitting BULL_OFF_START");
        let e = self.ev(DartEventType::BullOffStart);
        self.emit(e);
    }

    fn track_bull_off_round(&mut self, state: &Obj) {
        let rnd = as_int(state.get("round")).unwrap_or(1);
        if self.bull_off_phase.is_none() {
            self.start_bull_off();
            self.bull_off_round = rnd;
        } else if rnd > self.bull_off_round {
            self.bull_off_round = rnd;
            self.bull_off_phase = Some("running".into());
            self.in_leg_break = false;
            info!("Bull-off tie -> round {}, emitting BULL_OFF_START again", rnd);
            let e = self.ev(DartEventType::BullOffStart);
            self.emit(e);
        }
    }

    fn check_bull_off_winner(&mut self, state: &Obj) {
        if self.bull_off_phase.as_deref() != Some("running") || state.get("gameFinished") != Some(&Value::Bool(true)) {
            return;
        }
        let Some(w) = as_int(state.get("gameWinner")).filter(|w| *w >= 0) else { return };
        self.bull_off_phase = Some("decided".into());
        self.in_leg_break = true;
        let name = self.current_players.get(w as usize).cloned();
        info!("Bull-off won by {} -> emitting BULL_OFF_WON", name.clone().unwrap_or_else(|| format!("player {}", w + 1)));
        let mut e = self.ev(DartEventType::BullOffWon);
        e.player_name = name;
        e.player_index = Some(w);
        self.emit(e);
    }

    fn name_of(&self, v: Option<&Value>, dict_keys: &[&str]) -> Option<String> {
        match v {
            Some(Value::String(s)) if !NO_NAME.contains(&s.trim().to_lowercase().as_str()) => Some(s.trim().to_string()),
            Some(n @ Value::Number(_)) => as_int(Some(n)).filter(|i| *i >= 0 && (*i as usize) < self.current_players.len()).map(|i| self.current_players[i as usize].clone()),
            Some(Value::Object(o)) => dict_keys.iter().find_map(|k| non_empty(o.get(*k))).map(py_str),
            _ => None,
        }
    }

    fn emit_leg_won(&mut self, player: Option<Value>, player_idx: Option<i64>) {
        if self.last_match_finished {
            return;
        }
        let t = now();
        if t - self.last_leg_won_time < 2.0 {
            return;
        }
        self.last_leg_won_time = t;
        self.in_leg_break = true;
        let mut name = self.name_of(player.as_ref(), &["name", "username"]).filter(|n| !n.is_empty());
        if name.is_none() {
            let idx = player_idx.unwrap_or(self.active_player_idx);
            name = self.current_players.get(idx.max(0) as usize).cloned().filter(|_| idx >= 0);
        }
        let idx = player_idx.unwrap_or(self.active_player_idx);
        info!("Emitting LEG_WON event on board {} (Winner: {})", self.board_id, name.clone().unwrap_or_else(|| "None".into()));
        let mut e = self.ev(DartEventType::LegWon);
        e.player_name = name;
        e.player_index = Some(idx);
        self.emit(e);
    }

    fn emit_match_won(&mut self, winner: Option<Value>) {
        let t = now();
        if t - self.last_match_won_time < 2.0 {
            return;
        }
        self.last_match_won_time = t;
        self.last_match_finished = true;
        self.in_leg_break = true;
        let mut name = self.name_of(winner.as_ref(), &["name", "username", "displayName"]).filter(|n| !n.is_empty());
        if name.is_none() && self.active_player_idx >= 0 {
            name = self.current_players.get(self.active_player_idx as usize).cloned();
        }
        info!("Emitting MATCH_WON event on board {} (Winner: {})", self.board_id, name.clone().unwrap_or_else(|| "None".into()));
        let mut e = self.ev(DartEventType::MatchWon);
        e.player_name = name;
        self.emit(e);
    }

    // --- Bridge-specific -----------------------------------------------------------------------

    fn choose_primary(&self) -> Option<u64> {
        let attached: Vec<u64> = self.sources.iter().copied().filter(|s| self.source_state.get(s).map_or(false, |st| st.attached)).collect();
        let gp = re(&GAME_PAGE_RE, r"/(?:matches|lobby|lobbies)/[^/?#]+");
        let playing: Vec<u64> = attached.iter().copied().filter(|s| self.source_state.get(s).map_or(false, |st| gp.is_match(&st.url))).collect();
        for group in [&playing, &attached] {
            if let Some(p) = self.primary {
                if group.contains(&p) {
                    return Some(p);
                }
            }
            if let Some(g) = group.first() {
                return Some(*g);
            }
        }
        self.sources.first().copied()
    }

    fn update_primary(&mut self) {
        let p = self.choose_primary();
        let switched = p != self.primary && p.is_some();
        if switched && self.sources.len() > 1 {
            let url = p.and_then(|p| self.source_state.get(&p)).map(|s| s.url.clone()).filter(|u| !u.is_empty()).unwrap_or_else(|| "(none)".into());
            info!("Using the AutoGlow Bridge connection with the Autodarts tab {}", url);
        }
        self.primary = p;
        let st = p.and_then(|p| self.source_state.get(&p)).cloned().unwrap_or_default();
        self.extension_version = st.version.clone();
        self.tab_attached = st.attached;
        self.tab_url = if st.attached { st.url.clone() } else { String::new() };
        if switched && !st.snapshots.is_empty() {
            self.replay_for = p;
        }
    }

    fn keep_snapshot(&mut self, source: u64, message: &Obj) {
        let Some(state) = self.source_state.get_mut(&source) else { return };
        let snaps = &mut state.snapshots;
        let put = |snaps: &mut Vec<(String, Value)>, key: String, msg: &Obj| {
            snaps.retain(|(k, _)| *k != key);
            snaps.push((key, Value::Object(msg.clone())));
        };
        if message.get("type").and_then(Value::as_str) == Some("http") {
            let url = message.get("url").map(py_str).unwrap_or_default();
            let key = format!("http:{}", url.split('?').next().unwrap_or(""));
            put(snaps, key, message);
            while snaps.iter().filter(|(k, _)| k.starts_with("http:")).count() > MAX_HTTP_SNAPSHOTS {
                if let Some(i) = snaps.iter().position(|(k, _)| k.starts_with("http:")) {
                    snaps.remove(i);
                }
            }
            return;
        }
        let Some(relayed) = message.get("message").and_then(Value::as_object) else { return };
        let channel = relayed.get("channel").and_then(Value::as_str).unwrap_or("");
        let topic = relayed.get("topic").map(py_str).unwrap_or_default();
        if channel == LOBBY_CHANNEL {
            put(snaps, "lobby".into(), message);
        } else if channel == "autodarts.matches" && topic.ends_with(".state") {
            put(snaps, "match".into(), message);
        }
    }

    fn replay_snapshots(&mut self, source: u64) {
        let mut snaps = self.source_state.get(&source).map(|s| s.snapshots.clone()).unwrap_or_default();
        snaps.sort_by(|a, b| (a.0 != "lobby", a.0.clone()).cmp(&(b.0 != "lobby", b.0.clone())));
        for (key, msg) in snaps {
            if self.primary != Some(source) {
                return;
            }
            if msg.get("type").and_then(Value::as_str) == Some("http") {
                let url = msg.get("url").map(py_str).unwrap_or_default();
                self.ingest_http(&url, msg.get("body"));
                continue;
            }
            let Some(relayed) = msg.get("message").and_then(Value::as_object) else { continue };
            if key == "lobby" {
                let topic = relayed.get("topic").map(py_str).unwrap_or_default();
                self.ingest_lobby(&topic, relayed.get("data"));
            } else if let Some(d) = relayed.get("data").and_then(Value::as_object) {
                self.remember_snapshot(d);
            }
        }
    }

    /// A lobby update; returns the lobby when this update started its match
    fn ingest_lobby(&mut self, topic: &str, data: Option<&Value>) -> Option<Obj> {
        let topic_id = topic.split('.').next().unwrap_or("").to_string();
        let d = data?.as_object()?;
        let event = non_empty(d.get("event")).map(py_str).unwrap_or_default().to_lowercase();
        if LOBBY_END_EVENTS.contains(&event.as_str()) {
            let ended = self.lobby.clone();
            if let Some(e) = &ended {
                let eid = e.get("id").cloned().unwrap_or(Value::Null);
                if eid == json!(topic_id) || Some(&eid) == d.get("id") {
                    info!("Autodarts lobby {} ended ({})", py_str(&eid), event);
                    self.lobby = None;
                    if LOBBY_START_EVENTS.contains(&event.as_str()) {
                        return ended;
                    }
                }
            }
            return None;
        }
        if topic.ends_with(".state") || d.get("players").map_or(false, Value::is_array) {
            let mut lobby = d.clone();
            lobby.entry("id").or_insert(json!(topic_id));
            if !lobby.get("id").map_or(false, truthy) {
                return None;
            }
            if self.lobby.as_ref().map_or(true, |l| l.get("id") != lobby.get("id")) {
                info!("Autodarts lobby {} seen (tab: {})", py_str(&lobby["id"]), if self.tab_url.is_empty() { "unknown" } else { &self.tab_url });
            }
            self.lobby = Some(lobby);
        }
        None
    }

    /// A started lobby becomes the match (same id). With a bull-off, its animation starts now.
    fn lobby_started(&mut self, lobby: &Obj) {
        let mode = non_empty(lobby.get("bullOffMode")).map(py_str).unwrap_or_default();
        let mid = non_empty(lobby.get("id")).map(py_str);
        if let Some(m) = &mid {
            if self.match_id.is_some() && self.match_id.as_ref() != Some(m) {
                let r = format!("Lobby {} started the next match -> leaving match {}", m, self.match_id.clone().unwrap());
                self.leave_match(&r);
            }
        }
        if mid != self.paused_match_id {
            self.paused_match_id = None;
        }
        let Some(m) = mid else { return };
        if mode.is_empty() || mode.to_lowercase() == "off" {
            return;
        }
        if self.match_id.as_ref() != Some(&m) {
            self.set_match(Some(m.clone()));
            self.reset_match_state();
        }
        info!("Match {} started from the lobby with a {} bull-off", m, mode);
        self.begin_bull_off_view(json!(m), &mode, Some(lobby.clone()));
        self.start_bull_off();
    }

    /// The lobby the Autodarts tab shows right now, if any
    pub fn open_lobby(&self) -> Option<&Obj> {
        let l = self.lobby.as_ref()?;
        if !self.tab_attached {
            return None;
        }
        let id = regex::escape(&l.get("id").map(py_str).unwrap_or_default());
        let r = Regex::new(&format!(r"/lobb(?:y|ies)/{}(?:[/?#]|$)", id)).ok()?;
        if !r.is_match(&self.tab_url) {
            return None;
        }
        Some(l)
    }

    pub fn last_lobby_state(&self) -> Option<&Obj> {
        self.lobby.as_ref()
    }

    fn ingest_http(&mut self, url: &str, body: Option<&Value>) {
        let path = url.split('?').next().unwrap_or("");
        if let Some(c) = re(&LOBBY_ITEM_RE, r"/gs/v\d+/lobbies/([^/?#]+)/?$").captures(path) {
            if let Some(Value::Object(b)) = body {
                let id = non_empty(b.get("id")).map(py_str).unwrap_or_else(|| c[1].to_string());
                self.ingest_lobby(&format!("{}.state", id), body);
                return;
            }
        }
        if re(&BOARDS_LIST_RE, r"/bs/v\d+/boards/?$").is_match(path) {
            if let Some(Value::Array(l)) = body {
                self.boards_cache = l.iter().filter(|b| b.is_object()).cloned().collect();
                self.own_board_ids = self.boards_cache.iter().filter_map(|b| non_empty(b.get("id")).map(py_str)).collect();
                return;
            }
        }
        if re(&BOARD_ITEM_RE, r"/bs/v\d+/boards/([^/?#]+)/?$").is_match(path) {
            if let Some(Value::Object(b)) = body {
                if let Some(id) = non_empty(b.get("id")).cloned() {
                    self.boards_cache.retain(|x| x.get("id") != Some(&id));
                    self.boards_cache.push(Value::Object(b.clone()));
                    return;
                }
            }
        }
        if let Some(c) = re(&MATCH_ITEM_RE, r"/(?:gs|as)/v\d+/matches/([^/?#]+)/?$").captures(path) {
            if let Some(Value::Object(b)) = body {
                let mid = non_empty(b.get("id")).map(py_str).unwrap_or_else(|| c[1].to_string());
                self.match_cache.retain(|(k, _)| *k != mid);
                self.match_cache.push((mid.clone(), Value::Object(b.clone())));
                while self.match_cache.len() > MATCH_CACHE_LIMIT {
                    self.match_cache.remove(0);
                }
                if Some(&mid) == self.match_id.as_ref() {
                    self.extract_and_set_players(&Value::Object(b.clone()));
                }
                self.remember_snapshot(b);
            }
        }
    }

    /// Show a match state in the Studio without running it through the lighting events
    fn remember_snapshot(&mut self, state: &Obj) {
        let Some(id) = non_empty(state.get("id")).map(py_str) else { return };
        if Some(&id) == self.match_id.as_ref() || (self.match_id.is_none() && !is_match_over(state)) {
            self.remember_match_state(state);
        }
    }

    /// Board phase from Autodarts: throw, takeout_in_progress, takeout, takeout_finished, idle
    pub fn last_flow_state_str(&self) -> String {
        self.last_flow_state.clone().unwrap_or_default()
    }

    /// The running match is decided (it keeps its id until the board goes idle)
    pub fn match_finished(&self) -> bool {
        self.last_match_finished
    }

    pub fn last_throw_id(&self) -> Option<String> {
        self.last_throw_id.clone()
    }

    pub fn boards(&self) -> Vec<Value> {
        self.boards_cache.clone()
    }

    pub fn snapshot(&self) -> Value {
        json!({
            "extension_connected": self.is_connected, "extension_version": self.extension_version,
            "tab_attached": self.tab_attached, "tab_url": self.tab_url, "lobby_open": self.open_lobby().is_some(),
        })
    }
}

pub type EventSink = Arc<dyn Fn(DartEvent) -> BoxFuture<'static, ()> + Send + Sync>;

/// The bridge: extension connections in, DartEvents out
pub struct AutodartsBridge {
    pub st: Mutex<BridgeState>,
    dispatch: tokio::sync::Mutex<()>,
    sink: Mutex<Option<EventSink>>,
    next_source: std::sync::atomic::AtomicU64,
}

impl AutodartsBridge {
    pub fn new(board_id: &str) -> Arc<AutodartsBridge> {
        let st = BridgeState { board_id: board_id.into(), ..Default::default() };
        Arc::new(AutodartsBridge { st: Mutex::new(st), dispatch: tokio::sync::Mutex::new(()), sink: Mutex::new(None), next_source: 1.into() })
    }

    pub fn set_sink(&self, s: EventSink) {
        *self.sink.lock().unwrap() = Some(s);
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, BridgeState> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn active_match_id(&self) -> Option<String> {
        self.lock().match_id.clone()
    }

    pub fn current_players(&self) -> Vec<String> {
        self.lock().current_players.clone()
    }

    pub fn active_player_idx(&self) -> i64 {
        self.lock().active_player_idx
    }

    /// Hand the collected events to the engine, in order
    async fn flush(self: &Arc<Self>) {
        loop {
            let (events, replay) = {
                let mut s = self.lock();
                (std::mem::take(&mut s.pending), s.replay_for.take())
            };
            if let Some(src) = replay {
                self.lock().replay_snapshots(src);
                continue;
            }
            if events.is_empty() {
                return;
            }
            let sink = self.sink.lock().unwrap().clone();
            if let Some(sink) = sink {
                for e in events {
                    sink(e).await;
                }
            }
        }
    }

    pub async fn run<F: FnOnce(&mut BridgeState)>(self: &Arc<Self>, f: F) {
        let _g = self.dispatch.lock().await;
        f(&mut self.lock());
        self.flush().await;
    }

    /// Register an extension connection. Only one (the primary) is used, so two browsers never double-fire.
    pub async fn attach(self: &Arc<Self>) -> u64 {
        let id = self.next_source.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.run(|s| {
            s.sources.push(id);
            s.source_state.insert(id, SourceState::default());
            s.is_connected = true;
            s.update_primary();
            info!("AutoGlow Chrome extension connected ({} active connection(s))", s.sources.len());
        })
        .await;
        id
    }

    pub async fn detach(self: &Arc<Self>, id: u64) {
        self.run(|s| {
            s.sources.retain(|x| *x != id);
            s.source_state.remove(&id);
            s.update_primary();
            s.is_connected = !s.sources.is_empty();
            info!("AutoGlow Chrome extension disconnected ({} active connection(s))", s.sources.len());
        })
        .await;
        self.check_source_lost();
    }

    pub fn is_primary(&self, id: u64) -> bool {
        self.lock().primary == Some(id)
    }

    /// Process one message from an extension connection; returns a reply to send back, if any
    pub async fn ingest(self: &Arc<Self>, source: u64, message: &Value) -> Option<Value> {
        let m = message.as_object()?;
        let t = m.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if t == "ping" {
            return Some(json!({"type": "pong", "ts": now()}));
        }
        let mut check_lost = false;
        self.run(|s| {
            if let Some(st) = s.source_state.get_mut(&source) {
                if t == "hello" {
                    st.version = m.get("version").map(py_str).unwrap_or_default().chars().take(32).collect();
                } else if t == "tab" {
                    st.attached = m.get("attached").map_or(false, truthy);
                    st.url = if st.attached { m.get("url").map(py_str).unwrap_or_default().chars().take(300).collect() } else { String::new() };
                }
            }
            if t == "hello" || t == "tab" {
                s.update_primary();
            }
            if t == "ws" || t == "http" {
                s.keep_snapshot(source, m);
            }
            if s.primary != Some(source) {
                return;
            }
            match t.as_str() {
                "hello" => info!("Extension handshake: AutoGlow Bridge v{}", s.extension_version),
                "tab" => check_lost = true,
                "ws" => {
                    let Some(relayed) = m.get("message").and_then(Value::as_object) else { return };
                    let ch = relayed.get("channel").and_then(Value::as_str).unwrap_or("");
                    if !RELAYED_CHANNELS.contains(&ch) {
                        return;
                    }
                    let replay = m.get("replay").map_or(false, truthy);
                    let topic = relayed.get("topic").map(py_str).unwrap_or_default();
                    if ch == LOBBY_CHANNEL {
                        if let Some(started) = s.ingest_lobby(&topic, relayed.get("data")) {
                            if !replay {
                                s.lobby_started(&started);
                            }
                        }
                        return;
                    }
                    if replay {
                        if ch == "autodarts.matches" && topic.ends_with(".state") {
                            if let Some(d) = relayed.get("data").and_then(Value::as_object) {
                                s.remember_snapshot(d);
                            }
                        }
                    } else {
                        s.handle_raw_message(relayed);
                    }
                }
                "http" => {
                    let url = m.get("url").map(py_str).unwrap_or_default();
                    s.ingest_http(&url, m.get("body"));
                }
                _ => {}
            }
        })
        .await;
        if check_lost {
            self.check_source_lost();
        }
        None
    }

    /// Start the grace timer that ends a running match when no Autodarts tab relays it any more
    fn check_source_lost(self: &Arc<Self>) {
        {
            let mut s = self.lock();
            let receiving = !s.sources.is_empty() && s.tab_attached;
            if receiving || s.match_id.is_none() || s.source_lost_pending {
                return;
            }
            s.source_lost_pending = true;
        }
        let me = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs_f64(SOURCE_LOST_GRACE_SECONDS)).await;
            me.run(|s| {
                s.source_lost_pending = false;
                if (!s.sources.is_empty() && s.tab_attached) || s.match_id.is_none() {
                    return;
                }
                info!("No Autodarts tab for {:.0}s -> pausing match {} and emitting GAME_IDLE", SOURCE_LOST_GRACE_SECONDS, s.match_id.clone().unwrap_or_default());
                let b = s.board();
                s.end_match(b, None, false);
            })
            .await;
        });
    }
}
