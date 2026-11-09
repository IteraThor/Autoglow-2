//! The route table: every SPA page, REST endpoint and WebSocket

use crate::errors::{json_status, ok, ApiResult, AppError};
use crate::http;
use crate::led_thread::wall;
use crate::py::*;
use crate::server::{no_store_file, Req, S};
use crate::wled::{self, WledDriver};
use axum::extract::State;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use log::{error, info, warn};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;

mod auth;
mod autodarts_routes;
mod config;
mod flow_routes;
mod hub;
mod misc_routes;
mod power;
mod profiles;
mod studio_routes;
mod wled_routes;

/// Save the current config to disk
pub fn save_cfg(s: &S, cfg: &mut crate::models::AppConfig) -> bool {
    crate::storage::save_app_config(cfg, &s.engine.config_path)
}

pub struct Part {
    pub name: String,
    pub filename: Option<String>,
    pub data: Vec<u8>,
}

/// The parts of a multipart/form-data body
pub fn parse_multipart(req: &Req) -> Vec<Part> {
    let ct = req.header("content-type").unwrap_or("");
    let Some(b) = ct.split(';').filter_map(|p| p.trim().strip_prefix("boundary=")).next() else { return Vec::new() };
    let delim = format!("--{}", b.trim_matches('"')).into_bytes();
    let body = &req.body[..];
    let find = |from: usize| body[from..].windows(delim.len()).position(|w| w == &delim[..]).map(|p| p + from);
    let mut out = Vec::new();
    let Some(mut pos) = find(0) else { return out };
    loop {
        let start = pos + delim.len();
        if body.get(start..start + 2) == Some(b"--") {
            break;
        }
        let Some(next) = find(start) else { break };
        let mut part = &body[start..next];
        part = part.strip_prefix(b"\r\n").unwrap_or(part);
        part = part.strip_suffix(b"\r\n").unwrap_or(part);
        if let Some(h) = part.windows(4).position(|w| w == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&part[..h]).to_string();
            let data = part[h + 4..].to_vec();
            let mut name = String::new();
            let mut filename = None;
            for line in headers.lines() {
                if line.to_lowercase().starts_with("content-disposition") {
                    for kv in line.split(';').skip(1) {
                        if let Some((k, v)) = kv.trim().split_once('=') {
                            let v = v.trim().trim_matches('"').to_string();
                            match k.trim() {
                                "name" => name = v,
                                "filename" => filename = Some(v),
                                _ => {}
                            }
                        }
                    }
                }
            }
            out.push(Part { name, filename, data });
        }
        pos = next;
    }
    out
}

/// The first uploaded file of a multipart body: (file name, bytes)
pub async fn first_multipart_file(req: &Req) -> Option<(Option<String>, Vec<u8>)> {
    parse_multipart(req).into_iter().next().map(|p| (p.filename, p.data))
}

/// Every page of the single-page app. The first group is canonical; the rest are older links that
/// web/js/core/router.js redirects to their canonical page.
pub const SPA_PATHS: &[&str] = &[
    "/", "/hub", "/setup", "/setup/controllers", "/setup/connection", "/lighting", "/lighting/matrix", "/lighting/flow", "/studio", "/studio/broadcast",
    "/studio/match", "/studio/players", "/studio/cameras", "/classic", "/power", "/settings", "/index.html", "/home", "/dashboard", "/devices", "/wled-devices",
    "/autodarts", "/autodarts-account", "/matrix", "/event-matrix", "/simulator", "/led-simulator", "/power-timers", "/idle", "/idle-mode", "/updates",
    "/updates-backups", "/backups",
];

