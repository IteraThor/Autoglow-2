//! WLED hardware driver: DRGB/DNRGB UDP real-time streaming (port 21324) through the LED thread and
//! HTTP JSON control for WS281x (RGB) + PWM white setups.
//!
//! The blocking HTTP functions run on a worker thread (spawn_blocking). The driver itself keeps every
//! segment's channel (legacy effects, Flow looks with fades, hits and the hit locator) and hands a scene
//! snapshot to the LED thread whenever it changes.

use crate::flow_catalog::{normalize_style_str, render_effect};
use crate::http::{get_json, is_host_online, post_json, post_json_value};
use crate::led_thread::{self, wall, Scene, Shared};
use crate::models::{is_pwm_output, DeviceConfig, EffectConfig, ProtocolMode, RGBColor};
use crate::py::*;
use log::{debug, info, warn};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

static FLOW_SESSIONS: AtomicI64 = AtomicI64::new(1);

fn next_session() -> i64 {
    FLOW_SESSIONS.fetch_add(1, Ordering::SeqCst)
}

pub fn led_type_name(code: i64) -> String {
    match code {
        20 => "WS2811 (400kHz)",
        21 => "TM1829",
        22 => "WS281x",
        24 => "SK6812 RGBW",
        25 => "TM1814",
        26 => "400kHz",
        29 => "WS2801",
        30 => "APA102",
        31 => "LPD8806",
        40 => "On/Off",
        41 => "PWM White",
        42 => "PWM CCT",
        43 => "PWM RGB",
        44 => "PWM RGBW",
        45 => "PWM RGB+CCT",
        _ => return format!("Type {}", code),
    }
    .to_string()
}

fn seg_id_of(seg: &Value) -> i64 {
    safe_int(seg.get("id"), -1)
}

/// What a controller's LED outputs are wired as: start, length, data pin and type of each output
pub fn wiring_key(hw_ins: &[Value]) -> Vec<(i64, i64, i64, i64)> {
    hw_ins
        .iter()
        .filter(|h| h.is_object())
        .map(|h| {
            let pin = match h.get("pin") {
                Some(Value::Array(a)) if !a.is_empty() => a.first(),
                other => other,
            };
            (safe_int(h.get("start"), 0), safe_int(h.get("len"), 0), safe_int(pin, -1), safe_int(h.get("type"), 22))
        })
        .collect()
}

/// Strip characters WLED firmware does not take (quotes, apostrophes, ...) and limit to 32 chars
pub fn sanitize_wled_name(name: &str) -> String {
    if name.is_empty() {
        return String::new();
    }
    let replaced = name.replace('\u{b7}', "-");
    let kept: String = replaced.chars().filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '_' || *c == '-').collect();
    let collapsed = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    collapsed.chars().take(32).collect()
}

fn offline(ip: &str, name: &str, msg: &str) -> Value {
    json!({"status": "ok", "online": false, "ip": ip, "name": name, "segments": [], "hw_ins": [], "message": msg})
}

fn hw_ins_of(cfg: &Value) -> Vec<Value> {
    cfg.get("hw").and_then(|h| h.get("led")).and_then(|l| l.get("ins")).and_then(Value::as_array).cloned().unwrap_or_default()
}

/// /json and /cfg.json of a controller: live segments, hardware outputs and online status
pub fn fetch_live_device_info(ip: &str, timeout: f64) -> Value {
    let ip_c = ip.trim();
    if ip_c.is_empty() {
        return offline("", "WLED Controller", "No IP specified");
    }
    if !is_host_online(ip_c, 80, 0.3) {
        debug!("WLED controller at {} is offline (TCP check failed)", ip_c);
        return offline(ip_c, ip_c, "Offline (Host unreachable)");
    }
    let data = match get_json(&format!("http://{}/json", ip_c), 1.0) {
        Ok(d) => d,
        Err(e) => {
            warn!("WLED controller at {} failed HTTP /json query: {}", ip_c, e);
            return offline(ip_c, ip_c, &format!("Offline ({})", e.split(':').next().unwrap_or("Error")));
        }
    };
    let mut hw_ins = get_json(&format!("http://{}/cfg.json", ip_c), timeout).map(|c| hw_ins_of(&c)).unwrap_or_default();
    if hw_ins.is_empty() {
        hw_ins = get_json(&format!("http://{}/json/cfg", ip), timeout).map(|c| hw_ins_of(&c)).unwrap_or_default();
    }
    if hw_ins.is_empty() {
        hw_ins = data.get("info").and_then(|i| i.get("leds")).and_then(|l| l.get("ins")).and_then(Value::as_array).cloned().unwrap_or_default();
    }
    let empty = json!({});
    let state = data.get("state").unwrap_or(&empty);
    let info = data.get("info").unwrap_or(&empty);
    let mut live = Vec::new();
    for (idx, s) in arr(state.get("seg")).iter().enumerate() {
        let seg_id = s.get("id").cloned().unwrap_or(json!(idx));
        let start = s.get("start").cloned().unwrap_or(json!(0));
        let stop = s.get("stop").cloned().unwrap_or(json!(0));
        let st_i = safe_int(Some(&start), 0);
        let len = s.get("len").cloned().unwrap_or(json!(0.max(safe_int(Some(&stop), 0) - st_i)));
        let name = non_empty(s.get("n")).cloned().unwrap_or_else(|| json!(format!("Segment {}", py_str(&seg_id))));
        let mut hw_type = "WS281x".to_string();
        let mut gpio = String::new();
        for h in &hw_ins {
            let hs = safe_int(h.get("start"), 0);
            let hl = safe_int(h.get("len"), 0);
            if st_i >= hs && st_i < hs + hl {
                hw_type = led_type_name(safe_int(h.get("type"), 22));
                if let Some(p) = h.get("pin").and_then(Value::as_array).and_then(|a| a.first()) {
                    gpio = format!("GPIO {}", py_str(p));
                }
                break;
            }
        }
        live.push(json!({
            "id": seg_id, "name": name, "start": start, "stop": stop, "len": len,
            "of": s.get("of").cloned().unwrap_or(json!(0)), "on": s.get("on").cloned().unwrap_or(json!(true)),
            "bri": s.get("bri").cloned().unwrap_or(json!(255)), "type": hw_type, "gpio": gpio,
        }));
    }
    json!({
        "status": "ok", "online": true,
        "name": info.get("name").cloned().unwrap_or(json!("WLED Controller")),
        "version": info.get("ver").cloned().unwrap_or(json!("")),
        "info": info, "state": state, "segments": live, "hw_ins": hw_ins,
    })
}

