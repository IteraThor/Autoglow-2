//! Studio (TV-style broadcast overlay): the Studio players (name + picture), camera choice and overlay
//! settings, and the live Autodarts match state turned into a compact scoreboard for web/studio/live.html.
//! Everything lives in studio/ next to config.json: studio.json plus one picture per player.

use crate::py::*;
use crate::storage::project_root;
use log::warn;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_NAME_LENGTH: usize = 40;
pub const PROFILE_FIELDS: [(&str, usize); 12] = [
    ("alias", MAX_NAME_LENGTH), ("country", 3), ("nickname", 40), ("club", 60), ("hometown", 60), ("hand", 10), ("dart_weight", 10),
    ("favourite_double", 10), ("playing_since", 10), ("stat_average", 10), ("stat_180s", 10), ("stat_best_checkout", 10),
];
const PICTURE_SLOTS: [&str; 2] = ["image", "mockup"];
const THEMES: [&str; 8] = ["autodarts", "tv", "arena", "neon", "velocity", "glass", "pub", "daylight"];
const LAYOUTS: [&str; 3] = ["split", "board", "player"];
const MAX_TEXT_LENGTH: usize = 80;

type Item = (&'static str, &'static str, &'static str);
pub const TEXT_GROUPS: &[(&str, &[Item])] = &[
    ("Logo", &[("brand_main", "Logo, first word", "AutoGlow"), ("brand_accent", "Logo, second word (accent colour)", "Studio")]),
    (
        "Idle screen",
        &[
            ("idle_kicker", "Line above the title", "Live darts"),
            ("idle_tagline", "Line under the title (when no subtitle is set)", "Next match starts with the first game on Autodarts"),
            ("idle_ready", "Status when ready", "Ready \u{2013} pick the players on Autodarts"),
        ],
    ),
    (
        "Up next",
        &[("lobby_kicker", "Versus card title", "Up next"), ("lobby_status", "Status line", "Match starts soon"), ("idle_player_kicker", "Player card, when no club is set", "Player profile")],
    ),
    ("Scoreboard", &[("board_sets", "Sets column", "Sets"), ("board_legs", "Legs column", "Legs"), ("board_set", "Set (as in Set 2)", "Set"), ("board_leg", "Leg (as in Leg 3)", "Leg")]),
    ("Player card", &[("card_avg", "Average", "3-dart avg"), ("card_round", "Round", "Round")]),
    ("Darts of the visit", &[("visit_checkout", "Checkout hint", "Checkout"), ("visit_bust", "Bust in the visit", "BUST"), ("visit_nine", "9-darter alert", "9-darter on")]),
    ("Mini dartboard", &[]),
    (
        "Big moments",
        &[
            ("moment_180", "180", "180"), ("moment_game_shot", "Leg won", "GAME SHOT"), ("moment_set", "Set won", "SET WON"), ("moment_bust", "Bust", "BUST"),
            ("moment_nine", "Nine-darter", "NINE-DARTER"), ("moment_match", "Match won", "MATCH WON"),
        ],
    ),
    ("Player intro", &[("intro_vs", "Versus badge", "VS")]),
    (
        "Bull-off",
        &[
            ("bulloff_title", "Title", "Bull-off"),
            ("bulloff_rule_normal", "Rule: closest to the bull (WDF)", "Closest to the bull throws first"),
            ("bulloff_rule_official", "Rule: bull or 25 only (PDC)", "Bull beats 25 \u{2013} anything else throws again"),
            ("bulloff_round", "Round (as in Round 2)", "Round"), ("bulloff_turn", "Player at the board", "Throwing"), ("bulloff_leader", "Best dart so far", "Closest"),
            ("bulloff_first", "Winner", "Throws first"), ("bulloff_tie", "Tie banner", "TIE"), ("bulloff_again", "Under the tie banner", "Throw again"),
        ],
    ),
    (
        "Cards",
        &[
            ("leg_title", "Leg card title", "Game shot"), ("set_title", "Set card title", "Set won"), ("match_winner", "Match card", "Winner"),
            ("fact_from", "Player fact: hometown", "From"), ("fact_throws", "Player fact: hand", "Throws"), ("fact_darts", "Player fact: dart weight", "Darts"),
            ("fact_since", "Player fact: playing since", "Playing since"),
        ],
    ),
    (
        "Statistics",
        &[
            ("stat_average", "Average", "Average"), ("stat_first9", "First 9 average", "First 9 avg"), ("stat_180s", "180s", "180s"), ("stat_140", "140+", "140+"),
            ("stat_100", "100+", "100+"), ("stat_checkout_pct", "Checkout %", "Checkout %"), ("stat_best_checkout", "Best checkout", "Best checkout"),
            ("stat_checkout", "Checkout (leg card)", "Checkout"), ("stat_darts", "Darts", "Darts"), ("stat_leg_average", "Leg average", "Leg average"),
            ("stat_fav_double", "Favourite double", "Favourite double"),
        ],
    ),
];

fn text_group_where(n: &str) -> &'static str {
    match n {
        "Logo" => "Idle screen, corner logo during the match, transitions",
        "Idle screen" => "Between matches, while no players are picked in Autodarts",
        "Up next" => "Before the match: the two players picked in the Autodarts lobby, face to face and one by one",
        "Scoreboard" => "During the match: the score rows",
        "Player card" => "During the match: pictures and averages of the players",
        "Darts of the visit" => "During the match: the darts thrown, checkout hint and 9-darter alert",
        "Mini dartboard" => "During the match: a small board with where the darts landed (no texts)",
        "Big moments" => "Large banners after a 180, a won leg or set, a bust, a nine-darter, the match",
        "Player intro" => "Versus intro when a match starts",
        "Bull-off" => "Before the first leg, when the Autodarts lobby is set to a bull-off: who throws first",
        "Cards" => "Leg card, match end card, player profiles",
        "Statistics" => "Match end card, leg card, intro and player profiles",
        _ => "",
    }
}

fn text_group_toggle(n: &str) -> Value {
    match n {
        "Idle screen" => json!({"key": "idle_blur", "label": "Blurred board camera behind it", "show": false}),
        "Player card" => json!({"key": "show_player_card", "label": "Show", "show": true}),
        "Darts of the visit" => json!({"key": "show_checkout", "label": "Show", "show": true}),
        "Mini dartboard" => json!({"key": "show_dartboard", "label": "Show", "show": true}),
        "Player intro" => json!({"key": "show_intro", "label": "Show", "show": true}),
        _ => Value::Null,
    }
}

