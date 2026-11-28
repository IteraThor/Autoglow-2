//! The Local Tournament dashboard on the TVs (/tournament/live): what the TVs show and how it looks,
//! kept in studio/dashboard.json next to the Studio's settings, an optional event logo, and "on all
//! TVs now": a scene every TV holds until the dashboard is set back to its rotation. Also the
//! highlights ticker (what it shows, how fast, own messages), the text size and calm animations.

use crate::py::*;
use crate::storage::project_root;
use log::warn;
use regex::Regex;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

pub const LAYOUTS: [&str; 4] = ["overview", "boards", "wall", "single"];
pub const PRESETS: [&str; 6] = ["overview", "boards", "wall", "standings", "minimal", "custom"];
/// The scenes the dashboard rotates through, with their default seconds
pub const SCENES: [(&str, i64); 4] = [("bracket", 14), ("tables", 14), ("results", 10), ("leaders", 10)];
/// What "on all TVs now" can hold; empty = the rotation
pub const HOLDS: [&str; 6] = ["", "boards", "bracket", "tables", "results", "leaders"];
/// What the highlights ticker at the bottom can show
pub const TICKER_ITEMS: [&str; 5] = ["t180", "averages", "results", "upsets", "next"];
pub const TICKER_SPEEDS: [&str; 3] = ["slow", "normal", "fast"];
pub const TEXT_SIZES: [&str; 2] = ["normal", "large"];
const MAX_TITLE: usize = 60;
const MAX_SUBTITLE: usize = 80;
/// The ticker's own messages, one per line
const MAX_TICKER_TEXT: usize = 300;

fn dir() -> PathBuf {
    project_root().join("studio")
}
fn settings_file() -> PathBuf {
    dir().join("dashboard.json")
}

static LOGO_RE: OnceLock<Regex> = OnceLock::new();
fn logo_re() -> &'static Regex {
    LOGO_RE.get_or_init(|| Regex::new(r"^dashboard-logo-[a-f0-9]{6}\.(png|jpg|webp)$").unwrap())
}

/// The logo by file name, never outside the studio folder
pub fn logo_path(name: &str) -> Option<PathBuf> {
    if !logo_re().is_match(name) {
        return None;
    }
    let p = dir().join(name);
    p.is_file().then_some(p)
}

fn pick(o: &Obj, key: &str, allowed: &[&str], default: &str) -> String {
    let v = get_str(o, key, default);
    if allowed.contains(&v.as_str()) { v } else { default.to_string() }
}

fn text(o: &Obj, key: &str, max: usize) -> String {
    get_str(o, key, "").trim().chars().take(max).collect()
}

/// Every field checked, unknown ones dropped, missing ones at their default
pub fn clean(v: Option<&Value>) -> Obj {
    let empty = Obj::new();
    let o = v.and_then(Value::as_object).unwrap_or(&empty);
    let logo = get_str(o, "logo", "");
    // Each scene once, in the order given; scenes not given keep their default at the end
    let mut scenes: Vec<Value> = Vec::new();
    for s in arr(o.get("scenes")).iter().filter_map(Value::as_object) {
        let id = get_str(s, "id", "");
        let Some((_, secs)) = SCENES.iter().find(|(n, _)| *n == id) else { continue };
        if scenes.iter().any(|x| x["id"] == id.as_str()) {
            continue;
        }
        scenes.push(json!({"id": id, "secs": clamp(safe_int(s.get("secs"), *secs), 4, 60), "on": get_bool(s, "on", true)}));
    }
    for (id, secs) in SCENES {
        if !scenes.iter().any(|x| x["id"] == id) {
            scenes.push(json!({"id": id, "secs": secs, "on": true}));
        }
    }
    let empty_items = Obj::new();
    let items_in = o.get("ticker_items").and_then(Value::as_object).unwrap_or(&empty_items);
    let mut items = Obj::new();
    for k in TICKER_ITEMS {
        items.insert(k.into(), Value::Bool(get_bool(items_in, k, true)));
    }
    // Own messages: a line each, no empty ones
    let ticker_text: String = get_str(o, "ticker_text", "")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(MAX_TICKER_TEXT)
        .collect();
    crate::obj! {
        "preset" => pick(o, "preset", &PRESETS, "overview"),
        "layout" => pick(o, "layout", &LAYOUTS, "overview"),
        "photos" => get_bool(o, "photos", true),
        "clock" => get_bool(o, "clock", true),
        "boards" => get_bool(o, "boards", true),
        "upnext" => get_bool(o, "upnext", true),
        "safe" => clamp(safe_int(o.get("safe"), 0), 0, 5),
        "title" => text(o, "title", MAX_TITLE),
        "subtitle" => text(o, "subtitle", MAX_SUBTITLE),
        "logo" => if logo_re().is_match(&logo) { logo } else { String::new() },
        "scenes" => scenes,
        "ticker" => get_bool(o, "ticker", true),
        "ticker_speed" => pick(o, "ticker_speed", &TICKER_SPEEDS, "normal"),
        "ticker_items" => items,
        "ticker_text" => ticker_text,
        "text" => pick(o, "text", &TEXT_SIZES, "normal"),
        "calm" => get_bool(o, "calm", false),
    }
}

