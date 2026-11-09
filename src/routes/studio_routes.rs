//! /api/studio/*: overlay settings, cameras, players with pictures, and the live scoreboard that
//! web/studio/live.html polls

use super::*;
use crate::autodarts::is_match_over;
use crate::studio::{self, PlayerError};
use crate::studio_camera::{self as cam, AcquireError, FIRST_FRAME_TIMEOUT, MAX_DELAY};
use axum::body::Body;
use axum::extract::Path;

const STALE_SNAPSHOT_SECONDS: f64 = 600.0;
const STREAM_BOUNDARY: &str = "autoglowframe";
const STREAM_FRAME_TIMEOUT: f64 = 10.0;
const CUES: [&str; 15] = [
    "idle", "intro", "live", "leg", "match", "180", "bust", "stinger", "bulloff", "layout:auto", "layout:split", "layout:board", "layout:player", "overlay:hide",
    "overlay:show",
];

fn player_err(e: PlayerError) -> AppError {
    match e {
        PlayerError::Invalid(m) => AppError::validation(m),
        PlayerError::NotFound => AppError::not_found("Player not found"),
    }
}

/// This computer's address in the local network (no packet is sent)
fn lan_ip() -> String {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok();
    s.and_then(|s| s.connect("192.0.2.1:80").ok().map(|_| s)).and_then(|s| s.local_addr().ok()).map(|a| a.ip().to_string()).unwrap_or_default()
}

pub async fn get_studio(State(s): State<S>, req: Req) -> ApiResult {
    let mut out = crate::obj! {"status" => "ok"};
    out.extend(s.studio.load_settings());
    let ip = lan_ip();
    let port = req.header("host").and_then(|h| h.rsplit_once(':')).and_then(|(_, p)| p.parse::<u16>().ok()).unwrap_or(80);
    out.insert("output_url".into(), json!(if ip.is_empty() { String::new() } else { format!("http://{}:{}/studio/live", ip, port) }));
    let h264 = tokio::task::spawn_blocking(crate::studio_video::encoder_available).await.unwrap_or(false);
    out.insert("h264_cameras".into(), json!(h264));
    out.extend(studio::text_info());
    ok(Value::Object(out))
}

pub async fn post_studio(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let settings = s.studio.save_settings(&data).map_err(AppError::persistence)?;
    let mut out = crate::obj! {"status" => "ok"};
    out.extend(settings);
    out.extend(studio::text_info());
    ok(Value::Object(out))
}

async fn save_player_inner(s: S, id: Option<String>, req: Req) -> ApiResult {
    if !req.header("content-type").unwrap_or("").starts_with("multipart/") {
        return Err(AppError::validation("Expected a multipart form"));
    }
    let mut fields = crate::obj! {"name" => ""};
    for (k, _) in studio::PROFILE_FIELDS {
        fields.insert(k.into(), json!(""));
    }
    let mut image = None;
    let mut mockup = None;
    for part in parse_multipart(&req) {
        if (part.name == "image" || part.name == "mockup") && part.filename.is_some() {
            if part.data.len() > studio::MAX_IMAGE_BYTES {
                return Err(AppError::validation("Picture is larger than 5 MB"));
            }
            let d = if part.data.is_empty() { None } else { Some(part.data) };
            if part.name == "image" {
                image = d;
            } else {
                mockup = d;
            }
        } else if fields.contains_key(&part.name) {
            let t: String = String::from_utf8_lossy(&part.data).chars().take(200).collect();
            fields.insert(part.name, json!(t));
        }
    }
    let name = py_str(&fields.shift_remove("name").unwrap_or(json!("")));
    let st = Arc::clone(&s.studio);
    let r = tokio::task::spawn_blocking(move || st.upsert_player(id.as_deref(), &name, &fields, image, mockup)).await.map_err(|_| AppError::internal("Player save failed"))?;
    let p = r.map_err(player_err)?;
    ok(json!({"status": "ok", "player": p}))
}

pub async fn save_player(State(s): State<S>, req: Req) -> ApiResult {
    save_player_inner(s, None, req).await
}

pub async fn update_player(State(s): State<S>, Path(id): Path<String>, req: Req) -> ApiResult {
    save_player_inner(s, Some(id), req).await
}

