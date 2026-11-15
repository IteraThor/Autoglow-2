use super::agent;
use super::engine::*;
use serde_json::{json, Value};
use std::collections::HashSet;

fn spec(format: &str, n: usize) -> Spec {
    Spec {
        name: "Test Cup".into(),
        format: format.into(),
        players: (0..n).map(|i| Player { name: format!("Player {}", i + 1), ..Default::default() }).collect(),
        advance: 2,
        ..Default::default()
    }
}

fn with_boards(t: &mut Tournament, n: usize) {
    for i in 0..n {
        t.boards.push(Board { node_id: format!("B{}", i + 1), name: format!("Board {}", i + 1), number: i as i64 + 1, approved: true, plays: true, online: true, left: false, offline_since: 0.0, ..Default::default() });
    }
}

/// Play a whole tournament on `boards` boards; the better seed wins unless `upsets`
fn play_out(t: &mut Tournament, boards: usize, upsets: bool) -> usize {
    with_boards(t, boards);
    let mut played = 0;
    for _ in 0..500 {
        schedule(t);
        let mut seen = HashSet::new();
        for m in t.matches.iter().filter(|m| m.state == "assigned" || m.state == "live") {
            for s in &m.sides {
                let p = s.player.clone().expect("assigned match has both players");
                assert!(seen.insert(p), "a player is on two boards at once");
            }
        }
        let next: Vec<(String, usize)> = t
            .matches
            .iter()
            .filter(|m| m.state == "assigned")
            .map(|m| {
                let seed = |i: usize| t.player(m.sides[i].player.as_ref().unwrap()).unwrap().seed;
                let better = if seed(0) < seed(1) { 0 } else { 1 };
                (m.id.clone(), if upsets && m.order % 3 == 0 { 1 - better } else { better })
            })
            .collect();
        if next.is_empty() {
            break;
        }
        for (id, w) in next {
            let mut legs = [1, 1];
            legs[w] = 2;
            set_result(t, &id, MatchResult { legs, winner: w, ..Default::default() }).unwrap();
            played += 1;
        }
    }
    played
}

#[test]
fn every_format_and_size_plays_to_a_champion() {
    for format in FORMATS {
        for n in [2, 3, 5, 8, 13, 16, 17, 32] {
            if (format == "groups" && n < 4) || (format == "league" && n > MAX_LEAGUE) {
                continue;
            }
            for upsets in [false, true] {
                let mut t = create(&spec(format, n), "t", 0.0).unwrap_or_else(|e| panic!("{} {}: {}", format, n, e));
                let played = play_out(&mut t, 3, upsets);
                assert_eq!(t.status, "finished", "{} with {} players did not finish", format, n);
                assert!(champion(&t).is_some(), "{} with {} players has no champion", format, n);
                match format {
                    "single_ko" => assert_eq!(played, n - 1),
                    "double_ko" => assert!(played == 2 * n - 2 || played == 2 * n - 1, "double KO {} players played {}", n, played),
                    "league" => assert_eq!(played, n * (n - 1) / 2),
                    _ => {}
                }
            }
        }
    }
}

#[test]
fn top_seed_wins_without_upsets() {
    for format in ["single_ko", "double_ko"] {
        let mut t = create(&spec(format, 13), "t", 0.0).unwrap();
        play_out(&mut t, 2, false);
        assert_eq!(champion(&t).as_deref(), Some("P1"), "{}", format);
    }
}

#[test]
fn byes_go_to_the_top_seeds() {
    let t = create(&spec("single_ko", 5), "t", 0.0).unwrap();
    // 5 players in a bracket of 8: seeds 1 to 3 get a bye, 4 plays 5
    let mut byes: Vec<String> = t.matches.iter().filter(|m| m.round == 1 && m.sides.iter().any(|s| s.bye)).filter_map(|m| m.sides.iter().find_map(|s| s.player.clone())).collect();
    byes.sort();
    assert_eq!(byes, vec!["P1", "P2", "P3"]);
}

#[test]
fn a_single_group_of_32_is_refused() {
    let mut s = spec("groups", 32);
    s.groups = 1;
    assert!(create(&s, "t", 0.0).is_err());
}

#[test]
fn groups_cross_over_into_the_knockout() {
    let mut s = spec("groups", 8);
    s.groups = 2;
    let t = create(&s, "t", 0.0).unwrap();
    let first: Vec<Value> = t.matches.iter().filter(|m| m.stage == "ko" && m.round == 1).map(|m| json!([m.sides[0].from, m.sides[1].from])).collect();
    assert_eq!(first, vec![json!(["G:A:1", "G:B:2"]), json!(["G:B:1", "G:A:2"])]);
}

