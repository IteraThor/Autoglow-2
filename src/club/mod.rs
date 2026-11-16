//! Club players: one roster and real stats from every board. Every AutoGlow records the local
//! Autodarts games its board finishes. Alone, it keeps them itself. In a club, one PC is the
//! **club PC**: it keeps the roster (the Studio players) and every game; the other PCs are
//! **boards** that send their games there (an outbox keeps them while the club PC is off) and keep
//! a copy of the roster, so pictures and recognition work offline too.
//! Players are recognised by name like the Studio does (name, Autodarts name, close spelling),
//! plus names given to a member later from the unassigned list.
//! Boards follow the club PC by its node id (found again on the network when its address
//! changes, or when it hands over to another PC), send member edits there, and get a nudge from the
//! club PC when the roster changes. A PC that is alone offers to join the club PC it finds.

pub mod stats;
#[cfg(test)]
mod tests;

use crate::autodarts::AutodartsBridge;
use crate::py::{py_str, Obj};
use crate::studio::Studio;
use crate::tournament::Tournaments;
use chrono::{Datelike, TimeZone};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use stats::{Game, LegBests};
use std::collections::BTreeMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

const SEEN_KEEP: usize = 200;
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
/// A board sends waiting games and checks the roster this often (the club PC nudges it sooner)
const SYNC_EVERY: f64 = 20.0;
/// How often the network is searched: for a club PC to join, a moved club PC, or a second one
const LOOK_EVERY: f64 = 30.0;
/// A board not heard from for this long shows as offline on the club PC
const BOARD_SEEN: f64 = 60.0;
/// Games per request when the club PC hands over
const HANDOVER_CHUNK: usize = 300;
/// A PC not found on the network for this long shows as offline in Settings
const PC_SEEN: f64 = 75.0;

fn now() -> f64 {
    crate::led_thread::wall()
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Settings {
    /// alone, club or board
    #[serde(default)]
    role: String,
    /// The club PC as host:port (boards)
    #[serde(default)]
    address: String,
    #[serde(default)]
    club_name: String,
    /// The club PC's node id (boards), so it is found again on the network
    #[serde(default)]
    club_node: String,
    /// Club PCs whose join offer was turned down (node ids)
    #[serde(default)]
    declined: Vec<String>,
    /// Extra names a member is recognised by (NAME in capitals → member id)
    #[serde(default)]
    aliases: BTreeMap<String, String>,
    /// Names that aren't members (guests), hidden from the unassigned list
    #[serde(default)]
    ignored: Vec<String>,
    /// Matches already recorded
    #[serde(default)]
    seen: Vec<String>,
}

/// What a board knows from its club PC
#[derive(Clone, Default, Serialize, Deserialize)]
struct Remote {
    #[serde(default)]
    version: String,
    #[serde(default)]
    summaries: BTreeMap<String, Value>,
    #[serde(default)]
    aliases: BTreeMap<String, String>,
    #[serde(skip)]
    status: String,
    #[serde(skip)]
    error: String,
    #[serde(skip)]
    last_try: f64,
    #[serde(skip)]
    last_ok: f64,
}

/// A board as the club PC last heard from it
#[derive(Clone, Default)]
struct BoardSeen {
    name: String,
    ip: String,
    port: u16,
    version: String,
    outbox: u64,
    seen: f64,
}

#[derive(Default)]
struct Inner {
    set: Settings,
    games: Vec<Game>,
    outbox: Vec<Game>,
    remote: Remote,
    current: Option<String>,
    bests: LegBests,
    last_saved: Value,
    syncing: bool,
    /// Club PC: its boards by node id
    boards: BTreeMap<String, BoardSeen>,
    /// Club PC: the roster as boards last got it, to nudge them on a change
    sent: String,
    /// Alone: a club PC found on the network to join
    offer: Option<Value>,
    /// Club PC: another club PC on the network
    other_club: Option<Value>,
    next_look: f64,
    looking: bool,
    /// Every AutoGlow PC seen on the network by node id (Settings lists them, offline ones too)
    known: BTreeMap<String, Value>,
}

pub struct Club {
    dir: PathBuf,
    inner: Mutex<Inner>,
    studio: Arc<Studio>,
    tournaments: Arc<Tournaments>,
    bridge: Option<Arc<AutodartsBridge>>,
}

/// Start of this calendar month / year (local time) for the leaderboard periods
pub fn period_start(period: &str) -> i64 {
    let today = chrono::Local::now().date_naive();
    let day = match period {
        "month" => today.with_day(1),
        "season" | "year" => today.with_ordinal(1),
        _ => return 0,
    };
    day.and_then(|d| d.and_hms_opt(0, 0, 0)).and_then(|t| chrono::Local.from_local_datetime(&t).earliest()).map_or(0, |t| t.timestamp())
}

/// Members as id → name, from the Studio player list
fn members_of(roster: &[Value]) -> BTreeMap<String, String> {
    roster.iter().map(|p| (py_str(&p["id"]), py_str(&p["name"]))).filter(|(i, _)| !i.is_empty()).collect()
}

/// Give each human player of a game the member they are, if any
pub fn recognise(game: &mut Game, roster: &[Value], aliases: &BTreeMap<String, String>) {
    let list: Vec<Value> = game.players.iter().map(|p| json!({"name": p.name})).collect();
    let settings = crate::obj! {"players" => roster.to_vec()};
    let mapped = crate::studio::map_players(&list, &settings);
    let members = members_of(roster);
    for (p, m) in game.players.iter_mut().zip(mapped) {
        p.member = if p.bot {
            String::new()
        } else {
            aliases.get(&p.name.to_uppercase()).filter(|id| members.contains_key(*id)).cloned().unwrap_or_else(|| py_str(&m["studio_id"]))
        };
    }
}

fn read_json<T: for<'a> Deserialize<'a> + Default>(p: &PathBuf) -> T {
    crate::storage::read_json_file(p).and_then(|v| serde_json::from_value(Value::Object(v)).ok()).unwrap_or_default()
}

fn http_get(url: &str) -> Result<Value, String> {
    ureq::get(url).timeout(HTTP_TIMEOUT).call().map_err(|e| e.to_string())?.into_json::<Value>().map_err(|e| e.to_string())
}

/// POST JSON; the club PC's own error message when it refuses
fn http_post(url: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
    match ureq::post(url).timeout(timeout).send_json(body) {
        Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(_, r)) => Err(r.into_json::<Value>().ok().map(|v| py_str(&v["message"])).filter(|m| !m.is_empty()).unwrap_or_else(|| "The club host refused it".into())),
        Err(e) => Err(e.to_string()),
    }
}