pub fn register(mut r: Router<S>, web_dir: &Path) -> Router<S> {
    let index = web_dir.join("index.html");
    for p in SPA_PATHS {
        let i = index.clone();
        r = r.route(p, get(move || no_store_file(i.clone())));
    }
    let i = index.clone();
    r = r.route("/setup/controllers/{ip}", get(move || no_store_file(i.clone())));
    let live = web_dir.join("studio").join("live.html");
    r = r.route("/studio/live", get(move || no_store_file(live.clone())));
    let js_dir = web_dir.join("studio").join("js");
    r = r.route(
        "/studio/js/{name}",
        get(move |axum::extract::Path(name): axum::extract::Path<String>| {
            let dir = js_dir.clone();
            async move {
                if !name.ends_with(".js") || name.contains('/') || name.contains("..") {
                    return axum::http::StatusCode::NOT_FOUND.into_response();
                }
                match tokio::fs::read(dir.join(&name)).await {
                    Ok(b) => {
                        let mut resp = Response::new(axum::body::Body::from(b));
                        resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/javascript"));
                        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
                        resp
                    }
                    Err(_) => axum::http::StatusCode::NOT_FOUND.into_response(),
                }
            }
        }),
    );
    r.route("/api/auth/status", get(auth::status))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/pin", post(auth::set_pin))
        .route("/api/hub/status", get(hub::hub_status))
        .route("/api/status", get(hub::status))
        .route("/api/setup/checklist", get(hub::setup_checklist))
        .route("/api/config", get(config::get_config).post(config::post_config))
        .route("/api/config/reset", post(config::reset_config))
        .route("/api/matrix/presets", get(profiles::get_presets).delete(profiles::delete_preset))
        .route("/api/matrix/presets/select", post(profiles::select_preset))
        .route("/api/matrix/presets/save", post(profiles::save_preset))
        .route("/api/matrix/presets/rename", post(profiles::rename_preset))
        .route("/api/matrix/presets/export", get(profiles::export_preset))
        .route("/api/matrix/presets/import", post(profiles::import_preset))
        .route("/api/ping", get(wled_routes::ping))
        .route("/api/wled/update", post(wled_routes::wled_update))
        .route("/api/wled/preset", get(wled_routes::get_wled_preset).post(wled_routes::save_wled_preset))
        .route("/api/wled/segment-name", post(wled_routes::rename_segment))
        .route("/api/wled/game-brightness", post(wled_routes::game_brightness))
        .route("/api/wled/effects", get(wled_routes::get_wled_effects))
        .route("/api/wled/preview", post(wled_routes::preview_wled_state))
        .route("/api/wled/setup-preview", post(wled_routes::setup_preview))
        .route("/api/scan/network", get(wled_routes::scan_network))
        .route("/api/protocol/mode", get(wled_routes::get_protocol_mode).post(wled_routes::post_protocol_mode))
        .route("/api/test/effect", post(wled_routes::test_effect))
        .route("/api/test/light", post(wled_routes::test_light))
        .route("/api/test/end", post(wled_routes::test_end))
        .route("/api/power/test_dim", post(power::test_dim))
        .route("/api/power/test_off", post(power::test_off))
        .route("/api/power/test_wake", post(power::test_wake))
        .route("/api/autodarts/login", post(autodarts_routes::login))
        .route("/api/autodarts/logout", post(autodarts_routes::logout))
        .route("/api/autodarts/boards", get(autodarts_routes::boards))
        .route("/api/autodarts/status", get(autodarts_routes::status))
        .route("/api/autodarts/device/code", post(autodarts_routes::device_code))
        .route("/api/autodarts/device/poll", post(autodarts_routes::device_poll))
        .route("/api/autodarts/bridge", get(autodarts_routes::bridge_info))
        .route(crate::security::BRIDGE_WS_PATH, get(autodarts_routes::bridge_ws))
        .route(misc_routes::UPDATE_XML_PATH, get(misc_routes::update_xml))
        .route(misc_routes::CRX_PATH, get(misc_routes::crx))
        .route("/ws/telemetry", get(autodarts_routes::telemetry_ws))
        .route("/api/flow/overview", get(flow_routes::get_overview))
        .route("/api/flow/profile", get(flow_routes::get_profile))
        .route("/api/flow/profile/save", post(flow_routes::save_profile))
        .route("/api/flow/profile/create", post(flow_routes::create_profile))
        .route("/api/flow/profile/delete", post(flow_routes::delete_profile))
        .route("/api/flow/profile/reset", post(flow_routes::reset_profile))
        .route("/api/flow/profile/default", post(flow_routes::set_default))
        .route("/api/flow/assign", post(flow_routes::assign))
        .route("/api/flow/segment/copy", post(flow_routes::segment_copy))
        .route("/api/flow/segment/preset", post(flow_routes::segment_preset))
        .route("/api/flow/segment/restore", post(flow_routes::segment_restore))
        .route("/api/flow/preset/save", post(flow_routes::preset_save))
        .route("/api/flow/preset/delete", post(flow_routes::preset_delete))
        .route("/api/flow/idle/apply", post(flow_routes::apply_idle))
        .route("/api/flow/try", post(flow_routes::try_look))
        .route("/api/flow/preview", post(flow_routes::preview))
        .route("/api/flow/preview/stop", post(flow_routes::preview_stop))
        .route("/api/flow/segment-direction", post(flow_routes::segment_direction))
        .route("/api/flow/standby", post(flow_routes::standby))
        .route("/api/flow/mode", get(flow_routes::get_mode).post(flow_routes::set_mode))
        .route("/api/studio", get(studio_routes::get_studio).post(studio_routes::post_studio))
        .route("/api/studio/players", post(studio_routes::save_player))
        .route("/api/studio/players/{id}", post(studio_routes::update_player).merge(delete(studio_routes::delete_player)))
        .route("/api/studio/images/{name}", get(studio_routes::player_image))
        .route("/api/studio/state", get(studio_routes::state))
        .route("/api/studio/raw", get(studio_routes::raw))
        .route("/api/studio/cameras", get(studio_routes::list_cameras))
        .route("/api/studio/stream", get(studio_routes::camera_stream))
        .route("/api/studio/video", get(studio_routes::camera_video))
        .route("/api/studio/output-log", post(studio_routes::output_log))
        .route("/api/studio/camera-controls", get(studio_routes::get_camera_controls).post(studio_routes::set_camera_controls))
        .route("/api/studio/cue", post(studio_routes::cue))
        .route("/api/studio/remember-name", post(studio_routes::remember_name))
        .route("/api/studio/autodarts", get(studio_routes::autodarts_state))
        .route("/api/studio/autodarts/start", post(studio_routes::autodarts_start))
        .route("/api/classic", get(misc_routes::get_classic).post(misc_routes::post_classic))
        .route("/api/classic/test", post(misc_routes::test_classic))
        .route("/api/{*rest}", axum::routing::any(|| async { json_status(404, crate::errors::error_body("NOT_FOUND", "Unknown API endpoint", None, false, None)) }))
}
