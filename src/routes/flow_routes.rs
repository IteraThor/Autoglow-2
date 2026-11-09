//! Flow Matrix routes: profiles (named flows), which controller / segment uses which, trying a step or hit
//! on the real lights, the match preview, and the lighting mode switch.

use super::*;
use crate::engine::is_pwm_segment;
use crate::flow_catalog::catalog_for_ui;
use crate::flow_runtime::board_position;
use crate::game_flow::*;
use crate::models::{EffectConfig, LightingMode, ProtocolMode};

const MAX_NAME: usize = 40;

fn match_running(s: &S) -> bool {
    s.engine.autodarts.as_ref().map_or(false, |a| {
        let st = a.lock();
        st.active_match_id().is_some() && !st.match_finished()
    })
}

fn clean_name(raw: Option<&Value>) -> Result<String, AppError> {
    let name = raw.filter(|v| truthy(v)).map(py_str).unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(AppError::validation("Give the profile a name."));
    }
    if name.chars().count() > MAX_NAME {
        return Err(AppError::validation(format!("Profile names can be at most {} characters.", MAX_NAME)));
    }
    Ok(name)
}

fn opt_int(v: Option<&Value>) -> Result<Option<i64>, AppError> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(x) => int_of(x).map(Some).ok_or_else(|| AppError::validation("Invalid segment id")),
    }
}

/// Every controller and its light strips, with the flow profile each one plays
fn lights(s: &S) -> Vec<Value> {
    let flows = &s.engine.flows;
    s.engine
        .active_devices()
        .iter()
        .map(|d| {
            let segs: Vec<Value> = if d.segments.is_empty() {
                vec![json!({"id": null, "name": "All LEDs", "gpio": "", "start": 0, "length": d.rgb_count, "role": "dartboard_ring",
                            "light_strip": false, "clockwise": true, "profile": flows.profile_name_for(Some(&d.ip), None)})]
            } else {
                d.segments
                    .iter()
                    .map(|sg| {
                        let pwm = is_pwm_segment(sg);
                        json!({"id": sg.id, "name": sg.name, "gpio": sg.gpio, "start": sg.start, "length": sg.length, "role": sg.role,
                               "light_strip": pwm, "clockwise": sg.clockwise, "locator": sg.locator,
                               "profile": if pwm { Value::Null } else { json!(flows.profile_name_for(Some(&d.ip), Some(sg.id))) }})
                    })
                    .collect()
            };
            json!({"ip": d.ip, "name": if d.name.is_empty() { d.ip.clone() } else { d.name.clone() }, "segments": segs})
        })
        .collect()
}

fn overview(s: &S) -> Obj {
    let flows = &s.engine.flows;
    let lights = lights(s);
    let profiles: Vec<Value> = flows
        .profile_names()
        .iter()
        .map(|name| {
            let f = flows.get_profile(Some(name));
            let used: Vec<Value> = lights
                .iter()
                .flat_map(|d| {
                    arr(d.get("segments"))
                        .iter()
                        .filter(|sg| sg.get("profile") == Some(&json!(name)))
                        .map(|sg| json!({"ip": d["ip"], "controller": d["name"], "segment": sg["id"], "segment_name": sg["name"]}))
                        .collect::<Vec<_>>()
                })
                .collect();
            json!({"name": name, "preset": f.preset, "used_by": used})
        })
        .collect();
    let cfg = s.engine.cfg_clone();
    let snap = s.engine.runtime().snapshot();
    crate::obj! {
        "status" => "ok", "profiles" => profiles, "default" => flows.default_profile(), "lights" => lights,
        "lighting_mode" => cfg.lighting_mode.as_str(), "match_end_to_waiting" => cfg.disconnect_udp_on_match_end,
        "standby" => json!({"dim_on": cfg.inactivity_timeout_enabled, "dim_minutes": cfg.inactivity_timeout_minutes, "off_on": cfg.idle_power_off_enabled,
                            "off_minutes": cfg.idle_power_off_minutes, "dim_brightness": cfg.idle_dimming_brightness}),
        "match_running" => match_running(s),
        "live" => json!({"step": snap.step, "player": snap.player, "bull_off": snap.bull_off, "hit": snap.hit}),
        "catalog" => catalog_for_ui(), "presets" => presets_for_ui(),
        "user_presets" => flows.user_presets().iter().map(|(n, _)| json!({"name": n})).collect::<Vec<_>>(),
        "steps" => STEP_IDS.iter().map(|sid| json!({"id": sid, "label": step_label(sid), "timed": TIMED_STEPS.contains(sid), "always_on": ALWAYS_ON_STEPS.contains(sid)})).collect::<Vec<_>>(),
        "hits" => HIT_IDS.iter().map(|h| json!({"id": h, "label": hit_label(h)})).collect::<Vec<_>>(),
        "max_players" => MAX_PLAYERS,
    }
}

