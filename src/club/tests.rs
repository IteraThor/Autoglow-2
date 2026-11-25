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
    let mut log = DartLog::default();
    let mut game = None;
    for f in frames() {
        bests.note(&f);
        log.note(&f);
        if let Some(g) = game_from_state(&f, &bests, &log, "Board 1", "node1", 1000) {
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
    assert!(game_from_state(&f[f.len() - 2], &LegBests::default(), &DartLog::default(), "", "", 0).is_none());
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

#[test]
fn every_dart_is_recorded_with_where_it_landed() {
    let g = recorded();
    let thor = &g.players[0].throws;
    assert_eq!(thor.len(), 9, "a 9-dart leg");
    assert!(thor.iter().all(|d| d.x.is_some() && d.y.is_some()));
    assert_eq!((thor[0].n, thor[0].m, thor[0].r, thor[0].v, thor[0].i), (20, 3, 501, 1, 0));
    assert_eq!((thor[0].x, thor[0].y), (Some(0.0), Some(0.6)));
    // The score left before each dart follows the visits; the last dart is the D12 on 24
    let last = thor.last().unwrap();
    assert_eq!((last.n, last.m, last.r, last.v, last.i), (12, 2, 24, 3, 2));
    assert!(thor.windows(2).all(|w| w[0].q < w[1].q), "in throwing order");
    assert_eq!(g.players[1].throws.len(), 6);
    assert_eq!(g.players[1].throws[0].r, 501);
    assert!(g.players.iter().all(|p| p.avg170 > 0.0));
}

#[test]
fn a_frame_seen_twice_or_a_dart_taken_back_is_kept_once() {
    let f = frames();
    let mut log = DartLog::default();
    for x in &f {
        log.note(x);
        log.note(x);
    }
    let ids: Vec<String> = f[0]["players"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
    assert_eq!(log.of(&ids[0]).len() + log.of(&ids[1]).len(), 15);
    // Take the last dart back: the visit shows two darts again
    let mut x = f.last().unwrap().clone();
    let turns = x.get_mut("turns").unwrap().as_array_mut().unwrap();
    turns[0]["throws"].as_array_mut().unwrap().pop();
    log.note(&x);
    assert_eq!(log.of(turns_player(&x).as_str().unwrap()).len(), 8);
}

fn turns_player(x: &Obj) -> Value {
    x["turns"][0]["playerId"].clone()
}

#[test]
fn games_without_darts_still_load() {
    let line = r#"{"id":"a","at":1,"players":[{"name":"HENRY","darts":12,"average":51.0}]}"#;
    let g: Game = serde_json::from_str(line).unwrap();
    assert!(g.players[0].throws.is_empty());
    assert!(!serde_json::to_string(&g).unwrap().contains("throws"), "no empty list is written");
}

// --- Coach -------------------------------------------------------------------------------------

use super::coach::{self, segment_at, target_point, AimMap};

fn dart_at(xmm: f64, ymm: f64, r: i64, l: i64, v: i64, i: i64, q: u64) -> Dart {
    let (n, m) = segment_at(xmm, ymm);
    Dart { x: Some(xmm / 170.0), y: Some(ymm / 170.0), n, m, r, l, v, i, q, b: false }
}

#[test]
fn the_board_geometry_matches_autodarts() {
    assert_eq!(segment_at(0.0, 103.0), (20, 3));
    assert_eq!(segment_at(0.0, 0.0), (25, 2));
    assert_eq!(segment_at(0.0, 10.0), (25, 1));
    assert_eq!(segment_at(0.0, 175.0), (0, 0));
    // Autodarts' own D12, S1 and T19 points
    assert_eq!(segment_at(-0.5737 * 170.0, 0.7896 * 170.0), (12, 2));
    assert_eq!(segment_at(0.2472 * 170.0, 0.7608 * 170.0), (1, 1));
    assert_eq!(segment_at(-0.1854 * 170.0, -0.5706 * 170.0), (19, 3));
    let (x, y) = target_point(19, 3);
    assert_eq!(segment_at(x, y), (19, 3));
}

#[test]
fn the_best_aim_depends_on_the_spread() {
    let tight = AimMap::new(4.0, 4.0);
    let (x, y, v) = tight.best();
    assert_eq!(segment_at(x, y), (20, 3), "a tight thrower aims at T20");
    assert!(v > 40.0);
    let wide = AimMap::new(45.0, 45.0);
    let (t20x, t20y) = target_point(20, 3);
    let (t19x, t19y) = target_point(19, 3);
    assert!(wide.at(t19x, t19y) > wide.at(t20x, t20y), "a wide thrower scores more on T19");
    let (bx, by, _) = wide.best();
    assert_ne!(segment_at(bx, by), (20, 3));
}

/// A game where THOR throws `visits` scoring visits with a fixed group shape and then checks out
fn coach_game(id: &str, at: i64, visits: usize, spread: (f64, f64), low: f64) -> Game {
    let (tx, ty) = target_point(20, 3);
    let mut throws = Vec::new();
    let offs = [(-1.0, -1.0), (1.0, 0.0), (0.0, 1.0)];
    let mut q = 0;
    let mut left = 501 + 60 * visits as i64;
    for v in 0..visits {
        for (i, o) in offs.iter().enumerate() {
            q += 1;
            let d = dart_at(tx + o.0 * spread.0, ty + o.1 * spread.1 - low, left, 101, v as i64 + 1, i as i64, q);
            left -= d.points();
            throws.push(d);
        }
    }
    let p = GamePlayer { name: "THOR".into(), member: "aaaaaaaaaaaa".into(), won: true, legs: 1, darts: throws.len() as i64, score: 300.0, average: 60.0, first9: 70.0, throws, ..Default::default() };
    let o = GamePlayer { name: "IRIS".into(), member: "bbbbbbbbbbbb".into(), legs: 0, darts: 30, score: 400.0, average: 40.0, ..Default::default() };
    Game { id: id.into(), at, variant: "X01".into(), base: 501, out_mode: "Double".into(), legs: 1, players: vec![p, o], ..Default::default() }
}

#[test]
fn spread_and_drift_come_from_the_darts() {
    let g = coach_game("1", 10, 40, (4.0, 12.0), 8.0);
    let mut a = coach::Acc::default();
    a.add_game(&g, 0);
    let (sx, sy) = a.spread().unwrap();
    assert!(sy > sx * 2.0, "up-down spread is wider: {} vs {}", sy, sx);
    let j = a.json(true);
    assert!(j["drift"]["y"].as_f64().unwrap() < -5.0, "the group sits low");
    assert_eq!(j["heat"].as_array().unwrap().len(), 120);
    assert!(j["aim"]["best"]["points"].as_f64().unwrap() > 0.0);
    // Too few visits: no spread
    let mut few = coach::Acc::default();
    few.add_game(&coach_game("2", 10, 3, (4.0, 4.0), 0.0), 0);
    assert!(few.spread().is_none());
}

#[test]
fn doubles_and_leaves_are_counted_from_the_score_left() {
    // 100 left: T20 (40 left), then D20 missed inside (S20 → 20 left), then D10 hit
    let throws = vec![
        dart_at(0.0, 103.0, 100, 101, 1, 0, 1),
        dart_at(0.0, 134.0, 40, 101, 1, 1, 2),
        { let (x, y) = target_point(10, 2); dart_at(x, y, 20, 101, 1, 2, 3) },
    ];
    let p = GamePlayer { name: "THOR".into(), member: "aaaaaaaaaaaa".into(), won: true, darts: 3, throws, ..Default::default() };
    let g = Game { id: "x".into(), at: 1, variant: "X01".into(), out_mode: "Double".into(), legs: 1, players: vec![p], ..Default::default() };
    let mut a = coach::Acc::default();
    a.add_game(&g, 0);
    let d = a.json(false);
    assert_eq!(d["doubles"]["attempts"], 2);
    assert_eq!(d["doubles"]["hits"], 1);
    let d20 = d["doubles"]["by_double"].as_array().unwrap().iter().find(|x| x["target"] == 20).unwrap().clone();
    assert_eq!((d20["attempts"].as_u64(), d20["inside"].as_u64()), (Some(1), Some(1)));
    assert_eq!(d["doubles"]["first_dart_pct"], 0.0);
    assert_eq!(coach::leg_winners(&g).get(&101), Some(&0));
    // A visit from 220 that leaves 163 is a bogey leave
    let throws = vec![dart_at(0.0, 134.0, 220, 101, 1, 0, 1), dart_at(0.0, 134.0, 200, 101, 1, 1, 2), dart_at(0.0, 150.0, 180, 101, 1, 2, 3)];
    let mut g2 = g.clone();
    g2.players[0].throws = throws.iter().map(|d| Dart { n: 19, m: 1, ..d.clone() }).collect();
    let mut a = coach::Acc::default();
    a.add_game(&g2, 0);
    assert_eq!(a.json(false)["leaves"]["bogey"], 1);
}

#[test]
fn ratings_move_points_from_loser_to_winner() {
    let m = members();
    let games: Vec<Game> = (0..6).map(|i| game_at(&i.to_string(), i, ("THOR", "aaaaaaaaaaaa", 60.0, true), ("IRIS", "bbbbbbbbbbbb", 40.0))).collect();
    let r = coach::ratings(&games, &m);
    let (thor, iris) = (r["aaaaaaaaaaaa"], r["bbbbbbbbbbbb"]);
    assert!(thor.0 > 1500.0 && iris.0 < 1500.0);
    assert!((thor.0 + iris.0 - 3000.0).abs() < 1e-6, "points are only moved");
    assert_eq!((thor.1, iris.1), (6, 6));
}

#[test]
fn the_coach_waits_for_enough_darts_before_giving_tips() {
    let m = members();
    let few = vec![coach_game("1", 10, 5, (4.0, 30.0), 10.0)];
    let c = coach::coach(&few, "aaaaaaaaaaaa", &m, 0);
    assert!(c["tips"].as_array().unwrap().iter().all(|t| t["id"] != "vertical"));
    // Many visits with a tall, low group: the vertical tip shows, with the real numbers
    let many: Vec<Game> = (0..4).map(|i| coach_game(&i.to_string(), 10 + i, 30, (4.0, 14.0), 9.0)).collect();
    let c = coach::coach(&many, "aaaaaaaaaaaa", &m, 0);
    let tip = c["tips"].as_array().unwrap().iter().find(|t| t["id"] == "vertical").cloned().expect("a vertical tip");
    assert!(tip["text"].as_str().unwrap().contains("low"));
    assert_eq!(tip["drill"], "grouping");
    assert!(c["trend"]["points"].as_array().unwrap().len() >= 1);
    assert!(c["records"]["bests"].as_array().unwrap().iter().any(|b| b["key"] == "average"));
}

#[test]
fn a_game_report_has_every_leg() {
    let g = recorded();
    let r = coach::game_report(&g, &members());
    assert_eq!(r["legs"].as_array().unwrap().len(), 1);
    assert_eq!(r["legs"][0]["winner"], 0);
    assert_eq!(r["legs"][0]["players"][0]["darts"], 9);
    assert_eq!(r["legs"][0]["players"][0]["finish"], 141);
    assert_eq!(r["players"][0]["heat"].as_array().unwrap().len(), 9);
}

#[test]
fn darts_stay_with_their_player_when_autodarts_sends_the_players_in_another_order() {
    let f = frames();
    let mut log = DartLog::default();
    for (i, x) in f.iter().enumerate() {
        let mut x = x.clone();
        if i % 2 == 1 {
            x.get_mut("players").unwrap().as_array_mut().unwrap().reverse();
            if let Some(Value::Array(gs)) = x.get_mut("gameScores") {
                gs.reverse();
            }
        }
        log.note(&x);
    }
    let thor = f[0]["players"].as_array().unwrap().iter().find(|p| p["name"] == "THOR").unwrap()["id"].as_str().unwrap().to_string();
    let darts = log.of(&thor);
    assert_eq!(darts.len(), 9);
    assert_eq!(darts[0].r, 501);
}

#[test]
fn best_checkout_and_best_leg_come_from_the_darts() {
    let d = |l, v, i, r, n, m| Dart { n, m, r, l, v, i, ..Default::default() };
    let darts = vec![
        // leg 1: 54 left, S14 then D20 out in 2 darts of visit 9 (26 darts in all)
        d(101, 9, 0, 54, 14, 1),
        d(101, 9, 1, 40, 20, 2),
        // leg 2: busted on 32, then D16 out
        d(102, 7, 0, 32, 20, 1),
        d(102, 8, 0, 32, 16, 2),
    ];
    let (finish, fewest) = leg_bests_from(&darts);
    assert_eq!(finish, 54);
    assert_eq!(fewest, 2);
    assert_eq!(leg_bests_from(&[]), (0, 0));
}

#[test]
fn legs_won_and_lost_add_up_overall_and_per_opponent() {
    let m = members();
    let mut a = game_at("1", 10, ("THOR", "aaaaaaaaaaaa", 60.0, true), ("IRIS", "bbbbbbbbbbbb", 40.0));
    (a.players[0].legs, a.players[1].legs) = (3, 2);
    let mut b = game_at("2", 20, ("THOR", "aaaaaaaaaaaa", 50.0, false), ("IRIS", "bbbbbbbbbbbb", 55.0));
    (b.players[0].legs, b.players[1].legs) = (1, 3);
    // A set match: Autodarts' legs are the current set's only, so they don't count
    let mut c = game_at("3", 30, ("THOR", "aaaaaaaaaaaa", 50.0, true), ("IRIS", "bbbbbbbbbbbb", 55.0));
    c.sets = 3;
    let s = member_stats(&[a, b, c], "aaaaaaaaaaaa", &m, 0);
    let t = &s["totals"];
    assert_eq!((t["legs_won"].as_i64(), t["legs_lost"].as_i64(), t["legs"].as_i64()), (Some(4), Some(5), Some(9)));
    let iris = &s["head_to_head"][0];
    assert_eq!((iris["games"].as_u64(), iris["wins"].as_u64(), iris["losses"].as_u64()), (Some(3), Some(2), Some(1)));
    assert_eq!((iris["legs_won"].as_i64(), iris["legs_lost"].as_i64()), (Some(4), Some(5)));
}
