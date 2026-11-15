//! Classic mode (AutoGlow 1): a simple USB-only status light. It listens to the local Autodarts Board
//! Manager (ws://localhost:3180/api/events, with /api/state polled as a fallback) and sends one WLED JSON
//! command per board status over USB serial to an ESP32 running WLED.
//!
//! It runs next to the main engine and is independent of it. Settings live in classic.json next to config.json.

use crate::led_thread::wall;
use crate::py::*;
use futures_util::StreamExt;
use log::{debug, info, warn};
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::task::JoinHandle;

const BAUD_RATE: u32 = 115200;
/// CP210x, CH340, FTDI and ESP32-S2/S3 native USB, as in AutoGlow 1
const KNOWN_VID_PIDS: [(u16, u16); 4] = [(0x10C4, 0xEA60), (0x1A86, 0x7523), (0x0403, 0x6001), (0x303A, 0x1001)];
const RETRY_SECONDS: u64 = 5;
const POLL_SECONDS: u64 = 1;
const POLL_FRESH_SECONDS: f64 = 5.0;

/// WLED effect ids offered by AutoGlow 1's settings window
pub const EFFECTS: [(&str, i64); 12] = [
    ("Solid", 0), ("Blink", 1), ("Breathe", 2), ("Wipe", 3), ("Scan", 45), ("Rainbow", 9), ("Chase", 28), ("Fire", 66), ("Strobe", 8),
    ("Color Loop", 11), ("Heartbeat", 101), ("Pacifica", 104),
];

/// The "traffic light": board status -> look, in the order the page shows them
pub const STATUSES: [(&str, i64, [i64; 3]); 7] = [
    ("Throw", 0, [0, 255, 0]),
    ("Takeout in progress", 0, [255, 0, 0]),
    ("Takeout", 0, [255, 255, 0]),
    ("Starting", 0, [0, 0, 255]),
    ("Stopped", 0, [255, 0, 255]),
    ("Calibrating", 0, [128, 0, 128]),
    ("Error", 1, [255, 0, 0]),
];

fn clamp_int(v: Option<&Value>, lo: i64, hi: i64, d: i64) -> i64 {
    v.and_then(int_of).map(|x| x.clamp(lo, hi)).unwrap_or(d)
}

fn clean_color(v: Option<&Value>, d: [i64; 3]) -> Value {
    match v {
        Some(Value::String(s)) => {
            let t = s.trim().trim_start_matches('#');
            if t.len() == 6 {
                let p: Option<Vec<i64>> = (0..3).map(|i| t.get(i * 2..i * 2 + 2).and_then(|h| i64::from_str_radix(h, 16).ok())).collect();
                if let Some(p) = p {
                    return json!(p);
                }
            }
            json!(d)
        }
        Some(Value::Array(a)) if a.len() >= 3 => json!(a[..3].iter().map(|c| clamp_int(Some(c), 0, 255, 0)).collect::<Vec<_>>()),
        _ => json!(d),
    }
}

/// The Board Manager base URL (scheme://host[:port]) or None when it is not an http(s) URL
pub fn clean_board_manager_url(v: Option<&Value>) -> Option<String> {
    let mut t = v.filter(|x| truthy(x)).map(py_str).unwrap_or_default().trim().trim_end_matches('/').to_string();
    if t.is_empty() {
        return None;
    }
    if !t.contains("://") {
        t = format!("http://{}", t);
    }
    let (scheme, rest) = t.split_once("://")?;
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let netloc = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = netloc.rsplit('@').next().unwrap_or("");
    let (host, port) = if host_port.starts_with('[') {
        let end = host_port.find(']')?;
        (&host_port[1..end], host_port[end + 1..].strip_prefix(':'))
    } else {
        match host_port.rsplit_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (host_port, None),
        }
    };
    if host.is_empty() {
        return None;
    }
    if let Some(p) = port {
        if !p.is_empty() && p.parse::<u16>().is_err() {
            return None;
        }
    }
    Some(format!("{}://{}", scheme, netloc))
}