#[test]
fn swiss_never_repeats_a_pairing_when_avoidable() {
    let mut t = create(&spec("swiss", 8), "t", 0.0).unwrap();
    play_out(&mut t, 4, true);
    let mut pairs = HashSet::new();
    for m in t.matches.iter().filter(|m| m.stage == "swiss") {
        if let (Some(a), Some(b)) = (&m.sides[0].player, &m.sides[1].player) {
            let key = if a < b { (a.clone(), b.clone()) } else { (b.clone(), a.clone()) };
            assert!(pairs.insert(key), "rematch in Swiss");
        }
    }
    assert_eq!(t.matches.iter().map(|m| m.round).max(), Some(3));
}

#[test]
fn corrections_only_while_later_matches_have_not_started() {
    let mut t = create(&spec("single_ko", 4), "t", 0.0).unwrap();
    with_boards(&mut t, 2);
    schedule(&mut t);
    let r1: Vec<String> = t.matches.iter().filter(|m| m.round == 1).map(|m| m.id.clone()).collect();
    for id in &r1 {
        set_result(&mut t, id, MatchResult { legs: [2, 0], winner: 0, ..Default::default() }).unwrap();
    }
    // Final not started: correcting a semi-final changes who is in it
    set_result(&mut t, &r1[0], MatchResult { legs: [1, 2], winner: 1, ..Default::default() }).unwrap();
    let fin = t.matches.iter().find(|m| m.round == 2).unwrap().clone();
    assert_eq!(fin.sides[0].player, t.get(&r1[0]).unwrap().sides[1].player);
    // Final played: the semi-final can't change any more
    let fid = fin.id.clone();
    schedule(&mut t);
    set_result(&mut t, &fid, MatchResult { legs: [2, 1], winner: 0, ..Default::default() }).unwrap();
    assert!(set_result(&mut t, &r1[0], MatchResult { legs: [2, 0], winner: 0, ..Default::default() }).is_err());
}

#[test]
fn a_withdrawn_player_loses_by_walkover() {
    let mut t = create(&spec("single_ko", 4), "t", 0.0).unwrap();
    withdraw(&mut t, "P4").unwrap();
    let m = t.matches.iter().find(|m| m.sides.iter().any(|s| s.player.as_deref() == Some("P4"))).unwrap();
    assert_eq!(m.state, "done");
    assert!(m.result.as_ref().unwrap().walkover);
}

#[test]
fn longer_final() {
    let mut s = spec("single_ko", 4);
    s.final_legs = 4;
    let t = create(&s, "t", 0.0).unwrap();
    let fin = t.matches.iter().find(|m| m.label == "Final").unwrap();
    assert_eq!(t.settings_for(fin).legs, 4);
    let semi = t.matches.iter().find(|m| m.label == "Semi-final").unwrap();
    assert_eq!(t.settings_for(semi).legs, 2);
}

fn recorded_final_state() -> serde_json::Map<String, Value> {
    let raw: Vec<Value> = serde_json::from_str(&std::fs::read_to_string("tests/fixtures/pdc_bull_off_match_2026-11-02.json").unwrap()).unwrap();
    raw.iter()
        .rev()
        .filter_map(|m| m.get("message").unwrap_or(m).as_object().cloned())
        .find(|m| m.get("channel") == Some(&json!("autodarts.matches")) && m["topic"].as_str().unwrap_or("").ends_with(".state") && m["data"].as_object().map_or(false, |d| !d.is_empty()))
        .and_then(|m| m["data"].as_object().cloned())
        .unwrap()
}

#[test]
fn reads_the_result_of_a_recorded_real_match() {
    let state = recorded_final_state();
    // The recorded match: THOR (guest) beat iterathor (account) 1-0
    let assign = json!({"match": "M1", "players": [{"name": "Iterathor", "ad_name": "iterathor"}, {"name": "Thor", "ad_name": "THOR"}], "settings": GameSettings { legs: 1, ..Default::default() }});
    assert!(agent::names_match(&assign, &agent::names_of(&state)));
    let r = agent::result_of(&assign, &state, "x").unwrap();
    assert_eq!(r.winner, 1);
    assert_eq!(r.legs, [0, 1]);
}

