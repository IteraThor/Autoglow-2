//! WLED hardware & network: controller updates, segment names, presets, previews, discovery and tests

use super::*;
use crate::engine::is_pwm_segment;
use crate::models::{is_pwm_output, DeviceConfig, EffectConfig, ProtocolMode, RGBColor, ANIMATIONS};
use crate::wled_layout::{segments_from_wled, unique_ranges};

fn unreachable_err(ip: &str) -> AppError {
    AppError::unreachable(format!("Could not reach the WLED controller at {}", ip)).field("ip")
}

pub async fn ping(req: Req) -> ApiResult {
    let ip = req.q_or("ip", "").trim().to_string();
    if ip.is_empty() {
        return ok(json!({"status": "ok", "online": false, "ip": "", "message": "No IP specified"}));
    }
    let ip2 = ip.clone();
    match tokio::task::spawn_blocking(move || wled::fetch_live_device_info(&ip2, 0.4)).await {
        Ok(v) => ok(v),
        Err(_) => ok(json!({"status": "ok", "online": false, "ip": ip, "message": "Controller did not respond"})),
    }
}

/// LED count of the first RGB output, wherever it sits; PWM outputs are skipped
fn rgb_count(hw: &[Value]) -> i64 {
    hw.iter().find(|h| h.is_object() && !is_pwm_output(h)).map_or(45, |h| safe_int(h.get("len"), 45))
}

/// The first segment name used twice on one controller (case and spacing ignored)
fn duplicate_name<'a>(names: impl Iterator<Item = String>) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    for n in names {
        let key = n.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
        if key.is_empty() {
            continue;
        }
        if !seen.insert(key) {
            return Some(n.trim().to_string());
        }
    }
    None
}

fn primary_ip(s: &S) -> String {
    s.engine.cfg().primary_device().map(|d| d.ip.clone()).unwrap_or_default()
}

pub async fn wled_update(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let ip = data.get("ip").map(py_str).unwrap_or_default().trim().to_string();
    if ip.is_empty() {
        return Err(AppError::validation("No IP specified").field("ip"));
    }
    let name = non_empty(data.get("name")).map(py_str);
    let udp_port = non_empty(data.get("udp_port")).cloned();
    let mut hw_ins: Option<Vec<Value>> = data.get("hw_ins").and_then(Value::as_array).cloned();
    let mut state = data.get("state").cloned().unwrap_or(json!({}));
    let seg_data: Vec<Value> = state.get("seg").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(t) = duplicate_name(unique_ranges(&seg_data).iter().map(|s| s.get("n").map(py_str).unwrap_or_default())) {
        return Err(AppError::validation(format!("Two segments are called '{}'. Give each segment its own name.", t)).field("name"));
    }
    let mut snap = {
        let mut cfg = s.engine.cfg();
        let mut found = false;
        for dev in cfg.devices.iter_mut().filter(|d| d.ip == ip) {
            found = true;
            if let Some(n) = &name {
                dev.name = n.clone();
            }
            if let Some(p) = &udp_port {
                dev.udp_port = safe_int(Some(p), 21324);
            }
            if let Some(hw) = hw_ins.as_mut().filter(|h| !h.is_empty()) {
                let mut cum = 0;
                for h in hw.iter_mut() {
                    let pwm = is_pwm_output(h);
                    let len = 1.max(safe_int(h.get("len"), if pwm { 1 } else { 45 }));
                    if let Some(o) = h.as_object_mut() {
                        o.insert("len".into(), json!(len));
                        o.insert("start".into(), json!(cum));
                    }
                    cum += len;
                }
                if state.is_object() {
                    state["seg"] = json!(seg_data);
                }
                dev.hw_ins = hw.clone();
                dev.rgb_count = rgb_count(hw);
                dev.pwm_index = hw.iter().find(|h| is_pwm_output(h)).map(|p| safe_int(p.get("start"), dev.rgb_count));
            }
            if !seg_data.is_empty() {
                let hw_ref = hw_ins.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| dev.hw_ins.clone());
                dev.segments = segments_from_wled(&seg_data, &hw_ref, &dev.segments);
            }
        }
        if !found {
            let hw = hw_ins.clone().unwrap_or_default();
            let mut d = DeviceConfig::new(&ip);
            d.name = name.clone().unwrap_or_else(|| "WLED Controller".into());
            d.udp_port = safe_int(udp_port.as_ref(), 21324);
            d.rgb_count = rgb_count(&hw);
            d.pwm_index = hw.iter().find(|h| is_pwm_output(h)).map(|p| safe_int(p.get("start"), 45));
            d.segments = if seg_data.is_empty() { Vec::new() } else { segments_from_wled(&seg_data, &hw, &[]) };
            d.hw_ins = hw;
            cfg.devices.push(d);
        }
        cfg.clone()
    };
    if !save_cfg(&s, &mut snap) {
        return Err(AppError::persistence("Failed to persist configuration to disk"));
    }
    s.engine.sync_drivers(&snap);
    let st = state.as_object().cloned();
    let ip2 = ip.clone();
    let res = tokio::task::spawn_blocking(move || wled::apply_wled_mutations(&ip2, name.as_deref(), hw_ins, st.as_ref(), 3.0)).await;
    let (applied, readback) = match res {
        Ok(Ok(r)) => (true, r),
        Ok(Err(e)) => {
            warn!("Could not reach physical WLED hardware at {} (device offline): {}", ip, e);
            (false, Value::Null)
        }
        Err(_) => (false, Value::Null),
    };
    ok(json!({"status": "ok", "hardware_applied": applied, "readback": readback}))
}

