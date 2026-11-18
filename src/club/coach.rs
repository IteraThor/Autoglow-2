//! The coach: what a member's darts say about their game, and what to work on.
//!
//! Everything is computed from the stored games, like the other stats. Dart-level numbers need
//! games from v0.47.0 on (they carry every dart); trends from match totals use every game.
//! The ideas behind each number (grouping first, the direction of the miss, aiming by skill,
//! doubles practice, good leaves, first 9 vs the finish) come from darts coaching and from
//! Tibshirani, Price & Taylor, "A Statistician Plays Darts" (aim by a Gaussian spread).

use super::stats::{Dart, Game, MIN_GAMES};
use chrono::{Datelike, TimeZone};
use serde_json::{json, Value};
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------

/// Board coordinates are 1.0 at the outer edge of the double ring
pub const BOARD_MM: f64 = 170.0;
/// Segments clockwise from the top
pub const ORDER: [i64; 20] = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
const R_BULL: f64 = 6.35;
const R_25: f64 = 15.9;
const R_T_IN: f64 = 99.0;
const R_T_OUT: f64 = 107.0;
const R_D_IN: f64 = 162.0;
const R_D_OUT: f64 = 170.0;
/// Scores from 159 to 170 that no three darts can finish
pub const BOGEYS: [i64; 7] = [159, 162, 163, 165, 166, 168, 169];
/// Leaves most players like to have for their double
const GOOD_LEAVES: [i64; 7] = [40, 32, 16, 36, 24, 20, 8];

/// Number and multiplier at a point in mm (x right, y up towards the 20)
pub fn segment_at(x: f64, y: f64) -> (i64, i64) {
    let r = (x * x + y * y).sqrt();
    if r <= R_BULL {
        return (25, 2);
    }
    if r <= R_25 {
        return (25, 1);
    }
    if r > R_D_OUT {
        return (0, 0);
    }
    let deg = x.atan2(y).to_degrees().rem_euclid(360.0);
    let n = ORDER[(((deg + 9.0) / 18.0).floor() as usize) % 20];
    let m = if (R_T_IN..=R_T_OUT).contains(&r) {
        3
    } else if r >= R_D_IN {
        2
    } else {
        1
    };
    (n, m)
}

fn points_at(x: f64, y: f64) -> f64 {
    let (n, m) = segment_at(x, y);
    (n * m) as f64
}

/// Middle of a bed in mm: trebles and doubles in the middle of their ring, singles in the outer single
pub fn target_point(n: i64, m: i64) -> (f64, f64) {
    if n == 25 {
        return (0.0, 0.0);
    }
    let Some(i) = ORDER.iter().position(|x| *x == n) else { return (0.0, 0.0) };
    let a = (i as f64 * 18.0).to_radians();
    let r = match m {
        3 => (R_T_IN + R_T_OUT) / 2.0,
        2 => (R_D_IN + R_D_OUT) / 2.0,
        _ => (R_T_OUT + R_D_IN) / 2.0,
    };
    (r * a.sin(), r * a.cos())
}

/// The two numbers next to a number on the board
fn neighbours(n: i64) -> [i64; 2] {
    let Some(i) = ORDER.iter().position(|x| *x == n) else { return [0, 0] };
    [ORDER[(i + 19) % 20], ORDER[(i + 1) % 20]]
}

pub fn bed_label(n: i64, m: i64) -> String {
    match (n, m) {
        (25, 2) => "Bull".into(),
        (25, _) => "25".into(),
        (0, _) | (_, 0) => "Outside".into(),
        (n, 3) => format!("T{}", n),
        (n, 2) => format!("D{}", n),
        (n, _) => format!("S{}", n),
    }
}

/// The double a dart on this score is meant for (25 = bull), in a double-out game
pub fn double_target(left: i64) -> Option<i64> {
    match left {
        50 => Some(25),
        2..=40 if left % 2 == 0 => Some(left / 2),
        _ => None,
    }
}

fn mm(d: &Dart) -> Option<(f64, f64)> {
    Some((d.x? * BOARD_MM, d.y? * BOARD_MM))
}

fn r1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn r2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

fn pct(a: usize, b: usize) -> Option<f64> {
    (b > 0).then(|| r1(a as f64 * 100.0 / b as f64))
}

// ---------------------------------------------------------------------------------------------
// Aim: expected points per dart for every aim point, for a player's spread
// ---------------------------------------------------------------------------------------------

const GRID_STEP: f64 = 2.0;
const GRID_HALF: i64 = 85; // 2 mm × 85 = 170 mm

fn kernel(sigma_mm: f64) -> Vec<f64> {
    let s = (sigma_mm / GRID_STEP).max(0.5);
    let reach = (s * 3.5).ceil() as i64;
    let mut k: Vec<f64> = (-reach..=reach).map(|i| (-((i * i) as f64) / (2.0 * s * s)).exp()).collect();
    let sum: f64 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    k
}

fn blur(src: &[f64], n: usize, k: &[f64], along_x: bool) -> Vec<f64> {
    let reach = (k.len() / 2) as i64;
    let mut out = vec![0.0; src.len()];
    for row in 0..n {
        for col in 0..n {
            let mut acc = 0.0;
            for (t, w) in k.iter().enumerate() {
                let o = t as i64 - reach;
                let (r, c) = if along_x { (row as i64, col as i64 + o) } else { (row as i64 + o, col as i64) };
                if r >= 0 && c >= 0 && (r as usize) < n && (c as usize) < n {
                    acc += w * src[r as usize * n + c as usize];
                }
            }
            out[row * n + col] = acc;
        }
    }
    out
}

/// Expected points per dart on a 2 mm grid (row 0 at the top), for a Gaussian spread of
/// sx (left-right) and sy (up-down) in mm around the aim point
pub struct AimMap {
    n: usize,
    ev: Vec<f64>,
}

