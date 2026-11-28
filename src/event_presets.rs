//! Event presets: one saved setup per event (Friday League, Club Championship …) for the Studio
//! broadcast, the Local Tournament dashboard and the boards' overlay together: names, logo, looks, texts, TV screens and
//! ticker. Kept in studio/presets.json. The active preset is the live settings themselves: edits go
//! there, and the live settings are copied into it before switching away, so nothing is lost.
//! Cameras, players and camera settings stay with the PC.

use crate::dashboard::{self, Dashboard};
use crate::overlay;
use crate::py::*;
use crate::studio::{self, Studio};
use log::warn;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

/// The Studio settings an event preset holds; the rest belongs to the PC (cameras, players)
pub const STUDIO_KEYS: [&str; 13] = [
    "title", "subtitle", "accent", "theme", "look_sync", "texts", "hidden_texts", "show_player_card", "show_checkout", "show_dartboard", "show_intro", "show_overlay",
    "idle_blur",
];
const MAX_NAME: usize = 40;
const MAX_PRESETS: usize = 50;
const FIRST_NAME: &str = "Standard";

pub enum PresetError {
    Invalid(String),
    NotFound,
    Io(String),
}

impl From<String> for PresetError {
    fn from(e: String) -> PresetError {
        PresetError::Io(e)
    }
}

fn file() -> PathBuf {
    studio::studio_dir().join("presets.json")
}

/// The preset's part of the Studio settings, cleaned
pub fn studio_part(raw: Option<&Value>) -> Obj {
    let all = studio::clean_settings(raw);
    STUDIO_KEYS.iter().filter_map(|k| all.get(*k).map(|v| (k.to_string(), v.clone()))).collect()
}

fn clean_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_NAME).collect()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The stored presets, every one checked; the active one always exists (None: no usable preset)
pub fn clean_store(raw: Option<&Value>) -> Option<Obj> {
    let empty = Obj::new();
    let o = raw.and_then(Value::as_object).unwrap_or(&empty);
    let mut presets: Vec<Value> = Vec::new();
    for p in arr(o.get("presets")).iter().filter_map(Value::as_object) {
        let id = get_str(p, "id", "");
        let name = clean_name(&get_str(p, "name", ""));
        if !valid_id(&id) || name.is_empty() || presets.iter().any(|x| x["id"] == id.as_str()) {
            continue;
        }
        let mut preset = json!({"id": id, "name": name, "studio": studio_part(p.get("studio")), "dashboard": dashboard::clean(p.get("dashboard"))});
        // Presets from before the Overlay was in them have none: switching to one leaves the Overlay as it is
        if p.get("overlay").is_some_and(Value::is_object) {
            preset["overlay"] = Value::Object(overlay::preset_part(p.get("overlay")));
        }
        presets.push(preset);
    }
    if presets.is_empty() {
        return None;
    }
    let active = get_str(o, "active", "");
    let active = if presets.iter().any(|p| p["id"] == active.as_str()) { active } else { py_str(&presets[0]["id"]) };
    Some(crate::obj! {"active" => active, "presets" => presets})
}

/// The logo files the presets and the live dashboard use
pub fn logos_in_use(store: Option<&Obj>, live_dashboard: &Obj) -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    if let Some(s) = store {
        for p in arr(s.get("presets")) {
            if let Some(l) = p["dashboard"]["logo"].as_str() {
                out.insert(l.to_string());
            }
        }
    }
    out.insert(get_str(live_dashboard, "logo", ""));
    out.remove("");
    out
}

/// The logos the stored presets use; the dashboard keeps these when its own logo changes
pub fn stored_logos() -> HashSet<String> {
    logos_in_use(read().as_ref(), &Obj::new())
}

fn read() -> Option<Obj> {
    let text = std::fs::read_to_string(file()).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => clean_store(Some(&v)),
        Err(e) => {
            warn!("Could not read {}: {}", file().display(), e);
            None
        }
    }
}

fn write(store: &Obj) -> Result<(), String> {
    let buf = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    crate::storage::write_atomic(&file(), &buf).map_err(|e| e.to_string())
}

fn new_id(store: &Obj) -> String {
    loop {
        let id = format!("p-{}", hex::encode(rand::random::<[u8; 3]>()));
        if !arr(store.get("presets")).iter().any(|p| p["id"] == id.as_str()) {
            return id;
        }
    }
}

fn presets_mut(store: &mut Obj) -> &mut Vec<Value> {
    store.get_mut("presets").and_then(Value::as_array_mut).expect("a cleaned store has presets")
}

fn find<'a>(store: &'a mut Obj, id: &str) -> Option<&'a mut Value> {
    presets_mut(store).iter_mut().find(|p| p["id"] == id)
}

pub struct EventPresets {
    lock: Mutex<()>,
}

impl EventPresets {
    pub fn new() -> EventPresets {
        EventPresets { lock: Mutex::new(()) }
    }

