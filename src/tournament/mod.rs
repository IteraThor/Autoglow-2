//! Local tournaments. One AutoGlow hosts a tournament (the PC where "Host a tournament here" was
//! pressed); other AutoGlows join it as boards. Boards connect to the host over the LAN
//! (WebSocket /ws/tournament/peer), report what their Autodarts board does, and send results; the
//! host runs the bracket and hands out matches. The host's own board takes the same path in-process.
//! The Chrome extension only ever talks to its own AutoGlow (/api/tournament/*).

pub mod agent;
pub mod demo;
pub mod engine;
#[cfg(test)]
mod tests;

use crate::autodarts::{is_match_over, AutodartsBridge};
use crate::py::{py_str, Obj};
use axum::extract::ws::{Message as AxMsg, WebSocket};
use engine::{MatchResult, Spec, Tournament};
use futures_util::{SinkExt, StreamExt};
use log::{info, warn};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio_tungstenite::tungstenite::Message as TgMsg;

pub const PROTOCOL: i64 = 1;
pub const PEER_WS_PATH: &str = "/ws/tournament/peer";
/// The host pings every board this often; either side gives up on a link that stays silent for LINK_TIMEOUT
const PING_EVERY: Duration = Duration::from_secs(5);
const LINK_TIMEOUT: Duration = Duration::from_secs(15);
const SERVICE_TYPE: &str = "_autoglow._tcp.local.";
/// A linked match that disappears for this long without a result was aborted
const ABORT_GRACE: f64 = 6.0;
/// A board searches the network for its host (moved, or taken over) after this long offline
const LOOK_AFTER: f64 = 8.0;
/// A board may take over as host once the host has been unreachable this long
const TAKEOVER_AFTER: f64 = 20.0;

fn now() -> f64 {
    crate::led_thread::wall()
}

/// This PC as a board of another AutoGlow's tournament
#[derive(Default)]
struct Join {
    address: String,
    host_name: String,
    tournament_name: String,
    /// connecting, waiting (for approval), approved, rejected, offline, ended
    status: String,
    reason: String,
    tx: Option<UnboundedSender<String>>,
    tournament: Option<Value>,
    /// Live scores of every running match, from the host
    live: Value,
    assignment: Option<Value>,
    gen: u64,
    /// The tournament's id and its host's node, to find the host again on the network
    tid: String,
    host_node: String,
    /// The host's full tournament as last received, so this board can take over as host
    backup: Option<Value>,
    offline_since: f64,
    look_at: f64,
}

/// What this PC's board does for its assigned match
#[derive(Default)]
struct Agent {
    /// The match "Start game" started, or the last lobby that matched the checklist (started, it
    /// is this match: same id)
    ok_lobby: Option<String>,
    match_id: Option<String>,
    linked: Option<String>,
    done_ad: Vec<String>,
    outbox: Vec<Value>,
    checklist: Value,
    checklist_ok: bool,
    lobby_open: bool,
    live: Value,
    missing_since: f64,
    /// The Autodarts match that went missing (aborted, or Autodarts was closed or left): it is
    /// linked again if it shows up, so a game played on after a reopen still counts
    lost: Option<String>,
    notice: String,
    notice_at: f64,
    last_status: String,
    last_status_at: f64,
}

#[derive(Default)]
struct Inner {
    node_id: String,
    node_name: String,
    hosted: Option<Tournament>,
    peers: HashMap<String, UnboundedSender<String>>,
    board_status: HashMap<String, Value>,
    join: Option<Join>,
    join_gen: u64,
    agent: Agent,
    /// Host: the last score seen per live match, for typing in a result the board missed
    last_live: HashMap<String, Value>,
    /// This PC's club role: alone, club (keeps the club's players and games) or board; advertised
    /// so boards find the club PC and Settings can list every PC's role
    club: String,
}

pub struct Tournaments {
    inner: Mutex<Inner>,
    file: PathBuf,
    bridge: Option<Arc<AutodartsBridge>>,
    port: u16,
    searching: tokio::sync::Mutex<()>,
    /// The address last announced; announced again when DHCP gives this PC a new one
    adv_ip: Mutex<String>,
    mdns: Mutex<Option<(mdns_sd::ServiceDaemon, String)>>,
}

fn host_name_default() -> String {
    std::fs::read_to_string("/etc/hostname")
        .ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "AutoGlow".into())
}