fn text_default(key: &str) -> Option<&'static str> {
    TEXT_GROUPS.iter().flat_map(|(_, items)| items.iter()).find(|(k, _, _)| *k == key).map(|(_, _, d)| *d)
}

/// Defaults of the editable texts and their groups for the Studio page
pub fn text_info() -> Obj {
    let defaults: Obj = TEXT_GROUPS.iter().flat_map(|(_, i)| i.iter()).map(|(k, _, d)| (k.to_string(), json!(d))).collect();
    let groups: Vec<Value> = TEXT_GROUPS
        .iter()
        .map(|(n, items)| json!({"name": n, "where": text_group_where(n), "toggle": text_group_toggle(n), "items": items.iter().map(|(k, l, _)| json!({"key": k, "label": l})).collect::<Vec<_>>()}))
        .collect();
    crate::obj! {"text_defaults" => defaults, "text_groups" => groups}
}

pub fn studio_dir() -> PathBuf {
    project_root().join("studio")
}
fn players_dir() -> PathBuf {
    studio_dir().join("players")
}
fn settings_file() -> PathBuf {
    studio_dir().join("studio.json")
}

fn re(cell: &'static OnceLock<Regex>, p: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(p).unwrap())
}
static ID_RE: OnceLock<Regex> = OnceLock::new();
static IMG_RE: OnceLock<Regex> = OnceLock::new();
static ACCENT_RE: OnceLock<Regex> = OnceLock::new();

/// Python round(x, n)
pub fn roundn(x: f64, n: i32) -> f64 {
    let m = 10f64.powi(n);
    (x * m).round() / m
}

/// A number (not a bool) clamped and rounded to 3 places, else the default
fn clampf(v: Option<&Value>, lo: f64, hi: f64, d: f64) -> f64 {
    match v {
        Some(Value::Number(n)) => roundn(n.as_f64().unwrap_or(d).max(lo).min(hi), 3),
        _ => d,
    }
}

fn s_trunc(v: Option<&Value>, d: &str, n: usize) -> String {
    v.map(py_str).unwrap_or_else(|| d.into()).chars().take(n).collect()
}

fn clean_warp(raw: Option<&Value>) -> Value {
    let Some(r) = raw.and_then(Value::as_object) else { return Value::Null };
    let Some(pts) = r.get("points").and_then(Value::as_array).filter(|p| p.len() == 4) else { return Value::Null };
    let mut clean = Vec::new();
    for p in pts {
        let Some(a) = p.as_array().filter(|a| a.len() == 2) else { return Value::Null };
        if a.iter().any(|v| !v.is_number()) {
            return Value::Null;
        }
        clean.push(json!([clampf(a.first(), 0.0, 1.0, 0.5), clampf(a.get(1), 0.0, 1.0, 0.5)]));
    }
    json!({"points": clean, "strength": clampf(r.get("strength"), 0.0, 1.0, 0.5), "sharpen": clampf(r.get("sharpen"), 0.0, 1.0, 0.5)})
}

fn default_camera() -> Obj {
    crate::obj! {"kind" => "none", "device_id" => "", "label" => "", "url" => "", "mirror" => false, "rotation" => 0,
                 "zoom" => 1.0, "pan_x" => 0.0, "pan_y" => 0.0, "warp" => Value::Null, "controls" => {}}
}

fn clean_camera(raw: Option<&Value>) -> Obj {
    let mut cam = default_camera();
    let Some(r) = raw.and_then(Value::as_object) else { return cam };
    let kind = get_str(r, "kind", "none");
    cam.insert("kind".into(), json!(if ["none", "server", "device", "url", "mockup"].contains(&kind.as_str()) { kind } else { "none".into() }));
    cam.insert("device_id".into(), json!(s_trunc(r.get("device_id"), "", 256)));
    cam.insert("label".into(), json!(s_trunc(r.get("label"), "", 200)));
    cam.insert("url".into(), json!(s_trunc(r.get("url"), "", 500)));
    cam.insert("mirror".into(), json!(get_bool(r, "mirror", false)));
    let rot = r.get("rotation").and_then(|v| if v.is_i64() { v.as_i64() } else { None }).filter(|x| [0, 90, 180, 270].contains(x)).unwrap_or(0);
    cam.insert("rotation".into(), json!(rot));
    cam.insert("zoom".into(), json!(clampf(r.get("zoom"), 1.0, 4.0, 1.0)));
    cam.insert("pan_x".into(), json!(clampf(r.get("pan_x"), -1.0, 1.0, 0.0)));
    cam.insert("pan_y".into(), json!(clampf(r.get("pan_y"), -1.0, 1.0, 0.0)));
    cam.insert("warp".into(), clean_warp(r.get("warp")));
    cam.insert("controls".into(), Value::Object(crate::studio_camera::clean_control_values(r.get("controls"))));
    cam
}

fn clean_dart_zoom(raw: Option<&Value>) -> Value {
    let e = Obj::new();
    let r = raw.and_then(Value::as_object).unwrap_or(&e);
    let delay = clampf(r.get("delay"), 0.5, 5.0, 2.0);
    json!({"enabled": get_bool(r, "enabled", false), "delay": delay, "zoom": clampf(r.get("zoom"), 1.2, 4.0, 2.5),
           "lead": clampf(r.get("lead"), 0.0, 4.5, 1.0).min(roundn(delay - 0.3, 3)), "hold": clampf(r.get("hold"), 0.5, 8.0, 2.0)})
}

fn clean_profile(raw: &Obj) -> Obj {
    let mut p = Obj::new();
    for (k, lim) in PROFILE_FIELDS {
        let mut v: String = non_empty(raw.get(k)).map(py_str).unwrap_or_default().trim().chars().take(lim).collect();
        if k == "country" {
            v = v.to_uppercase();
        }
        p.insert(k.into(), json!(v));
    }
    p
}

fn clean_player(raw: &Value) -> Option<Obj> {
    let r = raw.as_object()?;
    let id = r.get("id").map(py_str).unwrap_or_default();
    if !re(&ID_RE, r"^[a-f0-9]{12}$").is_match(&id) {
        return None;
    }
    let name: String = get_str(r, "name", "").trim().chars().take(MAX_NAME_LENGTH).collect();
    if name.is_empty() {
        return None;
    }
    let mut p = crate::obj! {"id" => id, "name" => name};
    for slot in PICTURE_SLOTS {
        let pic = r.get(slot).map(py_str).unwrap_or_default();
        p.insert(slot.into(), json!(if !pic.is_empty() && players_dir().join(&pic).is_file() { pic } else { String::new() }));
    }
    p.extend(clean_profile(r));
    Some(p)
}

