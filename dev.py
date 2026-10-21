"""
AutoGlow 2 - Developer task runner (cross-platform).

Usage: python dev.py <setup|test|lint|check|run>
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV_PY = ROOT / "venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python3")


def _run(*args: str) -> int:
    print("+", " ".join(args))
    return subprocess.call(list(args), cwd=ROOT)


def setup() -> int:
    if not VENV_PY.exists():
        if _run(sys.executable, "-m", "venv", str(ROOT / "venv")):
            return 1
    return _run(str(VENV_PY), "-m", "pip", "install", "-r", "requirements-dev.txt")


def test() -> int:
    return _run(str(VENV_PY), "-m", "unittest", "discover", "-s", "tests")


def lint() -> int:
    return _run(str(VENV_PY), "-m", "ruff", "check", ".")


def check() -> int:
    return lint() or test()


def run() -> int:
    return _run(str(VENV_PY), "server.py")


TASKS = {"setup": setup, "test": test, "lint": lint, "check": check, "run": run}

if __name__ == "__main__":
    task = sys.argv[1] if len(sys.argv) > 1 else ""
    if task not in TASKS:
        print(__doc__.strip())
        sys.exit(2)
    if task != "setup" and not VENV_PY.exists():
        print("Virtual environment missing: run `python dev.py setup` first.")
        sys.exit(1)
    sys.exit(TASKS[task]())
