//! Access control & secret handling: keeps credentials out of API responses, guards state-changing
//! requests against cross-site use, and enforces the optional LAN access PIN.

use crate::models::AppConfig;
use crate::py::Obj;
use hmac::{Hmac, Mac};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Mutex;

/// Keys that must never leave the server
pub const SECRET_KEYS: [&str; 4] = ["autodarts_password", "autodarts_access_token", "autodarts_refresh_token", "access_pin_hash"];
pub const PIN_HASH_KEY: &str = "access_pin_hash";
pub const SESSION_COOKIE: &str = "autoglow_session";
pub const SESSION_MAX_AGE: i64 = 30 * 24 * 3600;
const PIN_ITERATIONS: u32 = 200_000;
const PIN_MIN_LENGTH: usize = 4;
const PIN_MAX_LENGTH: usize = 32;
const LOGIN_MAX_FAILURES: usize = 5;
const LOGIN_LOCKOUT_SECONDS: f64 = 30.0;

/// Reachable without a session so the browser can load the UI and show the PIN prompt
pub const PUBLIC_API_PATHS: [&str; 2] = ["/api/auth/status", "/api/auth/login"];
/// The Chrome extension relays Autodarts game data here; only Chrome on this computer may connect
pub const BRIDGE_WS_PATH: &str = "/ws/autodarts-bridge";
/// The extension's WLED menu switches controllers off and on; same rule as the bridge
pub const EXTENSION_POST_PATHS: [&str; 2] = ["/api/power/test_off", "/api/power/test_wake"];

static LOGIN_FAILURES: Mutex<Option<HashMap<String, Vec<f64>>>> = Mutex::new(None);

fn now() -> f64 {
    crate::led_thread::wall()
}

/// A copy of a serialized config with every secret blanked out
pub fn redact_config(data: &mut Obj) {
    for k in SECRET_KEYS {
        if data.contains_key(k) {
            data.insert(k.into(), json!(""));
        }
    }
}

/// A blank secret in a saved config means "unchanged": copy the stored value back
pub fn restore_redacted_secrets(new_cfg: &mut AppConfig, old: &AppConfig) {
    if new_cfg.autodarts_password.is_empty() && !old.autodarts_password.is_empty() {
        new_cfg.autodarts_password = old.autodarts_password.clone();
    }
    for k in SECRET_KEYS {
        let old_v = old.extra.get(k).filter(|v| crate::py::truthy(v));
        let new_set = new_cfg.extra.get(k).map_or(false, crate::py::truthy);
        if let (Some(v), false) = (old_v, new_set) {
            new_cfg.extra.insert(k.into(), v.clone());
        }
    }
}

fn pbkdf2_hex(pin: &str, salt: &[u8], iterations: u32) -> String {
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(pin.as_bytes(), salt, iterations, &mut out);
    hex::encode(out)
}

pub fn hash_pin(pin: &str) -> String {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    format!("pbkdf2_sha256${}${}${}", PIN_ITERATIONS, hex::encode(salt), pbkdf2_hex(pin, &salt, PIN_ITERATIONS))
}

pub fn verify_pin(pin: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2_sha256" {
        return false;
    }
    let (Ok(it), Ok(salt)) = (parts[1].parse::<u32>(), hex::decode(parts[2])) else { return false };
    constant_eq(pbkdf2_hex(pin, &salt, it).as_bytes(), parts[3].as_bytes())
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// An error message when the PIN is not acceptable
pub fn validate_new_pin(pin: &str) -> Option<String> {
    if pin.is_empty() || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Some("PIN must contain digits only.".into());
    }
    if !(PIN_MIN_LENGTH..=PIN_MAX_LENGTH).contains(&pin.chars().count()) {
        return Some(format!("PIN must be {}-{} digits long.", PIN_MIN_LENGTH, PIN_MAX_LENGTH));
    }
    None
}

pub fn get_pin_hash(cfg: &AppConfig) -> String {
    cfg.extra.get(PIN_HASH_KEY).filter(|v| crate::py::truthy(v)).map(crate::py::py_str).unwrap_or_default()
}