/// Rename one segment on the controller (live and in preset 1) and in AutoGlow's config
pub async fn rename_segment(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let ip = non_empty(data.get("ip")).map(py_str).unwrap_or_default().trim().to_string();
    let seg_id = safe_int(data.get("segment_id"), -1);
    let name = wled::sanitize_wled_name(&non_empty(data.get("name")).map(py_str).unwrap_or_default()).trim().to_string();
    if ip.is_empty() {
        return Err(AppError::validation("No IP specified").field("ip"));
    }
    if seg_id < 0 {
        return Err(AppError::validation("Choose a segment.").field("segment_id"));
    }
    if name.is_empty() {
        return Err(AppError::validation("Give the segment a name (letters, numbers, spaces, - and _).").field("name"));
    }
    let others: Vec<String> = s.engine.cfg().devices.iter().find(|d| d.ip == ip).map(|d| d.segments.iter().filter(|x| x.id != seg_id).map(|x| x.name.clone()).collect()).unwrap_or_default();
    if duplicate_name(others.into_iter().chain(std::iter::once(name.clone()))).is_some() {
        return Err(AppError::validation(format!("Another segment on this controller is already called '{}'.", name)).field("name"));
    }
    let (ip2, n2) = (ip.clone(), name.clone());
    match tokio::task::spawn_blocking(move || wled::rename_wled_segment(&ip2, seg_id, &n2, 2.5)).await {
        Ok(Ok(())) => {}
        other => {
            warn!("Could not rename segment {} on {}: {:?}", seg_id, ip, other.ok().and_then(|r| r.err()));
            return Err(unreachable_err(&ip));
        }
    }
    let mut snap = {
        let mut c = s.engine.cfg();
        for d in c.devices.iter_mut().filter(|d| d.ip == ip) {
            for sg in d.segments.iter_mut().filter(|x| x.id == seg_id) {
                sg.name = name.clone();
            }
        }
        c.clone()
    };
    if !save_cfg(&s, &mut snap) {
        return Err(AppError::persistence("Renamed on the controller, but AutoGlow could not save the name."));
    }
    s.engine.sync_drivers(&snap);
    ok(json!({"status": "ok", "name": name}))
}