/// Percent-encode a query value
fn pct(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{:02X}", b) }).collect()
}

fn hash_of(s: &str) -> String {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::hash::Hash::hash(s, &mut h);
    format!("{:016x}", std::hash::Hasher::finish(&h))
}

fn http_bytes(url: &str) -> Option<Vec<u8>> {
    let r = ureq::get(url).timeout(HTTP_TIMEOUT).call().ok()?;
    let mut buf = Vec::new();
    r.into_reader().take(12 * 1024 * 1024).read_to_end(&mut buf).ok()?;
    Some(buf)
}

impl Club {
    pub fn new(dir: PathBuf, studio: Arc<Studio>, tournaments: Arc<Tournaments>, bridge: Option<Arc<AutodartsBridge>>) -> Arc<Self> {
        let dir = dir.join("club");
        let mut inner = Inner { set: read_json(&dir.join("settings.json")), remote: read_json(&dir.join("remote.json")), ..Default::default() };
        if let Some(Value::Object(pcs)) = crate::storage::read_json_file(&dir.join("network.json")).and_then(|v| v.get("pcs").cloned()) {
            inner.known = pcs.into_iter().collect();
        }
        if !["club", "board"].contains(&inner.set.role.as_str()) {
            inner.set.role = "alone".into();
        }
        if let Ok(text) = std::fs::read_to_string(dir.join("games.jsonl")) {
            inner.games = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
        }
        if let Some(Value::Array(o)) = crate::storage::read_json_file(&dir.join("outbox.json")).and_then(|v| v.get("games").cloned()) {
            inner.outbox = o.into_iter().filter_map(|g| serde_json::from_value(g).ok()).collect();
        }
        tournaments.set_club(&inner.set.role);
        Arc::new(Club { dir, inner: Mutex::new(inner), studio, tournaments, bridge })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self, name: &str, v: &Value) {
        let _ = std::fs::create_dir_all(&self.dir);
        if let Err(e) = crate::storage::write_atomic(&self.dir.join(name), crate::storage::pretty_json(v).as_bytes()) {
            warn!("Could not save club/{}: {}", name, e);
        }
    }

    fn save_settings(&self, g: &Inner) {
        self.write("settings.json", &json!(g.set));
    }

    fn save_outbox(&self, g: &Inner) {
        self.write("outbox.json", &json!({"games": g.outbox}));
    }

    fn rewrite_games(&self, g: &Inner) {
        let text: String = g.games.iter().map(|x| format!("{}\n", serde_json::to_string(x).unwrap_or_default())).collect();
        let _ = std::fs::create_dir_all(&self.dir);
        if let Err(e) = crate::storage::write_atomic(&self.dir.join("games.jsonl"), text.as_bytes()) {
            warn!("Could not save the club games: {}", e);
        }
    }

    fn roster(&self) -> Vec<Value> {
        crate::py::arr(self.studio.cached_settings().get("players")).to_vec()
    }