#[test]
fn checklist_marks_what_differs() {
    let assign = json!({"match": "M1", "players": [{"name": "Anna", "ad_name": "ANNA"}, {"name": "Ben", "ad_name": "BEN"}], "settings": GameSettings::default()});
    let lobby = json!({"variant": "X01", "settings": {"baseScore": 501, "inMode": "Straight", "outMode": "Double"}, "legs": 2, "bullOffMode": "Normal", "players": [{"name": "BEN"}, {"name": "ANNA"}]});
    let (_, ok) = agent::checklist(&assign, lobby.as_object());
    assert!(ok);
    let lobby = json!({"variant": "X01", "settings": {"baseScore": 301, "inMode": "Straight", "outMode": "Double"}, "legs": 2, "bullOffMode": "Normal", "players": [{"name": "BEM"}, {"name": "ANNA"}]});
    let (items, ok) = agent::checklist(&assign, lobby.as_object());
    assert!(!ok);
    let bad: Vec<&str> = items.as_array().unwrap().iter().filter(|i| i["ok"] == json!(false)).map(|i| i["key"].as_str().unwrap()).collect();
    assert_eq!(bad, vec!["base", "players"]);
}

#[test]
fn checklist_flags_sets_mode_when_the_match_has_no_sets() {
    // Recorded from a real lobby: Autodarts adds "sets" only in sets mode
    let assign = json!({"match": "M1", "players": [{"name": "Anna", "ad_name": "ANNA"}, {"name": "Ben", "ad_name": "BEN"}], "settings": GameSettings::default()});
    let lobby = json!({"variant": "X01", "settings": {"baseScore": 501, "inMode": "Straight", "outMode": "Double"}, "legs": 2, "sets": 3, "bullOffMode": "Normal", "players": [{"name": "BEN"}, {"name": "ANNA"}]});
    let (items, ok) = agent::checklist(&assign, lobby.as_object());
    assert!(!ok);
    assert!(items.as_array().unwrap().iter().any(|i| i["key"] == "sets" && i["ok"] == json!(false)));
}

#[test]
fn league_with_return_round_plays_everyone_twice_and_crowns_the_table_leader() {
    let mut sp = spec("league", 5);
    sp.return_round = true;
    let mut t = create(&sp, "t", 0.0).unwrap();
    assert!(t.matches.iter().all(|m| m.stage == "group"), "a league has no knockout");
    let played = play_out(&mut t, 2, false);
    assert_eq!(played, 20);
    // Each pairing twice, once with each player throwing first
    let firsts: HashSet<(String, String)> = t.matches.iter().map(|m| (m.sides[0].player.clone().unwrap(), m.sides[1].player.clone().unwrap())).collect();
    assert_eq!(firsts.len(), 20);
    assert_eq!(champion(&t).as_deref(), Some("P1"));
    assert_eq!(t.status, "finished");
}

#[test]
fn a_league_of_17_is_refused() {
    assert!(create(&spec("league", 17), "t", 0.0).is_err());
}

#[test]
fn groups_with_return_round_still_cross_into_the_knockout() {
    let mut sp = spec("groups", 8);
    sp.return_round = true;
    let mut t = create(&sp, "t", 0.0).unwrap();
    assert_eq!(t.matches.iter().filter(|m| m.stage == "group").count(), 2 * 2 * 6);
    play_out(&mut t, 3, true);
    assert_eq!(t.status, "finished");
    assert!(champion(&t).is_some());
}

#[test]
fn nobody_plays_twice_in_a_row_while_another_match_is_ready() {
    // One board, a league of 4: after each match the next one should give both players a break if it can
    let mut t = create(&spec("league", 4), "t", 0.0).unwrap();
    with_boards(&mut t, 1);
    let mut prev: Vec<String> = Vec::new();
    let mut back_to_back = 0;
    loop {
        schedule(&mut t);
        let Some(m) = t.matches.iter().find(|m| m.state == "assigned").cloned() else { break };
        let ps: Vec<String> = m.sides.iter().filter_map(|s| s.player.clone()).collect();
        if ps.iter().any(|p| prev.contains(p)) {
            back_to_back += 1;
        }
        set_result(&mut t, &m.id, MatchResult { legs: [2, 0], winner: 0, ..Default::default() }).unwrap();
        prev = ps;
    }
    // 6 matches with 4 players: a fully rested order exists only for some steps; the old round order gave 4
    assert!(back_to_back <= 2, "{} back-to-back matches", back_to_back);
    assert_eq!(t.status, "finished");
}

