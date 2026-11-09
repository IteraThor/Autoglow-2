//! AutoGlow 2: real-time WLED lighting for Autodarts.
//!
//! The web server and orchestrator: loads config.json, starts the engine (game events -> lights), the
//! Chrome extension bridge, Classic mode and the Studio, registers autoglow.local over mDNS and serves the
//! web UI with its REST API and WebSockets on port 8080 (AUTOGLOW_PORT).
//!
//!     autoglow            run the server
//!     autoglow id         print the Chrome extension ID (creates the signing key if needed)
//!     autoglow version    print the version

mod autodarts;
mod classic;
mod discovery;
mod effects;
mod engine;
mod errors;
mod extension;
mod flow;
mod flow_catalog;
mod flow_runtime;
mod game_flow;
mod http;
mod led_thread;
mod legacy_cleanup;
mod models;
mod py;
mod pyrandom;
mod routes;
mod security;
mod server;
mod storage;
mod studio;
mod studio_camera;
mod studio_darts;
mod studio_video;
mod wled;
mod wled_layout;
#[cfg(test)]
mod tests;

use log::{info, warn, LevelFilter, Log, Metadata, Record};
use std::io::Write;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
const LOG_BACKUPS: usize = 3;

/// Console and autoglow.log (5 MB, 3 rotated copies), in the format the Python version wrote
struct Logger {
    path: PathBuf,
    file: Mutex<Option<std::fs::File>>,
}

impl Logger {
    fn rotate(&self, f: &mut Option<std::fs::File>) {
        *f = None;
        for i in (1..LOG_BACKUPS).rev() {
            let _ = std::fs::rename(format!("{}.{}", self.path.display(), i), format!("{}.{}", self.path.display(), i + 1));
        }
        let _ = std::fs::rename(&self.path, format!("{}.1", self.path.display()));
        *f = std::fs::OpenOptions::new().create(true).append(true).open(&self.path).ok();
    }
}

impl Log for Logger {
    fn enabled(&self, m: &Metadata) -> bool {
        m.level() <= log::Level::Info || std::env::var("AUTOGLOW_DEBUG").is_ok()
    }

    fn log(&self, r: &Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let target = r.target();
        // Only AutoGlow's own messages (the libraries are noisy at info level)
        if !target.starts_with("autoglow") {
            if r.level() > log::Level::Warn {
                return;
            }
        }
        let level = match r.level() {
            log::Level::Error => "ERROR",
            log::Level::Warn => "WARNING",
            log::Level::Info => "INFO",
            _ => "DEBUG",
        };
        let name = target.replace("::", ".");
        let line = format!("{} [{}] {}: {}\n", chrono::Local::now().format("%Y-%m-%d %H:%M:%S,%3f"), level, name, r.args());
        let _ = std::io::stdout().write_all(line.as_bytes());
        let mut f = self.file.lock().unwrap();
        if f.as_ref().and_then(|x| x.metadata().ok()).map_or(false, |m| m.len() >= LOG_MAX_BYTES) {
            self.rotate(&mut f);
        }
        if let Some(file) = f.as_mut() {
            let _ = file.write_all(line.as_bytes());
        }
    }

    fn flush(&self) {}
}

fn init_logging() {
    let path = storage::project_root().join("autoglow.log");
    let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).ok();
    let logger = Box::leak(Box::new(Logger { path, file: Mutex::new(file) }));
    let _ = log::set_logger(logger);
    log::set_max_level(if std::env::var("AUTOGLOW_DEBUG").is_ok() { LevelFilter::Debug } else { LevelFilter::Info });
}

/// AutoGlow on the local network as autoglow.local (mDNS)
fn register_mdns(port: u16) -> Option<mdns_sd::ServiceDaemon> {
    let d = mdns_sd::ServiceDaemon::new().map_err(|e| warn!("Failed to register mDNS service: {}", e)).ok()?;
    let ip = discovery::primary_ipv4().map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into());
    let props = [("path", "/")];
    match mdns_sd::ServiceInfo::new("_http._tcp.local.", "AutoGlow", "autoglow.local.", ip.as_str(), port, &props[..]) {
        Ok(info) => match d.register(info) {
            Ok(()) => info!("Registered mDNS: http://autoglow.local:{} on {}", port, ip),
            Err(e) => warn!("Failed to register mDNS service: {}", e),
        },
        Err(e) => warn!("Failed to register mDNS service: {}", e),
    }
    Some(d)
}