    /// The live settings as a preset's parts
    fn live(studio: &Studio, dash: &Dashboard) -> (Obj, Obj, Obj) {
        (studio_part(Some(&Value::Object(studio.load_settings()))), dash.load(), overlay::preset_part(Some(&Value::Object(overlay::load()))))
    }

    /// The stored presets; the first time a "Standard" one made from the live settings
    fn load(studio: &Studio, dash: &Dashboard) -> Result<Obj, String> {
        if let Some(s) = read() {
            return Ok(s);
        }
        let (st, da, ov) = Self::live(studio, dash);
        let store = crate::obj! {"active" => "p-first", "presets" => vec![json!({"id": "p-first", "name": FIRST_NAME, "studio": st, "dashboard": da, "overlay": ov})]};
        write(&store)?;
        Ok(store)
    }

    /// Copy the live settings into the active preset; returns the logo it held before
    fn capture(store: &mut Obj, studio: &Studio, dash: &Dashboard) -> String {
        let (st, da, ov) = Self::live(studio, dash);
        let active = get_str(store, "active", "");
        let Some(p) = find(store, &active) else { return String::new() };
        let old_logo = p["dashboard"]["logo"].as_str().unwrap_or("").to_string();
        p["studio"] = Value::Object(st);
        p["dashboard"] = Value::Object(da);
        p["overlay"] = Value::Object(ov);
        old_logo
    }

