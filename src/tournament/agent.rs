//! What a board reads from Autodarts for its tournament match: the checklist against the open
//! lobby, whether a started match is the assigned one, its live score and its result.

use super::engine::{GameSettings, MatchResult};
use crate::py::{py_str, Obj};
use serde_json::{json, Value};

pub fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

/// A player's name in a lobby or match (account players by their account name)
fn player_name(p: &Value) -> String {
    let n = p.get("name").map(py_str).unwrap_or_default();
    if !n.trim().is_empty() {
        return n;
    }
    p.get("user").and_then(|u| u.get("name")).map(py_str).unwrap_or_default()
}

pub fn names_of(state: &Obj) -> Vec<String> {
    state.get("players").and_then(Value::as_array).map(|ps| ps.iter().map(player_name).collect()).unwrap_or_default()
}

/// The assigned players as (name, Autodarts name)
fn wanted(assign: &Value) -> Vec<(String, String)> {
    assign["players"]
        .as_array()
        .map(|ps| ps.iter().map(|p| (p["name"].as_str().unwrap_or("").to_string(), p["ad_name"].as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default()
}

/// Which side of the assigned match a name belongs to
pub fn side_of(assign: &Value, name: &str) -> Option<usize> {
    let n = norm(name);
    wanted(assign).iter().position(|(a, b)| norm(a) == n || norm(b) == n)
}

/// The match has exactly the assigned players, in any order
pub fn names_match(assign: &Value, names: &[String]) -> bool {
    if names.len() != 2 {
        return false;
    }
    let a = side_of(assign, &names[0]);
    let b = side_of(assign, &names[1]);
    matches!((a, b), (Some(x), Some(y)) if x != y)
}

fn settings_of(assign: &Value) -> GameSettings {
    serde_json::from_value(assign["settings"].clone()).unwrap_or_default()
}

fn s(v: Option<&Value>) -> String {
    v.map(py_str).unwrap_or_default()
}

/// One line per thing to set up in Autodarts: what it should be, what the lobby has, ok or not
pub fn checklist(assign: &Value, lobby: Option<&Obj>) -> (Value, bool) {
    let want = settings_of(assign);
    let empty = Obj::new();
    let l = lobby.unwrap_or(&empty);
    let settings = l.get("settings").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut items = Vec::new();
    let mut add = |key: &str, label: &str, want: String, got: String, ok: bool| {
        items.push(json!({"key": key, "label": label, "want": want, "got": got, "ok": ok && lobby.is_some()}));
    };
    let variant = s(l.get("variant"));
    add("game", "Game", "X01".into(), variant.clone(), variant.eq_ignore_ascii_case("x01"));
    let base = s(settings.get("baseScore"));
    add("base", "Base score", want.base_score.to_string(), base.clone(), base == want.base_score.to_string());
    let (i, o) = (s(settings.get("inMode")), s(settings.get("outMode")));
    add(
        "inout",
        "In / Out",
        format!("{} in · {} out", want.in_mode, want.out_mode),
        if i.is_empty() { String::new() } else { format!("{} in · {} out", i, o) },
        i.eq_ignore_ascii_case(&want.in_mode) && o.eq_ignore_ascii_case(&want.out_mode),
    );
    let legs = s(l.get("legs"));
    add("legs", "Legs", format!("{} (first to {})", want.legs, want.legs), legs.clone(), legs == want.legs.to_string());
    // Autodarts only sends "sets" in sets mode (then "legs" is per set)
    let sets = s(l.get("sets"));
    if want.sets > 0 {
        add("sets", "Sets", format!("{} (first to {})", want.sets, want.sets), sets.clone(), sets == want.sets.to_string());
    } else if !sets.is_empty() {
        add("sets", "Sets", "off (match mode Legs)".into(), sets, false);
    }
    let bull = s(l.get("bullOffMode"));
    add("bull", "Bull-off", bull_label(&want.bull_off), bull_label(&bull), bull.eq_ignore_ascii_case(&want.bull_off));
    let names = names_of(l);
    let want_names: Vec<String> = wanted(assign).iter().map(|(n, a)| if a.is_empty() { n.to_uppercase() } else { a.clone() }).collect();
    add("players", "Players", format!("{} (any order)", want_names.join(", ")), names.join(", "), names_match(assign, &names));
    let ok = items.iter().all(|i| i["ok"] == json!(true));
    (json!(items), ok)
}

fn num(v: Option<&Value>) -> i64 {
    v.and_then(Value::as_f64).map(|f| f as i64).unwrap_or(0)
}

/// Position in the players list of the match winner. Autodarts' "winner" is the player's index
/// field; "gameWinner" is the list position.
pub fn winner_pos(state: &Obj) -> Option<usize> {
    let players = state.get("players")?.as_array()?;
    if let Some(w) = state.get("winner").and_then(Value::as_i64).filter(|w| *w >= 0) {
        if let Some(p) = players.iter().position(|p| p.get("index").and_then(Value::as_i64) == Some(w)) {
            return Some(p);
        }
        return Some(w as usize);
    }
    state.get("gameWinner").and_then(Value::as_i64).filter(|w| *w >= 0).map(|w| w as usize)
}

/// Legs (sets when the match uses them) per side of the assigned match
fn score_by_side(assign: &Value, state: &Obj, sets: bool) -> [i64; 2] {
    let names = names_of(state);
    let scores = state.get("scores").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut out = [0, 0];
    for (pos, n) in names.iter().enumerate() {
        if let Some(side) = side_of(assign, n) {
            out[side] = num(scores.get(pos).and_then(|s| s.get(if sets { "sets" } else { "legs" })));
        }
    }
    out
}

/// The result of a finished match, sides in the tournament's order
pub fn result_of(assign: &Value, state: &Obj, ad_match: &str) -> Option<MatchResult> {
    let sets = settings_of(assign).sets > 0;
    let names = names_of(state);
    let legs = score_by_side(assign, state, sets);
    let winner = winner_pos(state).and_then(|p| names.get(p)).and_then(|n| side_of(assign, n)).unwrap_or(if legs[0] >= legs[1] { 0 } else { 1 });
    let mut legs = legs;
    if legs[winner] <= legs[1 - winner] {
        // Autodarts sometimes reports the deciding leg only in the next frame
        legs[winner] = legs[1 - winner] + 1;
    }
    let stats = state.get("stats").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut avg = [Value::Null, Value::Null];
    let mut t180 = [0, 0];
    for (pos, n) in names.iter().enumerate() {
        if let Some(side) = side_of(assign, n) {
            let ms = stats.get(pos).and_then(|s| s.get("matchStats"));
            avg[side] = ms.and_then(|m| m.get("average")).cloned().unwrap_or(Value::Null);
            t180[side] = num(ms.and_then(|m| m.get("total180")));
        }
    }
    Some(MatchResult { legs, winner, walkover: false, ad_match: Some(ad_match.into()), stats: json!({"average": avg, "180s": t180}) })
}

/// Live score by side: legs, sets, points left, whose turn
pub fn live_of(assign: &Value, state: &Obj) -> Value {
    let names = names_of(state);
    let rem = state.get("gameScores").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut remaining = [Value::Null, Value::Null];
    let mut active = Value::Null;
    let turn = state.get("player").and_then(Value::as_i64);
    for (pos, n) in names.iter().enumerate() {
        if let Some(side) = side_of(assign, n) {
            remaining[side] = rem.get(pos).cloned().unwrap_or(Value::Null);
            if turn == Some(pos as i64) {
                active = json!(side);
            }
        }
    }
    json!({"legs": score_by_side(assign, state, false), "sets": score_by_side(assign, state, true), "remaining": remaining, "active": active})
}

/// Autodarts stores "Normal" / "Official" but its menu says WDF / PDC
fn bull_label(mode: &str) -> String {
    match mode {
        "Normal" => "WDF".into(),
        "Official" => "PDC".into(),
        m => m.into(),
    }
}
