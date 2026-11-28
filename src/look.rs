//! The look (theme and accent colour) of the Studio, the Dashboard and the Overlay. With look_sync on
//! (the Studio setting, on by default) all three use the Studio's theme and accent, so a change on any
//! of the pages changes all three. With it off each page keeps its own: the Studio its theme and
//! accent, the Dashboard its theme and accent (studio/dashboard.json), the Overlay its look and accent
//! (studio/overlay.json). /api/look reads and changes it for any page; web/js/features/studio-parts.js
//! lookPicker is the same picker with the switch on all three pages.

use crate::dashboard::Dashboard;
use crate::py::*;
use crate::studio::{Studio, THEMES};
use serde_json::{json, Value};

pub const PAGES: [&str; 3] = ["studio", "dashboard", "overlay"];

fn studio_look(st: &Obj) -> (String, String) {
    (get_str(st, "theme", "autodarts"), get_str(st, "accent", ""))
}

/// A page's own look, whatever the switch says
fn own(page: &str, st: &Obj, dash: &Obj, ov: &Obj) -> (String, String) {
    match page {
        "dashboard" => (get_str(dash, "theme", "arena"), get_str(dash, "accent", "")),
        "overlay" => (get_str(ov, "look", "autodarts"), get_str(ov, "accent", "")),
        _ => studio_look(st),
    }
}

/// The look a page shows now: (theme, accent)
pub fn of(page: &str) -> (String, String) {
    let st = Studio::new().load_settings();
    if get_bool(&st, "look_sync", true) || page == "studio" {
        return studio_look(&st);
    }
    own(page, &st, &Dashboard::new().load(), &crate::overlay::load())
}

/// The switch and every page's look now
pub fn view() -> Value {
    let st = Studio::new().load_settings();
    let mut out = crate::obj! {"status" => "ok", "sync" => get_bool(&st, "look_sync", true)};
    for p in PAGES {
        let (theme, accent) = of(p);
        out.insert(p.into(), json!({"theme": theme, "accent": accent}));
    }
    Value::Object(out)
}

fn is_hex(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// A change from one page: {page, theme?, accent?, sync?}. Switching sync on makes that page's look
/// the shared one; switching it off gives every page the shared look as its own, so nothing jumps.
pub fn set(studio: &Studio, dash: &Dashboard, body: &Obj) -> Result<Value, String> {
    let page = get_str(body, "page", "studio");
    if !PAGES.contains(&page.as_str()) {
        return Err("Unknown page".into());
    }
    let st = studio.load_settings();
    let was = get_bool(&st, "look_sync", true);
    let sync = body.get("sync").and_then(Value::as_bool).unwrap_or(was);
    let (mut theme, mut accent) = if was { studio_look(&st) } else { own(&page, &st, &dash.load(), &crate::overlay::load()) };
    if let Some(t) = body.get("theme").and_then(Value::as_str) {
        if !THEMES.contains(&t) {
            return Err("Unknown look".into());
        }
        theme = t.to_string();
    }
    if let Some(a) = body.get("accent").and_then(Value::as_str) {
        if !is_hex(a) {
            return Err("Unknown colour".into());
        }
        accent = a.to_lowercase();
    }
    // The Studio's accent is always a colour; a page without its own uses the Studio's
    let shared_accent = if is_hex(&accent) { accent.clone() } else { get_str(&st, "accent", "") };
    if sync {
        studio.save_settings(&crate::obj! {"look_sync" => true, "theme" => theme, "accent" => shared_accent})?;
    } else {
        if was {
            let (t, a) = studio_look(&st);
            dash.save(&crate::obj! {"theme" => t.clone(), "accent" => a.clone()})?;
            crate::overlay::save(&crate::obj! {"look" => t, "accent" => a})?;
        }
        match page.as_str() {
            "dashboard" => {
                dash.save(&crate::obj! {"theme" => theme, "accent" => accent})?;
            }
            "overlay" => {
                crate::overlay::save(&crate::obj! {"look" => theme, "accent" => accent})?;
            }
            _ => {
                studio.save_settings(&crate::obj! {"theme" => theme, "accent" => shared_accent})?;
            }
        }
        if was {
            studio.save_settings(&crate::obj! {"look_sync" => false})?;
        }
    }
    Ok(view())
}