pub async fn delete_player(State(s): State<S>, Path(id): Path<String>) -> ApiResult {
    s.studio.delete_player(&id).map_err(player_err)?;
    ok(json!({"status": "ok"}))
}

pub async fn player_image(Path(name): Path<String>) -> ApiResult {
    let p = studio::image_path(&name).ok_or_else(|| AppError::not_found("Picture not found"))?;
    let b = tokio::fs::read(&p).await.map_err(|_| AppError::not_found("Picture not found"))?;
    let mut r = Response::new(Body::from(b));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static(studio::image_mime(&name)));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"));
    Ok(r)
}

/// Where the game data comes from, for the Studio page's status panel
fn source_info(s: &S) -> Value {
    let Some(ad) = &s.engine.autodarts else { return json!({"connected": false}) };
    let st = ad.lock();
    let mut o = crate::obj! {
        "connected" => st.is_connected, "match_running" => st.active_match_id().is_some(),
        "updated_ago" => if st.last_match_state_at > 0.0 { json!(studio::roundn(wall() - st.last_match_state_at, 1)) } else { Value::Null },
    };
    if let Value::Object(snap) = st.snapshot() {
        o.extend(snap);
    }
    Value::Object(o)
}

/// Play a scene on all outputs now, e.g. to try the animations without a game
pub async fn cue(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let scene = get_str(&data, "scene", "");
    if !CUES.contains(&scene.as_str()) {
        return Err(AppError::validation("Unknown scene"));
    }
    if let Some(rest) = scene.strip_prefix("overlay:") {
        let _ = s.studio.save_settings(&crate::obj! {"show_overlay" => rest == "show"});
    }
    let mut g = s.studio.cue.lock().unwrap();
    let id = g.as_ref().and_then(|c| c["id"].as_i64()).unwrap_or(0) + 1;
    let c = json!({"id": id, "scene": scene, "at": wall()});
    *g = Some(c.clone());
    ok(json!({"status": "ok", "cue": c}))
}

fn add_matches(players: &mut Value, settings: &Obj) {
    let list = arr(Some(players)).to_vec();
    let m = studio::map_players(&list, settings);
    if let Value::Array(ps) = players {
        for (p, mm) in ps.iter_mut().zip(m) {
            if let (Some(po), Value::Object(mo)) = (p.as_object_mut(), mm) {
                po.extend(mo);
            }
        }
    }
}

/// Scoreboard of the running (or last finished) match; ?demo=1 returns sample data
pub async fn state(State(s): State<S>, req: Req) -> ApiResult {
    let cue = s.studio.cue.lock().unwrap().clone();
    if req.q("demo") == Some("1") {
        let mut o = crate::obj! {"status" => "ok"};
        o.extend(studio::demo_scoreboard());
        o.insert("cue".into(), json!(cue));
        return ok(Value::Object(o));
    }
    let settings = s.studio.cached_settings();
    let (mut board, lobby, bull_off) = match &s.engine.autodarts {
        Some(ad) => {
            let st = ad.lock();
            let state = st.last_match_state.clone();
            let live = match &state {
                Some(stt) => st.active_match_id().is_some() || (wall() - st.last_match_state_at < STALE_SNAPSHOT_SECONDS && !is_match_over(stt)),
                None => false,
            };
            let phase = st.last_flow_state_str();
            let board = studio::build_scoreboard(state.as_ref(), live, &phase);
            let lobby = if live { None } else { studio::build_lobby(st.open_lobby()) };
            let bo = studio::build_bull_off(st.bull_off_view());
            (board, lobby, bo)
        }
        None => (studio::build_scoreboard(None, false, ""), None, None),
    };
    if let Some(p) = board.get_mut("players") {
        add_matches(p, &settings);
    }
    let lobby = lobby.map(|mut l| {
        if let Some(p) = l.get_mut("players") {
            add_matches(p, &settings);
        }
        Value::Object(l)
    });
    let bull_off = bull_off.map(|mut b| {
        if let Some(p) = b.get_mut("players") {
            add_matches(p, &settings);
        }
        Value::Object(b)
    });
    board.insert("lobby".into(), lobby.unwrap_or(Value::Null));
    board.insert("bull_off".into(), bull_off.unwrap_or(Value::Null));
    let src = source_info(&s);
    board.insert("source_connected".into(), src["connected"].clone());
    board.insert("source".into(), src);
    board.insert("cue".into(), json!(cue));
    let zoom = settings.get("dart_zoom").and_then(|d| d.get("enabled")) == Some(&json!(true));
    board.insert("darts".into(), json!(if zoom { s.darts.recent() } else { Vec::new() }));
    board.insert("server_time".into(), json!(studio::roundn(wall(), 3)));
    let mut o = crate::obj! {"status" => "ok"};
    o.extend(board);
    ok(Value::Object(o))
}