/// Keyed on the PIN hash, so changing or removing the PIN invalidates every session
fn sign(pin_hash: &str, issued_at: &str) -> String {
    let mut m = Hmac::<Sha256>::new_from_slice(pin_hash.as_bytes()).expect("hmac key");
    m.update(format!("autoglow-session:{}", issued_at).as_bytes());
    hex::encode(m.finalize().into_bytes())
}

pub fn create_session_token(pin_hash: &str) -> String {
    let issued = (now() as i64).to_string();
    format!("{}.{}", issued, sign(pin_hash, &issued))
}

pub fn is_valid_session(token: Option<&str>, pin_hash: &str) -> bool {
    let Some(t) = token else { return false };
    if pin_hash.is_empty() || !t.contains('.') {
        return false;
    }
    let (issued, sig) = t.split_once('.').unwrap();
    let Ok(i) = issued.parse::<i64>() else { return false };
    if now() as i64 - i > SESSION_MAX_AGE {
        return false;
    }
    constant_eq(sig.as_bytes(), sign(pin_hash, issued).as_bytes())
}

pub fn session_cookie(pin_hash: &str) -> String {
    format!("{}={}; Max-Age={}; Path=/; HttpOnly; SameSite=Strict", SESSION_COOKIE, create_session_token(pin_hash), SESSION_MAX_AGE)
}

pub fn clear_cookie() -> String {
    format!("{}=\"\"; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/", SESSION_COOKIE)
}

pub fn cookie_value(headers: &axum::http::HeaderMap, name: &str) -> Option<String> {
    for h in headers.get_all(axum::http::header::COOKIE) {
        let Ok(s) = h.to_str() else { continue };
        for part in s.split(';') {
            if let Some((k, v)) = part.trim().split_once('=') {
                if k == name {
                    return Some(v.trim_matches('"').to_string());
                }
            }
        }
    }
    None
}

/// Seconds until this client may try again (0 if not locked out)
pub fn login_lockout_remaining(ip: &str) -> i64 {
    let mut g = LOGIN_FAILURES.lock().unwrap();
    let m = g.get_or_insert_with(HashMap::new);
    let t = now();
    let recent: Vec<f64> = m.get(ip).map(|v| v.iter().copied().filter(|x| t - x < LOGIN_LOCKOUT_SECONDS).collect()).unwrap_or_default();
    let out = if recent.len() >= LOGIN_MAX_FAILURES { (LOGIN_LOCKOUT_SECONDS - (t - recent[0])) as i64 + 1 } else { 0 };
    m.insert(ip.into(), recent);
    out
}

pub fn record_login_failure(ip: &str) {
    LOGIN_FAILURES.lock().unwrap().get_or_insert_with(HashMap::new).entry(ip.into()).or_default().push(now());
}

pub fn clear_login_failures(ip: &str) {
    if let Some(m) = LOGIN_FAILURES.lock().unwrap().as_mut() {
        m.remove(ip);
    }
}

pub fn is_loopback(remote: Option<&std::net::IpAddr>) -> bool {
    match remote {
        Some(std::net::IpAddr::V4(v)) => v.is_loopback(),
        Some(std::net::IpAddr::V6(v)) => v.is_loopback() || v.to_ipv4_mapped().map_or(false, |m| m.is_loopback()),
        None => false,
    }
}

/// Why an extension bridge connection is refused, or None when it is allowed
pub fn bridge_rejection_reason(origin: Option<&str>, remote: Option<&std::net::IpAddr>) -> Option<&'static str> {
    if let Some(o) = origin {
        if !o.starts_with("chrome-extension://") {
            return Some("Only the AutoGlow Chrome extension may connect to the bridge");
        }
    }
    if is_loopback(remote) {
        None
    } else {
        Some("The extension must run in Chrome on the AutoGlow computer itself")
    }
}

/// Origin header naming another site than the Host the request came to
pub fn is_cross_origin(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(o) = origin else { return false };
    if o == "null" {
        return true;
    }
    let netloc = o.split_once("://").map(|(_, r)| r).unwrap_or(o).split('/').next().unwrap_or("").to_lowercase();
    netloc != host.unwrap_or("").to_lowercase()
}

pub fn auth_required_body() -> Value {
    let mut b = crate::errors::error_body("AUTH_REQUIRED", "Access PIN required", None, false, None);
    b["auth_required"] = json!(true);
    b
}
