//! /api/overlay: how the Local Tournament match screen looks on the boards (src/overlay.rs);
//! web/js/features/overlay.js edits it, chrome_extension/match.js draws it

use super::*;

/// The settings, and the look in force (own or the shared one, src/look.rs) for the preview
fn view(settings: Obj) -> Value {
    let mut out = crate::obj! {"status" => "ok"};
    out.extend(settings);
    let (look, accent) = crate::look::of("overlay");
    out.insert("look_now".into(), json!({"look": look, "accent": accent}));
    let d = crate::dashboard::Dashboard::new().load();
    out.insert("event".into(), json!({"title": get_str(&d, "title", ""), "subtitle": get_str(&d, "subtitle", ""), "logo": get_str(&d, "logo", "")}));
    Value::Object(out)
}

pub async fn get(State(_s): State<S>) -> ApiResult {
    ok(view(crate::overlay::load()))
}

pub async fn post(State(s): State<S>, req: Req) -> ApiResult {
    let settings = crate::overlay::save(&req.json()?).map_err(AppError::persistence)?;
    // Every board of a tournament this PC hosts follows at once
    s.tournaments.overlay_changed();
    ok(view(settings))
}
