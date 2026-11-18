//! Tournament rules: knockout brackets (single and double), round-robin groups, Swiss pairing,
//! results with corrections, and handing ready matches to free boards. Pure data, no I/O.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const MAX_PLAYERS: usize = 32;
pub const FORMATS: [&str; 5] = ["single_ko", "double_ko", "groups", "league", "swiss"];
/// Everyone against everyone in one table: 16 players are already 120 matches
pub const MAX_LEAGUE: usize = 16;

/// One Autodarts X01 game as the players set it up in the local-game screen
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct GameSettings {
    pub base_score: i64,
    pub in_mode: String,
    pub out_mode: String,
    /// First to this many legs (per set when sets > 0)
    pub legs: i64,
    /// First to this many sets; 0 = no sets
    pub sets: i64,
    pub bull_off: String,
}

impl Default for GameSettings {
    fn default() -> Self {
        GameSettings { base_score: 501, in_mode: "Straight".into(), out_mode: "Double".into(), legs: 2, sets: 0, bull_off: "Normal".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Player {
    pub id: String,
    pub name: String,
    /// The name the player has in Autodarts (guest name or account name)
    pub ad_name: String,
    pub account: bool,
    pub seed: i64,
    pub withdrawn: bool,
    /// A visitor gets no club profile and their games stay out of the club's unassigned list
    pub visitor: bool,
    /// The club member this player was picked from; empty for a name typed in
    pub member: String,
    /// Put themselves on the list by scanning the lobby's QR code: their sign-up number (0 = no)
    pub phone: i64,
}

/// One side of a match: a known player, a bye, or where the player will come from
/// ("W:M5" winner of M5, "L:M5" loser of M5, "G:A:2" second of group A)
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Side {
    pub player: Option<String>,
    pub from: Option<String>,
    pub bye: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct MatchResult {
    /// Legs (or sets, when the match is played in sets) per side
    pub legs: [i64; 2],
    pub winner: usize,
    pub walkover: bool,
    pub ad_match: Option<String>,
    pub stats: Value,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Match {
    pub id: String,
    /// main (single KO), wb / lb / gf (double KO), group, ko (after groups), swiss
    pub stage: String,
    pub round: i64,
    pub order: i64,
    pub label: String,
    pub group: Option<String>,
    pub sides: [Side; 2],
    /// pending, ready, assigned, live, done, skipped
    pub state: String,
    pub board: Option<String>,
    pub result: Option<MatchResult>,
    pub held: bool,
    pub ad_match: Option<String>,
    /// Order in which matches finished (1 = first); 0 = not played
    pub done_seq: i64,
    /// When the match went live (wall clock seconds); 0 = not live
    pub live_at: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Group {
    pub name: String,
    pub players: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Board {
    pub node_id: String,
    pub name: String,
    pub number: i64,
    pub approved: bool,
    pub plays: bool,
    pub online: bool,
    pub left: bool,
    /// When the host lost the link to this board (0 = online, or not known)
    pub offline_since: f64,
    /// The match this board has lined up but not started, shown on every screen in the board's colour.
    /// It holds nothing: another board can still take that match.
    pub pick: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Tournament {
    pub id: String,
    pub name: String,
    pub format: String,
    /// lobby (boards join, the organizer sets it up), running, finished
    pub status: String,
    /// While in the lobby: what the organizer has set up so far; the bracket is built from it on start
    pub lobby: Option<Spec>,
    pub settings: GameSettings,
    /// Legs for the semi-finals and the final(s); 0 = like every other match
    pub semi_legs: i64,
    pub final_legs: i64,
    /// Legs for the knockout after the groups; 0 = like the group matches
    pub ko_legs: i64,
    pub players: Vec<Player>,
    pub matches: Vec<Match>,
    pub groups: Vec<Group>,
    pub advance: i64,
    pub swiss_rounds: i64,
    /// Groups and league: every pairing is played twice
    pub return_round: bool,
    pub boards: Vec<Board>,
    pub created_at: f64,
    pub host_node: String,
    pub host_name: String,
    /// When this PC became the host by taking over (0 = it created the tournament); the newest
    /// host of a tournament wins when an old one comes back
    pub host_since: f64,
    next_match: i64,
    done_count: i64,
}

/// What the wizard sends to create a tournament
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Spec {
    pub name: String,
    pub format: String,
    pub settings: GameSettings,
    pub semi_legs: i64,
    pub final_legs: i64,
    pub ko_legs: i64,
    pub players: Vec<Player>,
    /// Number of groups (groups format); 0 = about four players per group
    pub groups: i64,
    /// Players per group that reach the knockout
    pub advance: i64,
    /// Swiss rounds; 0 = ceil(log2 players)
    pub swiss_rounds: i64,
    /// Groups and league: play every pairing twice
    pub return_round: bool,
    /// Lobby: players may add themselves from a phone (QR code)
    pub phone_signup: bool,
    /// Phone sign-ups so far (the server counts) and the last one the organizer's page has taken in
    pub phone_count: i64,
    pub phone_seen: i64,
}

fn is_final_label(l: &str) -> bool {
    l == "Final" || l.starts_with("Grand final")
}

/// Standard bracket order: seed 1 meets the last seed, and seeds 1 and 2 only meet in the final
fn seed_order(size: usize) -> Vec<usize> {
    let mut order = vec![1];
    while order.len() < size {
        let n = order.len() * 2;
        order = order.iter().flat_map(|&s| [s, n + 1 - s]).collect();
    }
    order
}

fn ko_label(matches_in_round: usize) -> String {
    match matches_in_round {
        1 => "Final".into(),
        2 => "Semi-final".into(),
        4 => "Quarter-final".into(),
        n => format!("Round of {}", n * 2),
    }
}

fn group_name(i: usize) -> String {
    ((b'A' + i as u8) as char).to_string()
}

impl Tournament {
    fn new_match(&mut self, stage: &str, round: i64, label: String, sides: [Side; 2]) -> String {
        self.next_match += 1;
        let id = format!("M{}", self.next_match);
        self.matches.push(Match { id: id.clone(), stage: stage.into(), round, order: self.next_match, label, sides, state: "pending".into(), ..Default::default() });
        id
    }

    pub fn get(&self, id: &str) -> Option<&Match> {
        self.matches.iter().find(|m| m.id == id)
    }

    fn idx(&self, id: &str) -> Option<usize> {
        self.matches.iter().position(|m| m.id == id)
    }

    pub fn player(&self, id: &str) -> Option<&Player> {
        self.players.iter().find(|p| p.id == id)
    }

    /// The game settings of one match (longer semi-finals and finals when set)
    pub fn settings_for(&self, m: &Match) -> GameSettings {
        let mut s = self.settings.clone();
        let longer = if is_final_label(&m.label) && self.final_legs > 0 {
            self.final_legs
        } else if m.label.ends_with("emi-final") && self.semi_legs > 0 {
            self.semi_legs
        } else if m.stage == "ko" {
            self.ko_legs
        } else {
            0
        };
        if longer > 0 {
            if s.sets > 0 {
                s.sets = longer;
            } else {
                s.legs = longer;
            }
        }
        s
    }

    /// A knockout bracket for these seeds (missing seeds are byes); returns the final's id
    fn build_ko(&mut self, seeds: &[Side], stage: &str, prefix: &str) -> Vec<Vec<String>> {
        let size = seeds.len().next_power_of_two().max(2);
        let order = seed_order(size);
        let mut rounds: Vec<Vec<String>> = Vec::new();
        let mut round = 1;
        let mut cur: Vec<String> = Vec::new();
        for i in 0..size / 2 {
            let side = |s: usize| seeds.get(s - 1).cloned().unwrap_or(Side { bye: true, ..Default::default() });
            let label = format!("{}{}", prefix, ko_label(size / 2));
            cur.push(self.new_match(stage, round, label, [side(order[2 * i]), side(order[2 * i + 1])]));
        }
        rounds.push(cur.clone());
        while cur.len() > 1 {
            round += 1;
            let n = cur.len() / 2;
            let mut next = Vec::new();
            for i in 0..n {
                let s = |id: &str| Side { from: Some(format!("W:{}", id)), ..Default::default() };
                let label = format!("{}{}", prefix, ko_label(n));
                next.push(self.new_match(stage, round, label, [s(&cur[2 * i]), s(&cur[2 * i + 1])]));
            }
            rounds.push(next.clone());
            cur = next;
        }
        rounds
    }

    fn build_double_ko(&mut self, seeds: &[Side]) {
        let wb = self.build_ko(seeds, "wb", "Winners ");
        let k = wb.len();
        let from = |kind: &str, id: &str| Side { from: Some(format!("{}:{}", kind, id)), ..Default::default() };
        let mut lb_champ = from("L", &wb[k - 1][0]);
        if k >= 2 {
            let mut lr = 1;
            let mut prev: Vec<String> = Vec::new();
            for i in 0..wb[0].len() / 2 {
                prev.push(self.new_match("lb", lr, format!("Losers round {}", lr), [from("L", &wb[0][2 * i]), from("L", &wb[0][2 * i + 1])]));
            }
            for j in 1..k {
                lr += 1;
                let drop = &wb[j];
                let mut cur = Vec::new();
                for i in 0..prev.len() {
                    // Losers dropping down meet the bracket in reverse order, so early rematches are rare
                    let d = drop[drop.len() - 1 - i].clone();
                    cur.push(self.new_match("lb", lr, format!("Losers round {}", lr), [from("W", &prev[i]), from("L", &d)]));
                }
                prev = cur;
                if j < k - 1 {
                    lr += 1;
                    let mut cur = Vec::new();
                    for i in 0..prev.len() / 2 {
                        cur.push(self.new_match("lb", lr, format!("Losers round {}", lr), [from("W", &prev[2 * i]), from("W", &prev[2 * i + 1])]));
                    }
                    prev = cur;
                }
            }
            lb_champ = from("W", &prev[0]);
        }
        let gf = self.new_match("gf", 1, "Grand final".into(), [from("W", &wb[k - 1][0]), lb_champ]);
        self.new_match("gf", 2, "Grand final (reset)".into(), [from("W", &gf), from("L", &gf)]);
    }

    /// Round robin groups (a league is one group without a knockout); a return round plays every pairing
    /// again with the throw order swapped
    fn build_groups(&mut self, ordered: &[String], groups: usize, advance: usize, return_round: bool) {
        let league = self.format == "league";
        let mut gs: Vec<Group> = (0..groups).map(|i| Group { name: if league { "League".into() } else { group_name(i) }, players: Vec::new() }).collect();
        for (i, p) in ordered.iter().enumerate() {
            let (row, col) = (i / groups, i % groups);
            let g = if row % 2 == 0 { col } else { groups - 1 - col };
            gs[g].players.push(p.clone());
        }
        // Round robin by the circle method, every group's round r before round r + 1
        let mut per_group: Vec<Vec<Vec<(String, String)>>> = Vec::new();
        for g in &gs {
            let mut list: Vec<Option<String>> = g.players.iter().cloned().map(Some).collect();
            if list.len() % 2 == 1 {
                list.push(None);
            }
            let n = list.len();
            let mut rounds = Vec::new();
            for _ in 0..n - 1 {
                let mut pairs = Vec::new();
                for i in 0..n / 2 {
                    if let (Some(a), Some(b)) = (&list[i], &list[n - 1 - i]) {
                        pairs.push((a.clone(), b.clone()));
                    }
                }
                rounds.push(pairs);
                let last = list.pop().unwrap();
                list.insert(1, last);
            }
            if return_round {
                let back: Vec<Vec<(String, String)>> = rounds.iter().map(|r| r.iter().map(|(a, b)| (b.clone(), a.clone())).collect()).collect();
                rounds.extend(back);
            }
            per_group.push(rounds);
        }
        let max_rounds = per_group.iter().map(Vec::len).max().unwrap_or(0);
        for r in 0..max_rounds {
            for (gi, rounds) in per_group.iter().enumerate() {
                for (a, b) in rounds.get(r).cloned().unwrap_or_default() {
                    let p = |id: String| Side { player: Some(id), ..Default::default() };
                    let label = if league { format!("Round {}", r + 1) } else { format!("Group {} · Round {}", gs[gi].name, r + 1) };
                    let id = self.new_match("group", r as i64 + 1, label, [p(a), p(b)]);
                    let i = self.idx(&id).unwrap();
                    self.matches[i].group = Some(gs[gi].name.clone());
                }
            }
        }
        let mut seeds = Vec::new();
        for rank in 1..=advance {
            for g in &gs {
                seeds.push(Side { from: Some(format!("G:{}:{}", g.name, rank)), ..Default::default() });
            }
        }
        self.groups = gs;
        if !league {
            self.build_ko(&seeds, "ko", "");
        }
    }

    fn players_in_seed_order(&self) -> Vec<String> {
        let mut ps: Vec<&Player> = self.players.iter().collect();
        ps.sort_by_key(|p| p.seed);
        ps.iter().map(|p| p.id.clone()).collect()
    }
}

/// Check a wizard spec; the reason is shown to the organizer
pub fn validate(spec: &Spec) -> Result<(), String> {
    let n = spec.players.len();
    if !FORMATS.contains(&spec.format.as_str()) {
        return Err("Pick a tournament format".into());
    }
    if n < 2 {
        return Err("Add at least 2 players".into());
    }
    if n > MAX_PLAYERS {
        return Err(format!("At most {} players", MAX_PLAYERS));
    }
    let mut seen = HashSet::new();
    for p in &spec.players {
        let name = p.name.trim().to_lowercase();
        if name.is_empty() {
            return Err("Every player needs a name".into());
        }
        if !seen.insert(name) {
            return Err(format!("{} is in the list twice", p.name.trim()));
        }
    }
    let s = &spec.settings;
    if ![301, 501, 701].contains(&s.base_score) {
        return Err("Base score must be 301, 501 or 701".into());
    }
    if !(1..=11).contains(&s.legs) || !(0..=7).contains(&s.sets) {
        return Err("Legs must be 1 to 11, sets 0 to 7".into());
    }
    if spec.format == "league" && n > MAX_LEAGUE {
        return Err(format!("A league is at most {} players ({} matches). Use groups for more.", MAX_LEAGUE, MAX_LEAGUE * (MAX_LEAGUE - 1) / 2));
    }
    if spec.format == "groups" {
        let g = group_count(spec);
        if g == 0 || n / g < 2 {
            return Err("Each group needs at least 2 players".into());
        }
        if n.div_ceil(g) > 8 {
            return Err(format!("{} players per group is too many (max 8). Use more groups.", n.div_ceil(g)));
        }
        let adv = spec.advance.max(1) as usize;
        if adv * g < 2 || adv > n / g {
            return Err("Too many players advance from each group".into());
        }
    }
    Ok(())
}

fn group_count(spec: &Spec) -> usize {
    if spec.groups > 0 {
        spec.groups as usize
    } else {
        spec.players.len().div_ceil(4).max(1)
    }
}

/// A tournament still in its lobby: no bracket yet, only what the organizer has set up so far
pub fn lobby(id: &str, now: f64) -> Tournament {
    Tournament { id: id.into(), status: "lobby".into(), created_at: now, ..Default::default() }
}

/// A new tournament from the wizard's spec, with every match it can already lay out
pub fn create(spec: &Spec, id: &str, now: f64) -> Result<Tournament, String> {
    validate(spec)?;
    let mut t = Tournament {
        id: id.into(),
        name: if spec.name.trim().is_empty() { "Local Tournament".into() } else { spec.name.trim().into() },
        format: spec.format.clone(),
        status: "running".into(),
        settings: spec.settings.clone(),
        semi_legs: spec.semi_legs,
        final_legs: spec.final_legs,
        ko_legs: if spec.format == "groups" { spec.ko_legs } else { 0 },
        return_round: spec.return_round && (spec.format == "groups" || spec.format == "league"),
        created_at: now,
        ..Default::default()
    };
    let mut players = spec.players.clone();
    // Unseeded players keep their list order after the seeded ones
    for (i, p) in players.iter_mut().enumerate() {
        if p.seed <= 0 {
            p.seed = 1000 + i as i64;
        }
    }
    players.sort_by_key(|p| p.seed);
    for (i, p) in players.iter_mut().enumerate() {
        p.id = format!("P{}", i + 1);
        p.seed = i as i64 + 1;
        p.name = p.name.trim().into();
        if p.ad_name.trim().is_empty() {
            p.ad_name = p.name.clone();
        }
        p.withdrawn = false;
    }
    t.players = players;
    let ordered = t.players_in_seed_order();
    let seeds: Vec<Side> = ordered.iter().map(|p| Side { player: Some(p.clone()), ..Default::default() }).collect();
    match spec.format.as_str() {
        "single_ko" => {
            t.build_ko(&seeds, "main", "");
        }
        "double_ko" => t.build_double_ko(&seeds),
        "groups" => {
            let g = group_count(spec);
            t.advance = spec.advance.max(1);
            t.build_groups(&ordered, g, t.advance as usize, spec.return_round);
        }
        "league" => t.build_groups(&ordered, 1, 0, spec.return_round),
        _ => {
            let n = ordered.len();
            t.swiss_rounds = if spec.swiss_rounds > 0 { spec.swiss_rounds.min(n as i64 - 1).max(1) } else { (n as f64).log2().ceil().max(1.0) as i64 };
            swiss_round(&mut t, 1);
        }
    }
    resolve(&mut t);
    Ok(t)
}

// ---------------------------------------------------------------------------------------------
// Standings
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize)]
pub struct Row {
    pub player: String,
    pub name: String,
    pub played: i64,
    pub won: i64,
    pub lost: i64,
    pub legs_for: i64,
    pub legs_against: i64,
    pub byes: i64,
    pub buchholz: i64,
    pub seed: i64,
    /// Three-dart average over the matches with stats (0 = none yet)
    pub average: f64,
    #[serde(rename = "t180")]
    pub t180: i64,
    #[serde(skip)]
    avg_n: i64,
}

fn rows_for(t: &Tournament, players: &[String], stage: &str, group: Option<&str>) -> HashMap<String, Row> {
    let mut rows: HashMap<String, Row> = players
        .iter()
        .map(|p| (p.clone(), Row { player: p.clone(), name: t.player(p).map(|x| x.name.clone()).unwrap_or_default(), seed: t.player(p).map_or(99, |x| x.seed), ..Default::default() }))
        .collect();
    for m in t.matches.iter().filter(|m| m.stage == stage && m.state == "done" && (group.is_none() || m.group.as_deref() == group)) {
        let Some(r) = &m.result else { continue };
        for s in 0..2 {
            let Some(p) = &m.sides[s].player else { continue };
            let Some(row) = rows.get_mut(p) else { continue };
            if m.sides[1 - s].bye {
                row.byes += 1;
                row.won += 1;
                continue;
            }
            row.played += 1;
            row.legs_for += r.legs[s];
            row.legs_against += r.legs[1 - s];
            if let Some(a) = r.stats.get("average").and_then(|v| v.get(s)).and_then(Value::as_f64).filter(|a| *a > 0.0) {
                row.average += a;
                row.avg_n += 1;
            }
            row.t180 += r.stats.get("180s").and_then(|v| v.get(s)).and_then(Value::as_i64).unwrap_or(0);
            if r.winner == s {
                row.won += 1;
            } else {
                row.lost += 1;
            }
        }
    }
    for row in rows.values_mut() {
        if row.avg_n > 0 {
            row.average = (row.average / row.avg_n as f64 * 100.0).round() / 100.0;
        }
    }
    rows
}

/// Wins against the other players in the same tie (a mini-table, so a three-way circle stays a tie)
fn head_to_head_wins(t: &Tournament, stage: &str, rows: &[Row]) -> HashMap<String, i64> {
    let key = |r: &Row| (r.won, r.legs_for - r.legs_against, r.legs_for);
    let mut out = HashMap::new();
    for r in rows {
        let tied: HashSet<&str> = rows.iter().filter(|x| key(x) == key(r)).map(|x| x.player.as_str()).collect();
        let mut wins = 0;
        for m in t.matches.iter().filter(|m| m.stage == stage && m.state == "done") {
            let (Some(x), Some(y), Some(res)) = (&m.sides[0].player, &m.sides[1].player, &m.result) else { continue };
            if (x == &r.player && tied.contains(y.as_str())) || (y == &r.player && tied.contains(x.as_str())) {
                if m.sides[res.winner].player.as_deref() == Some(r.player.as_str()) {
                    wins += 1;
                }
            }
        }
        out.insert(r.player.clone(), wins);
    }
    out
}

fn by_average(a: &Row, b: &Row) -> std::cmp::Ordering {
    b.average.partial_cmp(&a.average).unwrap_or(std::cmp::Ordering::Equal)
}

/// Group table: wins, leg difference, legs won, wins among the tied players, average, seed
pub fn group_table(t: &Tournament, g: &Group) -> Vec<Row> {
    let rows = rows_for(t, &g.players, "group", Some(&g.name));
    let mut v: Vec<Row> = g.players.iter().filter_map(|p| rows.get(p).cloned()).collect();
    let h2h = head_to_head_wins(t, "group", &v);
    v.sort_by(|a, b| {
        b.won
            .cmp(&a.won)
            .then((b.legs_for - b.legs_against).cmp(&(a.legs_for - a.legs_against)))
            .then(b.legs_for.cmp(&a.legs_for))
            .then(h2h[&b.player].cmp(&h2h[&a.player]))
            .then_with(|| by_average(a, b))
            .then(a.seed.cmp(&b.seed))
    });
    v
}

/// Swiss table: wins, Buchholz (opponents' wins), leg difference, seed
pub fn swiss_table(t: &Tournament) -> Vec<Row> {
    let ids: Vec<String> = t.players.iter().map(|p| p.id.clone()).collect();
    let mut rows = rows_for(t, &ids, "swiss", None);
    let wins: HashMap<String, i64> = rows.iter().map(|(k, r)| (k.clone(), r.won)).collect();
    for m in t.matches.iter().filter(|m| m.stage == "swiss" && m.state == "done") {
        if let (Some(a), Some(b)) = (&m.sides[0].player, &m.sides[1].player) {
            if let Some(r) = rows.get_mut(a) {
                r.buchholz += wins.get(b).copied().unwrap_or(0);
            }
            if let Some(r) = rows.get_mut(b) {
                r.buchholz += wins.get(a).copied().unwrap_or(0);
            }
        }
    }
    let mut v: Vec<Row> = rows.into_values().collect();
    v.sort_by(|a, b| {
        b.won.cmp(&a.won).then(b.buchholz.cmp(&a.buchholz)).then((b.legs_for - b.legs_against).cmp(&(a.legs_for - a.legs_against))).then_with(|| by_average(a, b)).then(a.seed.cmp(&b.seed))
    });
    v
}

// ---------------------------------------------------------------------------------------------
// Swiss pairing
// ---------------------------------------------------------------------------------------------

fn swiss_played(t: &Tournament) -> HashSet<(String, String)> {
    let mut s = HashSet::new();
    for m in t.matches.iter().filter(|m| m.stage == "swiss") {
        if let (Some(a), Some(b)) = (&m.sides[0].player, &m.sides[1].player) {
            s.insert((a.clone(), b.clone()));
            s.insert((b.clone(), a.clone()));
        }
    }
    s
}

fn pair_up(list: &[String], played: &HashSet<(String, String)>) -> Option<Vec<(String, String)>> {
    if list.is_empty() {
        return Some(Vec::new());
    }
    let a = &list[0];
    for i in 1..list.len() {
        if played.contains(&(a.clone(), list[i].clone())) {
            continue;
        }
        let rest: Vec<String> = list[1..].iter().enumerate().filter(|(j, _)| *j + 1 != i).map(|(_, p)| p.clone()).collect();
        if let Some(mut pairs) = pair_up(&rest, played) {
            pairs.insert(0, (a.clone(), list[i].clone()));
            return Some(pairs);
        }
    }
    None
}

fn swiss_round(t: &mut Tournament, round: i64) {
    let mut ranked: Vec<String> = if round == 1 { t.players_in_seed_order() } else { swiss_table(t).into_iter().map(|r| r.player).collect() };
    ranked.retain(|p| t.player(p).map_or(false, |x| !x.withdrawn));
    let p = |id: &str| Side { player: Some(id.into()), ..Default::default() };
    if ranked.len() % 2 == 1 {
        let had_bye: HashSet<String> = t.matches.iter().filter(|m| m.stage == "swiss" && m.sides[1].bye).filter_map(|m| m.sides[0].player.clone()).collect();
        let pos = ranked.iter().rposition(|x| !had_bye.contains(x)).unwrap_or(ranked.len() - 1);
        let b = ranked.remove(pos);
        t.new_match("swiss", round, format!("Round {}", round), [p(&b), Side { bye: true, ..Default::default() }]);
    }
    let pairs = if round == 1 {
        let h = ranked.len() / 2;
        (0..h).map(|i| (ranked[i].clone(), ranked[i + h].clone())).collect()
    } else {
        pair_up(&ranked, &swiss_played(t)).unwrap_or_else(|| ranked.chunks(2).map(|c| (c[0].clone(), c[1].clone())).collect())
    };
    for (a, b) in pairs {
        t.new_match("swiss", round, format!("Round {}", round), [p(&a), p(&b)]);
    }
}

// ---------------------------------------------------------------------------------------------
// Moving players forward
// ---------------------------------------------------------------------------------------------

/// The player a source names, Some(None) for a bye, None while it is not decided yet
fn source_player(t: &Tournament, from: &str) -> Option<Option<String>> {
    let parts: Vec<&str> = from.split(':').collect();
    match parts.as_slice() {
        [kind @ ("W" | "L"), id] => {
            let m = t.get(id)?;
            if m.state != "done" {
                return None;
            }
            let r = m.result.as_ref()?;
            let s = if *kind == "W" { &m.sides[r.winner] } else { &m.sides[1 - r.winner] };
            Some(if s.bye { None } else { s.player.clone() })
        }
        ["G", g, rank] => {
            if t.matches.iter().any(|m| m.stage == "group" && m.state != "done") {
                return None;
            }
            let group = t.groups.iter().find(|x| x.name == *g)?;
            let r: usize = rank.parse().ok()?;
            Some(group_table(t, group).get(r - 1).map(|row| row.player.clone()))
        }
        _ => None,
    }
}

fn withdrawn(t: &Tournament, p: &Option<String>) -> bool {
    p.as_ref().and_then(|id| t.player(id)).map_or(false, |x| x.withdrawn)
}

/// Fill decided sides, settle byes and walkovers, open new Swiss rounds, mark the end
pub fn resolve(t: &mut Tournament) {
    loop {
        let mut changed = false;
        for i in 0..t.matches.len() {
            for s in 0..2 {
                let side = t.matches[i].sides[s].clone();
                if side.player.is_none() && !side.bye {
                    if let Some(from) = &side.from {
                        if let Some(p) = source_player(t, from) {
                            t.matches[i].sides[s].player = p.clone();
                            t.matches[i].sides[s].bye = p.is_none();
                            changed = true;
                        }
                    }
                }
            }
            let m = t.matches[i].clone();
            if m.state != "pending" && m.state != "ready" {
                continue;
            }
            let known = |s: &Side| s.bye || s.player.is_some();
            if !(known(&m.sides[0]) && known(&m.sides[1])) {
                continue;
            }
            // The grand final reset is only played when the losers' bracket champion won the first one
            if m.stage == "gf" && m.round == 2 {
                if let Some(gf) = t.matches.iter().find(|x| x.stage == "gf" && x.round == 1) {
                    if gf.result.as_ref().map_or(false, |r| r.winner == 0) || gf.sides[1].bye {
                        t.matches[i].state = "skipped".into();
                        changed = true;
                        continue;
                    }
                }
            }
            let out = [m.sides[0].bye || withdrawn(t, &m.sides[0].player), m.sides[1].bye || withdrawn(t, &m.sides[1].player)];
            if out[0] || out[1] {
                let winner = if out[0] && !out[1] { 1 } else { 0 };
                t.matches[i].state = "done".into();
                t.matches[i].board = None;
                t.matches[i].result = Some(MatchResult { winner, walkover: true, ..Default::default() });
                changed = true;
            } else if m.state == "pending" {
                t.matches[i].state = "ready".into();
                changed = true;
            }
        }
        if t.format == "swiss" && t.status == "running" {
            let last = t.matches.iter().filter(|m| m.stage == "swiss").map(|m| m.round).max().unwrap_or(0);
            if last < t.swiss_rounds && t.matches.iter().filter(|m| m.stage == "swiss").all(|m| m.state == "done") {
                swiss_round(t, last + 1);
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    let all_done = t.matches.iter().all(|m| m.state == "done" || m.state == "skipped");
    t.status = if all_done { "finished".into() } else { "running".into() };
}

/// The champion once the tournament is decided
pub fn champion(t: &Tournament) -> Option<String> {
    if t.status != "finished" {
        return None;
    }
    if t.format == "swiss" {
        return swiss_table(t).first().map(|r| r.player.clone());
    }
    if t.format == "league" {
        return t.groups.first().and_then(|g| group_table(t, g).first().map(|r| r.player.clone()));
    }
    let last = t.matches.iter().filter(|m| m.state == "done").max_by_key(|m| m.order)?;
    let r = last.result.as_ref()?;
    last.sides[r.winner].player.clone()
}

// ---------------------------------------------------------------------------------------------
// Results and corrections
// ---------------------------------------------------------------------------------------------

/// Every match that takes a player from this one, directly or further down the line
pub fn dependents(t: &Tournament, id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut todo = vec![id.to_string()];
    while let Some(cur) = todo.pop() {
        let Some(m) = t.get(&cur) else { continue };
        for x in &t.matches {
            if out.contains(&x.id) || x.id == id {
                continue;
            }
            let fed = x.sides.iter().any(|s| s.from.as_deref() == Some(&format!("W:{}", cur)) || s.from.as_deref() == Some(&format!("L:{}", cur)))
                || (m.stage == "group" && x.sides.iter().any(|s| s.from.as_deref().map_or(false, |f| f.starts_with("G:"))))
                || (m.stage == "swiss" && x.stage == "swiss" && x.round > m.round);
            if fed {
                out.push(x.id.clone());
                todo.push(x.id.clone());
            }
        }
    }
    out
}

fn started(m: &Match) -> bool {
    m.state == "live" || (m.state == "done" && !m.result.as_ref().map_or(false, |r| r.walkover && (m.sides[0].bye || m.sides[1].bye)))
}

/// Record a result (from a board or typed in by the host). A correction is allowed while no later
/// match that depends on it has started; those matches go back to waiting.
pub fn set_result(t: &mut Tournament, id: &str, result: MatchResult) -> Result<(), String> {
    let i = t.idx(id).ok_or("Unknown match")?;
    let m = t.matches[i].clone();
    if m.state == "pending" || m.state == "skipped" {
        return Err(format!("{} can't be played yet", id));
    }
    if m.sides.iter().any(|s| s.player.is_none()) {
        return Err(format!("{} has a bye", id));
    }
    if result.winner > 1 || (!result.walkover && result.legs[result.winner] <= result.legs[1 - result.winner]) {
        return Err("The winner must have more legs".into());
    }
    if m.state == "done" {
        let deps = dependents(t, id);
        let blocking: Vec<String> = deps.iter().filter(|d| t.get(d).map_or(false, started)).cloned().collect();
        if !blocking.is_empty() {
            return Err(format!("{} already started; correct those first", blocking.join(", ")));
        }
        for d in &deps {
            let Some(j) = t.idx(d) else { continue };
            if t.matches[j].stage == "swiss" {
                continue;
            }
            for s in 0..2 {
                if t.matches[j].sides[s].from.is_some() {
                    t.matches[j].sides[s].player = None;
                    t.matches[j].sides[s].bye = false;
                }
            }
            t.matches[j].state = "pending".into();
            t.matches[j].result = None;
            t.matches[j].board = None;
        }
        t.matches.retain(|x| !(x.stage == "swiss" && deps.contains(&x.id)));
    }
    if m.state != "done" {
        t.done_count += 1;
        t.matches[i].done_seq = t.done_count;
    }
    let mm = &mut t.matches[i];
    mm.state = "done".into();
    mm.board = None;
    mm.ad_match = result.ad_match.clone().or(mm.ad_match.take());
    mm.result = Some(result);
    resolve(t);
    Ok(())
}

/// Change how long matches are while the tournament runs; games already started keep theirs
pub fn set_distances(t: &mut Tournament, legs: i64, sets: i64, ko_legs: i64, semi_legs: i64, final_legs: i64) -> Result<(), String> {
    if !(1..=11).contains(&legs) || !(0..=7).contains(&sets) {
        return Err("Legs must be 1 to 11, sets 0 to 7".into());
    }
    if [ko_legs, semi_legs, final_legs].iter().any(|v| !(0..=11).contains(v)) {
        return Err("Longer rounds must be 0 (same) to 11".into());
    }
    t.settings.legs = legs;
    t.settings.sets = sets;
    t.ko_legs = if t.format == "groups" { ko_legs } else { 0 };
    t.semi_legs = semi_legs;
    t.final_legs = final_legs;
    Ok(())
}

/// A player stops: their open matches are lost by walkover
pub fn withdraw(t: &mut Tournament, player: &str) -> Result<(), String> {
    let p = t.players.iter_mut().find(|p| p.id == player).ok_or("Unknown player")?;
    p.withdrawn = true;
    for m in t.matches.iter_mut() {
        if (m.state == "assigned" || m.state == "live") && m.sides.iter().any(|s| s.player.as_deref() == Some(player)) {
            m.state = "ready".into();
            m.board = None;
        }
    }
    resolve(t);
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------------------------

/// Hand ready matches to free boards, earliest match first, never one player on two boards
/// Ready matches in the order the scheduler hands them out
pub fn queue(t: &Tournament) -> Vec<usize> {
    // Give players a break: a match whose player finished one of the last few games waits while
    // another match is ready (nobody plays twice in a row unless there is nothing else to play)
    let boards = t.boards.iter().filter(|b| b.approved && b.plays && !b.left).count().max(1) as i64;
    let mut last: HashMap<String, i64> = HashMap::new();
    for m in t.matches.iter().filter(|m| m.done_seq > 0) {
        for p in m.sides.iter().filter_map(|s| s.player.clone()) {
            let e = last.entry(p).or_insert(0);
            *e = (*e).max(m.done_seq);
        }
    }
    let tired = |m: &Match| m.sides.iter().filter_map(|s| s.player.as_ref()).any(|p| last.get(p).map_or(false, |&d| d > t.done_count - boards));
    let mut ready: Vec<usize> = (0..t.matches.len()).filter(|&i| t.matches[i].state == "ready" && !t.matches[i].held).collect();
    // Round robin matches are all ready from the start: there, resting beats the round order
    ready.sort_by_key(|&i| {
        let m = &t.matches[i];
        let ko_round = if m.stage == "group" { 0 } else { m.round };
        (ko_round, tired(m), m.round, m.order)
    });
    ready
}

/// A board offline this long gives back a match that has not started, so another board plays it
pub const GIVE_BACK_AFTER: f64 = 60.0;

pub fn schedule(t: &mut Tournament) -> bool {
    schedule_at(t, crate::led_thread::wall())
}

pub fn schedule_at(t: &mut Tournament, now: f64) -> bool {
    let mut changed = false;
    // A board that left, or is offline for a while, gives back a match that has not started
    let gone = |x: &Board| x.left || (!x.online && x.offline_since > 0.0 && now - x.offline_since >= GIVE_BACK_AFTER);
    for m in t.matches.iter_mut() {
        if m.state == "assigned" {
            let ok = m.board.as_ref().map_or(false, |b| t.boards.iter().any(|x| &x.node_id == b && x.approved && x.plays && !gone(x)));
            if !ok {
                m.state = "ready".into();
                m.board = None;
                changed = true;
            }
        }
    }
    let busy_boards: HashSet<String> = t.matches.iter().filter(|m| m.state == "assigned" || m.state == "live").filter_map(|m| m.board.clone()).collect();
    let mut busy_players: HashSet<String> =
        t.matches.iter().filter(|m| m.state == "assigned" || m.state == "live").flat_map(|m| m.sides.iter().filter_map(|s| s.player.clone())).collect();
    let mut free: Vec<&Board> = t.boards.iter().filter(|b| b.approved && b.plays && b.online && !b.left && !busy_boards.contains(&b.node_id)).collect();
    free.sort_by_key(|b| b.number);
    let free: Vec<String> = free.iter().map(|b| b.node_id.clone()).collect();
    let ready = queue(t);
    let mut fi = 0;
    for i in ready {
        if fi >= free.len() {
            break;
        }
        let ps: Vec<String> = t.matches[i].sides.iter().filter_map(|s| s.player.clone()).collect();
        if ps.iter().any(|p| busy_players.contains(p)) {
            continue;
        }
        t.matches[i].state = "assigned".into();
        t.matches[i].board = Some(free[fi].clone());
        busy_players.extend(ps);
        fi += 1;
        changed = true;
    }
    changed
}

/// "Play here": a board takes a waiting match (or one another board has not started). The match it
/// had and not started goes back to the queue, so the next free board gets it
pub fn claim(t: &mut Tournament, id: &str, node: &str) -> Result<(), String> {
    if !t.boards.iter().any(|b| b.node_id == node && b.approved && !b.left) {
        return Err("This board is not in the tournament".into());
    }
    let target = t.matches.iter().position(|m| m.id == id).ok_or("Unknown match")?;
    let m = &t.matches[target];
    if m.state == "live" {
        return Err("That match is being played".into());
    }
    if (m.state != "ready" && m.state != "assigned") || m.sides.iter().any(|s| s.player.is_none()) {
        return Err("That match is not ready yet".into());
    }
    if m.board.as_deref() == Some(node) {
        set_pick(t, node, "");
        return Ok(());
    }
    let mine = t.matches.iter().position(|m| (m.state == "assigned" || m.state == "live") && m.board.as_deref() == Some(node));
    if let Some(i) = mine {
        if t.matches[i].state == "live" {
            return Err(format!("This board is playing {} right now", t.matches[i].id));
        }
    }
    let players: Vec<String> = t.matches[target].sides.iter().filter_map(|s| s.player.clone()).collect();
    for (i, o) in t.matches.iter().enumerate() {
        if i == target || Some(i) == mine || (o.state != "assigned" && o.state != "live") {
            continue;
        }
        if let Some(p) = o.sides.iter().filter_map(|s| s.player.as_ref()).find(|p| players.contains(p)) {
            let who = t.player(p).map_or(p.clone(), |x| x.name.clone());
            let on = o.board.as_ref().and_then(|b| t.boards.iter().find(|x| &x.node_id == b)).map_or(String::new(), |b| format!(" on Board {}", b.number));
            return Err(format!("{} is in {}{} right now", who, o.id, on));
        }
    }
    if let Some(i) = mine {
        t.matches[i].state = "ready".into();
        t.matches[i].board = None;
    }
    let m = &mut t.matches[target];
    m.state = "assigned".into();
    m.board = Some(node.to_string());
    m.held = false;
    set_pick(t, node, "");
    Ok(())
}

/// A board lined up another match on its page (or none). True when that changed anything
pub fn set_pick(t: &mut Tournament, node: &str, id: &str) -> bool {
    let known = id.is_empty() || t.matches.iter().any(|m| m.id == id);
    match t.boards.iter_mut().find(|b| b.node_id == node) {
        Some(b) if known && b.pick != id => {
            b.pick = id.to_string();
            true
        }
        _ => false,
    }
}

/// A live match whose board is gone: start it again from scratch on another board
pub fn replay(t: &mut Tournament, id: &str) -> Result<(), String> {
    let m = t.matches.iter_mut().find(|m| m.id == id).ok_or("Unknown match")?;
    if m.state != "live" && m.state != "assigned" {
        return Err("Only a match that is being set up or played can be played again".into());
    }
    m.board = None;
    m.state = "ready".into();
    m.ad_match = None;
    m.held = false;
    Ok(())
}

/// What one board has to play now: the match, its players and the game to set up
pub fn assignment_for(t: &Tournament, node: &str) -> Option<Value> {
    let m = t.matches.iter().find(|m| (m.state == "assigned" || m.state == "live") && m.board.as_deref() == Some(node))?;
    let players: Vec<Value> = m
        .sides
        .iter()
        .map(|s| {
            let p = s.player.as_ref().and_then(|id| t.player(id));
            json!({"id": s.player, "name": p.map(|p| p.name.clone()), "ad_name": p.map(|p| p.ad_name.clone()), "account": p.map_or(false, |p| p.account)})
        })
        .collect();
    Some(json!({
        "tournament": t.id, "tournament_name": t.name, "match": m.id, "label": m.label, "state": m.state,
        "players": players, "settings": t.settings_for(m), "ad_match": m.ad_match,
    }))
}

/// The tournament as pages show it: everything plus tables, champion and per-match settings
pub fn view(t: &Tournament) -> Value {
    let mut v = serde_json::to_value(t).unwrap_or(Value::Null);
    let tables: Vec<Value> = if t.format == "groups" || t.format == "league" {
        t.groups.iter().map(|g| json!({"name": g.name, "rows": group_table(t, g)})).collect()
    } else if t.format == "swiss" {
        vec![json!({"name": "Standings", "rows": swiss_table(t)})]
    } else {
        Vec::new()
    };
    v["tables"] = json!(tables);
    v["champion"] = json!(champion(t));
    v["up_next"] = json!(queue(t).iter().map(|&i| t.matches[i].id.clone()).collect::<Vec<_>>());
    if let Some(ms) = v.get_mut("matches").and_then(Value::as_array_mut) {
        for (m, raw) in ms.iter_mut().zip(t.matches.iter()) {
            let s = t.settings_for(raw);
            m["legs_to_win"] = json!(if s.sets > 0 { s.sets } else { s.legs });
        }
    }
    v
}
