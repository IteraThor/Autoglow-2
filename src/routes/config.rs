//! /api/config (GET, POST) and /api/config/reset

use super::*;
use crate::models::AppConfig;
use crate::security::{redact_config, restore_redacted_secrets, PIN_HASH_KEY};

/// Autodarts account details in "extra" that keep their saved value when a save leaves them blank
const KEPT_AUTODARTS_EXTRAS: [&str; 6] =
    ["autodarts_token_expires_at", "autodarts_client_id", "autodarts_email", "autodarts_name", "autodarts_username", "autodarts_board_id"];

pub async fn get_config(State(s): State<S>) -> ApiResult {
    let mut cfg = s.engine.cfg_clone();
    let Value::Object(mut data) = cfg.to_value() else { unreachable!() };
    redact_config(&mut data);
    data.insert("status".into(), json!("ok"));
    data.insert("device".into(), cfg.primary_device().map(|d| d.to_value()).unwrap_or(json!({})));
    ok(Value::Object(data))
}

pub async fn post_config(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let mut existing = s.engine.cfg_clone();
    // A page sends only the settings it edits; everything else stays as the server has it now
    let Value::Object(mut merged) = existing.to_value() else { unreachable!() };
    for (k, v) in &data {
        merged.insert(k.clone(), v.clone());
    }
    let mut cfg = AppConfig::from_value(&Value::Object(merged));
    cfg.extra.shift_remove(PIN_HASH_KEY);
    keep_unsent_settings(&mut cfg, &existing, &data);
    if !save_cfg(&s, &mut cfg) {
        error!("Failed to persist configuration to disk: {}", s.engine.config_path.display());
        return Err(AppError::persistence("Failed to persist configuration to disk"));
    }
    s.engine.set_config(cfg);
    ok(json!({"status": "ok"}))
}

fn keep_unsent_settings(cfg: &mut AppConfig, existing: &AppConfig, data: &Obj) {
    restore_redacted_secrets(cfg, existing);
    if !data.contains_key("device_profiles") {
        let names: Vec<String> = cfg.profiles.iter().map(|p| p.name.clone()).collect();
        cfg.device_profiles = existing.device_profiles.iter().filter(|(_, n)| names.contains(&py_str(n))).map(|(k, v)| (k.clone(), v.clone())).collect();
    }
    if !data.contains_key("segment_profiles") {
        let names: Vec<String> = cfg.profiles.iter().map(|p| p.name.clone()).collect();
        cfg.segment_profiles = existing
            .segment_profiles
            .iter()
            .map(|(ip, segs)| (ip.clone(), segs.iter().filter(|(_, n)| names.contains(&py_str(n))).map(|(k, v)| (k.clone(), v.clone())).collect()))
            .collect();
    }
    if cfg.autodarts_user.is_empty() && !existing.autodarts_user.is_empty() {
        cfg.autodarts_user = existing.autodarts_user.clone();
    }
    if cfg.autodarts_board_id.is_empty() && !existing.autodarts_board_id.is_empty() {
        cfg.autodarts_board_id = existing.autodarts_board_id.clone();
    }
    for k in KEPT_AUTODARTS_EXTRAS {
        if let Some(v) = existing.extra.get(k).filter(|v| truthy(v)) {
            if !cfg.extra.get(k).map_or(false, truthy) {
                cfg.extra.insert(k.into(), v.clone());
            }
        }
    }
}

pub async fn reset_config(State(s): State<S>) -> ApiResult {
    let mut empty = AppConfig::default();
    if let Some(h) = s.engine.cfg().extra.get(PIN_HASH_KEY).filter(|v| truthy(v)) {
        // Keep the access PIN: resetting lighting settings must not silently open the API
        empty.extra.insert(PIN_HASH_KEY.into(), h.clone());
    }
    if !save_cfg(&s, &mut empty) {
        return Err(AppError::persistence("Failed to reset configuration on disk"));
    }
    s.engine.set_config(empty);
    info!("Application settings reset to clean zero-state.");
    ok(json!({"status": "ok", "message": "Settings cleared."}))
}
