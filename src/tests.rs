//! Tests against reference outputs recorded from the Python version (tests/fixtures/python_*.json) and
//! against real Autodarts matches recorded with the AutoGlow Bridge (tests/fixtures/*bull_off*.json).

use crate::autodarts::{read_throw, AutodartsBridge};
use crate::effects::{blend, render, FireState};
use crate::flow::{blend_flow, render_flow};
use crate::flow_catalog::{is_flow_effect, render_effect};
use crate::game_flow::{create_default_game_flow, player_colour_index, GameFlow};
use crate::models::*;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn fixture(name: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {}", p.display(), e))).unwrap()
}

fn reference() -> Value {
    fixture("python_reference_2026-11-09.json")
}

/// Replay a recorded match through the bridge and collect the events it emits
fn replay(name: &str) -> (Vec<Value>, Vec<String>) {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    rt.block_on(async {
        let bridge = AutodartsBridge::new("");
        let got: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let g = Arc::clone(&got);
        bridge.set_sink(Arc::new(move |e: DartEvent| {
            g.lock().unwrap().push(json!([e.kind().as_str(), e.player_name, e.player_index, e.score, e.multiplier, e.segment_number, e.segment_name, e.round_score]));
            Box::pin(async {})
        }));
        let src = bridge.attach().await;
        bridge.ingest(src, &json!({"type": "tab", "attached": true, "url": "https://play.autodarts.com/matches/x"})).await;
        for m in fixture(&format!("{}.json", name)).as_array().unwrap() {
            bridge.ingest(src, &json!({"type": "ws", "message": m})).await;
        }
        let players = bridge.current_players();
        let events = got.lock().unwrap().clone();
        (events, players)
    })
}

#[test]
fn recorded_matches_emit_the_same_events_as_python() {
    let r = reference();
    for name in ["bull_off_wdf_2026-11-01", "bull_off_pdc_tie_2026-11-01", "pdc_bull_off_match_2026-11-02", "bull_off_normal_2026-11-01"] {
        let (events, players) = replay(name);
        let want = &r[name];
        assert_eq!(Value::Array(events), want[0], "events of {}", name);
        assert_eq!(json!(players), want[1], "players of {}", name);
    }
}

#[test]
fn throws_are_read_like_python() {
    let r = reference();
    for (t, want) in r["throws"].as_array().unwrap().iter().zip(r["read_throw"].as_array().unwrap()) {
        let (s, m, l) = read_throw(t.as_object().unwrap());
        assert_eq!(json!([s, m, l]), *want, "{}", t);
    }
}

#[test]
fn similar_names_score_like_difflib() {
    for p in reference()["ratio"].as_array().unwrap() {
        let got = crate::studio::seq_ratio(p[0].as_str().unwrap(), p[1].as_str().unwrap());
        assert!((got - p[2].as_f64().unwrap()).abs() < 1e-12, "{} {} {}", p[0], p[1], got);
    }
}

#[test]
fn studio_players_map_like_python() {
    let sp = json!({"players": [
        {"id": "aaaaaaaaaaaa", "name": "Loki Laufeyson", "alias": "", "nickname": ""},
        {"id": "bbbbbbbbbbbb", "name": "Thor", "alias": "GodOfThunder", "nickname": ""},
        {"id": "cccccccccccc", "name": "J\u{e9}r\u{f4}me O'Neil", "alias": "", "nickname": ""},
    ]});
    let players = vec![json!({"name": "LOKKI"}), json!({"name": "godofthunder"}), json!({"name": "jerome oneil"}), json!({"name": "nobody"})];
    assert_eq!(Value::Array(crate::studio::map_players(&players, sp.as_object().unwrap())), reference()["map"]);
}

#[test]
fn player_colours_follow_names_like_python() {
    let mut f = create_default_game_flow();
    f.players[2].name = "Loki".into();
    for c in reference()["colour"].as_array().unwrap() {
        let roster: Vec<String> = c[0].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(player_colour_index(&roster, c[1].as_i64(), &f) as i64, c[2].as_i64().unwrap());
    }
}

