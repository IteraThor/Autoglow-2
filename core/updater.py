"""
AutoGlow 2 - GitHub Auto-Updater
Queries GitHub Releases / Repository for updates, performs git pull or zip package updates, and restarts.
"""

import sys
import json
import logging
import urllib.request
import zipfile
import subprocess
from pathlib import Path
from typing import Dict, Any

from core.version import __version__

logger = logging.getLogger("autoglow.updater")

CURRENT_VERSION = __version__
DEFAULT_GITHUB_REPO = "Henry/Autoglow-2-remastered"
PROJECT_ROOT = Path(__file__).resolve().parent.parent


def _parse_version(v: str) -> tuple:
    """Parse version string like 'v2.1.0' into numeric tuple (2, 1, 0)."""
    cleaned = v.strip().lstrip("v").lstrip("V")
    parts = []
    for p in cleaned.split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    return tuple(parts) if parts else (0, 0)


class UpdateManager:
    """Manages update checks against GitHub and performs in-place application."""

    @staticmethod
    def check_for_updates(repo: str = DEFAULT_GITHUB_REPO) -> Dict[str, Any]:
        """Check GitHub for newer releases or commits."""
        url = f"https://api.github.com/repos/{repo}/releases/latest"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "AutoGlow-Dartboard-Engine",
                "Accept": "application/vnd.github.v3+json"
            }
        )

        try:
            with urllib.request.urlopen(req, timeout=5.0) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    tag = data.get("tag_name", "v2.1")
                    remote_ver = _parse_version(tag)
                    local_ver = _parse_version(CURRENT_VERSION)
                    has_update = remote_ver > local_ver

                    return {
                        "status": "ok",
                        "has_update": has_update,
                        "current_version": f"v{CURRENT_VERSION}",
                        "latest_version": tag,
                        "release_name": data.get("name", tag),
                        "release_notes": data.get("body", "No release notes provided."),
                        "published_at": data.get("published_at", ""),
                        "html_url": data.get("html_url", f"https://github.com/{repo}")
                    }
        except Exception as e:
            logger.warning(f"Failed to check GitHub releases: {e}")
            return {
                "status": "error",
                "has_update": False,
                "current_version": f"v{CURRENT_VERSION}",
                "latest_version": "unknown",
                "release_name": "Unable to check for updates",
                "release_notes": f"Update check failed: {e}",
                "published_at": "",
                "html_url": f"https://github.com/{repo}"
            }

        # Fallback if repo has no formal releases yet
        return {
            "status": "ok",
            "has_update": False,
            "current_version": f"v{CURRENT_VERSION}",
            "latest_version": f"v{CURRENT_VERSION}",
            "release_name": f"AutoGlow v{CURRENT_VERSION} (Current)",
            "release_notes": "You are currently running the latest version.",
            "published_at": "",
            "html_url": f"https://github.com/{repo}"
        }

    @staticmethod
    def apply_zip_update(zip_path: Path, auto_backup: bool = True) -> Dict[str, Any]:
        """Apply an update from an uploaded ZIP archive directly to the project root."""
        if not zip_path.exists() or not zip_path.is_file():
            return {"status": "error", "message": f"Uploaded update file not found: {zip_path.name}"}

        backup_filename = None
        if auto_backup:
            try:
                from core.backup_manager import BackupManager
                res = BackupManager.create_backup(note=f"Snapshot before ZIP update ({zip_path.name})")
                backup_filename = res.get("filename")
                logger.info(f"Created pre-update safety backup: {backup_filename}")
            except Exception as e:
                logger.warning(f"Failed to create pre-update safety backup: {e}")

        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                # 1. Inspect archive files to detect common top-level directory wrapper (e.g. from GitHub release zips)
                all_names = [m.filename for m in zf.infolist() if not m.is_dir()]
                common_prefix = ""
                if all_names:
                    first_parts = [n.split("/")[0] for n in all_names if "/" in n]
                    if first_parts and len(set(first_parts)) == 1 and len(first_parts) == len(all_names):
                        candidate = first_parts[0] + "/"
                        if any(n.startswith(candidate + "core/") or n.startswith(candidate + "web/") or n == candidate + "server.py" for n in all_names):
                            common_prefix = candidate

                restored_count = 0
                for member in zf.infolist():
                    arcname = member.filename
                    if common_prefix and arcname.startswith(common_prefix):
                        arcname = arcname[len(common_prefix):]

                    if not arcname or arcname == "backup_metadata.json":
                        continue

                    # Security check: prevent path traversal outside PROJECT_ROOT
                    target_path = (PROJECT_ROOT / arcname).resolve()
                    if not target_path.is_relative_to(PROJECT_ROOT):
                        logger.warning(f"Skipping ZIP entry outside project root: {member.filename}")
                        continue

                    # Prevent overwriting the backups storage folder or the live config/secrets
                    if target_path.is_relative_to(PROJECT_ROOT / "backups") or target_path.name.startswith("config.json"):
                        continue

                    if member.is_dir():
                        target_path.mkdir(parents=True, exist_ok=True)
                    else:
                        target_path.parent.mkdir(parents=True, exist_ok=True)
                        try:
                            with zf.open(member) as src, open(target_path, "wb") as dst:
                                dst.write(src.read())
                            restored_count += 1
                        except Exception as file_err:
                            logger.warning(f"Could not overwrite file {arcname}: {file_err}")

            logger.info(f"Successfully applied ZIP update: {restored_count} files extracted.")
            return {
                "status": "ok",
                "message": f"Update applied successfully ({restored_count} files updated). AutoGlow is restarting...",
                "files_updated": restored_count,
                "backup_created": backup_filename
            }
        except Exception as e:
            logger.exception("Failed to apply ZIP update")
            return {"status": "error", "message": str(e)}
        finally:
            try:
                if zip_path.exists():
                    zip_path.unlink()
            except Exception:
                pass

    @staticmethod
    def apply_update() -> Dict[str, Any]:
        """Execute update via git pull and reinstall requirements."""
        git_dir = PROJECT_ROOT / ".git"
        
        if git_dir.exists():
            logger.info("Executing git pull to update AutoGlow...")
            try:
                # 1. Git pull
                res = subprocess.run(
                    ["git", "pull", "origin", "main"],
                    cwd=str(PROJECT_ROOT),
                    capture_output=True,
                    text=True,
                    timeout=30
                )
                if res.returncode != 0:
                    logger.warning(f"Git pull failed: {res.stderr}")
                    return {"status": "error", "message": f"Git pull error: {res.stderr}"}

                # 2. Pip install requirements
                req_file = PROJECT_ROOT / "requirements.txt"
                if req_file.exists():
                    pip_res = subprocess.run(
                        [sys.executable, "-m", "pip", "install", "-r", str(req_file)],
                        cwd=str(PROJECT_ROOT),
                        capture_output=True,
                        text=True,
                        timeout=60
                    )
                    if pip_res.returncode != 0:
                        logger.warning(f"pip install requirements failed: {pip_res.stderr}")

                logger.info("Git pull completed successfully.")
                return {
                    "status": "ok",
                    "message": "AutoGlow updated successfully. Restarting...",
                    "output": res.stdout
                }
            except Exception as e:
                logger.exception("Error applying git update")
                return {"status": "error", "message": str(e)}

        return {
            "status": "error",
            "message": "Manual download required: .git repository not found in workspace."
        }
