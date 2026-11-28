//! /api/dashboard: the Local Tournament dashboard's settings, its logo and "on all TVs now"
//! (src/dashboard.rs); web/studio/tournament.html reads them, web/js/features/dashboard.js edits them

use super::*;
use crate::dashboard;
use axum::body::Body;
use axum::extract::Path;

/// The settings with the look in force (its own, or the shared one: src/look.rs), what the TVs hold
/// now and the address to open on a TV
fn view(s: &S, req: &Req, settings: crate::py::Obj) -> Value {
    let mut out = crate::obj! {"status" => "ok"};
    out.extend(settings);
    let (theme, accent) = crate::look::of("dashboard");
    out.insert("theme".into(), json!(theme));
    out.insert("accent".into(), json!(accent));
    out.insert("hold".into(), s.dashboard.hold.lock().unwrap().clone());
    let ip = studio_routes::lan_ip();
    let port = req.header("host").and_then(|h| h.rsplit_once(':')).and_then(|(_, p)| p.parse::<u16>().ok()).unwrap_or(80);
    out.insert("tv_url".into(), json!(if ip.is_empty() { String::new() } else { format!("http://{}:{}/tournament/live", ip, port) }));
    Value::Object(out)
}

pub async fn get(State(s): State<S>, req: Req) -> ApiResult {
    let settings = s.dashboard.load();
    ok(view(&s, &req, settings))
}

pub async fn post(State(s): State<S>, req: Req) -> ApiResult {
    let settings = s.dashboard.save(&req.json()?).map_err(AppError::persistence)?;
    ok(view(&s, &req, settings))
}

pub async fn logo_upload(State(s): State<S>, req: Req) -> ApiResult {
    let part = parse_multipart(&req).into_iter().find(|p| p.name == "logo" && !p.data.is_empty()).ok_or_else(|| AppError::validation("No picture sent"))?;
    let settings = s.dashboard.set_logo(&part.data).map_err(AppError::validation)?;
    ok(view(&s, &req, settings))
}

pub async fn logo(Path(name): Path<String>) -> ApiResult {
    let p = dashboard::logo_path(&name).ok_or_else(|| AppError::not_found("Logo not found"))?;
    let b = tokio::fs::read(&p).await.map_err(|_| AppError::not_found("Logo not found"))?;
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(crate::studio::image_mime(&name)));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
    Ok(r)
}

/// Every TV shows this scene until it is set back to "" (the rotation)
pub async fn hold(State(s): State<S>, req: Req) -> ApiResult {
    let scene = get_str(&req.json()?, "scene", "");
    let hold = s.dashboard.set_hold(&scene).map_err(AppError::validation)?;
    ok(json!({"status": "ok", "hold": hold}))
}