    pub fn is_board(&self) -> bool {
        self.lock().set.role == "board"
    }

    /// The club PC's address for a board, else None
    pub fn club_address(&self) -> Option<String> {
        let g = self.lock();
        (g.set.role == "board" && !g.set.address.is_empty()).then(|| g.set.address.clone())
    }

    pub fn start(self: &Arc<Self>) {
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(1));
            loop {
                iv.tick().await;
                me.tick();
                me.nudge_on_change();
                let look = {
                    let mut g = me.lock();
                    let due = !g.looking && now() > g.next_look;
                    if due {
                        g.looking = true;
                        g.next_look = now() + LOOK_EVERY;
                    }
                    due
                };
                if look {
                    let m = Arc::clone(&me);
                    tokio::spawn(async move {
                        let found = m.discover().await;
                        m.found(found.into_iter().filter(|v| v["club"].as_bool().unwrap_or(false)).collect());
                        m.lock().looking = false;
                    });
                }
                let due = {
                    let g = me.lock();
                    g.set.role == "board" && !g.set.address.is_empty() && !g.syncing && (now() - g.remote.last_try > SYNC_EVERY || (!g.outbox.is_empty() && now() - g.remote.last_try > 3.0))
                };
                if due {
                    let m = Arc::clone(&me);
                    m.lock().syncing = true;
                    tokio::task::spawn_blocking(move || {
                        // A panic in sync must not leave the flag set, or this board never syncs again
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| m.sync()));
                        m.lock().syncing = false;
                    });
                }
            }
        });
    }

    // -----------------------------------------------------------------------------------------
    // Recording the board's games
    // -----------------------------------------------------------------------------------------

    fn tick(&self) {
        let Some(b) = &self.bridge else { return };
        let state = b.lock().last_match_state.clone();
        let Some(state) = state else { return };
        let Some(id) = state.get("id").map(py_str).filter(|s| !s.is_empty()) else { return };
        let mut g = self.lock();
        if g.current.as_deref() != Some(id.as_str()) {
            g.current = Some(id.clone());
            g.bests = LegBests::default();
        }
        g.bests.note(&state);
        if g.set.seen.contains(&id) {
            return;
        }
        let (node, board) = self.tournaments.node();
        let Some(mut game) = stats::game_from_state(&state, &g.bests, &board, &node, now() as i64) else { return };
        g.set.seen.push(id.clone());
        let n = g.set.seen.len();
        g.set.seen.drain(..n.saturating_sub(SEEN_KEEP));
        let roster = self.roster();
        let mut aliases = g.set.aliases.clone();
        aliases.extend(g.remote.aliases.clone());
        recognise(&mut game, &roster, &aliases);
        info!("Club game {} recorded: {}", id, game.players.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().join(" vs "));
        g.last_saved = json!({"id": id, "at": now(), "text": saved_text(&game, &members_of(&roster))});
        if g.set.role == "board" {
            g.outbox.push(game);
            self.save_outbox(&g);
        } else {
            self.store(&mut g, game, &roster);
        }
        self.save_settings(&g);
    }

    /// Keep a game unless it's already there; true when new
    fn store(&self, g: &mut Inner, mut game: Game, roster: &[Value]) -> bool {
        if game.id.is_empty() || g.games.iter().any(|x| x.id == game.id) {
            return false;
        }
        recognise(&mut game, roster, &g.set.aliases);
        let line = format!("{}\n", serde_json::to_string(&game).unwrap_or_default());
        let _ = std::fs::create_dir_all(&self.dir);
        let ok = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("games.jsonl")).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes()));
        if let Err(e) = ok {
            warn!("Could not save the club game: {}", e);
        }
        g.games.push(game);
        g.games.sort_by_key(|x| x.at);
        true
    }

    /// Games from a board (club PC); returns the ids now stored, old ones included
    pub fn receive(&self, games: Vec<Game>) -> Vec<String> {
        let roster = self.roster();
        let mut g = self.lock();
        let mut ids = Vec::new();
        for game in games {
            ids.push(game.id.clone());
            self.store(&mut g, game, &roster);
        }
        ids
    }

    // -----------------------------------------------------------------------------------------
    // Board ↔ club PC
    // -----------------------------------------------------------------------------------------

    /// What the club PC hands its boards
    pub fn roster_for_boards(&self) -> Value {
        let roster = self.roster();
        let g = self.lock();
        let summaries = stats::summaries(&g.games, &members_of(&roster));
        let (node, name) = self.tournaments.node();
        let mut out = json!({"players": roster, "aliases": g.set.aliases, "summaries": summaries, "club_name": name, "club_node": node});
        out["version"] = json!(hash_of(&out.to_string()));
        out
    }

    /// The club PC answers a board's sync (and notes the board); any other PC points to the club PC
    pub fn answer_board(&self, q: &std::collections::HashMap<String, String>, ip: String) -> Value {
        let role = self.lock().set.role.clone();
        if role != "club" {
            let g = self.lock();
            let club = (role == "board").then(|| json!({"address": g.set.address, "node": g.set.club_node, "name": g.set.club_name}));
            return json!({"not_club": true, "club": club});
        }
        let out = self.roster_for_boards();
        let get = |k: &str| q.get(k).cloned().unwrap_or_default();
        let node = get("node");
        if !node.is_empty() {
            let b = BoardSeen { name: get("name"), ip, port: get("port").parse().unwrap_or(8080), version: py_str(&out["version"]), outbox: get("outbox").parse().unwrap_or(0), seen: now() };
            self.lock().boards.insert(node, b);
        }
        out
    }

    /// A cheap fingerprint of what boards copy, to see when it changes
    fn quick_version(&self) -> String {
        let roster = self.roster();
        let g = self.lock();
        hash_of(&format!("{}|{}|{:?}|{}", json!(roster), g.games.len(), g.set.aliases, self.tournaments.node().1))
    }

    /// Club PC: tell the boards when members, names or stats change, so they copy them right away
    fn nudge_on_change(&self) {
        if self.lock().set.role != "club" {
            return;
        }
        let v = self.quick_version();
        let old = std::mem::replace(&mut self.lock().sent, v.clone());
        if !old.is_empty() && old != v {
            self.nudge_boards();
        }
    }

    fn nudge_boards(&self) {
        let targets: Vec<String> = self.lock().boards.values().filter(|b| now() - b.seen < 3.0 * BOARD_SEEN).map(|b| format!("http://{}:{}/api/club/nudge", b.ip, b.port)).collect();
        if targets.is_empty() {
            return;
        }
        tokio::task::spawn_blocking(move || {
            for url in targets {
                let _ = ureq::post(&url).timeout(Duration::from_secs(2)).send_json(json!({}));
            }
        });
    }

    /// Board: the club PC says something changed
    pub fn nudged(&self) {
        let mut g = self.lock();
        if g.set.role == "board" {
            g.remote.last_try = 0.0;
        }
    }

    /// Club PCs found on the network: an offer to join (alone), the club PC again at a new address
    /// or after a handover (board), or a second club PC (club)
    fn found(&self, clubs: Vec<Value>) {
        let (role, node, empty) = {
            let g = self.lock();
            (g.set.role.clone(), g.set.club_node.clone(), g.games.is_empty() && g.outbox.is_empty())
        };
        match role.as_str() {
            "alone" => {
                let offer = {
                    let g = self.lock();
                    (clubs.len() == 1 && !g.set.declined.contains(&py_str(&clubs[0]["node"]))).then(|| clubs[0].clone())
                };
                if let Some(c) = offer.as_ref().filter(|_| empty && self.roster().is_empty()) {
                    // A new PC with nothing of its own simply joins
                    info!("Syncing with the club host {} found on the network", py_str(&c["name"]));
                    let _ = self.set_role("board", &py_str(&c["address"]), &py_str(&c["name"]), &py_str(&c["node"]));
                    return;
                }
                self.lock().offer = offer;
            }
            "board" => {
                // Its own club PC at a new address; another one only while its own is unreachable
                let offline = self.lock().remote.status == "offline";
                let pick = clubs.iter().find(|c| !node.is_empty() && py_str(&c["node"]) == node).or_else(|| (offline && clubs.len() == 1).then(|| &clubs[0]));
                if let Some(c) = pick {
                    self.follow(&py_str(&c["address"]), &py_str(&c["node"]), &py_str(&c["name"]));
                }
            }
            "club" => self.lock().other_club = clubs.first().cloned(),
            _ => {}
        }
    }

    /// Board: use the club PC at this address from now on (moved, or handed over)
    fn follow(&self, address: &str, node: &str, name: &str) {
        let mut g = self.lock();
        if address.is_empty() || (g.set.address == address && g.set.club_node == node) {
            return;
        }
        info!("Club host is now {} at {}", name, address);
        g.set.address = address.into();
        g.set.club_node = node.into();
        g.set.club_name = name.into();
        g.remote.version.clear();
        g.remote.last_try = 0.0;
        self.save_settings(&g);
    }

    /// Send waiting games to the club PC and copy its roster (blocking; runs off the async threads)
    fn sync(&self) {
        let (addr, outbox, version) = {
            let mut g = self.lock();
            g.remote.last_try = now();
            (g.set.address.clone(), g.outbox.clone(), g.remote.version.clone())
        };
        let base = format!("http://{}", addr);
        let fail = |e: String| {
            let mut g = self.lock();
            if g.remote.status != "offline" {
                warn!("Club host {} not reachable: {}", addr, e);
                g.next_look = 0.0; // Look for it on the network now
            }
            g.remote.status = "offline".into();
            g.remote.error = e;
        };
        let (node, name) = self.tournaments.node();
        let q = format!("node={}&name={}&port={}&outbox={}", node, pct(&name), self.tournaments.port(), outbox.len());
        let r = match http_get(&format!("{}/api/club/roster?{}", base, q)) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        if r["not_club"].as_bool().unwrap_or(false) {
            // It handed over (or stopped being the club PC): follow it where it points
            let c = &r["club"];
            if c.is_object() && py_str(&c["address"]) != addr {
                self.follow(&py_str(&c["address"]), &py_str(&c["node"]), &py_str(&c["name"]));
            }
            return fail(format!("{} is not the club host any more", addr));
        }
        if !outbox.is_empty() {
            match http_post(&format!("{}/api/club/games", base), &json!({"games": outbox}), HTTP_TIMEOUT) {
                Ok(v) => {
                    let saved: Vec<String> = crate::py::arr(v.get("saved")).iter().map(py_str).collect();
                    let mut g = self.lock();
                    g.outbox.retain(|x| !saved.contains(&x.id));
                    self.save_outbox(&g);
                    info!("Sent {} game(s) to the club host", saved.len());
                }
                Err(e) => return fail(e),
            }
        }
        if py_str(&r["version"]) != version {
            let players = crate::py::arr(r.get("players")).to_vec();
            if let Err(e) = self.studio.replace_players(&players, |name| http_bytes(&format!("{}/api/studio/images/{}", base, name))) {
                return fail(format!("Could not copy the roster: {}", e));
            }
            let mut g = self.lock();
            g.remote.version = py_str(&r["version"]);
            g.remote.summaries = serde_json::from_value(r["summaries"].clone()).unwrap_or_default();
            g.remote.aliases = serde_json::from_value(r["aliases"].clone()).unwrap_or_default();
            g.set.club_name = py_str(&r["club_name"]);
            self.write("remote.json", &json!(g.remote));
            self.save_settings(&g);
        }
        let mut g = self.lock();
        let club_node = py_str(&r["club_node"]);
        if !club_node.is_empty() && g.set.club_node != club_node {
            g.set.club_node = club_node;
            self.save_settings(&g);
        }
        g.remote.status = "ok".into();
        g.remote.error.clear();
        g.remote.last_ok = now();
    }

    /// Board: send a member edit to the club PC, then copy the roster at once
    pub async fn forward(self: &Arc<Self>, method: &'static str, path: String, content_type: String, body: Vec<u8>) -> Result<Value, String> {
        let addr = self.club_address().ok_or("No club host set")?;
        let me = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            let req = ureq::request(method, &format!("http://{}{}", addr, path)).timeout(Duration::from_secs(20)).set("Content-Type", &content_type);
            let v = match req.send_bytes(&body) {
                Ok(r) => r.into_json::<Value>().map_err(|e| e.to_string())?,
                Err(ureq::Error::Status(_, r)) => return Err(r.into_json::<Value>().ok().map(|v| py_str(&v["message"])).filter(|m| !m.is_empty()).unwrap_or_else(|| "The club host refused it".into())),
                Err(_) => return Err("The club host is not reachable right now, so members can't be changed. Try again when it's back.".into()),
            };
            me.sync();
            Ok(v)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    /// Search the network and remember every AutoGlow found
    pub async fn discover(self: &Arc<Self>) -> Vec<Value> {
        let found = self.tournaments.discover().await;
        let mut g = self.lock();
        for pc in &found {
            let mut v = pc.clone();
            v["seen"] = json!(now());
            g.known.insert(py_str(&pc["node"]), v);
        }
        self.write("network.json", &json!({"pcs": g.known}));
        found
    }

    /// Every AutoGlow PC on the network, this one first, offline ones too (Settings)
    pub fn network(&self) -> Value {
        let (node, name) = self.tournaments.node();
        let ip = crate::discovery::primary_ipv4().map(|i| i.to_string()).unwrap_or_default();
        let g = self.lock();
        let mut pcs = vec![json!({"node": node, "name": name, "address": format!("{}:{}", ip, self.tournaments.port()), "role": g.set.role, "version": env!("CARGO_PKG_VERSION"), "online": true, "me": true})];
        let mut others: Vec<Value> = g
            .known
            .iter()
            .filter(|(n, _)| **n != node)
            .map(|(n, pc)| {
                let mut v = pc.clone();
                let ago = (now() - pc["seen"].as_f64().unwrap_or(0.0)).round();
                v["online"] = json!(ago < PC_SEEN);
                v["seen_ago"] = json!(ago);
                if let Some(b) = g.boards.get(n) {
                    v["outbox"] = json!(b.outbox);
                    v["synced_ago"] = json!((now() - b.seen).round());
                }
                v
            })
            .collect();
        others.sort_by_key(|v| (!v["online"].as_bool().unwrap_or(false), py_str(&v["name"]).to_lowercase()));
        pcs.extend(others);
        json!({"pcs": pcs})
    }

    /// Rename another AutoGlow PC (blocking): it changes its own name and announces it again
    pub fn rename_pc(&self, node: &str, name: &str) -> Result<(), String> {
        let address = self.lock().known.get(node).map(|v| py_str(&v["address"])).ok_or("That PC is not known here")?;
        http_post(&format!("http://{}/api/club/name", address), &json!({"name": name}), HTTP_TIMEOUT).map_err(|e| format!("Could not rename it: {}", e))?;
        let mut g = self.lock();
        if let Some(v) = g.known.get_mut(node) {
            v["name"] = json!(name.trim());
        }
        if let Some(b) = g.boards.get_mut(node) {
            b.name = name.trim().into();
        }
        if g.set.club_node == node {
            g.set.club_name = name.trim().into();
            self.save_settings(&g);
        }
        self.write("network.json", &json!({"pcs": g.known}));
        Ok(())
    }

    /// Stop listing a PC that is gone
    pub fn forget_pc(&self, node: &str) {
        let mut g = self.lock();
        g.known.remove(node);
        g.boards.remove(node);
        self.write("network.json", &json!({"pcs": g.known}));
    }

    /// Another club PC on the network (one per network), if any
    pub async fn other_club(self: &Arc<Self>) -> Option<Value> {
        {
            let g = self.lock();
            if g.set.role == "board" && g.remote.status == "ok" {
                return Some(json!({"name": g.set.club_name, "address": g.set.address, "node": g.set.club_node}));
            }
        }
        // mDNS answers can be slow to arrive; search twice before saying there is none
        for _ in 0..2 {
            if let Some(c) = self.discover().await.into_iter().find(|v| v["club"].as_bool().unwrap_or(false)) {
                return Some(c);
            }
        }
        None
    }

    /// Alone: don't offer this club PC again
    pub fn decline(&self, node: &str) {
        let mut g = self.lock();
        if !g.set.declined.iter().any(|n| n == node) {
            g.set.declined.push(node.into());
        }
        g.offer = None;
        self.save_settings(&g);
    }

    /// Club PC: hand the club over to the PC at `address` (blocking). It copies the roster from
    /// here and becomes the club PC; then the games go there and this PC becomes one of its boards.
    pub fn hand_over(&self, address: &str, node: &str, name: &str) -> Result<(), String> {
        if self.lock().set.role != "club" {
            return Err("Only the club host can hand over".into());
        }
        let address = address.trim().trim_start_matches("http://").trim_end_matches('/').to_string();
        let base = format!("http://{}", address);
        let me = format!("{}:{}", crate::discovery::primary_ipv4().map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into()), self.tournaments.port());
        let (aliases, ignored, games) = {
            let g = self.lock();
            (g.set.aliases.clone(), g.set.ignored.clone(), g.games.clone())
        };
        http_post(&format!("{}/api/club/takeover", base), &json!({"from": me, "aliases": aliases, "ignored": ignored}), Duration::from_secs(60))?;
        for chunk in games.chunks(HANDOVER_CHUNK) {
            let v = http_post(&format!("{}/api/club/games", base), &json!({"games": chunk}), Duration::from_secs(30))?;
            if crate::py::arr(v.get("saved")).len() != chunk.len() {
                return Err("The new club host did not save every game. Nothing was changed here.".into());
            }
        }
        {
            let mut g = self.lock();
            let _ = std::fs::rename(self.dir.join("games.jsonl"), self.dir.join(format!("games-handed-over-{}.jsonl", now() as i64)));
            g.games.clear();
        }
        info!("Club handed over to {} at {}", name, address);
        self.set_role("board", &address, name, node)?;
        // Boards ask here next, are told where the club PC is now and follow it
        self.nudge_boards();
        Ok(())
    }

    /// Become the club PC that `from` hands over: copy its roster, names and guests (blocking)
    pub fn take_over(&self, from: &str, aliases: BTreeMap<String, String>, ignored: Vec<String>) -> Result<(), String> {
        let base = format!("http://{}", from.trim().trim_start_matches("http://").trim_end_matches('/'));
        let r = http_get(&format!("{}/api/club/roster", base))?;
        if r["not_club"].as_bool().unwrap_or(false) {
            return Err("That PC is not the club host".into());
        }
        let players = crate::py::arr(r.get("players")).to_vec();
        self.studio.replace_players(&players, |name| http_bytes(&format!("{}/api/studio/images/{}", base, name)))?;
        self.set_role("club", "", "", "")?;
        let mut g = self.lock();
        g.set.aliases.extend(aliases);
        for n in ignored {
            if !g.set.ignored.contains(&n) {
                g.set.ignored.push(n);
            }
        }
        self.save_settings(&g);
        info!("This PC is now the club host (handed over from {})", from);
        Ok(())
    }

    /// A read-only view from the club PC (boards show the club's stats, not their own)
    pub async fn remote_get(self: &Arc<Self>, path: String) -> Result<Value, String> {
        let addr = self.club_address().ok_or("No club host set")?;
        let name = self.lock().set.club_name.clone();
        tokio::task::spawn_blocking(move || http_get(&format!("http://{}/api/club/{}", addr, path)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|_| format!("The club host{} is not reachable right now.", if name.is_empty() { String::new() } else { format!(" ({})", name) }))
    }

    // -----------------------------------------------------------------------------------------
    // Views
    // -----------------------------------------------------------------------------------------

    /// Short stats per member id, for cards and the Studio (boards: the club PC's numbers)
    pub fn summaries(&self) -> BTreeMap<String, Value> {
        let roster = self.roster();
        let g = self.lock();
        if g.set.role == "board" {
            g.remote.summaries.clone()
        } else {
            stats::summaries(&g.games, &members_of(&roster))
        }
    }

    pub fn state(&self) -> Value {
        let (_, node_name) = self.tournaments.node();
        let g = self.lock();
        let unassigned = if g.set.role == "board" { 0 } else { stats::unassigned(&g.games, &members_of(&self.roster()), &g.set.ignored).len() };
        let boards: Vec<Value> = if g.set.role == "club" {
            drop(g);
            let current = py_str(&self.roster_for_boards()["version"]);
            let g = self.lock();
            g.boards
                .values()
                .map(|b| {
                    let ago = (now() - b.seen).round();
                    json!({"name": b.name, "address": format!("{}:{}", b.ip, b.port), "seen_ago": ago, "online": ago < BOARD_SEEN, "up_to_date": b.version == current, "outbox": b.outbox})
                })
                .collect()
        } else {
            drop(g);
            Vec::new()
        };
        let g = self.lock();
        json!({
            "role": g.set.role, "address": g.set.address, "club_name": g.set.club_name, "club_node": g.set.club_node, "node_name": node_name,
            "can_edit": g.set.role != "board" || g.remote.status != "offline", "status": g.remote.status, "error": g.remote.error,
            "boards": boards, "offer": g.offer, "other_club": g.other_club,
            "synced_ago": if g.remote.last_ok > 0.0 { json!((now() - g.remote.last_ok).round()) } else { Value::Null },
            "outbox": g.outbox.len(), "games": g.games.len(), "unassigned": unassigned, "last_saved": g.last_saved,
        })
    }

    pub fn members(&self) -> Value {
        let sums = self.summaries();
        let roster: Vec<Value> = self
            .roster()
            .into_iter()
            .map(|mut p| {
                p["summary"] = sums.get(&py_str(&p["id"])).cloned().unwrap_or(Value::Null);
                p
            })
            .collect();
        // Who is in the open Autodarts lobby, so the lobby menu can mark members already added
        let lobby: Vec<String> = self.bridge.as_ref().and_then(|b| b.lock().open_lobby().map(crate::tournament::agent::names_of)).unwrap_or_default();
        json!({"players": roster, "lobby": lobby})
    }

    pub fn member(&self, id: &str, period: &str) -> Result<Value, String> {
        let roster = self.roster();
        let p = roster.iter().find(|p| py_str(&p["id"]) == id).cloned().ok_or("Member not found")?;
        let g = self.lock();
        let names: Vec<String> = g.set.aliases.iter().filter(|(_, m)| m.as_str() == id).map(|(n, _)| n.clone()).collect();
        Ok(json!({"player": p, "names": names, "stats": stats::member_stats(&g.games, id, &members_of(&roster), period_start(period))}))
    }

    pub fn leaderboards(&self, period: &str) -> Value {
        let roster = self.roster();
        let g = self.lock();
        let mut v = stats::leaderboards(&g.games, &members_of(&roster), period_start(period));
        v["period"] = json!(period);
        v
    }

    pub fn unassigned(&self) -> Value {
        let roster = self.roster();
        let g = self.lock();
        json!({"names": stats::unassigned(&g.games, &members_of(&roster), &g.set.ignored), "ignored": g.set.ignored})
    }

    pub fn export(&self) -> Value {
        let g = self.lock();
        json!({"games": g.games, "aliases": g.set.aliases, "ignored": g.set.ignored})
    }

    // -----------------------------------------------------------------------------------------
    // Changes
    // -----------------------------------------------------------------------------------------

    /// Give the games of an unassigned name to a member; `remember` also recognises the name next time
    pub fn assign(&self, name: &str, member: &str, remember: bool) -> Result<(), String> {
        let roster = self.roster();
        let members = members_of(&roster);
        if !members.contains_key(member) {
            return Err("Member not found".into());
        }
        let key = name.trim().to_uppercase();
        if key.is_empty() {
            return Err("Name is required".into());
        }
        let mut g = self.lock();
        let mut n = 0;
        for game in g.games.iter_mut() {
            let ids: Vec<String> = game.players.iter().map(|p| p.member.clone()).collect();
            if ids.iter().any(|m| m == member) {
                continue; // A member plays once per game
            }
            if let Some(p) = game.players.iter_mut().find(|p| !p.bot && p.name.to_uppercase() == key && !members.contains_key(&p.member)) {
                p.member = member.into();
                n += 1;
            }
        }
        if remember {
            g.set.aliases.insert(key.clone(), member.into());
        }
        g.set.ignored.retain(|x| *x != key);
        info!("Club: {} game(s) of {} given to {}", n, key, members[member]);
        self.rewrite_games(&g);
        self.save_settings(&g);
        Ok(())
    }

    /// Hide a name from the unassigned list (a guest), or show it again
    pub fn ignore(&self, name: &str, ignore: bool) -> Result<(), String> {
        let key = name.trim().to_uppercase();
        let mut g = self.lock();
        g.set.ignored.retain(|x| *x != key);
        if ignore && !key.is_empty() {
            g.set.ignored.push(key);
        }
        self.save_settings(&g);
        Ok(())
    }

    /// Forget a name a member was recognised by
    pub fn forget_name(&self, name: &str) -> Result<(), String> {
        let mut g = self.lock();
        g.set.aliases.remove(&name.trim().to_uppercase());
        self.save_settings(&g);
        Ok(())
    }

    /// alone, club (this PC keeps everything) or board (of the club PC at `address`)
    pub fn set_role(&self, role: &str, address: &str, club_name: &str, club_node: &str) -> Result<(), String> {
        if !["alone", "club", "board"].contains(&role) {
            return Err("Unknown role".into());
        }
        let address = address.trim().trim_start_matches("http://").trim_end_matches('/').to_string();
        if role == "board" && address.is_empty() {
            return Err("Pick the club host or type its address".into());
        }
        let roster = self.roster();
        let mut g = self.lock();
        let was = g.set.role.clone();
        if role == "board" && was != "board" && !g.games.is_empty() {
            // Games this PC kept itself go to the club PC; the file stays as a backup
            let games = std::mem::take(&mut g.games);
            let _ = std::fs::rename(self.dir.join("games.jsonl"), self.dir.join(format!("games-before-board-{}.jsonl", now() as i64)));
            g.outbox.extend(games);
            self.save_outbox(&g);
        }
        if role != "board" && was == "board" && !g.outbox.is_empty() {
            for game in std::mem::take(&mut g.outbox) {
                self.store(&mut g, game, &roster);
            }
            self.save_outbox(&g);
        }
        g.set.role = role.into();
        g.set.address = if role == "board" { address } else { String::new() };
        g.set.club_name = if role == "board" { club_name.trim().into() } else { String::new() };
        g.set.club_node = if role == "board" { club_node.trim().into() } else { String::new() };
        g.remote = Remote::default();
        g.offer = None;
        g.other_club = None;
        g.boards.clear();
        g.sent.clear();
        self.write("remote.json", &json!(g.remote));
        self.save_settings(&g);
        drop(g);
        self.tournaments.set_club(role);
        Ok(())
    }
}

