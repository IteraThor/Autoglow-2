//! Leftovers from older versions: unpacking a new release over an old install adds and replaces files but
//! never deletes any. Files earlier versions shipped that this version removed are deleted once at startup.

use log::{info, warn};
use std::path::Path;

const REMOVED_FILES: &[&str] = &[
    // AI Copilot
    "core/ai_assistant.py",
    "routes/ai_routes.py",
    "web/js/ai.js",
    // Updates & backups page
    "core/updater.py",
    "core/backup_manager.py",
    "routes/system_routes.py",
    "web/js/system.js",
    // Old UI files replaced by the redesign
    "web/style.css",
    "web/js/hub.js",
    "web/js/features/hub.js",
    "web/css/hub.css",
    "web/flow_design_examples.html",
    "web/flow_outcome_examples.html",
    "web/flow_takeout_examples.html",
    "core/animations.py",
    "tests/test_board_offline_standby.py",
];

pub fn remove_legacy_files(root: &Path) -> Vec<String> {
    let mut removed = Vec::new();
    for rel in REMOVED_FILES {
        let p = root.join(rel);
        if !p.is_file() {
            continue;
        }
        match std::fs::remove_file(&p) {
            Ok(()) => removed.push(rel.to_string()),
            Err(e) => warn!("Could not remove leftover file from an older version {}: {}", rel, e),
        }
    }
    if !removed.is_empty() {
        info!("Removed {} leftover file(s) from an older AutoGlow version: {}", removed.len(), removed.join(", "));
    }
    removed
}
