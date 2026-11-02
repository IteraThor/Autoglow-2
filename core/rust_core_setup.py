"""Build and install the optional Rust LED engine (rust_core/) into this venv.

    venv/bin/python3 -m core.rust_core_setup        (setup.sh and setup.bat run this)

Needs cargo (Rust). Without it, or when the build fails, AutoGlow keeps its Python LED engine and
setup carries on: this always exits 0. A build that no longer matches the sources is removed, so an
old engine never runs next to newer effect code. The build is skipped when the sources did not change.
"""

import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "rust_core"
MARKER = Path(sys.prefix) / ".autoglow_core_build"
PACKAGE = "autoglow-core"


def source_hash() -> str:
    h = hashlib.sha256()
    files = [SRC / "Cargo.toml", SRC / "Cargo.lock", SRC / "pyproject.toml"] + sorted((SRC / "src").glob("*.rs"))
    for f in files:
        h.update(f.name.encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def engine_works() -> bool:
    """The installed module loads and is the one this AutoGlow's wled_driver accepts."""
    probe = ("import autoglow_core, core.wled_driver as w; "
             "raise SystemExit(0 if autoglow_core.API_VERSION == w._RUST_API_VERSION else 1)")
    return subprocess.run([sys.executable, "-c", probe], cwd=ROOT, capture_output=True).returncode == 0


def uninstall() -> None:
    subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", PACKAGE], capture_output=True)
    MARKER.unlink(missing_ok=True)


def main() -> int:
    if not SRC.is_dir():
        return 0
    wanted = source_hash()
    if MARKER.exists() and MARKER.read_text().strip() == wanted and engine_works():
        print("    Rust LED engine is up to date.")
        return 0

    if shutil.which("cargo") is None:
        uninstall()
        print("    Rust (cargo) is not installed: AutoGlow uses its Python LED engine.")
        print("    For the steadier Rust engine install Rust from https://rustup.rs and run setup again.")
        return 0

    print("    Building the Rust LED engine (takes a minute or two the first time)...", flush=True)
    res = subprocess.run([sys.executable, "-m", "pip", "install", "--force-reinstall", "--no-deps", str(SRC)],
                         capture_output=True, text=True)
    if res.returncode == 0 and engine_works():
        MARKER.write_text(wanted + "\n")
        print("    Rust LED engine installed.")
        return 0

    uninstall()
    tail = "\n".join((res.stderr or res.stdout).strip().splitlines()[-15:])
    print("    The Rust LED engine could not be built, AutoGlow uses its Python LED engine:")
    print("    " + tail.replace("\n", "\n    "))
    return 0


if __name__ == "__main__":
    sys.exit(main())
