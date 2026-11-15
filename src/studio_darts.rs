//! Studio dart zoom: where and when each dart landed, from the Autodarts Board Manager on this computer.
//! The board camera is shown a few seconds late, so the live page knows a dart before the picture shows
//! it and can zoom to it in advance. The Board Manager's event socket is only a fast trigger: on each
//! message the current state is read and new darts are noted with the time they were reported.
//! Runs only while the dart zoom is switched on.

use crate::py::*;
use crate::studio::{roundn, throw_detail, Studio};
use crate::studio_camera::BOARD_MANAGER_URL;
use futures_util::StreamExt;
use log::{debug, info};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const KEEP_SECONDS: f64 = 20.0;
const FALLBACK_POLL: f64 = 1.0;
const IDLE_CHECK: u64 = 3;

fn now() -> f64 {
    crate::led_thread::wall()
}

struct St {
    darts: Vec<Value>,
    known: usize,
    seq: u64,
}

pub struct DartTracker {
    st: Mutex<St>,
}

/// x, y and label of a Board Manager throw (flat coordsX / coordsY / segmentName, or the play format);
/// a bounce-out or failed detection has no position, so the camera stays wide
fn position(t: &Value) -> Value {
    let Some(o) = t.as_object() else { return json!({"x": null, "y": null, "label": ""}) };
    let d = throw_detail(Some(t));
    let x = o.get("coordsX").cloned().unwrap_or_else(|| d["x"].clone());
    let y = o.get("coordsY").cloned().unwrap_or_else(|| d["y"].clone());
    let usable = x.is_number() && y.is_number() && !o.get("bouncer").map_or(false, truthy) && !o.get("failed").map_or(false, truthy);
    let label = non_empty(o.get("segmentName")).map(py_str).unwrap_or_else(|| py_str(&d["label"]));
    json!({
        "x": if usable { json!(roundn(x.as_f64().unwrap_or(0.0), 4)) } else { Value::Null },
        "y": if usable { json!(roundn(y.as_f64().unwrap_or(0.0), 4)) } else { Value::Null },
        "label": label,
    })
}

impl DartTracker {
    pub fn new() -> DartTracker {
        DartTracker { st: Mutex::new(St { darts: Vec::new(), known: 0, seq: 0 }) }
    }

    /// Darts of the last seconds, oldest first: {id, t, x, y, label}
    pub fn recent(&self) -> Vec<Value> {
        let cut = now() - KEEP_SECONDS;
        self.st.lock().unwrap().darts.iter().filter(|d| d["t"].as_f64().unwrap_or(0.0) >= cut).cloned().collect()
    }

    fn note_state(&self, state: &Value, at: f64) {
        let Some(throws) = state.get("throws").and_then(Value::as_array) else { return };
        let mut s = self.st.lock().unwrap();
        if throws.len() < s.known {
            s.known = 0;
        }
        for t in &throws[s.known..] {
            s.seq += 1;
            let mut d = json!({"id": s.seq, "t": roundn(at, 3)});
            if let (Some(o), Value::Object(p)) = (d.as_object_mut(), position(t)) {
                o.extend(p);
            }
            s.darts.push(d);
        }
        s.known = throws.len();
        let cut = now() - KEEP_SECONDS;
        s.darts.retain(|d| d["t"].as_f64().unwrap_or(0.0) >= cut);
    }

    async fn read_state(&self, at: f64) {
        let r = tokio::task::spawn_blocking(|| crate::http::get_json(&format!("{}/api/state", BOARD_MANAGER_URL), 2.0)).await;
        if let Ok(Ok(v)) = r {
            self.note_state(&v, at);
        }
    }

    pub async fn run(self: Arc<Self>, studio: Arc<Studio>) {
        let enabled = |s: &Studio| s.cached_settings().get("dart_zoom").and_then(|d| d.get("enabled")) == Some(&json!(true));
        let url = format!("{}/api/events", BOARD_MANAGER_URL.replace("http://", "ws://"));
        let mut delay = 1.0f64;
        loop {
            if !enabled(&studio) {
                self.st.lock().unwrap().known = 0;
                tokio::time::sleep(Duration::from_secs(IDLE_CHECK)).await;
                continue;
            }
            match tokio::time::timeout(Duration::from_secs(3), tokio_tungstenite::connect_async(&url)).await {
                Ok(Ok((mut ws, _))) => {
                    info!("Dart zoom: listening to the Autodarts Board Manager");
                    delay = 1.0;
                    self.read_state(now()).await;
                    self.st.lock().unwrap().darts.clear();
                    while enabled(&studio) {
                        match tokio::time::timeout(Duration::from_secs_f64(FALLBACK_POLL), ws.next()).await {
                            Err(_) => self.read_state(now()).await,
                            Ok(None) | Ok(Some(Err(_))) => break,
                            Ok(Some(Ok(msg))) => {
                                let at = now();
                                let data = match &msg {
                                    tokio_tungstenite::tungstenite::Message::Text(t) => serde_json::from_str::<Value>(t).ok(),
                                    tokio_tungstenite::tungstenite::Message::Close(_) => break,
                                    _ => None,
                                };
                                let inner = data.as_ref().and_then(|d| d.get("data")).cloned();
                                if data.as_ref().and_then(|d| d.get("throws")).map_or(false, Value::is_array) {
                                    self.note_state(data.as_ref().unwrap(), at);
                                } else if inner.as_ref().and_then(|d| d.get("throws")).map_or(false, Value::is_array) {
                                    self.note_state(inner.as_ref().unwrap(), at);
                                } else {
                                    self.read_state(at).await;
                                }
                            }
                        }
                    }
                }
                Ok(Err(e)) => debug!("Dart zoom: Board Manager not reachable ({})", e),
                Err(_) => debug!("Dart zoom: Board Manager not reachable (timeout)"),
            }
            tokio::time::sleep(Duration::from_secs_f64(delay)).await;
            delay = (delay * 2.0).min(10.0);
        }
    }
}
