"""
AutoGlow 2 - Resilient Configuration Storage Module
Atomic persistence, auto-backup, corrupted-file quarantine, and multi-tier recovery.
"""

import os
import sys
import json
import shutil
import zipfile
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, Optional

from core.models import AppConfig, ProfileConfig

logger = logging.getLogger("autoglow.storage")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = str(PROJECT_ROOT / "config.json")
BACKUPS_CONFIG_DIR = PROJECT_ROOT / "backups" / "configs"
PRESETS_DIR = PROJECT_ROOT / "presets"
DEFAULT_PROFILES_DIR = PROJECT_ROOT / "defaults" / "profiles"


def resolve_config_path(config_path: Optional[str] = None) -> str:
    """Resolve configuration path to an absolute path anchored to project root."""
    if not config_path:
        return DEFAULT_CONFIG_PATH
    p = Path(config_path)
    if p.is_absolute():
        return str(p)
    return str((PROJECT_ROOT / p).resolve())


def _read_json_file(file_path: str) -> Optional[Dict[str, Any]]:
    """Read and parse a JSON dictionary from file. Returns None if invalid or empty."""
    if not os.path.exists(file_path):
        return None
    try:
        if os.path.getsize(file_path) == 0:
            logger.warning(f"Config file is 0 bytes (empty): {file_path}")
            return None
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
            logger.warning(f"Expected JSON object in {file_path}, got {type(data)}")
            return None
    except Exception as e:
        logger.warning(f"Failed to parse JSON from {file_path}: {e}")
        return None


def load_app_config(config_path: Optional[str] = None) -> AppConfig:
    """
    Load full application configuration into an AppConfig dataclass.
    Multi-tier resilient recovery order:
    1. Primary target config file (config.json)
    2. Primary backup file (config.json.bak)
    3. Latest archive snapshot (backups/*.zip)
    4. Clean default AppConfig (last resort)
    """
    target_path = resolve_config_path(config_path)
    bak_path = f"{target_path}.bak"

    # Tier 1: Try primary config file
    raw_config = _read_json_file(target_path)
    if raw_config is not None:
        cfg = AppConfig.from_dict(raw_config)
        if any(isinstance(p, dict) and p.get("device_events") for p in raw_config.get("profiles") or []):
            # Pre-2.3 per-controller effects were split into profiles; save so the split happens only once
            save_app_config(cfg, target_path)
        return cfg

    # If primary file exists but failed validation (corrupt / 0-bytes), quarantine it
    if os.path.exists(target_path):
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        corrupt_path = f"{target_path}.corrupt_{ts}"
        try:
            shutil.copy2(target_path, corrupt_path)
            logger.error(f"Quarantined corrupted configuration from {target_path} to {corrupt_path}")
        except Exception:
            logger.exception(f"Failed to quarantine corrupted config from {target_path}")

    # Tier 2: Try primary backup file (.bak)
    bak_config = _read_json_file(bak_path)
    if bak_config is not None:
        logger.warning(f"Primary configuration invalid. Successfully recovered from backup: {bak_path}")
        try:
            shutil.copy2(bak_path, target_path)
        except Exception as e:
            logger.warning(f"Could not restore backup to primary path: {e}")
        return AppConfig.from_dict(bak_config)

    # Tier 3: Try latest zip snapshot from backups directory
    backup_dir = PROJECT_ROOT / "backups"
    if backup_dir.exists() and backup_dir.is_dir():
        zip_files = sorted(
            backup_dir.glob("*.zip"),
            key=lambda p: p.stat().st_mtime if p.exists() else 0,
            reverse=True
        )
        for zip_file in zip_files:
            try:
                with zipfile.ZipFile(zip_file, "r") as zf:
                    if "config.json" in zf.namelist():
                        with zf.open("config.json") as cf:
                            snap_data = json.loads(cf.read().decode("utf-8"))
                            if isinstance(snap_data, dict):
                                logger.warning(f"Recovered configuration from snapshot: {zip_file.name}")
                                recovered_cfg = AppConfig.from_dict(snap_data)
                                save_app_config(recovered_cfg, target_path)
                                return recovered_cfg
            except Exception as e:
                logger.warning(f"Could not inspect snapshot {zip_file.name}: {e}")

    # Tier 4: Fallback to defaults
    logger.info(f"No valid configuration found for {target_path}. Initializing clean defaults.")
    return AppConfig()


def save_app_config(
    config: AppConfig,
    config_path: Optional[str] = None
) -> bool:
    """
    Atomically save entire AppConfig state to disk:
    1. Writes serialized JSON to temporary file (.tmp)
    2. Flushes & fsyncs to guarantee disk persistence
    3. Backs up existing valid config to .bak
    4. Atomically replaces target config with temporary file
    """
    target_path = resolve_config_path(config_path)
    tmp_path = f"{target_path}.tmp"
    bak_path = f"{target_path}.bak"

    # SAFETY GUARD: Prevent unit test execution from inadvertently overwriting production configuration
    if ("unittest" in sys.modules or "pytest" in sys.modules) and not os.environ.get("AUTOGLOW_ALLOW_PROD_CONFIG_IN_TEST"):
        if os.path.abspath(target_path) == os.path.abspath(DEFAULT_CONFIG_PATH):
            logger.error(
                f"SAFETY GUARD ACTIVATED: Blocked attempt to overwrite production config '{target_path}' "
                f"during test execution. Tests must provide an isolated test config path."
            )
            return False

    try:
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        data = config.to_dict()

        # Step 1: Write to temporary file with flush & fsync
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=4)
            f.flush()
            os.fsync(f.fileno())

        # Step 2: If existing target is non-empty, back it up to .bak
        if os.path.exists(target_path) and os.path.getsize(target_path) > 0:
            try:
                shutil.copy2(target_path, bak_path)
            except Exception as e:
                logger.warning(f"Failed to update backup file {bak_path}: {e}")

            # If saving production config, also maintain timestamped rolling snapshots (last 15)
            if os.path.abspath(target_path) == os.path.abspath(DEFAULT_CONFIG_PATH):
                try:
                    os.makedirs(BACKUPS_CONFIG_DIR, exist_ok=True)
                    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                    snap_path = BACKUPS_CONFIG_DIR / f"config_{ts}.json"
                    shutil.copy2(target_path, snap_path)

                    snaps = sorted(BACKUPS_CONFIG_DIR.glob("config_*.json"), key=os.path.getmtime)
                    if len(snaps) > 15:
                        for old_snap in snaps[:-15]:
                            try:
                                old_snap.unlink()
                            except Exception:
                                pass
                except Exception as e_snap:
                    logger.debug(f"Could not write rolling config snapshot: {e_snap}")

        # Step 3: Atomic replace
        os.replace(tmp_path, target_path)
        return True

    except Exception:
        logger.exception(f"Failed to atomically save config to {target_path}")
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        return False