fn with_overview(s: &S, extra: Obj) -> ApiResult {
    let mut o = extra;
    for (k, v) in overview(s) {
        o.insert(k, v);
    }
    ok(Value::Object(o))
}

/// Which controllers answer, by ip (one streaming the game counts as online)
async fn online(s: &S) -> Obj {
    let mut out = Obj::new();
    let mut hs = Vec::new();
    for d in s.engine.active_devices() {
        let streaming = s.engine.drivers().iter().any(|x| x.ip().trim() == d.ip.trim() && x.protocol_mode() == ProtocolMode::ActiveUdp);
        let ip = d.ip.clone();
        hs.push((d.ip.clone(), streaming, tokio::task::spawn_blocking(move || if streaming { true } else { http::is_host_online(ip.trim(), 80, 0.3) })));
    }
    for (ip, _, h) in hs {
        out.insert(ip, json!(h.await.unwrap_or(false)));
    }
    out
}

/// Read the LED layout of every online controller that is not streaming, so the segments shown are real
async fn refresh_layouts(s: &S, online: &Obj) {
    let streaming: Vec<String> = s.engine.drivers().iter().filter(|d| d.protocol_mode() == ProtocolMode::ActiveUdp).map(|d| d.ip().trim().to_string()).collect();
    let ips: Vec<String> = online.iter().filter(|(ip, v)| **v == json!(true) && !streaming.contains(&ip.trim().to_string())).map(|(ip, _)| ip.clone()).collect();
    if ips.is_empty() {
        return;
    }
    let hs: Vec<_> = ips.iter().map(|ip| (ip.clone(), tokio::task::spawn_blocking({ let ip = ip.clone(); move || wled::fetch_live_device_info(&ip, 0.4) }))).collect();
    let mut live = std::collections::HashMap::new();
    for (ip, h) in hs {
        if let Ok(v) = h.await {
            live.insert(ip, v);
        }
    }
    let snap = {
        let mut c = s.engine.cfg();
        let mut changed = false;
        for d in c.devices.iter_mut() {
            if let Some(info) = live.get(&d.ip) {
                changed |= crate::wled_layout::adopt_live_layout(d, info);
            }
        }
        if changed {
            Some(c.clone())
        } else {
            None
        }
    };
    if let Some(mut snap) = snap {
        save_cfg(s, &mut snap);
        s.engine.sync_drivers(&snap);
        info!("Took the controllers' current LED layouts for the Lighting page.");
    }
}

pub async fn get_overview(State(s): State<S>) -> ApiResult {
    let on = online(&s).await;
    refresh_layouts(&s, &on).await;
    let segs: Vec<(String, Option<i64>, String)> = lights(&s)
        .iter()
        .flat_map(|d| {
            let ip = d["ip"].as_str().unwrap_or("").to_string();
            arr(d.get("segments"))
                .iter()
                .filter(|sg| sg["light_strip"] != json!(true))
                .map(|sg| (ip.clone(), sg["id"].as_i64(), sg["name"].as_str().unwrap_or("").to_string()))
                .collect::<Vec<_>>()
        })
        .collect();
    s.engine.flows.give_own_profiles(&segs);
    with_overview(&s, crate::obj! {"online" => on})
}

