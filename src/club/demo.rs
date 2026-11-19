//! Made-up game history for the demo players: a few weeks of 501 matches between them, thrown dart
//! by dart with a spread that fits each player's average, so every tab of a member (progress, heat
//! map, doubles, games, compare) has something to show. The games are marked by their id, so the
//! same button that adds the demo players can take them away again.

use super::coach::double_target;
use super::stats::{bests_from_darts, Dart, Game, GamePlayer};
use rand::{rngs::StdRng, Rng, SeedableRng};

pub const ID_PREFIX: &str = "demo-";
const GAMES: usize = 36;
const DAY: i64 = 86_400;

/// The demo members and the 3-dart average each is made to play at
pub const PLAYERS: [(&str, f64); 8] = [
    ("Odin Borson", 79.4),
    ("Freya Njordsdottir", 74.8),
    ("Heimdall", 72.1),
    ("Sif Golden-Hair", 66.5),
    ("Tyr One-Hand", 70.3),
    ("Hela Lokisdottir", 77.2),
    ("Thor Odinson", 81.3),
    ("Loki Laufeyson", 73.6),
];

/// The numbers around the board, clockwise from the top
const RING: [i64; 20] = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];

/// What a dart at (x, y) scores: 1.0 is the outer edge of the double ring (170 mm)
fn landed(x: f64, y: f64) -> (i64, i64) {
    let r = x.hypot(y) * 170.0;
    if r < 6.35 {
        return (25, 2);
    }
    if r < 15.9 {
        return (25, 1);
    }
    if r > 170.0 {
        return (0, 0);
    }
    let deg = x.atan2(y).to_degrees();
    let n = RING[(((deg + 9.0).rem_euclid(360.0)) / 18.0) as usize % 20];
    let m = if (99.0..107.0).contains(&r) { 3 } else if r >= 162.0 { 2 } else { 1 };
    (n, m)
}

/// Where to aim for a segment: the middle of its treble, double or outer single
fn aim_point(n: i64, m: i64) -> (f64, f64) {
    if n == 25 {
        return (0.0, 0.0);
    }
    let i = RING.iter().position(|v| *v == n).unwrap_or(0) as f64;
    let r = match m {
        3 => 103.0,
        2 => 166.0,
        _ => 130.0,
    } / 170.0;
    let a = (i * 18.0).to_radians();
    (r * a.sin(), r * a.cos())
}

/// The segment a player goes for with this much left
fn target(left: i64) -> (i64, i64) {
    if let Some(d) = double_target(left) {
        return (d, 2);
    }
    match left {
        61.. => (20, 3),
        41..=60 => (if left - 32 <= 20 { left - 32 } else { 20 }, 1),
        _ => (1, 1),
    }
}