fn clean_texts(raw: Option<&Value>) -> Obj {
    let mut out = Obj::new();
    if let Some(r) = raw.and_then(Value::as_object) {
        for (k, v) in r {
            if let (Some(d), Value::String(s)) = (text_default(k), v) {
                let s: String = s.trim().chars().take(MAX_TEXT_LENGTH).collect();
                if !s.is_empty() && s != d {
                    out.insert(k.clone(), json!(s));
                }
            }
        }
    }
    out
}

pub fn clean_settings(raw: Option<&Value>) -> Obj {
    let e = Obj::new();
    let r = raw.and_then(Value::as_object).unwrap_or(&e);
    let accent = get_str(r, "accent", "#1fa34a");
    let pick = |k: &str, list: &[&str], d: &str| -> String {
        r.get(k).and_then(Value::as_str).filter(|v| list.contains(v)).unwrap_or(d).to_string()
    };
    let res = get_str(r, "camera_resolution", "720p");
    let fps = r.get("relay_fps").and_then(|v| if v.is_i64() { v.as_i64() } else { None }).filter(|f| [10, 15, 30].contains(f)).unwrap_or(15);
    let cams = obj_or_empty(r.get("cameras"));
    let hideable: HashSet<String> = TEXT_GROUPS.iter().flat_map(|(_, i)| i.iter()).map(|(k, _, _)| k.to_string()).chain(["event_title".into(), "event_subtitle".into()]).collect();
    let hidden: Vec<String> = match r.get("hidden_texts") {
        Some(Value::Array(a)) => {
            let mut v: Vec<String> = a.iter().filter_map(Value::as_str).filter(|k| hideable.contains(*k)).map(str::to_string).collect::<HashSet<_>>().into_iter().collect();
            v.sort();
            v
        }
        _ => Vec::new(),
    };
    crate::obj! {
        "title" => s_trunc(r.get("title"), "AutoGlow Darts Studio", 80),
        "subtitle" => s_trunc(r.get("subtitle"), "", 80),
        "accent" => if re(&ACCENT_RE, r"^#[0-9a-fA-F]{6}$").is_match(&accent) { accent } else { "#1fa34a".into() },
        "show_player_card" => get_bool(r, "show_player_card", true),
        "show_checkout" => get_bool(r, "show_checkout", true),
        "show_dartboard" => get_bool(r, "show_dartboard", true),
        "show_intro" => get_bool(r, "show_intro", true),
        "show_overlay" => get_bool(r, "show_overlay", true),
        "texts" => clean_texts(r.get("texts")),
        "hidden_texts" => hidden,
        "idle_blur" => get_bool(r, "idle_blur", true),
        "auto_direct" => get_bool(r, "auto_direct", true),
        "layout" => pick("layout", &LAYOUTS, "split"),
        "theme" => pick("theme", &THEMES, "autodarts"),
        "camera_resolution" => if ["480p", "720p", "1080p"].contains(&res.as_str()) { res } else { "720p".into() },
        "relay_fps" => fps,
        "dart_zoom" => clean_dart_zoom(r.get("dart_zoom")),
        "cameras" => json!({"board": clean_camera(cams.get("board")), "player": clean_camera(cams.get("player"))}),
        "players" => arr(r.get("players")).iter().filter_map(clean_player).collect::<Vec<_>>(),
    }
}

/// The Studio's state on disk, with a cache for the scoreboard polls (several per second)
pub struct Studio {
    lock: Mutex<()>,
    cache: Mutex<(Option<std::time::SystemTime>, Option<Obj>)>,
    pub cue: Mutex<Option<Value>>,
}

impl Studio {
    pub fn new() -> Studio {
        Studio { lock: Mutex::new(()), cache: Mutex::new((None, None)), cue: Mutex::new(None) }
    }

    pub fn load_settings(&self) -> Obj {
        match std::fs::read_to_string(settings_file()) {
            Ok(t) => match serde_json::from_str::<Value>(&t) {
                Ok(v) => clean_settings(Some(&v)),
                Err(e) => {
                    warn!("Could not read {}: {}", settings_file().display(), e);
                    clean_settings(None)
                }
            },
            Err(_) => clean_settings(None),
        }
    }

    /// Settings read again only when the file changed
    pub fn cached_settings(&self) -> Obj {
        let mtime = std::fs::metadata(settings_file()).and_then(|m| m.modified()).ok();
        let mut c = self.cache.lock().unwrap();
        if c.1.is_none() || c.0 != mtime {
            c.1 = Some(self.load_settings());
            c.0 = mtime;
        }
        c.1.clone().unwrap()
    }

    fn write(&self, s: &Obj) -> Result<(), String> {
        let mut buf = Vec::new();
        let fmt = serde_json::ser::PrettyFormatter::with_indent(b"  ");
        let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
        serde::Serialize::serialize(&Value::Object(s.clone()), &mut ser).map_err(|e| e.to_string())?;
        crate::storage::write_atomic(&settings_file(), &buf).map_err(|e| e.to_string())?;
        *self.cache.lock().unwrap() = (None, None);
        Ok(())
    }

    /// Save the overlay settings and cameras; the player list keeps its stored pictures
    pub fn save_settings(&self, raw: &Obj) -> Result<Obj, String> {
        let _g = self.lock.lock().unwrap();
        let current = self.load_settings();
        let mut merged = current.clone();
        for (k, v) in raw {
            merged.insert(k.clone(), v.clone());
        }
        let mut incoming = clean_settings(Some(&Value::Object(merged)));
        let stored: BTreeMap<String, Obj> = arr(current.get("players")).iter().filter_map(|p| p.as_object()).map(|p| (py_str(&p["id"]), p.clone())).collect();
        let players: Vec<Value> = arr(incoming.get("players"))
            .iter()
            .filter_map(|p| p.as_object())
            .filter_map(|p| {
                let id = py_str(&p["id"]);
                stored.get(&id).map(|s| {
                    let mut q = p.clone();
                    for slot in PICTURE_SLOTS {
                        q.insert(slot.into(), s[slot].clone());
                    }
                    Value::Object(q)
                })
            })
            .collect();
        incoming.insert("players".into(), Value::Array(players));
        self.write(&incoming)?;
        Ok(incoming)
    }

