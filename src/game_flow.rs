//! Game flow model and storage (Flow Matrix).
//!
//! A flow profile describes how the light strips follow a match:
//!     Waiting -> Bull-off -> Game starts -> [Player's turn <-> Pulling darts] -> Leg won -> ... -> Match won -> Waiting
//! - Steps: an on/off switch, a look (one of the curated Flow Matrix effects) and the transition it comes in
//!   with. A step that is off is skipped: the next step simply comes in with its own transition.
//! - Hits (1x, 180, Bull ...) play on top of the current look and fade back into it.
//! - Players: up to six colours; a colour can be tied to a player name.
//! - Waiting (idle): one effect from the controller's own WLED library, written into its idle preset.
//!
//! game_flows.json holds named profiles and which controller / segment uses which profile.

use crate::flow_catalog::{normalize_transition_style, to_flow_effect};
use crate::models::{EffectConfig, RGBColor};
use crate::py::*;
use crate::storage::{project_root, write_atomic};
use log::{error, info, warn};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const FILE_VERSION: i64 = 2;
pub const STEP_IDS: [&str; 6] = ["bull_off", "game_start", "turn", "takeout", "leg_won", "match_won"];
pub const TIMED_STEPS: [&str; 3] = ["game_start", "leg_won", "match_won"];
pub const ALWAYS_ON_STEPS: [&str; 1] = ["turn"];
pub const HIT_IDS: [&str; 9] = ["single", "double", "triple", "bullseye", "miss", "bust", "ton", "ton40", "180"];
pub const MAX_PLAYERS: usize = 6;
pub const PLAYER_COLOURS: [(i64, i64, i64); 6] = [(0, 110, 255), (255, 120, 0), (220, 0, 200), (0, 220, 170), (255, 215, 0), (235, 235, 235)];
pub const DEFAULT_PROFILE_NAME: &str = "Classic";

pub fn step_label(id: &str) -> &'static str {
    match id {
        "bull_off" => "Bull-off",
        "game_start" => "Game starts",
        "turn" => "Player's turn",
        "takeout" => "Pulling darts",
        "leg_won" => "Leg won",
        "match_won" => "Match won",
        _ => "",
    }
}

pub fn hit_label(id: &str) -> &'static str {
    match id {
        "single" => "Single",
        "double" => "Double",
        "triple" => "Triple",
        "bullseye" => "Bull",
        "miss" => "Miss",
        "bust" => "Bust",
        "ton" => "Ton (100+)",
        "ton40" => "Ton-40 (140+)",
        "180" => "180",
        _ => "",
    }
}

/// Python round(x, 3)
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// How a step comes in
#[derive(Clone, Debug, PartialEq)]
pub struct FlowTransition {
    pub style: String,
    pub duration: f64,
    pub accent_color: Option<RGBColor>,
}

impl FlowTransition {
    pub fn new(style: &str, duration: f64, accent: Option<RGBColor>) -> FlowTransition {
        let style = normalize_transition_style(Some(&json!(style)));
        let duration = if style == "instant" { 0.0 } else { duration.max(0.0).min(5.0) };
        FlowTransition { style, duration, accent_color: accent }
    }

    pub fn to_value(&self) -> Value {
        let mut o = crate::obj! {"style" => self.style, "duration" => round3(self.duration)};
        if let Some(a) = self.accent_color {
            o.insert("accent_color".into(), a.to_list());
        }
        Value::Object(o)
    }

    pub fn from_value(d: Option<&Value>) -> FlowTransition {
        let Some(d) = d.and_then(Value::as_object) else { return FlowTransition::new("crossfade", 0.6, None) };
        let acc = non_empty(d.get("accent_color")).map(|a| RGBColor::from_value(Some(a), RGBColor::WHITE));
        FlowTransition::new(&get_str(d, "style", "crossfade"), safe_float(d.get("duration"), 0.6), acc)
    }
}

impl Default for FlowTransition {
    fn default() -> Self {
        FlowTransition::new("crossfade", 0.6, None)
    }
}

/// What a strip shows between games: a WLED effect with its settings
#[derive(Clone, Debug, PartialEq)]
pub struct FlowIdle {
    pub on: bool,
    pub fx: i64,
    pub speed: i64,
    pub intensity: i64,
    pub brightness: i64,
    pub colors: Vec<RGBColor>,
}

impl Default for FlowIdle {
    fn default() -> Self {
        FlowIdle { on: true, fx: 9, speed: 128, intensity: 128, brightness: 100, colors: vec![RGBColor::new(0, 255, 157), RGBColor::BLACK, RGBColor::BLACK] }
    }
}

fn num_clamp(v: Option<&Value>, lo: i64, hi: i64, d: i64) -> i64 {
    match v {
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(d as f64);
            clamp(f.trunc() as i64, lo, hi)
        }
        _ => d,
    }
}

impl FlowIdle {
    pub fn to_value(&self) -> Value {
        json!({"on": self.on, "fx": self.fx, "speed": self.speed, "intensity": self.intensity, "brightness": self.brightness,
               "colors": self.colors.iter().map(|c| c.to_list()).collect::<Vec<_>>()})
    }

    pub fn from_value(d: Option<&Value>) -> FlowIdle {
        let base = FlowIdle::default();
        let Some(d) = d.and_then(Value::as_object) else { return base };
        let raw = arr(d.get("colors"));
        FlowIdle {
            on: get_bool(d, "on", true),
            fx: num_clamp(Some(d.get("fx").unwrap_or(&json!(base.fx))), 0, 255, 9),
            speed: num_clamp(Some(d.get("speed").unwrap_or(&json!(base.speed))), 0, 255, 128),
            intensity: num_clamp(Some(d.get("intensity").unwrap_or(&json!(base.intensity))), 0, 255, 128),
            brightness: num_clamp(Some(d.get("brightness").unwrap_or(&json!(base.brightness))), 0, 100, 100),
            colors: (0..3).map(|i| if i < raw.len() { RGBColor::from_value(raw.get(i), base.colors[i]) } else { base.colors[i] }).collect(),
        }
    }