pub async fn get_profile(State(s): State<S>, req: Req) -> ApiResult {
    let name = req.q("name").map(str::to_string);
    if let Some(n) = name.as_ref().filter(|n| !n.is_empty()) {
        if !s.engine.flows.profile_names().contains(n) {
            return Err(AppError::validation(format!("There is no profile called '{}'.", n)));
        }
    }
    ok(json!({"status": "ok", "flow": s.engine.flows.get_profile(name.as_deref()).to_value()}))
}

fn idle_failed(f: Vec<String>) -> Obj {
    crate::obj! {"idle_failed" => f}
}

/// Save an edited profile; a changed name renames it (controllers keep using it)
pub async fn save_profile(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let flows = &s.engine.flows;
    let raw = data.get("flow").and_then(Value::as_object).filter(|r| r.contains_key("steps")).ok_or_else(|| AppError::validation("No flow to save."))?;
    let old = non_empty(data.get("old_name")).or_else(|| non_empty(raw.get("name"))).map(py_str).unwrap_or_default();
    let name = clean_name(raw.get("name"))?;
    let names = flows.profile_names();
    if !old.is_empty() && !names.contains(&old) {
        return Err(AppError::validation(format!("There is no profile called '{}'.", old)));
    }
    if name != old && names.contains(&name) {
        return Err(AppError::validation(format!("A profile called '{}' already exists.", name)));
    }
    let mut r = raw.clone();
    r.insert("name".into(), json!(name));
    let flow = GameFlow::from_value(&Value::Object(r), Some(&name));
    if !flows.save_profile(&flow, if old.is_empty() { None } else { Some(&old) }) {
        return Err(AppError::persistence("Could not save the flow profile."));
    }
    let failed = s.engine.apply_idle(None, Some(&name)).await;
    let mut o = idle_failed(failed);
    o.insert("flow".into(), flows.get_profile(Some(&name)).to_value());
    with_overview(&s, o)
}

/// A new profile from a preset, or a copy of an existing profile
pub async fn create_profile(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let flows = &s.engine.flows;
    let name = clean_name(data.get("name"))?;
    if flows.profile_names().contains(&name) {
        return Err(AppError::validation(format!("A profile called '{}' already exists.", name)));
    }
    let flow = match non_empty(data.get("copy_from")).map(py_str) {
        Some(src) => {
            if !flows.profile_names().contains(&src) {
                return Err(AppError::validation(format!("There is no profile called '{}'.", src)));
            }
            let mut f = flows.load_profile(Some(&src));
            f.name = name.clone();
            f
        }
        None => build_preset(&non_empty(data.get("preset")).map(py_str).unwrap_or_else(|| "classic".into()), Some(&name)),
    };
    if !flows.save_profile(&flow, None) {
        return Err(AppError::persistence("Could not create the flow profile."));
    }
    with_overview(&s, crate::obj! {"flow" => flow.to_value()})
}

pub async fn delete_profile(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let flows = &s.engine.flows;
    let name = non_empty(data.get("name")).map(py_str).unwrap_or_default();
    if !flows.profile_names().contains(&name) {
        return Err(AppError::validation(format!("There is no profile called '{}'.", name)));
    }
    if flows.profile_names().len() <= 1 {
        return Err(AppError::validation("The last profile cannot be deleted."));
    }
    if !flows.delete_profile(&name) {
        return Err(AppError::persistence("Could not delete the flow profile."));
    }
    let failed = s.engine.apply_idle(None, None).await;
    with_overview(&s, idle_failed(failed))
}

/// Put a profile back to the preset it started from (Classic when it has none)
pub async fn reset_profile(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let flows = &s.engine.flows;
    let name = non_empty(data.get("name")).map(py_str).unwrap_or_default();
    if !flows.profile_names().contains(&name) {
        return Err(AppError::validation(format!("There is no profile called '{}'.", name)));
    }
    let cur = flows.get_profile(Some(&name));
    let flow = build_preset(cur.preset.as_deref().unwrap_or("classic"), Some(&name));
    if !flows.save_profile(&flow, None) {
        return Err(AppError::persistence("Could not reset the flow profile."));
    }
    let failed = s.engine.apply_idle(None, Some(&name)).await;
    let mut o = idle_failed(failed);
    o.insert("flow".into(), flow.to_value());
    with_overview(&s, o)
}

