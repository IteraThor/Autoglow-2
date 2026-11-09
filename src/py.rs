//! Python value semantics on JSON values.
//!
//! The config files, presets and API bodies were written by (and for) the Python version, which read
//! them leniently: int("12") works, bool([]) is False, a missing key falls back to a default. These
//! helpers read serde_json values the same way, so old files and the web UI keep working unchanged.

use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// Python int(val) with a fallback for None and values int() rejects
pub fn safe_int(v: Option<&Value>, default: i64) -> i64 {
    match v {
        None | Some(Value::Null) => default,
        Some(v) => int_of(v).unwrap_or(default),
    }
}

/// Python int(val): bool → 0/1, float truncates, str must be an integer literal
pub fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)),
        Value::String(s) => s.trim().replace('_', "").parse::<i64>().ok(),
        _ => None,
    }
}

/// Python float(val) with a fallback
pub fn safe_float(v: Option<&Value>, default: f64) -> f64 {
    match v {
        None | Some(Value::Null) => default,
        Some(v) => float_of(v).unwrap_or(default),
    }
}

pub fn float_of(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(*b as i64 as f64),
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

/// Python bool(val)
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map_or(true, |f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// bool(d.get(key, default))
pub fn get_bool(o: &Obj, key: &str, default: bool) -> bool {
    o.get(key).map_or(default, truthy)
}

/// Python str(val)
pub fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(u) = n.as_u64() {
                u.to_string()
            } else {
                float_repr(n.as_f64().unwrap_or(0.0))
            }
        }
        other => other.to_string(),
    }
}

/// str(d.get(key, default))
pub fn get_str(o: &Obj, key: &str, default: &str) -> String {
    o.get(key).map_or_else(|| default.to_string(), py_str)
}

/// Python repr of a float: 2.0, 0.5, 1e-05
pub fn float_repr(f: f64) -> String {
    if f.is_nan() {
        return "nan".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if f == f.trunc() && f.abs() < 1e16 {
        return format!("{:.1}", f);
    }
    format!("{}", f)
}

/// The "or" of Python: the value when it is truthy, else None
pub fn non_empty(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| truthy(v))
}

pub fn as_obj(v: Option<&Value>) -> Option<&Obj> {
    v.and_then(Value::as_object)
}

/// d.get(key) as a dict, or an empty one
pub fn obj_or_empty(v: Option<&Value>) -> Obj {
    as_obj(v).cloned().unwrap_or_default()
}

pub fn arr(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map(|a| a.as_slice()).unwrap_or(&[])
}

/// Python round() (half to even) to an int
pub fn py_round(f: f64) -> i64 {
    let r = f.round();
    if (f - f.trunc()).abs() == 0.5 {
        let t = f.trunc();
        return if (t as i64) % 2 == 0 { t as i64 } else { r as i64 };
    }
    r as i64
}

pub fn clamp(v: i64, lo: i64, hi: i64) -> i64 {
    v.max(lo).min(hi)
}

/// Build a JSON object from key/value pairs in order
#[macro_export]
macro_rules! obj {
    ($($k:expr => $v:expr),* $(,)?) => {{
        #[allow(unused_mut)]
        let mut m = serde_json::Map::new();
        $( m.insert(($k).to_string(), serde_json::json!($v)); )*
        m
    }};
}