fn normal(rng: &mut StdRng) -> f64 {
    let (u, v): (f64, f64) = (rng.gen_range(1e-9..1.0), rng.gen());
    (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
}

/// Spread in mm for a player of this average (calibrated against simulated games)
fn spread(avg: f64) -> f64 {
    (9.5 + (81.3 - avg) * 0.28).max(7.0)
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

struct Throw {
    d: Dart,
    points: i64,
}

/// One leg: both players throw at 501 until one checks out on a double. Returns the winner.
fn play_leg(rng: &mut StdRng, sds: [f64; 2], leg: i64, first: usize, q: &mut u64, out: &mut [Vec<Throw>; 2]) -> usize {
    let mut left = [501i64, 501];
    let mut visit = [0i64, 0];
    let mut turn = first;
    loop {
        visit[turn] += 1;
        let start = left[turn];
        let first_dart = out[turn].len();
        let mut r = start;
        let mut busted = false;
        for i in 0..3 {
            let (tn, tm) = target(r);
            let (ax, ay) = aim_point(tn, tm);
            let (x, y) = (ax + normal(rng) * sds[turn] / 170.0, ay + normal(rng) * sds[turn] / 170.0);
            let (n, m) = landed(x, y);
            let pts = n * m;
            *q += 1;
            out[turn].push(Throw {
                d: Dart { x: Some((x * 1000.0).round() / 1000.0), y: Some((y * 1000.0).round() / 1000.0), n, m, r, l: leg, v: visit[turn], i, q: *q, b: false },
                points: pts,
            });
            let new = r - pts;
            if new == 0 && m == 2 {
                return turn;
            }
            if new <= 1 {
                busted = true;
                break;
            }
            r = new;
        }
        if busted {
            for t in &mut out[turn][first_dart..] {
                t.d.b = true;
                t.points = 0;
            }
        } else {
            left[turn] = r;
        }
        turn = 1 - turn;
    }
}

/// A player's numbers for the whole match, from their darts
fn player_of(name: &str, member_won: bool, legs: i64, throws: Vec<Throw>) -> GamePlayer {
    let darts = throws.len() as i64;
    let score: i64 = throws.iter().map(|t| t.points).sum();
    let mut visits: Vec<(i64, i64, i64)> = Vec::new(); // leg, visit, points
    for t in &throws {
        match visits.last_mut() {
            Some(v) if v.0 == t.d.l && v.1 == t.d.v => v.2 += t.points,
            _ => visits.push((t.d.l, t.d.v, t.points)),
        }
    }
    let early: Vec<&Throw> = throws.iter().filter(|t| t.d.v <= 3).collect();
    let early_pts: i64 = early.iter().map(|t| t.points).sum();
    let scoring: Vec<&Throw> = throws.iter().filter(|t| t.d.r > 170).collect();
    let scoring_pts: i64 = scoring.iter().map(|t| t.points).sum();
    let at_double: Vec<&Throw> = throws.iter().filter(|t| double_target(t.d.r).is_some()).collect();
    let hit = at_double.iter().filter(|t| !t.d.b && t.d.r - t.points == 0 && t.d.m == 2).count() as i64;
    let mut p = GamePlayer {
        name: name.to_uppercase(),
        won: member_won,
        legs,
        sets: 0,
        score: score as f64,
        darts,
        average: if darts > 0 { round2(score as f64 * 3.0 / darts as f64) } else { 0.0 },
        first9: if early.is_empty() { 0.0 } else { round2(early_pts as f64 * 3.0 / early.len() as f64) },
        checkouts: at_double.len() as i64,
        checkouts_hit: hit,
        t180: visits.iter().filter(|v| v.2 == 180).count() as i64,
        t140: visits.iter().filter(|v| (140..180).contains(&v.2)).count() as i64,
        t100: visits.iter().filter(|v| (100..140).contains(&v.2)).count() as i64,
        avg170: if scoring.is_empty() { 0.0 } else { round2(scoring_pts as f64 * 3.0 / scoring.len() as f64) },
        throws: throws.into_iter().map(|t| t.d).collect(),
        ..Default::default()
    };
    bests_from_darts(std::slice::from_mut(&mut p));
    p
}

/// The made-up games for these members (their names as in the roster). Always the same games for
/// the same members, spread over the last months, the players getting a little better over time.
pub fn games(names: &[(String, f64)], now: i64) -> Vec<Game> {
    if names.len() < 2 {
        return Vec::new();
    }
    let mut rng = StdRng::seed_from_u64(0x00D1_5EA5);
    (0..GAMES)
        .map(|g| {
            let a = rng.gen_range(0..names.len());
            let b = (a + 1 + rng.gen_range(0..names.len() - 1)) % names.len();
            // Oldest first: 150 days ago up to today, with a little shaking of the days
            let days_ago = (150.0 * (1.0 - g as f64 / GAMES as f64)) as i64;
            let at = now - days_ago * DAY - rng.gen_range(0..DAY / 2);
            // Everybody is a few points weaker at the start of the period
            let form = 0.94 + 0.06 * (g as f64 / GAMES as f64);
            let sds = [spread(names[a].1 * form), spread(names[b].1 * form)];
            let (mut legs, mut q) = ([0i64; 2], 0u64);
            let mut out: [Vec<Throw>; 2] = [Vec::new(), Vec::new()];
            let mut leg = 0;
            let mut first = g % 2;
            while legs[0] < 3 && legs[1] < 3 {
                leg += 1;
                let w = play_leg(&mut rng, sds, leg, first, &mut q, &mut out);
                legs[w] += 1;
                first = 1 - first;
            }
            let [t0, t1] = out;
            let won0 = legs[0] == 3;
            Game {
                id: format!("{}{}", ID_PREFIX, g + 1),
                at,
                board: "Demo board".into(),
                node: "demo".into(),
                variant: "X01".into(),
                base: 501,
                in_mode: "Straight".into(),
                out_mode: "Double".into(),
                legs: 3,
                sets: 0,
                players: vec![player_of(&names[a].0, won0, legs[0], t0), player_of(&names[b].0, !won0, legs[1], t1)],
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn made_up_games_are_complete_and_fit_the_players() {
        let names: Vec<(String, f64)> = PLAYERS.iter().map(|(n, a)| (n.to_string(), *a)).collect();
        let list = games(&names, 1_800_000_000);
        assert_eq!(list.len(), GAMES);
        assert_eq!(list, games(&names, 1_800_000_000), "same members give the same games");
        let (mut score, mut darts) = (0.0, 0);
        for g in &list {
            assert!(g.players.iter().any(|p| p.won && p.legs == 3));
            for p in &g.players {
                score += p.score;
                darts += p.darts;
                assert!(p.throws.iter().all(|d| d.x.is_some()));
            }
        }
        let avg = score * 3.0 / darts as f64;
        assert!((55.0..95.0).contains(&avg), "average over everybody: {}", avg);
    }
}