pub async fn set_default(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let name = non_empty(data.get("name")).map(py_str).unwrap_or_default();
    if !s.engine.flows.set_default(&name) {
        return Err(AppError::validation(format!("There is no profile called '{}'.", name)));
    }
    let failed = s.engine.apply_idle(None, None).await;
    with_overview(&s, idle_failed(failed))
}

/// Choose the profile a controller (segment_id omitted) or one of its segments plays
pub async fn assign(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let ip = non_empty(data.get("ip")).map(py_str).unwrap_or_default().trim().to_string();
    let name = non_empty(data.get("name")).map(py_str).unwrap_or_default();
    let seg = opt_int(data.get("segment_id"))?;
    if !s.engine.flows.profile_names().contains(&name) {
        return Err(AppError::validation(format!("There is no profile called '{}'.", name)));
    }
    if ip.is_empty() {
        return Err(AppError::validation("Choose a controller."));
    }
    if !s.engine.flows.assign(&ip, &name, seg) {
        return Err(AppError::persistence("Could not save the profile choice."));
    }
    let failed = s.engine.apply_idle(Some(vec![ip]), None).await;
    with_overview(&s, idle_failed(failed))
}

/// An RGB segment from {ip, segment_id}, with its controller's ip and its profile
fn segment(s: &S, r: Option<&Value>) -> Result<Obj, AppError> {
    let r = r.and_then(Value::as_object).cloned().unwrap_or_default();
    let ip = non_empty(r.get("ip")).map(py_str).unwrap_or_default().trim().to_string();
    let sid = opt_int(r.get("segment_id"))?;
    let l = lights(s);
    let entry = l
        .iter()
        .find(|d| d["ip"] == json!(ip))
        .and_then(|d| arr(d.get("segments")).iter().find(|sg| sg["id"].as_i64() == sid).cloned())
        .filter(|e| e["light_strip"] != json!(true))
        .ok_or_else(|| AppError::validation("That RGB strip was not found."))?;
    let mut e = entry.as_object().cloned().unwrap_or_default();
    e.insert("ip".into(), json!(ip));
    Ok(e)
}

/// Give a segment a look (saved as its own profile). Returns the look it had before, for Undo.
fn put_look(s: &S, seg: &Obj, flow: &GameFlow, origin: &str) -> Result<Value, AppError> {
    let pname = seg.get("profile").map(py_str).unwrap_or_default();
    let before = s.engine.flows.load_profile(Some(&pname)).to_value();
    let mut new = flow.clone();
    new.name = pname;
    new.origin = origin.into();
    if !s.engine.flows.save_profile(&new, None) {
        return Err(AppError::persistence("Could not save the look."));
    }
    Ok(before)
}

pub async fn segment_copy(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let src = segment(&s, data.get("from"))?;
    let mut targets = Vec::new();
    for r in arr(data.get("to")) {
        targets.push(segment(&s, Some(r))?);
    }
    targets.retain(|t| (t.get("ip"), t.get("id")) != (src.get("ip"), src.get("id")));
    if targets.is_empty() {
        return Err(AppError::validation("Choose where to copy it to."));
    }
    let flow = s.engine.flows.load_profile(src.get("profile").map(py_str).as_deref());
    let origin = format!("Copied from {}", src.get("name").map(py_str).unwrap_or_default());
    let mut before = Vec::new();
    for t in &targets {
        before.push(put_look(&s, t, &flow, &origin)?);
    }
    let mut ips: Vec<String> = targets.iter().map(|t| t.get("ip").map(py_str).unwrap_or_default()).collect();
    ips.sort();
    ips.dedup();
    let failed = s.engine.apply_idle(Some(ips), None).await;
    let mut o = idle_failed(failed);
    o.insert("before".into(), json!(before));
    with_overview(&s, o)
}