#[test]
fn tables_show_averages_and_break_ties_with_them() {
    let mut t = create(&spec("league", 3), "t", 0.0).unwrap();
    // Everyone wins once 2:0: same points and legs, so the average decides
    // P1 beats P2, P2 beats P3, P3 beats P1
    let ms: Vec<(String, usize)> = t
        .matches
        .iter()
        .map(|m| {
            let n = |s: usize| m.sides[s].player.as_ref().unwrap()[1..].parse::<i64>().unwrap();
            (m.id.clone(), if (n(1) - n(0)).rem_euclid(3) == 1 { 0 } else { 1 })
        })
        .collect();
    for (k, (id, w)) in ms.iter().enumerate() {
        let mut legs = [0, 0];
        legs[*w] = 2;
        let mut avg = [30.0, 30.0];
        avg[*w] = 40.0 + k as f64 * 10.0;
        let stats = json!({"average": avg, "180s": [1, 0]});
        set_result(&mut t, id, MatchResult { legs, winner: *w, stats, ..Default::default() }).unwrap();
    }
    let table = group_table(&t, &t.groups[0]);
    assert!(table.iter().all(|r| r.won == 1 && r.legs_for - r.legs_against == 0));
    assert!(table[0].average >= table[1].average && table[1].average >= table[2].average);
    assert_eq!(table.iter().map(|r| r.t180).sum::<i64>(), 3);
}

#[test]
fn knockout_after_groups_can_be_longer() {
    let mut sp = spec("groups", 8);
    sp.settings.legs = 2;
    sp.ko_legs = 3;
    sp.final_legs = 4;
    let t = create(&sp, "t", 0.0).unwrap();
    for m in &t.matches {
        let want = if m.label == "Final" { 4 } else if m.stage == "ko" { 3 } else { 2 };
        assert_eq!(t.settings_for(m).legs, want, "{}", m.label);
    }
}

#[test]
fn an_offline_board_gives_back_its_match_after_a_minute() {
    // 6 players, 2 boards: two first-round matches start at once, then board 2 drops out
    let mut t = create(&spec("single_ko", 6), "t", 0.0).unwrap();
    with_boards(&mut t, 2);
    schedule_at(&mut t, 1000.0);
    let on_b2 = t.matches.iter().find(|m| m.board.as_deref() == Some("B2")).unwrap().id.clone();
    let on_b1 = t.matches.iter().find(|m| m.board.as_deref() == Some("B1")).unwrap().id.clone();
    t.boards[1].online = false;
    t.boards[1].offline_since = 1000.0;
    schedule_at(&mut t, 1030.0);
    assert_eq!(t.get(&on_b2).unwrap().board.as_deref(), Some("B2"), "kept while only briefly offline");
    schedule_at(&mut t, 1061.0);
    assert_eq!(t.get(&on_b2).unwrap().state, "ready");
    // Board 1 finishes its match and gets the given-back one next
    set_result(&mut t, &on_b1, MatchResult { legs: [2, 0], winner: 0, ..Default::default() }).unwrap();
    schedule_at(&mut t, 1062.0);
    assert!(t.matches.iter().any(|m| m.board.as_deref() == Some("B1") && m.state == "assigned"));
    assert!(!t.matches.iter().any(|m| m.board.as_deref() == Some("B2")));
}

#[test]
fn a_live_match_can_be_played_again_on_another_board() {
    let mut t = create(&spec("single_ko", 2), "t", 0.0).unwrap();
    with_boards(&mut t, 2);
    schedule(&mut t);
    let id = t.matches.iter().find(|m| m.state == "assigned").unwrap().id.clone();
    let i = t.matches.iter().position(|m| m.id == id).unwrap();
    let first = t.matches[i].board.clone().unwrap();
    t.matches[i].state = "live".into();
    t.matches[i].ad_match = Some("ad-1".into());
    let b = t.boards.iter_mut().find(|b| b.node_id == first).unwrap();
    b.left = true;
    replay(&mut t, &id).unwrap();
    schedule(&mut t);
    let m = t.get(&id).unwrap();
    assert_eq!(m.state, "assigned");
    assert_ne!(m.board.as_deref(), Some(first.as_str()));
    assert_eq!(m.ad_match, None);
    assert!(replay(&mut t, "nope").is_err());
}