/// Reasons a /json/state readback says the LEDs may stay dark (empty when none)
pub fn evaluate_state_blockers(state: &Value, expect_live: bool) -> Vec<String> {
    let mut w = Vec::new();
    if state.get("on") == Some(&Value::Bool(false)) {
        w.push("Controller power is off (on: false)".to_string());
    }
    if safe_int(state.get("bri"), 255) == 0 && state.get("bri").map_or(false, |v| v.is_number()) {
        w.push("Master brightness is 0 (bri: 0)".to_string());
    }
    let lor = safe_int(state.get("lor"), 0);
    if lor > 0 && !expect_live {
        w.push(format!("Live override lock active (lor: {}); JSON API changes are blocked", lor));
    }
    for seg in arr(state.get("seg")) {
        if !seg.is_object() {
            continue;
        }
        let sid = seg.get("id").map(py_str).unwrap_or_else(|| "?".into());
        let start = safe_int(seg.get("start"), 0);
        let stop = safe_int(seg.get("stop"), 0);
        if stop <= start {
            w.push(format!("Segment {} has invalid bounds (start {}, stop {})", sid, start, stop));
            continue;
        }
        if seg.get("on") == Some(&Value::Bool(false)) {
            w.push(format!("Segment {} is switched off", sid));
        }
        if seg.get("bri").map_or(false, |v| v.is_number()) && safe_int(seg.get("bri"), 255) == 0 {
            w.push(format!("Segment {} brightness is 0", sid));
        }
    }
    w
}

/// One GET /json summarizing controller state and hardware blockers
pub fn fetch_device_health(ip: &str, expect_live: bool, timeout: f64) -> Value {
    let ip_c = ip.trim();
    if ip_c.is_empty() || !is_host_online(ip_c, 80, 0.3) {
        return json!({"online": false, "warnings": []});
    }
    let data = match get_json(&format!("http://{}/json", ip_c), timeout) {
        Ok(d) => d,
        Err(e) => return json!({"online": false, "warnings": [], "error": e}),
    };
    let empty = json!({});
    let state = data.get("state").filter(|s| s.is_object()).unwrap_or(&empty);
    let info = data.get("info").filter(|s| s.is_object()).unwrap_or(&empty);
    let segs: Vec<Value> = arr(state.get("seg"))
        .iter()
        .filter(|s| s.is_object())
        .map(|s| {
            json!({
                "id": s.get("id"),
                "name": non_empty(s.get("n")).cloned().unwrap_or_else(|| json!(format!("Segment {}", s.get("id").map(py_str).unwrap_or_else(|| "None".into())))),
                "start": s.get("start").cloned().unwrap_or(json!(0)),
                "stop": s.get("stop").cloned().unwrap_or(json!(0)),
                "on": s.get("on").cloned().unwrap_or(json!(true)),
                "bri": s.get("bri").cloned().unwrap_or(json!(255)),
            })
        })
        .collect();
    json!({
        "online": true, "name": info.get("name").cloned().unwrap_or(json!("")), "version": info.get("ver").cloned().unwrap_or(json!("")),
        "on": state.get("on"), "bri": state.get("bri"), "lor": state.get("lor").cloned().unwrap_or(json!(0)),
        "preset": state.get("ps").cloned().unwrap_or(json!(-1)), "segments": segs,
        "warnings": evaluate_state_blockers(state, expect_live),
    })
}

/// PWM outputs need a white-balance mode, or WLED leaves the channel dark
pub fn normalize_pwm_outputs(hw_ins: &mut [Value]) {
    for ins in hw_ins.iter_mut() {
        if is_pwm_output(ins) {
            let ok = matches!(ins.get("rgbwm").and_then(Value::as_i64), Some(1..=4));
            if !ok {
                if let Some(o) = ins.as_object_mut() {
                    o.insert("rgbwm".into(), json!(4));
                }
            }
        }
    }
}

fn existing_seg_count(ip: &str) -> usize {
    get_json(&format!("http://{}/json/state", ip), 1.5).map(|s| arr(s.get("seg")).len()).unwrap_or(8)
}

/// Apply name, outputs and state to a controller (state saved as preset 1), then read /json back
pub fn apply_wled_mutations(ip: &str, name: Option<&str>, hw_ins: Option<Vec<Value>>, state_payload: Option<&Obj>, timeout: f64) -> Result<Value, String> {
    if ip.trim().is_empty() {
        return Err("No IP address specified".into());
    }
    let mut cfg = Obj::new();
    if let Some(n) = name.map(sanitize_wled_name).filter(|n| !n.is_empty()) {
        cfg.insert("id".into(), json!({"name": n}));
    }
    let had_hw = hw_ins.as_ref().map_or(false, |h| !h.is_empty());
    if let Some(mut h) = hw_ins {
        normalize_pwm_outputs(&mut h);
        cfg.insert("hw".into(), json!({"led": {"ins": h}}));
    }
    cfg.insert("def".into(), json!({"ps": 1}));
    cfg.insert("if".into(), json!({"live": {"mso": false}}));
    match post_json(&format!("http://{}/json/cfg", ip), &Value::Object(cfg), timeout) {
        Ok(_) => std::thread::sleep(Duration::from_millis(80)),
        Err(e) => warn!("Failed to update /json/cfg on {}: {}", ip, e),
    }
    if let Some(sp) = state_payload.filter(|s| !s.is_empty()) {
        let mut st = sp.clone();
        st.insert("v".into(), json!(true));
        st.insert("lor".into(), json!(0));
        st.insert("psave".into(), json!(1));
        st.insert("n".into(), json!("AutoGlow Default"));
        st.insert("ib".into(), json!(true));
        st.insert("sb".into(), json!(true));
        let existing = existing_seg_count(ip);
        let mut segs: Vec<Value> = arr(st.get("seg")).to_vec();
        for s in segs.iter_mut() {
            if let Some(o) = s.as_object_mut() {
                if let Some(n) = o.get("n").map(py_str) {
                    o.insert("n".into(), json!(sanitize_wled_name(&n)));
                }
            }
        }
        let active: HashSet<i64> = segs.iter().filter_map(|s| s.get("id")).map(|v| safe_int(Some(v), -1)).collect();
        let n_segs = segs.len();
        for sid in 0..existing.max(8) {
            if !active.contains(&(sid as i64)) && (n_segs == 0 || sid >= n_segs) {
                segs.push(json!({"id": sid, "stop": 0}));
            }
        }
        st.insert("seg".into(), Value::Array(segs));
        let url = format!("http://{}/json/state", ip);
        let res = post_json(&url, &Value::Object(st.clone()), timeout).and_then(|_| {
            if had_hw {
                // WLED's bus rebuild after new outputs can land after this state and reset the segments
                std::thread::sleep(Duration::from_millis(800));
                let resend: Obj = st.iter().filter(|(k, _)| !["psave", "n", "ib", "sb"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
                post_json(&url, &Value::Object(resend), timeout)?;
            }
            Ok(())
        });
        if let Err(e) = res {
            warn!("Failed to update /json/state on {}: {}", ip, e);
        }
    }
    get_json(&format!("http://{}/json", ip), timeout)
}

/// A temporary LED layout for the setup guide's light tests (nothing saved, boot settings untouched)
pub fn apply_setup_preview(ip: &str, hw_ins: Option<Vec<Value>>, state_payload: Option<&Obj>, timeout: f64) -> Result<(), String> {
    let ip_c = ip.trim();
    if ip_c.is_empty() {
        return Err("No IP address specified".into());
    }
    let had_hw = hw_ins.as_ref().map_or(false, |h| !h.is_empty());
    if let Some(mut h) = hw_ins.filter(|h| !h.is_empty()) {
        normalize_pwm_outputs(&mut h);
        post_json(&format!("http://{}/json/cfg", ip_c), &json!({"hw": {"led": {"ins": h}}}), timeout)?;
        std::thread::sleep(Duration::from_millis(400));
    }
    if let Some(sp) = state_payload.filter(|s| !s.is_empty()) {
        let mut st = sp.clone();
        st.insert("v".into(), json!(false));
        st.insert("lor".into(), json!(0));
        let mut segs: Vec<Value> = arr(st.get("seg")).iter().filter(|s| s.is_object()).cloned().collect();
        if !segs.is_empty() {
            let existing = existing_seg_count(ip_c);
            let used: HashSet<i64> = segs.iter().map(|s| safe_int(s.get("id"), -1)).collect();
            let n = segs.len();
            for sid in 0..existing.max(8) {
                if !used.contains(&(sid as i64)) && sid >= n {
                    segs.push(json!({"id": sid, "stop": 0}));
                }
            }
            for s in segs.iter_mut() {
                if let Some(o) = s.as_object_mut() {
                    if let Some(nm) = o.get("n").map(py_str) {
                        o.insert("n".into(), json!(sanitize_wled_name(&nm)));
                    }
                }
            }
            st.insert("seg".into(), Value::Array(segs));
        }
        let body = Value::Object(st);
        for attempt in 0..(if had_hw { 2 } else { 1 }) {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(800));
            }
            post_json(&format!("http://{}/json/state", ip_c), &body, timeout)?;
        }
    }
    Ok(())
}

