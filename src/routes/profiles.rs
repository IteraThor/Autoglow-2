//! Event Matrix presets: /api/matrix/presets (GET, select, save, rename, delete, export, import).
//! Profiles are one shared list; each controller picks the one it uses. Calls that pass a controller "ip"
//! act on that controller's choice, calls without one on the shared default.

use super::*;
use crate::models::{AppConfig, ProfileConfig};
use crate::storage::{delete_preset_file, presets_dir, sanitize_preset_filename, save_preset_file, sync_presets_with_disk};

fn target_ip(req: &Req, data: Option<&Obj>) -> String {
    data.and_then(|d| non_empty(d.get("ip"))).map(py_str).unwrap_or_else(|| req.q_or("ip", "").to_string()).trim().to_string()
}

fn ip_opt(ip: &str) -> Option<&str> {
    if ip.is_empty() {
        None
    } else {
        Some(ip)
    }
}

/// Preset names, the profile in use (for ip, else the default) and every controller's choice
fn preset_state(cfg: &AppConfig, ip: &str, with_profile: bool) -> Obj {
    let devs: Obj = cfg.devices.iter().filter(|d| !d.ip.is_empty()).map(|d| (d.ip.clone(), json!(cfg.profile_name_for(Some(&d.ip), None)))).collect();
    let segs: Obj = cfg
        .devices
        .iter()
        .filter(|d| !d.ip.is_empty() && !d.segments.is_empty())
        .map(|d| {
            let m: Obj = d.segments.iter().map(|sg| (sg.id.to_string(), json!(cfg.profile_name_for(Some(&d.ip), Some(sg.id))))).collect();
            (d.ip.clone(), Value::Object(m))
        })
        .collect();
    let mut out = crate::obj! {
        "status" => "ok", "active_profile" => cfg.profile_name_for(ip_opt(ip), None),
        "presets" => cfg.profiles.iter().map(|p| p.name.clone()).collect::<Vec<_>>(),
        "device_profiles" => devs, "segment_profiles" => segs,
    };
    if with_profile {
        out.insert("profile".into(), cfg.profile_for(ip_opt(ip), None).to_value());
    }
    out
}

fn persist(s: &S) -> Result<AppConfig, AppError> {
    let mut snap = s.engine.cfg_clone();
    if !save_cfg(s, &mut snap) {
        error!("Failed to persist configuration to disk");
        return Err(AppError::persistence("Failed to persist configuration to disk"));
    }
    Ok(snap)
}

pub async fn get_presets(State(s): State<S>, req: Req) -> ApiResult {
    let changed = sync_presets_with_disk(&mut s.engine.cfg(), &presets_dir(), false);
    if changed {
        let _ = persist(&s);
    }
    let cfg = s.engine.cfg_clone();
    let ip = target_ip(&req, None);
    let mut out = preset_state(&cfg, &ip, !ip.is_empty());
    let name = req.q_or("name", "").trim().to_string();
    if !name.is_empty() {
        let p = cfg.get_profile(&name).ok_or_else(|| AppError::not_found(format!("Preset '{}' not found", name)))?;
        out.insert("profile".into(), p.to_value());
    }
    ok(Value::Object(out))
}

pub async fn select_preset(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let name = data.get("name").map(py_str).unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("Preset name is required").field("name"));
    }
    let ip = target_ip(&req, Some(&data));
    let seg = data.get("segment_id").filter(|v| !v.is_null()).map(|v| safe_int(Some(v), 0));
    let found = {
        let mut c = s.engine.cfg();
        match (ip.is_empty(), seg) {
            (false, Some(sid)) => c.set_segment_profile(&ip, sid, &name),
            (false, None) => c.set_device_profile(&ip, &name),
            _ => c.set_active_profile(&name),
        }
    };
    if !found {
        return Err(AppError::not_found(format!("Preset '{}' not found", name)));
    }
    let cfg = persist(&s)?;
    info!("Switched Event Matrix preset to '{}'{}", name, if ip.is_empty() { String::new() } else { format!(" on {}", ip) });
    ok(Value::Object(preset_state(&cfg, &ip, true)))
}

pub async fn save_preset(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let name = data.get("name").map(py_str).unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("Preset name cannot be empty").field("name"));
    }
    if name.chars().count() > 60 {
        return Err(AppError::validation("Preset name exceeds 60 characters").field("name"));
    }
    let ip = target_ip(&req, Some(&data));
    let mut prof = match data.get("profile").filter(|p| p.is_object() && truthy(p)) {
        Some(p) => ProfileConfig::from_value(p),
        None => ProfileConfig::from_value(&s.engine.cfg().profile_for(ip_opt(&ip), None).to_value()),
    };
    prof.name = name.clone();
    let set_active = get_bool(&data, "set_active", true);
    {
        let mut c = s.engine.cfg();
        c.add_or_update_profile(prof.clone(), set_active && ip.is_empty());
        if set_active && !ip.is_empty() {
            c.set_device_profile(&ip, &prof.name);
        }
    }
    save_preset_file(&prof, &presets_dir());
    let cfg = persist(&s)?;
    info!("Saved Event Matrix preset '{}' (active={})", name, set_active);
    let mut out = preset_state(&cfg, &ip, true);
    if ip.is_empty() {
        out.insert("active_profile".into(), json!(prof.name));
        out.insert("profile".into(), prof.to_value());
    }
    ok(Value::Object(out))
}