/// Start a segment from a preset: a built-in one ({preset: id}) or one of the user's ({mine: name})
pub async fn segment_preset(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let seg = segment(&s, Some(&Value::Object(data.clone())))?;
    let flow = match non_empty(data.get("mine")).map(py_str) {
        Some(m) => s.engine.flows.user_presets().into_iter().find(|(n, _)| *n == m).map(|(_, f)| f).ok_or_else(|| AppError::validation(format!("There is no preset called '{}'.", m)))?,
        None => build_preset(&non_empty(data.get("preset")).map(py_str).unwrap_or_else(|| "classic".into()), None),
    };
    let origin = flow.name.clone();
    let before = put_look(&s, &seg, &flow, &origin)?;
    let ip = seg.get("ip").map(py_str).unwrap_or_default();
    let failed = s.engine.apply_idle(Some(vec![ip]), None).await;
    let mut o = idle_failed(failed);
    o.insert("before".into(), json!([before]));
    o.insert("flow".into(), s.engine.flows.get_profile(seg.get("profile").map(py_str).as_deref()).to_value());
    with_overview(&s, o)
}

/// Undo: put back the looks a copy or preset replaced
pub async fn segment_restore(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let flows: Vec<GameFlow> = arr(data.get("flows")).iter().filter(|r| r.is_object()).map(|r| GameFlow::from_value(r, None)).collect();
    let names = s.engine.flows.profile_names();
    if flows.is_empty() || flows.iter().any(|f| !names.contains(&f.name)) {
        return Err(AppError::validation("Nothing to undo."));
    }
    for f in &flows {
        if !s.engine.flows.save_profile(f, None) {
            return Err(AppError::persistence("Could not undo."));
        }
    }
    let failed = s.engine.apply_idle(None, None).await;
    with_overview(&s, idle_failed(failed))
}

/// Save a look as one of the user's presets: {name, flow}
pub async fn preset_save(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let name = clean_name(data.get("name"))?;
    let raw = data.get("flow").and_then(Value::as_object).filter(|r| r.contains_key("steps")).ok_or_else(|| AppError::validation("No look to save."))?;
    let builtin: Vec<String> = PRESET_ORDER.iter().map(|p| preset_info(p).0.to_lowercase()).collect();
    if builtin.contains(&name.to_lowercase()) || s.engine.flows.user_presets().iter().any(|(n, _)| *n == name) {
        return Err(AppError::validation("That name is taken."));
    }
    let mut r = raw.clone();
    r.insert("name".into(), json!(name));
    r.insert("origin".into(), json!(""));
    let flow = GameFlow::from_value(&Value::Object(r), Some(&name));
    if !s.engine.flows.save_user_preset(&flow) {
        return Err(AppError::persistence("Could not save the preset."));
    }
    with_overview(&s, Obj::new())
}

pub async fn preset_delete(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    if !s.engine.flows.delete_user_preset(&non_empty(data.get("name")).map(py_str).unwrap_or_default()) {
        return Err(AppError::validation("That preset was not found."));
    }
    with_overview(&s, Obj::new())
}

/// Write the waiting look of the assigned profiles to one controller (ip) or all of them
pub async fn apply_idle(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let ip = non_empty(data.get("ip")).map(py_str).unwrap_or_default().trim().to_string();
    let failed = s.engine.apply_idle(if ip.is_empty() { None } else { Some(vec![ip]) }, None).await;
    ok(json!({"status": "ok", "idle_failed": failed}))
}

/// The RGB segments to try a look on: the chosen ones, one controller / segment, or all
fn targets(s: &S, ip: Option<String>, seg: Option<i64>, chosen: Option<&Value>) -> Result<Vec<(String, Option<i64>)>, AppError> {
    let segs: Vec<(String, Option<i64>)> = s.engine.flow_segments().into_iter().map(|(ip, sid, _)| (ip, sid)).collect();
    if let Some(Value::Array(c)) = chosen {
        let mut want = Vec::new();
        for x in c.iter().filter_map(Value::as_object) {
            want.push((non_empty(x.get("ip")).map(py_str).unwrap_or_default(), opt_int(x.get("segment_id"))?));
        }
        return Ok(segs.into_iter().filter(|t| want.contains(t)).collect());
    }
    Ok(match ip.filter(|i| !i.is_empty()) {
        Some(ip) => segs.into_iter().filter(|(i, sid)| *i == ip && (seg.is_none() || *sid == seg)).collect(),
        None => segs,
    })
}

