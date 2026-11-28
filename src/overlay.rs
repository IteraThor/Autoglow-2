//! The Local Tournament overlay on the boards: how Autodarts' match page looks on every board PC
//! while it plays a tournament match (chrome_extension/match.js draws it). Kept in
//! studio/overlay.json on the PC that hosts the tournament; the host sends it to every board with
//! the tournament (src/tournament/mod.rs), so all boards look the same.
//!
//! look: one of the Dashboard's looks, "autodarts" (Autodarts' own colours) or "dashboard"/"studio"
//! (follow that page's look and accent). skin "page" restyles the whole Autodarts page in the look,
//! "panels" only adds the tournament panels on top of it. style: panels, corners, motion, the page's
//! background, the active card and the display font. landscape / portrait: each screen shape has its
//! own parts (what is shown) and boxes (where a box was moved to on the Overlay page: x, y and width
//! in % of the screen, s its size; a box without one stays where match.js puts it). face: how
//! Autodarts' own parts are drawn: the score, the player cards, the three darts, the dartboard, its
//! frame and hit markers, the checkout route and target, and the big moments (180, bust).

use crate::py::*;
use crate::storage::project_root;
use log::warn;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

/// The looks match.js knows; "dashboard" and "studio" are resolved to one of them
pub const LOOKS: [&str; 9] = ["autodarts", "arena", "flap", "poster", "mono", "gazette", "blueprint", "pop", "worldcup"];
pub const FOLLOW: [&str; 2] = ["dashboard", "studio"];
pub const SKINS: [&str; 2] = ["page", "panels"];
/// Every part of the overlay that can be switched off, with its default
pub const PARTS: [(&str, bool); 13] = [
    ("intro", true), ("seeds", true), ("header", true), ("race", true), ("run", true),
    ("stake", true), ("next", true), ("winner", true), ("ticker", false), ("logo", true),
    ("clock", false), ("note", false), ("glow", false),
];
/// The boxes that can be moved and sized (runL / runR: the run under the left / right card)
pub const BOXES: [&str; 9] = ["header", "race", "runL", "runR", "stake", "next", "winner", "clock", "note"];
pub const ORIENTS: [&str; 2] = ["landscape", "portrait"];
/// style: each choice with its default first
const STYLE: [(&str, &[&str]); 6] = [
    ("corners", &["look", "square", "soft", "round"]),
    ("motion", &["fade", "slide", "pop", "none"]),
    ("bg", &["look", "plain", "spot", "grid", "dots", "lines"]),
    ("card", &["fill", "outline", "glow"]),
    ("font", &["look", "bebas", "oswald", "anton", "unbounded", "serif", "black"]),
    ("ticker_pos", &["bottom", "top"]),
];
/// face: Autodarts' own parts, each choice with its default first ("auto": the look's own)
const FACE: [(&str, &[&str]); 6] = [
    ("score", &["auto", "classic", "broadcast", "flap", "roll", "led", "neon"]),
    ("card", &["classic", "strip", "lower", "minimal"]),
    ("throws", &["classic", "tiles"]),
    ("board", &["classic", "look", "mono", "neon", "wire", "gold"]),
    ("frame", &["none", "leds", "rings"]),
    ("markers", &["look", "classic"]),
];
const FACE_ON: [(&str, bool); 4] = [("checkout", true), ("target", true), ("moments", true), ("logos", true)];
const PICKS: [(&str, &[&str]); 2] = [("ticker_speed", &["normal", "slow", "fast"]), ("clock", &["time", "match", "both"])];
pub const NOTE_MAX: usize = 140;
pub const INTRO_SECS: (i64, i64, i64) = (2, 4, 10);

/// The Studio's looks, as the dashboard look closest to each (same as web/studio/js/tournament.js)
fn studio_to_look(theme: &str) -> &'static str {
    match theme {
        "autodarts" => "autodarts",
        "neon" | "velocity" => "arena",
        "arena" | "pub" => "flap",
        "tv" | "daylight" | "glass" => "poster",
        "mono" => "mono",
        "gazette" => "gazette",
        "blueprint" => "blueprint",
        "pop" => "pop",
        "worldcup" => "worldcup",
        _ => "arena",
    }
}

fn file() -> PathBuf {
    project_root().join("studio").join("overlay.json")
}

static LOCK: Mutex<()> = Mutex::new(());

fn hex(s: &str) -> String {
    let ok = s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit());
    if ok { s.to_lowercase() } else { String::new() }
}