/// Fill in defaults and drop anything unexpected
pub fn clean_settings(raw: Option<&Value>) -> Obj {
    let empty = Obj::new();
    let r = raw.and_then(Value::as_object).unwrap_or(&empty);
    let show = get_bool(r, "show_in_menu", false);
    let statuses_in = obj_or_empty(r.get("statuses"));
    let mut statuses = Obj::new();
    for (name, fx_d, col_d) in STATUSES {
        let g = obj_or_empty(statuses_in.get(name));
        let fx = clamp_int(g.get("fx"), 0, 255, fx_d);
        statuses.insert(
            name.into(),
            json!({"enabled": get_bool(&g, "enabled", true), "fx": if EFFECTS.iter().any(|(_, i)| *i == fx) { fx } else { fx_d },
                   "color": clean_color(g.get("color"), col_d)}),
        );
    }
    crate::obj! {
        "enabled" => get_bool(r, "enabled", false) && show,
        "show_in_menu" => show,
        "board_manager_url" => clean_board_manager_url(r.get("board_manager_url")).unwrap_or_else(|| "http://localhost:3180".into()),
        "manual_port" => non_empty(r.get("manual_port")).map(py_str).unwrap_or_default().trim().chars().take(200).collect::<String>(),
        "global_brightness" => clamp_int(r.get("global_brightness"), 0, 255, 255),
        "startup_animation" => get_bool(r, "startup_animation", true),
        "statuses" => statuses,
    }
}

fn norm(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// 'takeout in progress', 'TakeoutInProgress' ... -> 'Takeout in progress'
pub fn resolve_status_key(status: &str) -> Option<&'static str> {
    let w = norm(status);
    STATUSES.iter().map(|s| s.0).find(|k| norm(k) == w)
}

/// The board status of a Board Manager event or state, old or new format
pub fn extract_status(d: &Value) -> Option<String> {
    let o = d.as_object()?;
    if let Some(Value::Object(inner)) = o.get("data") {
        if let Some(s) = non_empty(inner.get("status")) {
            return Some(py_str(s));
        }
    }
    non_empty(o.get("status")).map(py_str)
}

fn wled_command(settings: &Obj, key: &str) -> Value {
    let look = &settings["statuses"][key];
    json!({"on": true, "bri": settings["global_brightness"], "tt": 0, "seg": {"fx": look["fx"], "col": [look["color"]]}})
}

pub fn list_ports() -> Vec<Value> {
    let mut ports = serialport::available_ports().unwrap_or_default();
    // The legacy /dev/ttyS* placeholders the kernel creates on every PC are no USB controller
    ports.retain(|p| !(p.port_name.starts_with("/dev/ttyS") && matches!(p.port_type, serialport::SerialPortType::Unknown)));
    ports.sort_by(|a, b| a.port_name.cmp(&b.port_name));
    ports
        .into_iter()
        .map(|p| {
            let (desc, esp) = match &p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    let d = u.product.clone().or_else(|| u.manufacturer.clone()).unwrap_or_default();
                    (d, KNOWN_VID_PIDS.contains(&(u.vid, u.pid)))
                }
                _ => (String::new(), false),
            };
            json!({"device": p.port_name, "description": desc, "esp32": esp})
        })
        .collect()
}

fn find_port(manual: &str) -> Option<String> {
    if !manual.is_empty() {
        return Some(manual.into());
    }
    list_ports().into_iter().find(|p| p["esp32"] == json!(true)).map(|p| py_str(&p["device"]))
}

#[derive(Default)]
struct St {
    port: Option<String>,
    serial_error: Option<String>,
    ws_connected: bool,
    poll_ok_at: Option<f64>,
    board_manager_error: Option<String>,
    last_status: Option<String>,
    last_status_at: Option<f64>,
    sent_key: Option<String>,
}

