//! Club games and the stats computed from them. A game is one finished Autodarts match as the
//! board saw it; stats are always computed from the stored games, never kept as totals, so a name
//! given to another member later changes every number that depends on it.

use crate::py::{py_str, Obj};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Members need this many games before they appear on the average-type leaderboards
pub const MIN_GAMES: usize = 3;
const FORM_GAMES: usize = 20;
const RECENT_GAMES: usize = 15;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct GamePlayer {
    /// The name as Autodarts showed it (guests in capitals)
    pub name: String,
    /// The member this player was recognised as; empty while unassigned
    #[serde(default)]
    pub member: String,
    #[serde(default)]
    pub bot: bool,
    #[serde(default)]
    pub won: bool,
    #[serde(default)]
    pub legs: i64,
    #[serde(default)]
    pub sets: i64,
    /// Points scored and darts thrown in the whole match
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub darts: i64,
    #[serde(default)]
    pub average: f64,
    #[serde(default)]
    pub first9: f64,
    /// Darts at a double for the checkout, and how many of them hit
    #[serde(default)]
    pub checkouts: i64,
    #[serde(default)]
    pub checkouts_hit: i64,
    #[serde(default)]
    pub t180: i64,
    /// Visits of 140 to 179
    #[serde(default)]
    pub t140: i64,
    /// Visits of 100 to 139
    #[serde(default)]
    pub t100: i64,
    #[serde(default)]
    pub best_checkout: i64,
    /// Fewest darts in a leg this player won; 0 when they won none
    #[serde(default)]
    pub best_leg: i64,
    /// Autodarts' scoring average until 170 left (pure scoring, no finishing)
    #[serde(default)]
    pub avg170: f64,
    /// Every dart this player threw in the match, in order (games from v0.47.0 on)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub throws: Vec<Dart>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// One dart as the board saw it. Short names keep a game line small.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Dart {
    /// Where it landed: 1.0 is the outer edge of the double ring (170 mm), +x right, +y towards the 20.
    /// None when the score was typed in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    /// Segment number (25 = bull, 0 = outside) and multiplier (0 = miss)
    pub n: i64,
    pub m: i64,
    /// X01: score left before this dart; 0 in other variants
    #[serde(default)]
    pub r: i64,
    /// Leg as set*100 + leg
    #[serde(default)]
    pub l: i64,
    /// Visit (round) in the leg, from 1
    #[serde(default)]
    pub v: i64,
    /// Dart in the visit: 0, 1 or 2
    #[serde(default)]
    pub i: i64,
    /// Order in the whole match (all players), so the darts of both players can be put side by side
    #[serde(default)]
    pub q: u64,
    /// The visit busted
    #[serde(default, skip_serializing_if = "is_false")]
    pub b: bool,
}

impl Dart {
    pub fn points(&self) -> i64 {
        self.n * self.m
    }
}

#[derive(Clone, Debug, Default)]
struct Noted {
    /// The Autodarts player id: the list of players doesn't always come in the same order
    player: String,
    turn: String,
    dart: Dart,
}

/// Every dart of the match on screen, gathered from each match-state message. Autodarts sends
/// only the current visit, so the darts are noted while they are visible. Keyed by throw id: a
/// frame seen twice or a corrected dart is kept once.
#[derive(Clone, Debug, Default)]
pub struct DartLog {
    pub match_id: String,
    darts: BTreeMap<String, Noted>,
    turn_start: BTreeMap<String, i64>,
    seq: u64,
}