/// How bright one controller's light strips are during a game (0..255); shows at once during a game
pub async fn game_brightness(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let ip = non_empty(data.get("ip")).map(py_str).unwrap_or_default().trim().to_string();
    if ip.is_empty() {
        return Err(AppError::validation("No IP specified").field("ip"));
    }
    let bri = data.get("brightness").and_then(int_of).ok_or_else(|| AppError::validation("Brightness must be a number").field("brightness"))?.clamp(0, 255);
    let mut snap = {
        let mut c = s.engine.cfg();
        let mut found = false;
        for d in c.devices.iter_mut().filter(|d| d.ip == ip) {
            d.game_pwm_brightness = Some(bri);
            found = true;
        }
        if !found {
            return Err(AppError::not_found(format!("No controller at {}", ip)).field("ip"));
        }
        c.clone()
    };
    if !save_cfg(&s, &mut snap) {
        return Err(AppError::persistence("Could not save the brightness."));
    }
    s.engine.sync_drivers(&snap);
    if let Some(drv) = s.engine.drivers().into_iter().find(|d| d.ip() == ip) {
        let (off, dim) = {
            let st = s.engine.state();
            (st.is_board_off, st.is_board_dimmed)
        };
        if drv.protocol_mode() == ProtocolMode::ActiveUdp && !(off || dim) {
            drv.set_board_light(bri, None).await;
        }
    }
    ok(json!({"status": "ok", "brightness": bri}))
}

pub async fn get_wled_preset(State(s): State<S>, req: Req) -> ApiResult {
    let mut ip = req.q_or("ip", "").trim().to_string();
    let pid: i64 = req.q_or("id", "1").parse().map_err(|_| AppError::validation("Invalid preset id"))?;
    if ip.is_empty() {
        ip = primary_ip(&s);
    }
    if ip.is_empty() {
        return Err(AppError::validation("No IP specified").field("ip"));
    }
    let ip2 = ip.clone();
    match tokio::task::spawn_blocking(move || wled::get_wled_preset(&ip2, pid, 0.8)).await {
        Ok(Ok(v)) => ok(v),
        _ => Err(unreachable_err(&ip)),
    }
}

pub async fn get_wled_effects(State(s): State<S>, req: Req) -> ApiResult {
    let mut ip = req.q_or("ip", "").trim().to_string();
    if ip.is_empty() {
        ip = primary_ip(&s);
    }
    let ip2 = ip.clone();
    match tokio::task::spawn_blocking(move || wled::get_wled_effects_list(&ip2, 0.8)).await {
        Ok(v) => ok(json!({"effects": v})),
        Err(_) => Err(unreachable_err(&ip)),
    }
}

pub async fn save_wled_preset(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let mut ip = data.get("ip").map(py_str).unwrap_or_default().trim().to_string();
    if ip.is_empty() {
        ip = primary_ip(&s);
    }
    if ip.is_empty() {
        return Err(AppError::validation("No IP specified").field("ip"));
    }
    let pid = data.get("preset_id").map_or(Some(1), int_of).ok_or_else(|| AppError::validation("Invalid preset id"))?;
    let name = get_str(&data, "name", "AutoGlow Default");
    let segments: Vec<Value> = data.get("segments").and_then(Value::as_array).cloned().unwrap_or_default();
    let bri = data.get("bri").map_or(Some(255), int_of).ok_or_else(|| AppError::validation("Invalid brightness"))?;
    let boot = get_bool(&data, "boot_default", true);
    if !segments.is_empty() {
        for sg in segments.iter().filter(|x| x.is_object()) {
            let (st, sp) = (sg.get("start").filter(|v| !v.is_null()), sg.get("stop").filter(|v| !v.is_null()));
            if let (Some(st), Some(sp)) = (st, sp) {
                match (int_of(st), int_of(sp)) {
                    (Some(a), Some(b)) if b <= a => {
                        return Err(AppError::validation(format!("Invalid segment bounds: stop ({}) must be greater than start ({})", py_str(sp), py_str(st))))
                    }
                    (Some(_), Some(_)) => {}
                    _ => return Err(AppError::validation("Segment start and stop must be valid integers")),
                }
            }
        }
        let cfg = s.engine.cfg_clone();
        let dev = cfg.devices.iter().find(|d| d.ip == ip).or(cfg.primary_device());
        if let Some(d) = dev {
            if !d.segments.is_empty() && d.segments.len() > segments.len() {
                return Err(AppError::validation(format!(
                    "Segment count mismatch: device has {} segments configured, but preset only provided {}.",
                    d.segments.len(),
                    segments.len()
                )));
            }
        }
    }
    let ip2 = ip.clone();
    match tokio::task::spawn_blocking(move || wled::save_wled_preset(&ip2, pid, &name, Some(&segments), bri, boot, 2.5)).await {
        Ok(Ok(_)) => ok(json!({"status": "ok", "message": format!("Preset {} saved to WLED device {}.", pid, ip)})),
        _ => Err(AppError::unreachable(format!("Could not save the preset on the WLED controller at {}", ip)).field("ip")),
    }
}

