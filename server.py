"""
AutoGlow 2 - compatibility launcher.

AutoGlow is a Rust program now (src/, built by setup.sh / setup.bat into ./autoglow). Installs that still
start "python3 server.py" (an older autoglow.service, a shortcut) land here: build AutoGlow if needed,
then hand over to it. Run setup again once to start the program directly.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EXE = ROOT / ("autoglow.exe" if sys.platform == "win32" else "autoglow")
BUILT = ROOT / "target" / "release" / EXE.name


def _outdated() -> bool:
    """The program is missing, or older than its sources (an update was unpacked or pulled)."""
    if not EXE.exists():
        return True
    built = EXE.stat().st_mtime
    sources = [ROOT / "Cargo.toml", ROOT / "Cargo.lock", *(ROOT / "src").rglob("*.rs")]
    return any(p.exists() and p.stat().st_mtime > built for p in sources)


def main() -> int:
    if _outdated():
        if shutil.which("cargo"):
            print("--> Building AutoGlow (first start after an update, takes a few minutes)...", flush=True)
            if subprocess.call(["cargo", "build", "--release"], cwd=ROOT) != 0:
                return 1
            shutil.copy2(BUILT, EXE)
        elif not EXE.exists():
            print("AutoGlow needs Rust to build: install it from https://rustup.rs and run setup again.", file=sys.stderr)
            return 1
    if sys.platform == "win32":
        return subprocess.call([str(EXE), *sys.argv[1:]], cwd=ROOT)
    os.chdir(ROOT)
    os.execv(str(EXE), [str(EXE), *sys.argv[1:]])
    return 0


if __name__ == "__main__":
    sys.exit(main())
