//! Core domain models: game events, device configuration, effects and profiles.
//! to_value / from_value keep the exact JSON layout of config.json and the API.

use crate::py::*;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashSet};

/// WLED analog (PWM) outputs are types 40-49; 50+ are SPI strips and network buses
pub fn is_pwm_output(hw: &Value) -> bool {
    hw.is_object() && (40..50).contains(&safe_int(hw.get("type"), 22))
}

/// Fill in what a controller's LED outputs already say about its segments: a segment without a data pin
/// gets the pin of the output it sits on, and a segment on a white light output is white illumination.
fn complete_segments_from_outputs(segments: &mut [SegmentConfig], hw_ins: &[Value]) {
    let outputs: Vec<&Value> = hw_ins.iter().filter(|h| h.is_object()).collect();
    for seg in segments.iter_mut() {
        let out = outputs.iter().find(|h| {
            let st = safe_int(h.get("start"), 0);
            st <= seg.start && seg.start < st + 1.max(safe_int(h.get("len"), 1))
        });
        let Some(out) = out else { continue };
        if seg.gpio.trim().is_empty() {
            if let Some(p) = out.get("pin").and_then(Value::as_array).and_then(|a| a.first()) {
                seg.gpio = format!("GPIO {}", py_str(p));
            }
        }
        if is_pwm_output(out) {
            seg.role = "white_illumination".into();
        }
    }
}