    /// Create a player (no id) or update one; a picture left as None stays as it is
    pub fn upsert_player(&self, player_id: Option<&str>, name: &str, profile: &Obj, image: Option<Vec<u8>>, mockup: Option<Vec<u8>>) -> Result<Obj, PlayerError> {
        let name: String = name.trim().chars().take(MAX_NAME_LENGTH).collect();
        if name.is_empty() {
            return Err(PlayerError::Invalid("Player name is required".into()));
        }
        let mut uploads = Vec::new();
        for (slot, data) in [("image", image), ("mockup", mockup)] {
            if let Some(d) = data {
                let ext = picture_type(&d).map_err(PlayerError::Invalid)?;
                uploads.push((slot, d, ext));
            }
        }
        let _g = self.lock.lock().unwrap();
        let mut settings = self.load_settings();
        let mut players: Vec<Obj> = arr(settings.get("players")).iter().filter_map(|p| p.as_object().cloned()).collect();
        let idx = match player_id {
            Some(id) => players.iter().position(|p| p["id"] == json!(id)).ok_or(PlayerError::NotFound)?,
            None => {
                let id = hex::encode(rand::random::<[u8; 6]>());
                players.push(crate::obj! {"id" => id, "image" => "", "mockup" => ""});
                players.len() - 1
            }
        };
        let p = &mut players[idx];
        p.insert("name".into(), json!(name));
        p.extend(clean_profile(profile));
        for (slot, data, ext) in uploads {
            let _ = std::fs::create_dir_all(players_dir());
            let fname = format!("{}-{}.{}", py_str(&p["id"]), hex::encode(rand::random::<[u8; 3]>()), ext);
            std::fs::write(players_dir().join(&fname), &data).map_err(|e| PlayerError::Invalid(e.to_string()))?;
            remove_image(&p.get(slot).map(py_str).unwrap_or_default());
            p.insert(slot.into(), json!(fname));
        }
        let out = p.clone();
        settings.insert("players".into(), json!(players));
        self.write(&settings).map_err(PlayerError::Invalid)?;
        Ok(out)
    }

    /// Save an Autodarts name as this player's Autodarts name; another player with that name loses it
    pub fn remember_autodarts_name(&self, player_id: &str, ad_name: &str) -> Result<Obj, PlayerError> {
        let ad: String = ad_name.trim().chars().take(MAX_NAME_LENGTH).collect();
        if ad.is_empty() {
            return Err(PlayerError::Invalid("Autodarts name is required".into()));
        }
        let _g = self.lock.lock().unwrap();
        let mut settings = self.load_settings();
        let mut players: Vec<Obj> = arr(settings.get("players")).iter().filter_map(|p| p.as_object().cloned()).collect();
        let idx = players.iter().position(|p| p["id"] == json!(player_id)).ok_or(PlayerError::NotFound)?;
        for (i, o) in players.iter_mut().enumerate() {
            if i != idx && o.get("alias").map(py_str).unwrap_or_default().to_lowercase() == ad.to_lowercase() {
                o.insert("alias".into(), json!(""));
            }
        }
        let same = py_str(&players[idx]["name"]).to_lowercase() == ad.to_lowercase();
        players[idx].insert("alias".into(), json!(if same { String::new() } else { ad }));
        settings.insert("players".into(), json!(players));
        self.write(&settings).map_err(PlayerError::Invalid)?;
        Ok(settings)
    }

    pub fn delete_player(&self, player_id: &str) -> Result<(), PlayerError> {
        let _g = self.lock.lock().unwrap();
        let mut settings = self.load_settings();
        let mut players: Vec<Obj> = arr(settings.get("players")).iter().filter_map(|p| p.as_object().cloned()).collect();
        let idx = players.iter().position(|p| p["id"] == json!(player_id)).ok_or(PlayerError::NotFound)?;
        for slot in PICTURE_SLOTS {
            remove_image(&players[idx].get(slot).map(py_str).unwrap_or_default());
        }
        players.remove(idx);
        settings.insert("players".into(), json!(players));
        self.write(&settings).map_err(PlayerError::Invalid)
    }

    /// Picture controls saved for a USB camera (in whichever slot shows it), applied when it opens
    pub fn saved_controls(&self, cam_id: &str) -> Vec<(u32, i32)> {
        let s = self.cached_settings();
        for cam in obj_or_empty(s.get("cameras")).values() {
            if cam["kind"] == json!("server") && cam["device_id"] == json!(cam_id) {
                let c = obj_or_empty(cam.get("controls"));
                if !c.is_empty() {
                    return c.iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_i64()? as i32))).collect();
                }
            }
        }
        Vec::new()
    }

    /// Merge control values into the saved controls of a slot that shows this camera (replace: only these)
    pub fn save_camera_controls(&self, slot: &str, cam_id: &str, values: &Obj, replace: bool) {
        let _g = self.lock.lock().unwrap();
        let mut s = self.load_settings();
        let Some(Value::Object(cams)) = s.get_mut("cameras") else { return };
        let Some(Value::Object(cam)) = cams.get_mut(slot) else { return };
        if cam.get("kind") != Some(&json!("server")) || cam.get("device_id") != Some(&json!(cam_id)) {
            return;
        }
        let mut merged = if replace { Obj::new() } else { obj_or_empty(cam.get("controls")) };
        merged.extend(values.clone());
        cam.insert("controls".into(), Value::Object(crate::studio_camera::clean_control_values(Some(&Value::Object(merged)))));
        let _ = self.write(&s);
    }
}

pub enum PlayerError {
    Invalid(String),
    NotFound,
}

fn detect_image_type(d: &[u8]) -> Option<&'static str> {
    if d.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if d.starts_with(b"\xff\xd8\xff") {
        Some("jpg")
    } else if d.starts_with(b"RIFF") && d.get(8..12) == Some(b"WEBP") {
        Some("webp")
    } else {
        None
    }
}

fn picture_type(d: &[u8]) -> Result<&'static str, String> {
    if d.len() > MAX_IMAGE_BYTES {
        return Err("Picture is larger than 5 MB".into());
    }
    detect_image_type(d).ok_or_else(|| "Picture must be a PNG, JPEG or WebP file".into())
}