pub async fn preview_wled_state(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let mut ip = data.get("ip").map(py_str).unwrap_or_default().trim().to_string();
    if ip.is_empty() {
        ip = primary_ip(&s);
    }
    if ip.is_empty() {
        return Err(AppError::validation("No IP specified").field("ip"));
    }
    if s.engine.protocol_mode() == ProtocolMode::ActiveUdp {
        info!("Live preview requested while in UDP mode -> Releasing UDP stream to allow HTTP state preview...");
        s.engine.set_protocol_mode(ProtocolMode::IdleHttp).await;
    }
    let ip2 = ip.clone();
    match tokio::task::spawn_blocking(move || wled::preview_wled_state(&ip2, &data, 2.0)).await {
        Ok(Ok(_)) => ok(json!({"status": "ok", "message": "Live preview sent to WLED."})),
        _ => Err(unreachable_err(&ip)),
    }
}

/// Light tests of the setup guide: a temporary LED layout and state, nothing saved
pub async fn setup_preview(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let ip = data.get("ip").map(py_str).unwrap_or_default().trim().to_string();
    if ip.is_empty() {
        return Err(AppError::validation("No IP specified").field("ip"));
    }
    let hw = match data.get("hw_ins") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) if a.iter().all(Value::is_object) => Some(a.clone()),
        _ => return Err(AppError::validation("hw_ins must be a list of LED outputs").field("hw_ins")),
    };
    let state = match data.get("state") {
        None | Some(Value::Null) => None,
        Some(Value::Object(o)) => Some(o.clone()),
        _ => return Err(AppError::validation("state must be an object").field("state")),
    };
    if s.engine.protocol_mode() == ProtocolMode::ActiveUdp {
        s.engine.set_protocol_mode(ProtocolMode::IdleHttp).await;
    }
    let ip2 = ip.clone();
    match tokio::task::spawn_blocking(move || wled::apply_setup_preview(&ip2, hw, state.as_ref(), 3.0)).await {
        Ok(Ok(())) => ok(json!({"status": "ok"})),
        other => {
            warn!("Setup preview failed on WLED {}: {:?}", ip, other.ok().and_then(|r| r.err()));
            Err(unreachable_err(&ip))
        }
    }
}

pub async fn scan_network() -> ApiResult {
    ok(json!({"status": "ok", "devices": crate::discovery::scan_network().await}))
}

