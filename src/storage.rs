//! Resilient configuration storage: atomic writes, automatic backups, corrupt-file quarantine and
//! multi-tier recovery (config.json → config.json.bak → latest backups/*.zip → defaults).

use crate::models::{AppConfig, ProfileConfig};
use crate::py::*;
use log::{error, info, warn};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

const SNAPSHOT_MIN_SECONDS: u64 = 3600;

static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// The AutoGlow folder: holds web/, defaults/, config.json and the other runtime files.
/// AUTOGLOW_ROOT, else the folder above the binary's target/ directory, else the working directory.
pub fn project_root() -> &'static Path {
    ROOT.get_or_init(|| {
        if let Ok(r) = std::env::var("AUTOGLOW_ROOT") {
            if !r.trim().is_empty() {
                return PathBuf::from(r);
            }
        }
        if let Ok(exe) = std::env::current_exe() {
            for dir in exe.ancestors().skip(1) {
                if dir.join("web").join("index.html").is_file() && dir.join("defaults").is_dir() {
                    return dir.to_path_buf();
                }
            }
        }
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    })
}

pub fn default_config_path() -> PathBuf {
    project_root().join("config.json")
}

pub fn presets_dir() -> PathBuf {
    project_root().join("presets")
}

/// Resolve a configuration path to an absolute path anchored to the project root
pub fn resolve_config_path(p: Option<&str>) -> PathBuf {
    match p.filter(|s| !s.is_empty()) {
        None => default_config_path(),
        Some(s) => {
            let p = PathBuf::from(s);
            if p.is_absolute() {
                p
            } else {
                project_root().join(p)
            }
        }
    }
}

/// The folder runtime files live in next to config.json
pub fn data_dir(config_path: &Path) -> PathBuf {
    config_path.parent().map(Path::to_path_buf).unwrap_or_else(|| project_root().to_path_buf())
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Read a JSON object from a file; None when missing, empty or invalid
pub fn read_json_file(path: &Path) -> Option<Obj> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() == 0 {
        warn!("Config file is 0 bytes (empty): {}", path.display());
        return None;
    }
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            warn!("Failed to parse JSON from {}: {}", path.display(), e);
            return None;
        }
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(o)) => Some(o),
        Ok(_) => {
            warn!("Expected JSON object in {}", path.display());
            None
        }
        Err(e) => {
            warn!("Failed to parse JSON from {}: {}", path.display(), e);
            None
        }
    }
}

/// JSON with 4-space indent, like json.dump(indent=4)
pub fn pretty_json(v: &Value) -> String {
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    serde::Serialize::serialize(v, &mut ser).ok();
    String::from_utf8(buf).unwrap_or_default()
}

/// Write a file atomically: temp file beside it, fsync, rename over the target
pub fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = with_suffix(path, ".tmp");
    let res = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content)?;
        f.flush()?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

pub fn load_app_config(path: &Path) -> AppConfig {
    let bak = with_suffix(path, ".bak");
    if let Some(raw) = read_json_file(path) {
        let raw = Value::Object(raw);
        let mut cfg = AppConfig::from_value(&raw);
        if arr(raw.get("profiles")).iter().any(|p| p.get("device_events").map_or(false, truthy)) {
            // Pre-2.3 per-controller effects were split into profiles; save so the split happens only once
            save_app_config(&mut cfg, path);
        }
        return cfg;
    }
    if path.exists() {
        let ts = chrono::Local::now().format("%Y%m%d_%H%M%S");
        let corrupt = with_suffix(path, &format!(".corrupt_{}", ts));
        match fs::copy(path, &corrupt) {
            Ok(_) => error!("Quarantined corrupted configuration from {} to {}", path.display(), corrupt.display()),
            Err(e) => error!("Failed to quarantine corrupted config from {}: {}", path.display(), e),
        }
    }
    if let Some(raw) = read_json_file(&bak) {
        warn!("Primary configuration invalid. Successfully recovered from backup: {}", bak.display());
        if let Err(e) = fs::copy(&bak, path) {
            warn!("Could not restore backup to primary path: {}", e);
        }
        return AppConfig::from_value(&Value::Object(raw));
    }
    let backup_dir = project_root().join("backups");
    if let Ok(rd) = fs::read_dir(&backup_dir) {
        let mut zips: Vec<(SystemTime, PathBuf)> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().map_or(false, |e| e == "zip"))
            .map(|p| (fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
            .collect();
        zips.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, z) in zips {
            let snap = (|| -> Option<Value> {
                let f = fs::File::open(&z).ok()?;
                let mut za = zip::ZipArchive::new(f).ok()?;
                let mut entry = za.by_name("config.json").ok()?;
                let mut s = String::new();
                std::io::Read::read_to_string(&mut entry, &mut s).ok()?;
                serde_json::from_str::<Value>(&s).ok().filter(Value::is_object)
            })();
            if let Some(v) = snap {
                warn!("Recovered configuration from snapshot: {}", z.file_name().unwrap_or_default().to_string_lossy());
                let mut cfg = AppConfig::from_value(&v);
                save_app_config(&mut cfg, path);
                return cfg;
            }
        }
    }
    info!("No valid configuration found for {}. Initializing clean defaults.", path.display());
    AppConfig::default()
}

