//! /api/presets: event presets, one saved setup per event for the Studio and the Dashboard together
//! (src/event_presets.rs); web/js/features/event-presets.js shows them on both pages

use super::*;
use crate::event_presets::PresetError;
use axum::extract::Path;

fn err(e: PresetError) -> AppError {
    match e {
        PresetError::Invalid(m) => AppError::validation(m),
        PresetError::NotFound => AppError::not_found("Preset not found"),
        PresetError::Io(m) => AppError::persistence(m),
    }
}

pub async fn list(State(s): State<S>) -> ApiResult {
    ok(s.presets.list(&s.studio, &s.dashboard).map_err(err)?)
}

/// A new preset, copied from the live settings; it becomes the active one
pub async fn create(State(s): State<S>, req: Req) -> ApiResult {
    let name = get_str(&req.json()?, "name", "");
    ok(s.presets.create(&s.studio, &s.dashboard, &name).map_err(err)?)
}

pub async fn rename(State(s): State<S>, Path(id): Path<String>, req: Req) -> ApiResult {
    let name = get_str(&req.json()?, "name", "");
    ok(s.presets.rename(&s.studio, &s.dashboard, &id, &name).map_err(err)?)
}

pub async fn activate(State(s): State<S>, Path(id): Path<String>) -> ApiResult {
    ok(s.presets.activate(&s.studio, &s.dashboard, &id).map_err(err)?)
}

pub async fn remove(State(s): State<S>, Path(id): Path<String>) -> ApiResult {
    ok(s.presets.delete(&s.studio, &s.dashboard, &id).map_err(err)?)
}