pub struct Dashboard {
    lock: Mutex<()>,
    /// {"scene": "" | one of HOLDS, "id": n}; the id changes with every switch so TVs see a new one
    pub hold: Mutex<Value>,
}

impl Dashboard {
    pub fn new() -> Dashboard {
        Dashboard { lock: Mutex::new(()), hold: Mutex::new(json!({"scene": "", "id": 0})) }
    }

    pub fn load(&self) -> Obj {
        match std::fs::read_to_string(settings_file()) {
            Ok(t) => match serde_json::from_str::<Value>(&t) {
                Ok(v) => clean(Some(&v)),
                Err(e) => {
                    warn!("Could not read {}: {}", settings_file().display(), e);
                    clean(None)
                }
            },
            Err(_) => clean(None),
        }
    }

    /// Merge the changed fields into the stored settings
    pub fn save(&self, changes: &Obj) -> Result<Obj, String> {
        let _g = self.lock.lock().unwrap();
        let old = self.load();
        let mut merged = old.clone();
        for (k, v) in changes {
            merged.insert(k.clone(), v.clone());
        }
        let new = clean(Some(&Value::Object(merged)));
        let buf = serde_json::to_vec_pretty(&new).map_err(|e| e.to_string())?;
        crate::storage::write_atomic(&settings_file(), &buf).map_err(|e| e.to_string())?;
        // A replaced or removed logo leaves no file behind, unless a saved event preset still shows it
        let old_logo = get_str(&old, "logo", "");
        if !old_logo.is_empty() && old_logo != get_str(&new, "logo", "") && !crate::event_presets::stored_logos().contains(&old_logo) {
            let _ = std::fs::remove_file(dir().join(&old_logo));
        }
        Ok(new)
    }

    /// Store an uploaded logo and make it the event logo
    pub fn set_logo(&self, data: &[u8]) -> Result<Obj, String> {
        let ext = crate::studio::picture_type(data)?;
        let name = format!("dashboard-logo-{}.{}", hex::encode(rand::random::<[u8; 3]>()), ext);
        crate::storage::write_atomic(&dir().join(&name), data).map_err(|e| e.to_string())?;
        self.save(&crate::obj! {"logo" => name})
    }

    pub fn set_hold(&self, scene: &str) -> Result<Value, String> {
        if !HOLDS.contains(&scene) {
            return Err("Unknown scene".into());
        }
        let mut g = self.hold.lock().unwrap();
        let id = g["id"].as_i64().unwrap_or(0) + 1;
        *g = json!({"scene": scene, "id": id});
        Ok(g.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_keeps_known_values_and_fills_defaults() {
        let v = json!({"layout": "wall", "theme": "flap", "accent": "#FF8800", "safe": 9, "title": " Friday ",
            "logo": "../x.png", "scenes": [{"id": "results", "secs": 2, "on": false}, {"id": "bogus"}, {"id": "results"}], "extra": 1});
        let c = clean(Some(&v));
        assert_eq!(c["layout"], "wall");
        // The look is the Studio's (src/studio.rs THEMES)
        assert!(c.get("theme").is_none() && c.get("accent").is_none());
        assert_eq!(c["safe"], 5);
        assert_eq!(c["title"], "Friday");
        assert_eq!(c["logo"], "");
        assert!(c.get("extra").is_none());
        let ids: Vec<&str> = c["scenes"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["results", "bracket", "tables", "leaders"]);
        assert_eq!(c["scenes"][0], json!({"id": "results", "secs": 4, "on": false}));
        assert_eq!(c["ticker"], true);
        assert_eq!(c["text"], "normal");
    }

    #[test]
    fn clean_ticker_settings() {
        let v = json!({"ticker": false, "ticker_speed": "warp", "text": "large", "calm": true,
            "ticker_items": {"t180": false, "bogus": true}, "ticker_text": "  Bar open till 2 \n\n Next: doubles night  "});
        let c = clean(Some(&v));
        assert_eq!(c["ticker"], false);
        assert_eq!(c["ticker_speed"], "normal");
        assert_eq!(c["text"], "large");
        assert_eq!(c["calm"], true);
        assert_eq!(c["ticker_items"], json!({"t180": false, "averages": true, "results": true, "upsets": true, "next": true}));
        assert_eq!(c["ticker_text"], "Bar open till 2\nNext: doubles night");
    }

    #[test]
    fn hold_takes_only_known_scenes() {
        let d = Dashboard::new();
        assert_eq!(d.set_hold("bracket").unwrap()["id"], 1);
        assert!(d.set_hold("champion").is_err());
        assert_eq!(d.set_hold("").unwrap(), json!({"scene": "", "id": 2}));
    }
}