pub async fn test_effect(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let evt = obj_or_empty(data.get("effect"));
    let event_key = non_empty(data.get("event")).map(py_str);
    let target_ip = non_empty(data.get("ip")).map(py_str);
    let segment_id = data.get("segment_id").filter(|v| !v.is_null()).map(|v| safe_int(Some(v), 0));
    let cfg = s.engine.cfg_clone();
    let effect = if evt.is_empty() && event_key.is_some() {
        match cfg.profile_for(target_ip.as_deref(), segment_id).get_effect(event_key.as_deref().unwrap()) {
            Some(f) => EffectConfig {
                animation: f.animation.clone(),
                color_primary: f.color_primary,
                color_secondary: f.color_secondary,
                dynamic_secondary: f.dynamic_secondary,
                duration: f.duration,
                speed: f.speed,
                fps: f.fps,
                reverse: f.reverse,
                enabled: true,
                ..Default::default()
            },
            None => EffectConfig { color_primary: RGBColor::new(0, 255, 0), duration: 2.0, ..Default::default() },
        }
    } else {
        let anim = get_str(&evt, "animation", "solid");
        EffectConfig {
            animation: if ANIMATIONS.contains(&anim.as_str()) { anim } else { "solid".into() },
            color_primary: RGBColor::from_value(non_empty(evt.get("color_primary")).or_else(|| evt.get("color")), RGBColor::new(0, 255, 0)),
            color_secondary: RGBColor::from_value(evt.get("color_secondary"), RGBColor::BLACK),
            dynamic_secondary: get_bool(&evt, "dynamic_secondary", false),
            duration: safe_float(evt.get("duration"), 2.0),
            speed: safe_float(evt.get("speed"), 1.0),
            fps: safe_int(evt.get("fps"), 50),
            reverse: get_bool(&evt, "reverse", false),
            enabled: true,
            ..Default::default()
        }
    };
    let drv = match &target_ip {
        Some(ip) => s.engine.get_driver(Some(ip)),
        None => s.engine.driver(),
    }
    .ok_or_else(|| AppError::not_found(format!("No driver configured for controller {}.", target_ip.clone().unwrap_or_else(|| "primary".into()))).field("ip"))?;
    s.engine.state().lighting_test_active = true;
    if drv.protocol_mode() != ProtocolMode::ActiveUdp {
        info!("Effect test requested while in HTTP mode -> Auto-connecting UDP mode...");
        s.engine.set_protocol_mode(ProtocolMode::ActiveUdp).await;
    }
    let prev_raw = non_empty(evt.get("previous_color")).or_else(|| non_empty(data.get("previous_color")));
    let mut prev = prev_raw.map(|p| RGBColor::from_value(Some(p), RGBColor::WHITE));
    if effect.dynamic_secondary && prev.is_none() {
        prev = drv.last_active_color(segment_id.unwrap_or(0)).or_else(|| {
            let p = cfg.profile_for(target_ip.as_deref(), segment_id);
            let p1 = p.player_slots.iter().find(|x| x.id == 1).map(|x| x.effect.color_primary).filter(|c| !c.is_black());
            p1.or_else(|| p.get_effect("throw").map(|e| e.color_primary).filter(|c| !c.is_black()))
                .or_else(|| p.get_effect("game_start").map(|e| e.color_primary).filter(|c| !c.is_black()))
        });
    }
    let segs = drv.config().segments;
    let targets: Vec<Option<i64>> = if segment_id.is_none() && !segs.is_empty() {
        segs.iter().filter(|x| !is_pwm_segment(x)).map(|x| Some(x.id)).collect()
    } else {
        vec![segment_id]
    };
    for t in targets {
        drv.play_effect(&effect, t, true, prev);
    }
    ok(json!({"status": "ok"}))
}

pub async fn test_end(State(s): State<S>) -> ApiResult {
    let restored = s.engine.end_lighting_test().await;
    ok(json!({"status": "ok", "restored": restored}))
}

pub async fn test_light(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let bri = data.get("brightness").map_or(Some(200), int_of).ok_or_else(|| AppError::validation("Brightness must be a number").field("brightness"))?;
    let ip = non_empty(data.get("ip")).map(py_str);
    s.engine.state().lighting_test_active = true;
    let okk = s.engine.set_board_light(bri, ip.as_deref()).await;
    if !okk {
        warn!("set_board_light returned False for brightness {} on {}", bri, ip.clone().unwrap_or_else(|| "all".into()));
    }
    ok(json!({"status": "ok", "brightness": bri, "success": okk}))
}

pub async fn get_protocol_mode(State(s): State<S>) -> ApiResult {
    ok(json!({"status": "ok", "mode": s.engine.protocol_mode().as_str()}))
}

pub async fn post_protocol_mode(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let m = if get_str(&data, "mode", "http").to_lowercase() == "udp" { ProtocolMode::ActiveUdp } else { ProtocolMode::IdleHttp };
    let v = s.engine.set_protocol_mode(m).await;
    ok(json!({"status": "ok", "mode": m.as_str(), "verified": v}))
}
