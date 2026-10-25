"""
AutoGlow 2 - Universal Cross-Platform 1-Click Launcher
Automatically sets up the virtual environment if missing, installs dependencies,
and starts the AutoGlow 2 Web Server at http://localhost:8080.
"""

import sys
import subprocess
from pathlib import Path

def main():
    root = Path(__file__).resolve().parent
    venv_dir = root / "venv"
    
    if sys.platform == "win32":
        venv_python = venv_dir / "Scripts" / "python.exe"
    else:
        venv_python = venv_dir / "bin" / "python3"

    print("=" * 50)
    print("      AutoGlow 2 Universal Launcher")
    print("=" * 50)

    if sys.version_info < (3, 10):
        print(f"[ERROR] AutoGlow needs Python 3.10 or newer (this is {sys.version.split()[0]}).")
        input("\nPress Enter to exit...")
        return 1

    # 1. Create Virtual Environment if not present
    if not venv_python.exists():
        print("--> Creating isolated Python virtual environment...")
        try:
            subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], check=True)
        except subprocess.CalledProcessError as e:
            print(f"[ERROR] Failed to create virtual environment: {e}")
            input("\nPress Enter to exit...")
            return 1

        print("--> Installing dependencies from requirements.txt...")
        req_file = root / "requirements.txt"
        try:
            subprocess.run([str(venv_python), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], check=True)
            subprocess.run([str(venv_python), "-m", "pip", "install", "-r", str(req_file)], check=True)
        except subprocess.CalledProcessError as e:
            print(f"[ERROR] Failed to install dependencies: {e}")
            input("\nPress Enter to exit...")
            return 1
        print("--> Installation complete!\n")

    # 2. Launch AutoGlow 2 Web Server
    server_script = root / "server.py"
    print("--> Starting AutoGlow 2 Web Server at http://localhost:8080 ...")
    print("--> Open http://localhost:8080 in your browser to configure.")
    print("=" * 50)
    
    try:
        subprocess.run([str(venv_python), str(server_script)])
    except KeyboardInterrupt:
        print("\nAutoGlow 2 stopped by user.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
