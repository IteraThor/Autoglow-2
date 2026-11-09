//! The web server: shared state, the request extractor every handler uses, middleware (security,
//! error envelope, cache headers) and the route table.

use crate::engine::Engine;
use crate::errors::{error_body, json_status};
use crate::security;
use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, FromRequest, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Router;
use log::{error, warn};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

pub struct AppState {
    pub engine: Arc<Engine>,
    pub web_dir: PathBuf,
    pub classic: Arc<crate::classic::ClassicMode>,
    pub studio: Arc<crate::studio::Studio>,
    pub cameras: Arc<crate::studio_camera::CameraHub>,
    pub darts: Arc<crate::studio_darts::DartTracker>,
    pub video: Arc<crate::studio_video::VideoHub>,
}

pub type S = Arc<AppState>;

/// What handlers need from a request: query, headers, client address and the whole body
pub struct Req {
    pub query: HashMap<String, String>,
    pub headers: HeaderMap,
    pub remote: Option<SocketAddr>,
    pub body: Bytes,
}

impl Req {
    pub fn q(&self, k: &str) -> Option<&str> {
        self.query.get(k).map(String::as_str)
    }
    pub fn q_or<'a>(&'a self, k: &str, d: &'a str) -> &'a str {
        self.q(k).unwrap_or(d)
    }
    pub fn json(&self) -> Result<crate::py::Obj, crate::errors::AppError> {
        crate::errors::read_json(&self.body)
    }
    /// request.json() that falls back to {} like `except Exception: data = {}`
    pub fn json_or_empty(&self) -> crate::py::Obj {
        serde_json::from_slice::<serde_json::Value>(&self.body).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default()
    }
    pub fn client_ip(&self) -> String {
        self.remote.map(|r| r.ip().to_string()).unwrap_or_else(|| "unknown".into())
    }
    pub fn header(&self, k: &str) -> Option<&str> {
        self.headers.get(k).and_then(|v| v.to_str().ok())
    }
}

pub fn parse_query(q: Option<&str>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Some(q) = q {
        for (k, v) in form_urlencoded_pairs(q) {
            m.entry(k).or_insert(v);
        }
    }
    m
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn form_urlencoded_pairs(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (pct_decode(k), pct_decode(v)),
            None => (pct_decode(p), String::new()),
        })
        .collect()
}

impl<St: Send + Sync> FromRequest<St> for Req {
    type Rejection = Response;
    async fn from_request(req: Request, state: &St) -> Result<Self, Self::Rejection> {
        let query = parse_query(req.uri().query());
        let headers = req.headers().clone();
        let remote = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0);
        let body = Bytes::from_request(req, state).await.map_err(|e| e.into_response())?;
        Ok(Req { query, headers, remote, body })
    }
}

pub fn remote_of(req: &Request) -> Option<SocketAddr> {
    req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0)
}

/// Security: the bridge only from the extension on this computer, no cross-site writes, the access PIN
pub async fn security_mw(State(s): State<S>, req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let origin = req.headers().get(header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_string);
    let remote_ip = remote_of(&req).map(|r| r.ip());
    if path == security::BRIDGE_WS_PATH {
        if let Some(reason) = security::bridge_rejection_reason(origin.as_deref(), remote_ip.as_ref()) {
            warn!("Rejected extension bridge connection from {:?}: {}", remote_ip, reason);
            return json_status(403, error_body("FORBIDDEN", reason, None, false, None));
        }
        return next.run(req).await;
    }
    let is_api = path.starts_with("/api/") || path.starts_with("/ws/");
    let m = req.method().clone();
    if is_api && (!(m == Method::GET || m == Method::HEAD || m == Method::OPTIONS) || path.starts_with("/ws/")) {
        let from_ext = security::EXTENSION_POST_PATHS.contains(&path.as_str()) && security::bridge_rejection_reason(origin.as_deref(), remote_ip.as_ref()).is_none();
        let host = req.headers().get(header::HOST).and_then(|v| v.to_str().ok());
        if security::is_cross_origin(origin.as_deref(), host) && !from_ext {
            warn!("Rejected cross-origin {} {} from Origin {:?}", m, path, origin);
            return json_status(403, error_body("FORBIDDEN", "Cross-origin request rejected", None, false, None));
        }
    }
    if is_api && !security::PUBLIC_API_PATHS.contains(&path.as_str()) {
        let pin_hash = security::get_pin_hash(&s.engine.cfg());
        if !pin_hash.is_empty() && !security::is_valid_session(security::cookie_value(req.headers(), security::SESSION_COOKIE).as_deref(), &pin_hash) {
            return json_status(401, security::auth_required_body());
        }
    }
    next.run(req).await
}

/// Every /api failure answers in the standard error body; unknown /api paths and wrong methods included.
/// Static files get "Cache-Control: no-cache" so browsers revalidate unversioned scripts after an update.
pub async fn envelope_mw(req: Request, next: Next) -> Response {
    let is_api = req.uri().path().starts_with("/api/");
    let resp = next.run(req).await;
    let status = resp.status();
    let is_json = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).map_or(false, |c| c.starts_with("application/json"));
    if is_api && status.as_u16() >= 400 && !is_json {
        let code = match status.as_u16() {
            404 => "NOT_FOUND",
            405 => "METHOD_NOT_ALLOWED",
            _ => "HTTP_ERROR",
        };
        let reason = status.canonical_reason().unwrap_or("Error");
        return json_status(status.as_u16(), error_body(code, reason, None, false, None));
    }
    let mut resp = resp;
    if !resp.headers().contains_key(header::CACHE_CONTROL) {
        resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    }
    resp
}

/// A panic in a handler: logged with a reference, answered with the standard error body
pub fn panic_response(err: Box<dyn std::any::Any + Send + 'static>) -> Response {
    let msg = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    let rid = format!("{:08x}", rand::random::<u32>());
    error!("Unhandled exception [{}]: {}", rid, msg);
    json_status(
        500,
        error_body("INTERNAL", &format!("Internal server error (ref {}). Details are in autoglow.log.", rid), None, false, Some(serde_json::json!({"request_id": rid}))),
    )
}

/// A file from the web folder, never cached by the browser (the app pages)
pub async fn no_store_file(path: PathBuf) -> Response {
    match tokio::fs::read(&path).await {
        Ok(b) => {
            let ct = mime_for(&path);
            let mut r = Response::new(Body::from(b));
            r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(ct).unwrap());
            r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store, must-revalidate"));
            r
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

pub fn mime_for(p: &std::path::Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "mp4" => "video/mp4",
        "xml" => "application/xml",
        "crx" => "application/x-chrome-extension",
        _ => "application/octet-stream",
    }
}

pub fn build_router(s: S) -> Router {
    let web_dir = s.web_dir.clone();
    let mut app = crate::routes::register(Router::new(), &web_dir);
    let static_svc = tower_http::services::ServeDir::new(&web_dir).append_index_html_on_directories(false);
    app = app.fallback_service(static_svc);
    app.layer(axum::middleware::from_fn_with_state(Arc::clone(&s), security_mw))
        .layer(axum::middleware::from_fn(envelope_mw))
        .layer(tower_http::catch_panic::CatchPanicLayer::custom(panic_response))
        .with_state(s)
}