/// "Saved to Anna's and Ben's stats" / "Saved. SASCHA K isn't a member yet"
fn saved_text(game: &Game, members: &BTreeMap<String, String>) -> String {
    let known: Vec<String> = game.players.iter().filter_map(|p| members.get(&p.member)).cloned().collect();
    let unknown: Vec<String> = game.players.iter().filter(|p| !p.bot && !members.contains_key(&p.member)).map(|p| p.name.clone()).collect();
    let mut t = if known.is_empty() { "Game saved".to_string() } else { format!("Saved to {}", join_names(&known.iter().map(|n| format!("{}'s", n)).collect::<Vec<_>>()) + " stats") };
    if !unknown.is_empty() {
        t += &format!(". {} {} not a member yet", join_names(&unknown), if unknown.len() == 1 { "is" } else { "are" });
    }
    t
}

fn join_names(n: &[String]) -> String {
    match n.len() {
        0 => String::new(),
        1 => n[0].clone(),
        _ => format!("{} and {}", n[..n.len() - 1].join(", "), n[n.len() - 1]),
    }
}

/// Request body helper for the routes
pub fn games_from(body: &Obj) -> Vec<Game> {
    crate::py::arr(body.get("games")).iter().filter_map(|g| serde_json::from_value(g.clone()).ok()).collect()
}