def sanitize_preset_filename(name: str) -> str:
    """Sanitize preset name to a safe, valid filesystem filename."""
    cleaned = "".join(c if c not in r'\/:*?"<>|' else "_" for c in name.strip())
    return (cleaned or "Unnamed_Preset") + ".json"


def ensure_presets_dir(presets_dir: Optional[str] = None) -> Path:
    """Ensure the presets directory exists and return Path."""
    p = Path(presets_dir) if presets_dir else PRESETS_DIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def save_preset_file(profile: ProfileConfig, presets_dir: Optional[str] = None) -> bool:
    """Save an individual preset to a clean JSON file in the presets folder."""
    try:
        p_dir = ensure_presets_dir(presets_dir)
        filename = sanitize_preset_filename(profile.name)
        target = p_dir / filename
        with open(target, "w", encoding="utf-8") as f:
            json.dump(profile.to_dict(), f, indent=4)
        return True
    except Exception as e:
        logger.warning(f"Could not write preset file for '{profile.name}': {e}")
        return False


def delete_preset_file(name: str, presets_dir: Optional[str] = None) -> bool:
    """Delete an individual preset file from the presets folder."""
    try:
        p_dir = ensure_presets_dir(presets_dir)
        filename = sanitize_preset_filename(name)
        target = p_dir / filename
        if target.exists():
            target.unlink()
            return True
        return False
    except Exception as e:
        logger.warning(f"Could not delete preset file for '{name}': {e}")
        return False


def seed_default_profiles(cfg: AppConfig, defaults_dir: Optional[str] = None) -> bool:
    """
    Add the profiles shipped in defaults/profiles/ once per installation. The names already seeded are
    remembered in cfg.extra, so a shipped profile that the user deleted or renamed does not come back.
    Returns True if any profile was added.
    """
    d_dir = Path(defaults_dir) if defaults_dir else DEFAULT_PROFILES_DIR
    if not d_dir.is_dir():
        return False
    seeded = cfg.extra.get("seeded_default_profiles")
    seeded = [str(n) for n in seeded] if isinstance(seeded, list) else []
    existing_names = {p.name.lower() for p in cfg.profiles}
    changed = False
    for file in sorted(d_dir.glob("*.json")):
        try:
            raw = _read_json_file(str(file))
            if not (raw and isinstance(raw, dict)):
                continue
            name = str(raw.get("name", file.stem)).strip() or file.stem
            if name in seeded:
                continue
            seeded.append(name)
            changed = True
            if name.lower() in existing_names:
                continue
            profile = ProfileConfig.from_dict(raw)
            profile.name = name
            cfg.add_or_update_profile(profile, set_active=False)
            existing_names.add(name.lower())
            logger.info(f"Added shipped profile '{name}'")
        except Exception as e:
            logger.warning(f"Failed to load shipped profile {file.name}: {e}")
    if changed:
        cfg.extra["seeded_default_profiles"] = seeded
    return changed


def sync_presets_with_disk(cfg: AppConfig, presets_dir: Optional[str] = None) -> bool:
    """
    Bi-directionally synchronize presets between AppConfig and the presets/ folder:
    1. Writes all current AppConfig profiles to individual files in presets/.
    2. Discovers any new .json preset files dropped into presets/ and loads them into cfg.profiles.
    Returns True if any new presets were added from disk.
    """
    p_dir = ensure_presets_dir(presets_dir)
    changed = seed_default_profiles(cfg)

    # 1. Export current in-memory profiles to presets folder
    for prof in cfg.profiles:
        save_preset_file(prof, presets_dir=str(p_dir))

    # 2. Scan presets folder for external preset files
    existing_names = {p.name.lower(): p for p in cfg.profiles}
    for file in p_dir.glob("*.json"):
        try:
            raw = _read_json_file(str(file))
            if raw and isinstance(raw, dict):
                # Resolve name
                p_name = str(raw.get("name", file.stem)).strip() or file.stem
                if p_name.lower() not in existing_names:
                    loaded_profile = ProfileConfig.from_dict(raw)
                    loaded_profile.name = p_name
                    cfg.add_or_update_profile(loaded_profile, set_active=False)
                    existing_names[p_name.lower()] = loaded_profile
                    changed = True
                    logger.info(f"Discovered new preset from disk: '{p_name}' ({file.name})")
        except Exception as e:
            logger.warning(f"Failed to load preset from {file.name}: {e}")

    return changed