#[test]
fn a_lobby_hands_out_nothing_and_old_files_still_load() {
    let mut t = lobby("L1", 0.0);
    with_boards(&mut t, 2);
    t.lobby = Some(spec("single_ko", 4));
    assert!(!schedule(&mut t), "no match before the start");
    assert!(view(&t)["matches"].as_array().unwrap().is_empty());
    assert_eq!(view(&t)["lobby"]["players"].as_array().unwrap().len(), 4);
    // Saved before visitors existed
    let p: Player = serde_json::from_value(json!({"id": "p1", "name": "Anna"})).unwrap();
    assert!(!p.visitor && p.member.is_empty());
}

#[test]
fn a_board_can_play_a_waiting_match_first() {
    let mut t = create(&spec("league", 6), "t", 0.0).unwrap();
    with_boards(&mut t, 1);
    schedule(&mut t);
    let mine = t.matches.iter().find(|m| m.state == "assigned").unwrap().id.clone();
    let busy: Vec<String> = t.get(&mine).unwrap().sides.iter().filter_map(|s| s.player.clone()).collect();
    let other = t.matches.iter().find(|m| m.state == "ready" && !m.sides.iter().any(|s| busy.contains(s.player.as_ref().unwrap()))).unwrap().id.clone();
    claim(&mut t, &other, "B1").unwrap();
    schedule(&mut t);
    assert_eq!(t.get(&other).unwrap().state, "assigned");
    assert_eq!(t.get(&mine).unwrap().state, "ready");
    // A second board: its players are busy on board 1, so it can't take a match with them
    with_boards(&mut t, 2);
    t.boards.truncate(2);
    t.boards[1].node_id = "B2".into();
    schedule(&mut t);
    let ps: Vec<String> = t.get(&other).unwrap().sides.iter().filter_map(|s| s.player.clone()).collect();
    let clash = t.matches.iter().find(|m| m.state == "ready" && m.sides.iter().any(|s| ps.contains(s.player.as_ref().unwrap()))).unwrap().id.clone();
    assert!(claim(&mut t, &clash, "B2").unwrap_err().contains("right now"));
    // A live match can't be taken, and a board playing live can't swap
    let i = t.matches.iter().position(|m| m.id == other).unwrap();
    t.matches[i].state = "live".into();
    assert!(claim(&mut t, &other, "B2").is_err());
    let free = t.matches.iter().find(|m| m.state == "ready" && !m.sides.iter().any(|s| ps.contains(s.player.as_ref().unwrap()))).unwrap().id.clone();
    assert!(claim(&mut t, &free, "B1").unwrap_err().contains("playing"));
}

#[test]
fn a_pick_is_shown_until_the_board_takes_a_match() {
    let mut t = create(&spec("league", 6), "t", 0.0).unwrap();
    with_boards(&mut t, 1);
    schedule(&mut t);
    let free = t.matches.iter().find(|m| m.state == "ready").unwrap().id.clone();
    assert!(set_pick(&mut t, "B1", &free));
    assert!(!set_pick(&mut t, "B1", &free), "the same pick again changes nothing");
    assert!(!set_pick(&mut t, "B1", "nope"), "an unknown match is ignored");
    assert_eq!(t.boards[0].pick, free);
    // Picking holds nothing: the match stays ready until the board starts it
    assert_eq!(t.get(&free).unwrap().state, "ready");
    let mine = t.matches.iter().find(|m| m.state == "assigned").unwrap().id.clone();
    claim(&mut t, &mine, "B1").unwrap();
    assert_eq!(t.boards[0].pick, "");
}

#[test]
fn a_board_keeps_its_match_link_across_restarts() {
    let dir = std::env::temp_dir().join(format!("autoglow-link-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("tournament")).unwrap();
    // A file from before the link was saved still loads
    std::fs::write(dir.join("tournament/state.json"), r#"{"node_id":"n1","node_name":"Board"}"#).unwrap();
    let t = super::Tournaments::new(dir.clone(), None, 0);
    assert!(t.local_view()["board"]["linked"].is_null());
    std::fs::write(dir.join("tournament/state.json"), r#"{"node_id":"n1","node_name":"Board","link":{"match":"M2","ad":"ad-9"}}"#).unwrap();
    let t = super::Tournaments::new(dir.clone(), None, 0);
    assert_eq!(t.local_view()["board"]["linked"], "ad-9");
    std::fs::remove_dir_all(dir).ok();
}