    /// Delete the given logo files when nothing uses them any more
    fn prune(store: &Obj, dash: &Dashboard, candidates: &[String]) {
        let used = logos_in_use(Some(store), &dash.load());
        for c in candidates.iter().filter(|c| !c.is_empty() && !used.contains(*c)) {
            if let Some(p) = dashboard::logo_path(c) {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    /// Put a preset's settings live
    fn apply(preset: &Value, studio: &Studio, dash: &Dashboard) -> Result<(), String> {
        studio.save_settings(&obj_or_empty(preset.get("studio")))?;
        dash.save(&obj_or_empty(preset.get("dashboard")))?;
        if let Some(ov) = preset.get("overlay").and_then(Value::as_object) {
            overlay::save(ov)?;
        }
        Ok(())
    }

    /// The presets for the page; the active one shows the live settings
    fn view(store: &Obj, studio: &Studio, dash: &Dashboard) -> Value {
        let mut out = store.clone();
        let (st, da, ov) = Self::live(studio, dash);
        let active = get_str(store, "active", "");
        if let Some(p) = find(&mut out, &active) {
            p["studio"] = Value::Object(st);
            p["dashboard"] = Value::Object(da);
            p["overlay"] = Value::Object(ov);
        }
        out.insert("status".into(), json!("ok"));
        Value::Object(out)
    }

    pub fn list(&self, studio: &Studio, dash: &Dashboard) -> Result<Value, PresetError> {
        let _g = self.lock.lock().unwrap();
        let store = Self::load(studio, dash)?;
        Ok(Self::view(&store, studio, dash))
    }

    /// A new preset as a copy of the live settings; it becomes the active one
    pub fn create(&self, studio: &Studio, dash: &Dashboard, name: &str) -> Result<Value, PresetError> {
        let name = clean_name(name);
        if name.is_empty() {
            return Err(PresetError::Invalid("Give the preset a name".into()));
        }
        let _g = self.lock.lock().unwrap();
        let mut store = Self::load(studio, dash)?;
        if arr(store.get("presets")).len() >= MAX_PRESETS {
            return Err(PresetError::Invalid(format!("At most {} presets", MAX_PRESETS)));
        }
        if arr(store.get("presets")).iter().any(|p| p["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&name))) {
            return Err(PresetError::Invalid(format!("There is already a preset called {}", name)));
        }
        let old_logo = Self::capture(&mut store, studio, dash);
        let (st, da, ov) = Self::live(studio, dash);
        let id = new_id(&store);
        presets_mut(&mut store).push(json!({"id": id, "name": name, "studio": st, "dashboard": da, "overlay": ov}));
        store.insert("active".into(), json!(id));
        write(&store)?;
        Self::prune(&store, dash, &[old_logo]);
        Ok(Self::view(&store, studio, dash))
    }

    pub fn rename(&self, studio: &Studio, dash: &Dashboard, id: &str, name: &str) -> Result<Value, PresetError> {
        let name = clean_name(name);
        if name.is_empty() {
            return Err(PresetError::Invalid("Give the preset a name".into()));
        }
        let _g = self.lock.lock().unwrap();
        let mut store = Self::load(studio, dash)?;
        if arr(store.get("presets")).iter().any(|p| p["id"] != id && p["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&name))) {
            return Err(PresetError::Invalid(format!("There is already a preset called {}", name)));
        }
        let p = find(&mut store, id).ok_or(PresetError::NotFound)?;
        p["name"] = json!(name);
        write(&store)?;
        Ok(Self::view(&store, studio, dash))
    }

    /// Keep the live settings in the active preset, then put the chosen one live
    pub fn activate(&self, studio: &Studio, dash: &Dashboard, id: &str) -> Result<Value, PresetError> {
        let _g = self.lock.lock().unwrap();
        let mut store = Self::load(studio, dash)?;
        if get_str(&store, "active", "") == id {
            return Ok(Self::view(&store, studio, dash));
        }
        let target = find(&mut store, id).ok_or(PresetError::NotFound)?.clone();
        let old_logo = Self::capture(&mut store, studio, dash);
        store.insert("active".into(), json!(id));
        // Stored before the switch, so the dashboard keeps the logo the old preset now holds
        write(&store)?;
        Self::apply(&target, studio, dash)?;
        Self::prune(&store, dash, &[old_logo]);
        Ok(Self::view(&store, studio, dash))
    }

    /// Delete a preset; the last one stays. Deleting the active one puts the first other one live.
    pub fn delete(&self, studio: &Studio, dash: &Dashboard, id: &str) -> Result<Value, PresetError> {
        let _g = self.lock.lock().unwrap();
        let mut store = Self::load(studio, dash)?;
        let gone = find(&mut store, id).ok_or(PresetError::NotFound)?.clone();
        if arr(store.get("presets")).len() <= 1 {
            return Err(PresetError::Invalid("The last preset stays".into()));
        }
        presets_mut(&mut store).retain(|p| p["id"] != id);
        let mut candidates = vec![py_str(&gone["dashboard"]["logo"])];
        if get_str(&store, "active", "") == id {
            let next = store["presets"][0].clone();
            candidates.push(get_str(&dash.load(), "logo", ""));
            store.insert("active".into(), next["id"].clone());
            write(&store)?;
            Self::apply(&next, studio, dash)?;
        } else {
            write(&store)?;
        }
        Self::prune(&store, dash, &candidates);
        Ok(Self::view(&store, studio, dash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn studio_part_keeps_only_the_event_settings() {
        let raw = json!({"title": "Friday League", "theme": "pop", "accent": "#ff0000", "texts": {"intro_vs": "V"}, "layout": "board",
            "cameras": {"board": {"kind": "url", "url": "http://x"}}, "players": [{"id": "a", "name": "Ann"}], "relay_fps": 30});
        let p = studio_part(Some(&raw));
        assert_eq!(p["title"], "Friday League");
        assert_eq!(p["theme"], "pop");
        assert_eq!(p["texts"], json!({"intro_vs": "V"}));
        for k in ["cameras", "players", "layout", "relay_fps", "dart_zoom", "auto_direct", "camera_resolution"] {
            assert!(p.get(k).is_none(), "{} must stay with the PC", k);
        }
        assert_eq!(p.len(), STUDIO_KEYS.len());
    }

    #[test]
    fn clean_store_checks_every_preset() {
        let raw = json!({"active": "nope", "presets": [
            {"id": "p-1", "name": "  Friday   League ", "studio": {"theme": "bogus"}, "dashboard": {"theme": "flap", "logo": "../etc"}},
            {"id": "p-1", "name": "Twice"},
            {"id": "bad id!", "name": "X"},
            {"id": "p-2", "name": ""},
            {"id": "p-3", "name": "Championship", "overlay": {"look": "pop", "casual": true}}
        ]});
        let s = clean_store(Some(&raw)).unwrap();
        let names: Vec<&str> = s["presets"].as_array().unwrap().iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Friday League", "Championship"]);
        assert_eq!(s["active"], "p-1");
        assert_eq!(s["presets"][0]["studio"]["theme"], "autodarts");
        // A look that is gone: the Dashboard's default
        assert_eq!(s["presets"][0]["dashboard"]["theme"], "arena");
        // Stored before the Overlay was in presets: none, so switching leaves the Overlay alone
        assert!(s["presets"][0].get("overlay").is_none());
        assert_eq!(s["presets"][0]["dashboard"]["logo"], "");
        assert!(s["presets"][0]["studio"].get("cameras").is_none());
        assert_eq!(s["presets"][1]["overlay"]["look"], "pop");
        assert!(s["presets"][1]["overlay"].get("casual").is_none(), "casual stays with the PC");
        assert!(clean_store(Some(&json!({"presets": []}))).is_none());
        assert!(clean_store(None).is_none());
    }

    #[test]
    fn logos_in_use_counts_presets_and_live() {
        let store = clean_store(Some(&json!({"presets": [
            {"id": "a", "name": "A", "dashboard": {"logo": "dashboard-logo-aaaaaa.png"}},
            {"id": "b", "name": "B", "dashboard": {}}
        ]})))
        .unwrap();
        let live = crate::obj! {"logo" => "dashboard-logo-bbbbbb.webp"};
        let used = logos_in_use(Some(&store), &live);
        assert!(used.contains("dashboard-logo-aaaaaa.png"));
        assert!(used.contains("dashboard-logo-bbbbbb.webp"));
        assert_eq!(used.len(), 2);
        assert!(logos_in_use(None, &Obj::new()).is_empty());
    }

    #[test]
    fn names_are_tidied() {
        assert_eq!(clean_name("  a \n b  "), "a b");
        assert_eq!(clean_name(&"x".repeat(80)).len(), MAX_NAME);
    }
}