/// Whether the Autodarts Board Manager on this computer is running detection (and so its cameras)
pub async fn autodarts_state() -> ApiResult {
    let st = tokio::task::spawn_blocking(cam::board_manager_state).await.ok().flatten();
    let mut o = crate::obj! {"status" => "ok", "reachable" => st.is_some()};
    if let Some(Value::Object(x)) = st {
        o.extend(x);
    }
    ok(Value::Object(o))
}

/// Start Autodarts detection on this computer (the Start button of the Board Manager)
pub async fn autodarts_start(State(s): State<S>) -> ApiResult {
    let st = tokio::task::spawn_blocking(cam::start_board_manager).await.ok().flatten().ok_or_else(|| AppError::unavailable("The Autodarts Board Manager is not reachable on this computer"))?;
    if st.get("running") != Some(&json!(true)) {
        return Err(AppError::unavailable("Autodarts did not start \u{2013} check the Board Manager"));
    }
    s.cameras.retry_relays();
    let mut o = crate::obj! {"status" => "ok", "reachable" => true};
    if let Value::Object(x) = st {
        o.extend(x);
    }
    ok(Value::Object(o))
}

/// Save the Autodarts name of a match player as a Studio player's Autodarts name
pub async fn remember_name(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let settings = s.studio.remember_autodarts_name(&get_str(&data, "player_id", ""), &get_str(&data, "autodarts_name", "")).map_err(player_err)?;
    let mut o = crate::obj! {"status" => "ok"};
    o.extend(settings);
    ok(Value::Object(o))
}

/// The match and lobby data exactly as received from Autodarts, to check the Studio against a real game
pub async fn raw(State(s): State<S>) -> ApiResult {
    let (ms, ls) = match &s.engine.autodarts {
        Some(ad) => {
            let st = ad.lock();
            (st.last_match_state.clone(), st.last_lobby_state().cloned())
        }
        None => (None, None),
    };
    let mut r = Json(json!({"source": source_info(&s), "match_state": ms, "lobby_state": ls})).into_response();
    r.headers_mut().insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=\"autoglow-match-data.json\""));
    Ok(r)
}

/// Cameras the Studio can stream to every device: the Board Manager's and free USB cameras
pub async fn list_cameras() -> ApiResult {
    let (cams, used, ad) = tokio::task::spawn_blocking(|| (cam::list_cameras(), cam::board_manager_camera_locations(), cam::list_autodarts_cameras()))
        .await
        .map_err(|_| AppError::internal("Camera list failed"))?;
    let mut out = ad;
    for mut c in cams {
        let id = c["id"].as_str().unwrap_or("").to_string();
        c["source"] = json!("usb");
        c["autodarts"] = json!(used.iter().any(|loc| !loc.is_empty() && format!("-{}-", id).contains(&format!("-{}-", loc))));
        out.push(c);
    }
    ok(json!({"status": "ok", "cameras": out, "resolutions": cam::RESOLUTIONS.iter().map(|(n, _)| n).collect::<Vec<_>>(), "relay_fps": cam::RELAY_FPS}))
}

/// /dev/videoN of a USB camera on this computer; only those have picture controls here
fn usb_device(id: &str) -> Result<String, AppError> {
    if cam::autodarts_stream_url(id).is_some() {
        return Err(AppError::validation("Picture controls are only for a USB camera on the AutoGlow computer"));
    }
    cam::resolve_device(id).ok_or_else(|| AppError::not_found("Camera not found \u{2013} is it plugged in?"))
}

pub async fn get_camera_controls(req: Req) -> ApiResult {
    let dev = usb_device(req.q_or("cam", ""))?;
    let c = tokio::task::spawn_blocking(move || cam::get_controls(&dev)).await.map_err(|_| AppError::internal("failed"))?;
    let c = c.map_err(|e| AppError::unavailable(format!("Camera controls not readable: {}", e)))?;
    ok(json!({"status": "ok", "controls": c}))
}

