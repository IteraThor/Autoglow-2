//! Small blocking HTTP helpers for talking to WLED controllers and local services.
//! Call them from spawn_blocking (or a thread), never directly on the async runtime.

use serde_json::Value;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

pub type HttpResult<T> = Result<T, String>;

fn agent(timeout: f64) -> ureq::Agent {
    let t = Duration::from_secs_f64(timeout.max(0.05));
    ureq::AgentBuilder::new().timeout_connect(t).timeout(t).build()
}

fn err_text(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => format!("HTTP Error {}: {}", code, r.status_text()),
        ureq::Error::Transport(t) => {
            let s = t.to_string();
            if s.to_lowercase().contains("timed out") || s.to_lowercase().contains("timeout") {
                format!("timed out ({})", s)
            } else {
                s
            }
        }
    }
}

pub fn get_text(url: &str, timeout: f64) -> HttpResult<String> {
    let r = agent(timeout).get(url).call().map_err(err_text)?;
    r.into_string().map_err(|e| e.to_string())
}

pub fn get_json(url: &str, timeout: f64) -> HttpResult<Value> {
    let t = get_text(url, timeout)?;
    serde_json::from_str(&t).map_err(|e| format!("JSONDecodeError: {}", e))
}

/// POST a JSON body; returns the response text
pub fn post_json(url: &str, body: &Value, timeout: f64) -> HttpResult<String> {
    let r = agent(timeout)
        .post(url)
        .set("Content-Type", "application/json")
        .send_string(&serde_json::to_string(body).unwrap_or_default())
        .map_err(err_text)?;
    r.into_string().map_err(|e| e.to_string())
}

/// POST a JSON body and parse the JSON answer ("{}" when empty)
pub fn post_json_value(url: &str, body: &Value, timeout: f64) -> HttpResult<Value> {
    let t = post_json(url, body, timeout)?;
    if t.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(&t).map_err(|e| format!("JSONDecodeError: {}", e))
}

/// Fast TCP check whether a host answers on a port
pub fn is_host_online(ip: &str, port: u16, timeout: f64) -> bool {
    let ip = ip.trim();
    if ip.is_empty() {
        return false;
    }
    let addrs: Vec<SocketAddr> = match (ip, port).to_socket_addrs() {
        Ok(a) => a.filter(|a| a.is_ipv4()).collect(),
        Err(_) => return false,
    };
    addrs.iter().any(|a| TcpStream::connect_timeout(a, Duration::from_secs_f64(timeout)).is_ok())
}