fn remove_image(name: &str) {
    if !name.is_empty() {
        let _ = std::fs::remove_file(players_dir().join(name));
    }
}

/// A stored picture by file name, never outside the players folder
pub fn image_path(name: &str) -> Option<PathBuf> {
    if !re(&IMG_RE, r"^[a-f0-9]{12}-[a-f0-9]{6}\.(png|jpg|webp)$").is_match(name) {
        return None;
    }
    let p = players_dir().join(name);
    p.is_file().then_some(p)
}

pub fn image_mime(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("") {
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

// --- Player matching ---------------------------------------------------------------------------

/// Lowercase words without accents or punctuation: "Jérôme  O'Neil" -> "jerome o neil"
fn norm_name(s: &str) -> String {
    let folded: String = s.chars().map(fold_accent).collect::<String>().to_lowercase();
    folded.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ")
}

/// NFKD + drop non-ASCII, for the common Latin letters
fn fold_accent(c: char) -> char {
    const FROM: &str = "ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖòóôõöÙÚÛÜùúûüÝýÿŠšŽžČčĆćŁłŃńŚśŹźŻżĞğİıŞşŘřĎďŤťŇňŮůŐőŰű";
    const TO: &str = "AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOoooooUUUUuuuuYyySsZzCcCcLlNnSsZzZzGgIiSsRrDdTtNnUuOoUu";
    match FROM.chars().position(|f| f == c) {
        Some(i) => TO.chars().nth(i).unwrap_or(c),
        None if c.is_ascii() => c,
        None => ' ',
    }
}

/// difflib.SequenceMatcher(None, a, b).ratio()
pub fn seq_ratio(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let t = a.len() + b.len();
    if t == 0 {
        return 1.0;
    }
    fn matches(a: &[char], b: &[char], alo: usize, ahi: usize, blo: usize, bhi: usize) -> usize {
        let (mut bi, mut bj, mut bk) = (alo, blo, 0);
        for i in alo..ahi {
            for j in blo..bhi {
                let mut k = 0;
                while i + k < ahi && j + k < bhi && a[i + k] == b[j + k] {
                    k += 1;
                }
                if k > bk {
                    bi = i;
                    bj = j;
                    bk = k;
                }
            }
        }
        if bk == 0 {
            return 0;
        }
        bk + matches(a, b, alo, bi, blo, bj) + matches(a, b, bi + bk, ahi, bj + bk, bhi)
    }
    2.0 * matches(&a, &b, 0, a.len(), 0, b.len()) as f64 / t as f64
}

/// How surely an Autodarts name is this Studio player, 0 to 1
fn name_score(ad: &str, sp: &Obj) -> f64 {
    let a = norm_name(ad);
    if a.is_empty() {
        return 0.0;
    }
    let mut best: f64 = 0.0;
    for c in ["name", "alias", "nickname"] {
        let b = norm_name(&sp.get(c).map(py_str).unwrap_or_default());
        if b.is_empty() {
            continue;
        }
        let (ac, bc) = (a.replace(' ', ""), b.replace(' ', ""));
        let aw: HashSet<&str> = a.split(' ').collect();
        let bw: HashSet<&str> = b.split(' ').collect();
        let m = ac.chars().count().min(bc.chars().count());
        let score = if ac == bc {
            1.0
        } else if m >= 3 && (aw.is_subset(&bw) || bw.is_subset(&aw)) {
            0.9
        } else if m >= 3 && (ac.starts_with(&bc) || bc.starts_with(&ac)) {
            0.85
        } else {
            let xs: Vec<String> = std::iter::once(ac.clone()).chain(a.split(' ').map(str::to_string)).collect();
            let ys: Vec<String> = std::iter::once(bc.clone()).chain(b.split(' ').map(str::to_string)).collect();
            let mut ratio: f64 = 0.0;
            for x in xs.iter().filter(|x| x.chars().count() >= 3) {
                for y in ys.iter().filter(|y| y.chars().count() >= 3) {
                    ratio = ratio.max(seq_ratio(x, y));
                }
            }
            if ratio >= 0.8 {
                ratio * 0.9
            } else {
                0.0
            }
        };
        best = best.max(score);
    }
    best
}

/// Which Studio player each Autodarts player is: exact name or remembered Autodarts name, then a similar
/// name. A name that fits two Studio players equally well stays unknown.
pub fn map_players(players: &[Value], settings: &Obj) -> Vec<Value> {
    let sps: Vec<Obj> = arr(settings.get("players")).iter().filter_map(|p| p.as_object().cloned()).collect();
    let by_name: BTreeMap<String, String> = sps.iter().map(|p| (py_str(&p["name"]).to_lowercase(), py_str(&p["id"]))).collect();
    let by_alias: BTreeMap<String, String> = sps.iter().filter(|p| p.get("alias").map_or(false, truthy)).map(|p| (py_str(&p["alias"]).to_lowercase(), py_str(&p["id"]))).collect();
    let mut used: HashSet<String> = HashSet::new();
    let mut result: Vec<(String, String)> = Vec::new();
    for p in players {
        let key = p.get("name").map(py_str).unwrap_or_default().trim().to_lowercase();
        let m = match (by_alias.get(&key), by_name.get(&key)) {
            (Some(id), _) if !used.contains(id) => (id.clone(), "alias".to_string()),
            (_, Some(id)) if !used.contains(id) => (id.clone(), "name".to_string()),
            _ => (String::new(), String::new()),
        };
        used.insert(m.0.clone());
        result.push(m);
    }
    let mut pairs: Vec<(f64, usize, String)> = Vec::new();
    for (i, p) in players.iter().enumerate() {
        if !result[i].0.is_empty() {
            continue;
        }
        let name = p.get("name").map(py_str).unwrap_or_default();
        let mut scores: Vec<(f64, String)> = sps.iter().filter(|sp| !used.contains(&py_str(&sp["id"]))).map(|sp| (name_score(&name, sp), py_str(&sp["id"]))).collect();
        scores.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(top) = scores.first() {
            if top.0 >= 0.7 && (scores.len() == 1 || scores[1].0 < top.0) {
                pairs.push((top.0, i, top.1.clone()));
            }
        }
    }
    pairs.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    for (_, i, pid) in pairs {
        if result[i].0.is_empty() && !used.contains(&pid) {
            result[i] = (pid.clone(), "similar".into());
            used.insert(pid);
        }
    }
    result.into_iter().map(|(id, m)| json!({"studio_id": id, "match": m})).collect()
}

// --- Scoreboard from the Autodarts match state -------------------------------------------------

fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Bool(_)) | None | Some(Value::Null) => None,
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// A JSON number as it came (int stays int)
fn num_v(v: Option<&Value>) -> Value {
    match v {
        Some(n @ Value::Number(_)) => n.clone(),
        other => num(other).map(|f| json!(f)).unwrap_or(Value::Null),
    }
}

fn int_v(v: Option<&Value>) -> Option<i64> {
    v.and_then(|x| if x.is_i64() { x.as_i64() } else { None })
}

fn dict<'a>(d: &'a Obj, k: &str) -> Obj {
    obj_or_empty(d.get(k))
}

