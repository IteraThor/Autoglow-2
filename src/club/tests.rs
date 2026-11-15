use super::stats::*;
use super::*;
use crate::py::Obj;
use serde_json::{json, Value};

/// The match states of a real recorded Autodarts game (THOR beats iterathor, 9-dart 501 leg)
fn frames() -> Vec<Obj> {
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pdc_bull_off_match_2026-11-02.json")).unwrap();
    let all: Vec<Value> = serde_json::from_str(&text).unwrap();
    all.into_iter()
        .filter(|f| f["topic"].as_str().unwrap_or("").ends_with(".state"))
        .filter_map(|f| f["data"].as_object().cloned())
        .filter(|d| d.contains_key("players"))
        .collect()
}

fn recorded() -> Game {
    let mut bests = LegBests::default();
    let mut game = None;
    for f in frames() {
        bests.note(&f);
        if let Some(g) = game_from_state(&f, &bests, "Board 1", "node1", 1000) {
            game = Some(g);
        }
    }
    game.expect("the last frame is a finished match")
}

fn roster() -> Vec<Value> {
    vec![json!({"id": "aaaaaaaaaaaa", "name": "Thor", "alias": ""}), json!({"id": "bbbbbbbbbbbb", "name": "Iris", "alias": "iterathor"})]
}

fn members() -> BTreeMap<String, String> {
    members_of(&roster())
}

#[test]
fn a_real_finished_match_becomes_a_game() {
    let g = recorded();
    assert_eq!(g.variant, "X01");
    assert_eq!((g.base, g.in_mode.as_str(), g.out_mode.as_str(), g.legs), (501, "Straight", "Double", 1));
    let thor = &g.players[0];
    assert_eq!(thor.name, "THOR");
    assert!(thor.won && !g.players[1].won);
    assert_eq!((thor.legs, thor.darts, thor.t180, thor.t140), (1, 9, 2, 1));
    assert_eq!(thor.average, 167.0);
    assert_eq!((thor.best_checkout, thor.best_leg), (141, 9));
    assert_eq!((g.players[1].best_checkout, g.players[1].best_leg), (0, 0));
    assert!(!g.players.iter().any(|p| p.bot));
}

#[test]
fn unfinished_states_are_not_games() {
    let f = frames();
    assert!(game_from_state(&f[f.len() - 2], &LegBests::default(), "", "", 0).is_none());
}

#[test]
fn players_are_recognised_by_name_and_autodarts_name() {
    let mut g = recorded();
    recognise(&mut g, &roster(), &BTreeMap::new());
    assert_eq!(g.players[0].member, "aaaaaaaaaaaa");
    assert_eq!(g.players[1].member, "bbbbbbbbbbbb");
    // A name given to a member from the unassigned list wins over the Studio match
    let aliases = BTreeMap::from([("THOR".to_string(), "bbbbbbbbbbbb".to_string())]);
    let mut g = recorded();
    g.players.truncate(1);
    recognise(&mut g, &roster(), &aliases);
    assert_eq!(g.players[0].member, "bbbbbbbbbbbb");
}

fn game_at(id: &str, at: i64, a: (&str, &str, f64, bool), b: (&str, &str, f64)) -> Game {
    let p = |name: &str, member: &str, avg: f64, won: bool| GamePlayer {
        name: name.into(),
        member: member.into(),
        won,
        legs: won as i64,
        score: avg * 10.0,
        darts: 30,
        average: avg,
        first9: avg + 5.0,
        checkouts: 4,
        checkouts_hit: won as i64,
        ..Default::default()
    };
    Game { id: id.into(), at, board: "Board 1".into(), variant: "X01".into(), base: 501, legs: 1, players: vec![p(a.0, a.1, a.2, a.3), p(b.0, b.1, b.2, !a.3)], ..Default::default() }
}