pub async fn set_camera_controls(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let cam_id = get_str(&data, "cam", "");
    let slot = get_str(&data, "slot", "");
    let dev = usb_device(&cam_id)?;
    let used = tokio::task::spawn_blocking(cam::board_manager_camera_locations).await.unwrap_or_default();
    if used.iter().any(|loc| !loc.is_empty() && format!("-{}-", cam_id).contains(&format!("-{}-", loc))) {
        return Err(AppError::validation("Autodarts uses this camera for dart detection; change its picture in Autodarts"));
    }
    let reset = get_bool(&data, "reset", false);
    let dev2 = dev.clone();
    let values: Vec<(u32, i32)> = if reset {
        let c = tokio::task::spawn_blocking(move || cam::get_controls(&dev2)).await.map_err(|_| AppError::internal("failed"))?;
        c.map_err(|e| AppError::unavailable(format!("Camera controls not writable: {}", e)))?
            .iter()
            .filter_map(|c| Some((c["id"].as_u64()? as u32, c["default"].as_i64()? as i32)))
            .collect()
    } else {
        cam::clean_control_values(data.get("values")).iter().filter_map(|(k, v)| Some((k.parse().ok()?, v.as_i64()? as i32))).collect()
    };
    let v2 = values.clone();
    let result = tokio::task::spawn_blocking(move || cam::set_controls(&dev, &v2)).await.map_err(|_| AppError::internal("failed"))?;
    let result = result.map_err(|e| AppError::unavailable(format!("Camera controls not writable: {}", e)))?;
    let saved: Obj = if reset { Obj::new() } else { values.iter().map(|(k, v)| (k.to_string(), json!(v))).collect() };
    s.studio.save_camera_controls(&slot, &cam_id, &saved, reset);
    let mut o = crate::obj! {"status" => "ok"};
    if let Value::Object(r) = result {
        o.extend(r);
    }
    ok(Value::Object(o))
}

fn parse_delay(req: &Req) -> f64 {
    req.q("delay").and_then(|d| d.parse::<f64>().ok()).filter(|d| d.is_finite()).map(|d| d.max(0.0).min(MAX_DELAY)).unwrap_or(0.0)
}

fn mjpeg_part(frame: &[u8]) -> bytes::Bytes {
    let mut b = format!("--{}\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n", STREAM_BOUNDARY, frame.len()).into_bytes();
    b.extend_from_slice(frame);
    b.extend_from_slice(b"\r\n");
    bytes::Bytes::from(b)
}

/// MJPEG stream of a camera (?cam=<id>&res=720p[&delay=s]); any browser shows it as an <img>
pub async fn camera_stream(State(s): State<S>, req: Req) -> ApiResult {
    let settings = s.studio.load_settings();
    let res = req.q("res").filter(|r| !r.is_empty()).map(str::to_string).unwrap_or_else(|| py_str(&settings["camera_resolution"]));
    let cam_id = req.q_or("cam", "").to_string();
    let fps = settings["relay_fps"].as_i64().unwrap_or(15);
    let src = match s.cameras.acquire(&cam_id, &res, fps, s.studio.saved_controls(&cam_id)) {
        Ok(src) => src,
        Err(AcquireError::NotFound) => return Err(AppError::not_found("Camera not found")),
    };
    let delay = parse_delay(&req);
    if delay > 0.0 {
        src.keep_history(delay);
    }
    let start = if src.has_frame() { src.seq().saturating_sub(1) } else { 0 };
    let mut first = src.next_frame(start, FIRST_FRAME_TIMEOUT).await;
    if first.is_some() && delay > 0.0 {
        first = src.delayed_frame(0, delay, delay + FIRST_FRAME_TIMEOUT).await;
    }
    let Some((seq, frame)) = first else {
        let e = src.error();
        s.cameras.release(&src);
        return Ok(json_status(503, json!({"status": "error", "message": if e.is_empty() { "The camera sends no picture".to_string() } else { e }})));
    };
    struct Guard(Arc<cam::CameraHub>, Arc<cam::FrameSource>);
    impl Drop for Guard {
        fn drop(&mut self) {
            self.0.release(&self.1);
        }
    }
    let guard = Guard(Arc::clone(&s.cameras), Arc::clone(&src));
    let stream = futures_util::stream::unfold((Some((seq, frame)), guard, delay), |(next, g, delay)| async move {
        let (seq, frame) = next?;
        let part = mjpeg_part(&frame);
        // A slow viewer simply gets fewer frames: always the newest one, never a backlog
        let after = if delay > 0.0 { g.1.delayed_frame(seq, delay, STREAM_FRAME_TIMEOUT).await } else { g.1.next_frame(g.1.seq(), STREAM_FRAME_TIMEOUT).await };
        Some((Ok::<_, std::io::Error>(part), (after, g, delay)))
    });
    let mut r = Response::new(Body::from_stream(stream));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_str(&format!("multipart/x-mixed-replace; boundary={}", STREAM_BOUNDARY)).unwrap());
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store, must-revalidate"));
    r.headers_mut().insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    Ok(r)
}

