//! Local tournaments: the page in Autodarts (through the extension) and boards on other PCs

use super::*;
use axum::extract::ws::WebSocketUpgrade;

fn done(r: Result<(), String>, s: &S) -> ApiResult {
    match r {
        Ok(()) => ok(s.tournaments.local_view()),
        Err(e) => Err(AppError::validation(e)),
    }
}

fn str_of(b: &crate::py::Obj, k: &str) -> String {
    b.get(k).map(crate::py::py_str).unwrap_or_default()
}

pub async fn local(State(s): State<S>) -> ApiResult {
    ok(s.tournaments.local_view())
}

/// A made-up tournament for the Dashboard page's demo switch; nothing is stored
pub async fn demo(req: Req) -> ApiResult {
    let q = |k: &str| req.query.get(k).cloned().unwrap_or_default();
    ok(crate::tournament::demo::view(&q("format"), &q("state")))
}

pub async fn discover(State(s): State<S>) -> ApiResult {
    ok(json!({"hosts": s.tournaments.discover().await}))
}

/// Check a wizard spec and show its bracket without creating anything
pub async fn preview(State(s): State<S>, req: Req) -> ApiResult {
    let _ = &s;
    let (spec, _) = crate::tournament::spec_from(&req.json()?).map_err(AppError::validation)?;
    let t = crate::tournament::engine::create(&spec, "preview", 0.0).map_err(AppError::validation)?;
    ok(crate::tournament::engine::view(&t))
}

/// "Host a tournament": the lobby opens at once and boards can join
pub async fn lobby_open(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.open_lobby(&str_of(&b, "format")), &s)
}

/// The organizer changed rules or players in the lobby
pub async fn lobby(State(s): State<S>, req: Req) -> ApiResult {
    let (spec, _) = crate::tournament::spec_from(&req.json()?).map_err(AppError::validation)?;
    done(s.tournaments.update_lobby(spec), &s)
}

pub async fn lobby_start(State(s): State<S>) -> ApiResult {
    let players = s.tournaments.start_lobby().map_err(AppError::validation)?;
    let (added, failed) = profiles(&s, &players).await;
    let mut v = s.tournaments.local_view();
    v["profiles_added"] = json!(added);
    v["profiles_error"] = json!(failed);
    ok(v)
}

/// Tournament players get a club profile, so their games count for their stats; visitors don't,
/// and their name is hidden from the club's unassigned list. Returns the names given a profile,
/// and why the others got none (the club host is offline: then the rest isn't tried either).
async fn profiles(s: &S, players: &[crate::tournament::engine::Player]) -> (Vec<String>, Option<String>) {
    let roster = s.club.members();
    let mut failed: Option<String> = None;
    let known = |n: &str| {
        let n = n.trim().to_lowercase();
        roster["players"].as_array().map_or(false, |ps| ps.iter().any(|p| py_str(&p["name"]).trim().to_lowercase() == n || (!n.is_empty() && py_str(&p["alias"]).trim().to_lowercase() == n)))
    };
    let mut added = Vec::new();
    for p in players {
        if failed.is_some() {
            break;
        }
        let ad = if p.ad_name.trim().is_empty() { p.name.trim() } else { p.ad_name.trim() };
        if p.visitor {
            let r = if s.club.is_board() {
                s.club.forward("POST", "/api/club/ignore".into(), "application/json".into(), json!({"name": ad, "ignore": true}).to_string().into_bytes()).await.map(|_| ())
            } else {
                s.club.ignore(ad, true)
            };
            if let Err(e) = r {
                warn!("Could not mark visitor {} as a guest: {}", p.name, e);
                failed = Some(e);
            }
            continue;
        }
        if !p.member.is_empty() || known(&p.name) || known(&p.ad_name) {
            continue;
        }
        let alias = if p.ad_name.trim().is_empty() || p.ad_name.trim().eq_ignore_ascii_case(p.name.trim()) { "" } else { p.ad_name.trim() };
        let r = if s.club.is_board() {
            let b = "autoglowtournament";
            let body = format!("--{b}\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\n{}\r\n--{b}\r\nContent-Disposition: form-data; name=\"alias\"\r\n\r\n{}\r\n--{b}--\r\n", p.name.trim(), alias);
            s.club.forward("POST", "/api/studio/players".into(), format!("multipart/form-data; boundary={b}"), body.into_bytes()).await.map(|_| ())
        } else {
            let mut fields = crate::obj! {};
            for (k, _) in crate::studio::PROFILE_FIELDS {
                fields.insert(k.into(), json!(""));
            }
            fields.insert("alias".into(), json!(alias));
            let (st, name) = (Arc::clone(&s.studio), p.name.clone());
            tokio::task::spawn_blocking(move || st.upsert_player(None, &name, &fields, None).map(|_| ()).map_err(|_| "could not save".to_string())).await.unwrap_or_else(|e| Err(e.to_string()))
        };
        match r {
            Ok(()) => added.push(p.name.clone()),
            Err(e) => {
                warn!("Could not give {} a club profile: {}", p.name, e);
                failed = Some(e);
            }
        }
    }
    (added, failed)
}

