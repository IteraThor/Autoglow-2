//! A made-up tournament for the Dashboard page: the TV preview can show it while no real tournament
//! is running, so a change to the layout or look can be judged. Nothing is stored; it is built on
//! every request, with a real bracket from the engine and part of it played.

use super::engine::{self, Board, MatchResult, Player, Spec};
use serde_json::{json, Value};

const NAMES: [&str; 8] = ["Odin Borson", "Freya Njordsdottir", "Heimdall", "Sif Golden-Hair", "Tyr One-Hand", "Hela Lokisdottir", "Thor Odinson", "Loki Laufeyson"];
const BOARDS: usize = 3;

/// format: single_ko, double_ko, groups, league or swiss. state: "running" (about half played,
/// boards busy) or "finished" (everything played)
pub fn view(format: &str, state: &str) -> Value {
    let format = if engine::FORMATS.contains(&format) { format } else { "single_ko" };
    let finished = state == "finished";
    // A league of 8 is 28 matches; six players keep it readable
    let n = if format == "league" { 6 } else { NAMES.len() };
    let spec = Spec {
        name: "Club Championship".into(),
        format: format.into(),
        players: NAMES.iter().take(n).map(|name| Player { name: (*name).into(), ..Default::default() }).collect(),
        groups: if format == "groups" { 2 } else { 0 },
        advance: 2,
        ..Default::default()
    };
    let now = crate::led_thread::wall();
    let mut t = engine::create(&spec, "demo", now).expect("the demo spec is valid");
    t.boards = (1..=BOARDS)
        .map(|i| Board { node_id: format!("demo-board-{}", i), name: format!("Board {}", i), number: i as i64, approved: true, plays: true, online: true, ..Default::default() })
        .collect();

    let total = t.matches.iter().filter(|m| m.state != "skipped" && !m.sides.iter().any(|s| s.bye)).count();
    let target = if finished { total } else { (total / 2).max(1) };
    let mut played = 0;
    let mut seed = 7u64;
    let mut rnd = |m: u64| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (seed >> 33) % m
    };
    loop {
        engine::schedule_at(&mut t, now);
        let ready: Vec<String> = t.matches.iter().filter(|m| m.state == "assigned").map(|m| m.id.clone()).collect();
        if ready.is_empty() || (played >= target && !finished) {
            break;
        }
        for id in ready {
            if played >= target && !finished {
                break;
            }
            let m = t.get(&id).expect("scheduled match").clone();
            let seed_of = |i: usize| m.sides[i].player.as_ref().and_then(|p| t.player(p)).map_or(0, |p| p.seed);
            // The better seed wins most of the time
            let winner = if (seed_of(0) < seed_of(1)) == (rnd(10) < 7) { 0 } else { 1 };
            let to_win = t.settings_for(&m).legs.max(2);
            let lost = rnd(to_win as u64) as i64;
            let mut legs = [0, 0];
            legs[winner] = to_win;
            legs[1 - winner] = lost;
            let a0 = 52.0 + rnd(380) as f64 / 10.0 + if winner == 0 { 6.0 } else { 0.0 };
            let a1 = 52.0 + rnd(380) as f64 / 10.0 + if winner == 1 { 6.0 } else { 0.0 };
            let stats = json!({"average": [(a0 * 10.0).round() / 10.0, (a1 * 10.0).round() / 10.0], "180s": [rnd(3), rnd(3)]});
            if engine::set_result(&mut t, &id, MatchResult { legs, winner, stats, ..Default::default() }).is_ok() {
                played += 1;
            }
        }
    }
    t.status = if finished { "finished".into() } else { "running".into() };

    // The first boards are in a game, the rest wait for their players
    let mut live: Vec<(String, [i64; 2])> = Vec::new();
    for (k, m) in t.matches.iter_mut().filter(|m| m.state == "assigned").enumerate() {
        if k < 2 {
            m.state = "live".into();
            m.live_at = now - 240.0;
            live.push((m.id.clone(), if k == 0 { [1, 0] } else { [0, 1] }));
        }
    }

    let mut v = engine::view(&t);
    if let Some(ms) = v.get_mut("matches").and_then(Value::as_array_mut) {
        for m in ms.iter_mut() {
            if let Some((_, legs)) = live.iter().find(|(id, _)| m["id"] == json!(id)) {
                let k = live.iter().position(|(id, _)| m["id"] == json!(id)).unwrap_or(0);
                m["last_live"] = json!({"legs": legs, "sets": [0, 0], "remaining": [if k == 0 { 141 } else { 268 }, if k == 0 { 96 } else { 170 }], "active": k});
            }
        }
    }
    json!({"role": "demo", "node": {"id": "demo", "name": "Demo"}, "tournament": v, "join": null, "board": {}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_format_builds_running_and_finished() {
        for f in engine::FORMATS {
            let r = view(f, "running");
            let ms = r["tournament"]["matches"].as_array().unwrap();
            assert!(ms.iter().any(|m| m["state"] == "done"), "{f}: some played");
            assert!(ms.iter().any(|m| m["state"] == "live"), "{f}: some live");
            let d = view(f, "finished");
            assert_eq!(d["tournament"]["status"], "finished");
            assert!(d["tournament"]["champion"].is_string(), "{f}: champion");
        }
    }
}