/// Try part of a (possibly unsaved) flow on the real lights: a step, a hit over the turn, or the locator
pub async fn try_look(State(s): State<S>, req: Req) -> ApiResult {
    if match_running(&s) {
        return Err(AppError::validation("A match is running; trying looks would disturb it."));
    }
    let data = req.json()?;
    let flow = match data.get("flow").filter(|f| f.is_object()) {
        Some(f) => GameFlow::from_value(f, None),
        None => (*s.engine.flows.get_profile(non_empty(data.get("name")).map(py_str).as_deref())).clone(),
    };
    let kind = non_empty(data.get("kind")).map(py_str).unwrap_or_else(|| "step".into());
    let item = non_empty(data.get("id")).map(py_str).unwrap_or_else(|| "turn".into());
    let player = safe_int(non_empty(data.get("player")), 0).clamp(0, MAX_PLAYERS as i64 - 1);
    let tg = targets(&s, non_empty(data.get("ip")).map(py_str), opt_int(data.get("segment_id"))?, data.get("segments"))?;
    if tg.is_empty() {
        return Err(AppError::validation("No light strip to try it on. Add a controller in Setup first."));
    }
    s.engine.ensure_streaming().await;
    s.engine.state().lighting_test_active = true;
    let colour = flow.players[player_colour_index(&[], Some(player), &flow)].color;
    let coloured = |e: &EffectConfig, force: bool| -> EffectConfig {
        if force || e.options.as_ref().and_then(|o| o.get("colour_from")) == Some(&json!("player")) {
            EffectConfig { color_primary: colour, ..e.clone() }
        } else {
            e.clone()
        }
    };
    let turn = flow.step("turn");
    for (ip, sid) in tg {
        let Some(drv) = s.engine.get_driver(Some(&ip)) else { continue };
        match kind.as_str() {
            "hit" => {
                if !HIT_IDS.contains(&item.as_str()) {
                    return Err(AppError::validation("Unknown hit."));
                }
                drv.flow_show(sid, &coloured(&turn.effect, true), "instant", 0.0, None);
                drv.flow_hit(sid, &coloured(flow.hit(&item), false), 1.0);
            }
            "locator" => {
                drv.flow_show(sid, &coloured(&turn.effect, true), "instant", 0.0, None);
                let n = safe_int(non_empty(data.get("number")), 20);
                drv.flow_locate(sid, board_position(Some(n)).unwrap_or(0.0), colour, 2.0, s.engine.segment_clockwise(&ip, sid));
            }
            _ => {
                if !STEP_IDS.contains(&item.as_str()) {
                    return Err(AppError::validation("Unknown step."));
                }
                let st = flow.step(&item);
                let t = &st.transition;
                drv.flow_show(sid, &coloured(&st.effect, item == "turn"), &t.style, t.duration, t.accent_color.map(|c| c.tuple()));
            }
        }
    }
    ok(json!({"status": "ok"}))
}

/// Play a short made-up match through the flow on the real lights
pub async fn preview(State(s): State<S>, req: Req) -> ApiResult {
    if match_running(&s) {
        return Err(AppError::validation("A match is running; the preview would disturb it."));
    }
    let data = req.json()?;
    let flow = data.get("flow").filter(|f| f.is_object()).map(|f| GameFlow::from_value(f, None));
    let players = safe_int(non_empty(data.get("players")), 2).clamp(1, MAX_PLAYERS as i64);
    let legs = safe_int(non_empty(data.get("legs")), 1).clamp(1, 3);
    let plan = s.engine.start_preview(players, get_bool(&data, "bull_off", false), legs, flow).await;
    let mut o = crate::obj! {"status" => "ok"};
    if let Value::Object(p) = plan {
        o.extend(p);
    }
    ok(Value::Object(o))
}

pub async fn preview_stop(State(s): State<S>) -> ApiResult {
    s.engine.stop_preview().await;
    ok(json!({"status": "ok"}))
}