/// Atomically save the whole AppConfig, keeping config.json.bak and hourly rolling snapshots
pub fn save_app_config(cfg: &mut AppConfig, path: &Path) -> bool {
    let data = pretty_json(&cfg.to_value());
    let bak = with_suffix(path, ".bak");
    if path.exists() && fs::metadata(path).map(|m| m.len() > 0).unwrap_or(false) {
        if let Err(e) = fs::copy(path, &bak) {
            warn!("Failed to update backup file {}: {}", bak.display(), e);
        }
        if path == default_config_path() {
            rolling_snapshot(path);
        }
    }
    match write_atomic(path, data.as_bytes()) {
        Ok(()) => true,
        Err(e) => {
            error!("Failed to atomically save config to {}: {}", path.display(), e);
            false
        }
    }
}

fn rolling_snapshot(path: &Path) {
    let dir = project_root().join("backups").join("configs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut snaps: Vec<(SystemTime, PathBuf)> = fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let n = p.file_name().unwrap_or_default().to_string_lossy().to_string();
                    n.starts_with("config_") && n.ends_with(".json")
                })
                .map(|p| (fs::metadata(&p).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH), p))
                .collect()
        })
        .unwrap_or_default();
    snaps.sort();
    let due = snaps.last().map_or(true, |(t, _)| SystemTime::now().duration_since(*t).map(|d| d.as_secs() >= SNAPSHOT_MIN_SECONDS).unwrap_or(true));
    if due {
        let snap = dir.join(format!("config_{}.json", chrono::Local::now().format("%Y%m%d_%H%M%S")));
        if fs::copy(path, &snap).is_ok() {
            snaps.push((SystemTime::now(), snap));
        }
    }
    if snaps.len() > 15 {
        for (_, old) in &snaps[..snaps.len() - 15] {
            let _ = fs::remove_file(old);
        }
    }
}

/// Make a preset name a safe file name
pub fn sanitize_preset_filename(name: &str) -> String {
    let cleaned: String = name.trim().chars().map(|c| if r#"\/:*?"<>|"#.contains(c) { '_' } else { c }).collect();
    format!("{}.json", if cleaned.is_empty() { "Unnamed_Preset".to_string() } else { cleaned })
}

pub fn save_preset_file(profile: &ProfileConfig, dir: &Path) -> bool {
    let target = dir.join(sanitize_preset_filename(&profile.name));
    match write_atomic(&target, pretty_json(&profile.to_value()).as_bytes()) {
        Ok(()) => true,
        Err(e) => {
            warn!("Could not write preset file for '{}': {}", profile.name, e);
            false
        }
    }
}

pub fn delete_preset_file(name: &str, dir: &Path) -> bool {
    let target = dir.join(sanitize_preset_filename(name));
    target.exists() && fs::remove_file(&target).is_ok()
}

fn json_files(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> =
        fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map_or(false, |e| e == "json")).collect()).unwrap_or_default();
    v.sort();
    v
}

fn file_stem(p: &Path) -> String {
    p.file_stem().unwrap_or_default().to_string_lossy().to_string()
}

/// Add the profiles shipped in defaults/profiles/ once per installation (names remembered in extra)
pub fn seed_default_profiles(cfg: &mut AppConfig, dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let mut seeded: Vec<String> = arr(cfg.extra.get("seeded_default_profiles")).iter().map(py_str).collect();
    let mut existing: std::collections::HashSet<String> = cfg.profiles.iter().map(|p| p.name.to_lowercase()).collect();
    let mut changed = false;
    for file in json_files(dir) {
        let Some(raw) = read_json_file(&file) else { continue };
        let stem = file_stem(&file);
        let n = get_str(&raw, "name", &stem).trim().to_string();
        let name = if n.is_empty() { stem } else { n };
        if seeded.contains(&name) {
            continue;
        }
        seeded.push(name.clone());
        changed = true;
        if existing.contains(&name.to_lowercase()) {
            continue;
        }
        let mut p = ProfileConfig::from_value(&Value::Object(raw));
        p.name = name.clone();
        cfg.add_or_update_profile(p, false);
        existing.insert(name.to_lowercase());
        info!("Added shipped profile '{}'", name);
    }
    if changed {
        cfg.extra.insert("seeded_default_profiles".into(), json!(seeded));
    }
    changed
}

/// Write every profile to presets/ (with export) and load preset files dropped in there.
/// Returns true when profiles were added.
pub fn sync_presets_with_disk(cfg: &mut AppConfig, dir: &Path, export: bool) -> bool {
    let _ = fs::create_dir_all(dir);
    let mut changed = seed_default_profiles(cfg, &project_root().join("defaults").join("profiles"));
    if export {
        for p in &cfg.profiles {
            save_preset_file(p, dir);
        }
    }
    let mut existing: std::collections::HashSet<String> = cfg.profiles.iter().map(|p| p.name.to_lowercase()).collect();
    for file in json_files(dir) {
        let Some(raw) = read_json_file(&file) else { continue };
        if raw.is_empty() {
            continue;
        }
        let stem = file_stem(&file);
        let n = get_str(&raw, "name", &stem).trim().to_string();
        let name = if n.is_empty() { stem } else { n };
        if existing.contains(&name.to_lowercase()) {
            continue;
        }
        let mut p = ProfileConfig::from_value(&Value::Object(raw));
        p.name = name.clone();
        cfg.add_or_update_profile(p, false);
        existing.insert(name.to_lowercase());
        changed = true;
        info!("Discovered new preset from disk: '{}' ({})", name, file.display());
    }
    changed
}