impl Tournaments {
    pub fn new(dir: PathBuf, bridge: Option<Arc<AutodartsBridge>>, port: u16) -> Arc<Self> {
        let file = dir.join("tournament").join("state.json");
        let mut inner = Inner::default();
        let saved = crate::storage::read_json_file(&file).unwrap_or_default();
        inner.node_id = saved.get("node_id").map(py_str).filter(|s| s.len() >= 8).unwrap_or_else(|| format!("{:016x}", rand::random::<u64>()));
        inner.node_name = saved.get("node_name").map(py_str).filter(|s| !s.trim().is_empty()).unwrap_or_else(host_name_default);
        inner.hosted = saved.get("hosted").and_then(|v| serde_json::from_value(v.clone()).ok());
        if let Some(Value::Object(j)) = saved.get("join") {
            inner.join = Some(Join {
                address: j.get("address").map(py_str).unwrap_or_default(),
                host_name: j.get("host_name").map(py_str).unwrap_or_default(),
                tournament_name: j.get("tournament_name").map(py_str).unwrap_or_default(),
                tid: j.get("tid").map(py_str).unwrap_or_default(),
                host_node: j.get("host_node").map(py_str).unwrap_or_default(),
                backup: j.get("backup").filter(|v| v.is_object()).cloned(),
                status: "connecting".into(),
                ..Default::default()
            });
        }
        if let Some(Value::Array(o)) = saved.get("outbox") {
            inner.agent.outbox = o.clone();
        }
        if let Some(Value::Array(d)) = saved.get("done_ad") {
            inner.agent.done_ad = d.iter().map(py_str).collect();
        }
        // The Autodarts match this board was playing: after a restart it is still linked
        let link = saved.get("link").cloned().unwrap_or(Value::Null);
        if let (Some(m), Some(ad)) = (link["match"].as_str(), link["ad"].as_str()) {
            inner.agent.match_id = Some(m.into());
            inner.agent.linked = Some(ad.into());
        }
        if let Some(t) = inner.hosted.as_mut() {
            for b in t.boards.iter_mut() {
                b.online = b.node_id == inner.node_id;
            }
        }
        Arc::new(Tournaments { inner: Mutex::new(inner), file, bridge, port, mdns: Mutex::new(None), searching: tokio::sync::Mutex::new(()), adv_ip: Mutex::new(String::new()) })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn save(&self, g: &Inner) {
        let join = g.join.as_ref().filter(|j| j.status != "rejected" && j.status != "ended").map(|j| json!({"address": j.address, "host_name": j.host_name, "tournament_name": j.tournament_name, "tid": j.tid, "host_node": j.host_node, "backup": j.backup}));
        let v = json!({
            "node_id": g.node_id, "node_name": g.node_name, "hosted": g.hosted, "join": join,
            "outbox": g.agent.outbox, "done_ad": g.agent.done_ad.iter().rev().take(50).rev().collect::<Vec<_>>(),
            "link": g.agent.linked.as_ref().map(|ad| json!({"match": g.agent.match_id, "ad": ad})),
        });
        if let Err(e) = crate::storage::write_atomic(&self.file, crate::storage::pretty_json(&v).as_bytes()) {
            warn!("Could not save the tournament: {}", e);
        }
    }

    pub fn start(self: &Arc<Self>) {
        self.advertise();
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_millis(500));
            loop {
                iv.tick().await;
                me.tick();
            }
        });
        // A board offline for a minute gives back a match that has not started
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(5));
            loop {
                iv.tick().await;
                let mut g = me.lock();
                let stale = g.hosted.as_ref().map_or(false, |t| engine::schedule(&mut t.clone()));
                if stale {
                    me.host_changed(&mut g);
                }
            }
        });
        // A host that was gone checks whether a board took over meanwhile
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(30));
            loop {
                iv.tick().await;
                me.step_down_if_replaced().await;
            }
        });
        // A new address from DHCP: announce it, or the other PCs keep trying the old one
        let me = Arc::clone(self);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(10));
            loop {
                iv.tick().await;
                let now_ip = crate::discovery::primary_ipv4().map(|i| i.to_string()).unwrap_or_default();
                let old = me.adv_ip.lock().unwrap_or_else(|e| e.into_inner()).clone();
                if !now_ip.is_empty() && now_ip != old {
                    info!("This PC's address changed from {} to {}; announcing it again", old, now_ip);
                    me.advertise();
                }
            }
        });
        let addr = {
            let mut g = self.lock();
            let a = g.join.as_ref().map(|j| j.address.clone());
            if a.is_some() {
                g.join_gen += 1;
                let gen = g.join_gen;
                if let Some(j) = g.join.as_mut() {
                    j.gen = gen;
                }
            }
            a.map(|a| (a, g.join_gen))
        };
        if let Some((a, gen)) = addr {
            tokio::spawn(Arc::clone(self).run_join(gen, a));
        }
    }

    // -----------------------------------------------------------------------------------------
    // Discovery
    // -----------------------------------------------------------------------------------------

    /// Advertise this AutoGlow (and the tournament it hosts) as _autoglow._tcp
    fn advertise(&self) {
        let (node, name, tour, club, tid, since) = {
            let g = self.lock();
            let t = g.hosted.as_ref().filter(|t| t.status == "running" || t.status == "lobby");
            (g.node_id.clone(), g.node_name.clone(), t.map(|t| t.name.clone()).unwrap_or_default(), g.club.clone(), t.map(|t| t.id.clone()).unwrap_or_default(), t.map(|t| t.host_since.to_string()).unwrap_or_default())
        };
        let mut m = self.mdns.lock().unwrap_or_else(|e| e.into_inner());
        if m.is_none() {
            match mdns_sd::ServiceDaemon::new() {
                Ok(d) => *m = Some((d, String::new())),
                Err(e) => {
                    warn!("Tournament discovery unavailable: {}", e);
                    return;
                }
            }
        }
        let Some((d, full)) = m.as_mut() else { return };
        if !full.is_empty() {
            let _ = d.unregister(full);
        }
        let ip = crate::discovery::primary_ipv4().map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into());
        *self.adv_ip.lock().unwrap_or_else(|e| e.into_inner()) = ip.clone();
        let host = format!("autoglow-{}.local.", &node[..8.min(node.len())]);
        let instance: String = name.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
        let props = [("node", node.as_str()), ("name", name.as_str()), ("tournament", tour.as_str()), ("protocol", "1"), ("club", if club == "club" { "1" } else { "" }), ("role", club.as_str()), ("version", env!("CARGO_PKG_VERSION")), ("tid", tid.as_str()), ("since", since.as_str())];
        match mdns_sd::ServiceInfo::new(SERVICE_TYPE, if instance.is_empty() { "AutoGlow" } else { &instance }, &host, ip.as_str(), self.port, &props[..]) {
            Ok(info) => {
                *full = info.get_fullname().to_string();
                if let Err(e) = d.register(info) {
                    warn!("Could not advertise the tournament: {}", e);
                }
            }
            Err(e) => warn!("Could not advertise the tournament: {}", e),
        }
    }

    /// AutoGlows found on the network, those hosting a tournament first
    pub async fn discover(self: &Arc<Self>) -> Vec<Value> {
        // One search at a time: a second browse would be stopped by the first one's stop_browse
        let _turn = self.searching.lock().await;
        let me = self.lock().node_id.clone();
        let rx = {
            let m = self.mdns.lock().unwrap_or_else(|e| e.into_inner());
            match m.as_ref().map(|(d, _)| d.browse(SERVICE_TYPE)) {
                Some(Ok(rx)) => rx,
                _ => return Vec::new(),
            }
        };
        let found = tokio::task::spawn_blocking(move || {
            let mut out: HashMap<String, Value> = HashMap::new();
            let end = std::time::Instant::now() + Duration::from_millis(1800);
            while let Some(left) = end.checked_duration_since(std::time::Instant::now()) {
                match rx.recv_timeout(left) {
                    Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                        let node = info.get_property_val_str("node").unwrap_or("").to_string();
                        if node.is_empty() || node == me {
                            continue;
                        }
                        let Some(ip) = info.get_addresses_v4().into_iter().next().copied() else { continue };
                        out.insert(
                            node.clone(),
                            json!({
                                "node": node, "name": info.get_property_val_str("name").unwrap_or(""),
                                "tournament": info.get_property_val_str("tournament").unwrap_or(""),
                                "club": info.get_property_val_str("club") == Some("1"),
                                "role": info.get_property_val_str("role").unwrap_or(""),
                                "tid": info.get_property_val_str("tid").unwrap_or(""),
                                "since": info.get_property_val_str("since").and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                                "version": info.get_property_val_str("version").unwrap_or(""),
                                "address": format!("{}:{}", ip, info.get_port()),
                            }),
                        );
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
            out.into_values().collect::<Vec<_>>()
        })
        .await
        .unwrap_or_default();
        if let Some((d, _)) = self.mdns.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = d.stop_browse(SERVICE_TYPE);
        }
        let mut found = found;
        found.sort_by_key(|v| (v["tournament"].as_str().unwrap_or("").is_empty(), v["name"].as_str().unwrap_or("").to_lowercase()));
        found
    }

    /// The port this AutoGlow listens on
    pub fn port(&self) -> u16 {
        self.port
    }

    /// This PC's node id and board name
    pub fn node(&self) -> (String, String) {
        let g = self.lock();
        (g.node_id.clone(), g.node_name.clone())
    }

    /// Advertise this PC's club role (the club PC is how boards find it)
    pub fn set_club(&self, role: &str) {
        let changed = {
            let mut g = self.lock();
            std::mem::replace(&mut g.club, role.to_string()) != role
        };
        if changed && self.mdns.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
            self.advertise();
        }
    }

    // -----------------------------------------------------------------------------------------
    // What the local page shows
    // -----------------------------------------------------------------------------------------

    pub fn local_view(&self) -> Value {
        let g = self.lock();
        let role = if g.hosted.is_some() { "host" } else if g.join.is_some() { "board" } else { "none" };
        let assignment = match &g.hosted {
            Some(t) => engine::assignment_for(t, &g.node_id),
            None => g.join.as_ref().and_then(|j| j.assignment.clone()),
        };
        let tournament = match &g.hosted {
            Some(t) => {
                let mut v = engine::view(t);
                if let Some(ms) = v.get_mut("matches").and_then(Value::as_array_mut) {
                    for m in ms.iter_mut() {
                        if m["state"] == "live" || m["state"] == "assigned" {
                            m["last_live"] = g.last_live.get(m["id"].as_str().unwrap_or("")).cloned().unwrap_or(Value::Null);
                        }
                    }
                }
                // The lobby: is it ready to start, and how many matches it makes
                if let Some(spec) = t.lobby.as_ref().filter(|_| t.status == "lobby") {
                    v["lobby_check"] = match engine::create(spec, "check", 0.0) {
                        Ok(c) => json!({"ok": true, "matches": c.matches.iter().filter(|m| m.state != "skipped" && !m.sides.iter().any(|s| s.bye)).count(), "groups": c.groups.len()}),
                        Err(e) => json!({"ok": false, "error": e}),
                    };
                }
                if let Some(bs) = v.get_mut("boards").and_then(Value::as_array_mut) {
                    for b in bs.iter_mut() {
                        let id = b["node_id"].as_str().unwrap_or("").to_string();
                        b["status"] = g.board_status.get(&id).cloned().unwrap_or(Value::Null);
                        b["this_pc"] = json!(id == g.node_id);
                    }
                }
                Some(v)
            }
            None => g.join.as_ref().and_then(|j| {
                let mut v = j.tournament.clone()?;
                if let Some(ms) = v.get_mut("matches").and_then(Value::as_array_mut) {
                    for m in ms.iter_mut().filter(|m| m["state"] == "live") {
                        m["last_live"] = j.live.get(m["id"].as_str().unwrap_or("")).cloned().unwrap_or(Value::Null);
                    }
                }
                Some(v)
            }),
        };
        let a = &g.agent;
        json!({
            "role": role,
            "node": {"id": g.node_id, "name": g.node_name},
            "tournament": tournament,
            "join": g.join.as_ref().map(|j| {
                let away = if j.status == "offline" && j.offline_since > 0.0 { (now() - j.offline_since).round() } else { 0.0 };
                json!({"address": j.address, "host_name": j.host_name, "tournament_name": j.tournament_name, "status": j.status, "reason": j.reason,
                    "offline_for": away, "can_take_over": j.backup.is_some() && away >= TAKEOVER_AFTER})
            }),
            "board": {
                "assignment": assignment, "checklist": a.checklist, "checklist_ok": a.checklist_ok, "lobby_open": a.lobby_open,
                "linked": a.linked, "live": a.live, "outbox": a.outbox.len(),
                "notice": if now() - a.notice_at < 8.0 { json!(a.notice) } else { Value::Null },
            },
        })
    }

    // -----------------------------------------------------------------------------------------
    // Host actions
    // -----------------------------------------------------------------------------------------

    fn with_host<R>(&self, f: impl FnOnce(&mut Inner) -> Result<R, String>) -> Result<R, String> {
        let mut g = self.lock();
        if g.hosted.is_none() {
            return Err("This PC is not hosting a tournament".into());
        }
        let r = f(&mut g)?;
        self.host_changed(&mut g);
        Ok(r)
    }

    /// After every change: hand out matches, save, tell every board
    fn host_changed(&self, g: &mut Inner) {
        let Some(t) = g.hosted.as_mut() else { return };
        engine::schedule(t);
        let t = g.hosted.as_ref().unwrap();
        let view = engine::view(t);
        // Approved boards keep the whole tournament, so one of them can take over if this PC is gone
        let full = serde_json::to_value(t).unwrap_or(Value::Null);
        let live = Self::live_scores(g);
        for (node, tx) in &g.peers {
            let approved = t.boards.iter().any(|b| &b.node_id == node && b.approved);
            let msg = json!({"t": "state", "approved": approved, "host_name": g.node_name, "host_node": g.node_id, "tid": t.id, "tournament": if approved { view.clone() } else { json!({"name": t.name}) }, "full": if approved { full.clone() } else { Value::Null }, "live": live, "assignment": engine::assignment_for(t, node)});
            let _ = tx.send(msg.to_string());
        }
        self.save(g);
    }

    pub fn create(&self, spec: &Spec, host_plays: bool) -> Result<(), String> {
        {
            let mut g = self.lock();
            if g.hosted.as_ref().map_or(false, |t| t.status == "running" || t.status == "lobby") {
                return Err("This PC already hosts a running tournament".into());
            }
            if g.join.is_some() {
                return Err("This PC is a board of another tournament. Leave it first.".into());
            }
            let id = format!("{:x}", rand::random::<u64>());
            let mut t = engine::create(spec, &id, now())?;
            t.host_node = g.node_id.clone();
            t.host_name = g.node_name.clone();
            t.boards.push(engine::Board { node_id: g.node_id.clone(), name: g.node_name.clone(), number: 1, approved: true, plays: host_plays, online: true, left: false, offline_since: 0.0, pick: String::new() });
            info!("Hosting tournament '{}' ({}, {} players)", t.name, t.format, t.players.len());
            g.hosted = Some(t);
            g.agent = Agent { done_ad: std::mem::take(&mut g.agent.done_ad), ..Default::default() };
            self.host_changed(&mut g);
        }
        self.advertise();
        Ok(())
    }

    /// "Host a tournament": open its lobby at once, so boards can join while the organizer sets
    /// up the rules and players. Nothing is played until start_lobby builds the bracket.
    pub fn open_lobby(&self, format: &str) -> Result<(), String> {
        {
            let mut g = self.lock();
            if g.hosted.is_some() {
                return Err("This PC already hosts a tournament".into());
            }
            if g.join.is_some() {
                return Err("This PC is a board of another tournament. Leave it first.".into());
            }
            let format = if engine::FORMATS.contains(&format) { format } else { "single_ko" };
            let spec = Spec { name: "Local Tournament".into(), format: format.into(), advance: 2, ..Default::default() };
            let mut t = engine::lobby(&format!("{:x}", rand::random::<u64>()), now());
            lobby_fields(&mut t, &spec);
            t.lobby = Some(spec);
            t.host_node = g.node_id.clone();
            t.host_name = g.node_name.clone();
            t.boards.push(engine::Board { node_id: g.node_id.clone(), name: g.node_name.clone(), number: 1, approved: true, plays: true, online: true, left: false, offline_since: 0.0, pick: String::new() });
            info!("Tournament lobby '{}' open", t.name);
            g.hosted = Some(t);
            g.agent = Agent { done_ad: std::mem::take(&mut g.agent.done_ad), ..Default::default() };
            self.host_changed(&mut g);
        }
        self.advertise();
        Ok(())
    }

    /// The organizer changed the rules or players in the lobby
    pub fn update_lobby(&self, spec: Spec) -> Result<(), String> {
        let renamed = self.with_host(|g| {
            let t = g.hosted.as_mut().unwrap();
            if t.status != "lobby" {
                return Err("The tournament has already started".into());
            }
            let old = t.name.clone();
            lobby_fields(t, &spec);
            t.lobby = Some(spec);
            Ok(old != t.name)
        })?;
        if renamed {
            self.advertise();
        }
        Ok(())
    }

    /// Build the bracket from the lobby and start handing out matches. Returns the players, so
    /// the caller can give the new ones a club profile.
    pub fn start_lobby(&self) -> Result<Vec<engine::Player>, String> {
        self.with_host(|g| {
            let t = g.hosted.as_mut().unwrap();
            let spec = t.lobby.clone().filter(|_| t.status == "lobby").ok_or("The tournament has already started")?;
            let mut n = engine::create(&spec, &t.id, now())?;
            n.boards = std::mem::take(&mut t.boards);
            n.host_node = std::mem::take(&mut t.host_node);
            n.host_name = std::mem::take(&mut t.host_name);
            n.host_since = t.host_since;
            info!("Tournament '{}' started ({}, {} players, {} boards)", n.name, n.format, n.players.len(), n.boards.iter().filter(|b| b.approved && !b.left).count());
            let players = n.players.clone();
            *t = n;
            Ok(players)
        })
    }

    pub fn end(&self) -> Result<(), String> {
        {
            let mut g = self.lock();
            let t = g.hosted.take().ok_or("This PC is not hosting a tournament")?;
            info!("Tournament '{}' ended", t.name);
            for tx in g.peers.values() {
                let _ = tx.send(json!({"t": "ended"}).to_string());
            }
            g.peers.clear();
            g.board_status.clear();
            g.agent = Agent { done_ad: std::mem::take(&mut g.agent.done_ad), ..Default::default() };
            self.save(&g);
        }
        self.advertise();
        Ok(())
    }

    /// End the tournament on its host from any PC: a board of it, or a PC that only sees it on the
    /// network (the host's own screen may be out of reach). The network is private and trusted.
    pub async fn end_at(&self, address: &str) -> Result<(), String> {
        let addr = if address.is_empty() { self.lock().join.as_ref().map(|j| j.address.clone()).unwrap_or_default() } else { address.to_string() };
        if addr.is_empty() {
            return Err("No host to ask".into());
        }
        let addr = if addr.contains(':') { addr } else { format!("{}:8080", addr) };
        let url = format!("http://{}/api/tournament/end-remote", addr);
        tokio::task::spawn_blocking(move || match ureq::post(&url).timeout(Duration::from_secs(5)).send_json(json!({})) {
            Ok(_) => Ok(()),
            Err(ureq::Error::Status(_, r)) => Err(r.into_json::<Value>().ok().map(|v| py_str(&v["message"])).filter(|m| !m.is_empty()).unwrap_or_else(|| "The host refused it".into())),
            Err(_) => Err("The host is not reachable. Take over as host first, then end it there.".into()),
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn export(&self) -> Option<Value> {
        self.lock().hosted.as_ref().map(|t| serde_json::to_value(t).unwrap_or(Value::Null))
    }

    /// Continue an exported tournament on this PC, which becomes its host
    pub fn import(&self, v: Value) -> Result<(), String> {
        {
            let mut g = self.lock();
            if g.hosted.is_some() || g.join.is_some() {
                return Err("End or leave the current tournament first".into());
            }
            let mut t: Tournament = serde_json::from_value(v).map_err(|e| format!("Not a tournament file: {}", e))?;
            let me = g.node_id.clone();
            let name = g.node_name.clone();
            for m in t.matches.iter_mut() {
                if m.state == "assigned" || m.state == "live" {
                    m.state = "ready".into();
                    m.board = None;
                }
            }
            t.boards.retain(|b| b.node_id != t.host_node);
            for b in t.boards.iter_mut() {
                b.online = false;
            }
            let n = t.boards.iter().map(|b| b.number).max().unwrap_or(0) + 1;
            t.boards.push(engine::Board { node_id: me.clone(), name: name.clone(), number: n, approved: true, plays: true, online: true, left: false, offline_since: 0.0, pick: String::new() });
            t.host_node = me;
            t.host_name = name;
            engine::resolve(&mut t);
            g.hosted = Some(t);
            self.host_changed(&mut g);
        }
        self.advertise();
        Ok(())
    }

    pub fn approve(&self, node: &str, approve: bool) -> Result<(), String> {
        self.with_host(|g| {
            let t = g.hosted.as_mut().unwrap();
            let b = t.boards.iter_mut().find(|b| b.node_id == node).ok_or("Unknown board")?;
            if approve {
                b.approved = true;
                b.left = false;
            } else {
                t.boards.retain(|b| b.node_id != node);
                if let Some(tx) = g.peers.remove(node) {
                    let _ = tx.send(json!({"t": "rejected", "reason": "The host did not let this board join"}).to_string());
                }
            }
            Ok(())
        })
    }

    pub fn set_plays(&self, node: &str, plays: bool) -> Result<(), String> {
        self.with_host(|g| {
            let t = g.hosted.as_mut().unwrap();
            t.boards.iter_mut().find(|b| b.node_id == node).ok_or("Unknown board")?.plays = plays;
            Ok(())
        })
    }

    pub fn result(&self, match_id: &str, legs: [i64; 2], walkover_winner: Option<usize>) -> Result<(), String> {
        self.with_host(|g| {
            let t = g.hosted.as_mut().unwrap();
            let r = match walkover_winner {
                Some(w) => MatchResult { winner: w.min(1), walkover: true, ..Default::default() },
                None => {
                    // A typed score must be a finished game: the winner has exactly the legs (or sets) to win
                    let m = t.get(match_id).ok_or("Unknown match")?;
                    let gs = t.settings_for(m);
                    // A correction of a game played before the distances changed is checked by set_result only
                    let checked = m.state != "done";
                    let (need, unit) = if gs.sets > 0 { (gs.sets, "sets") } else { (gs.legs, "legs") };
                    let (hi, lo) = (legs[0].max(legs[1]), legs[0].min(legs[1]));
                    if checked && (hi != need || lo >= need || lo < 0) {
                        return Err(format!("{} is first to {} {}: the winner needs {}, the loser less", match_id, need, if need == 1 { unit.trim_end_matches('s') } else { unit }, need));
                    }
                    // A corrected score keeps the averages and 180s the board measured in the real game
                    let prev = t.get(match_id).and_then(|m| m.result.clone()).filter(|r| !r.walkover);
                    MatchResult {
                        legs,
                        winner: if legs[0] > legs[1] { 0 } else { 1 },
                        ad_match: prev.as_ref().and_then(|r| r.ad_match.clone()),
                        stats: prev.map(|r| r.stats).unwrap_or_default(),
                        ..Default::default()
                    }
                }
            };
            engine::set_result(t, match_id, r)
        })
    }

    pub fn set_distances(&self, legs: i64, sets: i64, ko_legs: i64, semi_legs: i64, final_legs: i64) -> Result<(), String> {
        self.with_host(|g| engine::set_distances(g.hosted.as_mut().unwrap(), legs, sets, ko_legs, semi_legs, final_legs))
    }

    pub fn withdraw(&self, player: &str) -> Result<(), String> {
        self.with_host(|g| engine::withdraw(g.hosted.as_mut().unwrap(), player))
    }

    /// Hold a match back, let it go again, or move it to another free board
    /// Play a match again from scratch on another board (its board is gone)
    pub fn replay(&self, match_id: &str) -> Result<(), String> {
        self.with_host(|g| {
            g.last_live.remove(match_id);
            engine::replay(g.hosted.as_mut().unwrap(), match_id)
        })
    }

    /// "Play here" on this PC: on the host it happens at once, a board asks the host
    pub fn claim(&self, match_id: &str) -> Result<(), String> {
        let mut g = self.lock();
        if g.hosted.is_some() {
            let me = g.node_id.clone();
            engine::claim(g.hosted.as_mut().unwrap(), match_id, &me)?;
            self.host_changed(&mut g);
            return Ok(());
        }
        let j = g.join.as_ref().ok_or("This PC is not in a tournament")?;
        let tx = j.tx.as_ref().filter(|_| j.status == "approved").ok_or("The host is not reachable right now")?;
        tx.send(json!({"t": "claim", "match": match_id}).to_string()).map_err(|_| "The host is not reachable right now".to_string())
    }

    /// The match lined up on this PC's board page, for the other screens; a board tells the host
    pub fn pick(&self, match_id: &str) -> Result<(), String> {
        let mut g = self.lock();
        if g.hosted.is_some() {
            let me = g.node_id.clone();
            if engine::set_pick(g.hosted.as_mut().unwrap(), &me, match_id) {
                self.host_changed(&mut g);
            }
            return Ok(());
        }
        // Only a hint: while the host is away it is simply not shown
        if let Some(tx) = g.join.as_ref().filter(|j| j.status == "approved").and_then(|j| j.tx.as_ref()) {
            let _ = tx.send(json!({"t": "pick", "match": match_id}).to_string());
        }
        Ok(())
    }

    pub fn assign(&self, match_id: &str, board: Option<&str>, hold: Option<bool>) -> Result<(), String> {
        self.with_host(|g| {
            let t = g.hosted.as_mut().unwrap();
            let busy: Vec<String> = t.matches.iter().filter(|m| (m.state == "assigned" || m.state == "live") && m.id != match_id).filter_map(|m| m.board.clone()).collect();
            let m = t.matches.iter_mut().find(|m| m.id == match_id).ok_or("Unknown match")?;
            if m.state == "live" {
                return Err("The match is being played".into());
            }
            if m.state != "ready" && m.state != "assigned" {
                return Err("The match is not ready".into());
            }
            if let Some(h) = hold {
                m.held = h;
                if h {
                    m.state = "ready".into();
                    m.board = None;
                }
            }
            if let Some(b) = board {
                if busy.iter().any(|x| x == b) {
                    return Err("That board is busy".into());
                }
                m.held = false;
                m.state = "assigned".into();
                m.board = Some(b.to_string());
            }
            Ok(())
        })
    }

    // -----------------------------------------------------------------------------------------
    // Host side of the board link
    // -----------------------------------------------------------------------------------------

    pub async fn peer_session(self: Arc<Self>, mut sock: WebSocket) {
        let hello = match tokio::time::timeout(Duration::from_secs(5), sock.recv()).await {
            Ok(Some(Ok(AxMsg::Text(t)))) => serde_json::from_str::<Value>(&t).unwrap_or(Value::Null),
            _ => return,
        };
        let node = hello["node"].as_str().unwrap_or("").to_string();
        if hello["t"] != "hello" || node.is_empty() {
            return;
        }
        if hello["protocol"].as_i64() != Some(PROTOCOL) {
            let _ = sock.send(AxMsg::Text(json!({"t": "rejected", "reason": "This AutoGlow version can't join the host's tournament. Update both PCs."}).to_string().into())).await;
            return;
        }
        let (tx, mut rx) = unbounded_channel::<String>();
        let hosting = self.lock().hosted.is_some();
        if !hosting {
            let _ = sock.send(AxMsg::Text(json!({"t": "rejected", "code": "not_hosting", "reason": "That PC is not hosting a tournament any more"}).to_string().into())).await;
            return;
        }
        {
            let mut g = self.lock();
            let me = g.node_id.clone();
            let Some(t) = g.hosted.as_mut() else { return };
            if node == me {
                return;
            }
            let name = hello["name"].as_str().unwrap_or("Board").to_string();
            match t.boards.iter_mut().find(|b| b.node_id == node) {
                Some(b) => {
                    b.online = true;
                    b.approved = true;
                    b.left = false;
                    b.offline_since = 0.0;
                    b.name = name;
                }
                None => {
                    let n = t.boards.iter().map(|b| b.number).max().unwrap_or(0) + 1;
                    // Every board is let in, also after the start: it's the organizer's own network
                    info!("Board '{}' joined the tournament", name);
                    t.boards.push(engine::Board { node_id: node.clone(), name, number: n, approved: true, plays: true, online: true, left: false, offline_since: 0.0, pick: String::new() });
                }
            }
            g.peers.insert(node.clone(), tx);
            self.host_changed(&mut g);
        }
        let mut ping = tokio::time::interval(PING_EVERY);
        let mut heard = std::time::Instant::now();
        loop {
            tokio::select! {
                out = rx.recv() => match out {
                    Some(text) => if sock.send(AxMsg::Text(text.into())).await.is_err() { break },
                    None => break,
                },
                msg = sock.recv() => match msg {
                    Some(Ok(m)) if !matches!(m, AxMsg::Close(_)) && !matches!(m, AxMsg::Text(_)) => heard = std::time::Instant::now(),
                    Some(Ok(AxMsg::Text(t))) => {
                        heard = std::time::Instant::now();
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            if let Some(reply) = self.on_peer_message(&node, &v) {
                                if sock.send(AxMsg::Text(reply.to_string().into())).await.is_err() { break }
                            }
                        }
                    }
                    Some(Ok(AxMsg::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                },
                _ = ping.tick() => {
                    if heard.elapsed() > LINK_TIMEOUT {
                        warn!("Board {} stopped answering, marking it offline", node);
                        break;
                    }
                    if sock.send(AxMsg::Ping(Vec::new().into())).await.is_err() { break }
                }
            }
        }
        let mut g = self.lock();
        if g.peers.get(&node).map_or(false, |t| t.is_closed()) || g.peers.contains_key(&node) {
            g.peers.remove(&node);
        }
        if let Some(t) = g.hosted.as_mut() {
            if let Some(b) = t.boards.iter_mut().find(|b| b.node_id == node) {
                b.online = false;
                b.offline_since = now();
            }
        }
        g.board_status.remove(&node);
        self.host_changed(&mut g);
    }

    /// Host: the score of every running match
    fn live_scores(g: &Inner) -> Value {
        let Some(t) = g.hosted.as_ref() else { return json!({}) };
        let live: serde_json::Map<String, Value> = t.matches.iter().filter(|m| m.state == "live").filter_map(|m| Some((m.id.clone(), g.last_live.get(&m.id)?.clone()))).collect();
        json!(live)
    }

    /// Host: keep a live match's score and pass it on to the boards, so every board lists it
    fn note_live(g: &mut Inner, status: &Value) {
        let (Some(m), true) = (status["match"].as_str(), status["live"].is_object()) else { return };
        if g.last_live.get(m) == Some(&status["live"]) {
            return;
        }
        g.last_live.insert(m.to_string(), status["live"].clone());
        let msg = json!({"t": "live", "live": Self::live_scores(g)}).to_string();
        for tx in g.peers.values() {
            let _ = tx.send(msg.clone());
        }
    }

    fn on_peer_message(&self, node: &str, v: &Value) -> Option<Value> {
        let mut g = self.lock();
        match v["t"].as_str().unwrap_or("") {
            "status" => {
                g.board_status.insert(node.to_string(), v.clone());
                Self::note_live(&mut g, v);
                if self.mark_live(&mut g, node, v["match"].as_str(), v["linked"].as_str()) {
                    self.host_changed(&mut g);
                }
                None
            }
            "result" => {
                let mid = v["match"].as_str().unwrap_or("").to_string();
                let r: MatchResult = serde_json::from_value(v["result"].clone()).unwrap_or_default();
                let t = g.hosted.as_mut()?;
                let already = t.get(&mid).map_or(false, |m| m.state == "done" && m.ad_match.is_some() && m.ad_match == r.ad_match);
                // Also a match that went to another board while this one was offline, unless it is being played there
                let mine = t.get(&mid).map_or(false, |m| {
                    (m.board.as_deref() == Some(node) && (m.state == "assigned" || m.state == "live")) || m.state == "ready" || (m.state == "assigned" && m.board.as_deref() != Some(node))
                });
                let mut reply = json!({"t": "ack", "match": mid, "ad_match": r.ad_match});
                if mine {
                    if let Err(e) = engine::set_result(t, &mid, r) {
                        warn!("Result for {} from board {} refused: {}", mid, node, e);
                        reply["error"] = json!(e);
                    }
                    self.host_changed(&mut g);
                } else if !already {
                    reply["error"] = json!("The host no longer expects this result");
                }
                Some(reply)
            }
            "claim" => {
                let mid = v["match"].as_str().unwrap_or("").to_string();
                let t = g.hosted.as_mut()?;
                let r = engine::claim(t, &mid, node);
                self.host_changed(&mut g);
                r.err().map(|e| json!({"t": "claimed", "match": mid, "error": e}))
            }
            "pick" => {
                let t = g.hosted.as_mut()?;
                if engine::set_pick(t, node, v["match"].as_str().unwrap_or("")) {
                    self.host_changed(&mut g);
                }
                None
            }
            "leave" => {
                if let Some(t) = g.hosted.as_mut() {
                    if let Some(b) = t.boards.iter_mut().find(|b| b.node_id == node) {
                        b.left = true;
                    }
                }
                self.host_changed(&mut g);
                None
            }
            _ => None,
        }
    }

    /// A board reports which Autodarts match it linked: the assigned match goes live (or back)
    fn mark_live(&self, g: &mut Inner, node: &str, match_id: Option<&str>, linked: Option<&str>) -> bool {
        let Some(t) = g.hosted.as_mut() else { return false };
        let Some(m) = t.matches.iter_mut().find(|m| m.board.as_deref() == Some(node) && (m.state == "assigned" || m.state == "live")) else { return false };
        if match_id != Some(m.id.as_str()) {
            return false;
        }
        match (m.state.as_str(), linked) {
            ("assigned", Some(ad)) => {
                m.state = "live".into();
                m.ad_match = Some(ad.to_string());
                m.live_at = now();
                true
            }
            ("live", None) => {
                m.state = "assigned".into();
                m.ad_match = None;
                m.live_at = 0.0;
                true
            }
            _ => false,
        }
    }

    // -----------------------------------------------------------------------------------------
    // Board side of the link
    // -----------------------------------------------------------------------------------------

    pub fn join(self: &Arc<Self>, address: &str, host_name: &str, tournament_name: &str) -> Result<(), String> {
        let address = address.trim().trim_start_matches("http://").trim_start_matches("ws://").trim_end_matches('/').to_string();
        if address.is_empty() {
            return Err("Enter the host's address".into());
        }
        let address = if address.contains(':') { address } else { format!("{}:8080", address) };
        let gen = {
            let mut g = self.lock();
            if g.hosted.is_some() {
                return Err("This PC hosts a tournament. End it first.".into());
            }
            g.join_gen += 1;
            let gen = g.join_gen;
            g.join = Some(Join { address: address.clone(), host_name: host_name.into(), tournament_name: tournament_name.into(), status: "connecting".into(), gen, ..Default::default() });
            g.agent = Agent { done_ad: std::mem::take(&mut g.agent.done_ad), outbox: std::mem::take(&mut g.agent.outbox), ..Default::default() };
            self.save(&g);
            gen
        };
        tokio::spawn(Arc::clone(self).run_join(gen, address));
        Ok(())
    }

    pub fn leave(&self) -> Result<(), String> {
        let mut g = self.lock();
        let j = g.join.take().ok_or("This PC is not a board of a tournament")?;
        if let Some(tx) = &j.tx {
            let _ = tx.send(json!({"t": "leave"}).to_string());
        }
        g.join_gen += 1;
        g.agent = Agent { done_ad: std::mem::take(&mut g.agent.done_ad), ..Default::default() };
        self.save(&g);
        Ok(())
    }

    async fn run_join(self: Arc<Self>, gen: u64, _address: String) {
        let mut backoff = 1u64;
        loop {
            let Some(address) = self.lock().join.as_ref().filter(|j| j.gen == gen).map(|j| j.address.clone()) else { return };
            self.find_host(gen).await;
            let address = self.lock().join.as_ref().filter(|j| j.gen == gen).map_or(address, |j| j.address.clone());
            let url = format!("ws://{}{}", address, PEER_WS_PATH);
            let conn = tokio::time::timeout(Duration::from_secs(4), tokio_tungstenite::connect_async(&url)).await;
            let Ok(Ok((ws, _))) = conn else {
                self.set_join_status(gen, "offline", "");
                tokio::time::sleep(Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(15);
                continue;
            };
            backoff = 1;
            let (mut wr, mut rd) = ws.split();
            let (tx, mut rx) = unbounded_channel::<String>();
            let hello = {
                let mut g = self.lock();
                let Some(j) = g.join.as_mut().filter(|j| j.gen == gen) else { return };
                j.tx = Some(tx.clone());
                if j.status != "approved" {
                    j.status = "waiting".into();
                }
                let hello = json!({"t": "hello", "node": g.node_id, "name": g.node_name, "version": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL});
                for r in &g.agent.outbox {
                    let _ = tx.send(r.to_string());
                }
                g.agent.last_status.clear();
                hello
            };
            if wr.send(TgMsg::Text(hello.to_string().into())).await.is_err() {
                continue;
            }
            info!("Connected to the tournament host at {}", address);
            let mut stop = false;
            let mut check = tokio::time::interval(Duration::from_secs(2));
            let mut heard = std::time::Instant::now();
            loop {
                tokio::select! {
                    out = rx.recv() => match out {
                        Some(text) => if wr.send(TgMsg::Text(text.into())).await.is_err() { break },
                        None => break,
                    },
                    msg = rd.next() => match msg {
                        Some(Ok(TgMsg::Ping(p))) => {
                            heard = std::time::Instant::now();
                            if wr.send(TgMsg::Pong(p)).await.is_err() { break }
                        }
                        Some(Ok(TgMsg::Text(t))) => {
                            heard = std::time::Instant::now();
                            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                                if !self.on_host_message(gen, &v) { stop = true; break }
                            }
                        }
                        Some(Ok(TgMsg::Close(_))) | None | Some(Err(_)) => break,
                        _ => {}
                    },
                    _ = check.tick() => {
                        if self.lock().join.as_ref().map_or(true, |j| j.gen != gen) { let _ = wr.close().await; return }
                        if heard.elapsed() > LINK_TIMEOUT {
                            warn!("The tournament host at {} stopped answering, reconnecting", address);
                            break;
                        }
                    }
                }
            }
            {
                let mut g = self.lock();
                if let Some(j) = g.join.as_mut().filter(|j| j.gen == gen) {
                    j.tx = None;
                }
            }
            if stop {
                return;
            }
            self.set_join_status(gen, "offline", "");
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }

    /// A board whose host has been unreachable for a while searches the network for whoever hosts
    /// the tournament now: the same host at a new address, or a board that took over
    async fn find_host(self: &Arc<Self>, gen: u64) {
        let (tid, host) = {
            let mut g = self.lock();
            let Some(j) = g.join.as_mut().filter(|j| j.gen == gen && j.status == "offline" && !j.tid.is_empty()) else { return };
            if now() - j.offline_since < LOOK_AFTER || now() < j.look_at {
                return;
            }
            j.look_at = now() + 15.0;
            (j.tid.clone(), j.host_node.clone())
        };
        let found = self.discover().await;
        // The newest host wins (an old host that comes back steps down); same age: the one we had
        let since = |v: &Value| v["since"].as_f64().unwrap_or(0.0);
        let pick = found.iter().filter(|v| v["tid"] == tid.as_str()).max_by(|a, b| since(a).total_cmp(&since(b)).then_with(|| (a["node"] == host.as_str()).cmp(&(b["node"] == host.as_str()))));
        if let Some(h) = pick {
            let mut g = self.lock();
            if let Some(j) = g.join.as_mut().filter(|j| j.gen == gen) {
                let addr = py_str(&h["address"]);
                if j.address != addr {
                    info!("Tournament host is now {} at {}", py_str(&h["name"]), addr);
                    j.address = addr;
                    j.host_name = py_str(&h["name"]);
                    j.host_node = py_str(&h["node"]);
                    self.save(&g);
                }
            }
        }
    }

    /// The host has been gone for a while: this board becomes the host, from the copy it kept.
    /// The other boards find it on the network; the old host steps down if it comes back.
    pub async fn take_over(self: &Arc<Self>) -> Result<(), String> {
        let (tid, old) = {
            let g = self.lock();
            let j = g.join.as_ref().ok_or("This PC is not a board of a tournament")?;
            if j.status != "offline" || now() - j.offline_since < TAKEOVER_AFTER {
                return Err("The host is still reachable, or only just went offline. Wait a little.".into());
            }
            if j.backup.is_none() {
                return Err("This board has no copy of the tournament yet".into());
            }
            (j.tid.clone(), j.host_node.clone())
        };
        // Somebody may have taken over already, or the host may be back at a new address
        if let Some(h) = self.discover().await.into_iter().find(|v| v["tid"] == tid.as_str()) {
            let mut g = self.lock();
            if let Some(j) = g.join.as_mut() {
                j.address = py_str(&h["address"]);
                j.host_name = py_str(&h["name"]);
                j.host_node = py_str(&h["node"]);
            }
            return Err(format!("{} hosts the tournament{}. This board connects to it.", py_str(&h["name"]), if h["node"] == old.as_str() { " again" } else { " now" }));
        }
        {
            let mut g = self.lock();
            let g = &mut *g;
            let j = g.join.take().ok_or("This PC is not a board of a tournament")?;
            let mut t: Tournament = serde_json::from_value(j.backup.unwrap_or_default()).map_err(|e| format!("The copy of the tournament is damaged: {}", e))?;
            let me = g.node_id.clone();
            for m in t.matches.iter_mut() {
                // The old host's own match starts again on a free board
                if m.board.as_deref() == Some(old.as_str()) && (m.state == "assigned" || m.state == "live") {
                    m.state = "ready".into();
                    m.board = None;
                    m.ad_match = None;
                }
            }
            for b in t.boards.iter_mut() {
                b.online = b.node_id == me;
            }
            if !t.boards.iter().any(|b| b.node_id == me) {
                let n = t.boards.iter().map(|b| b.number).max().unwrap_or(0) + 1;
                t.boards.push(engine::Board { node_id: me.clone(), name: g.node_name.clone(), number: n, approved: true, plays: true, online: true, left: false, offline_since: 0.0, pick: String::new() });
            }
            t.host_node = me.clone();
            t.host_name = g.node_name.clone();
            t.host_since = now();
            // Results this board could not send yet
            for r in std::mem::take(&mut g.agent.outbox) {
                let mid = py_str(&r["match"]);
                let mine = t.get(&mid).map_or(false, |m| m.board.as_deref() == Some(me.as_str()) && (m.state == "assigned" || m.state == "live"));
                if let (true, Ok(res)) = (mine, serde_json::from_value::<MatchResult>(r["result"].clone())) {
                    let _ = engine::set_result(&mut t, &mid, res);
                }
            }
            warn!("Took over tournament '{}' as host (the host {} was gone)", t.name, j.host_name);
            g.join_gen += 1;
            g.hosted = Some(t);
            self.host_changed(g);
        }
        self.advertise();
        Ok(())
    }

    /// Host: another PC took the tournament over while this one was gone; become its board
    async fn step_down_if_replaced(self: &Arc<Self>) {
        let (tid, since, me) = {
            let g = self.lock();
            let Some(t) = g.hosted.as_ref().filter(|t| t.status == "running") else { return };
            (t.id.clone(), t.host_since, g.node_id.clone())
        };
        let found = self.discover().await;
        let Some(h) = found.iter().filter(|v| v["tid"] == tid.as_str() && v["node"] != me.as_str() && v["since"].as_f64().unwrap_or(0.0) > since).max_by(|a, b| a["since"].as_f64().unwrap_or(0.0).total_cmp(&b["since"].as_f64().unwrap_or(0.0))) else { return };
        let (address, name, node) = (py_str(&h["address"]), py_str(&h["name"]), py_str(&h["node"]));
        let gen = {
            let mut g = self.lock();
            let Some(t) = g.hosted.take() else { return };
            warn!("{} took over tournament '{}' while this PC was gone; joining it as a board", name, t.name);
            for tx in g.peers.values() {
                let _ = tx.send(json!({"t": "rejected", "code": "not_hosting", "reason": "This PC is not the host any more"}).to_string());
            }
            g.peers.clear();
            g.board_status.clear();
            g.join_gen += 1;
            let gen = g.join_gen;
            g.join = Some(Join { address: address.clone(), host_name: name, tournament_name: t.name.clone(), status: "connecting".into(), gen, tid, host_node: node, backup: serde_json::to_value(&t).ok(), ..Default::default() });
            g.agent = Agent { done_ad: std::mem::take(&mut g.agent.done_ad), outbox: std::mem::take(&mut g.agent.outbox), ..Default::default() };
            self.save(&g);
            gen
        };
        self.advertise();
        tokio::spawn(Arc::clone(self).run_join(gen, address));
    }

    fn set_join_status(&self, gen: u64, status: &str, reason: &str) {
        let mut g = self.lock();
        if let Some(j) = g.join.as_mut().filter(|j| j.gen == gen) {
            if j.status != "rejected" && j.status != "ended" {
                j.status = status.into();
                j.reason = reason.into();
                if status != "offline" {
                    j.offline_since = 0.0;
                } else if j.offline_since == 0.0 {
                    j.offline_since = now();
                }
            }
        }
    }

    /// false = stop the link (rejected or the tournament ended)
    fn on_host_message(&self, gen: u64, v: &Value) -> bool {
        let mut g = self.lock();
        let g = &mut *g;
        let Some(j) = g.join.as_mut().filter(|j| j.gen == gen) else { return false };
        match v["t"].as_str().unwrap_or("") {
            "state" => {
                let approved = v["approved"] == json!(true);
                j.status = if approved { "approved".into() } else { "waiting".into() };
                j.host_name = v["host_name"].as_str().unwrap_or(&j.host_name).to_string();
                j.tournament_name = v["tournament"]["name"].as_str().unwrap_or(&j.tournament_name).to_string();
                j.tournament = if approved { Some(v["tournament"].clone()) } else { None };
                j.live = v["live"].clone();
                j.assignment = v.get("assignment").filter(|a| !a.is_null()).cloned();
                if let Some(t) = v["tid"].as_str().filter(|t| !t.is_empty()) {
                    j.tid = t.into();
                }
                if let Some(h) = v["host_node"].as_str().filter(|h| !h.is_empty()) {
                    j.host_node = h.into();
                }
                if v["full"].is_object() {
                    j.backup = Some(v["full"].clone());
                }
                self.save(g);
                true
            }
            "live" => {
                j.live = v["live"].clone();
                true
            }
            "ack" => {
                let mid = v["match"].clone();
                g.agent.outbox.retain(|r| r["match"] != mid);
                if let Some(e) = v["error"].as_str() {
                    g.agent.notice = format!("Host: {}", e);
                    g.agent.notice_at = now();
                }
                self.save(g);
                true
            }
            "claimed" => {
                g.agent.notice = format!("Host: {}", v["error"].as_str().unwrap_or("could not move the match here"));
                g.agent.notice_at = now();
                true
            }
            "rejected" if v["code"] == "not_hosting" && !j.tid.is_empty() => {
                // The host handed over or stepped down: find who hosts the tournament now
                j.status = "offline".into();
                j.look_at = 0.0;
                if j.offline_since == 0.0 {
                    j.offline_since = now();
                }
                true
            }
            "rejected" => {
                j.status = "rejected".into();
                j.reason = v["reason"].as_str().unwrap_or("").to_string();
                j.tx = None;
                j.tournament = None;
                j.assignment = None;
                false
            }
            "ended" => {
                j.status = "ended".into();
                j.reason = "The host ended the tournament".into();
                j.tx = None;
                j.assignment = None;
                false
            }
            _ => true,
        }
    }

    pub fn set_name(&self, name: &str) -> Result<(), String> {
        let name = name.trim();
        if name.is_empty() || name.len() > 40 {
            return Err("Name must be 1 to 40 characters".into());
        }
        {
            let mut g = self.lock();
            g.node_name = name.into();
            let me = g.node_id.clone();
            if let Some(t) = g.hosted.as_mut() {
                t.host_name = name.into();
                if let Some(b) = t.boards.iter_mut().find(|b| b.node_id == me) {
                    b.name = name.into();
                }
                self.host_changed(&mut g);
            } else {
                self.save(&g);
            }
        }
        self.advertise();
        Ok(())
    }

    /// "Start game" started this Autodarts match for the assigned match: link it once its page is open
    pub fn started(&self, match_id: &str, ad_match: &str) -> Result<(), String> {
        let mut g = self.lock();
        let mine = g.agent.match_id.as_deref() == Some(match_id);
        if !mine || ad_match.is_empty() {
            return Err("This match is not on this board any more".into());
        }
        g.agent.ok_lobby = Some(ad_match.to_string());
        Ok(())
    }

    // -----------------------------------------------------------------------------------------
    // The board watching its Autodarts game
    // -----------------------------------------------------------------------------------------

    fn tick(&self) {
        // Autodarts is open when the extension is connected and has a play.autodarts.com tab
        let (lobby, active, state, open, tab_match): (Option<Obj>, Option<String>, Option<Obj>, bool, Option<String>) = match &self.bridge {
            Some(b) => {
                let st = b.lock();
                // The match page in the tab: known before Autodarts sends any match data (no bull-off: not until the first dart)
                let tab_match = st.tab_url.split("/matches/").nth(1).map(|r| r.split(['/', '?', '#']).next().unwrap_or("").to_string()).filter(|x| !x.is_empty());
                (st.open_lobby().cloned(), st.active_match_id().map(str::to_string), st.last_match_state.clone(), st.is_connected && st.tab_attached, tab_match)
            }
            None => (None, None, None, false, None),
        };
        let mut g = self.lock();
        let g = &mut *g;
        let me = g.node_id.clone();
        let assign = match &g.hosted {
            Some(t) => engine::assignment_for(t, &me),
            None => g.join.as_ref().filter(|j| j.status == "approved" || j.status == "offline").and_then(|j| j.assignment.clone()),
        };
        let a = &mut g.agent;
        let mid = assign.as_ref().and_then(|x| x["match"].as_str()).map(str::to_string);
        if mid != a.match_id {
            a.match_id = mid.clone();
            a.linked = None;
            a.live = Value::Null;
            a.missing_since = 0.0;
            a.lost = None;
            a.ok_lobby = None;
        }
        let linked_before = a.linked.clone();
        let mut result: Option<(String, MatchResult)> = None;
        if let Some(asg) = &assign {
            let (cl, ok) = agent::checklist(asg, lobby.as_ref());
            a.checklist = cl;
            a.checklist_ok = ok;
            a.lobby_open = lobby.is_some();
            if ok {
                a.ok_lobby = lobby.as_ref().and_then(|l| l.get("id")).map(py_str);
            }
            if a.linked.is_none() && a.lost != tab_match && a.ok_lobby.is_some() && a.ok_lobby == tab_match && !a.done_ad.contains(tab_match.as_ref().unwrap()) {
                // The lobby that matched the checklist was started
                a.linked = tab_match.clone();
                a.lost = None;
                a.notice = format!("Linked to Local Tournament {}", asg["match"].as_str().unwrap_or(""));
                a.notice_at = now();
                info!("Tournament match {} linked to Autodarts match {} (started from the matching lobby)", asg["match"], a.ok_lobby.as_deref().unwrap_or(""));
            }
            let st = state.as_ref().filter(|s| s.get("id").map(py_str) == active);
            if a.linked.is_none() && a.lost.is_some() && a.lost == active && st.is_some() {
                // The same game is back (finished or not): follow it again
                a.linked = a.lost.take();
                a.notice = format!("Linked to Local Tournament {} again", asg["match"].as_str().unwrap_or(""));
                a.notice_at = now();
                info!("Tournament match {} found its Autodarts match again", asg["match"]);
            }
            match (&a.linked, &active, st) {
                (None, Some(ad), Some(s)) if !a.done_ad.contains(ad) && !is_match_over(s) => {
                    if agent::names_match(asg, &agent::names_of(s)) {
                        a.linked = Some(ad.clone());
                        a.notice = format!("Linked to Local Tournament {}", asg["match"].as_str().unwrap_or(""));
                        a.notice_at = now();
                        info!("Tournament match {} linked to Autodarts match {}", asg["match"], ad);
                    }
                }
                _ => {}
            }
            if let Some(linked) = a.linked.clone() {
                let ls = state.as_ref().filter(|s| s.get("id").map(py_str).as_deref() == Some(linked.as_str()));
                match ls {
                    Some(s) if is_match_over(s) => {
                        if let Some(r) = agent::result_of(asg, s, &linked) {
                            result = Some((mid.clone().unwrap_or_default(), r));
                        }
                        a.done_ad.push(linked.clone());
                        a.linked = None;
                        a.live = Value::Null;
                        a.notice = if g.hosted.is_some() { "Result saved".into() } else { "Result sent to the host".into() };
                        a.notice_at = now();
                    }
                    Some(s) if active.as_deref() == Some(linked.as_str()) => {
                        a.live = agent::live_of(asg, s);
                        a.missing_since = 0.0;
                    }
                    // Autodarts closed: the match goes on there, so keep the link until it's back
                    // ...or its match page is open but no data came yet
                    _ if !open || tab_match.as_deref() == Some(linked.as_str()) => a.missing_since = 0.0,
                    _ => {
                        if a.missing_since == 0.0 {
                            a.missing_since = now();
                        } else if now() - a.missing_since > ABORT_GRACE {
                            info!("Tournament match {} lost its Autodarts match {} (aborted?)", asg["match"], linked);
                            a.lost = Some(linked);
                            a.linked = None;
                            a.live = Value::Null;
                            a.missing_since = 0.0;
                            a.notice = "The Autodarts game is gone (aborted or closed). Open it again, or start it again.".into();
                            a.notice_at = now();
                        }
                    }
                }
            }
        } else {
            a.checklist = Value::Null;
            a.checklist_ok = false;
            a.lobby_open = lobby.is_some();
        }
        let relinked = a.linked != linked_before;
        let status = json!({"t": "status", "match": mid, "linked": a.linked, "live": a.live, "checklist_ok": a.checklist_ok, "lobby_open": a.lobby_open, "bridge": open});
        if g.hosted.is_some() {
            g.board_status.insert(me.clone(), status.clone());
            Self::note_live(g, &status);
            let mut changed = self.mark_live(g, &me, mid.as_deref(), status["linked"].as_str());
            if let Some((m, r)) = result {
                if let Err(e) = engine::set_result(g.hosted.as_mut().unwrap(), &m, r) {
                    warn!("Own result for {} refused: {}", m, e);
                }
                changed = true;
            }
            if changed {
                self.host_changed(g);
            } else if relinked {
                self.save(g);
            }
        } else if let Some(j) = g.join.as_ref() {
            let mut save = relinked;
            if let Some((m, r)) = result {
                let msg = json!({"t": "result", "match": m, "result": r});
                if let Some(tx) = &j.tx {
                    let _ = tx.send(msg.to_string());
                }
                g.agent.outbox.push(msg);
                save = true;
            }
            let text = status.to_string();
            if text != g.agent.last_status || now() - g.agent.last_status_at > 5.0 {
                if let Some(tx) = &j.tx {
                    if tx.send(text.clone()).is_ok() {
                        g.agent.last_status = text;
                        g.agent.last_status_at = now();
                    }
                }
            }
            if save {
                self.save(g);
            }
        }
    }
}

/// What boards and the page show of a lobby before the bracket exists
fn lobby_fields(t: &mut Tournament, spec: &Spec) {
    t.name = if spec.name.trim().is_empty() { "Local Tournament".into() } else { spec.name.trim().chars().take(60).collect() };
    t.format = spec.format.clone();
    t.settings = spec.settings.clone();
    t.players = spec.players.clone();
}

/// Request body helpers for the routes
pub fn spec_from(body: &Obj) -> Result<(Spec, bool), String> {
    let spec: Spec = serde_json::from_value(Value::Object(body.clone())).map_err(|e| format!("Bad tournament data: {}", e))?;
    let host_plays = body.get("host_plays").map_or(true, crate::py::truthy);
    Ok((spec, host_plays))
}
