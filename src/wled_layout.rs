//! Reading a controller's LED layout from WLED into AutoGlow's segments: when a layout is saved (Setup),
//! when the server starts and when the Lighting page loads.

use crate::models::{is_pwm_output, DeviceConfig, SegmentConfig};
use crate::py::*;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

/// The WLED segments without leftovers: a segment covering exactly the same LEDs as an earlier one is dropped
pub fn unique_ranges(seg_data: &[Value]) -> Vec<Value> {
    let mut seen = HashSet::new();
    seg_data
        .iter()
        .filter(|s| s.is_object())
        .filter(|s| seen.insert((safe_int(s.get("start"), 0), safe_int(s.get("stop"), 1))))
        .cloned()
        .collect()
}

/// AutoGlow's segments from a WLED layout; what only AutoGlow knows (role, hit-locator direction) is kept
/// from the previous segment with the same id and start
pub fn segments_from_wled(seg_data: &[Value], hw_ins: &[Value], previous: &[SegmentConfig]) -> Vec<SegmentConfig> {
    let outputs: Vec<&Value> = hw_ins.iter().filter(|h| h.is_object()).collect();
    let before: HashMap<(i64, i64), &SegmentConfig> = previous.iter().map(|p| ((p.id, p.start), p)).collect();
    let mut out = Vec::new();
    for (i, s) in unique_ranges(seg_data).iter().enumerate() {
        let start = safe_int(s.get("start"), 0);
        let o = outputs.iter().find(|h| {
            let hs = safe_int(h.get("start"), 0);
            hs <= start && start < hs + safe_int(h.get("len"), 1)
        });
        let pwm = o.map_or(false, |h| is_pwm_output(h));
        let pin = o.and_then(|h| h.get("pin")).and_then(Value::as_array).and_then(|a| a.first()).cloned();
        let id = safe_int(s.get("id"), i as i64);
        let old = before.get(&(id, start));
        let mut seg = SegmentConfig::new(id);
        seg.name = non_empty(s.get("n")).or_else(|| non_empty(s.get("name"))).map(py_str).unwrap_or_else(|| format!("Segment {}", i));
        seg.start = start;
        seg.length = 1.max(safe_int(s.get("stop"), 1) - start);
        seg.r#type = if pwm { "PWM White".into() } else { "WS281x".into() };
        seg.offset = 0.max(safe_int(s.get("of"), 0));
        if let Some(p) = pin {
            seg.gpio = format!("GPIO {}", py_str(&p));
        } else if let Some(o) = old {
            seg.gpio = o.gpio.clone();
        }
        if pwm {
            seg.role = "white_illumination".into();
        } else if let Some(o) = old.filter(|o| o.role != "white_illumination") {
            seg.role = o.role.clone();
        }
        if let Some(o) = old {
            seg.clockwise = o.clockwise;
            seg.locator = o.locator;
        }
        out.push(seg);
    }
    out
}

/// Take the layout of a reachable controller (fetch_live_device_info) into its config; true when changed
pub fn adopt_live_layout(dev: &mut DeviceConfig, info: &Value) -> bool {
    if info.get("online") != Some(&Value::Bool(true)) {
        return false;
    }
    let seg_data = arr(info.get("state").and_then(|s| s.get("seg")));
    if seg_data.is_empty() {
        return false;
    }
    let hw: Vec<Value> = match info.get("hw_ins").and_then(Value::as_array) {
        Some(a) if !a.is_empty() => a.clone(),
        _ => dev.hw_ins.clone(),
    };
    let segs = segments_from_wled(seg_data, &hw, &dev.segments);
    let same = segs.iter().map(|s| s.to_value()).collect::<Vec<_>>() == dev.segments.iter().map(|s| s.to_value()).collect::<Vec<_>>();
    if same && hw == dev.hw_ins {
        return false;
    }
    dev.segments = segs;
    dev.hw_ins = hw.clone();
    let outs: Vec<&Value> = hw.iter().filter(|h| h.is_object()).collect();
    if let Some(rgb) = outs.iter().find(|h| !is_pwm_output(h)) {
        dev.rgb_count = safe_int(rgb.get("len"), dev.rgb_count);
    }
    dev.pwm_index = outs.iter().find(|h| is_pwm_output(h)).map(|p| safe_int(p.get("start"), 0));
    true
}