#[test]
fn flows_serialize_like_python() {
    let r = reference();
    assert_eq!(create_default_game_flow().to_value(), r["default_flow"]);
    let v1 = GameFlow::from_value(&fixture("game_flows_v1_2026-11-01.json"), None);
    assert_eq!(v1.to_value(), r["v1"]);
    // Reading what was written gives the same flow again
    assert_eq!(GameFlow::from_value(&v1.to_value(), None).to_value(), r["v1"]);
}

#[test]
fn legacy_effects_render_the_same_bytes_as_python() {
    let f = fixture("python_frames_2026-11-09.json");
    let mut fire = FireState::default();
    for c in f["legacy"].as_array().unwrap() {
        let e = render_effect(&EffectConfig::from_value(Some(&c["effect"])));
        let n = c["count"].as_u64().unwrap() as usize;
        for (t, want) in c["times"].as_array().unwrap().iter().zip(c["frames"].as_array().unwrap()) {
            let got = hex::encode(render(&e, t[0].as_i64().unwrap(), t[1].as_f64().unwrap(), n, &mut fire));
            assert_eq!(got, want.as_str().unwrap(), "{} at {}", c["effect"]["animation"], t);
        }
    }
    let a: Vec<u8> = (0..90).map(|i| ((i * 37) % 256) as u8).collect();
    let b: Vec<u8> = (0..90).map(|i| ((i * 91 + 13) % 256) as u8).collect();
    for x in f["legacy_blends"].as_array().unwrap() {
        let got = hex::encode(blend(&a, &b, x["factor"].as_f64().unwrap(), x["style"].as_str().unwrap(), None));
        assert_eq!(got, x["out"].as_str().unwrap(), "{}", x);
    }
}

#[test]
fn flow_looks_render_the_same_bytes_as_python() {
    let f = fixture("python_frames_2026-11-09.json");
    for c in f["flow"].as_array().unwrap() {
        let cfg = EffectConfig::from_value(Some(&c["effect"]));
        assert!(is_flow_effect(&cfg.animation));
        let e = render_effect(&cfg);
        for (t, want) in [0.0, 0.2, 0.9, 2.3].iter().zip(c["frames"].as_array().unwrap()) {
            let got = hex::encode(render_flow(&e, &cfg.animation, e.flow.as_ref().unwrap(), *t, 40));
            assert_eq!(got, want.as_str().unwrap(), "{} at {}", cfg.animation, t);
        }
    }
    let a: Vec<u8> = (0..90).map(|i| ((i * 37) % 256) as u8).collect();
    let b: Vec<u8> = (0..90).map(|i| ((i * 91 + 13) % 256) as u8).collect();
    for x in f["blends"].as_array().unwrap() {
        let style = x["style"].as_str().unwrap();
        let acc = if style == "flash" { Some((0, 255, 0)) } else { None };
        let got = hex::encode(blend_flow(&a, &b, x["factor"].as_f64().unwrap(), style, acc, false));
        assert_eq!(got, x["out"].as_str().unwrap(), "{}", x);
    }
}