/// Every field checked, unknown ones dropped, missing ones at their default
pub fn clean(v: Option<&Value>) -> Obj {
    let empty = Obj::new();
    let o = v.and_then(Value::as_object).unwrap_or(&empty);
    let look = get_str(o, "look", "dashboard");
    let look = if LOOKS.contains(&look.as_str()) || FOLLOW.contains(&look.as_str()) { look } else { "dashboard".into() };
    let skin = get_str(o, "skin", "page");
    // Before the screens had their own: one set of parts for both
    let old_parts = o.get("parts").and_then(Value::as_object).unwrap_or(&empty);
    let style_in = o.get("style").and_then(Value::as_object).unwrap_or(&empty);
    let mut style = Obj::new();
    for (k, opts) in STYLE {
        style.insert(k.into(), json!(pick(style_in, k, opts)));
    }
    style.insert("opacity".into(), json!(clamp(safe_int(style_in.get("opacity"), 92), 30, 100)));
    let face_in = o.get("face").and_then(Value::as_object).unwrap_or(&empty);
    let mut face = Obj::new();
    for (k, opts) in FACE {
        face.insert(k.into(), json!(pick(face_in, k, opts)));
    }
    for (k, d) in FACE_ON {
        face.insert(k.into(), Value::Bool(get_bool(face_in, k, d)));
    }
    let mut out = crate::obj! {
        "look" => look,
        "accent" => hex(&get_str(o, "accent", "")),
        "skin" => if SKINS.contains(&skin.as_str()) { skin } else { "page".into() },
        "intro_secs" => clamp(safe_int(o.get("intro_secs"), INTRO_SECS.1), INTRO_SECS.0, INTRO_SECS.2),
        "style" => style,
        "face" => face,
        "note" => get_str(o, "note", "").trim().chars().take(NOTE_MAX).collect::<String>(),
    };
    for (k, opts) in PICKS {
        out.insert(k.into(), json!(pick(o, k, opts)));
    }
    for or in ORIENTS {
        out.insert(or.into(), Value::Object(screen(o.get(or).and_then(Value::as_object).unwrap_or(&empty), old_parts)));
    }
    out
}

/// One of the choices, else the first
fn pick(o: &Obj, key: &str, opts: &[&str]) -> String {
    let v = get_str(o, key, opts[0]);
    if opts.contains(&v.as_str()) { v } else { opts[0].into() }
}

/// A screen shape's parts and moved boxes
fn screen(o: &Obj, old_parts: &Obj) -> Obj {
    let empty = Obj::new();
    let parts_in = o.get("parts").and_then(Value::as_object).unwrap_or(old_parts);
    let mut parts = Obj::new();
    for (k, d) in PARTS {
        parts.insert(k.into(), Value::Bool(get_bool(parts_in, k, d)));
    }
    let boxes_in = o.get("boxes").and_then(Value::as_object).unwrap_or(&empty);
    let mut boxes = Obj::new();
    for k in BOXES {
        let Some(b) = boxes_in.get(k).and_then(Value::as_object) else { continue };
        let num = |key: &str, d: f64, lo: f64, hi: f64| {
            let v = safe_float(b.get(key), d);
            ((if v.is_finite() { v } else { d }).clamp(lo, hi) * 100.0).round() / 100.0
        };
        boxes.insert(k.into(), json!({"x": num("x", 0.0, 0.0, 98.0), "y": num("y", 0.0, 0.0, 98.0), "w": num("w", 25.0, 6.0, 100.0), "s": num("s", 1.0, 0.4, 3.0)}));
    }
    crate::obj! { "parts" => parts, "boxes" => boxes }
}

pub fn load() -> Obj {
    match std::fs::read_to_string(file()) {
        Ok(t) => match serde_json::from_str::<Value>(&t) {
            Ok(v) => clean(Some(&v)),
            Err(e) => {
                warn!("Could not read {}: {}", file().display(), e);
                clean(None)
            }
        },
        Err(_) => clean(None),
    }
}

/// Merge the changed fields into the stored settings
pub fn save(changes: &Obj) -> Result<Obj, String> {
    let _g = LOCK.lock().unwrap();
    let mut merged = load();
    for (k, v) in changes {
        // style and a screen's parts / boxes: only the fields sent change
        if k == "style" || k == "face" || ORIENTS.contains(&k.as_str()) {
            if let (Some(Value::Object(old)), Some(new)) = (merged.get_mut(k.as_str()), v.as_object()) {
                for (pk, pv) in new {
                    old.insert(pk.clone(), pv.clone());
                }
                continue;
            }
        }
        merged.insert(k.clone(), v.clone());
    }
    let new = clean(Some(&Value::Object(merged)));
    let buf = serde_json::to_vec_pretty(&new).map_err(|e| e.to_string())?;
    crate::storage::write_atomic(&file(), &buf).map_err(|e| e.to_string())?;
    Ok(new)
}