pub struct ClassicMode {
    path: PathBuf,
    pub settings: Mutex<Obj>,
    st: Mutex<St>,
    ser: Arc<Mutex<Option<Box<dyn serialport::SerialPort>>>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl ClassicMode {
    pub fn new(path: PathBuf) -> Arc<ClassicMode> {
        let settings = match std::fs::read_to_string(&path) {
            Ok(t) => match serde_json::from_str::<Value>(&t) {
                Ok(v) => clean_settings(Some(&v)),
                Err(e) => {
                    warn!("Could not read {}, using the defaults: {}", path.display(), e);
                    clean_settings(None)
                }
            },
            Err(_) => clean_settings(None),
        };
        Arc::new(ClassicMode { path, settings: Mutex::new(settings), st: Mutex::new(St::default()), ser: Arc::new(Mutex::new(None)), task: Mutex::new(None) })
    }

    fn settings(&self) -> Obj {
        self.settings.lock().unwrap().clone()
    }

    pub fn running(&self) -> bool {
        self.task.lock().unwrap().as_ref().map_or(false, |t| !t.is_finished())
    }

    pub fn serial_error(&self) -> Option<String> {
        self.st.lock().unwrap().serial_error.clone()
    }

    pub async fn start(self: &Arc<Self>) {
        if self.running() || self.settings()["enabled"] != json!(true) {
            return;
        }
        let me = Arc::clone(self);
        *self.task.lock().unwrap() = Some(tokio::spawn(async move { me.run().await }));
        info!("Classic mode (AutoGlow 1) started");
    }

    pub async fn stop(&self) {
        let t = self.task.lock().unwrap().take();
        if let Some(t) = t {
            t.abort();
            info!("Classic mode (AutoGlow 1) stopped");
        }
        *self.ser.lock().unwrap() = None;
        let mut s = self.st.lock().unwrap();
        s.ws_connected = false;
        s.poll_ok_at = None;
    }

    /// Save new settings and restart the loop so they take effect
    pub async fn apply(self: &Arc<Self>, settings: &Value) -> Result<Obj, String> {
        let cleaned = clean_settings(Some(settings));
        let text = {
            let mut buf = Vec::new();
            let fmt = serde_json::ser::PrettyFormatter::with_indent(b"  ");
            let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
            serde::Serialize::serialize(&Value::Object(cleaned.clone()), &mut ser).map_err(|e| e.to_string())?;
            buf
        };
        crate::storage::write_atomic(&self.path, &text).map_err(|e| e.to_string())?;
        let old = self.settings();
        let reconnect = ["enabled", "manual_port", "board_manager_url"].iter().any(|k| old.get(*k) != cleaned.get(*k));
        *self.settings.lock().unwrap() = cleaned.clone();
        self.st.lock().unwrap().sent_key = None;
        let last = self.st.lock().unwrap().last_status.clone();
        if reconnect || cleaned["enabled"] != json!(true) {
            self.stop().await;
            self.start().await;
        } else if let Some(l) = last {
            self.show(&l).await;
        }
        Ok(cleaned)
    }

    fn board_manager_connected(&self) -> bool {
        let s = self.st.lock().unwrap();
        s.ws_connected || s.poll_ok_at.map_or(false, |t| wall() - t < POLL_FRESH_SECONDS)
    }

    /// While the loop is off, look once whether the Board Manager answers, so the page shows the truth
    pub async fn check_board_manager(&self) {
        if self.running() {
            return;
        }
        let base = py_str(&self.settings()["board_manager_url"]);
        let url = format!("{}/api/state", base);
        let r = tokio::task::spawn_blocking(move || crate::http::get_json(&url, 1.5)).await.ok().and_then(|r| r.ok());
        let mut s = self.st.lock().unwrap();
        match r {
            None => {
                s.poll_ok_at = None;
                s.board_manager_error = Some(format!("Board Manager not reachable at {}", base));
            }
            Some(v) => {
                s.poll_ok_at = Some(wall());
                s.board_manager_error = None;
                if let Some(k) = extract_status(&v).as_deref().and_then(resolve_status_key) {
                    if s.last_status.as_deref() != Some(k) {
                        s.last_status = Some(k.into());
                        s.last_status_at = Some(wall());
                    }
                }
            }
        }
    }

    pub fn snapshot(&self) -> Value {
        let connected = self.ser.lock().unwrap().is_some();
        let bm = self.board_manager_connected();
        let s = self.st.lock().unwrap();
        json!({
            "running": self.running(), "pyserial": true, "serial_connected": connected, "port": s.port, "serial_error": s.serial_error,
            "board_manager_connected": bm, "board_manager_error": s.board_manager_error, "last_status": s.last_status,
            "last_status_at": s.last_status_at,
        })
    }

    async fn open_serial(&self) -> bool {
        if self.ser.lock().unwrap().is_some() {
            return true;
        }
        let manual = py_str(&self.settings()["manual_port"]);
        let Some(port) = tokio::task::spawn_blocking(move || find_port(&manual)).await.ok().flatten() else {
            self.st.lock().unwrap().serial_error = Some("No ESP32 found on USB. Plug it in or enter its port.".into());
            return false;
        };
        let p2 = port.clone();
        let opened = tokio::task::spawn_blocking(move || serialport::new(&p2, BAUD_RATE).timeout(Duration::from_secs(2)).open()).await;
        match opened {
            Ok(Ok(ser)) => {
                tokio::time::sleep(Duration::from_secs(2)).await; // the ESP32 resets when the port opens
                *self.ser.lock().unwrap() = Some(ser);
                let mut s = self.st.lock().unwrap();
                s.port = Some(port.clone());
                s.serial_error = None;
                info!("Classic mode: serial connection on {}", port);
                true
            }
            Ok(Err(e)) => {
                let mut s = self.st.lock().unwrap();
                s.port = Some(port.clone());
                s.serial_error = Some(format!("Could not open {}: {}", port, e));
                false
            }
            Err(_) => false,
        }
    }

    pub async fn send(&self, cmd: &Value) -> bool {
        let line = format!("{}\n", cmd);
        let ser = Arc::clone(&self.ser);
        let res = tokio::task::spawn_blocking(move || {
            let mut g = ser.lock().unwrap();
            let Some(p) = g.as_mut() else { return None };
            match p.write_all(line.as_bytes()).and_then(|_| p.flush()) {
                Ok(()) => Some(Ok(())),
                Err(e) => {
                    *g = None;
                    Some(Err(e.to_string()))
                }
            }
        })
        .await
        .ok()
        .flatten();
        match res {
            Some(Ok(())) => true,
            Some(Err(e)) => {
                warn!("Classic mode: serial write failed: {}", e);
                let mut s = self.st.lock().unwrap();
                s.serial_error = Some(format!("Lost the connection to {}: {}", s.port.clone().unwrap_or_default(), e));
                false
            }
            None => false,
        }
    }

    /// Show one status's look now, optionally an unsaved one from the page
    pub async fn test(&self, key: &str, look: Option<&Value>, brightness: Option<&Value>) -> bool {
        let mut settings = self.settings();
        if let Some(l) = look {
            let c = clean_settings(Some(&json!({"statuses": {key: l}})));
            settings["statuses"][key] = c["statuses"][key].clone();
        }
        if let Some(b) = brightness.filter(|b| !b.is_null()) {
            let gb = clamp_int(Some(b), 0, 255, safe_int(settings.get("global_brightness"), 255));
            settings.insert("global_brightness".into(), json!(gb));
        }
        if self.ser.lock().unwrap().is_none() && !self.running() {
            self.open_serial().await;
        }
        let okk = self.send(&wled_command(&settings, key)).await;
        self.st.lock().unwrap().sent_key = None;
        okk
    }

    async fn handle_status(&self, status: &str) {
        let Some(key) = resolve_status_key(status) else {
            debug!("Classic mode: unknown status {:?}", status);
            return;
        };
        {
            let mut s = self.st.lock().unwrap();
            if s.last_status.as_deref() != Some(key) {
                s.last_status = Some(key.into());
                s.last_status_at = Some(wall());
                info!("Classic mode: status {}", key);
            }
        }
        self.show(key).await;
    }

    async fn show(&self, key: &str) {
        let settings = self.settings();
        let Some(look) = settings["statuses"].get(key) else { return };
        if look["enabled"] != json!(true) || self.st.lock().unwrap().sent_key.as_deref() == Some(key) {
            return;
        }
        if self.send(&wled_command(&settings, key)).await {
            self.st.lock().unwrap().sent_key = Some(key.into());
        }
    }

    async fn run(self: Arc<Self>) {
        let (a, b, c) = (Arc::clone(&self), Arc::clone(&self), Arc::clone(&self));
        tokio::join!(a.serial_loop(), b.events_loop(), c.poll_loop());
    }

    async fn serial_loop(self: Arc<Self>) {
        loop {
            if self.ser.lock().unwrap().is_none() && self.open_serial().await {
                self.st.lock().unwrap().sent_key = None;
                let s = self.settings();
                if s["startup_animation"] == json!(true) {
                    self.send(&json!({"on": true, "bri": s["global_brightness"], "seg": {"fx": 9, "sx": 128, "ix": 128}})).await;
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
                let last = self.st.lock().unwrap().last_status.clone().unwrap_or_else(|| "Throw".into());
                self.show(&last).await;
            }
            tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
        }
    }

    async fn events_loop(self: Arc<Self>) {
        let base = py_str(&self.settings()["board_manager_url"]);
        let url = format!("{}/api/events", base.replacen("https://", "wss://", 1).replacen("http://", "ws://", 1));
        loop {
            match tokio::time::timeout(Duration::from_secs(3), tokio_tungstenite::connect_async(&url)).await {
                Ok(Ok((mut ws, _))) => {
                    {
                        let mut s = self.st.lock().unwrap();
                        s.ws_connected = true;
                        s.board_manager_error = None;
                    }
                    info!("Classic mode: connected to the Board Manager at {}", url);
                    while let Some(Ok(msg)) = ws.next().await {
                        if let tokio_tungstenite::tungstenite::Message::Text(t) = msg {
                            if let Ok(v) = serde_json::from_str::<Value>(&t) {
                                if let Some(st) = extract_status(&v) {
                                    self.handle_status(&st).await;
                                }
                            }
                        }
                    }
                }
                Ok(Err(e)) => {
                    self.st.lock().unwrap().board_manager_error = Some(format!("Board Manager not reachable at {}: {}", base, e));
                    debug!("Classic mode: event stream failed: {}", e);
                }
                Err(_) => {
                    self.st.lock().unwrap().board_manager_error = Some(format!("Board Manager not reachable at {}: TimeoutError", base));
                }
            }
            self.st.lock().unwrap().ws_connected = false;
            tokio::time::sleep(Duration::from_secs(RETRY_SECONDS)).await;
        }
    }

    /// Newer Board Manager versions do not always push status changes, so poll the state too
    async fn poll_loop(self: Arc<Self>) {
        let url = format!("{}/api/state", py_str(&self.settings()["board_manager_url"]));
        loop {
            let u = url.clone();
            match tokio::task::spawn_blocking(move || crate::http::get_json(&u, 2.0)).await {
                Ok(Ok(v)) => {
                    self.st.lock().unwrap().poll_ok_at = Some(wall());
                    if let Some(st) = extract_status(&v) {
                        self.handle_status(&st).await;
                    }
                }
                Ok(Err(e)) => debug!("Classic mode: state poll failed: {}", e),
                Err(_) => {}
            }
            tokio::time::sleep(Duration::from_secs(POLL_SECONDS)).await;
        }
    }
}

/// The page payload: settings, live state, effects and the USB ports found
pub fn payload(c: &ClassicMode, ports: Vec<Value>) -> Value {
    json!({
        "status": "ok", "settings": c.settings(), "state": c.snapshot(),
        "effects": EFFECTS.iter().map(|(n, i)| json!({"id": i, "name": n})).collect::<Vec<_>>(),
        "status_names": STATUSES.iter().map(|s| s.0).collect::<Vec<_>>(), "ports": ports,
    })
}
