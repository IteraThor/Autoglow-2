"""
AutoGlow 2 - Leftovers from older versions
Unpacking a new release over an old install (or the old in-app ZIP updater) adds and replaces
files but never deletes any. These are files earlier versions shipped that this version removed;
they are deleted once at startup so stale code and pages are not served or picked up by tests.
"""

import logging
import os
from typing import List

logger = logging.getLogger("autoglow.legacy_cleanup")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

REMOVED_FILES = (
    # AI Copilot
    "core/ai_assistant.py",
    "routes/ai_routes.py",
    "web/js/ai.js",
    # Updates & backups page
    "core/updater.py",
    "core/backup_manager.py",
    "routes/system_routes.py",
    "web/js/system.js",
    # Old UI files replaced by the redesign
    "web/style.css",
    "web/js/hub.js",
    "web/flow_design_examples.html",
    "web/flow_outcome_examples.html",
    "web/flow_takeout_examples.html",
    # Tests for removed features
    "tests/test_board_offline_standby.py",
)


def remove_legacy_files(root: str = ROOT) -> List[str]:
    """Delete files that older versions shipped and this one no longer has. Returns the removed paths."""
    removed = []
    for rel in REMOVED_FILES:
        path = os.path.join(root, *rel.split("/"))
        if not os.path.isfile(path):
            continue
        try:
            os.remove(path)
            removed.append(rel)
        except OSError as e:
            logger.warning(f"Could not remove leftover file from an older version {rel}: {e}")
    if removed:
        logger.info(f"Removed {len(removed)} leftover file(s) from an older AutoGlow version: {', '.join(removed)}")
    return removed
