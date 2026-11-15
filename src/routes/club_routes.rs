//! /api/club/*: the club roster's stats, the unassigned names and this PC's club role. On a board,
//! the stat views come from the club PC; /api/club/roster and /api/club/games are what the club PC
//! answers its boards.

use super::*;

fn str_of(b: &crate::py::Obj, k: &str) -> String {
    b.get(k).map(crate::py::py_str).unwrap_or_default()
}

fn done(r: Result<(), String>, s: &S) -> ApiResult {
    r.map_err(AppError::validation)?;
    ok(s.club.state())
}

/// On a board, a change goes to the club PC (and the roster is copied back); else it's made here
async fn change(s: &S, path: &str, req: Req, here: impl FnOnce(&crate::py::Obj) -> Result<(), String>) -> ApiResult {
    if s.club.is_board() {
        s.club.forward("POST", format!("/api/club/{}", path), "application/json".into(), req.body.to_vec()).await.map_err(AppError::validation)?;
        return ok(s.club.state());
    }
    done(here(&req.json()?), s)
}

/// Ask the club PC on a board, else answer here
async fn view(s: &S, path: String, here: impl FnOnce() -> Result<Value, String>) -> ApiResult {
    let r = if s.club.is_board() { s.club.remote_get(path).await } else { here() };
    r.map(ok).map_err(AppError::validation)?
}

pub async fn state(State(s): State<S>) -> ApiResult {
    ok(s.club.state())
}

pub async fn members(State(s): State<S>) -> ApiResult {
    ok(s.club.members())
}

pub async fn member(State(s): State<S>, req: Req) -> ApiResult {
    let id = req.q_or("id", "").to_string();
    let period = req.q_or("period", "all").to_string();
    let club = Arc::clone(&s.club);
    view(&s, format!("member?id={}&period={}", id, period), move || club.member(&id, &period)).await
}

pub async fn leaderboards(State(s): State<S>, req: Req) -> ApiResult {
    let period = req.q_or("period", "season").to_string();
    let club = Arc::clone(&s.club);
    view(&s, format!("leaderboards?period={}", period), move || Ok(club.leaderboards(&period))).await
}

pub async fn unassigned(State(s): State<S>) -> ApiResult {
    let club = Arc::clone(&s.club);
    view(&s, "unassigned".into(), move || Ok(club.unassigned())).await
}

pub async fn assign(State(s): State<S>, req: Req) -> ApiResult {
    let club = Arc::clone(&s.club);
    change(&s, "assign", req, |b| club.assign(&str_of(b, "name"), &str_of(b, "member"), crate::py::get_bool(b, "remember", true))).await
}

pub async fn ignore(State(s): State<S>, req: Req) -> ApiResult {
    let club = Arc::clone(&s.club);
    change(&s, "ignore", req, |b| club.ignore(&str_of(b, "name"), crate::py::get_bool(b, "ignore", true))).await
}

pub async fn forget_name(State(s): State<S>, req: Req) -> ApiResult {
    let club = Arc::clone(&s.club);
    change(&s, "forget-name", req, |b| club.forget_name(&str_of(b, "name"))).await
}

pub async fn role(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    let role = str_of(&b, "role");
    if role == "club" && s.club.state()["role"] != "club" {
        // One club PC per network
        if let Some(other) = s.club.other_club().await {
            return Err(AppError::validation(format!("{} is already the club host. To make this PC the host, hand the club over from there.", crate::py::py_str(&other["name"]))));
        }
    }
    done(s.club.set_role(&role, &str_of(&b, "address"), &str_of(&b, "club_name"), &str_of(&b, "club_node")), &s)
}

/// Alone: don't offer this club PC again
pub async fn decline(State(s): State<S>, req: Req) -> ApiResult {
    s.club.decline(&str_of(&req.json()?, "node"));
    ok(s.club.state())
}

/// Club PC: make another PC the club PC; this one becomes its board
pub async fn handover(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    let club = Arc::clone(&s.club);
    let r = tokio::task::spawn_blocking(move || club.hand_over(&str_of(&b, "address"), &str_of(&b, "node"), &str_of(&b, "name"))).await.map_err(|e| AppError::validation(e.to_string()))?;
    done(r, &s)
}

/// The club PC hands the club over to this PC
pub async fn takeover(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    let aliases = serde_json::from_value(b.get("aliases").cloned().unwrap_or_default()).unwrap_or_default();
    let ignored = serde_json::from_value(b.get("ignored").cloned().unwrap_or_default()).unwrap_or_default();
    let club = Arc::clone(&s.club);
    let r = tokio::task::spawn_blocking(move || club.take_over(&str_of(&b, "from"), aliases, ignored)).await.map_err(|e| AppError::validation(e.to_string()))?;
    done(r, &s)
}

/// The club PC says the roster changed
pub async fn nudge(State(s): State<S>) -> ApiResult {
    s.club.nudged();
    ok(json!({"ok": true}))
}

/// Other AutoGlows on the network, club PCs first
pub async fn discover(State(s): State<S>) -> ApiResult {
    let mut found = s.club.discover().await;
    found.sort_by_key(|v| !v["club"].as_bool().unwrap_or(false));
    ok(json!({"found": found}))
}

/// Every AutoGlow PC on the network, offline ones too; `scan=1` searches first
pub async fn network(State(s): State<S>, req: Req) -> ApiResult {
    if req.q("scan") == Some("1") {
        s.club.discover().await;
    }
    ok(s.club.network())
}

/// Rename this PC (another PC asks; the name shows in every PC's list and the tournaments)
pub async fn name(State(s): State<S>, req: Req) -> ApiResult {
    s.tournaments.set_name(&str_of(&req.json()?, "name")).map_err(AppError::validation)?;
    ok(s.club.network())
}

/// Rename another PC on the network
pub async fn rename_pc(State(s): State<S>, req: Req) -> ApiResult {
    let b = req.json()?;
    let club = Arc::clone(&s.club);
    let r = tokio::task::spawn_blocking(move || club.rename_pc(&str_of(&b, "node"), &str_of(&b, "name"))).await.map_err(|e| AppError::validation(e.to_string()))?;
    r.map_err(AppError::validation)?;
    ok(s.club.network())
}

pub async fn forget_pc(State(s): State<S>, req: Req) -> ApiResult {
    s.club.forget_pc(&str_of(&req.json()?, "node"));
    ok(s.club.network())
}

pub async fn export(State(s): State<S>) -> ApiResult {
    ok(s.club.export())
}

/// The club PC's roster, names and stat summaries, for its boards
pub async fn roster(State(s): State<S>, req: Req) -> ApiResult {
    let ip = req.remote.map(|r| r.ip().to_string()).unwrap_or_default();
    ok(s.club.answer_board(&req.query, ip))
}

/// Games sent by a board
pub async fn games(State(s): State<S>, req: Req) -> ApiResult {
    if s.club.is_board() {
        return Err(AppError::validation("This PC is a club client, not the club host"));
    }
    let games = crate::club::games_from(&req.json()?);
    ok(json!({"saved": s.club.receive(games)}))
}
