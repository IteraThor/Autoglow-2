//! Flow Matrix effect & transition catalog: a deliberately small set of looks, each with a clear job
//! in a dart game and at most two options in plain words. Everything is defined in proportions of the
//! segment, so a look is the same on 10 LEDs as on 1500.

use crate::effects::{Anim, Effect, Rgb};
use crate::flow::FlowOpts;
use crate::models::{EffectConfig, RGBColor};
use crate::py::*;
use serde_json::{json, Value};

pub struct FlowEffectSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub job: &'static str,
    /// key -> (default, allowed values)
    pub options: &'static [(&'static str, fn() -> (Value, Vec<Value>))],
}

fn opt_pulses() -> (Value, Vec<Value>) {
    (json!(1), vec![json!(1), json!(2), json!(3)])
}
fn opt_tail() -> (Value, Vec<Value>) {
    (json!("short"), vec![json!("short"), json!("long")])
}
fn opt_comets() -> (Value, Vec<Value>) {
    (json!(1), vec![json!(1), json!(2)])
}
fn opt_sides() -> (Value, Vec<Value>) {
    (json!("both"), vec![json!("both"), json!("one")])
}
fn opt_palette() -> (Value, Vec<Value>) {
    (json!("vivid"), vec![json!("vivid"), json!("soft")])
}
fn opt_amount() -> (Value, Vec<Value>) {
    (json!("some"), vec![json!("few"), json!("some"), json!("many")])
}
fn opt_colour_from() -> (Value, Vec<Value>) {
    (json!("custom"), vec![json!("custom"), json!("player")])
}

pub const FLOW_EFFECTS: &[FlowEffectSpec] = &[
    FlowEffectSpec { id: "solid", label: "Solid", job: "A steady colour", options: &[] },
    FlowEffectSpec { id: "breathe", label: "Breathe", job: "A calm, slow glow", options: &[] },
    FlowEffectSpec { id: "flash", label: "Flash", job: "Instant hit feedback", options: &[("pulses", opt_pulses)] },
    FlowEffectSpec { id: "chase", label: "Chase", job: "Light running around the strip", options: &[("tail", opt_tail), ("comets", opt_comets)] },
    FlowEffectSpec { id: "curtain", label: "Curtain", job: "Fills the strip from the top", options: &[("sides", opt_sides)] },
    FlowEffectSpec { id: "rainbow", label: "Rainbow", job: "A big celebration", options: &[("palette", opt_palette)] },
    FlowEffectSpec { id: "sparkle", label: "Sparkle", job: "Glitter over a colour", options: &[("amount", opt_amount)] },
];

/// Transition id -> label. "instant" is shown as Cut.
pub const FLOW_TRANSITIONS: &[(&str, &str)] = &[("instant", "Cut"), ("crossfade", "Fade"), ("wipe", "Wipe"), ("curtain", "Curtain"), ("flash", "Flash")];

pub const SPEED_MIN: f64 = 0.25;
pub const SPEED_MAX: f64 = 4.0;

pub fn is_flow_effect(id: &str) -> bool {
    FLOW_EFFECTS.iter().any(|e| e.id == id)
}

fn spec(id: &str) -> &'static FlowEffectSpec {
    FLOW_EFFECTS.iter().find(|e| e.id == id).unwrap_or(&FLOW_EFFECTS[0])
}