/// Save which way a light strip runs around the board (used by the hit locator)
pub async fn segment_direction(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let ip = non_empty(data.get("ip")).map(py_str).unwrap_or_default();
    let sid = safe_int(non_empty(data.get("segment_id")), 0);
    let dir = non_empty(data.get("direction")).map(py_str).unwrap_or_else(|| if get_bool(&data, "clockwise", true) { "cw".into() } else { "ccw".into() });
    let mut snap = {
        let mut c = s.engine.cfg();
        let mut changed = false;
        for d in c.devices.iter_mut().filter(|d| d.ip == ip) {
            for sg in d.segments.iter_mut().filter(|x| x.id == sid) {
                sg.clockwise = dir != "ccw";
                sg.locator = dir != "off";
                changed = true;
            }
        }
        if !changed {
            return Err(AppError::validation("That light strip was not found."));
        }
        c.clone()
    };
    if !save_cfg(&s, &mut snap) {
        return Err(AppError::persistence("Could not save the strip direction."));
    }
    s.engine.sync_drivers(&snap);
    ok(json!({"status": "ok", "direction": dir}))
}

pub async fn get_mode(State(s): State<S>) -> ApiResult {
    ok(json!({"status": "ok", "mode": s.engine.cfg().lighting_mode.as_str()}))
}

/// Switch the lighting engine: Flow Matrix (default) or the legacy Event Matrix
pub async fn set_mode(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let mode = if get_str(&data, "mode", "flow").trim().to_lowercase() == "matrix" { LightingMode::Matrix } else { LightingMode::Flow };
    s.engine.set_lighting_mode(mode).await;
    let mut snap = s.engine.cfg_clone();
    if !save_cfg(&s, &mut snap) {
        warn!("Could not persist lighting_mode to config.json");
    }
    s.engine.broadcast(json!({"type": "lighting_mode_changed", "mode": mode.as_str()})).await;
    info!("Lighting mode changed to '{}' and persisted.", mode.as_str());
    let failed = if mode == LightingMode::Flow { s.engine.apply_idle(None, None).await } else { Vec::new() };
    ok(json!({"status": "ok", "mode": mode.as_str(), "idle_failed": failed}))
}

/// Save the standby timers (the same values as Settings > Power) from the Flow Matrix chart
pub async fn standby(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let base = s.engine.cfg_clone();
    let minutes = |k: &str, fb: i64| -> Result<i64, AppError> {
        match data.get(k) {
            None => Ok(fb.clamp(1, 240)),
            Some(v) => int_of(v).map(|m| m.clamp(1, 240)).ok_or_else(|| AppError::validation("Minutes must be a whole number.")),
        }
    };
    let bri = match data.get("dim_brightness") {
        None => base.idle_dimming_brightness.clamp(0, 255),
        Some(v) => int_of(v).ok_or_else(|| AppError::validation("Brightness must be a whole number."))?.clamp(0, 255),
    };
    let dim_on = get_bool(&data, "dim_on", base.inactivity_timeout_enabled);
    let dim_min = minutes("dim_minutes", base.inactivity_timeout_minutes)?;
    let off_on = get_bool(&data, "off_on", base.idle_power_off_enabled);
    // Same rule as Settings > Power: switching off never comes before dimming
    let off_min = minutes("off_minutes", base.idle_power_off_minutes)?.max(dim_min);
    let mew = get_bool(&data, "match_end_to_waiting", base.disconnect_udp_on_match_end);
    let mut snap = {
        let mut c = s.engine.cfg();
        c.inactivity_timeout_enabled = dim_on;
        c.inactivity_timeout_minutes = dim_min;
        c.idle_power_off_enabled = off_on;
        c.idle_power_off_minutes = off_min;
        c.disconnect_udp_on_match_end = mew;
        c.idle_dimming_brightness = bri;
        c.clone()
    };
    if !save_cfg(&s, &mut snap) {
        return Err(AppError::persistence("Could not save the standby timers."));
    }
    ok(json!({"status": "ok", "inactivity_timeout_enabled": dim_on, "inactivity_timeout_minutes": dim_min, "idle_power_off_enabled": off_on,
              "idle_power_off_minutes": off_min, "disconnect_udp_on_match_end": mew, "idle_dimming_brightness": bri}))
}