impl AimMap {
    pub fn new(sx: f64, sy: f64) -> AimMap {
        // The grid reaches past the board so darts aimed near the edge can miss it
        let half = GRID_HALF + (sx.max(sy) * 3.5 / GRID_STEP).ceil() as i64;
        let n = (half * 2 + 1) as usize;
        let mut score = vec![0.0; n * n];
        for row in 0..n {
            for col in 0..n {
                let x = (col as i64 - half) as f64 * GRID_STEP;
                let y = (half - row as i64) as f64 * GRID_STEP;
                score[row * n + col] = points_at(x, y);
            }
        }
        let ev = blur(&blur(&score, n, &kernel(sx), true), n, &kernel(sy), false);
        AimMap { n, ev }
    }
    fn half(&self) -> i64 {
        (self.n as i64 - 1) / 2
    }
    pub fn at(&self, x: f64, y: f64) -> f64 {
        let h = self.half();
        let col = ((x / GRID_STEP).round() as i64 + h).clamp(0, self.n as i64 - 1) as usize;
        let row = ((h as f64 - y / GRID_STEP).round() as i64).clamp(0, self.n as i64 - 1) as usize;
        self.ev[row * self.n + col]
    }
    /// The best aim point on the board: (x, y, expected points)
    pub fn best(&self) -> (f64, f64, f64) {
        let h = self.half();
        let mut best = (0.0, 0.0, -1.0);
        for row in 0..self.n {
            for col in 0..self.n {
                let x = (col as i64 - h) as f64 * GRID_STEP;
                let y = (h - row as i64) as f64 * GRID_STEP;
                if x * x + y * y > R_D_OUT * R_D_OUT {
                    continue;
                }
                let v = self.ev[row * self.n + col];
                if v > best.2 {
                    best = (x, y, v);
                }
            }
        }
        best
    }
    /// A coarse picture of the map for the page: `cells`×`cells` values over the board square
    pub fn coarse(&self, cells: usize) -> Vec<f64> {
        let step = 2.0 * R_D_OUT / cells as f64;
        let mut out = Vec::with_capacity(cells * cells);
        for row in 0..cells {
            for col in 0..cells {
                let x = -R_D_OUT + (col as f64 + 0.5) * step;
                let y = R_D_OUT - (row as f64 + 0.5) * step;
                out.push(r1(self.at(x, y)));
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------------------------
// Gathering a member's darts
// ---------------------------------------------------------------------------------------------

/// What kind of dart it was, for the heat map
pub const KIND_SCORING: u8 = 0;
pub const KIND_DOUBLE: u8 = 1;
pub const KIND_OTHER: u8 = 2;

#[derive(Clone, Default)]
struct DoubleRow {
    attempts: usize,
    hits: usize,
    inside: usize,
    outside: usize,
    /// Misses into another number: number → count
    wide: BTreeMap<i64, usize>,
}

/// Dart-level numbers of one member over some games
#[derive(Clone, Default)]
pub struct Acc {
    pub games: usize,
    pub darts: usize,
    with_xy: usize,
    // Grouping: pooled spread around each scoring visit's own centre
    sxx: f64,
    syy: f64,
    dof: f64,
    spread_visits: usize,
    // Drift of T20 visits from the middle of T20
    dx: f64,
    dy: f64,
    drift_n: f64,
    // Scoring darts (X01, more than 170 left)
    scoring: usize,
    scoring_pts: i64,
    trebles: usize,
    t20: usize,
    bed20: usize,
    beside20: usize,
    treble_by_dart: [(usize, usize); 3],
    // Doubles (double out)
    doubles: BTreeMap<i64, DoubleRow>,
    first_at_double: (usize, usize),
    later_at_double: (usize, usize),
    checkouts: usize,
    // Leaves
    range_leaves: usize,
    bogey_leaves: usize,
    setup_leaves: usize,
    odd_leaves: usize,
    good_leaves: usize,
    // Scoring visits by band: <60, 60+, 100+, 140+, 180
    bands: [usize; 5],
    // Scoring per leg of the match (1..5+): points, darts
    by_leg: [(i64, usize); 5],
    // Darts at a double with the opponent close to a finish (≤ 100 left), and without
    pressure: (usize, usize),
    calm: (usize, usize),
    deciding: (usize, usize),
    other_legs: (usize, usize),
    pub heat: Vec<(f64, f64, u8, i64)>,
}

/// The visits of a list of darts, in order
fn visits(darts: &[Dart]) -> Vec<&[Dart]> {
    let mut out = Vec::new();
    let mut start = 0;
    for i in 1..=darts.len() {
        if i == darts.len() || (darts[i].l, darts[i].v) != (darts[start].l, darts[start].v) {
            if i > start {
                out.push(&darts[start..i]);
            }
            start = i;
        }
    }
    out
}

/// Who won each leg (set*100+leg → player index), from the dart that left 0
pub fn leg_winners(g: &Game) -> BTreeMap<i64, usize> {
    let mut w = BTreeMap::new();
    if !g.is_x01() {
        return w;
    }
    for (p, gp) in g.players.iter().enumerate() {
        for d in &gp.throws {
            if !d.b && d.r > 0 && d.r - d.points() == 0 {
                w.insert(d.l, p);
            }
        }
    }
    w
}

/// Score left of a player just before match order q in leg l (None before their first dart)
fn left_before(darts: &[Dart], l: i64, q: u64) -> Option<i64> {
    let mut last: Option<&Dart> = None;
    let mut visit_start: Option<&Dart> = None;
    for d in darts.iter().filter(|d| d.l == l && d.q < q) {
        if visit_start.map_or(true, |s| s.v != d.v) {
            visit_start = Some(d);
        }
        last = Some(d);
    }
    let d = last?;
    Some(if d.b { visit_start.map_or(d.r, |s| s.r) } else { d.r - d.points() })
}

impl Acc {
    pub fn add_game(&mut self, g: &Game, me: usize) {
        let Some(p) = g.players.get(me) else { return };
        if p.throws.is_empty() {
            return;
        }
        self.games += 1;
        self.darts += p.throws.len();
        let x01 = g.is_x01();
        let double_out = x01 && g.out_mode.eq_ignore_ascii_case("double");
        let legs_order: Vec<i64> = {
            let mut l: Vec<i64> = p.throws.iter().map(|d| d.l).collect();
            l.dedup();
            l
        };
        // Deciding legs: both players one leg (in that set) from winning it
        let winners = leg_winners(g);
        let mut deciding: Vec<i64> = Vec::new();
        if g.players.len() == 2 && g.legs > 1 {
            let mut won: BTreeMap<(i64, usize), i64> = BTreeMap::new();
            for (l, w) in &winners {
                let set = l / 100;
                if won.get(&(set, 0)).copied().unwrap_or(0) == g.legs - 1 && won.get(&(set, 1)).copied().unwrap_or(0) == g.legs - 1 {
                    deciding.push(*l);
                }
                *won.entry((set, *w)).or_default() += 1;
            }
        }
        let opponent = (g.players.len() == 2).then(|| &g.players[1 - me].throws);
        for visit in visits(&p.throws) {
            let start = visit[0].r;
            let scoring_visit = x01 && start > 170;
            // Grouping: the darts of one scoring visit share one aim
            let pts: Vec<(f64, f64)> = visit.iter().filter(|d| x01 && d.r > 170).filter_map(mm).collect();
            if scoring_visit && pts.len() >= 2 {
                let k = pts.len() as f64;
                let (mx, my) = (pts.iter().map(|p| p.0).sum::<f64>() / k, pts.iter().map(|p| p.1).sum::<f64>() / k);
                // A dart far off its group is a different aim (a cover shot), not spread
                if pts.iter().all(|p| ((p.0 - mx).powi(2) + (p.1 - my).powi(2)).sqrt() < 90.0) {
                    self.sxx += pts.iter().map(|p| (p.0 - mx).powi(2)).sum::<f64>();
                    self.syy += pts.iter().map(|p| (p.1 - my).powi(2)).sum::<f64>();
                    self.dof += k - 1.0;
                    self.spread_visits += 1;
                    // Drift: a group around the top of the board is aimed at T20
                    let ang = mx.atan2(my).to_degrees();
                    let rad = (mx * mx + my * my).sqrt();
                    if ang.abs() <= 27.0 && (50.0..=165.0).contains(&rad) {
                        let (tx, ty) = target_point(20, 3);
                        self.dx += (mx - tx) * k;
                        self.dy += (my - ty) * k;
                        self.drift_n += k;
                    }
                }
            }
            if scoring_visit && visit.len() == 3 && !visit[0].b {
                let total: i64 = visit.iter().map(Dart::points).sum();
                let band = match total {
                    180 => 4,
                    140..=179 => 3,
                    100..=139 => 2,
                    60..=99 => 1,
                    _ => 0,
                };
                self.bands[band] += 1;
            }
            // Leaves: where the visit ended
            if double_out && !visit[0].b {
                let end = start - visit.iter().map(Dart::points).sum::<i64>();
                if end > 0 {
                    if start > 170 && end <= 170 {
                        self.range_leaves += 1;
                        if BOGEYS.contains(&end) {
                            self.bogey_leaves += 1;
                        }
                    }
                    if start > 40 && end <= 40 {
                        self.setup_leaves += 1;
                        if end % 2 == 1 {
                            self.odd_leaves += 1;
                        }
                        if GOOD_LEAVES.contains(&end) {
                            self.good_leaves += 1;
                        }
                    }
                }
            }
            let mut first_double_in_visit = true;
            for d in visit {
                let xy = mm(d);
                if xy.is_some() {
                    self.with_xy += 1;
                }
                let mut kind = KIND_OTHER;
                if x01 && d.r > 170 {
                    kind = KIND_SCORING;
                    self.scoring += 1;
                    self.scoring_pts += d.points();
                    let treble = d.m == 3;
                    self.trebles += treble as usize;
                    self.t20 += (d.n == 20 && treble) as usize;
                    self.bed20 += (d.n == 20) as usize;
                    self.beside20 += (d.n == 1 || d.n == 5) as usize;
                    if let Some(t) = self.treble_by_dart.get_mut(d.i as usize) {
                        t.0 += treble as usize;
                        t.1 += 1;
                    }
                    let leg_i = legs_order.iter().position(|l| *l == d.l).unwrap_or(0).min(4);
                    self.by_leg[leg_i].0 += d.points();
                    self.by_leg[leg_i].1 += 1;
                }
                if double_out {
                    if let Some(target) = double_target(d.r) {
                        kind = KIND_DOUBLE;
                        let hit = d.n == target && d.m == 2;
                        let row = self.doubles.entry(target).or_default();
                        row.attempts += 1;
                        if hit {
                            row.hits += 1;
                            self.checkouts += 1;
                        } else if d.n == 0 || d.m == 0 {
                            row.outside += 1;
                        } else if d.n == target {
                            row.inside += 1;
                        } else {
                            *row.wide.entry(d.n).or_default() += 1;
                        }
                        let slot = if first_double_in_visit { &mut self.first_at_double } else { &mut self.later_at_double };
                        slot.0 += hit as usize;
                        slot.1 += 1;
                        first_double_in_visit = false;
                        if let Some(op) = opponent {
                            let close = left_before(op, d.l, d.q).map_or(false, |r| r <= 100);
                            let slot = if close { &mut self.pressure } else { &mut self.calm };
                            slot.0 += hit as usize;
                            slot.1 += 1;
                        }
                        if g.legs > 1 && g.players.len() == 2 {
                            let slot = if deciding.contains(&d.l) { &mut self.deciding } else { &mut self.other_legs };
                            slot.0 += hit as usize;
                            slot.1 += 1;
                        }
                    }
                }
                if let Some((x, y)) = xy {
                    self.heat.push((x / BOARD_MM, y / BOARD_MM, kind, g.at));
                }
            }
        }
    }

    /// Spread around the group centre in mm: (left-right, up-down); None with too few visits
    pub fn spread(&self) -> Option<(f64, f64)> {
        (self.spread_visits >= MIN_SPREAD_VISITS && self.dof > 0.0).then(|| ((self.sxx / self.dof).sqrt(), (self.syy / self.dof).sqrt()))
    }

    /// Half the darts land within this many mm of where the visit's group centres
    pub fn group_radius(&self) -> Option<f64> {
        self.spread().map(|(sx, sy)| ((sx * sx + sy * sy) / 2.0).sqrt() * 1.1774)
    }

    pub fn treble_pct(&self) -> Option<f64> {
        (self.scoring >= MIN_SCORING_DARTS).then(|| pct(self.trebles, self.scoring)).flatten()
    }

    pub fn double_pct(&self) -> Option<f64> {
        let att: usize = self.doubles.values().map(|r| r.attempts).sum();
        (att >= MIN_DOUBLE_DARTS).then(|| pct(self.checkouts, att)).flatten()
    }

    fn drift(&self) -> Option<(f64, f64)> {
        (self.drift_n >= 30.0).then(|| (self.dx / self.drift_n, self.dy / self.drift_n))
    }

    /// `full` adds the heat points and the aim map
    pub fn json(&self, full: bool) -> Value {
        let att: usize = self.doubles.values().map(|r| r.attempts).sum();
        let spread = self.spread();
        let aim = spread.filter(|_| full).map(|(sx, sy)| aim_json(sx, sy));
        let mut doubles: Vec<Value> = self
            .doubles
            .iter()
            .map(|(t, r)| {
                let mut wide: Vec<(i64, usize)> = r.wide.iter().map(|(n, c)| (*n, *c)).collect();
                wide.sort_by_key(|x| std::cmp::Reverse(x.1));
                json!({
                    "target": t, "label": if *t == 25 { "Bull".to_string() } else { format!("D{}", t) },
                    "attempts": r.attempts, "hits": r.hits, "pct": pct(r.hits, r.attempts),
                    "inside": r.inside, "outside": r.outside,
                    "wide": wide.iter().map(|(n, c)| json!({"number": n, "count": c, "beside": neighbours(*t).contains(n)})).collect::<Vec<_>>(),
                })
            })
            .collect();
        doubles.sort_by_key(|d| std::cmp::Reverse(d["attempts"].as_u64().unwrap_or(0)));
        let by_leg: Vec<Value> = self.by_leg.iter().enumerate().filter(|(_, (_, n))| *n > 0).map(|(i, (p, n))| json!({"leg": i + 1, "average": r2(*p as f64 * 3.0 / *n as f64), "darts": n})).collect();
        let heat: Vec<Value> = if full {
            let skip = self.heat.len().saturating_sub(HEAT_KEEP);
            self.heat[skip..].iter().map(|(x, y, k, _)| json!([r2_3(*x), r2_3(*y), k])).collect()
        } else {
            Vec::new()
        };
        json!({
            "games": self.games, "darts": self.darts, "with_coords": self.with_xy,
            "spread": spread.map(|(sx, sy)| json!({"x": r1(sx), "y": r1(sy), "radius": self.group_radius().map(r1), "visits": self.spread_visits})),
            "drift": self.drift().map(|(x, y)| json!({"x": r1(x), "y": r1(y)})),
            "scoring": {
                "darts": self.scoring,
                "average": (self.scoring > 0).then(|| r2(self.scoring_pts as f64 * 3.0 / self.scoring as f64)),
                "treble_pct": pct(self.trebles, self.scoring), "t20_pct": pct(self.t20, self.scoring),
                "bed20_pct": pct(self.bed20, self.scoring), "beside20_pct": pct(self.beside20, self.scoring),
                "treble_by_dart": self.treble_by_dart.iter().map(|(h, n)| pct(*h, *n)).collect::<Vec<_>>(),
            },
            "aim": aim,
            "doubles": {
                "attempts": att, "hits": self.checkouts, "pct": pct(self.checkouts, att),
                "darts_per_checkout": (self.checkouts > 0).then(|| r1(att as f64 / self.checkouts as f64)),
                "first_dart_pct": pct(self.first_at_double.0, self.first_at_double.1),
                "later_dart_pct": pct(self.later_at_double.0, self.later_at_double.1),
                "by_double": doubles,
                "pressure": {"hits": self.pressure.0, "attempts": self.pressure.1, "pct": pct(self.pressure.0, self.pressure.1)},
                "calm": {"hits": self.calm.0, "attempts": self.calm.1, "pct": pct(self.calm.0, self.calm.1)},
                "deciding": {"hits": self.deciding.0, "attempts": self.deciding.1, "pct": pct(self.deciding.0, self.deciding.1)},
                "other_legs": {"hits": self.other_legs.0, "attempts": self.other_legs.1, "pct": pct(self.other_legs.0, self.other_legs.1)},
            },
            "leaves": {
                "range": self.range_leaves, "bogey": self.bogey_leaves, "bogey_pct": pct(self.bogey_leaves, self.range_leaves),
                "setup": self.setup_leaves, "odd": self.odd_leaves, "odd_pct": pct(self.odd_leaves, self.setup_leaves),
                "good": self.good_leaves, "good_pct": pct(self.good_leaves, self.setup_leaves),
            },
            "visits": {"bands": self.bands, "total": self.bands.iter().sum::<usize>()},
            "by_leg": by_leg,
            "heat": heat,
        })
    }
}

fn r2_3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

const MIN_SPREAD_VISITS: usize = 10;
const MIN_SCORING_DARTS: usize = 60;
const MIN_DOUBLE_DARTS: usize = 10;
const HEAT_KEEP: usize = 3000;
const AIM_CELLS: usize = 34;

/// Expected points per dart at the usual targets and the best spot, for a spread
pub fn aim_json(sx: f64, sy: f64) -> Value {
    let map = AimMap::new(sx, sy);
    let (bx, by, bv) = map.best();
    let targets: Vec<Value> = [(20, 3), (19, 3), (18, 3), (25, 2)]
        .iter()
        .map(|(n, m)| {
            let (x, y) = target_point(*n, *m);
            json!({"label": bed_label(*n, *m), "x": r2_3(x / BOARD_MM), "y": r2_3(y / BOARD_MM), "points": r2(map.at(x, y))})
        })
        .collect();
    let (n, m) = segment_at(bx, by);
    json!({
        "best": {"x": r2_3(bx / BOARD_MM), "y": r2_3(by / BOARD_MM), "points": r2(bv), "label": bed_label(n, m)},
        "targets": targets,
        "cells": AIM_CELLS,
        "map": map.coarse(AIM_CELLS),
    })
}

// ---------------------------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------------------------

const RATING_START: f64 = 1500.0;
pub const RATING_PROVISIONAL: usize = 5;

/// A club rating (Elo) for every player from the match results, oldest game first.
/// Key: member id, or name:NAME for players who aren't members. Value: (rating, games).
pub fn ratings(games: &[Game], members: &BTreeMap<String, String>) -> BTreeMap<String, (f64, usize)> {
    let mut r: BTreeMap<String, (f64, usize)> = BTreeMap::new();
    let key = |p: &super::stats::GamePlayer| if !p.member.is_empty() && members.contains_key(&p.member) { p.member.clone() } else { format!("name:{}", p.name.to_uppercase()) };
    let mut list: Vec<&Game> = games.iter().filter(|g| g.is_x01() && !g.has_bot() && g.players.len() >= 2).collect();
    list.sort_by_key(|g| g.at);
    for g in list {
        let Some(w) = g.players.iter().position(|p| p.won) else { continue };
        let legs: i64 = g.players.iter().map(|p| if g.sets > 0 { p.sets } else { p.legs }).sum();
        let k = (16.0 + 4.0 * legs.clamp(1, 6) as f64) / (g.players.len() - 1) as f64;
        let wk = key(&g.players[w]);
        for (i, p) in g.players.iter().enumerate() {
            if i == w {
                continue;
            }
            let lk = key(p);
            let rw = r.get(&wk).map_or(RATING_START, |x| x.0);
            let rl = r.get(&lk).map_or(RATING_START, |x| x.0);
            let expected = 1.0 / (1.0 + 10f64.powf((rl - rw) / 400.0));
            let change = k * (1.0 - expected);
            r.entry(wk.clone()).or_insert((RATING_START, 0)).0 += change;
            r.entry(lk.clone()).or_insert((RATING_START, 0)).0 -= change;
        }
        for p in &g.players {
            r.entry(key(p)).or_insert((RATING_START, 0)).1 += 1;
        }
    }
    r
}

// ---------------------------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------------------------

#[derive(Default)]
struct Bucket {
    games: usize,
    score: f64,
    darts: i64,
    first9: f64,
    first9_n: usize,
    avg170: f64,
    avg170_n: usize,
    checkouts: i64,
    hits: i64,
    acc: Acc,
}

impl Bucket {
    fn add(&mut self, g: &Game, me: usize) {
        let p = &g.players[me];
        self.games += 1;
        self.score += p.score;
        self.darts += p.darts;
        if p.first9 > 0.0 {
            self.first9 += p.first9;
            self.first9_n += 1;
        }
        if p.avg170 > 0.0 {
            self.avg170 += p.avg170;
            self.avg170_n += 1;
        }
        self.checkouts += p.checkouts;
        self.hits += p.checkouts_hit;
        self.acc.add_game(g, me);
    }
    fn average(&self) -> Option<f64> {
        (self.darts > 0).then(|| r2(self.score / self.darts as f64 * 3.0))
    }
    fn json(&self) -> Value {
        json!({
            "games": self.games,
            "average": self.average(),
            "first9": (self.first9_n > 0).then(|| r2(self.first9 / self.first9_n as f64)),
            "avg170": (self.avg170_n > 0).then(|| r2(self.avg170 / self.avg170_n as f64)),
            "checkout_pct": (self.checkouts > 0).then(|| r1(self.hits as f64 * 100.0 / self.checkouts as f64)),
            "spread": self.acc.group_radius().map(r1),
            "treble_pct": self.acc.treble_pct(),
        })
    }
}

fn local(ts: i64) -> chrono::NaiveDate {
    chrono::Local.timestamp_opt(ts, 0).single().map(|t| t.date_naive()).unwrap_or_default()
}

fn start_of(d: chrono::NaiveDate) -> i64 {
    d.and_hms_opt(0, 0, 0).and_then(|t| chrono::Local.from_local_datetime(&t).earliest()).map_or(0, |t| t.timestamp())
}

fn month_start(d: chrono::NaiveDate) -> chrono::NaiveDate {
    d.with_day(1).unwrap_or(d)
}

/// Is this game one a member's stats count (X01 against people)?
fn counts(g: &Game, me: usize) -> bool {
    g.is_x01() && !g.has_bot() && g.players[me].darts > 0
}

// ---------------------------------------------------------------------------------------------
// The coach for one member
// ---------------------------------------------------------------------------------------------

/// Club-wide numbers to compare with: averages over members with enough games
fn club_numbers(games: &[Game], members: &BTreeMap<String, String>, from: i64) -> Value {
    let mut by: BTreeMap<&str, (Bucket, usize)> = BTreeMap::new();
    for g in games.iter().filter(|g| g.at >= from) {
        for (i, p) in g.players.iter().enumerate() {
            if !members.contains_key(&p.member) {
                continue;
            }
            let e = by.entry(p.member.as_str()).or_default();
            if counts(g, i) {
                e.0.add(g, i);
                e.1 += 1;
            } else {
                e.0.acc.add_game(g, i);
            }
        }
    }
    let ok: Vec<&Bucket> = by.values().filter(|(_, n)| *n >= MIN_GAMES).map(|(b, _)| b).collect();
    let mean = |f: &dyn Fn(&Bucket) -> Option<f64>| -> Option<f64> {
        let v: Vec<f64> = ok.iter().filter_map(|b| f(b)).collect();
        (!v.is_empty()).then(|| r2(v.iter().sum::<f64>() / v.len() as f64))
    };
    json!({
        "members": ok.len(),
        "average": mean(&|b| b.average()),
        "first9": mean(&|b| (b.first9_n > 0).then(|| b.first9 / b.first9_n as f64)),
        "checkout_pct": mean(&|b| (b.checkouts > 0).then(|| b.hits as f64 * 100.0 / b.checkouts as f64)),
        "spread": mean(&|b| b.acc.group_radius()),
        "treble_pct": mean(&|b| b.acc.treble_pct()),
        "double_pct": mean(&|b| b.acc.double_pct()),
    })
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64()
}

struct Tip {
    weight: f64,
    v: Value,
}

fn tip(weight: f64, kind: &str, id: &str, title: String, text: String, drill: &str, metric: Value) -> Tip {
    Tip { weight, v: json!({"kind": kind, "id": id, "title": title, "text": text, "drill": drill, "metric": metric}) }
}

fn metric(key: &str, label: &str, value: Option<f64>, unit: &str, better: &str) -> Value {
    json!({"key": key, "label": label, "value": value, "unit": unit, "better": better})
}

/// What to work on, strongest first, from rules tied to coaching advice; each needs enough darts
fn tips(totals: &Bucket, d: &Value, acc: &Acc, club: &Value) -> Vec<Value> {
    let mut out: Vec<Tip> = Vec::new();
    let co = totals.json()["checkout_pct"].as_f64();
    let club_co = num(&club["checkout_pct"]);
    let doubles = d["doubles"]["by_double"].as_array().cloned().unwrap_or_default();
    let att = d["doubles"]["attempts"].as_u64().unwrap_or(0) as usize;
    // The double needed most, and the weakest double needed often
    let main = doubles.first().filter(|x| x["attempts"].as_u64().unwrap_or(0) >= 8).cloned();
    let weak = doubles
        .iter()
        .filter(|x| x["attempts"].as_u64().unwrap_or(0) as usize >= 12 && x["attempts"].as_u64().unwrap_or(0) as f64 >= att as f64 * 0.12)
        .min_by(|a, b| a["pct"].as_f64().unwrap_or(0.0).partial_cmp(&b["pct"].as_f64().unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal))
        .cloned();
    if let (Some(c), Some(cc)) = (co, club_co) {
        if totals.checkouts >= 20 && c + 5.0 < cc {
            let extra = main.as_ref().map(|m| format!(" Your most needed double is {} ({}/{}).", m["label"].as_str().unwrap_or(""), m["hits"], m["attempts"])).unwrap_or_default();
            out.push(tip(
                (cc - c) * 1.5,
                "work",
                "checkout",
                "Finishing costs you legs".into(),
                format!("Your checkout is {:.0}%, the club's is {:.0}%.{} Spend at least half your practice on doubles.", c, cc, extra),
                "ladder",
                metric("checkout_pct", "Checkout", Some(c), "%", "up"),
            ));
        }
    }
    if let Some(w) = weak {
        let p = w["pct"].as_f64().unwrap_or(0.0);
        let overall = d["doubles"]["pct"].as_f64().unwrap_or(0.0);
        if p + 6.0 < overall || p < 12.0 {
            let mut miss = String::new();
            let (inside, outside) = (w["inside"].as_u64().unwrap_or(0), w["outside"].as_u64().unwrap_or(0));
            let wide = w["wide"].as_array().and_then(|x| x.first()).cloned();
            let wide_n = wide.as_ref().map_or(0, |x| x["count"].as_u64().unwrap_or(0));
            let most = [(inside, "inside, into the single".to_string()), (outside, "outside the board".to_string()), (wide_n, wide.map(|x| format!("into the {}", x["number"])).unwrap_or_default())]
                .into_iter()
                .max_by_key(|x| x.0)
                .filter(|x| x.0 > 0);
            if let Some((_, where_)) = most {
                miss = format!(" Most misses go {}.", where_);
            }
            out.push(tip(
                (overall - p).max(4.0) + 4.0,
                "work",
                "weak_double",
                format!("{} needs work", w["label"].as_str().unwrap_or("")),
                format!("You hit {} with {} of {} darts ({:.0}%), against {:.0}% on all doubles.{} Bob's 27 or doubles around the clock train every double.", w["label"].as_str().unwrap_or(""), w["hits"], w["attempts"], p, overall, miss),
                "bobs27",
                json!({"key": format!("double:{}", w["target"]), "label": w["label"], "value": p, "unit": "%", "better": "up"}),
            ));
        }
    }
    // Spread and its shape
    if let (Some((sx, sy)), Some(radius)) = (acc.spread(), acc.group_radius()) {
        let drift = acc.drift();
        let low = drift.map_or(false, |(_, y)| y < -5.0);
        if sy > sx * 1.4 && acc.spread_visits >= 30 {
            let why = if low { format!(" and your T20 group sits {:.0} mm low: that usually means the elbow drops or the dart is let go late", -drift.unwrap().1) } else { ": usually release timing".into() };
            out.push(tip(
                (sy / sx - 1.0) * 10.0,
                "work",
                "vertical",
                "Your misses are high and low".into(),
                format!("Up-down your darts spread {:.0} mm, left-right only {:.0} mm{}. Keep the elbow up and release at the same point every time.", sy, sx, why),
                "grouping",
                metric("spread", "Group radius", Some(r1(radius)), "mm", "down"),
            ));
        } else if sx > sy * 1.15 && acc.spread_visits >= 30 {
            out.push(tip(
                (sx / sy - 1.0) * 14.0,
                "work",
                "sideways",
                "Your misses go left and right".into(),
                format!("Left-right your darts spread {:.0} mm, more than up-down ({:.0} mm). That is unusual and often means the elbow moves sideways or the hand turns at release.", sx, sy),
                "grouping",
                metric("spread", "Group radius", Some(r1(radius)), "mm", "down"),
            ));
        }
        if let Some((dx, _)) = drift {
            if dx.abs() >= 7.0 {
                let side = if dx > 0.0 { "right, towards the 1" } else { "left, towards the 5" };
                out.push(tip(
                    dx.abs() / 2.0,
                    "work",
                    "drift",
                    "Your T20 group sits to one side".into(),
                    format!("On average your darts at T20 land {:.0} mm {}. Check your stance and that the throw follows a straight line to the target.", dx.abs(), side),
                    "grouping",
                    metric("spread", "Group radius", Some(r1(radius)), "mm", "down"),
                ));
            }
        }
        // Aim: the best target for this spread
        let aim = &d["aim"];
        let t20 = aim["targets"][0]["points"].as_f64().unwrap_or(0.0);
        if let Some(best) = aim["targets"].as_array().and_then(|t| t.iter().max_by(|a, b| a["points"].as_f64().partial_cmp(&b["points"].as_f64()).unwrap_or(std::cmp::Ordering::Equal))) {
            let gain = best["points"].as_f64().unwrap_or(0.0) - t20;
            if gain >= 0.4 && best["label"] != "T20" {
                out.push(tip(
                    gain * 6.0,
                    "work",
                    "aim",
                    format!("Aim at {} for now", best["label"].as_str().unwrap_or("")),
                    format!("With your spread, aiming at {} scores {:.1} points per dart, {:.1} more than T20 ({:.1}). Its neighbours are kinder to misses. Switch back once your group tightens.", best["label"].as_str().unwrap_or(""), best["points"].as_f64().unwrap_or(0.0), gain, t20),
                    "scoring19",
                    metric("spread", "Group radius", Some(r1(radius)), "mm", "down"),
                ));
            }
        }
    }
    // Scoring fades after the first 9
    let tj = totals.json();
    if let (Some(f9), Some(a170)) = (tj["first9"].as_f64(), tj["avg170"].as_f64()) {
        if totals.games >= MIN_GAMES && f9 - a170 > 10.0 {
            out.push(tip(
                (f9 - a170) / 2.0,
                "work",
                "fade",
                "Your scoring fades after the first 9".into(),
                format!("First 9: {:.1}. Average until 170 left: {:.1}. Practise scoring in longer blocks, like 30 darts at T20, keeping the same rhythm.", f9, a170),
                "scoring20",
                metric("avg170", "Average until 170", Some(a170), "", "up"),
            ));
        }
    }
    // Leaves
    let lv = &d["leaves"];
    if lv["range"].as_u64().unwrap_or(0) >= 20 && lv["bogey_pct"].as_f64().unwrap_or(0.0) >= 10.0 {
        out.push(tip(
            lv["bogey_pct"].as_f64().unwrap_or(0.0) / 2.0,
            "work",
            "bogey",
            "Plan the visit into the finish".into(),
            format!("{:.0}% of the times you came under 170 you left a score no three darts can finish (159, 162, 163, 165, 166, 168, 169). Near 200, think one visit ahead.", lv["bogey_pct"].as_f64().unwrap_or(0.0)),
            "ladder",
            metric("bogey_pct", "Bogey leaves", lv["bogey_pct"].as_f64(), "%", "down"),
        ));
    }
    if lv["setup"].as_u64().unwrap_or(0) >= 20 && lv["odd_pct"].as_f64().unwrap_or(0.0) >= 35.0 {
        out.push(tip(
            lv["odd_pct"].as_f64().unwrap_or(0.0) / 5.0,
            "work",
            "odd",
            "Leave an even number".into(),
            format!("{:.0}% of your visits into the last 40 left an odd score, which costs a dart to set up. Aim to leave 32, 40 or 16: a miss there still leaves a double.", lv["odd_pct"].as_f64().unwrap_or(0.0)),
            "ladder",
            metric("odd_pct", "Odd leaves", lv["odd_pct"].as_f64(), "%", "down"),
        ));
    }
    // Pressure
    let (pr, ca) = (&d["doubles"]["pressure"], &d["doubles"]["calm"]);
    if pr["attempts"].as_u64().unwrap_or(0) >= 15 && ca["attempts"].as_u64().unwrap_or(0) >= 15 {
        let gap = ca["pct"].as_f64().unwrap_or(0.0) - pr["pct"].as_f64().unwrap_or(0.0);
        if gap >= 10.0 {
            out.push(tip(
                gap / 2.0,
                "work",
                "pressure",
                "Doubles drop under pressure".into(),
                format!("When your opponent is close to a finish you hit {:.0}% at the double, otherwise {:.0}%. Practise doubles with a target to beat so every dart matters.", pr["pct"].as_f64().unwrap_or(0.0), ca["pct"].as_f64().unwrap_or(0.0)),
                "ladder",
                metric("pressure_pct", "Doubles under pressure", pr["pct"].as_f64(), "%", "up"),
            ));
        }
    }
    // Fading during a match
    if let Some(legs) = d["by_leg"].as_array() {
        let first = legs.iter().find(|l| l["leg"] == 1 && l["darts"].as_u64().unwrap_or(0) >= 60);
        let late = legs.iter().filter(|l| l["leg"].as_u64().unwrap_or(0) >= 4 && l["darts"].as_u64().unwrap_or(0) >= 60).last();
        if let (Some(a), Some(b)) = (first, late) {
            let drop = a["average"].as_f64().unwrap_or(0.0) - b["average"].as_f64().unwrap_or(0.0);
            if drop >= 8.0 {
                out.push(tip(
                    drop / 2.0,
                    "work",
                    "stamina",
                    "Later legs score less".into(),
                    format!("Scoring in leg 1: {:.1}. From leg 4 on: {:.1}. Longer practice blocks and a steady routine between visits help keep it up.", a["average"].as_f64().unwrap_or(0.0), b["average"].as_f64().unwrap_or(0.0)),
                    "scoring20",
                    metric("avg170", "Average until 170", tj["avg170"].as_f64(), "", "up"),
                ));
            }
        }
    }
    // Strengths, so the page isn't only about faults
    if let (Some(c), Some(cc)) = (co, club_co) {
        if totals.checkouts >= 20 && c >= cc + 5.0 {
            out.push(tip(1.0, "strength", "checkout", "Strong finisher".into(), format!("Checkout {:.0}% against the club's {:.0}%.", c, cc), "", metric("checkout_pct", "Checkout", Some(c), "%", "up")));
        }
    }
    if let (Some(r), Some(cr)) = (acc.group_radius(), num(&club["spread"])) {
        if r + 3.0 < cr {
            out.push(tip(1.0, "strength", "grouping", "Tight grouping".into(), format!("Half your darts land within {:.0} mm of the group centre (club: {:.0} mm).", r, cr), "", metric("spread", "Group radius", Some(r1(r)), "mm", "down")));
        }
    }
    if let Some(m) = main.filter(|m| m["pct"].as_f64().unwrap_or(0.0) >= 30.0) {
        out.push(tip(0.8, "strength", "main_double", format!("{} is your double", m["label"].as_str().unwrap_or("")), format!("{:.0}% on your most needed double ({}/{}).", m["pct"].as_f64().unwrap_or(0.0), m["hits"], m["attempts"]), "", Value::Null));
    }
    out.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap_or(std::cmp::Ordering::Equal));
    let work: Vec<Value> = out.iter().filter(|t| t.v["kind"] == "work").take(4).map(|t| t.v.clone()).collect();
    let strengths: Vec<Value> = out.iter().filter(|t| t.v["kind"] == "strength").take(2).map(|t| t.v.clone()).collect();
    work.into_iter().chain(strengths).collect()
}

/// A metric's value in a bucket of games (for the focus arrow)
fn metric_in(b: &Bucket, key: &str) -> Option<f64> {
    let j = b.json();
    let d = b.acc.json(false);
    match key {
        "checkout_pct" => j["checkout_pct"].as_f64(),
        "avg170" => j["avg170"].as_f64(),
        "spread" => b.acc.group_radius().map(r1),
        "bogey_pct" => d["leaves"]["bogey_pct"].as_f64(),
        "odd_pct" => d["leaves"]["odd_pct"].as_f64(),
        "pressure_pct" => d["doubles"]["pressure"]["pct"].as_f64(),
        k if k.starts_with("double:") => {
            let t: i64 = k[7..].parse().ok()?;
            let r = b.acc.doubles.get(&t)?;
            (r.attempts >= 5).then(|| r1(r.hits as f64 * 100.0 / r.attempts as f64))
        }
        _ => None,
    }
}

/// Least-squares change of the game average per 30 days; None without enough spread in time
fn projection(points: &[(i64, f64)]) -> Option<f64> {
    if points.len() < 6 {
        return None;
    }
    let span = points.last()?.0 - points.first()?.0;
    if span < 14 * 86400 {
        return None;
    }
    let n = points.len() as f64;
    let xs: Vec<f64> = points.iter().map(|p| p.0 as f64 / 86400.0).collect();
    let mx = xs.iter().sum::<f64>() / n;
    let my = points.iter().map(|p| p.1).sum::<f64>() / n;
    let cov: f64 = xs.iter().zip(points).map(|(x, p)| (x - mx) * (p.1 - my)).sum();
    let var: f64 = xs.iter().map(|x| (x - mx).powi(2)).sum();
    (var > 0.0).then(|| r2(cov / var * 30.0))
}

/// Everything the coach tabs show for one member
pub fn coach(games: &[Game], member: &str, members: &BTreeMap<String, String>, from: i64) -> Value {
    let mut totals = Bucket::default();
    let mut weeks: BTreeMap<i64, Bucket> = BTreeMap::new();
    let mut months: BTreeMap<i64, Bucket> = BTreeMap::new();
    let mut each: Vec<(i64, Bucket)> = Vec::new();
    let mut avgs: Vec<(i64, f64)> = Vec::new();
    let today = local(chrono::Local::now().timestamp());
    let this_month = start_of(month_start(today));
    let last_month = start_of(month_start(month_start(today) - chrono::Duration::days(1)));
    let mut this_b = Bucket::default();
    let mut last_b = Bucket::default();
    for g in games.iter() {
        let Some(me) = g.players.iter().position(|p| p.member == member) else { continue };
        let ok = counts(g, me);
        // Month vs month ignores the period switch
        if ok && g.at >= this_month {
            this_b.add(g, me);
        } else if ok && g.at >= last_month {
            last_b.add(g, me);
        }
        if g.at < from {
            continue;
        }
        if ok {
            totals.add(g, me);
            avgs.push((g.at, g.players[me].average));
            let day = local(g.at);
            let week = start_of(day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64));
            weeks.entry(week).or_default().add(g, me);
            months.entry(start_of(month_start(day))).or_default().add(g, me);
            let mut one = Bucket::default();
            one.add(g, me);
            each.push((g.at, one));
        } else {
            totals.acc.add_game(g, me);
        }
    }
    let acc = totals.acc.clone();
    let span = avgs.last().map_or(0, |l| l.0) - avgs.first().map_or(0, |f| f.0);
    // Under 3 weeks of play a line per week says nothing: plot each game instead
    let (unit, buckets): (&str, Vec<(&i64, &Bucket)>) = if span > 182 * 86400 {
        ("month", months.iter().collect())
    } else if weeks.len() >= 3 {
        ("week", weeks.iter().collect())
    } else {
        ("game", each.iter().map(|(a, b)| (a, b)).collect())
    };
    let trend: Vec<Value> = buckets
        .into_iter()
        .map(|(at, b)| {
            let mut v = b.json();
            v["at"] = json!(at);
            v
        })
        .collect();
    let consistency = if avgs.len() >= 3 {
        let m = avgs.iter().map(|a| a.1).sum::<f64>() / avgs.len() as f64;
        Some(r2((avgs.iter().map(|a| (a.1 - m).powi(2)).sum::<f64>() / (avgs.len() - 1) as f64).sqrt()))
    } else {
        None
    };
    let club = club_numbers(games, members, from);
    let detail = acc.json(true);
    let tips = tips(&totals, &detail, &acc, &club);
    // This week's focus: the top tip's number, now vs last month
    let focus = tips.iter().find(|t| t["kind"] == "work" && t["metric"].is_object()).map(|t| {
        let key = t["metric"]["key"].as_str().unwrap_or("");
        json!({
            "metric": t["metric"], "title": t["title"], "drill": t["drill"],
            "now": metric_in(&this_b, key), "before": metric_in(&last_b, key),
        })
    });
    let ratings = ratings(games, members);
    let rating = ratings.get(member).map(|(r, n)| json!({"value": r.round(), "games": n, "provisional": *n < RATING_PROVISIONAL}));
    json!({
        "detail": detail,
        "totals": totals.json(),
        "trend": {"unit": unit, "points": trend, "per_30_days": projection(&avgs)},
        "month": {"this": this_b.json(), "last": last_b.json()},
        "consistency": consistency,
        "club": club,
        "tips": tips,
        "focus": focus,
        "rating": rating,
        "records": records(games, member),
    })
}

// ---------------------------------------------------------------------------------------------
// Personal bests and milestones (all time)
// ---------------------------------------------------------------------------------------------

fn keep(best: &mut BTreeMap<&'static str, (f64, i64, String)>, k: &'static str, v: f64, at: i64, id: &str, lower: bool) {
    if v <= 0.0 {
        return;
    }
    if best.get(k).map_or(true, |o| if lower { v < o.0 } else { v > o.0 }) {
        best.insert(k, (v, at, id.to_string()));
    }
}

pub fn records(games: &[Game], member: &str) -> Value {
    let mut best: BTreeMap<&'static str, (f64, i64, String)> = BTreeMap::new();
    let mut milestones: Vec<Value> = Vec::new();
    let mut played = 0;
    let mut t180 = 0;
    let mut tons = 0;
    let mut streak = 0;
    let mut best_streak = (0, 0i64);
    let mut list: Vec<&Game> = games.iter().collect();
    list.sort_by_key(|g| g.at);
    for g in list {
        let Some(me) = g.players.iter().position(|p| p.member == member) else { continue };
        if !counts(g, me) {
            continue;
        }
        let p = &g.players[me];
        played += 1;
        if [10, 25, 50, 100, 250, 500, 1000].contains(&played) {
            milestones.push(json!({"label": format!("{} games played", played), "at": g.at}));
        }
        if t180 == 0 && p.t180 > 0 {
            milestones.push(json!({"label": "First 180", "at": g.at, "game": g.id}));
        }
        t180 += p.t180;
        if p.best_checkout >= 100 {
            tons += 1;
            if tons == 1 {
                milestones.push(json!({"label": format!("First ton-plus checkout ({})", p.best_checkout), "at": g.at, "game": g.id}));
            }
        }
        if p.best_checkout == 170 {
            milestones.push(json!({"label": "The Big Fish (170)", "at": g.at, "game": g.id}));
        }
        if p.best_leg > 0 && p.best_leg <= 9 {
            milestones.push(json!({"label": "Nine-darter", "at": g.at, "game": g.id}));
        }
        keep(&mut best, "average", p.average, g.at, &g.id, false);
        keep(&mut best, "checkout", p.best_checkout as f64, g.at, &g.id, false);
        keep(&mut best, "best_leg", p.best_leg as f64, g.at, &g.id, true);
        keep(&mut best, "t180", p.t180 as f64, g.at, &g.id, false);
        keep(&mut best, "first9", p.first9, g.at, &g.id, false);
        if p.won {
            streak += 1;
            if streak > best_streak.0 {
                best_streak = (streak, g.at);
            }
            if streak == 3 || streak == 5 || streak == 10 {
                milestones.push(json!({"label": format!("{} wins in a row", streak), "at": g.at}));
            }
        } else {
            streak = 0;
        }
    }
    let rec = |k: &str, label: &str| best.get(k).map(|(v, at, id)| json!({"key": k, "label": label, "value": v, "at": at, "game": id}));
    let mut out: Vec<Value> = [
        rec("average", "Best match average"),
        rec("first9", "Best first 9"),
        rec("checkout", "Highest checkout"),
        rec("best_leg", "Best leg (darts)"),
        rec("t180", "Most 180s in a match"),
    ]
    .into_iter()
    .flatten()
    .collect();
    if best_streak.0 >= 2 {
        out.push(json!({"key": "streak", "label": "Longest win streak", "value": best_streak.0, "at": best_streak.1}));
    }
    milestones.reverse();
    json!({"bests": out, "milestones": milestones, "t180": t180, "tons": tons})
}

// ---------------------------------------------------------------------------------------------
// One game, leg by leg
// ---------------------------------------------------------------------------------------------

pub fn game_report(g: &Game, members: &BTreeMap<String, String>) -> Value {
    let winners = leg_winners(g);
    let mut legs: Vec<i64> = g.players.iter().flat_map(|p| p.throws.iter().map(|d| d.l)).collect();
    legs.sort();
    legs.dedup();
    let double_out = g.out_mode.eq_ignore_ascii_case("double");
    let leg_rows: Vec<Value> = legs
        .iter()
        .map(|l| {
            let players: Vec<Value> = g
                .players
                .iter()
                .map(|p| {
                    let ds: Vec<&Dart> = p.throws.iter().filter(|d| d.l == *l).collect();
                    let pts: i64 = visits(&p.throws).iter().filter(|v| v[0].l == *l && !v[0].b).map(|v| v.iter().map(Dart::points).sum::<i64>()).sum();
                    let at_double: Vec<&&Dart> = ds.iter().filter(|d| double_out && double_target(d.r).is_some()).collect();
                    let finish = ds.iter().rev().find(|d| !d.b && d.r > 0 && d.r - d.points() == 0).and_then(|last| ds.iter().find(|d| d.v == last.v).map(|first| first.r));
                    json!({
                        "darts": ds.len(),
                        "average": (!ds.is_empty()).then(|| r2(pts as f64 * 3.0 / ds.len() as f64)),
                        "at_double": at_double.len(), "hit": at_double.iter().filter(|d| d.m == 2 && Some(d.n) == double_target(d.r)).count(),
                        "finish": finish,
                    })
                })
                .collect();
            json!({"leg": l % 100, "set": l / 100, "winner": winners.get(l), "players": players})
        })
        .collect();
    let players: Vec<Value> = g
        .players
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut a = Acc::default();
            a.add_game(g, i);
            json!({
                "name": members.get(&p.member).cloned().unwrap_or_else(|| p.name.clone()), "member": p.member, "bot": p.bot, "won": p.won,
                "legs": p.legs, "sets": p.sets, "average": p.average, "first9": p.first9, "avg170": p.avg170,
                "checkout_pct": (p.checkouts > 0).then(|| r1(p.checkouts_hit as f64 * 100.0 / p.checkouts as f64)),
                "checkouts": p.checkouts, "checkouts_hit": p.checkouts_hit, "t180": p.t180, "t140": p.t140, "t100": p.t100,
                "best_checkout": p.best_checkout, "darts": p.darts,
                "heat": a.heat.iter().map(|(x, y, k, _)| json!([r2_3(*x), r2_3(*y), k])).collect::<Vec<_>>(),
                "detail": {"spread": a.spread().map(|(sx, sy)| json!({"x": r1(sx), "y": r1(sy)})), "leaves": a.json(false)["leaves"].clone(), "doubles": a.json(false)["doubles"]["by_double"].clone()},
            })
        })
        .collect();
    json!({
        "id": g.id, "at": g.at, "board": g.board, "variant": g.variant, "base": g.base, "in_mode": g.in_mode, "out_mode": g.out_mode,
        "legs_to_win": g.legs, "sets": g.sets, "players": players, "legs": leg_rows, "has_darts": g.players.iter().any(|p| !p.throws.is_empty()),
    })
}
