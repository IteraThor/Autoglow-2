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
        let got = hex::encode(blend_flow(&a, &b, x["factor"].as_f64().unwrap(), style, acc, false, false, None));
        assert_eq!(got, x["out"].as_str().unwrap(), "{}", x);
    }
}

#[test]
fn a_line_has_two_ends() {
    let lit = |buf: &[u8]| -> Vec<usize> { (0..buf.len() / 3).filter(|i| buf[i * 3] > 0).collect() };
    let look = |v: Value, line: bool| crate::effects::Effect { line, ..render_effect(&EffectConfig::from_value(Some(&v))) };
    let draw = |e: &crate::effects::Effect, t: f64| render_flow(e, &e.name, e.flow.as_ref().unwrap(), t, 40);
    let chase = json!({"animation": "chase", "color_primary": [255, 0, 0], "color_secondary": [0, 0, 0], "speed": 1.0, "options": {"tail": "short"}});
    // One lap takes 2.5 s. Just after it the light on a loop is back at the first LED...
    assert!(lit(&draw(&look(chase.clone(), false), 2.6)).contains(&1));
    // ...but on a line it has bounced off the end and is on its way back, the first LEDs still dark
    let back = lit(&draw(&look(chase.clone(), true), 2.6));
    assert!(back.contains(&38) && !back.contains(&1), "{:?}", back);
    // A curtain transition, part of the way in: on a loop it starts at the start point and comes from both sides, on a line it opens from the middle
    let (dark, bright) = (vec![0u8; 120], vec![255u8; 120]);
    let (on_loop, on_line) = (lit(&blend_flow(&dark, &bright, 0.4, "curtain", None, false, false, None)), lit(&blend_flow(&dark, &bright, 0.4, "curtain", None, false, true, None)));
    assert!(on_loop.contains(&0) && on_loop.contains(&39) && !on_loop.contains(&20), "{:?}", on_loop);
    assert!(on_line.contains(&19) && on_line.contains(&20) && !on_line.contains(&0), "{:?}", on_line);
    // A wipe runs from the other end when reversed
    let (a, b) = (dark, bright);
    assert_eq!(lit(&blend_flow(&a, &b, 0.3, "wipe", None, false, true, None)).first(), Some(&0));
    assert_eq!(lit(&blend_flow(&a, &b, 0.3, "wipe", None, true, true, None)).last(), Some(&39));
    // The direction is saved with the transition, and only when it is turned round
    let t = crate::game_flow::FlowTransition::from_value(Some(&json!({"style": "wipe", "duration": 0.5, "reverse": true})));
    assert!(t.reverse && t.to_value()["reverse"] == json!(true));
    assert!(crate::game_flow::FlowTransition::default().to_value().get("reverse").is_none());
}