#[test]
fn stats_are_weighted_by_darts_and_count_head_to_head() {
    let m = members();
    let games = vec![
        game_at("1", 10, ("THOR", "aaaaaaaaaaaa", 60.0, true), ("IRIS", "bbbbbbbbbbbb", 40.0)),
        game_at("2", 20, ("THOR", "aaaaaaaaaaaa", 30.0, false), ("SASCHA", "", 50.0)),
    ];
    let s = member_stats(&games, "aaaaaaaaaaaa", &m, 0);
    assert_eq!(s["totals"]["games"], 2);
    assert_eq!(s["totals"]["wins"], 1);
    assert_eq!(s["totals"]["average"], 45.0);
    assert_eq!(s["totals"]["checkout_pct"], 12.5);
    assert_eq!(s["recent"][0]["id"], "2", "newest first");
    assert_eq!(s["form"][0]["average"], 60.0, "oldest first");
    let h2h = s["head_to_head"].as_array().unwrap();
    assert!(h2h.iter().any(|h| h["name"] == "Iris" && h["wins"] == 1));
    assert!(h2h.iter().any(|h| h["name"] == "SASCHA" && h["wins"] == 0));
    // A period leaves older games out
    assert_eq!(member_stats(&games, "aaaaaaaaaaaa", &m, 15)["totals"]["games"], 1);
}

#[test]
fn bot_games_are_listed_but_not_counted() {
    let mut g = game_at("1", 10, ("THOR", "aaaaaaaaaaaa", 60.0, true), ("BOT", "", 40.0));
    g.players[1].bot = true;
    let s = member_stats(&[g.clone()], "aaaaaaaaaaaa", &members(), 0);
    assert_eq!(s["totals"]["games"], 0);
    assert_eq!(s["recent"][0]["bot"], true);
    assert!(unassigned(&[g], &members(), &[]).is_empty(), "bots are never unassigned");
}

#[test]
fn leaderboards_need_enough_games_for_averages() {
    let m = members();
    let mut games: Vec<Game> = (0..MIN_GAMES as i64).map(|i| game_at(&i.to_string(), i, ("THOR", "aaaaaaaaaaaa", 50.0, true), ("IRIS", "bbbbbbbbbbbb", 70.0))).collect();
    games[0].players[1].best_leg = 15;
    games[1].players[0].best_leg = 12;
    let lb = leaderboards(&games, &m, 0);
    assert_eq!(lb["average"][0]["name"], "Iris");
    assert_eq!(lb["best_leg"][0]["name"], "Thor", "fewest darts first");
    let lb = leaderboards(&games[..1], &m, 0);
    assert!(lb["average"].as_array().unwrap().is_empty());
    assert_eq!(lb["games"].as_array().unwrap().len(), 2);
    // The players table still gets everyone who played, with their totals
    let rows = lb["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let iris = rows.iter().find(|r| r["name"] == "Iris").unwrap();
    assert_eq!((iris["member"].as_str(), iris["games"].as_u64()), (Some("bbbbbbbbbbbb"), Some(1)));
}

#[test]
fn unassigned_names_skip_members_and_ignored() {
    let games = vec![
        game_at("1", 10, ("THOR", "aaaaaaaaaaaa", 60.0, true), ("SASCHA K", "", 40.0)),
        game_at("2", 20, ("GUEST", "", 60.0, true), ("SASCHA K", "", 40.0)),
    ];
    let u = unassigned(&games, &members(), &["GUEST".into()]);
    assert_eq!(u.len(), 1);
    assert_eq!((u[0]["name"].as_str(), u[0]["games"].as_u64()), (Some("SASCHA K"), Some(2)));
    // A deleted member's games come back as unassigned
    let mut m = members();
    m.remove("aaaaaaaaaaaa");
    assert!(unassigned(&games, &m, &[]).iter().any(|x| x["name"] == "THOR"));
}

#[test]
fn games_survive_a_round_trip_through_json() {
    let g = recorded();
    let back: Game = serde_json::from_str(&serde_json::to_string(&g).unwrap()).unwrap();
    assert_eq!(g, back);
}

#[test]
fn saved_text_names_members_and_strangers() {
    let g = game_at("1", 10, ("THOR", "aaaaaaaaaaaa", 60.0, true), ("SASCHA K", "", 40.0));
    assert_eq!(saved_text(&g, &members()), "Saved to Thor's stats. SASCHA K is not a member yet");
}
