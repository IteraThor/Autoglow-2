//! Access PIN: /api/auth/status, /api/auth/login, /api/auth/logout, /api/auth/pin

use super::*;
use crate::security::*;

fn with_cookie(mut r: Response, cookie: String) -> Response {
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        r.headers_mut().append(header::SET_COOKIE, v);
    }
    r
}

pub async fn status(State(s): State<S>, req: Req) -> ApiResult {
    let h = get_pin_hash(&s.engine.cfg());
    let authed = h.is_empty() || is_valid_session(cookie_value(&req.headers, SESSION_COOKIE).as_deref(), &h);
    ok(json!({"status": "ok", "pin_enabled": !h.is_empty(), "authenticated": authed}))
}

pub async fn login(State(s): State<S>, req: Req) -> ApiResult {
    let h = get_pin_hash(&s.engine.cfg());
    if h.is_empty() {
        return ok(json!({"status": "ok", "pin_enabled": false}));
    }
    let ip = req.client_ip();
    let wait = login_lockout_remaining(&ip);
    if wait > 0 {
        return Ok(json_status(429, json!({"status": "error", "message": format!("Too many attempts. Try again in {}s.", wait)})));
    }
    let pin = req.json_or_empty().get("pin").map(py_str).unwrap_or_default().trim().to_string();
    if !verify_pin(&pin, &h) {
        record_login_failure(&ip);
        warn!("Failed access PIN attempt from {}", ip);
        return Ok(json_status(401, json!({"status": "error", "message": "Incorrect PIN."})));
    }
    clear_login_failures(&ip);
    Ok(with_cookie(Json(json!({"status": "ok", "authenticated": true})).into_response(), session_cookie(&h)))
}

pub async fn logout() -> ApiResult {
    Ok(with_cookie(Json(json!({"status": "ok"})).into_response(), clear_cookie()))
}

/// Set, change or remove the access PIN. An empty new_pin removes protection.
pub async fn set_pin(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json_or_empty();
    let current = get_pin_hash(&s.engine.cfg());
    let cur_pin = data.get("current_pin").map(py_str).unwrap_or_default().trim().to_string();
    let new_pin = data.get("new_pin").map(py_str).unwrap_or_default().trim().to_string();
    if !current.is_empty() && !verify_pin(&cur_pin, &current) {
        return Ok(json_status(403, json!({"status": "error", "message": "Current PIN is incorrect."})));
    }
    let new_hash = if new_pin.is_empty() {
        String::new()
    } else {
        if let Some(e) = validate_new_pin(&new_pin) {
            return Ok(json_status(400, json!({"status": "error", "message": e})));
        }
        hash_pin(&new_pin)
    };
    let mut snap = {
        let mut c = s.engine.cfg();
        if new_hash.is_empty() {
            c.extra.shift_remove(PIN_HASH_KEY);
        } else {
            c.extra.insert(PIN_HASH_KEY.into(), json!(new_hash));
        }
        c.clone()
    };
    if !save_cfg(&s, &mut snap) {
        return Ok(json_status(500, json!({"status": "error", "message": "Failed to persist configuration to disk"})));
    }
    let resp = Json(json!({"status": "ok", "pin_enabled": !new_hash.is_empty()})).into_response();
    if new_hash.is_empty() {
        info!("Access PIN removed; API is open on the local network.");
        Ok(with_cookie(resp, clear_cookie()))
    } else {
        info!("Access PIN enabled/changed.");
        Ok(with_cookie(resp, session_cookie(&new_hash)))
    }
}