/// Python `value in allowed`: 1 == 1.0 == True
fn py_eq(a: &Value, b: &Value) -> bool {
    match (float_of_num(a), float_of_num(b)) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

fn float_of_num(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(*b as i64 as f64),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// The full option set for an effect: known keys only, each with an allowed value
pub fn normalize_options(effect_id: &str, options: Option<&Obj>) -> Obj {
    let empty = Obj::new();
    let given = options.unwrap_or(&empty);
    let mut out = Obj::new();
    let mut keys: Vec<(&str, fn() -> (Value, Vec<Value>))> = spec(effect_id).options.to_vec();
    keys.push(("colour_from", opt_colour_from));
    for (key, f) in keys {
        let (default, allowed) = f();
        let value = given.get(key).cloned().unwrap_or_else(|| default.clone());
        let ok = allowed.iter().any(|a| py_eq(a, &value));
        out.insert(key.into(), if ok { value } else { default });
    }
    out
}

pub fn normalize_transition_style(style: Option<&Value>) -> String {
    let s = style.filter(|v| truthy(v)).map(py_str).unwrap_or_default().trim().to_lowercase();
    let s = match s.as_str() {
        "cut" => "instant".to_string(),
        "fade" | "pulse" => "crossfade".to_string(),
        _ => s,
    };
    if FLOW_TRANSITIONS.iter().any(|(t, _)| *t == s) {
        s
    } else {
        "crossfade".into()
    }
}

pub fn normalize_style_str(s: &str) -> String {
    normalize_transition_style(Some(&json!(s)))
}

fn legacy(anim: &str) -> (&'static str, Value) {
    match anim {
        "solid" => ("solid", json!({})),
        "breathe" | "pulse" => ("breathe", json!({})),
        "heartbeat" => ("flash", json!({"pulses": 2})),
        "flash" => ("flash", json!({})),
        "chase" | "radar" => ("chase", json!({"tail": "long"})),
        "comet" | "scan" => ("chase", json!({"tail": "short"})),
        "dual_comet" => ("chase", json!({"comets": 2})),
        "curtain" => ("curtain", json!({"sides": "both"})),
        "wipe" => ("curtain", json!({"sides": "one"})),
        "rainbow" => ("rainbow", json!({"palette": "vivid"})),
        "pastel_rainbow" => ("rainbow", json!({"palette": "soft"})),
        "sparkle" => ("sparkle", json!({})),
        "fire" => ("sparkle", json!({"amount": "many"})),
        _ => ("solid", json!({})),
    }
}

pub fn clamp_speed(speed: f64) -> f64 {
    if speed.is_nan() {
        return 1.0;
    }
    speed.max(SPEED_MIN).min(SPEED_MAX)
}

/// The curated version of an effect. Effects that already carry options are only tidied; older effects
/// are converted (e.g. Radar -> Chase with a long tail). "Off" becomes a switched-off Solid.
pub fn to_flow_effect(effect: &EffectConfig) -> EffectConfig {
    let anim = effect.animation.as_str();
    if effect.options.is_some() && is_flow_effect(anim) {
        return EffectConfig { options: Some(normalize_options(anim, effect.options.as_ref())), speed: clamp_speed(effect.speed), ..effect.clone() };
    }
    if anim == "off" {
        return EffectConfig { animation: "solid".into(), enabled: false, options: Some(Obj::new()), speed: 1.0, ..effect.clone() };
    }
    let (target, extra) = legacy(anim);
    EffectConfig {
        animation: target.into(),
        options: Some(normalize_options(target, extra.as_object())),
        speed: 1.0,
        wled_effect_id: None,
        wled_effect_name: None,
        ..effect.clone()
    }
}

/// Effects and transitions as plain lists for the Flow Matrix page
pub fn catalog_for_ui() -> Value {
    let effects: Vec<Value> = FLOW_EFFECTS
        .iter()
        .map(|e| {
            let opts: Vec<Value> = e
                .options
                .iter()
                .map(|(k, f)| {
                    let (d, a) = f();
                    json!({"key": k, "default": d, "values": a})
                })
                .collect();
            json!({"id": e.id, "label": e.label, "job": e.job, "options": opts})
        })
        .collect();
    let transitions: Vec<Value> = FLOW_TRANSITIONS.iter().map(|(id, l)| json!({"id": id, "label": l})).collect();
    json!({"effects": effects, "transitions": transitions})
}

fn rgb(c: RGBColor) -> Rgb {
    Rgb { r: c.r, g: c.g, b: c.b }
}

/// An EffectConfig as the LED renderer's Effect (Flow options normalized like render_flow_frame)
pub fn render_effect(effect: &EffectConfig) -> Effect {
    let flow = effect.options.as_ref().map(|op| {
        let id = if is_flow_effect(&effect.animation) { effect.animation.as_str() } else { "solid" };
        let o = normalize_options(id, Some(op));
        let s = |k: &str, d: &str| o.get(k).map(py_str).unwrap_or_else(|| d.to_string());
        let i = |k: &str| o.get(k).map(|v| safe_int(Some(v), 1)).unwrap_or(1);
        FlowOpts { pulses: i("pulses"), comets: i("comets"), tail: s("tail", "short"), sides: s("sides", "both"), palette: s("palette", "vivid"), amount: s("amount", "some") }
    });
    Effect {
        anim: Anim::parse(&effect.animation),
        name: effect.animation.clone(),
        flow,
        c1: rgb(effect.color_primary),
        c2: rgb(effect.color_secondary),
        dynamic_secondary: effect.dynamic_secondary,
        duration: effect.duration,
        speed: effect.speed,
        reverse: effect.reverse,
        brightness: effect.brightness,
        transition: effect.transition.clone(),
        transition_duration: effect.transition_duration,
    }
}