pub async fn end(State(s): State<S>) -> ApiResult {
    done(s.tournaments.end(), &s)
}

/// Asked by another PC on the network (see Tournaments::end_at)
pub async fn end_remote(State(s): State<S>) -> ApiResult {
    done(s.tournaments.end(), &s)
}

pub async fn end_at(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.end_at(&str_of(&b, "address")).await, &s)
}

pub async fn join(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.join(&str_of(&b, "address"), &str_of(&b, "host_name"), &str_of(&b, "tournament_name")), &s)
}

pub async fn leave(State(s): State<S>) -> ApiResult {
    done(s.tournaments.leave(), &s)
}

pub async fn approve(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.approve(&str_of(&b, "node"), crate::py::get_bool(&b, "approve", true)), &s)
}

pub async fn plays(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.set_plays(&str_of(&b, "node"), crate::py::get_bool(&b, "plays", true)), &s)
}

pub async fn result(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    let legs = b.get("legs").and_then(Value::as_array).map(|a| [crate::py::safe_int(a.first(), 0), crate::py::safe_int(a.get(1), 0)]).unwrap_or([0, 0]);
    let walkover = b.get("walkover_winner").filter(|v| !v.is_null()).map(|v| crate::py::safe_int(Some(v), 0) as usize);
    done(s.tournaments.result(&str_of(&b, "match"), legs, walkover), &s)
}

pub async fn distances(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    let n = |k: &str| crate::py::safe_int(b.get(k), 0);
    done(s.tournaments.set_distances(n("legs"), n("sets"), n("ko_legs"), n("semi_legs"), n("final_legs")), &s)
}

pub async fn withdraw(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.withdraw(&str_of(&b, "player")), &s)
}

pub async fn assign(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    let board = b.get("board").filter(|v| !v.is_null()).map(crate::py::py_str);
    let hold = b.get("hold").filter(|v| !v.is_null()).map(crate::py::truthy);
    done(s.tournaments.assign(&str_of(&b, "match"), board.as_deref(), hold), &s)
}

pub async fn claim(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.claim(&str_of(&b, "match")), &s)
}

pub async fn pick(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.pick(&str_of(&b, "match")), &s)
}

pub async fn replay(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.replay(&str_of(&b, "match")), &s)
}

pub async fn started(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.started(&str_of(&b, "match"), &str_of(&b, "ad_match")), &s)
}

/// The host is gone: this board becomes the host from its copy of the tournament
pub async fn take_over(State(s): State<S>) -> ApiResult {
    done(s.tournaments.take_over().await, &s)
}

pub async fn name(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    done(s.tournaments.set_name(&str_of(&b, "name")), &s)
}

pub async fn export(State(s): State<S>) -> ApiResult {
    match s.tournaments.export() {
        Some(v) => ok(v),
        None => Err(AppError::not_found("This PC is not hosting a tournament")),
    }
}

pub async fn import(State(s): State<S>, req: Req) -> ApiResult {
    let v: Value = serde_json::from_slice(&req.body).map_err(|_| AppError::validation("Not a tournament file"))?;
    done(s.tournaments.import(v), &s)
}

/// Boards on other PCs connect here (reachable from the LAN)
pub async fn peer_ws(State(s): State<S>, ws: WebSocketUpgrade) -> Response {
    let t = Arc::clone(&s.tournaments);
    ws.on_upgrade(move |sock| t.peer_session(sock))
}
