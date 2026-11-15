//! /api/hub/status (engine, Autodarts and controller health), /api/status (the cheap header snapshot
//! every page polls; it never contacts the controllers) and /api/setup/checklist

use super::*;
use crate::models::{AppConfig, LightingMode, ProtocolMode};

fn seconds_until(limit_min: i64, enabled: bool, idle: f64) -> Value {
    if !enabled {
        return Value::Null;
    }
    json!(0.max((limit_min as f64 * 60.0 - idle) as i64))
}

pub fn engine_snapshot(s: &S, cfg: &AppConfig) -> Value {
    let e = &s.engine;
    let streaming = e.any_streaming();
    let st = e.state();
    let power = if st.is_board_off {
        "off"
    } else if st.is_board_dimmed {
        "dimmed"
    } else {
        "on"
    };
    let idle = (wall() - st.last_activity_time).max(0.0);
    json!({
        "running": true,
        "lighting_mode": cfg.lighting_mode.as_str(),
        "protocol_mode": if streaming { "udp" } else { "http" },
        "power_state": power,
        "illumination": st.current_illumination,
        "idle_seconds": idle as i64,
        "dim_in_seconds": if st.is_board_dimmed { Value::Null } else { seconds_until(cfg.inactivity_timeout_minutes, cfg.inactivity_timeout_enabled, idle) },
        "off_in_seconds": if st.is_board_off { Value::Null } else { seconds_until(cfg.idle_power_off_minutes, cfg.idle_power_off_enabled, idle) },
        "last_event": st.last_event_name,
        "previous_event": st.previous_event_name,
        "flow_phase": e.flow_active_phase(),
    })
}

pub fn autodarts_snapshot(s: &S) -> Value {
    let Some(ad) = &s.engine.autodarts else { return json!({"configured": false, "connected": false}) };
    let st = ad.lock();
    let mid = st.active_match_id().map(str::to_string);
    json!({
        "configured": true, "source": "extension", "connected": st.is_connected, "tab_attached": st.tab_attached, "account": "",
        "match_active": mid.is_some(), "match_id": mid.unwrap_or_default(), "players": st.current_players,
        "active_player_idx": st.active_player_idx,
    })
}

async fn device_snapshot(s: S, dev: crate::models::DeviceConfig) -> Value {
    let drv = if dev.ip.is_empty() { None } else { s.engine.drivers().into_iter().find(|d| d.ip().trim() == dev.ip.trim()) };
    let streaming = drv.as_ref().map_or(false, |d| d.protocol_mode() == ProtocolMode::ActiveUdp);
    let mut out = crate::obj! {
        "name" => dev.name, "ip" => dev.ip, "enabled" => dev.enabled, "protocol_mode" => if streaming { "udp" } else { "http" },
        "configured_segments" => dev.segments.len(),
    };
    if !dev.enabled || dev.ip.is_empty() {
        out.insert("online".into(), Value::Null);
        out.insert("warnings".into(), json!([]));
        return Value::Object(out);
    }
    if streaming {
        // No HTTP polling while the UDP stream owns the controller
        out.insert("online".into(), Value::Null);
        out.insert("streaming".into(), json!(true));
        out.insert("warnings".into(), json!([]));
        out.insert("playing".into(), json!(if drv.map_or(false, |d| d.is_playing_effects()) { "effects" } else { "idle" }));
        return Value::Object(out);
    }
    let ip = dev.ip.clone();
    let health = tokio::task::spawn_blocking(move || wled::fetch_device_health(&ip, false, 1.0)).await.unwrap_or(json!({"online": false, "warnings": []}));
    if let Value::Object(h) = &health {
        for (k, v) in h {
            out.insert(k.clone(), v.clone());
        }
        if h.get("online") == Some(&json!(true)) {
            out.insert("playing".into(), json!(if h.get("on") == Some(&json!(false)) { "off" } else { "idle" }));
        }
    }
    Value::Object(out)
}

pub async fn hub_status(State(s): State<S>) -> ApiResult {
    let cfg = s.engine.cfg_clone();
    let futs: Vec<_> = cfg.devices.iter().map(|d| device_snapshot(Arc::clone(&s), d.clone())).collect();
    let devices = futures_util::future::join_all(futs).await;
    ok(json!({"status": "ok", "version": crate::VERSION, "engine": engine_snapshot(&s, &cfg), "autodarts": autodarts_snapshot(&s), "devices": devices}))
}

pub async fn status(State(s): State<S>) -> ApiResult {
    let cfg = s.engine.cfg_clone();
    let e = engine_snapshot(&s, &cfg);
    ok(json!({
        "status": "ok", "version": crate::VERSION, "lighting_mode": e["lighting_mode"], "protocol_mode": e["protocol_mode"],
        "power_state": e["power_state"], "flow_phase": e["flow_phase"], "autodarts": autodarts_snapshot(&s),
    }))
}

/// Flow Matrix ships with working default steps; the Event Matrix needs an enabled effect on a controller
fn lighting_configured(cfg: &AppConfig) -> bool {
    if cfg.lighting_mode == LightingMode::Flow {
        return true;
    }
    cfg.devices.iter().filter(|d| !d.ip.is_empty()).any(|d| {
        let ids: Vec<Option<i64>> = if d.segments.is_empty() { vec![None] } else { d.segments.iter().map(|x| Some(x.id)).collect() };
        ids.into_iter().any(|sid| cfg.profile_for(Some(&d.ip), sid).events.iter().any(|(_, e)| e.enabled))
    })
}

pub async fn setup_checklist(State(s): State<S>) -> ApiResult {
    let cfg = s.engine.cfg_clone();
    let connected = s.engine.autodarts.as_ref().map_or(false, |a| a.lock().is_connected);
    let steps = vec![
        json!({"id": "controller", "done": cfg.devices.iter().any(|d| !d.ip.is_empty())}),
        json!({"id": "autodarts", "done": connected}),
        json!({"id": "lighting", "done": lighting_configured(&cfg)}),
    ];
    let complete = steps.iter().all(|s| s["done"] == json!(true));
    ok(json!({"status": "ok", "steps": steps, "complete": complete}))
}