/// Release the live override lock and restore a preset; true when every controller reads back lor == 0
pub fn release_live_and_restore_preset(ips: &[String], preset_id: i64) -> bool {
    let mut all = true;
    for ip in ips.iter().filter(|i| !i.is_empty()) {
        if !is_host_online(ip, 80, 0.3) {
            warn!("Cannot release live mode on {}: controller unreachable", ip);
            all = false;
            continue;
        }
        let url = format!("http://{}/json/state", ip);
        if let Err(e) = post_json(&url, &json!({"lor": 0, "ps": preset_id, "tt": 0, "v": true}), 1.0) {
            warn!("Error releasing live mode via HTTP on {}: {}", ip, e);
        }
        let mut verified = false;
        for _ in 0..10 {
            match get_json(&url, 0.5) {
                Ok(d) => {
                    if safe_int(d.get("lor"), 0) == 0 {
                        verified = true;
                        break;
                    }
                }
                Err(e) => {
                    warn!("Live mode readback failed on {}: {}", ip, e);
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !verified {
            warn!("Live override lock on {} not confirmed released (lor != 0)", ip);
            all = false;
        }
    }
    all
}

/// fxdata "<sliders>;<colors>;<palettes>;<flags>;<defaults>" into effect parameters and colour slots
pub fn parse_wled_effect_metadata(fx_id: i64, name: &str, fxdata: &str) -> Value {
    let mut raw = fxdata.trim().to_string();
    if fx_id == 0 && raw.is_empty() {
        raw = ";!;".into();
    }
    let parts: Vec<&str> = if raw.is_empty() { Vec::new() } else { raw.split(';').collect() };
    let names = ["Primary", "Secondary", "Tertiary"];
    let mut slots = Vec::new();
    if parts.len() > 1 && !parts[1].is_empty() {
        let toks: Vec<&str> = parts[1].split(',').collect();
        for (i, tok) in toks.iter().take(3).enumerate() {
            let t = tok.trim();
            if !t.is_empty() {
                slots.push(json!({"slot": i, "label": if t == "!" { names[i] } else { t }}));
            }
        }
    } else if raw.is_empty() {
        slots.push(json!({"slot": 0, "label": "Primary"}));
        if fx_id != 0 {
            slots.push(json!({"slot": 1, "label": "Secondary"}));
        }
    }
    let sliders: Vec<String> = parts.first().filter(|s| !s.is_empty()).map(|s| s.split(',').map(|t| t.trim().to_string()).collect()).unwrap_or_default();
    let mut speed = !sliders.is_empty() && !sliders[0].is_empty();
    let speed_label = if speed && sliders[0] != "!" { sliders[0].clone() } else { "Speed".into() };
    let mut intensity = sliders.len() > 1 && !sliders[1].is_empty();
    let intensity_label = if intensity && sliders[1] != "!" { sliders[1].clone() } else { "Intensity".into() };
    if raw.is_empty() {
        speed = fx_id != 0;
        intensity = fx_id != 0;
    }
    let palette_part = parts.get(2).copied().unwrap_or("");
    let palette = fx_id != 0 && (!palette_part.is_empty() || slots.is_empty());
    json!({
        "id": fx_id, "name": name, "fxdata": raw, "colors": slots.len(), "colorSlots": slots, "speed": speed,
        "speedLabel": speed_label, "intensity": intensity, "intensityLabel": intensity_label, "palette": palette,
    })
}

/// Every native WLED effect with its metadata; the bundled catalog when the controller is offline
pub fn get_wled_effects_list(ip: &str, timeout: f64) -> Vec<Value> {
    let mut eff: Vec<Value> = Vec::new();
    let mut fxd: Vec<Value> = Vec::new();
    if !ip.is_empty() && is_host_online(ip, 80, 0.3) {
        let res = (|| -> Result<(), String> {
            if let Value::Array(a) = get_json(&format!("http://{}/json/eff", ip), timeout)? {
                eff = a;
            }
            if let Value::Array(a) = get_json(&format!("http://{}/json/fxdata", ip), timeout)? {
                fxd = a;
            }
            Ok(())
        })();
        if let Err(e) = res {
            warn!("Error fetching live WLED effects/fxdata from {}: {}", ip, e);
        }
    }
    if !eff.is_empty() {
        return eff
            .iter()
            .enumerate()
            .map(|(i, n)| parse_wled_effect_metadata(i as i64, &py_str(n), &fxd.get(i).map(py_str).unwrap_or_default()))
            .collect();
    }
    let bundled = crate::storage::project_root().join("defaults").join("wled_effects_data.json");
    if let Ok(t) = std::fs::read_to_string(&bundled) {
        if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&t) {
            if !items.is_empty() {
                return items
                    .iter()
                    .enumerate()
                    .map(|(i, it)| {
                        parse_wled_effect_metadata(
                            safe_int(it.get("id"), i as i64),
                            &it.get("name").map(py_str).unwrap_or_else(|| format!("Effect {}", i)),
                            &it.get("fxdata").map(py_str).unwrap_or_default(),
                        )
                    })
                    .collect();
            }
        }
    }
    let fallback = [
        "Solid", "Blink", "Breathe", "Wipe", "Wipe Random", "Random Colors", "Sweep", "Dynamic", "Colorloop", "Rainbow", "Scan", "Dual Scan",
        "Fade", "Chase", "Running", "Fire Flicker", "Aurora", "Sinelon", "Palette", "Popcorn",
    ];
    fallback.iter().enumerate().map(|(i, n)| parse_wled_effect_metadata(i as i64, n, "")).collect()
}

/// A preset from /presets.json, else the live /json/state
pub fn get_wled_preset(ip: &str, preset_id: i64, timeout: f64) -> Result<Value, String> {
    if ip.is_empty() {
        return Err("No IP address specified".into());
    }
    let segs = |v: &Value| -> Vec<Value> { arr(v.get("seg")).iter().filter(|s| s.is_object()).cloned().collect() };
    let mut conn_err = false;
    match get_json(&format!("http://{}/presets.json", ip), timeout) {
        Ok(p) => {
            if let Some(pd) = p.get(preset_id.to_string()) {
                return Ok(json!({
                    "id": preset_id, "name": pd.get("n").cloned().unwrap_or(json!(format!("Preset {}", preset_id))),
                    "on": pd.get("on").cloned().unwrap_or(json!(true)), "bri": pd.get("bri").cloned().unwrap_or(json!(255)), "seg": segs(pd),
                }));
            }
        }
        Err(e) => {
            warn!("Could not load presets.json from {}: {}", ip, e);
            let l = e.to_lowercase();
            conn_err = ["timeout", "timed out", "refused", "unreachable"].iter().any(|k| l.contains(k));
        }
    }
    if !conn_err {
        match get_json(&format!("http://{}/json/state", ip), timeout) {
            Ok(st) => {
                return Ok(json!({"id": preset_id, "name": format!("Preset {}", preset_id), "on": st.get("on").cloned().unwrap_or(json!(true)),
                                 "bri": st.get("bri").cloned().unwrap_or(json!(255)), "seg": segs(&st)}))
            }
            Err(e) => warn!("Failed to fetch WLED state for preset from {}: {}", ip, e),
        }
    }
    Ok(json!({"id": preset_id, "name": format!("Preset {}", preset_id), "on": true, "bri": 255, "seg": []}))
}

/// Push a preview state to WLED without saving it; false when the controller is offline
pub fn preview_wled_state(ip: &str, payload: &Obj, timeout: f64) -> Result<bool, String> {
    let ip_c = ip.trim();
    if ip_c.is_empty() {
        return Err("No IP address specified".into());
    }
    if !is_host_online(ip_c, 80, 0.3) {
        return Ok(false);
    }
    let mut body = crate::obj! {
        "on" => payload.get("on").cloned().unwrap_or(json!(true)),
        "bri" => payload.get("bri").cloned().unwrap_or(json!(255)),
        "transition" => payload.get("transition").cloned().unwrap_or(json!(0)),
        "lor" => 0, "v" => true,
    };
    for k in ["ps", "seg"] {
        if let Some(v) = payload.get(k) {
            body.insert(k.into(), v.clone());
        }
    }
    post_json(&format!("http://{}/json/state", ip_c), &Value::Object(body), timeout)?;
    Ok(true)
}

/// Save a multi-segment preset (psave) and optionally make it the boot preset
pub fn save_wled_preset(ip: &str, preset_id: i64, name: &str, segments: Option<&[Value]>, bri: i64, boot_default: bool, timeout: f64) -> Result<bool, String> {
    if ip.is_empty() {
        return Err("No IP address specified".into());
    }
    let url = format!("http://{}/json/state", ip);
    let mut payload = crate::obj! {
        "on" => true, "bri" => clamp(bri, 0, 255), "transition" => 0, "psave" => preset_id, "n" => name,
        "ib" => true, "sb" => true, "lor" => 0, "v" => true,
    };
    if let Some(s) = segments.filter(|s| !s.is_empty()) {
        payload.insert("seg".into(), json!(s));
    }
    let payload = Value::Object(payload);
    post_json(&url, &payload, timeout)?;
    if boot_default {
        if let Err(e) = post_json(&format!("http://{}/json/cfg", ip), &json!({"def": {"ps": preset_id, "on": true, "bri": clamp(bri, 0, 255)}}), timeout) {
            warn!("Could not set boot preset in cfg on {}: {}", ip, e);
        }
    }
    if segments.map_or(false, |s| s.len() > 1) {
        std::thread::sleep(Duration::from_millis(80));
        match get_json(&format!("http://{}/presets.json", ip), timeout) {
            Ok(p) => {
                let empty = json!({});
                let saved = p.get(preset_id.to_string()).unwrap_or(&empty);
                let missing: Vec<Value> = arr(saved.get("seg"))
                    .iter()
                    .filter(|s| s.is_object() && s.get("id").map_or(false, |v| !v.is_null()))
                    .filter(|s| s.get("start").map_or(true, Value::is_null) || s.get("stop").map_or(true, Value::is_null))
                    .map(|s| s.get("id").cloned().unwrap_or_default())
                    .collect();
                if !missing.is_empty() {
                    warn!("Preset {} on {} saved without bounds on segments {:?}! Re-saving with explicit sb: True...", preset_id, ip, missing);
                    let _ = post_json(&url, &payload, timeout);
                } else {
                    info!("Verified Preset {} on {} has valid multi-segment bounds in presets.json.", preset_id, ip);
                }
            }
            Err(e) => debug!("Could not verify presets.json on {}: {}", ip, e),
        }
    }
    Ok(true)
}

/// Rename one segment live, and in preset 1 (the idle and boot look) when it holds that segment
pub fn rename_wled_segment(ip: &str, seg_id: i64, name: &str, timeout: f64) -> Result<(), String> {
    post_json(&format!("http://{}/json/state", ip), &json!({"seg": [{"id": seg_id, "n": name}]}), timeout)?;
    let presets = match get_json(&format!("http://{}/presets.json", ip), timeout) {
        Ok(p) => p,
        Err(e) => {
            warn!("Renamed segment {} on {} live, but could not read its presets: {}", seg_id, ip, e);
            return Ok(());
        }
    };
    let Some(preset) = presets.get("1").filter(|p| p.is_object()) else { return Ok(()) };
    let mut segs: Vec<Value> = arr(preset.get("seg")).iter().filter(|s| s.is_object()).cloned().collect();
    if !segs.iter().any(|s| seg_id_of(s) == seg_id) {
        return Ok(());
    }
    for s in segs.iter_mut() {
        if seg_id_of(s) == seg_id {
            s["n"] = json!(name);
        }
    }
    let pname = non_empty(preset.get("n")).map(py_str).unwrap_or_else(|| "AutoGlow Default".into());
    save_wled_preset(ip, 1, &pname, Some(&segs), safe_int(preset.get("bri"), 255), true, timeout)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Device layout helpers (from the saved DeviceConfig)
// ---------------------------------------------------------------------------------------------

pub fn total_led_count(c: &DeviceConfig) -> i64 {
    if !c.hw_ins.is_empty() {
        return c.hw_ins.iter().map(|h| 1.max(safe_int(h.get("len"), 1))).sum();
    }
    if !c.segments.is_empty() {
        return c.segments.iter().map(|s| s.start + s.length).chain(std::iter::once(c.rgb_count)).max().unwrap_or(c.rgb_count);
    }
    let pwm = c.pwm_index.unwrap_or(c.rgb_count);
    c.rgb_count.max(pwm + 1)
}

pub fn pwm_seg_id(c: &DeviceConfig) -> Option<i64> {
    if !c.hw_ins.is_empty() && !c.hw_ins.iter().any(is_pwm_output) {
        return None;
    }
    if let Some(s) = c.segments.iter().find(|s| s.is_pwm()) {
        return Some(s.id);
    }
    if c.pwm_seg_id.is_some() && c.pwm_index.is_some() {
        c.pwm_seg_id
    } else {
        None
    }
}

/// Segment IDs of every PWM white output (a controller can have several light strips)
pub fn pwm_seg_ids(c: &DeviceConfig) -> Vec<i64> {
    if !c.hw_ins.is_empty() && !c.hw_ins.iter().any(is_pwm_output) {
        return Vec::new();
    }
    let ids: Vec<i64> = c.segments.iter().filter(|s| s.is_pwm()).map(|s| s.id).collect();
    if !ids.is_empty() {
        return ids;
    }
    pwm_seg_id(c).into_iter().collect()
}

/// LED index of every PWM white output in the UDP frame
pub fn pwm_led_indices(c: &DeviceConfig) -> Vec<i64> {
    if !c.hw_ins.is_empty() {
        let mut out = Vec::new();
        let mut cursor = 0;
        for h in &c.hw_ins {
            if is_pwm_output(h) {
                out.push(cursor);
            }
            cursor += 1.max(safe_int(h.get("len"), 1));
        }
        return out;
    }
    match (pwm_seg_id(c), c.pwm_index) {
        (Some(_), Some(i)) => vec![i],
        _ => Vec::new(),
    }
}

pub fn segment_bounds(c: &DeviceConfig, seg_id: i64) -> (i64, i64) {
    let total = total_led_count(c);
    if let Some(s) = c.segments.iter().find(|s| s.id == seg_id) {
        return (0.max(s.start), total.min(s.start + 1.max(s.length)));
    }
    if seg_id == 0 {
        return (0, c.rgb_count);
    }
    if Some(seg_id) == pwm_seg_id(c) {
        let p = c.pwm_index.unwrap_or(c.rgb_count);
        return (p, p + 1);
    }
    (0, c.rgb_count)
}

fn segment_offset(c: &DeviceConfig, seg_id: i64) -> i64 {
    c.segments.iter().find(|s| s.id == seg_id).map_or(0, |s| s.offset)
}

/// Check mso/rgbwm and restore saved multi-segment layouts after a WLED power cycle
pub fn sync_ensure_mso(c: &DeviceConfig) -> bool {
    let ip = c.ip.trim();
    if ip.is_empty() {
        return true;
    }
    if !is_host_online(ip, 80, 0.3) {
        warn!("Device at {} is offline during startup config check.", ip);
        return false;
    }
    let url = format!("http://{}/json/cfg", ip);
    let res = (|| -> Result<bool, String> {
        let cfg = get_json(&url, 1.0)?;
        let mut payload = Obj::new();
        if cfg.get("if").and_then(|i| i.get("live")).and_then(|l| l.get("mso")) != Some(&Value::Bool(false)) {
            payload.insert("if".into(), json!({"live": {"mso": false}}));
        }
        let mut hw_ins = hw_ins_of(&cfg);
        let mut hw_changed = false;
        for ins in hw_ins.iter_mut() {
            if is_pwm_output(ins) && !matches!(ins.get("rgbwm").and_then(Value::as_i64), Some(1..=4)) {
                ins["rgbwm"] = json!(4);
                hw_changed = true;
            }
        }
        if hw_changed {
            payload.insert("hw".into(), json!({"led": {"ins": hw_ins}}));
        }
        if !payload.is_empty() {
            post_json(&url, &Value::Object(payload), 1.0)?;
        }
        if c.segments.len() > 1 && wiring_key(&hw_ins) == wiring_key(&c.hw_ins) {
            let seg_res = (|| -> Result<(), String> {
                let live = get_json(&format!("http://{}/json/state", ip), 1.0)?;
                let live_segs = arr(live.get("seg"));
                let mut recover = live_segs.len() < c.segments.len() || live_segs.first().and_then(|s| s.get("stop")) != Some(&json!(c.segments[0].length));
                if !recover {
                    if let Ok(p) = get_json(&format!("http://{}/presets.json", ip), 1.0) {
                        let empty = json!({});
                        let p1 = p.get("1").unwrap_or(&empty);
                        let active: Vec<&Value> = arr(p1.get("seg")).iter().filter(|s| s.is_object() && s.get("id").map_or(false, |v| !v.is_null())).collect();
                        if active.len() < c.segments.len() || active.iter().any(|s| s.get("start").map_or(true, Value::is_null) || s.get("stop").map_or(true, Value::is_null)) {
                            info!("Preset 1 on {} lacks segment bounds in presets.json -> triggering auto-repair", ip);
                            recover = true;
                        }
                    }
                }
                if recover {
                    let seg_payload: Vec<Value> = c
                        .segments
                        .iter()
                        .map(|s| {
                            json!({"id": s.id, "start": s.start, "stop": s.start + s.length, "of": s.offset, "n": sanitize_wled_name(&s.name),
                                   "on": true, "bri": if s.id == 0 { 255 } else { c.default_pwm_brightness }})
                        })
                        .collect();
                    post_json(&format!("http://{}/json/state", ip), &json!({"seg": seg_payload, "psave": 1, "ib": true, "sb": true, "v": true}), 1.0)?;
                    info!("Restored and saved multi-segment configuration with sb: True on {}", ip);
                }
                Ok(())
            })();
            if let Err(e) = seg_res {
                warn!("Error checking/restoring segments on {}: {}", ip, e);
                return Ok(false);
            }
        }
        Ok(true)
    })();
    match res {
        Ok(v) => v,
        Err(e) => {
            warn!("Error ensuring WLED config on {}: {}", ip, e);
            false
        }
    }
}

/// Light strip brightness over HTTP, verified from the returned state
pub fn sync_set_pwm_brightness(c: &DeviceConfig, brightness: i64, target_ip: Option<&str>) -> bool {
    let ip = target_ip.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(c.ip.trim()).to_string();
    if ip.is_empty() {
        return true;
    }
    let ids = pwm_seg_ids(c);
    if ids.is_empty() {
        return true;
    }
    if !is_host_online(&ip, 80, 0.3) {
        warn!("Device at {} is offline during set_pwm_brightness.", ip);
        return false;
    }
    let payload = json!({"seg": ids.iter().map(|i| json!({"id": i, "on": brightness > 0, "bri": brightness})).collect::<Vec<_>>(), "v": true});
    let state = match post_json_value(&format!("http://{}/json/state", ip), &payload, 1.0) {
        Ok(s) => s,
        Err(e) => {
            warn!("Error setting PWM brightness via HTTP on {}: {}", ip, e);
            return false;
        }
    };
    for live in arr(state.get("seg")) {
        let sid = safe_int(live.get("id"), -1);
        if !live.is_object() || !ids.contains(&sid) {
            continue;
        }
        if brightness > 0 && safe_int(live.get("bri"), -1) != brightness {
            warn!("PWM segment {} on {} reads back bri={} (expected {})", sid, ip, live.get("bri").map(py_str).unwrap_or_default(), brightness);
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------------------------
// The driver: one controller's channels and its LED thread
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct FadeSt {
    start: f64,
    duration: f64,
    style: String,
    accent: Option<(i64, i64, i64)>,
    frame: Option<Vec<u8>>,
    effect: Option<EffectConfig>,
    effect_start: f64,
}

#[derive(Clone, Debug)]
struct OverlaySt {
    start: f64,
    duration: f64,
    strength: f64,
    layer: EffectConfig,
    mask: EffectConfig,
    brightness: Option<i64>,
}

#[derive(Clone, Debug)]
struct LocatorSt {
    start: f64,
    duration: f64,
    position: f64,
    color: RGBColor,
}

#[derive(Clone, Debug)]
struct Chan {
    start: i64,
    stop: i64,
    baseline: Option<EffectConfig>,
    baseline_start: f64,
    transient: Option<EffectConfig>,
    transient_start: f64,
    transient_duration: f64,
    last_active_color: Option<RGBColor>,
    flow: bool,
    fade: Option<FadeSt>,
    overlay: Option<OverlaySt>,
    locator: Option<LocatorSt>,
    flow_session: i64,
}

impl Chan {
    fn new(start: i64, stop: i64) -> Chan {
        Chan {
            start,
            stop,
            baseline: None,
            baseline_start: wall(),
            transient: None,
            transient_start: 0.0,
            transient_duration: 0.0,
            last_active_color: None,
            flow: false,
            fade: None,
            overlay: None,
            locator: None,
            flow_session: 0,
        }
    }
    fn clear_flow(&mut self) {
        self.flow = false;
        self.fade = None;
        self.overlay = None;
        self.locator = None;
        self.flow_session = next_session();
    }
    fn prune(&mut self, now: f64) {
        if self.fade.as_ref().map_or(false, |f| (now - f.start) / f.duration >= 1.0) {
            self.fade = None;
        }
        if self.overlay.as_ref().map_or(false, |o| now - o.start >= o.duration) {
            self.overlay = None;
        }
        if self.locator.as_ref().map_or(false, |l| now - l.start >= l.duration) {
            self.locator = None;
        }
    }
}

struct DriverState {
    config: DeviceConfig,
    target_ips: Vec<String>,
    current_pwm: i64,
    channels: BTreeMap<i64, Chan>,
    mode: ProtocolMode,
    feeder: Option<tokio::task::JoinHandle<()>>,
}

pub struct WledDriver {
    st: Mutex<DriverState>,
    led: Arc<Shared>,
    /// Receives every rendered frame while set (simulator / previews)
    pub frame_tap: Mutex<Option<Arc<dyn Fn(Vec<u8>) + Send + Sync>>>,
}

fn rgb_t(c: RGBColor) -> led_thread::Rgb {
    led_thread::Rgb { r: c.r, g: c.g, b: c.b }
}

impl WledDriver {
    pub fn new(config: DeviceConfig) -> Arc<WledDriver> {
        let targets = if config.ip.is_empty() { Vec::new() } else { vec![config.ip.clone()] };
        Arc::new(WledDriver {
            st: Mutex::new(DriverState {
                current_pwm: config.default_pwm_brightness,
                config,
                target_ips: targets,
                channels: BTreeMap::new(),
                mode: ProtocolMode::IdleHttp,
                feeder: None,
            }),
            led: Shared::new(),
            frame_tap: Mutex::new(None),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, DriverState> {
        self.st.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn config(&self) -> DeviceConfig {
        self.lock().config.clone()
    }

    pub fn set_config(&self, c: DeviceConfig) {
        let mut s = self.lock();
        s.target_ips = if c.ip.is_empty() { Vec::new() } else { vec![c.ip.clone()] };
        s.config = c;
    }

    pub fn ip(&self) -> String {
        self.lock().config.ip.clone()
    }

    pub fn protocol_mode(&self) -> ProtocolMode {
        self.lock().mode
    }

    /// IDLE_HTTP -> ACTIVE_UDP: this controller's own game brightness wins over the global one
    pub fn transition_to_udp_mode(&self, spotlight: Option<i64>) -> bool {
        let mut s = self.lock();
        let bri = s.config.game_pwm_brightness.or(spotlight).unwrap_or(s.config.default_pwm_brightness);
        s.current_pwm = clamp(bri, 0, 255);
        s.mode = ProtocolMode::ActiveUdp;
        info!("Transitioned to ACTIVE_UDP mode (Spotlight brightness: {})", s.current_pwm);
        true
    }

    fn stop_feeder(&self, s: &mut DriverState) {
        if let Some(h) = s.feeder.take() {
            h.abort();
        }
        self.led.stop();
    }

    /// ACTIVE_UDP -> IDLE_HTTP: stop streaming, release the live lock and restore the preset
    pub async fn transition_to_http_mode(&self, preset_id: i64) -> bool {
        info!("Transitioning to IDLE_HTTP mode (seamlessly restoring default preset)...");
        let ips = {
            let mut s = self.lock();
            for ch in s.channels.values_mut() {
                ch.baseline = None;
                ch.transient = None;
                ch.clear_flow();
            }
            self.stop_feeder(&mut s);
            if s.target_ips.is_empty() {
                vec![s.config.ip.clone()]
            } else {
                s.target_ips.clone()
            }
        };
        let ok = tokio::task::spawn_blocking(move || release_live_and_restore_preset(&ips, preset_id)).await.unwrap_or(false);
        self.lock().mode = ProtocolMode::IdleHttp;
        ok
    }

    pub async fn ensure_wled_config(&self) -> bool {
        let c = self.config();
        tokio::task::spawn_blocking(move || sync_ensure_mso(&c)).await.unwrap_or(false)
    }

    /// Light strip brightness: in memory while streaming, over HTTP otherwise
    pub async fn set_board_light(&self, brightness: i64, target_ip: Option<String>) -> bool {
        let (mode, c, b) = {
            let mut s = self.lock();
            s.current_pwm = clamp(brightness, 0, 255);
            (s.mode, s.config.clone(), s.current_pwm)
        };
        if mode == ProtocolMode::ActiveUdp {
            self.sync_scene(false);
            return true;
        }
        tokio::task::spawn_blocking(move || sync_set_pwm_brightness(&c, b, target_ip.as_deref())).await.unwrap_or(false)
    }

    /// Play a legacy effect on one segment (or segment 0): duration 0 sets the baseline, otherwise a
    /// transient that reverts to the baseline afterwards.
    pub fn play_effect(self: &Arc<Self>, effect: &EffectConfig, segment_id: Option<i64>, force_enable: bool, previous_color: Option<RGBColor>) {
        let s_id = segment_id.unwrap_or(0);
        {
            let mut s = self.lock();
            let (start, stop) = segment_bounds(&s.config, s_id);
            let valid: HashSet<i64> = if s.config.segments.is_empty() { [0].into() } else { s.config.segments.iter().map(|x| x.id).collect() };
            s.channels.retain(|k, _| valid.contains(k));
            if s.mode != ProtocolMode::ActiveUdp {
                warn!("Blocked UDP effect execution: protocol mode is IDLE_HTTP. Connect UDP first.");
                return;
            }
            if !force_enable && (!effect.enabled || effect.is_off()) {
                drop(s);
                if segment_id.is_some() {
                    self.stop_segment(s_id);
                } else {
                    self.stop_effect();
                }
                return;
            }
            let ch = s.channels.entry(s_id).or_insert_with(|| Chan::new(start, stop));
            ch.start = start;
            ch.stop = stop;
            if ch.flow {
                ch.clear_flow();
            }
            match previous_color.filter(|c| !c.is_black()) {
                Some(c) => ch.last_active_color = Some(c),
                None => {
                    if let Some(cur) = ch.transient.as_ref().or(ch.baseline.as_ref()) {
                        if !cur.color_primary.is_black() {
                            ch.last_active_color = Some(cur.color_primary);
                        }
                    }
                }
            }
            if effect.duration <= 0.0 {
                if effect.is_off() {
                    ch.baseline = None;
                } else {
                    ch.baseline = Some(effect.clone());
                    ch.baseline_start = wall();
                    if !effect.color_primary.is_black() {
                        ch.last_active_color = Some(effect.color_primary);
                    }
                }
            } else {
                ch.transient = Some(effect.clone());
                ch.transient_start = wall();
                ch.transient_duration = effect.duration.max(0.2);
            }
        }
        self.ensure_broadcast();
    }

    fn flow_channel<'a>(s: &'a mut DriverState, segment_id: Option<i64>) -> &'a mut Chan {
        let s_id = segment_id.unwrap_or(0);
        let (start, stop) = segment_bounds(&s.config, s_id);
        let ch = s.channels.entry(s_id).or_insert_with(|| Chan::new(start, stop));
        ch.start = start;
        ch.stop = stop;
        if !ch.flow {
            ch.clear_flow();
            ch.baseline = None;
            ch.flow = true;
        }
        ch.transient = None;
        ch
    }

    /// Show a flow step's look on a segment, blending in from what it shows now. False when not streaming.
    pub fn flow_show(self: &Arc<Self>, segment_id: Option<i64>, effect: &EffectConfig, style: &str, duration: f64, accent: Option<(i64, i64, i64)>) -> bool {
        {
            let mut s = self.lock();
            if s.mode != ProtocolMode::ActiveUdp {
                warn!("Blocked flow look: protocol mode is IDLE_HTTP. Connect UDP first.");
                return false;
            }
            let led = Arc::clone(&self.led);
            let s_id = segment_id.unwrap_or(0);
            let ch = Self::flow_channel(&mut s, segment_id);
            if ch.baseline.as_ref() == Some(effect) {
                return true; // the same look again keeps running, fade included
            }
            let now = wall();
            ch.prune(now);
            let mut fade = None;
            if duration > 0.0 && style != "instant" {
                let frozen = if ch.fade.is_some() || ch.baseline.is_none() { led.last_base(s_id, ch.flow_session) } else { None };
                fade = Some(FadeSt {
                    start: now,
                    duration,
                    style: style.to_string(),
                    accent,
                    effect: if frozen.is_some() { None } else { ch.baseline.clone() },
                    frame: frozen,
                    effect_start: ch.baseline_start,
                });
            }
            ch.baseline = Some(effect.clone());
            ch.baseline_start = now;
            ch.fade = fade;
        }
        self.ensure_broadcast();
        true
    }

    /// A hit on top of a segment's current look; it fades back into the look at the end
    pub fn flow_hit(self: &Arc<Self>, segment_id: Option<i64>, effect: &EffectConfig, strength: f64) -> bool {
        {
            let mut s = self.lock();
            if s.mode != ProtocolMode::ActiveUdp {
                return false;
            }
            let ch = Self::flow_channel(&mut s, segment_id);
            let dur = if effect.duration != 0.0 { effect.duration } else { 1.0 };
            ch.overlay = Some(OverlaySt {
                start: wall(),
                duration: dur.max(0.2),
                strength: strength.max(0.0).min(1.0),
                layer: EffectConfig { color_secondary: effect.color_primary, brightness: None, ..effect.clone() },
                mask: EffectConfig { color_primary: RGBColor::WHITE, color_secondary: RGBColor::BLACK, brightness: None, ..effect.clone() },
                brightness: effect.brightness,
            });
        }
        self.ensure_broadcast();
        true
    }

    /// Light the part of a segment next to a board position (0 = top, 0.25 = right, clockwise)
    pub fn flow_locate(self: &Arc<Self>, segment_id: Option<i64>, position: f64, color: RGBColor, duration: f64, clockwise: bool) -> bool {
        {
            let mut s = self.lock();
            if s.mode != ProtocolMode::ActiveUdp {
                return false;
            }
            let ch = Self::flow_channel(&mut s, segment_id);
            let pos = crate::effects::pymod(position, 1.0);
            ch.locator = Some(LocatorSt {
                start: wall(),
                duration: duration.max(0.3),
                position: if clockwise { pos } else { crate::effects::pymod(1.0 - pos, 1.0) },
                color,
            });
        }
        self.ensure_broadcast();
        true
    }

    pub fn flow_clear(&self) {
        {
            let mut s = self.lock();
            for ch in s.channels.values_mut() {
                if ch.flow {
                    ch.baseline = None;
                    ch.clear_flow();
                }
            }
        }
        self.sync_scene(false);
    }

    pub fn stop_segment(&self, seg_id: i64) {
        {
            let mut s = self.lock();
            if let Some(ch) = s.channels.get_mut(&seg_id) {
                ch.baseline = None;
                ch.transient = None;
            } else {
                return;
            }
        }
        self.sync_scene(false);
    }

    /// True while the UDP stream renders an AutoGlow effect on any segment
    pub fn is_playing_effects(&self) -> bool {
        let s = self.lock();
        if s.mode != ProtocolMode::ActiveUdp {
            return false;
        }
        let now = wall();
        s.channels.values().any(|ch| {
            (ch.transient.is_some() && now - ch.transient_start < ch.transient_duration) || ch.baseline.as_ref().map_or(false, |b| !b.is_off())
        })
    }

    /// Stop every channel and the stream
    pub fn stop_effect(&self) {
        let mut s = self.lock();
        for ch in s.channels.values_mut() {
            ch.baseline = None;
            ch.transient = None;
            ch.clear_flow();
        }
        self.stop_feeder(&mut s);
    }

    pub fn close(&self) {
        let mut s = self.lock();
        self.stop_feeder(&mut s);
    }

    /// The scene the LED thread renders from; finished parts are cleared first
    fn scene(s: &mut DriverState) -> Scene {
        let now = wall();
        let cfg = s.config.clone();
        let mut channels = Vec::new();
        for (id, ch) in s.channels.iter_mut() {
            if ch.transient.is_some() && now - ch.transient_start >= ch.transient_duration {
                ch.transient = None;
            }
            if ch.flow {
                ch.prune(now);
            }
            channels.push(led_thread::Channel {
                id: *id,
                start: ch.start,
                stop: ch.stop,
                offset: segment_offset(&cfg, *id),
                baseline: ch.baseline.as_ref().map(render_effect),
                baseline_start: ch.baseline_start,
                transient: ch.transient.as_ref().map(render_effect),
                transient_start: ch.transient_start,
                transient_duration: ch.transient_duration,
                last_color: ch.last_active_color.map(rgb_t),
                flow: ch.flow,
                flow_session: ch.flow_session,
                fade: if ch.flow {
                    ch.fade.as_ref().map(|f| led_thread::Fade {
                        start: f.start,
                        duration: f.duration,
                        style: normalize_style_str(&f.style),
                        accent: f.accent.map(|(r, g, b)| (clamp(r, 0, 255) as u8, clamp(g, 0, 255) as u8, clamp(b, 0, 255) as u8)),
                        frame: f.frame.clone(),
                        effect: f.effect.as_ref().map(render_effect),
                        effect_start: f.effect_start,
                    })
                } else {
                    None
                },
                overlay: if ch.flow {
                    ch.overlay.as_ref().map(|o| led_thread::Overlay {
                        start: o.start,
                        duration: o.duration,
                        strength: o.strength,
                        layer: render_effect(&o.layer),
                        mask: render_effect(&o.mask),
                        brightness: o.brightness,
                    })
                } else {
                    None
                },
                locator: if ch.flow {
                    ch.locator.as_ref().map(|l| led_thread::Locator { start: l.start, duration: l.duration, position: l.position, color: rgb_t(l.color) })
                } else {
                    None
                },
            });
        }
        let targets: Vec<String> = (if s.target_ips.is_empty() { vec![cfg.ip.clone()] } else { s.target_ips.clone() }).into_iter().filter(|i| !i.is_empty()).collect();
        Scene {
            targets,
            port: cfg.udp_port.clamp(0, 65535) as u16,
            total: total_led_count(&cfg).max(0) as usize,
            pwm_indices: pwm_led_indices(&cfg),
            pwm_value: clamp(s.current_pwm, 0, 255) as u8,
            channels,
        }
    }

    /// Hand the current channels to the LED thread right away
    pub fn sync_scene(&self, start: bool) {
        let scene = {
            let mut s = self.lock();
            Self::scene(&mut s)
        };
        self.led.update(scene);
        if start {
            self.led.ensure_running();
        }
    }

    fn ensure_broadcast(self: &Arc<Self>) {
        self.sync_scene(true);
        let mut s = self.lock();
        if s.feeder.as_ref().map_or(true, |h| h.is_finished()) {
            let me = Arc::clone(self);
            s.feeder = Some(tokio::spawn(async move { me.feed_loop().await }));
        }
    }

    /// Keeps the LED thread fed: config edits, finished parts, last colours, frames and send errors.
    /// The thread ends by itself once nothing is active.
    async fn feed_loop(self: Arc<Self>) {
        self.sync_scene(true);
        loop {
            tokio::time::sleep(Duration::from_millis(20)).await;
            self.sync_scene(false);
            if let Some(frame) = self.led.take_frame() {
                let tap = self.frame_tap.lock().ok().and_then(|t| t.clone());
                if let Some(t) = tap {
                    t(frame);
                }
            }
            let colors = self.led.take_last_colors();
            if !colors.is_empty() {
                let mut s = self.lock();
                for (id, c) in colors {
                    if let Some(ch) = s.channels.get_mut(&id) {
                        ch.last_active_color = Some(RGBColor::new(c.r, c.g, c.b));
                    }
                }
            }
            for msg in self.led.take_errors() {
                warn!("{}", msg);
            }
            if !self.led.running() {
                break;
            }
        }
        self.led.stop();
    }

    /// The colour a segment showed last (Match Previous)
    pub fn last_active_color(&self, seg_id: i64) -> Option<RGBColor> {
        self.lock().channels.get(&seg_id).and_then(|c| c.last_active_color)
    }

}
