"""
AutoGlow 2 - Backup & Restore Manager
Provides automated snapshot creation, archiving, and one-click restoration.
"""

import os
import json
import zipfile
import logging
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any, Optional

logger = logging.getLogger("autoglow.backup")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = PROJECT_ROOT / "backups"

# Environment, VCS and cache folders are machine-specific and must never be archived or restored
EXCLUDE_DIRS = {
    "backups", "backup", "venv", ".venv", "env", ".git", "__pycache__",
    "node_modules", "scratch", ".pytest_cache", ".ruff_cache"
}

EXCLUDE_EXTENSIONS = {".pyc", ".pyo", ".log", ".tmp"}


def _is_excluded_archive_path(arcname: str) -> bool:
    parts = Path(arcname).parts
    return any(part in EXCLUDE_DIRS for part in parts) or Path(arcname).suffix.lower() in EXCLUDE_EXTENSIONS


def _ensure_backup_dir():
    """Ensure the backups directory exists."""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


class BackupManager:
    """Manages creation, restoration, and enumeration of AutoGlow system backups."""

    @staticmethod
    def list_backups() -> List[Dict[str, Any]]:
        """Return a sorted list of all available backups."""
        _ensure_backup_dir()
        backups = []
        
        for file in BACKUP_DIR.glob("*.zip"):
            try:
                stat = file.stat()
                created_at = datetime.fromtimestamp(stat.st_ctime).strftime("%Y-%m-%d %H:%M:%S")
                size_kb = round(stat.st_size / 1024, 1)
                
                # Peek inside zip for metadata if available
                meta = {}
                try:
                    with zipfile.ZipFile(file, "r") as zf:
                        if "backup_metadata.json" in zf.namelist():
                            with zf.open("backup_metadata.json") as mf:
                                meta = json.loads(mf.read().decode("utf-8"))
                except Exception:
                    pass

                backups.append({
                    "filename": file.name,
                    "filepath": str(file),
                    "created_at": meta.get("created_at", created_at),
                    "version": meta.get("version", "v2.1"),
                    "note": meta.get("note", ""),
                    "size_kb": size_kb,
                    "file_count": meta.get("file_count", 0)
                })
            except Exception as e:
                logger.warning(f"Failed to inspect backup file {file.name}: {e}")

        # Sort newest first
        backups.sort(key=lambda x: x["created_at"], reverse=True)
        return backups

    @staticmethod
    def create_backup(note: str = "", version: str = "v2.1") -> Dict[str, Any]:
        """Create a full compressed snapshot of the AutoGlow project folder."""
        _ensure_backup_dir()
        
        now = datetime.now()
        timestamp_str = now.strftime("%Y%m%d_%H%M%S")
        readable_time = now.strftime("%Y-%m-%d %H:%M:%S")
        clean_ver = version.replace(".", "_")
        filename = f"autoglow_backup_{clean_ver}_{timestamp_str}.zip"
        zip_path = BACKUP_DIR / filename

        collected_files = []
        for root, dirs, files in os.walk(PROJECT_ROOT):
            # Prune only the backup directories to avoid recursive archiving
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

            rel_root = Path(root).relative_to(PROJECT_ROOT)
            
            for f in files:
                file_path = Path(root) / f
                if file_path == zip_path:
                    continue
                if EXCLUDE_EXTENSIONS and file_path.suffix.lower() in EXCLUDE_EXTENSIONS:
                    continue

                rel_path = rel_root / f
                collected_files.append((file_path, str(rel_path).replace("\\", "/")))

        # Create zip archive
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for src, arcname in collected_files:
                try:
                    zf.write(src, arcname)
                except Exception as ex:
                    logger.warning(f"Could not add {src} to backup: {ex}")
            
            # Write metadata manifest into archive
            metadata = {
                "created_at": readable_time,
                "version": version,
                "note": note,
                "file_count": len(collected_files),
                "timestamp": timestamp_str
            }
            zf.writestr("backup_metadata.json", json.dumps(metadata, indent=2))

        stat = zip_path.stat()
        logger.info(f"Created full project backup {filename} ({round(stat.st_size / 1024, 1)} KB, {len(collected_files)} files)")

        return {
            "status": "ok",
            "filename": filename,
            "size_kb": round(stat.st_size / 1024, 1),
            "created_at": readable_time,
            "version": version,
            "note": note,
            "file_count": len(collected_files)
        }

    @staticmethod
    def restore_backup(filename: str) -> Dict[str, Any]:
        """Safely restore all project files from a backup archive."""
        _ensure_backup_dir()
        safe_filename = Path(filename).name
        zip_path = BACKUP_DIR / safe_filename

        if not zip_path.exists() or not zip_path.is_file():
            raise FileNotFoundError(f"Backup file not found: {filename}")

        restored_count = 0
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.infolist():
                if member.filename == "backup_metadata.json":
                    continue
                # Older backups may contain venv/.git; restoring those would corrupt the install
                if _is_excluded_archive_path(member.filename):
                    continue
                # Security check: prevent path traversal outside PROJECT_ROOT
                target_path = (PROJECT_ROOT / member.filename).resolve()
                if not target_path.is_relative_to(PROJECT_ROOT):
                    continue

                try:
                    zf.extract(member, PROJECT_ROOT)
                    restored_count += 1
                except Exception as ex:
                    logger.warning(f"Could not restore file {member.filename}: {ex}")

        logger.info(f"Restored {restored_count} files from backup {safe_filename}")
        return {
            "status": "ok",
            "filename": safe_filename,
            "restored_files": restored_count
        }

    @staticmethod
    def delete_backup(filename: str) -> bool:
        """Delete an existing backup zip file."""
        _ensure_backup_dir()
        safe_filename = Path(filename).name
        zip_path = BACKUP_DIR / safe_filename

        if zip_path.exists() and zip_path.is_file():
            zip_path.unlink()
            logger.info(f"Deleted backup {safe_filename}")
            return True
        return False

    @staticmethod
    def get_backup_path(filename: str) -> Optional[Path]:
        """Get absolute path of backup file for downloads."""
        _ensure_backup_dir()
        safe_filename = Path(filename).name
        zip_path = BACKUP_DIR / safe_filename
        if zip_path.exists() and zip_path.is_file():
            return zip_path
        return None
