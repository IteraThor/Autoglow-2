//! Autodarts: the Chrome extension bridge (WebSocket + status) and the account routes. The direct cloud
//! login is on hold, so login and device link answer with the hold message.

use super::*;
use crate::autodarts::CLOUD_API_HOLD_MESSAGE;
use crate::security::BRIDGE_WS_PATH;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use std::time::Duration;

fn on_hold() -> ApiResult {
    Ok(json_status(503, json!({"status": "error", "on_hold": true, "message": CLOUD_API_HOLD_MESSAGE})))
}

pub async fn device_code() -> ApiResult {
    on_hold()
}
pub async fn device_poll() -> ApiResult {
    on_hold()
}
pub async fn login() -> ApiResult {
    on_hold()
}

fn board_id(s: &S) -> String {
    let c = s.engine.cfg();
    if !c.autodarts_board_id.is_empty() {
        return c.autodarts_board_id.clone();
    }
    c.extra.get("autodarts_board_id").map(py_str).unwrap_or_default()
}

pub async fn boards(State(s): State<S>) -> ApiResult {
    let Some(ad) = &s.engine.autodarts else { return ok(json!({"status": "ok", "authenticated": false, "boards": []})) };
    let st = ad.lock();
    ok(json!({"status": "ok", "source": "extension", "authenticated": st.is_connected, "email": "", "selected_board_id": board_id(&s), "boards": st.boards()}))
}

/// Status in the same shape as the cloud variant so the hub, power and matrix pages keep working
pub async fn status(State(s): State<S>) -> ApiResult {
    let Some(ad) = &s.engine.autodarts else { return ok(json!({"status": "ok", "source": "extension", "account": {"authenticated": false}})) };
    let (last, prev) = {
        let e = s.engine.state();
        (e.last_event_name.clone(), e.previous_event_name.clone())
    };
    let cfg_board = board_id(&s);
    let st = ad.lock();
    let boards = st.boards();
    let mid = st.active_match_id().map(str::to_string);
    let bid = if !st.board_id.is_empty() { st.board_id.clone() } else if !cfg_board.is_empty() { cfg_board } else { "All Boards".into() };
    ok(json!({
        "status": "ok", "source": "extension", "bridge": st.snapshot(),
        "account": {"email": "", "name": "", "username": "", "authenticated": st.is_connected, "has_access_token": false, "has_refresh_token": false},
        "connection": {"ws_connected": st.is_connected, "ws_gateway": "AutoGlow Chrome extension", "ws_endpoint": BRIDGE_WS_PATH, "running": true,
                       "board_id": bid, "subscribed_topics": []},
        "board": {"boards_count": boards.len(), "boards": boards},
        "match": {"active_match_id": mid, "in_game": mid.is_some(), "players": st.current_players, "active_player_idx": st.active_player_idx,
                  "last_throw_id": st.last_throw_id(), "last_event": last, "previous_event": prev},
    }))
}

pub async fn logout(State(s): State<S>) -> ApiResult {
    let mut snap = {
        let mut c = s.engine.cfg();
        c.autodarts_user.clear();
        c.autodarts_password.clear();
        c.autodarts_board_id.clear();
        for k in ["autodarts_email", "autodarts_password", "autodarts_access_token", "autodarts_refresh_token", "autodarts_board_id"] {
            c.extra.insert(k.into(), json!(""));
        }
        c.clone()
    };
    if !save_cfg(&s, &mut snap) {
        return Ok(json_status(500, json!({"status": "error", "message": "Failed to persist configuration to disk"})));
    }
    info!("Autodarts credentials cleared and user logged out.");
    ok(json!({"status": "ok", "message": "Logged out."}))
}

/// The WebSocket the Chrome extension pushes Autodarts game data into (access checked by the middleware)
pub async fn bridge_ws(State(s): State<S>, ws: WebSocketUpgrade) -> Response {
    if s.engine.autodarts.is_none() {
        return json_status(409, json!({"status": "error", "message": "Extension bridge is not active"}));
    }
    ws.on_upgrade(move |sock| bridge_session(s, sock))
}

async fn bridge_session(s: S, mut sock: WebSocket) {
    let ad = Arc::clone(s.engine.autodarts.as_ref().unwrap());
    let id = ad.attach().await;
    let welcome = json!({"type": "welcome", "server": "AutoGlow", "version": crate::VERSION, "primary": ad.is_primary(id)});
    if sock.send(Message::Text(welcome.to_string().into())).await.is_ok() {
        let mut ping = tokio::time::interval(Duration::from_secs(30));
        ping.tick().await;
        loop {
            tokio::select! {
                msg = sock.recv() => {
                    let Some(Ok(msg)) = msg else { break };
                    let Message::Text(t) = msg else { continue };
                    let Ok(v) = serde_json::from_str::<Value>(&t) else {
                        error!("Error processing message from Chrome extension: invalid JSON");
                        continue;
                    };
                    if let Some(reply) = ad.ingest(id, &v).await {
                        if sock.send(Message::Text(reply.to_string().into())).await.is_err() {
                            break;
                        }
                    }
                }
                _ = ping.tick() => {
                    if sock.send(Message::Ping(Default::default())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }
    ad.detach(id).await;
}

/// Extension folder and live status for the setup panel
pub async fn bridge_info(State(s): State<S>) -> ApiResult {
    let dir = crate::storage::project_root().join("chrome_extension");
    ok(json!({
        "status": "ok", "cloud_on_hold": true, "active": s.engine.autodarts.is_some(), "extension_dir": dir.to_string_lossy(),
        "ws_path": BRIDGE_WS_PATH, "bridge": s.engine.autodarts.as_ref().map(|a| a.lock().snapshot()),
    }))
}

/// Live telemetry stream for the pages
pub async fn telemetry_ws(State(s): State<S>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |sock| telemetry_session(s, sock))
}

async fn telemetry_session(s: S, mut sock: WebSocket) {
    let mut rx = s.engine.subscribe();
    let first = json!({"type": "protocol_state", "mode": s.engine.protocol_mode().as_str()});
    if sock.send(Message::Text(first.to_string().into())).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            m = rx.recv() => match m {
                Ok(text) => if sock.send(Message::Text(text.into())).await.is_err() { break },
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            },
            r = sock.recv() => if !matches!(r, Some(Ok(_))) { break },
        }
    }
}