/// What the Dashboard and the Studio look like now, as overlay looks: {"dashboard": {look, accent}, "studio": {...}}
pub fn follow() -> Value {
    let st = crate::studio::Studio::new().load_settings();
    let studio = json!({"look": studio_to_look(&get_str(&st, "theme", "autodarts")), "accent": hex(&get_str(&st, "accent", ""))});
    let d = crate::dashboard::Dashboard::new().load();
    let theme = get_str(&d, "theme", "arena");
    let dash = if theme == "studio" { studio.clone() } else { json!({"look": theme, "accent": hex(&get_str(&d, "accent", ""))}) };
    json!({"dashboard": dash, "studio": studio})
}

/// The settings as the boards use them: the look resolved, with the event's name and logo from
/// the Dashboard. This is what goes out with the tournament.
pub fn resolved() -> Value {
    let s = load();
    let f = follow();
    let mut out = Value::Object(s.clone());
    let look = get_str(&s, "look", "dashboard");
    if let Some(src) = f.get(look.as_str()) {
        out["look"] = src["look"].clone();
        // An own accent wins over the followed page's
        if get_str(&s, "accent", "").is_empty() {
            out["accent"] = src["accent"].clone();
        }
    }
    out["choice"] = json!(look);
    let d = crate::dashboard::Dashboard::new().load();
    out["title"] = json!(get_str(&d, "title", ""));
    out["subtitle"] = json!(get_str(&d, "subtitle", ""));
    out["logo"] = json!(get_str(&d, "logo", ""));
    out
}

/// The Dashboard's event logo as a data: address (the board's page cannot reach the host itself)
pub fn logo_data(name: &str) -> Option<String> {
    use base64::Engine;
    let p = crate::dashboard::logo_path(name)?;
    let b = std::fs::read(p).ok()?;
    Some(format!("data:{};base64,{}", crate::studio::image_mime(name), base64::engine::general_purpose::STANDARD.encode(b)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_checks_every_field() {
        let v = json!({"look": "neon", "accent": "#ABCDEF", "skin": "x", "parts": {"intro": false, "bogus": true}, "intro_secs": 99, "extra": 1,
            "style": {"motion": "pop", "bg": "nope", "opacity": 5}, "clock": "both", "note": "x".repeat(300),
            "portrait": {"parts": {"race": false}, "boxes": {"header": {"x": -5, "y": 40.123, "w": 500, "s": 9}, "bogus": {"x": 1}}}});
        let c = clean(Some(&v));
        assert_eq!(c["look"], "dashboard");
        assert_eq!(c["accent"], "#abcdef");
        assert_eq!(c["skin"], "page");
        // The old shared parts carry over to a screen without its own
        assert_eq!(c["landscape"]["parts"]["intro"], false);
        assert_eq!(c["landscape"]["parts"]["header"], true);
        assert_eq!(c["landscape"]["parts"]["ticker"], false);
        assert!(c["landscape"]["parts"].get("bogus").is_none());
        assert_eq!(c["portrait"]["parts"]["race"], false);
        assert_eq!(c["portrait"]["parts"]["intro"], true);
        assert!(c.get("parts").is_none());
        assert_eq!(c["portrait"]["boxes"]["header"], json!({"x": 0.0, "y": 40.12, "w": 100.0, "s": 3.0}));
        assert!(c["portrait"]["boxes"].get("bogus").is_none());
        assert_eq!(c["landscape"]["boxes"], json!({}));
        assert_eq!(c["style"]["motion"], "pop");
        assert_eq!(c["style"]["bg"], "look");
        assert_eq!(c["style"]["opacity"], 30);
        assert_eq!(c["clock"], "both");
        assert_eq!(c["ticker_speed"], "normal");
        assert_eq!(c["note"].as_str().unwrap().len(), NOTE_MAX);
        assert_eq!(c["intro_secs"], 10);
        assert!(c.get("extra").is_none());
        assert_eq!(c["face"]["score"], "auto");
        assert_eq!(c["face"]["checkout"], true);
        let f = clean(Some(&json!({"face": {"score": "flap", "board": "nope", "checkout": false}})));
        assert_eq!(f["face"]["score"], "flap");
        assert_eq!(f["face"]["board"], "classic");
        assert_eq!(f["face"]["checkout"], false);
    }

    #[test]
    fn follow_looks_and_studio_map() {
        assert_eq!(clean(Some(&json!({"look": "studio"})))["look"], "studio");
        assert_eq!(clean(Some(&json!({"look": "flap"})))["look"], "flap");
        assert_eq!(studio_to_look("tv"), "poster");
        assert_eq!(studio_to_look("whatever"), "arena");
    }
}