impl DartLog {
    pub fn note(&mut self, state: &Obj) {
        let id = state.get("id").map(py_str).unwrap_or_default();
        if id.is_empty() {
            return;
        }
        if id != self.match_id {
            *self = DartLog { match_id: id, ..Default::default() };
        }
        let variant = state.get("variant").map(py_str).unwrap_or_default();
        if variant.is_empty() || variant == crate::autodarts::BULL_OFF_VARIANT {
            return;
        }
        let x01 = variant.eq_ignore_ascii_case("x01");
        let players = state.get("players").and_then(Value::as_array).cloned().unwrap_or_default();
        let game_scores = state.get("gameScores").and_then(Value::as_array).cloned().unwrap_or_default();
        let leg = int(state.get("set")).max(0) * 100 + int(state.get("leg")).max(1);
        for turn in state.get("turns").and_then(Value::as_array).into_iter().flatten() {
            let pid = turn.get("playerId").map(py_str).unwrap_or_default();
            let Some(p) = players.iter().position(|x| x.get("id").map(py_str).as_deref() == Some(pid.as_str())) else { continue };
            let tid = turn.get("id").map(py_str).unwrap_or_default();
            if tid.is_empty() {
                continue;
            }
            let throws = turn.get("throws").and_then(Value::as_array).cloned().unwrap_or_default();
            let busted = turn.get("busted") == Some(&json!(true));
            // Score left when the visit began: what Autodarts shows before the first dart (and after a
            // bust, which puts it back), else what is left plus the points of the visit so far
            let start = match self.turn_start.get(&tid) {
                Some(s) => *s,
                None if !x01 => 0,
                None => {
                    let s = if throws.is_empty() || busted { int(game_scores.get(p)) } else { int(turn.get("score")) + int(turn.get("points")) };
                    self.turn_start.insert(tid.clone(), s);
                    s
                }
            };
            let mut left = start;
            for (k, t) in throws.iter().enumerate() {
                let seg = t.get("segment").cloned().unwrap_or(Value::Null);
                let coords = t.get("coords").filter(|c| c.is_object());
                let xy = |key: &str| coords.and_then(|c| c.get(key)).and_then(Value::as_f64).map(|v| (v * 1000.0).round() / 1000.0);
                let key = t.get("id").map(py_str).filter(|s| !s.is_empty()).unwrap_or_else(|| format!("{}:{}", tid, k));
                let mut d = Dart {
                    x: xy("x"),
                    y: xy("y"),
                    n: int(seg.get("number")),
                    m: int(seg.get("multiplier")),
                    r: if x01 { left } else { 0 },
                    l: leg,
                    v: int(turn.get("round")).max(1),
                    i: k as i64,
                    q: 0,
                    b: busted,
                };
                left -= d.points();
                match self.darts.get_mut(&key) {
                    Some(old) => {
                        d.l = old.dart.l;
                        d.q = old.dart.q;
                        old.dart = d;
                    }
                    None => {
                        self.seq += 1;
                        d.q = self.seq;
                        self.darts.insert(key, Noted { player: pid.clone(), turn: tid.clone(), dart: d });
                    }
                }
            }
            // A dart taken back in Autodarts disappears from the visit
            let n = throws.len() as i64;
            self.darts.retain(|_, x| x.turn != tid || x.dart.i < n);
        }
    }