pub async fn rename_preset(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let old = data.get("old_name").map(py_str).unwrap_or_default().trim().to_string();
    let new = data.get("new_name").map(py_str).unwrap_or_default().trim().to_string();
    if old.is_empty() {
        return Err(AppError::validation("Original preset name is required"));
    }
    if new.is_empty() {
        return Err(AppError::validation("New preset name cannot be empty").field("name"));
    }
    if new.chars().count() > 60 {
        return Err(AppError::validation("Preset name exceeds 60 characters").field("name"));
    }
    if old.to_lowercase() == "default" {
        return Err(AppError::validation("The 'Default' preset cannot be renamed"));
    }
    let ip = target_ip(&req, Some(&data));
    if old == new {
        return ok(Value::Object(preset_state(&s.engine.cfg_clone(), &ip, false)));
    }
    let renamed = {
        let mut c = s.engine.cfg();
        if c.profiles.iter().any(|p| p.name.to_lowercase() == new.to_lowercase() && p.name.to_lowercase() != old.to_lowercase()) {
            return Err(AppError::conflict(format!("A preset named '{}' already exists", new)).field("name"));
        }
        let Some(p) = c.get_profile_mut(&old) else { return Err(AppError::not_found(format!("Preset '{}' not found", old))) };
        p.name = new.clone();
        let p = p.clone();
        if c.active_profile == old {
            c.active_profile = new.clone();
        }
        c.rename_profile_refs(&old, &new);
        p
    };
    delete_preset_file(&old, &presets_dir());
    save_preset_file(&renamed, &presets_dir());
    let cfg = persist(&s)?;
    info!("Renamed Event Matrix preset '{}' to '{}'", old, new);
    ok(Value::Object(preset_state(&cfg, &ip, false)))
}

pub async fn delete_preset(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json_or_empty();
    let name = data.get("name").map(py_str).unwrap_or_else(|| req.q_or("name", "").to_string()).trim().to_string();
    if name.is_empty() {
        return Err(AppError::validation("Preset name to delete is required"));
    }
    if name.to_lowercase() == "default" {
        return Err(AppError::validation("The 'Default' preset cannot be deleted"));
    }
    {
        let mut c = s.engine.cfg();
        if c.profiles.len() <= 1 {
            return Err(AppError::validation("Cannot delete the only remaining preset"));
        }
        if c.get_profile(&name).is_none() {
            return Err(AppError::not_found(format!("Preset '{}' not found", name)));
        }
        c.profiles.retain(|p| p.name != name);
        c.drop_profile_refs(&name);
        if c.active_profile == name {
            c.active_profile = if c.get_profile("Default").is_some() { "Default".into() } else { c.profiles[0].name.clone() };
        }
    }
    delete_preset_file(&name, &presets_dir());
    let cfg = persist(&s)?;
    info!("Deleted Event Matrix preset '{}'. Default is now '{}'", name, cfg.active_profile);
    ok(Value::Object(preset_state(&cfg, &target_ip(&req, Some(&data)), true)))
}

pub async fn export_preset(State(s): State<S>, req: Req) -> ApiResult {
    let cfg = s.engine.cfg_clone();
    let name = req.q("name").map(str::trim).filter(|n| !n.is_empty()).map(str::to_string).unwrap_or_else(|| cfg.active_profile.clone());
    let p = cfg.get_profile(&name).ok_or_else(|| AppError::not_found(format!("Preset '{}' not found", name)))?;
    let mut r = Json(p.to_value()).into_response();
    if let Ok(v) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", sanitize_preset_filename(&name))) {
        r.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(r)
}

pub async fn import_preset(State(s): State<S>, req: Req) -> ApiResult {
    let ct = req.header("content-type").unwrap_or("").to_string();
    let (data, stem) = if ct.starts_with("multipart/") {
        let (fname, bytes) = first_multipart_file(&req).await.ok_or_else(|| AppError::validation("No file uploaded").field("file"))?;
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| AppError::validation("Preset file is not valid JSON").field("file"))?;
        let stem = fname.as_deref().map(|f| std::path::Path::new(f).file_stem().unwrap_or_default().to_string_lossy().to_string()).filter(|s| !s.is_empty());
        (v, stem.unwrap_or_else(|| "Imported Preset".into()))
    } else {
        (Value::Object(req.json()?), "Imported Preset".to_string())
    };
    let Some(obj) = data.as_object() else { return Err(AppError::validation("Preset file must contain a JSON object")) };
    let mut pname = get_str(obj, "name", &stem).trim().to_string();
    if pname.is_empty() {
        pname = stem.clone();
    }
    let pname: String = pname.chars().take(60).collect();
    let ip = req.q_or("ip", "").trim().to_string();
    let prof = {
        let mut c = s.engine.cfg();
        let existing: std::collections::HashSet<String> = c.profiles.iter().map(|p| p.name.to_lowercase()).collect();
        let mut final_name = pname.clone();
        let mut n = 1;
        while existing.contains(&final_name.to_lowercase()) {
            final_name = format!("{} ({})", pname, n);
            n += 1;
        }
        let mut p = ProfileConfig::from_value(&data);
        p.name = final_name.clone();
        c.add_or_update_profile(p.clone(), false);
        if !ip.is_empty() {
            c.set_device_profile(&ip, &final_name);
        }
        p
    };
    save_preset_file(&prof, &presets_dir());
    let cfg = persist(&s).map_err(|_| AppError::persistence("Failed to persist configuration"))?;
    info!("Successfully imported preset '{}'", prof.name);
    let mut out = preset_state(&cfg, &ip, true);
    if ip.is_empty() {
        out.insert("active_profile".into(), json!(prof.name));
        out.insert("profile".into(), prof.to_value());
    }
    ok(Value::Object(out))
}