fn is_digit_str(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Flatten one controller's per-segment effects from a pre-2.3 profile into a plain profile dict.
pub fn profile_dict_for_device(raw: &Obj, ip: &str) -> Obj {
    let mut out: Obj = raw.iter().filter(|(k, _)| k.as_str() != "device_events").map(|(k, v)| (k.clone(), v.clone())).collect();
    let mut events = obj_or_empty(raw.get("events"));
    let mut slots: Vec<Obj> = arr(raw.get("player_slots")).iter().filter_map(|s| s.as_object().cloned()).collect();
    if let Some(seg_map) = raw.get("device_events").and_then(|d| d.get(ip)).and_then(Value::as_object) {
        if !seg_map.is_empty() {
            let mut numbered: Vec<&String> = seg_map.keys().filter(|k| is_digit_str(k)).collect();
            numbered.sort_by_key(|k| k.parse::<i64>().unwrap_or(0));
            let key = if seg_map.contains_key("0") {
                "0".to_string()
            } else if let Some(n) = numbered.first() {
                (*n).clone()
            } else {
                seg_map.keys().next().cloned().unwrap_or_default()
            };
            if let Some(effs) = seg_map.get(&key).and_then(Value::as_object) {
                for (ev_key, eff) in effs {
                    let Some(eff_o) = eff.as_object() else { continue };
                    if ev_key.starts_with("player_") && is_digit_str(&ev_key[7..]) {
                        let slot_id: i64 = ev_key[7..].parse().unwrap_or(0);
                        let idx = match slots.iter().position(|s| safe_int(s.get("id"), 0) == slot_id) {
                            Some(i) => i,
                            None => {
                                slots.push(crate::obj! {"id" => slot_id, "name_filter" => "", "match_type" => "contains"});
                                slots.len() - 1
                            }
                        };
                        slots[idx].insert("effect".into(), Value::Object(eff_o.clone()));
                        slots[idx].insert("enabled".into(), json!(get_bool(eff_o, "enabled", false)));
                    } else {
                        events.insert(ev_key.clone(), Value::Object(eff_o.clone()));
                    }
                }
            }
        }
    }
    out.insert("events".into(), Value::Object(events));
    if !slots.is_empty() {
        out.insert("player_slots".into(), Value::Array(slots.into_iter().map(Value::Object).collect()));
    }
    out
}

/// Turn pre-2.3 profiles that hold per-controller effects into one fixed profile per controller.
pub fn split_device_profiles(raw_profiles: &[Value], devices: &[DeviceConfig], device_profiles: &Obj, active_name: &str) -> (Vec<Value>, Obj) {
    let mut profiles = Vec::new();
    let mut assigned = device_profiles.clone();
    let mut taken: HashSet<String> = raw_profiles.iter().filter_map(|p| p.as_object()).map(|p| get_str(p, "name", "").to_lowercase()).collect();
    let names: BTreeMap<&str, String> = devices.iter().map(|d| (d.ip.as_str(), if d.name.is_empty() { d.ip.clone() } else { d.name.clone() })).collect();
    for raw in raw_profiles {
        let Some(raw) = raw.as_object() else { continue };
        profiles.push(Value::Object(raw.iter().filter(|(k, _)| k.as_str() != "device_events").map(|(k, v)| (k.clone(), v.clone())).collect()));
        let Some(dev_events) = raw.get("device_events").and_then(Value::as_object) else { continue };
        let base = get_str(raw, "name", "Default");
        for (ip, seg_map) in dev_events {
            if !truthy(seg_map) {
                continue;
            }
            let Some(dname) = names.get(ip.as_str()) else { continue };
            let new_name = format!("{} - {}", base, dname);
            if !taken.contains(&new_name.to_lowercase()) {
                taken.insert(new_name.to_lowercase());
                let mut split = profile_dict_for_device(raw, ip);
                split.insert("name".into(), json!(new_name));
                profiles.push(Value::Object(split));
            }
            let current = assigned.get(ip).map(py_str).unwrap_or_else(|| active_name.to_string());
            if current == base {
                assigned.insert(ip.clone(), json!(new_name));
            }
        }
    }
    (profiles, assigned)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProtocolMode {
    IdleHttp,
    ActiveUdp,
}

impl ProtocolMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProtocolMode::IdleHttp => "http",
            ProtocolMode::ActiveUdp => "udp",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LightingMode {
    Matrix,
    Flow,
}

impl LightingMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            LightingMode::Matrix => "matrix",
            LightingMode::Flow => "flow",
        }
    }
    pub fn parse(s: &str) -> LightingMode {
        if s.to_lowercase() == "matrix" {
            LightingMode::Matrix
        } else {
            LightingMode::Flow
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DartEventType {
    Score180,
    Triple,
    Double,
    Single,
    Bullseye,
    Bust,
    LegWon,
    MatchWon,
    GameStart,
    BullOffStart,
    BullOffWon,
    GameFinish,
    GameIdle,
    Calibrating,
    Takeout,
    TakeoutInProgress,
    ManualReset,
    Throw,
}

impl DartEventType {
    pub fn as_str(&self) -> &'static str {
        use DartEventType::*;
        match self {
            Score180 => "180",
            Triple => "triple",
            Double => "double",
            Single => "single",
            Bullseye => "bullseye",
            Bust => "bust",
            LegWon => "leg_won",
            MatchWon => "match_won",
            GameStart => "game_start",
            BullOffStart => "bull_off_start",
            BullOffWon => "bull_off_won",
            GameFinish => "game_finish",
            GameIdle => "game_idle",
            Calibrating => "calibrating",
            Takeout => "takeout",
            TakeoutInProgress => "takeout_in_progress",
            ManualReset => "manual_reset",
            Throw => "throw",
        }
    }
}

pub const ANIMATIONS: [&str; 17] = [
    "chase", "rainbow", "pastel_rainbow", "flash", "curtain", "heartbeat", "pulse", "solid", "wipe", "breathe", "scan", "comet",
    "dual_comet", "sparkle", "fire", "radar", "off",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct RGBColor {
    pub r: i64,
    pub g: i64,
    pub b: i64,
}

impl RGBColor {
    pub const fn new(r: i64, g: i64, b: i64) -> RGBColor {
        RGBColor { r, g, b }
    }
    pub const WHITE: RGBColor = RGBColor::new(255, 255, 255);
    pub const BLACK: RGBColor = RGBColor::new(0, 0, 0);
    pub fn is_black(&self) -> bool {
        self.r == 0 && self.g == 0 && self.b == 0
    }
    pub fn to_list(&self) -> Value {
        json!([self.r, self.g, self.b])
    }
    pub fn tuple(&self) -> (i64, i64, i64) {
        (self.r, self.g, self.b)
    }
    /// RGBColor.from_dict: dict {r,g,b}, list [r,g,b] or "#rrggbb"
    pub fn from_value(v: Option<&Value>, default: RGBColor) -> RGBColor {
        match v {
            Some(Value::Object(o)) => RGBColor::new(safe_int(o.get("r"), default.r), safe_int(o.get("g"), default.g), safe_int(o.get("b"), default.b)),
            Some(Value::Array(a)) if a.len() >= 3 => RGBColor::new(safe_int(a.first(), default.r), safe_int(a.get(1), default.g), safe_int(a.get(2), default.b)),
            Some(Value::String(s)) if s.starts_with('#') && s.len() >= 7 => {
                let p = |i: usize| s.get(i..i + 2).and_then(|h| i64::from_str_radix(h, 16).ok());
                match (p(1), p(3), p(5)) {
                    (Some(r), Some(g), Some(b)) => RGBColor::new(r, g, b),
                    _ => default,
                }
            }
            _ => default,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EffectConfig {
    pub animation: String,
    pub color_primary: RGBColor,
    pub color_secondary: RGBColor,
    pub color_tertiary: RGBColor,
    /// Match Previous: dynamically inherit the active baseline/throw colour
    pub dynamic_secondary: bool,
    pub duration: f64,
    pub speed: f64,
    pub fps: i64,
    pub reverse: bool,
    pub enabled: bool,
    pub brightness: Option<i64>,
    pub transition: String,
    pub transition_duration: f64,
    pub wled_effect_id: Option<i64>,
    pub wled_effect_name: Option<String>,
    /// Flow Matrix look options (e.g. {"tail": "long"}); None = a legacy Event Matrix effect
    pub options: Option<Obj>,
}

impl Default for EffectConfig {
    fn default() -> Self {
        EffectConfig {
            animation: "solid".into(),
            color_primary: RGBColor::new(0, 255, 0),
            color_secondary: RGBColor::BLACK,
            color_tertiary: RGBColor::BLACK,
            dynamic_secondary: false,
            duration: 2.0,
            speed: 1.0,
            fps: 50,
            reverse: false,
            enabled: true,
            brightness: None,
            transition: "instant".into(),
            transition_duration: 0.0,
            wled_effect_id: None,
            wled_effect_name: None,
            options: None,
        }
    }
}

impl EffectConfig {
    pub fn off_solid() -> EffectConfig {
        EffectConfig { color_primary: RGBColor::BLACK, duration: 0.0, enabled: false, ..Default::default() }
    }

    pub fn is_off(&self) -> bool {
        self.animation == "off"
    }

    pub fn to_value(&self) -> Value {
        let mut o = crate::obj! {
            "animation" => self.animation,
            "color_primary" => self.color_primary.to_list(),
            "color_secondary" => self.color_secondary.to_list(),
            "color_tertiary" => self.color_tertiary.to_list(),
            "dynamic_secondary" => self.dynamic_secondary,
            "duration" => self.duration,
            "speed" => self.speed,
            "fps" => self.fps,
            "reverse" => self.reverse,
            "enabled" => self.enabled,
            "transition" => self.transition,
            "transition_duration" => self.transition_duration,
        };
        if let Some(b) = self.brightness {
            o.insert("brightness".into(), json!(b));
        }
        if let Some(i) = self.wled_effect_id {
            o.insert("wled_effect_id".into(), json!(i));
        }
        if let Some(n) = &self.wled_effect_name {
            o.insert("wled_effect_name".into(), json!(n));
        }
        if let Some(op) = &self.options {
            o.insert("options".into(), Value::Object(op.clone()));
        }
        Value::Object(o)
    }

    pub fn from_value(data: Option<&Value>) -> EffectConfig {
        let Some(d) = data.and_then(Value::as_object) else { return EffectConfig::default() };
        let anim = get_str(d, "animation", "solid").to_lowercase();
        let animation = if ANIMATIONS.contains(&anim.as_str()) { anim } else { "solid".into() };
        let prim = non_empty(d.get("color_primary")).or_else(|| d.get("color"));
        let prim_default = json!([0, 255, 0]);
        EffectConfig {
            animation,
            color_primary: RGBColor::from_value(Some(prim.unwrap_or(&prim_default)), RGBColor::new(0, 255, 0)),
            color_secondary: RGBColor::from_value(Some(d.get("color_secondary").unwrap_or(&json!([0, 0, 0]))), RGBColor::BLACK),
            color_tertiary: RGBColor::from_value(Some(d.get("color_tertiary").unwrap_or(&json!([0, 0, 0]))), RGBColor::BLACK),
            dynamic_secondary: get_bool(d, "dynamic_secondary", false),
            duration: safe_float(d.get("duration"), 2.0),
            speed: safe_float(d.get("speed"), 1.0),
            fps: safe_int(d.get("fps"), 50),
            reverse: get_bool(d, "reverse", false),
            enabled: get_bool(d, "enabled", true),
            brightness: d.get("brightness").filter(|v| !v.is_null()).map(|v| safe_int(Some(v), 0)),
            transition: get_str(d, "transition", "instant"),
            transition_duration: safe_float(d.get("transition_duration"), 0.0),
            wled_effect_id: d.get("wled_effect_id").filter(|v| !v.is_null()).map(|v| safe_int(Some(v), 0)),
            wled_effect_name: d.get("wled_effect_name").filter(|v| !v.is_null()).map(py_str),
            options: d.get("options").and_then(Value::as_object).cloned(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameMatchType {
    Contains,
    Exact,
}

impl NameMatchType {
    pub fn as_str(&self) -> &'static str {
        match self {
            NameMatchType::Contains => "contains",
            NameMatchType::Exact => "exact",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlayerSlotConfig {
    pub id: i64,
    pub name_filter: String,
    pub match_type: NameMatchType,
    pub effect: EffectConfig,
    pub enabled: bool,
}

impl PlayerSlotConfig {
    pub fn new(id: i64) -> PlayerSlotConfig {
        PlayerSlotConfig {
            id,
            name_filter: String::new(),
            match_type: NameMatchType::Contains,
            effect: EffectConfig { color_primary: RGBColor::new(0, 180, 255), duration: 0.0, ..Default::default() },
            enabled: true,
        }
    }

    pub fn to_value(&self) -> Value {
        json!({"id": self.id, "name_filter": self.name_filter, "match_type": self.match_type.as_str(),
               "effect": self.effect.to_value(), "enabled": self.enabled})
    }

    pub fn from_value(data: &Value, default_id: i64) -> PlayerSlotConfig {
        let Some(d) = data.as_object() else { return PlayerSlotConfig::new(default_id) };
        let match_type = if get_str(d, "match_type", "contains").to_lowercase() == "exact" { NameMatchType::Exact } else { NameMatchType::Contains };
        let empty = json!({});
        let mut effect = EffectConfig::from_value(Some(d.get("effect").unwrap_or(&empty)));
        let enabled = match d.get("enabled") {
            Some(v) if !v.is_null() => truthy(v),
            _ => effect.enabled,
        };
        effect.enabled = enabled;
        PlayerSlotConfig { id: safe_int(d.get("id"), default_id), name_filter: get_str(d, "name_filter", ""), match_type, effect, enabled }
    }

    /// Whether this slot's name filter of the given kind picks a lower-case player name
    fn picks(&self, name: &str, match_type: NameMatchType) -> bool {
        let filt = self.name_filter.trim().to_lowercase();
        if filt.is_empty() || self.match_type != match_type {
            return false;
        }
        if match_type == NameMatchType::Exact {
            name == filt
        } else {
            name.contains(&filt)
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SegmentConfig {
    pub id: i64,
    pub name: String,
    pub r#type: String,
    pub gpio: String,
    pub start: i64,
    pub length: i64,
    /// "dartboard_ring", "white_illumination", "ambient"
    pub role: String,
    pub hw_key: Option<Value>,
    /// effects begin this many LEDs after start, wrapping around (WLED "of")
    pub offset: i64,
    /// LEDs run clockwise around the board from the offset (hit locator)
    pub clockwise: bool,
    /// goes all the way around the board, so the hit locator can use it
    pub locator: bool,
}

impl SegmentConfig {
    pub fn new(id: i64) -> SegmentConfig {
        SegmentConfig {
            id,
            name: "Segment 0".into(),
            r#type: "WS281x".into(),
            gpio: "GPIO 33".into(),
            start: 0,
            length: 45,
            role: "dartboard_ring".into(),
            hw_key: None,
            offset: 0,
            clockwise: true,
            locator: true,
        }
    }

    pub fn is_pwm(&self) -> bool {
        self.name.to_lowercase().contains("pwm") || self.r#type.to_lowercase().contains("pwm")
    }

    pub fn to_value(&self) -> Value {
        let mut o = crate::obj! {
            "id" => self.id, "name" => self.name, "type" => self.r#type, "gpio" => self.gpio,
            "start" => self.start, "length" => self.length, "role" => self.role, "offset" => self.offset,
        };
        if !self.clockwise {
            o.insert("clockwise".into(), json!(false));
        }
        if !self.locator {
            o.insert("locator".into(), json!(false));
        }
        if let Some(k) = &self.hw_key {
            if truthy(k) {
                o.insert("hw_key".into(), k.clone());
            }
        }
        Value::Object(o)
    }

    pub fn from_value(data: &Value, default_id: i64) -> SegmentConfig {
        let Some(d) = data.as_object() else { return SegmentConfig::new(default_id) };
        let id = safe_int(d.get("id"), default_id);
        let name = non_empty(d.get("name")).or_else(|| non_empty(d.get("n"))).map(py_str).unwrap_or_else(|| format!("Segment {}", id));
        let start = safe_int(d.get("start"), 0);
        let present = |k: &str| d.get(k).filter(|v| !v.is_null());
        let length = if let Some(v) = present("length") {
            1.max(safe_int(Some(v), 15))
        } else if let Some(v) = present("len") {
            1.max(safe_int(Some(v), 15))
        } else if let Some(v) = present("stop") {
            1.max(safe_int(Some(v), start + 15) - start)
        } else {
            15
        };
        let off_raw = d.get("offset").or_else(|| d.get("of"));
        SegmentConfig {
            id,
            name,
            r#type: get_str(d, "type", "WS281x"),
            gpio: get_str(d, "gpio", ""),
            start,
            length,
            role: get_str(d, "role", "dartboard_ring"),
            hw_key: d.get("hw_key").cloned().filter(|v| !v.is_null()),
            offset: safe_int(off_raw, 0).rem_euclid(length),
            clockwise: d.get("clockwise") != Some(&Value::Bool(false)),
            locator: d.get("locator") != Some(&Value::Bool(false)),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DeviceConfig {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub udp_port: i64,
    pub rgb_count: i64,
    pub pwm_index: Option<i64>,
    pub pwm_seg_id: Option<i64>,
    pub default_pwm_brightness: i64,
    /// light strips during a game (0..255); None: the global game_mode_spotlight_brightness
    pub game_pwm_brightness: Option<i64>,
    pub idle_dim_seconds: i64,
    pub idle_dim_brightness: i64,
    pub idle_off_seconds: i64,
    pub enabled: bool,
    pub led_rotation: i64,
    pub led0_offset: i64,
    pub segments: Vec<SegmentConfig>,
    pub hw_ins: Vec<Value>,
}

impl DeviceConfig {
    pub fn new(ip: &str) -> DeviceConfig {
        DeviceConfig {
            id: "default_device".into(),
            name: "Main Dartboard WLED".into(),
            ip: ip.into(),
            udp_port: 21324,
            rgb_count: 45,
            pwm_index: Some(45),
            pwm_seg_id: Some(1),
            default_pwm_brightness: 200,
            game_pwm_brightness: None,
            idle_dim_seconds: 300,
            idle_dim_brightness: 40,
            idle_off_seconds: 1800,
            enabled: true,
            led_rotation: 0,
            led0_offset: 0,
            segments: Vec::new(),
            hw_ins: Vec::new(),
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "id": self.id, "name": self.name, "ip": self.ip, "udp_port": self.udp_port, "rgb_count": self.rgb_count,
            "pwm_index": self.pwm_index, "pwm_seg_id": self.pwm_seg_id, "default_pwm_brightness": self.default_pwm_brightness,
            "game_pwm_brightness": self.game_pwm_brightness, "idle_dim_seconds": self.idle_dim_seconds,
            "idle_dim_brightness": self.idle_dim_brightness, "idle_off_seconds": self.idle_off_seconds, "enabled": self.enabled,
            "led_rotation": self.led_rotation, "led0_offset": self.led0_offset,
            "segments": self.segments.iter().map(|s| s.to_value()).collect::<Vec<_>>(),
            "hw_ins": self.hw_ins,
        })
    }

    pub fn from_value(data: &Value, default_id: &str, default_pwm: i64) -> DeviceConfig {
        let Some(d) = data.as_object() else {
            let mut dc = DeviceConfig::new("");
            dc.id = default_id.into();
            return dc;
        };
        let mut segments: Vec<SegmentConfig> =
            arr(d.get("segments")).iter().enumerate().filter(|(_, s)| s.is_object()).map(|(i, s)| SegmentConfig::from_value(s, i as i64)).collect();
        let hw_ins: Vec<Value> = d.get("hw_ins").and_then(Value::as_array).cloned().unwrap_or_default();
        complete_segments_from_outputs(&mut segments, &hw_ins);
        let opt_int = |k: &str| d.get(k).filter(|v| !v.is_null()).map(|v| safe_int(Some(v), 0));
        let raw_offset = safe_int(d.get("led0_offset"), 0);
        let rot_default = py_round(raw_offset as f64 / 45.0 * 360.0);
        DeviceConfig {
            id: d.get("id").map(py_str).unwrap_or_else(|| default_id.into()),
            name: get_str(d, "name", "Main Dartboard WLED"),
            ip: get_str(d, "ip", ""),
            udp_port: safe_int(d.get("udp_port"), 21324),
            rgb_count: safe_int(d.get("rgb_count"), 45),
            pwm_index: opt_int("pwm_index"),
            pwm_seg_id: opt_int("pwm_seg_id"),
            default_pwm_brightness: safe_int(d.get("default_pwm_brightness"), default_pwm),
            game_pwm_brightness: d.get("game_pwm_brightness").filter(|v| !v.is_null()).map(|v| clamp(safe_int(Some(v), 255), 0, 255)),
            idle_dim_seconds: safe_int(d.get("idle_dim_seconds"), 300),
            idle_dim_brightness: safe_int(d.get("idle_dim_brightness"), 40),
            idle_off_seconds: safe_int(d.get("idle_off_seconds"), 1800),
            enabled: get_bool(d, "enabled", true),
            led_rotation: match d.get("led_rotation") {
                Some(v) if !v.is_null() => safe_int(Some(v), rot_default),
                _ => rot_default,
            },
            led0_offset: raw_offset,
            segments,
            hw_ins,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct DartEvent {
    pub event_type: Option<DartEventType>,
    pub score: i64,
    pub multiplier: i64,
    pub segment_number: Option<i64>,
    pub segment_name: Option<String>,
    pub player_name: Option<String>,
    pub player_index: Option<i64>,
    pub round_score: Option<i64>,
    pub board_id: Option<String>,
}

impl DartEvent {
    pub fn new(t: DartEventType) -> DartEvent {
        DartEvent { event_type: Some(t), multiplier: 1, ..Default::default() }
    }
    pub fn kind(&self) -> DartEventType {
        self.event_type.unwrap_or(DartEventType::Throw)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProfileConfig {
    pub name: String,
    /// event key -> effect, in insertion order
    pub events: Vec<(String, EffectConfig)>,
    pub player_slots: Vec<PlayerSlotConfig>,
}

impl ProfileConfig {
    pub fn event(&self, key: &str) -> Option<&EffectConfig> {
        self.events.iter().find(|(k, _)| k == key).map(|(_, e)| e)
    }

    pub fn set_event(&mut self, key: &str, eff: EffectConfig) {
        match self.events.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = eff,
            None => self.events.push((key.to_string(), eff)),
        }
    }

    /// The profile's effect for an event; every controller and segment using the profile plays it
    pub fn get_effect(&self, key: &str) -> Option<&EffectConfig> {
        let alt = match key {
            "calibration" => Some("calibrating"),
            "calibrating" => Some("calibration"),
            _ => None,
        };
        self.event(key).or_else(|| alt.and_then(|a| self.event(a)))
    }

    /// Resolve the throwing effect for a player: exact name, contains name, free slots for unnamed
    /// match players, slot by index, then the profile's throw effect.
    pub fn resolve_player_effect(&self, player_name: Option<&str>, player_index: Option<i64>, match_players: &[String]) -> Option<EffectConfig> {
        let defaults;
        let all: &[PlayerSlotConfig] = if self.player_slots.is_empty() {
            defaults = ProfileConfig::default_player_slots(None);
            &defaults
        } else {
            &self.player_slots
        };
        let p_name = player_name.map(|n| n.trim().to_lowercase()).unwrap_or_default();
        let p_idx = player_index.filter(|i| *i >= 0).unwrap_or(0);
        let first_pick = |name: &str, mt: NameMatchType, skip: &HashSet<i64>| all.iter().find(|s| !skip.contains(&s.id) && s.picks(name, mt));
        let none = HashSet::new();
        let is_named = |name: &str| all.iter().any(|s| s.picks(name, NameMatchType::Exact) || s.picks(name, NameMatchType::Contains));

        let mut target = if p_name.is_empty() {
            None
        } else {
            first_pick(&p_name, NameMatchType::Exact, &none).or_else(|| first_pick(&p_name, NameMatchType::Contains, &none))
        };
        if target.is_none() && !match_players.is_empty() {
            let mut claimed = HashSet::new();
            for m in match_players {
                let m_name = m.trim().to_lowercase();
                if m_name.is_empty() {
                    continue;
                }
                if let Some(e) = first_pick(&m_name, NameMatchType::Exact, &none) {
                    claimed.insert(e.id);
                }
                if let Some(c) = first_pick(&m_name, NameMatchType::Contains, &claimed) {
                    claimed.insert(c.id);
                }
            }
            let free: Vec<&PlayerSlotConfig> = all.iter().filter(|s| !claimed.contains(&s.id)).collect();
            if !free.is_empty() {
                let upto = (p_idx as usize).min(match_players.len());
                let rank = match_players[..upto].iter().filter(|p| !is_named(&p.trim().to_lowercase())).count();
                target = Some(free[rank % free.len()]);
            }
        }
        if target.is_none() {
            target = all.iter().find(|s| s.id == p_idx + 1);
        }
        if target.is_none() && !all.is_empty() {
            target = Some(&all[(p_idx as usize) % all.len()]);
        }
        if let Some(t) = target {
            if t.enabled && t.effect.enabled {
                return Some(t.effect.clone());
            }
        }
        if !all.iter().any(|s| s.enabled && s.effect.enabled) {
            return self.get_effect("throw").cloned();
        }
        Some(EffectConfig { enabled: false, ..Default::default() })
    }

    pub fn to_value(&self) -> Value {
        let events: Map<String, Value> = self.events.iter().map(|(k, v)| (k.clone(), v.to_value())).collect();
        json!({"name": self.name, "events": events, "player_slots": self.player_slots.iter().map(|s| s.to_value()).collect::<Vec<_>>()})
    }

    pub fn from_value(data: &Value) -> ProfileConfig {
        let mut profile = ProfileConfig::default_profile();
        let Some(d0) = data.as_object() else { return profile };
        let flattened;
        let d = match d0.get("device_events").and_then(Value::as_object) {
            Some(de) if !de.is_empty() => {
                let first = de.keys().next().cloned().unwrap_or_default();
                flattened = profile_dict_for_device(d0, &first);
                &flattened
            }
            _ => d0,
        };
        profile.name = get_str(d, "name", "Default");
        if let Some(evs) = d.get("events").and_then(Value::as_object) {
            for (k, v) in evs {
                profile.set_event(k, EffectConfig::from_value(Some(v)));
            }
        }
        if let Some(slots) = d.get("player_slots").and_then(Value::as_array) {
            profile.player_slots = slots.iter().enumerate().map(|(i, s)| PlayerSlotConfig::from_value(s, i as i64 + 1)).collect();
        }
        profile
    }

    pub fn default_player_slots(autodarts_name: Option<&str>) -> Vec<PlayerSlotConfig> {
        let p1 = autodarts_name.map(|n| n.trim().to_string()).unwrap_or_default();
        (1..=10)
            .map(|id| PlayerSlotConfig {
                id,
                name_filter: if id == 1 { p1.clone() } else { String::new() },
                match_type: NameMatchType::Contains,
                effect: EffectConfig::off_solid(),
                enabled: false,
            })
            .collect()
    }

    pub fn default_profile() -> ProfileConfig {
        let keys = [
            "180", "match_won", "leg_won", "bust", "triple", "double", "single", "bullseye", "game_start", "bull_off_start",
            "bull_off_won", "calibrating", "takeout", "takeout_in_progress", "manual_reset", "throw",
        ];
        ProfileConfig {
            name: "Default".into(),
            events: keys.iter().map(|k| (k.to_string(), EffectConfig::off_solid())).collect(),
            player_slots: ProfileConfig::default_player_slots(None),
        }
    }
}

const KNOWN_KEYS: [&str; 23] = [
    "devices", "profiles", "active_profile", "device_profiles", "segment_profiles", "profile", "global_brightness", "wifi_ip",
    "autodarts_user", "autodarts_password", "autodarts_board_id", "ai_key", "gemini_api_key", "game_mode_spotlight_brightness",
    "lighting_mode", "auto_connect_udp_on_game_start", "disconnect_udp_on_match_end", "inactivity_timeout_enabled",
    "inactivity_timeout_minutes", "idle_power_off_enabled", "idle_power_off_minutes", "idle_dimming_brightness", "device",
];

#[derive(Clone, Debug, PartialEq)]
pub struct AppConfig {
    pub devices: Vec<DeviceConfig>,
    pub profiles: Vec<ProfileConfig>,
    pub active_profile: String,
    /// Controller IP -> profile name it uses; controllers not listed use active_profile
    pub device_profiles: Obj,
    /// Controller IP -> segment id -> profile name; segments not listed use their controller's profile
    pub segment_profiles: BTreeMap<String, Obj>,
    pub global_brightness: i64,
    pub wifi_ip: String,
    pub autodarts_user: String,
    pub autodarts_password: String,
    pub autodarts_board_id: String,
    pub game_mode_spotlight_brightness: i64,
    pub lighting_mode: LightingMode,
    pub auto_connect_udp_on_game_start: bool,
    pub disconnect_udp_on_match_end: bool,
    pub inactivity_timeout_enabled: bool,
    pub inactivity_timeout_minutes: i64,
    pub idle_power_off_enabled: bool,
    pub idle_power_off_minutes: i64,
    pub idle_dimming_brightness: i64,
    pub extra: Obj,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            devices: Vec::new(),
            profiles: vec![ProfileConfig::default_profile()],
            active_profile: "Default".into(),
            device_profiles: Obj::new(),
            segment_profiles: BTreeMap::new(),
            global_brightness: 200,
            wifi_ip: String::new(),
            autodarts_user: String::new(),
            autodarts_password: String::new(),
            autodarts_board_id: String::new(),
            game_mode_spotlight_brightness: 255,
            lighting_mode: LightingMode::Flow,
            auto_connect_udp_on_game_start: true,
            disconnect_udp_on_match_end: false,
            inactivity_timeout_enabled: true,
            inactivity_timeout_minutes: 5,
            idle_power_off_enabled: true,
            idle_power_off_minutes: 30,
            idle_dimming_brightness: 50,
            extra: Obj::new(),
        }
    }
}

impl AppConfig {
    pub fn get_profile(&self, name: &str) -> Option<&ProfileConfig> {
        self.profiles.iter().find(|p| p.name == name)
    }

    pub fn get_profile_mut(&mut self, name: &str) -> Option<&mut ProfileConfig> {
        self.profiles.iter_mut().find(|p| p.name == name)
    }

    /// The active profile (AppConfig.profile in the Python version)
    pub fn profile(&self) -> &ProfileConfig {
        self.get_profile(&self.active_profile).unwrap_or(&self.profiles[0])
    }

    /// Keep the active profile pointing at an existing one, like __post_init__ / to_dict did
    pub fn normalize(&mut self) {
        if self.profiles.is_empty() {
            self.profiles.push(ProfileConfig::default_profile());
        }
        if self.get_profile(&self.active_profile).is_none() {
            self.active_profile = self.profiles[0].name.clone();
        }
    }

    /// Name of the profile a segment uses: its own choice, else its controller's, else the active profile
    pub fn profile_name_for(&self, ip: Option<&str>, seg_id: Option<i64>) -> String {
        if let (Some(ip), Some(sid)) = (ip, seg_id) {
            if let Some(n) = self.segment_profiles.get(ip).and_then(|s| s.get(&sid.to_string())).map(py_str) {
                if self.get_profile(&n).is_some() {
                    return n;
                }
            }
        }
        if let Some(ip) = ip {
            if let Some(n) = self.device_profiles.get(ip).map(py_str) {
                if self.get_profile(&n).is_some() {
                    return n;
                }
            }
        }
        self.active_profile.clone()
    }

    pub fn profile_for(&self, ip: Option<&str>, seg_id: Option<i64>) -> &ProfileConfig {
        self.get_profile(&self.profile_name_for(ip, seg_id)).unwrap_or_else(|| self.profile())
    }

    /// Controller-wide choice: every segment follows it, replacing any segment choices
    pub fn set_device_profile(&mut self, ip: &str, name: &str) -> bool {
        if ip.is_empty() || self.get_profile(name).is_none() {
            return false;
        }
        self.device_profiles.insert(ip.into(), json!(name));
        self.segment_profiles.remove(ip);
        true
    }

    pub fn set_segment_profile(&mut self, ip: &str, seg_id: i64, name: &str) -> bool {
        if ip.is_empty() || self.get_profile(name).is_none() {
            return false;
        }
        self.segment_profiles.entry(ip.into()).or_default().insert(seg_id.to_string(), json!(name));
        true
    }

    pub fn rename_profile_refs(&mut self, old: &str, new: &str) {
        for v in self.device_profiles.values_mut() {
            if py_str(v) == old {
                *v = json!(new);
            }
        }
        for segs in self.segment_profiles.values_mut() {
            for v in segs.values_mut() {
                if py_str(v) == old {
                    *v = json!(new);
                }
            }
        }
    }

    pub fn drop_profile_refs(&mut self, name: &str) {
        self.device_profiles.retain(|_, v| py_str(v) != name);
        for segs in self.segment_profiles.values_mut() {
            segs.retain(|_, v| py_str(v) != name);
        }
        self.segment_profiles.retain(|_, s| !s.is_empty());
    }

    pub fn set_active_profile(&mut self, name: &str) -> bool {
        if self.get_profile(name).is_some() {
            self.active_profile = name.into();
            true
        } else {
            false
        }
    }

    pub fn add_or_update_profile(&mut self, profile: ProfileConfig, set_active: bool) {
        let name = profile.name.clone();
        if let Some(p) = self.profiles.iter_mut().find(|p| p.name == name) {
            *p = profile;
            if set_active {
                self.active_profile = name;
            }
            return;
        }
        self.profiles.push(profile);
        if set_active {
            self.active_profile = name;
        }
    }

    pub fn primary_device(&self) -> Option<&DeviceConfig> {
        self.devices.first()
    }

    /// All configured and enabled controller IP addresses
    pub fn active_ips(&self) -> Vec<String> {
        let mut ips: Vec<String> = self.devices.iter().filter(|d| d.enabled && !d.ip.trim().is_empty()).map(|d| d.ip.trim().to_string()).collect();
        if ips.is_empty() && !self.wifi_ip.trim().is_empty() {
            ips.push(self.wifi_ip.trim().to_string());
        }
        ips
    }

    pub fn to_value(&mut self) -> Value {
        self.normalize();
        let mut out = crate::obj! {
            "devices" => self.devices.iter().map(|d| d.to_value()).collect::<Vec<_>>(),
            "profiles" => self.profiles.iter().map(|p| p.to_value()).collect::<Vec<_>>(),
            "active_profile" => self.active_profile,
            "device_profiles" => self.device_profiles,
            "segment_profiles" => self.segment_profiles,
            "profile" => self.profile().to_value(),
            "global_brightness" => self.global_brightness,
            "wifi_ip" => self.devices.first().map(|d| d.ip.clone()).unwrap_or_else(|| self.wifi_ip.clone()),
            "autodarts_user" => self.autodarts_user,
            "autodarts_password" => self.autodarts_password,
            "autodarts_board_id" => self.autodarts_board_id,
            "game_mode_spotlight_brightness" => self.game_mode_spotlight_brightness,
            "lighting_mode" => self.lighting_mode.as_str(),
            "auto_connect_udp_on_game_start" => self.auto_connect_udp_on_game_start,
            "disconnect_udp_on_match_end" => self.disconnect_udp_on_match_end,
            "inactivity_timeout_enabled" => self.inactivity_timeout_enabled,
            "inactivity_timeout_minutes" => self.inactivity_timeout_minutes,
            "idle_power_off_enabled" => self.idle_power_off_enabled,
            "idle_dimming_brightness" => self.idle_dimming_brightness,
            "idle_power_off_minutes" => self.idle_power_off_minutes,
        };
        for (k, v) in &self.extra {
            if !out.contains_key(k) {
                out.insert(k.clone(), v.clone());
            }
        }
        Value::Object(out)
    }

    pub fn from_value(data: &Value) -> AppConfig {
        let Some(d) = data.as_object() else { return AppConfig::default() };
        let gb = safe_int(d.get("global_brightness"), 200);
        let mut devices = Vec::new();
        let raw_devices = arr(d.get("devices"));
        if !raw_devices.is_empty() {
            for (i, dv) in raw_devices.iter().enumerate() {
                if dv.is_object() && dv.get("ip").map_or(false, truthy) {
                    devices.push(DeviceConfig::from_value(dv, &format!("device_{}", i + 1), gb));
                }
            }
        } else if let Some(w) = non_empty(d.get("wifi_ip")) {
            let mut dc = DeviceConfig::new(&py_str(w));
            dc.default_pwm_brightness = gb;
            devices.push(dc);
        }

        let mut raw_profiles: Vec<Value> = arr(d.get("profiles")).to_vec();
        let mut raw_dp = obj_or_empty(d.get("device_profiles"));
        if raw_profiles.iter().any(|p| p.get("device_events").map_or(false, truthy)) {
            let active = get_str(d, "active_profile", "");
            let active = if active.trim().is_empty() { "Default".to_string() } else { active.trim().to_string() };
            let (p, a) = split_device_profiles(&raw_profiles, &devices, &raw_dp, &active);
            raw_profiles = p;
            raw_dp = a;
        }
        let mut profiles: Vec<ProfileConfig> = raw_profiles.iter().filter(|p| p.is_object()).map(ProfileConfig::from_value).collect();
        let single = d.get("profile").filter(|p| p.is_object()).map(ProfileConfig::from_value);
        if profiles.is_empty() {
            profiles = vec![single.clone().unwrap_or_else(ProfileConfig::default_profile)];
        }
        let mut active = get_str(d, "active_profile", "").trim().to_string();
        if active.is_empty() {
            active = single.as_ref().map(|s| s.name.clone()).unwrap_or_else(|| profiles[0].name.clone());
        }
        if !profiles.iter().any(|p| p.name == active) {
            active = profiles[0].name.clone();
        }
        let names: HashSet<String> = profiles.iter().map(|p| p.name.clone()).collect();
        let device_profiles: Obj = raw_dp
            .iter()
            .filter(|(ip, n)| !ip.trim().is_empty() && names.contains(&py_str(n)))
            .map(|(ip, n)| (ip.trim().to_string(), json!(py_str(n))))
            .collect();
        let mut segment_profiles = BTreeMap::new();
        if let Some(sp) = d.get("segment_profiles").and_then(Value::as_object) {
            for (ip, segs) in sp {
                let Some(segs) = segs.as_object() else { continue };
                if ip.trim().is_empty() {
                    continue;
                }
                let kept: Obj = segs.iter().filter(|(_, n)| names.contains(&py_str(n))).map(|(s, n)| (s.clone(), json!(py_str(n)))).collect();
                segment_profiles.insert(ip.trim().to_string(), kept);
            }
        }
        let extra: Obj = d.iter().filter(|(k, _)| !KNOWN_KEYS.contains(&k.as_str()) && k.as_str() != "status").map(|(k, v)| (k.clone(), v.clone())).collect();
        AppConfig {
            wifi_ip: devices.first().map(|dv| dv.ip.clone()).unwrap_or_else(|| get_str(d, "wifi_ip", "")),
            devices,
            profiles,
            active_profile: active,
            device_profiles,
            segment_profiles,
            global_brightness: gb,
            autodarts_user: get_str(d, "autodarts_user", ""),
            autodarts_password: get_str(d, "autodarts_password", ""),
            autodarts_board_id: get_str(d, "autodarts_board_id", ""),
            game_mode_spotlight_brightness: safe_int(d.get("game_mode_spotlight_brightness"), 255),
            lighting_mode: LightingMode::parse(&get_str(d, "lighting_mode", "")),
            auto_connect_udp_on_game_start: get_bool(d, "auto_connect_udp_on_game_start", true),
            disconnect_udp_on_match_end: get_bool(d, "disconnect_udp_on_match_end", false),
            inactivity_timeout_enabled: get_bool(d, "inactivity_timeout_enabled", true),
            inactivity_timeout_minutes: 1.max(safe_int(d.get("inactivity_timeout_minutes"), 5)),
            idle_power_off_enabled: get_bool(d, "idle_power_off_enabled", true),
            idle_power_off_minutes: 1.max(safe_int(d.get("idle_power_off_minutes"), 30)),
            idle_dimming_brightness: clamp(safe_int(d.get("idle_dimming_brightness"), 50), 0, 255),
            extra,
        }
    }
}
