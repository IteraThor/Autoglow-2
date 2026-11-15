//! Power & standby: test inactivity dimming, standby auto-off and wake-up (all controllers or one)

use super::*;
use crate::models::ProtocolMode;

/// Set a controller's power, verified from the state it reads back
fn set_wled_power(ip: &str, on: bool) -> Value {
    if ip.is_empty() {
        return json!({"ip": ip, "success": false, "error": "No IP"});
    }
    let url = format!("http://{}/json/state", ip);
    let payload = if on { json!({"on": true, "lor": 0, "ps": 1, "tt": 0, "v": true}) } else { json!({"on": false, "lor": 0, "tt": 0, "v": true}) };
    let res = (|| -> Result<Value, String> {
        let r = http::post_json_value(&url, &payload, 2.0)?;
        let mut rb = r.get("on").cloned().filter(|v| !v.is_null());
        if rb.is_none() {
            rb = http::get_json(&url, 1.5)?.get("on").cloned();
        }
        Ok(json!({"ip": ip, "success": rb == Some(json!(on)), "on": rb, "expected": on}))
    })();
    res.unwrap_or_else(|e| {
        error!("Error setting power on {}: {}", ip, e);
        json!({"ip": ip, "success": false, "error": e})
    })
}

fn requested_ip(req: &Req) -> Option<String> {
    let v: Value = serde_json::from_slice(&req.body).ok()?;
    v.get("ip").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

fn unknown(ip: &str) -> Response {
    json_status(404, json!({"status": "error", "message": format!("No controller at {}.", ip)}))
}

fn pick(s: &S, ip: &Option<String>) -> Result<Vec<Arc<WledDriver>>, Response> {
    match ip {
        Some(ip) => {
            let d: Vec<_> = s.engine.drivers().into_iter().filter(|d| d.ip().trim() == ip).collect();
            if d.is_empty() {
                Err(unknown(ip))
            } else {
                Ok(d)
            }
        }
        None => Ok(s.engine.drivers()),
    }
}

fn power_ips(s: &S) -> Vec<String> {
    let ips = s.engine.cfg().active_ips();
    if ips.is_empty() {
        s.engine.driver_ips()
    } else {
        ips
    }
}

pub async fn test_dim(State(s): State<S>, req: Req) -> ApiResult {
    let ip = requested_ip(&req);
    let drivers = match pick(&s, &ip) {
        Ok(d) => d,
        Err(r) => return Ok(r),
    };
    let dim = s.engine.cfg().idle_dimming_brightness;
    if ip.is_none() {
        let mut st = s.engine.state();
        st.is_board_dimmed = true;
        st.current_illumination = dim;
    }
    let was_udp = drivers.iter().any(|d| d.protocol_mode() == ProtocolMode::ActiveUdp);
    let mut verified = true;
    for d in &drivers {
        verified = d.transition_to_http_mode(1).await && verified;
        verified = d.set_board_light(dim, None).await && verified;
    }
    if was_udp && ip.is_none() {
        s.engine.broadcast(json!({"type": "protocol_state", "mode": "http"})).await;
    }
    if ip.is_none() {
        s.engine.broadcast(json!({"type": "power_state", "state": "dimmed"})).await;
    }
    if verified {
        ok(json!({"status": "ok", "verified": true, "message": "Inactivity dimming executed (Idle Preset 1 restored)."}))
    } else {
        ok(json!({"status": "warning", "verified": false, "message": "Dimming sent, but not every controller confirmed the new state."}))
    }
}

pub async fn test_off(State(s): State<S>, req: Req) -> ApiResult {
    let ip = requested_ip(&req);
    let drivers = match pick(&s, &ip) {
        Ok(d) => d,
        Err(r) => return Ok(r),
    };
    {
        let mut st = s.engine.state();
        match &ip {
            Some(i) => {
                st.off_ips.insert(i.clone());
            }
            None => {
                st.is_board_off = true;
                st.is_board_dimmed = true;
                st.current_illumination = 0;
            }
        }
    }
    let was_udp = drivers.iter().any(|d| d.protocol_mode() == ProtocolMode::ActiveUdp);
    for d in &drivers {
        if d.protocol_mode() == ProtocolMode::ActiveUdp {
            d.transition_to_http_mode(1).await;
        }
        d.set_board_light(0, None).await;
    }
    if was_udp && ip.is_none() {
        s.engine.broadcast(json!({"type": "protocol_state", "mode": "http"})).await;
    }
    let ips = ip.clone().map(|i| vec![i]).unwrap_or_else(|| power_ips(&s));
    let mut results = Vec::new();
    for i in ips {
        results.push(tokio::task::spawn_blocking(move || set_wled_power(&i, false)).await.unwrap_or(json!({"success": false})));
    }
    let all_ok = results.iter().all(|r| r["success"] == json!(true));
    if ip.is_none() {
        s.engine.broadcast(json!({"type": "power_state", "state": "off"})).await;
    }
    if all_ok {
        ok(json!({"status": "ok", "message": "Standby Auto-Off verified on physical hardware (All lights turned off).", "verified": true, "results": results}))
    } else {
        ok(json!({"status": "warning", "message": "Auto-Off payload sent, but some devices did not confirm power off.", "verified": false, "results": results}))
    }
}

pub async fn test_wake(State(s): State<S>, req: Req) -> ApiResult {
    let ip = requested_ip(&req);
    let drivers = match pick(&s, &ip) {
        Ok(d) => d,
        Err(r) => return Ok(r),
    };
    let ips = ip.clone().map(|i| vec![i]).unwrap_or_else(|| power_ips(&s));
    let mut results = Vec::new();
    for i in ips.clone() {
        results.push(tokio::task::spawn_blocking(move || set_wled_power(&i, true)).await.unwrap_or(json!({"success": false})));
    }
    if let Some(i) = &ip {
        s.engine.state().off_ips.remove(i);
        // Restore Idle Preset 1 on this controller only; wake_up() would touch every controller
        drivers[0].transition_to_http_mode(1).await;
    } else {
        s.engine.wake_up(ProtocolMode::IdleHttp).await;
        s.engine.state().current_illumination = 255;
    }
    // Wake means full brightness: master bri (RGB strip) after the preset loads, then the light strip
    for t in ips {
        let t2 = t.clone();
        let r = tokio::task::spawn_blocking(move || wled::preview_wled_state(&t2, &crate::obj! {"on" => true, "bri" => 255}, 2.0)).await;
        if !matches!(r, Ok(Ok(_))) {
            error!("Error setting full brightness on {}", t);
        }
    }
    for d in &drivers {
        d.set_board_light(255, None).await;
    }
    let all_ok = results.iter().all(|r| r["success"] == json!(true));
    if all_ok {
        ok(json!({"status": "ok", "message": "Power restored & verified on physical hardware (Active Spotlight).", "verified": true, "results": results}))
    } else {
        ok(json!({"status": "warning", "message": "Turn-on payload sent, but some devices did not confirm power on.", "verified": false, "results": results}))
    }
}