/// Read the live layout of every controller and take it into the config (they may have been changed
/// on WLED's own page or by a power cycle)
async fn sync_hardware_on_boot(engine: Arc<engine::Engine>) {
    let ips: Vec<String> = {
        let mut v: Vec<String> = engine.cfg().devices.iter().map(|d| d.ip.trim().to_string()).filter(|i| !i.is_empty()).collect();
        v.sort();
        v.dedup();
        v
    };
    let mut live = std::collections::HashMap::new();
    for ip in ips {
        let ip2 = ip.clone();
        if let Ok(info) = tokio::task::spawn_blocking(move || wled::fetch_live_device_info(&ip2, 0.4)).await {
            live.insert(ip, info);
        }
    }
    let snap = {
        let mut c = engine.cfg();
        let mut changed = false;
        for d in c.devices.iter_mut() {
            if let Some(info) = live.get(d.ip.trim()) {
                if wled_layout::adopt_live_layout(d, info) {
                    if let Some(n) = info.get("name").and_then(|v| v.as_str()).filter(|n| !n.is_empty()) {
                        d.name = n.to_string();
                    }
                    changed = true;
                }
            }
        }
        changed.then(|| c.clone())
    };
    if let Some(mut s) = snap {
        storage::save_app_config(&mut s, &engine.config_path);
        engine.sync_drivers(&s);
        info!("Synchronized device configuration with live physical WLED hardware on boot.");
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("id") => match extension::load_or_create_key(&extension::key_path()) {
            Ok(k) => {
                println!("{}", extension::extension_id(&k));
                return;
            }
            Err(e) => {
                eprintln!("Could not read or create the extension key: {}", e);
                std::process::exit(1);
            }
        },
        Some("version") | Some("--version") => {
            println!("AutoGlow 2 v{}", VERSION);
            return;
        }
        Some(other) => {
            eprintln!("Unknown command '{}'. Usage: autoglow [id|version]", other);
            std::process::exit(2);
        }
        None => {}
    }
    init_logging();
    legacy_cleanup::remove_legacy_files(storage::project_root());
    // One worker thread is enough (like the Python event loop); blocking work goes to spawn_blocking,
    // the LED stream and the cameras have threads of their own
    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
    rt.block_on(run());
}

async fn run() {
    let port: u16 = std::env::var("AUTOGLOW_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
    let config_path = storage::resolve_config_path(std::env::var("AUTOGLOW_CONFIG").ok().as_deref());
    let mut cfg = storage::load_app_config(&config_path);
    if storage::sync_presets_with_disk(&mut cfg, &storage::presets_dir(), true) {
        storage::save_app_config(&mut cfg, &config_path);
    }
    // Game data comes from the AutoGlow Chrome extension; earlier builds stored a pairing key for it
    if cfg.extra.shift_remove("autodarts_bridge_key").is_some() {
        storage::save_app_config(&mut cfg, &config_path);
    }
    let board_id = if !cfg.autodarts_board_id.is_empty() { cfg.autodarts_board_id.clone() } else { cfg.extra.get("autodarts_board_id").map(py::py_str).unwrap_or_default() };
    let bridge = autodarts::AutodartsBridge::new(&board_id);
    info!("Autodarts source: Chrome extension bridge (direct cloud login on hold)");

    let engine = engine::Engine::new(cfg, config_path.clone(), Some(bridge));
    engine.start().await;
    tokio::spawn(sync_hardware_on_boot(Arc::clone(&engine)));

    let classic = classic::ClassicMode::new(storage::data_dir(&config_path).join("classic.json"));
    classic.start().await;
    let studio = Arc::new(studio::Studio::new());
    let cameras = Arc::new(studio_camera::CameraHub::new());
    let darts = Arc::new(studio_darts::DartTracker::new());
    tokio::spawn(Arc::clone(&darts).run(Arc::clone(&studio)));
    let video = Arc::new(studio_video::VideoHub::new(Arc::clone(&cameras)));

    let state = Arc::new(server::AppState {
        engine: Arc::clone(&engine),
        web_dir: storage::project_root().join("web"),
        classic: Arc::clone(&classic),
        studio,
        cameras: Arc::clone(&cameras),
        darts,
        video: Arc::clone(&video),
    });
    let app = server::build_router(Arc::clone(&state)).into_make_service_with_connect_info::<SocketAddr>();

    let v4 = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("Could not listen on port {}: {}", port, e);
            std::process::exit(1);
        }
    };
    // "localhost" resolves to ::1 first on many systems, so also listen on IPv6 where it exists
    let v6 = {
        let sock = socket2::Socket::new(socket2::Domain::IPV6, socket2::Type::STREAM, None);
        sock.and_then(|s| {
            s.set_only_v6(true)?;
            s.set_reuse_address(true)?;
            s.bind(&SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)).into())?;
            s.listen(1024)?;
            s.set_nonblocking(true)?;
            tokio::net::TcpListener::from_std(s.into())
        })
    };
    let mdns = tokio::task::spawn_blocking(move || register_mdns(port)).await.ok().flatten();
    info!("AutoGlow 2 v{} Web Server running at http://localhost:{}", VERSION, port);
    info!("LED engine: Rust (steady 50 FPS on its own thread)");

    let s4 = axum::serve(v4, app.clone()).with_graceful_shutdown(shutdown_signal());
    match v6 {
        Ok(l6) => {
            let s6 = axum::serve(l6, app).with_graceful_shutdown(shutdown_signal());
            let _ = tokio::join!(s4, s6);
        }
        Err(e) => {
            info!("IPv6 listener not available ({}); serving on IPv4 only", e);
            let _ = s4.await;
        }
    }
    info!("Shutting down...");
    video.stop_all();
    cameras.stop_all();
    classic.stop().await;
    engine.stop().await;
    if let Some(d) = mdns {
        let _ = d.shutdown();
    }
}