fn player_name(raw: Option<&Value>, fallback: &str) -> String {
    match raw {
        Some(Value::String(s)) if !s.trim().is_empty() => s.trim().into(),
        Some(Value::Object(o)) => {
            for k in ["name", "username", "userName", "nickname", "displayName"] {
                if let Some(Value::String(s)) = o.get(k) {
                    if !s.trim().is_empty() {
                        return s.trim().into();
                    }
                }
            }
            match o.get("user") {
                Some(u @ Value::Object(_)) => player_name(Some(u), fallback),
                _ => fallback.into(),
            }
        }
        _ => fallback.into(),
    }
}

/// Avatar picture and country Autodarts has for a player (guests have neither)
fn player_extras(raw: Option<&Value>) -> Obj {
    let Some(r) = raw.and_then(Value::as_object) else { return crate::obj! {"avatar_url" => "", "country" => ""} };
    let user = dict(r, "user");
    let avatar = non_empty(r.get("avatarUrl")).or_else(|| non_empty(user.get("avatarUrl"))).and_then(Value::as_str).unwrap_or("");
    let country = non_empty(r.get("country")).or_else(|| non_empty(user.get("country"))).and_then(Value::as_str).unwrap_or("");
    crate::obj! {
        "avatar_url" => if avatar.starts_with("https://") { avatar } else { "" },
        "country" => country.trim().chars().take(3).collect::<String>().to_uppercase(),
    }
}

fn average(stats: Option<&Value>) -> Value {
    let Some(s) = stats.and_then(Value::as_object) else { return Value::Null };
    for scope in ["matchStats", "legStats", "setStats"] {
        if let Some(Value::Object(b)) = s.get(scope) {
            if let Some(a) = num(b.get("average")) {
                return json!(roundn(a, 2));
            }
        }
    }
    num_v(s.get("average"))
}

fn throw_label(t: Option<&Value>) -> String {
    let Some(t) = t.and_then(Value::as_object) else { return String::new() };
    match t.get("segment") {
        Some(Value::Object(seg)) => {
            if let Some(Value::String(n)) = seg.get("name") {
                if !n.is_empty() {
                    return n.clone();
                }
            }
            if let (Some(n), Some(m)) = (int_v(seg.get("number")), int_v(seg.get("multiplier"))) {
                if n == 0 || m == 0 {
                    return "MISS".into();
                }
                if n == 25 {
                    return if m == 2 { "BULL".into() } else { "25".into() };
                }
                let p = match m {
                    1 => "S",
                    2 => "D",
                    3 => "T",
                    _ => "",
                };
                return format!("{}{}", p, n);
            }
            t.get("name").filter(|v| truthy(v)).map(py_str).unwrap_or_default()
        }
        Some(Value::String(s)) => s.clone(),
        _ => t.get("name").filter(|v| truthy(v)).map(py_str).unwrap_or_default(),
    }
}

const STAT_KEYS: [&str; 10] = ["average", "first9Average", "dartsThrown", "total180", "plus170", "plus140", "plus100", "checkoutPercent", "checkoutsHit", "checkouts"];

fn stats_block(stats: Option<&Value>, scope: &str) -> Obj {
    let Some(Value::Object(b)) = stats.and_then(|s| s.get(scope)) else { return Obj::new() };
    STAT_KEYS.iter().filter_map(|k| num(b.get(*k)).map(|v| (k.to_string(), json!(roundn(v, 2))))).collect()
}

/// One dart: label plus where it landed (board-relative: 1.0 is the outer edge of the double ring, +y to the 20)
pub fn throw_detail(t: Option<&Value>) -> Obj {
    let o = t.and_then(Value::as_object).cloned().unwrap_or_default();
    let seg = dict(&o, "segment");
    let coords = dict(&o, "coords");
    let (x, y) = (num(coords.get("x")), num(coords.get("y")));
    crate::obj! {
        "id" => if t.map_or(false, Value::is_object) { o.get("id").map(py_str).unwrap_or_default() } else { String::new() },
        "label" => throw_label(t),
        "number" => int_v(seg.get("number")),
        "multiplier" => int_v(seg.get("multiplier")),
        "bed" => non_empty(seg.get("bed")).map(py_str).unwrap_or_default(),
        "x" => x.map(|v| roundn(v, 4)),
        "y" => y.map(|v| roundn(v, 4)),
    }
}

fn rounds(cb: Option<&Value>) -> Vec<Value> {
    arr(cb.and_then(|c| c.get("rows")))
        .iter()
        .filter_map(|r| r.as_object())
        .filter(|r| num(r.get("round")).unwrap_or(0.0) > 0.0)
        .filter_map(|r| r.get("points").filter(|_| num(r.get("points")).is_some()).map(|p| num_v(Some(p))))
        .collect()
}

fn checkout(state: &Obj, active: i64) -> Vec<String> {
    let mut cands: Vec<Option<&Value>> = vec![state.get("checkoutGuide")];
    if let Some(Value::Object(inner)) = state.get("state") {
        cands.push(inner.get("checkoutGuide"));
        if let Some(Value::Array(pp)) = inner.get("checkoutGuides") {
            if active >= 0 && (active as usize) < pp.len() {
                cands.push(pp.get(active as usize));
            }
        }
    }
    for g in cands.into_iter().flatten() {
        if let Value::Array(a) = g {
            if !a.is_empty() {
                return a
                    .iter()
                    .map(|x| match x {
                        Value::Object(o) => o.get("name").filter(|v| truthy(v)).map(py_str).unwrap_or_default(),
                        other => py_str(other),
                    })
                    .filter(|l| !l.is_empty())
                    .take(3)
                    .collect();
            }
        }
    }
    Vec::new()
}

