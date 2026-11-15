//! /join: a QR code on a poster or screen lets a player add themselves to the roster from their
//! phone (same network). /api/join is public (no PIN): joining is the point. /api/club/join-qr gives the QR for the app and the extension.

use super::*;
use crate::studio::{self, PlayerError};

const JOIN_FIELDS: [&str; 2] = ["nickname", "country"];

/// The address the QR code opens: this PC in the local network
pub async fn qr(State(s): State<S>) -> ApiResult {
    let url = format!("http://{}:{}/join", studio_routes::lan_ip(), s.tournaments.port());
    let svg = qrcode::QrCode::new(url.as_bytes())
        .map_err(|_| AppError::internal("Could not make the QR code"))?
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .quiet_zone(true)
        .dark_color(qrcode::render::svg::Color("#000000"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    ok(json!({"status": "ok", "url": url, "svg": svg}))
}

/// A new player from a phone: name, nickname, country and picture
pub async fn join(State(s): State<S>, req: Req) -> ApiResult {
    if s.club.is_board() {
        let ctype = req.header("content-type").unwrap_or("application/json").to_string();
        return s.club.forward("POST", "/api/join".into(), ctype, req.body.to_vec()).await.map(ok).map_err(AppError::validation).and_then(|r| r);
    }
    if !req.header("content-type").unwrap_or("").starts_with("multipart/") {
        return Err(AppError::validation("Expected a multipart form"));
    }
    let mut name = String::new();
    let mut fields = crate::obj! {};
    let mut image = None;
    for part in parse_multipart(&req) {
        if part.name == "image" && part.filename.is_some() {
            if part.data.len() > studio::MAX_IMAGE_BYTES {
                return Err(AppError::validation("Picture is larger than 5 MB"));
            }
            if !part.data.is_empty() {
                image = Some(part.data);
            }
        } else if part.name == "name" || JOIN_FIELDS.contains(&part.name.as_str()) {
            let t: String = String::from_utf8_lossy(&part.data).trim().chars().take(80).collect();
            if part.name == "name" {
                name = t;
            } else {
                fields.insert(part.name, json!(t));
            }
        }
    }
    if name.is_empty() {
        return Err(AppError::validation("Please enter your name"));
    }
    let taken = |p: &Value, n: &str| [&p["name"], &p["alias"]].iter().any(|v| !crate::py::py_str(v).is_empty() && crate::py::py_str(v).to_lowercase() == n.to_lowercase());
    let all = s.studio.load_settings();
    if crate::py::arr(all.get("players")).iter().any(|p| taken(p, &name)) {
        return Err(AppError::validation("That name is already on the list. Ask the club to link your account if it is you."));
    }
    let st = Arc::clone(&s.studio);
    let r = tokio::task::spawn_blocking(move || st.upsert_player(None, &name, &fields, image, None)).await.map_err(|_| AppError::internal("Could not save"))?;
    let p = r.map_err(|e| match e {
        PlayerError::Invalid(m) => AppError::validation(m),
        PlayerError::NotFound => AppError::not_found("Player not found"),
    })?;
    ok(json!({"status": "ok", "name": p["name"]}))
}