    /// The look as WLED segment fields (merged into a preset segment)
    pub fn wled_segment(&self) -> Obj {
        crate::obj! {
            "on" => self.on, "bri" => py_round(self.brightness as f64 / 100.0 * 255.0), "fx" => self.fx, "sx" => self.speed,
            "ix" => self.intensity, "col" => self.colors.iter().map(|c| json!([c.r, c.g, c.b, 0])).collect::<Vec<_>>(),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FlowStep {
    pub effect: EffectConfig,
    pub transition: FlowTransition,
}

impl FlowStep {
    pub fn new(effect: EffectConfig, transition: FlowTransition) -> FlowStep {
        FlowStep { effect: to_flow_effect(&effect), transition }
    }
    pub fn enabled(&self) -> bool {
        self.effect.enabled
    }
    pub fn to_value(&self) -> Value {
        json!({"effect": self.effect.to_value(), "transition": self.transition.to_value()})
    }
    pub fn from_value(d: &Value) -> FlowStep {
        let Some(o) = d.as_object() else { return FlowStep::new(EffectConfig { options: Some(Obj::new()), ..Default::default() }, FlowTransition::default()) };
        let empty = json!({});
        FlowStep::new(
            EffectConfig::from_value(Some(non_empty(o.get("effect")).unwrap_or(&empty))),
            FlowTransition::from_value(Some(non_empty(o.get("transition")).unwrap_or(&empty))),
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FlowPlayer {
    pub color: RGBColor,
    /// empty = the next player without a named colour
    pub name: String,
}

impl FlowPlayer {
    pub fn to_value(&self) -> Value {
        json!({"color": self.color.to_list(), "name": self.name})
    }
    pub fn from_value(d: &Value, index: usize) -> FlowPlayer {
        let (r, g, b) = PLAYER_COLOURS[index % PLAYER_COLOURS.len()];
        let fallback = RGBColor::new(r, g, b);
        let Some(o) = d.as_object() else { return FlowPlayer { color: fallback, name: String::new() } };
        FlowPlayer { color: RGBColor::from_value(o.get("color"), fallback), name: non_empty(o.get("name")).map(py_str).unwrap_or_default().trim().to_string() }
    }
}

pub fn default_players() -> Vec<FlowPlayer> {
    PLAYER_COLOURS.iter().map(|(r, g, b)| FlowPlayer { color: RGBColor::new(*r, *g, *b), name: String::new() }).collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct GameFlow {
    pub name: String,
    pub steps: HashMap<String, FlowStep>,
    pub hits: HashMap<String, EffectConfig>,
    pub players: Vec<FlowPlayer>,
    pub camera_friendly: bool,
    pub hit_locator: bool,
    /// the preset this profile started from ("Reset to preset")
    pub preset: Option<String>,
    /// where the look came from, shown next to the segment: "Arena", "Copied from RGB1"
    pub origin: String,
    pub idle: FlowIdle,
}

impl GameFlow {
    /// GameFlow(...) with __post_init__: missing steps and hits filled in, durations fixed, six players
    pub fn build(name: &str, steps: HashMap<String, FlowStep>, hits: HashMap<String, EffectConfig>, players: Vec<FlowPlayer>) -> GameFlow {
        let mut f = GameFlow {
            name: name.into(),
            steps,
            hits,
            players,
            camera_friendly: true,
            hit_locator: false,
            preset: None,
            origin: String::new(),
            idle: FlowIdle::default(),
        };
        f.post_init();
        f
    }

    fn post_init(&mut self) {
        for sid in STEP_IDS {
            self.steps.entry(sid.into()).or_insert_with(|| FlowStep::new(EffectConfig { enabled: false, options: Some(Obj::new()), ..Default::default() }, FlowTransition::default()));
        }
        for sid in ALWAYS_ON_STEPS {
            if let Some(s) = self.steps.get_mut(sid) {
                s.effect.enabled = true;
            }
        }
        for (sid, step) in self.steps.iter_mut() {
            if TIMED_STEPS.contains(&sid.as_str()) {
                if step.effect.duration <= 0.0 {
                    step.effect.duration = 3.0;
                }
            } else {
                step.effect.duration = 0.0;
            }
        }
        for hid in HIT_IDS {
            let eff = self.hits.get(hid).cloned().unwrap_or(EffectConfig { enabled: false, duration: 1.0, options: Some(Obj::new()), ..Default::default() });
            let mut e = to_flow_effect(&eff);
            if e.duration <= 0.0 {
                e.duration = 1.0;
            }
            self.hits.insert(hid.into(), e);
        }
        let mut p = self.players.clone();
        p.extend(default_players());
        p.truncate(MAX_PLAYERS);
        self.players = p;
    }

    pub fn step(&self, id: &str) -> &FlowStep {
        &self.steps[id]
    }

    pub fn hit(&self, id: &str) -> &EffectConfig {
        &self.hits[id]
    }

    pub fn to_value(&self) -> Value {
        let steps: Map<String, Value> = STEP_IDS.iter().map(|s| (s.to_string(), self.steps[*s].to_value())).collect();
        let hits: Map<String, Value> = HIT_IDS.iter().map(|h| (h.to_string(), self.hits[*h].to_value())).collect();
        let mut o = crate::obj! {
            "name" => self.name, "steps" => steps, "hits" => hits,
            "players" => self.players.iter().map(|p| p.to_value()).collect::<Vec<_>>(),
            "camera_friendly" => self.camera_friendly, "hit_locator" => self.hit_locator, "idle" => self.idle.to_value(),
        };
        if let Some(p) = self.preset.as_ref().filter(|p| !p.is_empty()) {
            o.insert("preset".into(), json!(p));
        }
        if !self.origin.is_empty() {
            o.insert("origin".into(), json!(self.origin));
        }
        Value::Object(o)
    }

    pub fn from_value(data: &Value, name: Option<&str>) -> GameFlow {
        let Some(d) = data.as_object() else { return create_default_game_flow() };
        if d.contains_key("phases") && !d.contains_key("steps") {
            return convert_v1_flow(d, name);
        }
        let raw_steps = obj_or_empty(d.get("steps"));
        let raw_hits = obj_or_empty(d.get("hits"));
        let raw_players = arr(d.get("players"));
        let steps = STEP_IDS.iter().filter_map(|s| raw_steps.get(*s).filter(|v| v.is_object()).map(|v| (s.to_string(), FlowStep::from_value(v)))).collect();
        let hits = HIT_IDS.iter().filter_map(|h| raw_hits.get(*h).filter(|v| v.is_object()).map(|v| (h.to_string(), EffectConfig::from_value(Some(v))))).collect();
        let players = raw_players.iter().take(MAX_PLAYERS).enumerate().map(|(i, p)| FlowPlayer::from_value(p, i)).collect();
        let n = name.filter(|n| !n.is_empty()).map(str::to_string).or_else(|| non_empty(d.get("name")).map(py_str)).unwrap_or_else(|| DEFAULT_PROFILE_NAME.into());
        let mut f = GameFlow::build(&n, steps, hits, players);
        f.camera_friendly = get_bool(d, "camera_friendly", true);
        f.hit_locator = get_bool(d, "hit_locator", false);
        f.preset = non_empty(d.get("preset")).map(py_str);
        f.origin = non_empty(d.get("origin")).map(py_str).unwrap_or_default().chars().take(60).collect();
        f.idle = FlowIdle::from_value(d.get("idle"));
        f
    }
}

/// Which of the flow's player colours a match player gets: a colour tied to their name first,
/// otherwise the next colour not tied to a name, in match order.
pub fn player_colour_index(players: &[String], index: Option<i64>, flow: &GameFlow) -> usize {
    let idx = index.filter(|i| *i >= 0).unwrap_or(0) as usize;
    let names: Vec<String> = players.iter().map(|p| p.trim().to_lowercase()).collect();
    let named: Vec<(usize, String)> = flow.players.iter().enumerate().filter(|(_, p)| !p.name.trim().is_empty()).map(|(i, p)| (i, p.name.trim().to_lowercase())).collect();
    let named_slot = |pn: &str| -> Option<usize> {
        if pn.is_empty() {
            return None;
        }
        named.iter().find(|(_, f)| pn == f).or_else(|| named.iter().find(|(_, f)| pn.contains(f.as_str()))).map(|(s, _)| *s)
    };
    let me = names.get(idx).cloned().unwrap_or_default();
    if let Some(s) = named_slot(&me) {
        return s;
    }
    let named_ids: HashSet<usize> = named.iter().map(|(i, _)| *i).collect();
    let free: Vec<usize> = (0..flow.players.len()).filter(|i| !named_ids.contains(i)).collect();
    if free.is_empty() {
        return idx % flow.players.len().max(1);
    }
    let mut rank = (0..idx.min(names.len())).filter(|i| named_slot(&names[*i]).is_none()).count();
    if idx >= names.len() {
        rank = idx;
    }
    free[rank % free.len()]
}

/// A flow from the first format (fixed phases, 2 players, edge transitions) in the current model
pub fn convert_v1_flow(data: &Obj, name: Option<&str>) -> GameFlow {
    let phases: HashMap<String, &Value> = arr(data.get("phases")).iter().filter(|p| p.is_object()).map(|p| (p.get("id").map(py_str).unwrap_or_else(|| "None".into()), p)).collect();
    let events = obj_or_empty(data.get("events"));
    let transitions = obj_or_empty(data.get("transitions"));
    let effect_of = |raw: Option<&Value>| -> Option<EffectConfig> { raw.and_then(|r| r.get("effect")).filter(|e| e.is_object()).map(|e| EffectConfig::from_value(Some(e))) };
    let entry = |step: &str| -> FlowTransition {
        let edges: &[&str] = match step {
            "game_start" => &["idle->game_start"],
            "turn" => &["takeout->turn_p1", "game_start->turn_p1", "turn_p2->turn_p1"],
            "takeout" => &["turn_p1->takeout", "turn_p2->takeout"],
            "leg_won" => &["turn_p1->leg_won", "turn_p2->leg_won"],
            "match_won" => &["turn_p1->match_won", "turn_p2->match_won"],
            _ => &[],
        };
        edges.iter().find_map(|k| transitions.get(*k).filter(|v| v.is_object())).map(|v| FlowTransition::from_value(Some(v))).unwrap_or_default()
    };
    let base = create_default_game_flow();
    let mut steps = HashMap::new();
    steps.insert("bull_off".to_string(), base.steps["bull_off"].clone());
    for (sid, pid) in [("game_start", "game_start"), ("turn", "turn_p1"), ("takeout", "takeout"), ("leg_won", "leg_won"), ("match_won", "match_won")] {
        let st = match effect_of(phases.get(pid).copied()) {
            Some(e) => FlowStep::new(e, entry(sid)),
            None => base.steps[sid].clone(),
        };
        steps.insert(sid.to_string(), st);
    }
    let mut players = default_players();
    for (slot, pid) in [(0, "turn_p1"), (1, "turn_p2")] {
        if let Some(e) = effect_of(phases.get(pid).copied()) {
            players[slot] = FlowPlayer { color: e.color_primary, name: String::new() };
        }
    }
    let mut hits = HashMap::new();
    for hid in ["single", "double", "triple", "bullseye", "bust", "180"] {
        if let Some(e) = effect_of(events.get(hid)) {
            hits.insert(hid.to_string(), e);
        }
    }
    if let Some(b) = hits.get("bust").cloned() {
        hits.insert("miss".into(), b);
    }
    GameFlow::build(name.filter(|n| !n.is_empty()).unwrap_or("My flow"), steps, hits, players)
}

// --- Presets: the five starting flows, from calm to loud ---------------------------------------

type C3 = (i64, i64, i64);
const WHITE: C3 = (255, 255, 255);
const SOFT_WHITE: C3 = (190, 190, 190);
const DIM_WHITE: C3 = (70, 70, 70);
const BLACK: C3 = (0, 0, 0);
const GOLD: C3 = (255, 175, 0);
const RED: C3 = (255, 0, 30);
const GREY: C3 = (120, 120, 140);
const CYAN: C3 = (0, 190, 255);

pub const PRESET_ORDER: [&str; 5] = ["minimal", "classic", "arena", "show", "party"];

pub fn preset_info(id: &str) -> (&'static str, &'static str) {
    match id {
        "minimal" => ("Minimal", "Only shows whose turn it is. Calm and camera-friendly."),
        "arena" => ("Arena", "Bold, like a stage match, with a hit locator around the board."),
        "show" => ("Show", "Big moments feel big: score tiers, sparkle and rainbow finales."),
        "party" => ("Party", "Everything celebrates. Flashing during turns may disturb dart detection."),
        _ => ("Classic", "Clear player colours, gentle changes and a few highlights."),
    }
}

struct Look {
    anim: &'static str,
    primary: C3,
    secondary: C3,
    duration: f64,
    speed: f64,
    player: bool,
    enabled: bool,
    brightness: Option<i64>,
    options: Vec<(&'static str, Value)>,
}

fn look(anim: &'static str) -> Look {
    Look { anim, primary: WHITE, secondary: BLACK, duration: 0.0, speed: 1.0, player: false, enabled: true, brightness: None, options: Vec::new() }
}

impl Look {
    fn c(mut self, p: C3) -> Self {
        self.primary = p;
        self
    }
    fn c2(mut self, s: C3) -> Self {
        self.secondary = s;
        self
    }
    fn dur(mut self, d: f64) -> Self {
        self.duration = d;
        self
    }
    fn spd(mut self, s: f64) -> Self {
        self.speed = s;
        self
    }
    fn player(mut self) -> Self {
        self.player = true;
        self
    }
    fn bri(mut self, b: i64) -> Self {
        self.brightness = Some(b);
        self
    }
    fn off(mut self) -> Self {
        self.enabled = false;
        self
    }
    fn opt(mut self, k: &'static str, v: Value) -> Self {
        self.options.push((k, v));
        self
    }
    fn eff(self) -> EffectConfig {
        let mut options: Obj = self.options.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        if self.player {
            options.insert("colour_from".into(), json!("player"));
        }
        EffectConfig {
            animation: self.anim.into(),
            color_primary: RGBColor::new(self.primary.0, self.primary.1, self.primary.2),
            color_secondary: RGBColor::new(self.secondary.0, self.secondary.1, self.secondary.2),
            duration: self.duration,
            speed: self.speed,
            enabled: self.enabled,
            brightness: self.brightness,
            options: Some(options),
            ..Default::default()
        }
    }
}

fn off_look(anim: &'static str, duration: f64) -> EffectConfig {
    look(anim).dur(duration).off().eff()
}

fn comes_in(style: &str, d: f64, accent: Option<C3>) -> FlowTransition {
    FlowTransition::new(style, d, accent.map(|a| RGBColor::new(a.0, a.1, a.2)))
}

fn steps_of(v: Vec<(&str, EffectConfig, FlowTransition)>) -> HashMap<String, FlowStep> {
    v.into_iter().map(|(k, e, t)| (k.to_string(), FlowStep::new(e, t))).collect()
}

fn hits_of(v: Vec<(&str, EffectConfig)>) -> HashMap<String, EffectConfig> {
    v.into_iter().map(|(k, e)| (k.to_string(), e)).collect()
}

fn idle(fx: i64, brightness: i64, speed: i64, colors: Option<Vec<RGBColor>>) -> FlowIdle {
    let mut i = FlowIdle { fx, brightness, speed, ..Default::default() };
    if let Some(c) = colors {
        i.colors = c;
    }
    i
}

fn preset_flow(pid: &str) -> GameFlow {
    let fade = |d: f64| comes_in("crossfade", d, None);
    let (steps, hits, camera, locator, idl) = match pid {
        "minimal" => (
            steps_of(vec![
                ("bull_off", off_look("breathe", 0.0), fade(0.4)),
                ("game_start", off_look("curtain", 2.0), fade(0.4)),
                ("turn", look("solid").player().bri(60).eff(), fade(0.4)),
                ("takeout", off_look("solid", 0.0), fade(0.4)),
                ("leg_won", look("breathe").player().dur(3.0).spd(1.5).bri(70).eff(), fade(0.4)),
                ("match_won", look("breathe").player().dur(5.0).spd(1.25).eff(), fade(0.4)),
            ]),
            HashMap::new(),
            true,
            false,
            idle(0, 50, 128, Some(vec![RGBColor::new(255, 190, 130), RGBColor::BLACK, RGBColor::BLACK])),
        ),
        "arena" => (
            steps_of(vec![
                ("bull_off", look("breathe").c(WHITE).c2((25, 25, 25)).eff(), fade(0.5)),
                ("game_start", look("curtain").c(WHITE).dur(2.0).eff(), comes_in("curtain", 0.8, None)),
                ("turn", look("solid").player().eff(), comes_in("wipe", 0.5, None)),
                ("takeout", look("solid").c((170, 170, 170)).eff(), fade(0.3)),
                ("leg_won", look("sparkle").player().c2((20, 20, 20)).dur(4.0).opt("amount", json!("many")).eff(), comes_in("flash", 0.5, None)),
                ("match_won", look("rainbow").dur(6.0).opt("palette", json!("vivid")).eff(), comes_in("flash", 0.6, None)),
            ]),
            hits_of(vec![
                ("180", look("rainbow").dur(2.5).spd(2.0).opt("palette", json!("vivid")).eff()),
                ("bullseye", look("flash").c(RED).dur(1.2).opt("pulses", json!(2)).eff()),
                ("bust", look("flash").c(GREY).dur(0.8).opt("pulses", json!(1)).eff()),
            ]),
            true,
            true,
            idle(38, 80, 128, None),
        ),
        "show" => (
            steps_of(vec![
                ("bull_off", look("chase").c(WHITE).c2((10, 10, 10)).spd(0.6).opt("tail", json!("long")).eff(), fade(0.6)),
                ("game_start", look("chase").c(CYAN).dur(2.5).spd(1.5).opt("comets", json!(2)).opt("tail", json!("long")).eff(), comes_in("curtain", 0.8, None)),
                ("turn", look("solid").player().eff(), comes_in("wipe", 0.5, None)),
                ("takeout", look("solid").c((170, 170, 170)).eff(), fade(0.3)),
                ("leg_won", look("sparkle").player().c2((25, 25, 25)).dur(5.0).opt("amount", json!("many")).eff(), comes_in("flash", 0.6, Some(GOLD))),
                ("match_won", look("rainbow").dur(8.0).opt("palette", json!("vivid")).eff(), comes_in("curtain", 1.0, None)),
            ]),
            hits_of(vec![
                ("180", look("rainbow").dur(3.0).spd(2.0).opt("palette", json!("vivid")).eff()),
                ("bullseye", look("flash").c(RED).dur(1.2).opt("pulses", json!(2)).eff()),
                ("bust", look("flash").c(GREY).dur(0.8).opt("pulses", json!(1)).eff()),
                ("ton", look("sparkle").player().dur(2.0).opt("amount", json!("many")).eff()),
                ("ton40", look("sparkle").c(GOLD).dur(2.5).opt("amount", json!("many")).eff()),
            ]),
            true,
            true,
            idle(38, 100, 128, None),
        ),
        "party" => (
            steps_of(vec![
                ("bull_off", look("rainbow").opt("palette", json!("soft")).spd(0.8).eff(), fade(0.5)),
                ("game_start", look("rainbow").dur(3.0).spd(2.0).opt("palette", json!("vivid")).eff(), comes_in("flash", 0.4, None)),
                ("turn", look("breathe").player().c2((30, 30, 30)).spd(1.5).eff(), comes_in("wipe", 0.3, None)),
                ("takeout", look("sparkle").player().c2((15, 15, 15)).opt("amount", json!("many")).eff(), fade(0.3)),
                ("leg_won", look("rainbow").dur(5.0).spd(2.0).opt("palette", json!("vivid")).eff(), comes_in("flash", 0.4, None)),
                ("match_won", look("rainbow").dur(10.0).spd(1.5).opt("palette", json!("vivid")).eff(), comes_in("flash", 0.5, Some(GOLD))),
            ]),
            hits_of(vec![
                ("single", look("flash").player().dur(0.5).opt("pulses", json!(1)).eff()),
                ("double", look("flash").player().dur(0.8).opt("pulses", json!(2)).eff()),
                ("triple", look("flash").c(WHITE).dur(1.0).opt("pulses", json!(3)).eff()),
                ("bullseye", look("flash").c(RED).dur(1.2).opt("pulses", json!(3)).eff()),
                ("bust", look("flash").c(GREY).dur(0.8).opt("pulses", json!(1)).eff()),
                ("ton", look("sparkle").player().dur(2.0).opt("amount", json!("many")).eff()),
                ("ton40", look("sparkle").c(GOLD).dur(2.5).opt("amount", json!("many")).eff()),
                ("180", look("rainbow").dur(3.0).spd(2.5).opt("palette", json!("vivid")).eff()),
            ]),
            false,
            true,
            idle(9, 100, 170, None),
        ),
        _ => (
            steps_of(vec![
                ("bull_off", look("breathe").c(SOFT_WHITE).c2((20, 20, 20)).spd(0.8).eff(), fade(0.6)),
                ("game_start", look("curtain").c(CYAN).dur(2.0).eff(), fade(0.5)),
                ("turn", look("solid").player().eff(), comes_in("wipe", 0.6, None)),
                ("takeout", look("solid").c(DIM_WHITE).eff(), fade(0.4)),
                ("leg_won", look("curtain").player().dur(3.0).eff(), fade(0.4)),
                ("match_won", look("rainbow").dur(6.0).opt("palette", json!("soft")).eff(), fade(0.8)),
            ]),
            hits_of(vec![
                ("180", look("flash").c(GOLD).dur(1.5).opt("pulses", json!(2)).eff()),
                ("bullseye", look("flash").c(RED).dur(1.0).opt("pulses", json!(1)).eff()),
            ]),
            true,
            false,
            idle(9, 70, 128, None),
        ),
    };
    let mut f = GameFlow::build(DEFAULT_PROFILE_NAME, steps, hits, Vec::new());
    f.camera_friendly = camera;
    f.hit_locator = locator;
    f.idle = idl;
    f
}

/// A fresh copy of a preset as a profile
pub fn build_preset(preset_id: &str, name: Option<&str>) -> GameFlow {
    let pid = if PRESET_ORDER.contains(&preset_id) { preset_id } else { "classic" };
    let mut f = preset_flow(pid);
    f.name = name.filter(|n| !n.is_empty()).unwrap_or(preset_info(pid).0).to_string();
    f.preset = Some(pid.into());
    f
}

pub fn presets_for_ui() -> Value {
    Value::Array(
        PRESET_ORDER
            .iter()
            .map(|p| {
                let (n, s) = preset_info(p);
                json!({"id": p, "name": n, "summary": s})
            })
            .collect(),
    )
}

/// The flow a fresh install starts with (the Classic preset)
pub fn create_default_game_flow() -> GameFlow {
    build_preset("classic", None)
}

// --- Storage -----------------------------------------------------------------------------------

/// "base", or "base 2", "base 3", ... when taken
pub fn free_name(taken: &HashSet<String>, base: &str, limit: usize) -> String {
    for i in 1..1000 {
        let tail = if i == 1 { String::new() } else { format!(" {}", i) };
        let keep = limit.saturating_sub(tail.chars().count());
        let name = format!("{}{}", base.chars().take(keep).collect::<String>().trim_end(), tail);
        if !taken.contains(&name) {
            return name;
        }
    }
    base.to_string()
}

struct Cache {
    stamp: Option<(u128, u64)>,
    data: Obj,
    flows: HashMap<String, Arc<GameFlow>>,
}

/// Reads and atomically writes game_flows.json:
///     {"version": 2, "default": "<profile>", "profiles": {"<name>": {...}},
///      "assign": {"<controller ip>": {"*": "<profile>", "<segment id>": "<profile>"}}, "presets": {...}}
/// A segment uses its own profile, else its controller's ("*"), else the default profile. Parsed profiles
/// are cached and only re-read when the file changes (mtime and size).
pub struct GameFlowStorage {
    pub filepath: PathBuf,
    bak: PathBuf,
    template: Option<PathBuf>,
    cache: Mutex<Cache>,
}

impl GameFlowStorage {
    pub fn new(filepath: Option<PathBuf>) -> GameFlowStorage {
        let (filepath, template) = match filepath {
            Some(p) => (p, None),
            None => {
                let target = project_root().join("game_flows.json");
                adopt_flow_file_from_cwd(&target);
                (target, Some(project_root().join("defaults").join("game_flows.json")))
            }
        };
        let mut bak = filepath.as_os_str().to_owned();
        bak.push(".bak");
        GameFlowStorage { bak: PathBuf::from(bak), filepath, template, cache: Mutex::new(Cache { stamp: None, data: Obj::new(), flows: HashMap::new() }) }
    }

    fn file_stamp(&self) -> Option<(u128, u64)> {
        let m = std::fs::metadata(&self.filepath).ok()?;
        let mt = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
        Some((mt, m.len()))
    }

    fn read_file(&self) -> Obj {
        if !self.filepath.exists() {
            return Obj::new();
        }
        for p in [&self.filepath, &self.bak] {
            if !p.exists() {
                continue;
            }
            match std::fs::read_to_string(p).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
                Ok(Value::Object(o)) => return o,
                Ok(_) => {}
                Err(e) => {
                    warn!("Failed to read {}: {}", p.display(), e);
                    if p == &self.filepath {
                        self.quarantine();
                    }
                }
            }
        }
        Obj::new()
    }

    fn quarantine(&self) {
        if std::fs::metadata(&self.filepath).map(|m| m.len() == 0).unwrap_or(true) {
            return;
        }
        let mut t = self.filepath.as_os_str().to_owned();
        t.push(format!(".corrupt_{}", chrono::Local::now().format("%Y%m%d_%H%M%S")));
        match std::fs::copy(&self.filepath, &t) {
            Ok(_) => error!("Game flow file is not readable; kept a copy as {}", PathBuf::from(t).display()),
            Err(e) => warn!("Could not keep a copy of the unreadable game flow file: {}", e),
        }
    }

    fn data_now(&self) -> Obj {
        let stamp = self.file_stamp();
        {
            let c = self.cache.lock().unwrap();
            if stamp.is_some() && stamp == c.stamp && !c.data.is_empty() {
                return c.data.clone();
            }
        }
        let raw = self.read_file();
        if raw.get("version").and_then(Value::as_i64) == Some(FILE_VERSION) && raw.get("profiles").and_then(Value::as_object).map_or(false, |p| !p.is_empty()) {
            self.remember(raw.clone(), stamp);
            return raw;
        }
        let data = if !raw.is_empty() { upgrade(&raw) } else { self.starting_data() };
        if !self.write_raw(&data) {
            self.remember(data.clone(), stamp);
        }
        self.cache.lock().unwrap().data.clone()
    }

    fn remember(&self, data: Obj, stamp: Option<(u128, u64)>) {
        let mut c = self.cache.lock().unwrap();
        c.data = data;
        c.stamp = stamp;
        c.flows.clear();
    }

    fn starting_data(&self) -> Obj {
        if let Some(t) = self.template.as_ref().filter(|t| t.is_file()) {
            match std::fs::read_to_string(t).map_err(|e| e.to_string()).and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string())) {
                Ok(Value::Object(tpl)) => {
                    return if tpl.get("version").and_then(Value::as_i64) != Some(FILE_VERSION) { upgrade(&tpl) } else { tpl };
                }
                Ok(_) => {}
                Err(e) => warn!("Could not read the default flows {}: {}", t.display(), e),
            }
        }
        let f = create_default_game_flow();
        let mut profiles = Obj::new();
        profiles.insert(f.name.clone(), f.to_value());
        crate::obj! {"version" => FILE_VERSION, "default" => f.name, "profiles" => profiles, "assign" => {}}
    }

    fn profiles_of(data: &Obj) -> Obj {
        obj_or_empty(data.get("profiles"))
    }

    pub fn profile_names(&self) -> Vec<String> {
        Self::profiles_of(&self.data_now()).keys().cloned().collect()
    }

    pub fn default_profile(&self) -> String {
        let d = self.data_now();
        let profiles = Self::profiles_of(&d);
        match d.get("default").map(py_str) {
            Some(n) if profiles.contains_key(&n) => n,
            _ => profiles.keys().next().cloned().unwrap_or_else(|| DEFAULT_PROFILE_NAME.into()),
        }
    }

    pub fn profile_name_for(&self, ip: Option<&str>, seg_id: Option<i64>) -> String {
        let d = self.data_now();
        let profiles = Self::profiles_of(&d);
        let assign = obj_or_empty(d.get("assign"));
        let segs = assign.get(ip.unwrap_or("")).and_then(Value::as_object).cloned().unwrap_or_default();
        let mut keys = Vec::new();
        if let Some(s) = seg_id {
            keys.push(s.to_string());
        }
        keys.push("*".into());
        for k in keys {
            if let Some(n) = segs.get(&k).map(py_str) {
                if profiles.contains_key(&n) {
                    return n;
                }
            }
        }
        self.default_profile()
    }

    pub fn get_profile(&self, name: Option<&str>) -> Arc<GameFlow> {
        let d = self.data_now();
        let profiles = Self::profiles_of(&d);
        let pname = match name {
            Some(n) if profiles.contains_key(n) => n.to_string(),
            _ => self.default_profile(),
        };
        let mut c = self.cache.lock().unwrap();
        if let Some(f) = c.flows.get(&pname) {
            return Arc::clone(f);
        }
        let f = Arc::new(GameFlow::from_value(profiles.get(&pname).unwrap_or(&Value::Null), Some(&pname)));
        c.flows.insert(pname, Arc::clone(&f));
        f
    }

    /// The flow a segment plays (shared and read-only: the engine calls this for every event)
    pub fn get_for_segment(&self, ip: Option<&str>, seg_id: Option<i64>) -> Arc<GameFlow> {
        self.get_profile(Some(&self.profile_name_for(ip, seg_id)))
    }

    /// A private copy of a profile that the caller may edit
    pub fn load_profile(&self, name: Option<&str>) -> GameFlow {
        (*self.get_profile(name)).clone()
    }

    fn edit(&self) -> Obj {
        let mut d = self.data_now();
        if !d.get("assign").map_or(false, Value::is_object) {
            d.insert("assign".into(), json!({}));
        }
        d
    }

    /// Create or update a profile; with old_name it is also renamed (assignments follow)
    pub fn save_profile(&self, flow: &GameFlow, old_name: Option<&str>) -> bool {
        let mut d = self.edit();
        let name = if flow.name.trim().is_empty() { DEFAULT_PROFILE_NAME.to_string() } else { flow.name.trim().to_string() };
        let mut flow = flow.clone();
        flow.name = name.clone();
        let mut profiles = Self::profiles_of(&d);
        if let Some(old) = old_name.filter(|o| !o.is_empty() && *o != name) {
            if profiles.contains_key(&name) {
                return false;
            }
            profiles = profiles.into_iter().map(|(k, v)| (if k == old { name.clone() } else { k }, v)).collect();
            if d.get("default").map(py_str).as_deref() == Some(old) {
                d.insert("default".into(), json!(name));
            }
            if let Some(Value::Object(a)) = d.get_mut("assign") {
                for segs in a.values_mut() {
                    if let Some(so) = segs.as_object_mut() {
                        for v in so.values_mut() {
                            if py_str(v) == old {
                                *v = json!(name);
                            }
                        }
                    }
                }
            }
        }
        profiles.insert(name, flow.to_value());
        d.insert("profiles".into(), Value::Object(profiles));
        self.write_raw(&d)
    }

    pub fn delete_profile(&self, name: &str) -> bool {
        let mut d = self.edit();
        let mut profiles = Self::profiles_of(&d);
        if !profiles.contains_key(name) || profiles.len() <= 1 {
            return false;
        }
        profiles.shift_remove(name);
        if d.get("default").map(py_str).as_deref() == Some(name) {
            d.insert("default".into(), json!(profiles.keys().next().cloned().unwrap_or_default()));
        }
        d.insert("profiles".into(), Value::Object(profiles));
        let assign: Obj = obj_or_empty(d.get("assign"))
            .into_iter()
            .filter_map(|(ip, segs)| {
                let kept: Obj = segs.as_object().cloned().unwrap_or_default().into_iter().filter(|(_, v)| py_str(v) != name).collect();
                if kept.is_empty() {
                    None
                } else {
                    Some((ip, Value::Object(kept)))
                }
            })
            .collect();
        d.insert("assign".into(), Value::Object(assign));
        self.write_raw(&d)
    }

    pub fn set_default(&self, name: &str) -> bool {
        let mut d = self.edit();
        if !Self::profiles_of(&d).contains_key(name) {
            return false;
        }
        d.insert("default".into(), json!(name));
        self.write_raw(&d)
    }

    /// seg_id None = the whole controller (replaces its segment choices)
    pub fn assign(&self, ip: &str, name: &str, seg_id: Option<i64>) -> bool {
        let mut d = self.edit();
        if ip.is_empty() || !Self::profiles_of(&d).contains_key(name) {
            return false;
        }
        let a = d.get_mut("assign").and_then(Value::as_object_mut).unwrap();
        match seg_id {
            None => {
                a.insert(ip.into(), json!({"*": name}));
            }
            Some(s) => {
                let e = a.entry(ip.to_string()).or_insert_with(|| json!({}));
                if !e.is_object() {
                    *e = json!({});
                }
                e.as_object_mut().unwrap().insert(s.to_string(), json!(name));
            }
        }
        self.write_raw(&d)
    }

    /// Every segment ((ip, segment id, name), in page order) gets a profile it plays alone: the first
    /// segment of a shared profile keeps it, the others get a copy named after them.
    pub fn give_own_profiles(&self, segments: &[(String, Option<i64>, String)]) -> bool {
        let mut d = self.edit();
        let mut profiles = Self::profiles_of(&d);
        let mut taken: HashSet<String> = profiles.keys().cloned().collect();
        let mut seen = HashSet::new();
        let mut changed = false;
        for (ip, seg_id, seg_name) in segments {
            let name = self.profile_name_for(Some(ip), *seg_id);
            let key = seg_id.map_or_else(|| "*".to_string(), |s| s.to_string());
            let a = d.get_mut("assign").and_then(Value::as_object_mut).unwrap();
            let e = a.entry(ip.clone()).or_insert_with(|| json!({}));
            if !e.is_object() {
                *e = json!({});
            }
            let segs = e.as_object_mut().unwrap();
            if !seen.contains(&name) {
                seen.insert(name.clone());
                if segs.get(&key).map(py_str).as_deref() != Some(name.as_str()) {
                    segs.insert(key, json!(name));
                    changed = true;
                }
                continue;
            }
            let own = free_name(&taken, if seg_name.is_empty() { "Segment" } else { seg_name }, 40);
            taken.insert(own.clone());
            seen.insert(own.clone());
            let mut copy = profiles.get(&name).and_then(Value::as_object).cloned().unwrap_or_default();
            copy.insert("name".into(), json!(own));
            profiles.insert(own.clone(), Value::Object(copy));
            segs.insert(key, json!(own));
            changed = true;
        }
        d.insert("profiles".into(), Value::Object(profiles));
        if changed {
            self.write_raw(&d)
        } else {
            true
        }
    }

    pub fn user_presets(&self) -> Vec<(String, GameFlow)> {
        obj_or_empty(self.data_now().get("presets")).iter().filter(|(_, v)| v.is_object()).map(|(n, v)| (n.clone(), GameFlow::from_value(v, Some(n)))).collect()
    }

    pub fn save_user_preset(&self, flow: &GameFlow) -> bool {
        let mut d = self.edit();
        let mut p = obj_or_empty(d.get("presets"));
        p.insert(flow.name.clone(), flow.to_value());
        d.insert("presets".into(), Value::Object(p));
        self.write_raw(&d)
    }

    pub fn delete_user_preset(&self, name: &str) -> bool {
        let mut d = self.edit();
        let mut p = obj_or_empty(d.get("presets"));
        if p.shift_remove(name).is_none() {
            return false;
        }
        d.insert("presets".into(), Value::Object(p));
        self.write_raw(&d)
    }

    fn write_raw(&self, data: &Obj) -> bool {
        let text = {
            let mut buf = Vec::new();
            let fmt = serde_json::ser::PrettyFormatter::with_indent(b"  ");
            let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
            if serde::Serialize::serialize(&Value::Object(data.clone()), &mut ser).is_err() {
                return false;
            }
            buf
        };
        if self.filepath.exists() {
            if let Err(e) = std::fs::copy(&self.filepath, &self.bak) {
                warn!("Could not create game flow backup: {}", e);
            }
        }
        match write_atomic(&self.filepath, &text) {
            Ok(()) => {
                self.remember(data.clone(), self.file_stamp());
                info!("Saved game flows to {}", self.filepath.display());
                true
            }
            Err(e) => {
                error!("Error writing game flow data to {}: {}", self.filepath.display(), e);
                false
            }
        }
    }
}

/// A first-format file (one master flow plus per-segment copies) as profiles
fn upgrade(raw: &Obj) -> Obj {
    if raw.get("version").and_then(Value::as_i64) == Some(FILE_VERSION) {
        return raw.clone();
    }
    let main = GameFlow::from_value(&Value::Object(raw.clone()), Some("My flow"));
    let mut profiles = Obj::new();
    profiles.insert(main.name.clone(), main.to_value());
    let mut assign = Obj::new();
    for (ip, segs) in obj_or_empty(raw.get("device_flows")) {
        let Some(segs) = segs.as_object() else { continue };
        for (sid, seg_raw) in segs {
            if !seg_raw.is_object() {
                continue;
            }
            let pname = format!("My flow - {} segment {}", ip, sid);
            profiles.insert(pname.clone(), GameFlow::from_value(seg_raw, Some(&pname)).to_value());
            let e = assign.entry(ip.clone()).or_insert_with(|| json!({}));
            e.as_object_mut().unwrap().insert(sid.clone(), json!(pname));
        }
    }
    info!("Converted game flows to profiles: {}", profiles.keys().cloned().collect::<Vec<_>>().join(", "));
    crate::obj! {"version" => FILE_VERSION, "default" => main.name, "profiles" => profiles, "assign" => assign}
}

/// Older versions resolved game_flows.json from the working directory; copy that file over once
fn adopt_flow_file_from_cwd(target: &Path) {
    let Ok(cwd) = std::env::current_dir() else { return };
    let legacy = cwd.join("game_flows.json");
    if legacy == target || target.exists() || !legacy.is_file() {
        return;
    }
    match std::fs::copy(&legacy, target) {
        Ok(_) => info!("Copied game flows from {} to {} (the original is left in place)", legacy.display(), target.display()),
        Err(e) => warn!("Could not copy legacy game flows from {}: {}", legacy.display(), e),
    }
}