/// 'First to 3 legs' / 'First to 7 sets' from the match settings, if known
pub fn match_target(state: &Obj) -> String {
    let sets = num(state.get("sets")).unwrap_or(0.0);
    let legs = num(state.get("legs")).unwrap_or(0.0);
    if sets > 1.0 {
        return format!("First to {} sets", sets as i64);
    }
    if legs != 0.0 {
        return format!("First to {} leg{}", legs as i64, if legs != 1.0 { "s" } else { "" });
    }
    String::new()
}

/// Reduce an Autodarts match state to what the broadcast overlay draws
pub fn build_scoreboard(state: Option<&Obj>, live: bool, phase: &str) -> Obj {
    let Some(state) = state.filter(|s| !s.is_empty()) else { return crate::obj! {"live" => false, "players" => Vec::<Value>::new()} };
    let raw_players = arr(state.get("players"));
    let game_scores = arr(state.get("gameScores"));
    let scores = arr(state.get("scores"));
    let stats = arr(state.get("stats"));
    let active = int_v(state.get("player")).unwrap_or(0);
    let settings = dict(state, "settings");
    let chalk = arr(state.get("chalkboards"));
    let fresh = game_scores.is_empty() && !scores.iter().any(|s| s.as_object().map_or(false, |o| num(o.get("legs")).unwrap_or(0.0) != 0.0 || num(o.get("sets")).unwrap_or(0.0) != 0.0));
    let start_score = if fresh && state.get("variant") == Some(&json!("X01")) { num_v(settings.get("baseScore")) } else { Value::Null };
    let mut leg = num_v(state.get("leg"));
    if leg.is_null() && fresh {
        leg = json!(1);
    }
    let count = raw_players.len().max(game_scores.len());
    let mut players = Vec::new();
    for i in 0..count {
        let se = scores.get(i).and_then(Value::as_object).cloned().unwrap_or_default();
        let raw = raw_players.get(i).filter(|r| r.is_object());
        let ps = stats.get(i);
        let user = raw.and_then(|r| r.get("user")).and_then(Value::as_object).cloned().unwrap_or_default();
        let mut p = crate::obj! {
            "index" => i, "id" => raw.and_then(|r| r.get("id")).map(py_str).unwrap_or_default(),
            "name" => player_name(raw, &format!("Player {}", i + 1)),
            "remaining" => if i < game_scores.len() { num_v(game_scores.get(i)) } else { start_score.clone() },
            "legs" => num(se.get("legs")).unwrap_or(0.0) as i64,
            "sets" => num(se.get("sets")).unwrap_or(0.0) as i64,
            "average" => average(ps),
            "leg_stats" => stats_block(ps, "legStats"),
            "match_stats" => stats_block(ps, "matchStats"),
            "account_average" => num_v(user.get("average")),
            "rounds" => rounds(chalk.get(i)),
        };
        p.extend(player_extras(raw));
        players.push(p);
    }
    let turns = arr(state.get("turns"));
    let last = turns.last().and_then(Value::as_object).cloned().unwrap_or_default();
    let throws = arr(last.get("throws"));
    let mut turn_player = int_v(last.get("player"));
    if turn_player.is_none() {
        if let Some(pid) = non_empty(last.get("playerId")) {
            turn_player = players.iter().find(|p| p["id"] == json!(py_str(pid))).and_then(|p| p["index"].as_i64());
        }
    }
    let winner = int_v(state.get("winner"));
    crate::obj! {
        "live" => live, "match_id" => state.get("id").map(py_str).unwrap_or_default(),
        "variant" => non_empty(state.get("variant")).map(py_str).unwrap_or_default(),
        "base_score" => num_v(settings.get("baseScore")),
        "out_mode" => non_empty(settings.get("outMode")).map(py_str).unwrap_or_default(),
        "target" => match_target(state),
        "uses_sets" => num(state.get("sets")).unwrap_or(0.0) > 1.0,
        "set" => num_v(state.get("set")), "leg" => leg, "round" => num_v(state.get("round")), "active" => active,
        "finished" => state.get("finished").map_or(false, truthy) || winner.map_or(false, |w| w >= 0),
        "winner" => winner.filter(|w| *w >= 0),
        "players" => players,
        "turn" => json!({
            "id": last.get("id").map(py_str).unwrap_or_else(|| turns.len().to_string()),
            "player": turn_player.unwrap_or(active),
            "darts": throws.iter().map(|t| throw_label(Some(t))).collect::<Vec<_>>(),
            "throws": throws.iter().map(|t| throw_detail(Some(t))).collect::<Vec<_>>(),
            "points": num_v(last.get("points")),
            "busted": last.get("busted").map_or(false, truthy) || state.get("turnBusted") == Some(&json!(true)),
        }),
        "checkout" => checkout(state, active),
        "phase" => phase,
    }
}

fn bull_off_dart(stats: Option<&Value>, throw: Option<&Value>) -> Obj {
    let leg = stats.and_then(|s| s.get("legStats")).and_then(Value::as_object).cloned().unwrap_or_default();
    let mut coords = dict(&leg, "coords");
    if coords.is_empty() {
        coords = throw.and_then(|t| t.get("coords")).and_then(Value::as_object).cloned().unwrap_or_default();
    }
    if coords.is_empty() {
        return crate::obj! {"thrown" => false};
    }
    let segment = num(leg.get("segmentNumber")).unwrap_or(0.0) as i64;
    let label = if throw.map_or(false, Value::is_object) { throw_label(throw) } else { String::new() };
    let fallback = match segment {
        50 => "Bull",
        25 => "25",
        _ => "",
    };
    crate::obj! {
        "thrown" => true, "distance" => roundn(num(leg.get("bullDistance")).unwrap_or(0.0), 1), "segment" => segment,
        "label" => if label.is_empty() { fallback.to_string() } else { label },
        "x" => num_v(coords.get("x")).as_f64().map(|v| json!(v)).unwrap_or(json!(0)), "y" => num_v(coords.get("y")).as_f64().map(|v| json!(v)).unwrap_or(json!(0)),
    }
}

fn bull_off_round(entry: Option<&Value>, count: usize) -> Vec<Obj> {
    let e = entry.and_then(Value::as_object).cloned().unwrap_or_default();
    let stats = arr(e.get("stats"));
    let throws = dict(&e, "throws");
    (0..count).map(|i| bull_off_dart(stats.get(i), throws.get(&i.to_string()))).collect()
}