    /// The darts of one player (Autodarts player id) in the order they were thrown
    pub fn of(&self, player: &str) -> Vec<Dart> {
        let mut v: Vec<Dart> = self.darts.values().filter(|x| x.player == player).map(|x| x.dart.clone()).collect();
        v.sort_by_key(|d| d.q);
        v
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Game {
    /// The Autodarts match id, so a game sent twice is stored once
    pub id: String,
    /// When it ended (unix seconds)
    pub at: i64,
    #[serde(default)]
    pub board: String,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub variant: String,
    #[serde(default)]
    pub base: i64,
    #[serde(default)]
    pub in_mode: String,
    #[serde(default)]
    pub out_mode: String,
    #[serde(default)]
    pub legs: i64,
    #[serde(default)]
    pub sets: i64,
    pub players: Vec<GamePlayer>,
}

impl Game {
    pub fn is_x01(&self) -> bool {
        self.variant.eq_ignore_ascii_case("x01")
    }
    /// Games with a bot are listed but don't count for stats or head-to-head
    pub fn has_bot(&self) -> bool {
        self.players.iter().any(|p| p.bot)
    }
    fn counts(&self) -> bool {
        self.is_x01() && !self.has_bot()
    }
}

fn num(v: Option<&Value>) -> f64 {
    match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn int(v: Option<&Value>) -> i64 {
    num(v) as i64
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// A player's name in a match (account players by their account name)
pub fn player_name(p: &Value) -> String {
    let n = p.get("name").map(py_str).unwrap_or_default();
    if !n.trim().is_empty() {
        return n.trim().to_string();
    }
    p.get("user").and_then(|u| u.get("name")).map(py_str).unwrap_or_default().trim().to_string()
}

/// Best finish and fewest darts per player of the legs seen so far in a match. Autodarts only keeps
/// the current leg's numbers, so the board notes them while each leg is on screen.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LegBests {
    pub finish: Vec<i64>,
    pub darts: Vec<i64>,
}

impl LegBests {
    pub fn note(&mut self, state: &Obj) {
        let stats = state.get("stats").and_then(Value::as_array).cloned().unwrap_or_default();
        if self.finish.len() < stats.len() {
            self.finish.resize(stats.len(), 0);
            self.darts.resize(stats.len(), 0);
        }
        for (i, s) in stats.iter().enumerate() {
            let Some(leg) = s.get("legStats").filter(|l| l.is_object()) else { continue };
            if int(leg.get("checkoutsHit")) < 1 {
                continue;
            }
            let finish = int(leg.get("checkoutPoints"));
            let darts = int(leg.get("dartsThrown"));
            self.finish[i] = self.finish[i].max(finish);
            if darts > 0 && (self.darts[i] == 0 || darts < self.darts[i]) {
                self.darts[i] = darts;
            }
        }
    }
}

/// Highest checkout and fewest darts in a won leg, from one player's X01 darts (0 when none)
pub fn leg_bests_from(darts: &[Dart]) -> (i64, i64) {
    let (mut finish, mut fewest) = (0, 0);
    for d in darts.iter().filter(|d| d.r > 0 && !d.b && d.m == 2 && d.r == d.points()) {
        let start = darts.iter().find(|e| e.l == d.l && e.v == d.v && e.i == 0).map_or(d.r, |e| e.r);
        finish = finish.max(start);
        let n = darts.iter().filter(|e| e.l == d.l).count() as i64;
        if fewest == 0 || n < fewest {
            fewest = n;
        }
    }
    (finish, fewest)
}

/// Raises best checkout / best leg to what the saved darts show (games saved before v0.47.0 have none)
pub fn bests_from_darts(players: &mut [GamePlayer]) {
    for p in players.iter_mut() {
        let (finish, darts) = leg_bests_from(&p.throws);
        p.best_checkout = p.best_checkout.max(finish);
        if darts > 0 && (p.best_leg == 0 || darts < p.best_leg) {
            p.best_leg = darts;
        }
    }
}

/// The finished match as a club game; None while it isn't finished or has no players
pub fn game_from_state(state: &Obj, bests: &LegBests, log: &DartLog, board: &str, node: &str, at: i64) -> Option<Game> {
    if !crate::autodarts::is_match_over(state) {
        return None;
    }
    let id = state.get("id").map(py_str).filter(|s| !s.is_empty())?;
    let players = state.get("players").and_then(Value::as_array)?;
    if players.is_empty() {
        return None;
    }
    let scores = state.get("scores").and_then(Value::as_array).cloned().unwrap_or_default();
    let stats = state.get("stats").and_then(Value::as_array).cloned().unwrap_or_default();
    let settings = state.get("settings").and_then(Value::as_object).cloned().unwrap_or_default();
    let winner = crate::tournament::agent::winner_pos(state);
    let same_match = log.match_id == id;
    let mut out = Vec::new();
    for (i, p) in players.iter().enumerate() {
        let ms = stats.get(i).and_then(|s| s.get("matchStats")).cloned().unwrap_or(Value::Null);
        let m = |k: &str| ms.get(k);
        let sc = scores.get(i);
        out.push(GamePlayer {
            name: player_name(p),
            member: String::new(),
            bot: p.get("cpuPPR").map_or(false, |v| !v.is_null()),
            won: winner == Some(i),
            legs: int(sc.and_then(|s| s.get("legs"))),
            sets: int(sc.and_then(|s| s.get("sets"))),
            score: num(m("score")),
            darts: int(m("dartsThrown")),
            average: round2(num(m("average"))),
            first9: round2(num(m("first9Average"))),
            checkouts: int(m("checkouts")),
            checkouts_hit: int(m("checkoutsHit")),
            t180: int(m("total180")),
            t140: int(m("plus140")) + int(m("plus170")),
            t100: int(m("plus100")),
            best_checkout: bests.finish.get(i).copied().unwrap_or(0),
            best_leg: bests.darts.get(i).copied().unwrap_or(0),
            avg170: round2(num(m("averageUntil170"))),
            throws: if same_match { log.of(&p.get("id").map(py_str).unwrap_or_default()) } else { Vec::new() },
        });
    }
    // Checkouts and short legs from the darts too: the leg stats may miss the deciding leg
    bests_from_darts(&mut out);
    // A winner's deciding leg can arrive only in this last frame
    if let Some(w) = winner {
        let best_other = out.iter().enumerate().filter(|(j, _)| *j != w).map(|(_, p)| p.legs).max().unwrap_or(0);
        if out.len() > 1 && int(state.get("sets")) <= 1 && out[w].legs <= best_other {
            out[w].legs += 1;
        }
    }
    Some(Game {
        id,
        at,
        board: board.into(),
        node: node.into(),
        variant: state.get("variant").map(py_str).unwrap_or_default(),
        base: int(settings.get("baseScore")),
        in_mode: settings.get("inMode").map(py_str).unwrap_or_default(),
        out_mode: settings.get("outMode").map(py_str).unwrap_or_default(),
        legs: int(state.get("legs")),
        sets: int(state.get("sets")),
        players: out,
    })
}

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Totals {
    games: usize,
    wins: usize,
    score: f64,
    darts: i64,
    first9: f64,
    first9_n: usize,
    checkouts: i64,
    hit: i64,
    t180: i64,
    t140: i64,
    t100: i64,
    best_checkout: i64,
    best_leg: i64,
    last_at: i64,
}

impl Totals {
    fn add(&mut self, p: &GamePlayer, at: i64) {
        self.games += 1;
        self.wins += p.won as usize;
        self.score += p.score;
        self.darts += p.darts;
        if p.first9 > 0.0 {
            self.first9 += p.first9;
            self.first9_n += 1;
        }
        self.checkouts += p.checkouts;
        self.hit += p.checkouts_hit;
        self.t180 += p.t180;
        self.t140 += p.t140;
        self.t100 += p.t100;
        self.best_checkout = self.best_checkout.max(p.best_checkout);
        if p.best_leg > 0 && (self.best_leg == 0 || p.best_leg < self.best_leg) {
            self.best_leg = p.best_leg;
        }
        self.last_at = self.last_at.max(at);
    }
    fn average(&self) -> f64 {
        if self.darts > 0 { round2(self.score / self.darts as f64 * 3.0) } else { 0.0 }
    }
    fn json(&self) -> Value {
        json!({
            "games": self.games, "wins": self.wins,
            "win_pct": if self.games > 0 { round2(self.wins as f64 * 100.0 / self.games as f64) } else { 0.0 },
            "average": self.average(),
            "first9": if self.first9_n > 0 { round2(self.first9 / self.first9_n as f64) } else { 0.0 },
            "checkout_pct": if self.checkouts > 0 { round2(self.hit as f64 * 100.0 / self.checkouts as f64) } else { 0.0 },
            "t180": self.t180, "t140": self.t140, "t100": self.t100,
            "best_checkout": self.best_checkout, "best_leg": self.best_leg, "last_at": self.last_at,
        })
    }
}

/// Who a game player is in the stats: their member id, or their name when unassigned
fn who(p: &GamePlayer, members: &BTreeMap<String, String>) -> String {
    if !p.member.is_empty() && members.contains_key(&p.member) { p.member.clone() } else { format!("name:{}", p.name.to_uppercase()) }
}

/// The short summary shown on member cards and in the Studio
pub fn summaries(games: &[Game], members: &BTreeMap<String, String>) -> BTreeMap<String, Value> {
    let mut t: BTreeMap<String, Totals> = BTreeMap::new();
    for g in games.iter().filter(|g| g.counts()) {
        for p in g.players.iter().filter(|p| members.contains_key(&p.member) && p.darts > 0) {
            t.entry(p.member.clone()).or_default().add(p, g.at);
        }
    }
    let ratings = super::coach::ratings(games, members);
    t.into_iter()
        .map(|(k, v)| {
            let mut j = v.json();
            if let Some((r, n)) = ratings.get(&k) {
                j["rating"] = json!(r.round());
                j["rating_games"] = json!(n);
            }
            (k, j)
        })
        .collect()
}

/// Everything the member page shows
pub fn member_stats(games: &[Game], member: &str, members: &BTreeMap<String, String>, from: i64) -> Value {
    let mut tot = Totals::default();
    let mut form = Vec::new();
    let mut recent = Vec::new();
    let mut h2h: BTreeMap<String, (String, usize, usize)> = BTreeMap::new();
    let mut boards: BTreeMap<String, usize> = BTreeMap::new();
    for g in games.iter().filter(|g| g.at >= from) {
        let Some(me) = g.players.iter().position(|p| p.member == member) else { continue };
        let p = &g.players[me];
        let others: Vec<&GamePlayer> = g.players.iter().enumerate().filter(|(i, _)| *i != me).map(|(_, o)| o).collect();
        let counts = g.counts() && p.darts > 0;
        if counts {
            tot.add(p, g.at);
            form.push(json!({"at": g.at, "average": p.average, "won": p.won}));
            *boards.entry(g.board.clone()).or_default() += 1;
            for o in &others {
                let key = who(o, members);
                let name = members.get(&o.member).cloned().unwrap_or_else(|| o.name.clone());
                let e = h2h.entry(key).or_insert((name, 0, 0));
                e.1 += 1;
                e.2 += p.won as usize;
            }
        }
        recent.push(json!({
            "id": g.id, "at": g.at, "board": g.board, "won": p.won, "counts": counts, "bot": g.has_bot(), "variant": g.variant,
            "score": [if g.sets > 0 { p.sets } else { p.legs }, others.iter().map(|o| if g.sets > 0 { o.sets } else { o.legs }).max().unwrap_or(0)],
            "opponents": others.iter().map(|o| members.get(&o.member).cloned().unwrap_or_else(|| o.name.clone())).collect::<Vec<_>>(),
            "average": p.average, "t180": p.t180, "best_checkout": p.best_checkout,
        }));
    }
    let n = form.len();
    let form: Vec<Value> = form.into_iter().skip(n.saturating_sub(FORM_GAMES)).collect();
    let n = recent.len();
    let mut recent: Vec<Value> = recent.into_iter().skip(n.saturating_sub(RECENT_GAMES)).collect();
    recent.reverse();
    let mut h2h: Vec<Value> = h2h.into_iter().map(|(k, (name, games, wins))| json!({"key": k, "name": name, "games": games, "wins": wins})).collect();
    h2h.sort_by_key(|v| std::cmp::Reverse(v["games"].as_u64().unwrap_or(0)));
    let mut boards: Vec<Value> = boards.into_iter().map(|(b, n)| json!({"board": b, "games": n})).collect();
    boards.sort_by_key(|v| std::cmp::Reverse(v["games"].as_u64().unwrap_or(0)));
    json!({"totals": tot.json(), "form": form, "recent": recent, "head_to_head": h2h, "boards": boards})
}

/// One table per stat, best first. Averages need MIN_GAMES games; counts and records don't.
pub fn leaderboards(games: &[Game], members: &BTreeMap<String, String>, from: i64) -> Value {
    let mut t: BTreeMap<String, Totals> = BTreeMap::new();
    for g in games.iter().filter(|g| g.counts() && g.at >= from) {
        for p in g.players.iter().filter(|p| members.contains_key(&p.member) && p.darts > 0) {
            t.entry(p.member.clone()).or_default().add(p, g.at);
        }
    }
    // Ratings are all-time; the dart numbers come from every game in the period (bot games too)
    let ratings = super::coach::ratings(games, members);
    let mut accs: BTreeMap<String, super::coach::Acc> = BTreeMap::new();
    for g in games.iter().filter(|g| g.at >= from) {
        for (i, p) in g.players.iter().enumerate().filter(|(_, p)| members.contains_key(&p.member)) {
            accs.entry(p.member.clone()).or_default().add_game(g, i);
        }
    }
    let rows: Vec<(String, Value)> = t
        .iter()
        .map(|(k, v)| {
            let mut j = v.json();
            let rating = ratings.get(k).filter(|(_, n)| *n >= super::coach::RATING_PROVISIONAL);
            j["rating"] = json!(rating.map(|r| r.0.round()));
            let a = accs.get(k);
            j["spread"] = json!(a.and_then(|a| a.group_radius()).map(|r| (r * 10.0).round() / 10.0));
            j["treble_pct"] = json!(a.and_then(|a| a.treble_pct()));
            j["double_pct"] = json!(a.and_then(|a| a.double_pct()));
            (k.clone(), j)
        })
        .collect();
    let table = |key: &str, min_games: usize, lower_better: bool| -> Value {
        let mut r: Vec<(&String, f64, usize)> = rows
            .iter()
            .filter(|(_, v)| v["games"].as_u64().unwrap_or(0) as usize >= min_games)
            .map(|(k, v)| (k, v[key].as_f64().unwrap_or(0.0), v["games"].as_u64().unwrap_or(0) as usize))
            .filter(|(_, x, _)| *x > 0.0)
            .collect();
        r.sort_by(|a, b| {
            let o = a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal);
            (if lower_better { o } else { o.reverse() }).then(b.2.cmp(&a.2))
        });
        json!(r.into_iter().take(10).map(|(k, x, g)| json!({"member": k, "name": members.get(k), "value": x, "games": g})).collect::<Vec<_>>())
    };
    json!({
        "average": table("average", MIN_GAMES, false),
        "first9": table("first9", MIN_GAMES, false),
        "checkout_pct": table("checkout_pct", MIN_GAMES, false),
        "win_pct": table("win_pct", MIN_GAMES, false),
        "t180": table("t180", 1, false),
        "best_checkout": table("best_checkout", 1, false),
        "best_leg": table("best_leg", 1, true),
        "games": table("games", 1, false),
        "rating": table("rating", 1, false),
        "spread": table("spread", 1, true),
        "treble_pct": table("treble_pct", 1, false),
        "double_pct": table("double_pct", 1, false),
        "min_games": MIN_GAMES,
        // Every member who played in the period, for the players table
        "rows": rows.iter().map(|(k, v)| {
            let mut r = v.clone();
            r["member"] = json!(k);
            r["name"] = json!(members.get(k));
            r
        }).collect::<Vec<_>>(),
    })
}

/// Names that played but aren't a member yet, most games first
pub fn unassigned(games: &[Game], members: &BTreeMap<String, String>, ignored: &[String]) -> Vec<Value> {
    let mut by: BTreeMap<String, (usize, i64, String)> = BTreeMap::new();
    for g in games {
        for p in g.players.iter().filter(|p| !p.bot && !members.contains_key(&p.member)) {
            let key = p.name.to_uppercase();
            if key.is_empty() || ignored.contains(&key) {
                continue;
            }
            let e = by.entry(key).or_insert((0, 0, g.board.clone()));
            e.0 += 1;
            if g.at >= e.1 {
                e.1 = g.at;
                e.2 = g.board.clone();
            }
        }
    }
    let mut out: Vec<Value> = by.into_iter().map(|(n, (games, at, board))| json!({"name": n, "games": games, "last_at": at, "board": board})).collect();
    out.sort_by_key(|v| (std::cmp::Reverse(v["games"].as_u64().unwrap_or(0)), std::cmp::Reverse(v["last_at"].as_i64().unwrap_or(0))));
    out
}