#[test]
fn new_looks_and_transitions_know_the_shape_and_the_hit() {
    let look = |mut v: Value, line: bool, origin: Option<f64>| {
        v["options"] = v.get("options").cloned().unwrap_or(json!({}));
        crate::effects::Effect { line, origin, ..render_effect(&EffectConfig::from_value(Some(&v))) }
    };
    let draw = |e: &crate::effects::Effect, t: f64| render_flow(e, &e.name, e.flow.as_ref().unwrap(), t, 60);
    let red = |buf: &[u8]| -> Vec<usize> { (0..buf.len() / 3).filter(|i| buf[i * 3] > 0).collect() };
    // A ripple starts at the origin on a loop (here a quarter of the way round: LED 15 of 60)...
    let ripple = json!({"animation": "ripple", "color_primary": [255, 0, 0], "color_secondary": [0, 0, 0], "speed": 1.0});
    let early = red(&draw(&look(ripple.clone(), false, Some(0.25)), 0.1));
    assert!(early.contains(&15) && !early.contains(&0) && !early.contains(&40), "{:?}", early);
    // ...at the start point without one, and in the middle on a line, whatever origin it is given
    assert!(red(&draw(&look(ripple.clone(), false, None), 0.1)).contains(&0));
    for origin in [None, Some(0.25)] {
        let mid = red(&draw(&look(ripple.clone(), true, origin), 0.1));
        assert!(mid.contains(&30) && !mid.contains(&0) && !mid.contains(&59), "{:?}", mid);
    }
    // Later the ring has reached both ends of a line
    let late = red(&draw(&look(ripple.clone(), true, None), 1.25));
    assert!(late.contains(&0) && late.contains(&59), "{:?}", late);
    // Fire on a line is hottest at the start, and at the end when reversed; a loop burns opposite its start point
    let fire = |reverse: bool| json!({"animation": "fire", "color_primary": [255, 0, 0], "color_secondary": [0, 0, 0], "reverse": reverse});
    let heat = |buf: &[u8], from: usize, to: usize| -> u32 { (from..to).map(|i| buf[i * 3 + 1] as u32).sum() };
    for t in [0.3, 1.1, 4.7] {
        let f = draw(&look(fire(false), true, None), t);
        assert!(heat(&f, 0, 10) > heat(&f, 50, 60), "t={}", t);
        let r = draw(&look(fire(true), true, None), t);
        assert!(heat(&r, 50, 60) > heat(&r, 0, 10), "t={}", t);
        let l = draw(&look(fire(false), false, None), t);
        assert!(heat(&l, 25, 35) > heat(&l, 0, 5) + heat(&l, 55, 60), "t={}", t);
    }
    // A line's meteors fall off the end and vanish; on a loop they keep going round
    let meteors = json!({"animation": "meteors", "color_primary": [255, 0, 0], "color_secondary": [0, 0, 0], "options": {"amount": "few"}});
    let (mut gone, mut loop_always) = (false, true);
    for k in 0..400 {
        let t = k as f64 * 0.05;
        gone |= red(&draw(&look(meteors.clone(), true, None), t)).is_empty();
        loop_always &= !red(&draw(&look(meteors.clone(), false, None), t)).is_empty();
    }
    assert!(gone && loop_always);
    // On a short strip nothing falls between two LEDs: a ripple keeps a ring while it is strong, meteors never vanish on a loop
    let short = |e: &crate::effects::Effect, t: f64| render_flow(e, &e.name, e.flow.as_ref().unwrap(), t, 7);
    for line in [false, true] {
        let e = look(ripple.clone(), line, Some(0.3));
        for k in 0..20 {
            let t = 1.4 * 0.7 * k as f64 / 20.0;
            assert!(!red(&short(&e, t)).is_empty(), "ripple line={} t={}", line, t);
        }
    }
    let e = look(meteors.clone(), false, None);
    for k in 0..200 {
        assert!(!red(&short(&e, k as f64 * 0.05)).is_empty(), "meteors t={}", k as f64 * 0.05);
    }
    let (dark_a, dark_b) = (vec![10u8; 21], vec![20u8; 21]);
    for line in [false, true] {
        let mid = blend_flow(&dark_a, &dark_b, 0.5, "sweep", None, false, line, None);
        assert!(mid.iter().any(|v| *v > 20), "sweep on 7 LEDs line={}", line);
    }
    // Every new look gives a layer and a mask a hit can use: lit LEDs, and no colour where the mask says nothing
    for id in ["wave", "meteors", "fireworks", "confetti", "ripple", "fire"] {
        let mask = json!({"animation": id, "color_primary": [255, 255, 255], "color_secondary": [0, 0, 0], "speed": 1.0});
        let any = [0.2, 0.7, 1.3, 2.9].iter().any(|t| draw(&look(mask.clone(), false, None), *t).iter().any(|v| *v > 100));
        assert!(any, "{} never lights its mask", id);
    }
    // From the hit: a little way in, only LEDs near the origin have changed
    let (a, b) = (vec![0u8; 180], vec![255u8; 180]);
    let near = |buf: &[u8]| -> Vec<usize> { (0..buf.len() / 3).filter(|i| buf[i * 3] > 0).collect() };
    let s = near(&blend_flow(&a, &b, 0.15, "spread", None, false, false, Some(0.5)));
    assert!(!s.is_empty() && s.iter().all(|i| (*i as i64 - 30).abs() <= 12), "{:?}", s);
    let s = near(&blend_flow(&a, &b, 0.15, "spread", None, false, true, Some(0.5)));
    assert!(!s.is_empty() && s.iter().all(|i| (*i as i64 - 30).abs() <= 12), "{:?}", s);
    // ...even on a line with an origin it does not have, and a loop without one starts at its start point
    let s = near(&blend_flow(&a, &b, 0.15, "spread", None, false, true, Some(0.0)));
    assert!(s.contains(&30) && !s.contains(&0), "{:?}", s);
    let s = near(&blend_flow(&a, &b, 0.15, "spread", None, false, false, None));
    assert!(s.contains(&0) && !s.contains(&30), "{:?}", s);
    // The sweep paints the new look behind a bright light
    let (dark, grey) = (vec![0u8; 180], vec![100u8; 180]);
    let mid = blend_flow(&dark, &grey, 0.5, "sweep", Some((0, 255, 0)), false, false, None);
    assert!(mid.chunks(3).any(|p| p[1] > 150 && p[0] < 100));
    // Every new transition gives the old picture at 0 and the new one at 1, exactly, on both shapes
    let pa: Vec<u8> = (0..180).map(|i| ((i * 37) % 256) as u8).collect();
    let pb: Vec<u8> = (0..180).map(|i| ((i * 91 + 13) % 256) as u8).collect();
    for style in ["sweep", "spread", "dissolve", "dip"] {
        for (line, reverse, origin) in [(false, false, None), (true, true, None), (false, true, Some(0.3))] {
            assert_eq!(blend_flow(&pa, &pb, 0.0, style, None, reverse, line, origin), pa, "{} at 0", style);
            assert_eq!(blend_flow(&pa, &pb, 1.0, style, None, reverse, line, origin), pb, "{} at 1", style);
        }
    }
    // A dip goes dark in the middle and a dissolve changes LEDs one by one
    assert!(blend_flow(&pa, &pb, 0.5, "dip", None, false, false, None).iter().all(|v| *v == 0));
    let some = blend_flow(&pa, &pb, 0.5, "dissolve", None, false, false, None);
    let (same_a, same_b) = (some.chunks(3).zip(pa.chunks(3)).filter(|(x, y)| x == y).count(), some.chunks(3).zip(pb.chunks(3)).filter(|(x, y)| x == y).count());
    assert!(same_a > 5 && same_b > 5, "{} {}", same_a, same_b);
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
    prev[0].line = true;
    prev[0].role = "ambient".into();
    let again = crate::wled_layout::segments_from_wled(fx["seg"].as_array().unwrap(), fx["hw_ins"].as_array().unwrap(), &prev);
    assert!(!again[0].clockwise);
    assert!(again[0].line);
    // The shape is saved as "shape": "line"; a loop (the default) adds nothing to the config
    assert_eq!(again[0].to_value()["shape"], "line");
    assert!(crate::models::SegmentConfig::from_value(&again[0].to_value(), 0).line);
    assert!(segs[0].to_value().get("shape").is_none());
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
            // On a loop and on a line (a straight strip with two ends)
            for (d, s, r, n, line) in [(0.0, 1.0, false, 45, false), (2.0, 1.7, true, 300, false), (1.0, 0.25, false, 7, false), (0.0, 1.0, false, 45, true), (2.0, 1.7, true, 300, true), (0.0, 0.6, true, 7, true)] {
                // A ripple also starts from where a dart landed
                for origin in if spec.id == "ripple" { vec![Value::Null, json!(0.3)] } else { vec![Value::Null] } {
                    cases.push(json!({"animation": spec.id, "color_primary": [250, 120, 10], "color_secondary": [5, 20, 60], "duration": d, "speed": s,
                                      "reverse": r, "options": opts, "count": n, "line": line, "origin": origin, "times": [0.0, 0.03, 0.41, 1.234, 2.5, 9.87]}));
                }
            }
        }
    }
    let blends: Vec<Value> = crate::flow_catalog::FLOW_TRANSITIONS
        .iter()
        .flat_map(|(s, _)| [1, 45, 300].iter().flat_map(move |n| [0.0, 0.1, 0.37, 0.5, 0.8, 1.0].iter().map(move |f| json!({"style": s, "count": n, "factor": f, "accent": if *s == "flash" { json!([0, 255, 0]) } else { Value::Null }}))))
        .flat_map(|x| [(false, false), (true, false), (false, true), (true, true)].into_iter().map(move |(reverse, line)| { let mut x = x.clone(); x["reverse"] = json!(reverse); x["line"] = json!(line); x }))
        // "From the hit" starts where a dart landed; every other style ignores it
        .flat_map(|x| [Value::Null, json!(0.3)].into_iter().map(move |origin| { let mut x = x.clone(); x["origin"] = origin; x }))
        .collect();
    let dir = std::env::temp_dir().join(format!("autoglow-looks-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let script = dir.join("run.mjs");
    std::fs::write(
        &script,
        format!(
            "import {{ renderFlowFrame, blendFlow }} from {};\nconst cases = {};\nconst blends = {};\n\
             const a = n => Array.from({{length: n * 3}}, (_, i) => (i * 37) % 256);\nconst b = n => Array.from({{length: n * 3}}, (_, i) => (i * 91 + 13) % 256);\n\
             const frames = cases.map(c => c.times.map(t => Array.from(renderFlowFrame(c, t, c.count, c.line, c.origin))));\n\
             const mixed = blends.map(x => Array.from(blendFlow(a(x.count), b(x.count), x.factor, x.style, x.accent, x.reverse, x.line, x.origin)));\n\
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
        let e = crate::effects::Effect { line: c["line"] == json!(true), origin: c["origin"].as_f64(), ..render_effect(&cfg) };
        for (t, f) in c["times"].as_array().unwrap().iter().zip(frames.as_array().unwrap()) {
            let mine = render_flow(&e, &cfg.animation, e.flow.as_ref().unwrap(), t.as_f64().unwrap(), c["count"].as_u64().unwrap() as usize);
            close(&mine, f, &format!("{} {} line={} t={}", c["animation"], c["options"], c["line"], t));
        }
    }
    for (x, m) in blends.iter().zip(js["mixed"].as_array().unwrap()) {
        let n = x["count"].as_u64().unwrap() as usize;
        let a: Vec<u8> = (0..n * 3).map(|i| ((i * 37) % 256) as u8).collect();
        let b: Vec<u8> = (0..n * 3).map(|i| ((i * 91 + 13) % 256) as u8).collect();
        let acc = x["accent"].as_array().map(|v| (v[0].as_u64().unwrap() as u8, v[1].as_u64().unwrap() as u8, v[2].as_u64().unwrap() as u8));
        close(&blend_flow(&a, &b, x["factor"].as_f64().unwrap(), x["style"].as_str().unwrap(), acc, x["reverse"] == json!(true), x["line"] == json!(true), x["origin"].as_f64()), m, &format!("blend {}", x));
    }
}
