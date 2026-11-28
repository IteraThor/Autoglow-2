//! /api/overlay: how the Local Tournament match screen looks on the boards (src/overlay.rs);
//! web/js/features/overlay.js edits it, chrome_extension/match.js draws it

use super::*;

/// The settings, and the looks of the Dashboard and the Studio ("Same as …" previews them)
fn view(settings: Obj) -> Value {
    let mut out = crate::obj! {"status" => "ok"};
    out.extend(settings);
    out.insert("follow".into(), crate::overlay::follow());
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