fn bull_off_leader(darts: &[Obj], mode: &str) -> Option<usize> {
    let thrown: Vec<(usize, &Obj)> = darts.iter().enumerate().filter(|(_, d)| d.get("thrown") == Some(&json!(true))).collect();
    if thrown.is_empty() {
        return None;
    }
    if mode.to_lowercase() == "official" {
        let best = thrown.iter().map(|(_, d)| d["segment"].as_i64().unwrap_or(0)).max().unwrap_or(0);
        let top: Vec<usize> = thrown.iter().filter(|(_, d)| d["segment"].as_i64() == Some(best)).map(|(i, _)| *i).collect();
        return if best > 0 && top.len() == 1 { Some(top[0]) } else { None };
    }
    let best = thrown.iter().map(|(_, d)| d["distance"].as_f64().unwrap_or(0.0)).fold(f64::INFINITY, f64::min);
    let top: Vec<usize> = thrown.iter().filter(|(_, d)| d["distance"].as_f64() == Some(best)).map(|(i, _)| *i).collect();
    if top.len() == 1 {
        Some(top[0])
    } else {
        None
    }
}

/// The bull-off before the first leg: players, their darts this round and in tied rounds before, who
/// leads, and the winner once Autodarts decided it
pub fn build_bull_off(bo: Option<&Obj>) -> Option<Obj> {
    let bo = bo?;
    let state = dict(bo, "state");
    let lobby = dict(bo, "lobby");
    let mut rp: Vec<&Value> = arr(state.get("players")).iter().filter(|p| p.is_object()).collect();
    if arr(state.get("players")).is_empty() {
        rp = arr(lobby.get("players")).iter().filter(|p| p.is_object()).collect();
    }
    if rp.is_empty() {
        return None;
    }
    let mode = non_empty(bo.get("mode")).map(py_str).unwrap_or_default();
    let rounds = dict(bo, "rounds");
    let round_nums: Vec<i64> = rounds.keys().filter_map(|k| k.parse().ok()).collect();
    let current = int_v(state.get("round")).unwrap_or_else(|| round_nums.iter().copied().max().unwrap_or(1));
    let darts = bull_off_round(rounds.get(&current.to_string()), rp.len());
    let players: Vec<Value> = rp
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let user = raw.get("user").and_then(Value::as_object).cloned().unwrap_or_default();
            let mut p = crate::obj! {"index" => i, "id" => raw.get("id").map(py_str).unwrap_or_default(), "name" => player_name(Some(raw), &format!("Player {}", i + 1)),
                                     "account_average" => num_v(user.get("average"))};
            p.extend(player_extras(Some(raw)));
            p.extend(darts[i].clone());
            Value::Object(p)
        })
        .collect();
    let winner = int_v(state.get("gameWinner"));
    let decided = state.get("gameFinished") == Some(&json!(true)) && winner.map_or(false, |w| w >= 0 && (w as usize) < players.len());
    let mut active = int_v(state.get("player"));
    if active.is_none() && !darts.iter().any(|d| d.get("thrown") == Some(&json!(true))) {
        active = Some(0);
    }
    let mut sorted = round_nums.clone();
    sorted.sort();
    let history: Vec<Value> = sorted.iter().filter(|r| **r < current).map(|r| json!({"round": r, "darts": bull_off_round(rounds.get(&r.to_string()), players.len())})).collect();
    let ls = dict(&lobby, "settings");
    Some(crate::obj! {
        "match_id" => non_empty(bo.get("match_id")).or_else(|| non_empty(state.get("id"))).map(py_str).unwrap_or_default(),
        "mode" => mode, "round" => current,
        "active" => if decided { None } else { active },
        "decided" => decided,
        "winner" => if decided { winner } else { None },
        "leader" => if decided { winner } else { bull_off_leader(&darts, &mode).map(|i| i as i64) },
        "players" => players, "history" => history,
        "variant" => non_empty(lobby.get("variant")).map(py_str).unwrap_or_default(),
        "base_score" => num_v(ls.get("baseScore")),
        "target" => if lobby.is_empty() { String::new() } else { match_target(&lobby) },
    })
}

/// The players picked in an Autodarts lobby and its format, for the pre-match screens
pub fn build_lobby(lobby: Option<&Obj>) -> Option<Obj> {
    let l = lobby?;
    let s = dict(l, "settings");
    let players: Vec<Value> = arr(l.get("players"))
        .iter()
        .filter(|p| p.is_object())
        .enumerate()
        .map(|(i, raw)| {
            let user = raw.get("user").and_then(Value::as_object).cloned().unwrap_or_default();
            let mut p = crate::obj! {"index" => i, "id" => raw.get("id").map(py_str).unwrap_or_default(), "name" => player_name(Some(raw), &format!("Player {}", i + 1)),
                                     "account_average" => num_v(user.get("average"))};
            p.extend(player_extras(Some(raw)));
            Value::Object(p)
        })
        .collect();
    Some(crate::obj! {
        "id" => l.get("id").map(py_str).unwrap_or_default(), "variant" => non_empty(l.get("variant")).map(py_str).unwrap_or_default(),
        "base_score" => num_v(s.get("baseScore")), "out_mode" => non_empty(s.get("outMode")).map(py_str).unwrap_or_default(),
        "target" => match_target(l), "players" => players,
    })
}

/// Sample match so the overlay can be laid out without a game running
pub fn demo_scoreboard() -> Obj {
    let Value::Object(o) = json!({
        "live": true, "demo": true, "match_id": "demo", "variant": "X01", "base_score": 501, "out_mode": "Double", "target": "First to 7 sets",
        "uses_sets": true, "set": 3, "leg": 2, "round": 6, "active": 0, "finished": false, "winner": null,
        "players": [
            {"index": 0, "name": "Player One", "remaining": 367, "legs": 1, "sets": 0, "average": 98.4, "avatar_url": "", "country": ""},
            {"index": 1, "name": "Player Two", "remaining": 401, "legs": 0, "sets": 2, "average": 101.7, "avatar_url": "", "country": ""},
        ],
        "turn": {"id": "demo", "player": 1, "darts": ["T20", "T20", "S20"], "points": 140, "busted": false},
        "checkout": [],
    }) else { unreachable!() };
    o
}