#[test]
fn wled_layout_import_keeps_autoglow_settings() {
    let fx = fixture("btf_wled_layout_2026-11-02.json");
    let segs = crate::wled_layout::segments_from_wled(fx["seg"].as_array().unwrap(), fx["hw_ins"].as_array().unwrap(), &[]);
    assert!(!segs.is_empty());
    // A light strip output becomes white illumination; no two segments cover the same LEDs
    let spans: std::collections::HashSet<(i64, i64)> = segs.iter().map(|s| (s.start, s.length)).collect();
    assert_eq!(spans.len(), segs.len());
    for s in &segs {
        assert_eq!(s.role == "white_illumination", s.r#type == "PWM White", "{:?}", s);
    }
    let mut prev = segs.clone();
    prev[0].clockwise = false;
    prev[0].role = "ambient".into();
    let again = crate::wled_layout::segments_from_wled(fx["seg"].as_array().unwrap(), fx["hw_ins"].as_array().unwrap(), &prev);
    assert!(!again[0].clockwise);
    assert_eq!(again[0].role, if again[0].r#type == "PWM White" { "white_illumination" } else { "ambient" });
}

#[test]
fn pre_23_profiles_split_per_controller() {
    let raw = json!({
        "devices": [{"ip": "10.0.0.5", "name": "Board"}],
        "active_profile": "Party",
        "profiles": [{"name": "Party", "events": {"180": {"animation": "rainbow"}},
                      "device_events": {"10.0.0.5": {"0": {"bust": {"animation": "flash", "enabled": true}, "player_2": {"animation": "solid", "enabled": true}}}}}],
    });
    let cfg = AppConfig::from_value(&raw);
    let names: Vec<&str> = cfg.profiles.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["Party", "Party - Board"]);
    assert_eq!(cfg.profile_name_for(Some("10.0.0.5"), None), "Party - Board");
    let split = cfg.get_profile("Party - Board").unwrap();
    assert_eq!(split.event("bust").unwrap().animation, "flash");
    assert!(split.player_slots.iter().any(|s| s.id == 2 && s.enabled));
}

#[test]
fn config_round_trip_keeps_unknown_keys_and_types() {
    let raw = json!({"global_brightness": "150", "inactivity_timeout_minutes": 0, "lighting_mode": "MATRIX", "my_extra": {"a": 1},
                     "devices": [{"ip": "1.2.3.4", "segments": [{"id": 0, "n": "Ring", "start": 0, "stop": 30, "of": 35}]}]});
    let mut cfg = AppConfig::from_value(&raw);
    assert_eq!(cfg.global_brightness, 150);
    assert_eq!(cfg.inactivity_timeout_minutes, 1);
    assert_eq!(cfg.lighting_mode, LightingMode::Matrix);
    assert_eq!(cfg.devices[0].segments[0].length, 30);
    assert_eq!(cfg.devices[0].segments[0].offset, 5);
    let v = cfg.to_value();
    assert_eq!(v["my_extra"], json!({"a": 1}));
    assert_eq!(v["duration_check"], Value::Null);
    assert_eq!(AppConfig::from_value(&v).to_value(), v);
}

#[test]
fn pins_and_sessions() {
    use crate::security::*;
    let h = hash_pin("4711");
    assert!(verify_pin("4711", &h) && !verify_pin("4712", &h));
    // A hash written by the Python version (hashlib.pbkdf2_hmac, 200000 rounds)
    let py = "pbkdf2_sha256$1000$00112233445566778899aabbccddeeff$";
    let mut out = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(b"1234", &hex::decode("00112233445566778899aabbccddeeff").unwrap(), 1000, &mut out);
    assert!(verify_pin("1234", &format!("{}{}", py, hex::encode(out))));
    let t = create_session_token(&h);
    assert!(is_valid_session(Some(&t), &h) && !is_valid_session(Some(&t), "other"));
    assert_eq!(validate_new_pin("12a").as_deref(), Some("PIN must contain digits only."));
}

#[test]
fn browser_looks_match_the_strip() {
    // web/js/features/flow-looks.js must draw what the strip shows; skipped without node
    if std::process::Command::new("node").arg("--version").output().is_err() {
        eprintln!("node is not installed; skipping");
        return;
    }
    let module = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("web/js/features/flow-looks.js");
    let mut cases = Vec::new();
    for spec in crate::flow_catalog::FLOW_EFFECTS {
        let mut combos: Vec<serde_json::Map<String, Value>> = vec![serde_json::Map::new()];
        for (k, f) in spec.options {
            let (_, allowed) = f();
            combos = combos.into_iter().flat_map(|c| allowed.iter().map(move |v| { let mut c = c.clone(); c.insert(k.to_string(), v.clone()); c })).collect();
        }
        for opts in combos {
            for (d, s, r, n) in [(0.0, 1.0, false, 45), (2.0, 1.7, true, 300), (1.0, 0.25, false, 7)] {
                cases.push(json!({"animation": spec.id, "color_primary": [250, 120, 10], "color_secondary": [5, 20, 60], "duration": d, "speed": s,
                                  "reverse": r, "options": opts, "count": n, "times": [0.0, 0.03, 0.41, 1.234, 2.5, 9.87]}));
            }
        }
    }
    let blends: Vec<Value> = crate::flow_catalog::FLOW_TRANSITIONS
        .iter()
        .flat_map(|(s, _)| [1, 45, 300].iter().flat_map(move |n| [0.0, 0.1, 0.37, 0.5, 0.8, 1.0].iter().map(move |f| json!({"style": s, "count": n, "factor": f, "accent": if *s == "flash" { json!([0, 255, 0]) } else { Value::Null }}))))
        .collect();
    let dir = std::env::temp_dir().join(format!("autoglow-looks-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("run.mjs");
    std::fs::write(
        &script,
        format!(
            "import {{ renderFlowFrame, blendFlow }} from {};\nconst cases = {};\nconst blends = {};\n\
             const a = n => Array.from({{length: n * 3}}, (_, i) => (i * 37) % 256);\nconst b = n => Array.from({{length: n * 3}}, (_, i) => (i * 91 + 13) % 256);\n\
             const frames = cases.map(c => c.times.map(t => Array.from(renderFlowFrame(c, t, c.count))));\n\
             const mixed = blends.map(x => Array.from(blendFlow(a(x.count), b(x.count), x.factor, x.style, x.accent)));\n\
             process.stdout.write(JSON.stringify({{frames, mixed}}));\n",
            json!(format!("file://{}", module.display())),
            Value::Array(cases.clone()),
            Value::Array(blends.clone())
        ),
    )
    .unwrap();
    let out = std::process::Command::new("node").arg(&script).output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let js: Value = serde_json::from_slice(&out.stdout).unwrap();
    let close = |a: &[u8], b: &Value, what: &str| {
        let b: Vec<i64> = b.as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
        assert_eq!(a.len(), b.len(), "{}", what);
        for (i, (x, y)) in a.iter().zip(&b).enumerate() {
            assert!((*x as i64 - y).abs() <= 1, "{} byte {}: strip {} browser {}", what, i, x, y);
        }
    };
    for (c, frames) in cases.iter().zip(js["frames"].as_array().unwrap()) {
        let cfg = EffectConfig::from_value(Some(c));
        let e = render_effect(&cfg);
        for (t, f) in c["times"].as_array().unwrap().iter().zip(frames.as_array().unwrap()) {
            let mine = render_flow(&e, &cfg.animation, e.flow.as_ref().unwrap(), t.as_f64().unwrap(), c["count"].as_u64().unwrap() as usize);
            close(&mine, f, &format!("{} {} t={}", c["animation"], c["options"], t));
        }
    }
    for (x, m) in blends.iter().zip(js["mixed"].as_array().unwrap()) {
        let n = x["count"].as_u64().unwrap() as usize;
        let a: Vec<u8> = (0..n * 3).map(|i| ((i * 37) % 256) as u8).collect();
        let b: Vec<u8> = (0..n * 3).map(|i| ((i * 91 + 13) % 256) as u8).collect();
        let acc = x["accent"].as_array().map(|v| (v[0].as_u64().unwrap() as u8, v[1].as_u64().unwrap() as u8, v[2].as_u64().unwrap() as u8));
        close(&blend_flow(&a, &b, x["factor"].as_f64().unwrap(), x["style"].as_str().unwrap(), acc, false), m, &format!("blend {}", x));
    }
}