/// A Studio output reports a camera problem (TVs have no developer tools): written to the log
pub async fn output_log(req: Req) -> ApiResult {
    let data = req.json()?;
    let c: String = get_str(&data, "camera", "").chars().take(40).collect();
    let m: String = get_str(&data, "message", "").chars().take(200).collect();
    let st: String = get_str(&data, "status", "").chars().take(12).collect();
    let agent: String = req.header("user-agent").unwrap_or("").chars().take(120).collect();
    warn!(
        "Studio output {}: {} \u{2013} {} (status {}, secure={}, webcodecs={}) [{}]",
        req.client_ip(),
        c,
        if m.is_empty() { "no picture".into() } else { m },
        st,
        data.get("secure").map(py_str).unwrap_or_else(|| "None".into()),
        data.get("webcodecs").map(py_str).unwrap_or_else(|| "None".into()),
        agent
    );
    ok(json!({"status": "ok"}))
}

/// A camera as H.264 in fragmented MP4 (?cam=<id>&res=720p&delay=<s>); the codec string is in X-Codec
pub async fn camera_video(State(s): State<S>, req: Req) -> ApiResult {
    if !tokio::task::spawn_blocking(crate::studio_video::encoder_available).await.unwrap_or(false) {
        return Err(AppError::unavailable("No H.264 encoder (ffmpeg with VAAPI) on this computer"));
    }
    let settings = s.studio.load_settings();
    let cam_id = req.q_or("cam", "").to_string();
    let res = req.q("res").filter(|r| !r.is_empty()).map(str::to_string).unwrap_or_else(|| py_str(&settings["camera_resolution"]));
    let delay = parse_delay(&req);
    let c = s.video.get(&cam_id, &res, settings["relay_fps"].as_i64().unwrap_or(15), s.studio.saved_controls(&cam_id), delay);
    let viewer = c.add_viewer();
    if !c.wait_ready(FIRST_FRAME_TIMEOUT + delay + 5.0).await {
        let (_, _, e) = c.init_codec();
        s.video.release(&c, &viewer);
        return Ok(json_status(503, json!({"status": "error", "message": if e.is_empty() { "The camera sends no picture".to_string() } else { e }})));
    }
    let (init, codec, _) = c.init_codec();
    struct Guard(Arc<crate::studio_video::VideoHub>, Arc<crate::studio_video::H264Camera>, Option<crate::studio_video::ViewerHandle>);
    impl Drop for Guard {
        fn drop(&mut self) {
            if let Some(v) = &self.2 {
                self.0.release(&self.1, v);
            }
        }
    }
    let g = Guard(Arc::clone(&s.video), Arc::clone(&c), Some(viewer));
    let first = bytes::Bytes::from(init.map(|i| (*i).clone()).unwrap_or_default());
    let stream = futures_util::stream::unfold((Some(first), g), |(first, mut g)| async move {
        if let Some(f) = first {
            return Some((Ok::<_, std::io::Error>(f), (None, g)));
        }
        let frag = g.2.as_mut()?.rx.recv().await.flatten()?;
        Some((Ok(bytes::Bytes::from((*frag).clone())), (None, g)))
    });
    let mut r = Response::new(Body::from_stream(stream));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    r.headers_mut().insert("x-codec", HeaderValue::from_str(&codec).unwrap_or(HeaderValue::from_static("avc1.640028")));
    r.headers_mut().insert("access-control-expose-headers", HeaderValue::from_static("X-Codec"));
    r.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-store, must-revalidate"));
    Ok(r)
}
