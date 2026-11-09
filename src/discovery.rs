//! Finding WLED controllers on the network: mDNS (_wled._tcp) and a fast TCP + /json/info sweep of the
//! LAN subnets, run in parallel.

use crate::py::*;
use log::warn;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;

/// The address the default route leaves from
pub fn primary_ipv4() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    match s.local_addr().ok()? {
        SocketAddr::V4(a) => Some(*a.ip()),
        _ => None,
    }
}

/// Every IPv4 address of this machine's interfaces
pub fn interface_ipv4s() -> Vec<Ipv4Addr> {
    let mut out = Vec::new();
    #[cfg(unix)]
    unsafe {
        let mut ifap: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut ifap) == 0 {
            let mut p = ifap;
            while !p.is_null() {
                let a = (*p).ifa_addr;
                if !a.is_null() && (*a).sa_family as i32 == libc::AF_INET {
                    let sin = &*(a as *const libc::sockaddr_in);
                    out.push(Ipv4Addr::from(u32::from_be(sin.sin_addr.s_addr)));
                }
                p = (*p).ifa_next;
            }
            libc::freeifaddrs(ifap);
        }
    }
    out
}

fn primary_subnets() -> Vec<String> {
    let mut subnets: Vec<String> = Vec::new();
    let sub = |ip: &Ipv4Addr| {
        let o = ip.octets();
        format!("{}.{}.{}", o[0], o[1], o[2])
    };
    if let Some(ip) = primary_ipv4().filter(|i| !i.is_loopback()) {
        subnets.push(sub(&ip));
    }
    for ip in interface_ipv4s() {
        let o = ip.octets();
        // Skip localhost and Docker/WSL bridge ranges (172.16-31.x.x)
        if ip.is_loopback() || (o[0] == 172 && (16..=31).contains(&o[1])) {
            continue;
        }
        let s = sub(&ip);
        if !subnets.contains(&s) {
            subnets.push(s);
        }
    }
    if subnets.is_empty() {
        subnets = ["192.168.1", "192.168.2", "192.168.0", "192.168.178"].iter().map(|s| s.to_string()).collect();
    }
    subnets.truncate(2);
    subnets
}

pub fn local_ips() -> HashSet<String> {
    let mut s: HashSet<String> = interface_ipv4s().iter().map(|i| i.to_string()).collect();
    s.insert("127.0.0.1".into());
    if let Some(p) = primary_ipv4() {
        s.insert(p.to_string());
    }
    s
}

async fn probe(ip: String) -> Option<Value> {
    let addr: SocketAddr = format!("{}:80", ip).parse().ok()?;
    tokio::time::timeout(Duration::from_millis(350), tokio::net::TcpStream::connect(addr)).await.ok()?.ok()?;
    let ip2 = ip.clone();
    let data = tokio::task::spawn_blocking(move || crate::http::get_json(&format!("http://{}/json/info", ip2), 0.8)).await.ok()?.ok()?;
    let d = data.as_object()?;
    if d.get("brand") == Some(&json!("WLED")) || d.contains_key("leds") || d.contains_key("ver") {
        return Some(json!({
            "ip": ip, "name": d.get("name").cloned().unwrap_or(json!("WLED Device")),
            "version": d.get("ver").cloned().unwrap_or(json!("Unknown")),
            "leds": d.get("leds").and_then(|l| l.get("count")).cloned().unwrap_or(json!(0)),
            "brand": d.get("brand").cloned().unwrap_or(json!("WLED")),
        }));
    }
    None
}

async fn scan_subnets() -> Vec<Value> {
    let sem = Arc::new(tokio::sync::Semaphore::new(80));
    let mut handles = Vec::new();
    for sn in primary_subnets() {
        for h in 1..255 {
            let ip = format!("{}.{}", sn, h);
            let sem = Arc::clone(&sem);
            handles.push(tokio::spawn(async move {
                let _p = sem.acquire().await.ok()?;
                probe(ip).await
            }));
        }
    }
    let mut out = Vec::new();
    for h in handles {
        if let Ok(Some(v)) = h.await {
            out.push(v);
        }
    }
    out
}

fn scan_mdns(timeout: Duration) -> Vec<Value> {
    let d = match mdns_sd::ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            warn!("mDNS scan error: {}", e);
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    if let Ok(rx) = d.browse("_wled._tcp.local.") {
        let end = std::time::Instant::now() + timeout;
        while let Some(left) = end.checked_duration_since(std::time::Instant::now()) {
            match rx.recv_timeout(left) {
                Ok(mdns_sd::ServiceEvent::ServiceResolved(info)) => {
                    if let Some(ip) = info.get_addresses().iter().find(|a| a.is_ipv4()) {
                        let name = info.get_fullname().split('.').next().unwrap_or("").replace('\\', "");
                        out.push(json!({"ip": ip.to_string(), "name": if name.is_empty() { "WLED Device".to_string() } else { name },
                                        "port": info.get_port(), "brand": "WLED"}));
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
    }
    let _ = d.shutdown();
    out
}

/// mDNS + subnet sweep in parallel; this machine itself is never listed
pub async fn scan_network() -> Vec<Value> {
    let mdns = tokio::task::spawn_blocking(|| scan_mdns(Duration::from_secs(1)));
    let subnet = scan_subnets().await;
    let mut by_ip: BTreeMap<String, Value> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    for d in subnet {
        let ip = d.get("ip").map(py_str).unwrap_or_default();
        if by_ip.insert(ip.clone(), d).is_none() {
            order.push(ip);
        }
    }
    for d in mdns.await.unwrap_or_default() {
        let ip = d.get("ip").map(py_str).unwrap_or_default();
        match by_ip.get_mut(&ip) {
            None => {
                by_ip.insert(ip.clone(), d);
                order.push(ip);
            }
            Some(e) => {
                if !e.get("name").map_or(false, truthy) {
                    e["name"] = d["name"].clone();
                }
            }
        }
    }
    let local = local_ips();
    order.into_iter().filter(|ip| !local.contains(ip)).filter_map(|ip| by_ip.remove(&ip)).collect()
}
