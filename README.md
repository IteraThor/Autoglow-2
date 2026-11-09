# AutoGlow 2: Status Light for Autodarts

Real-time WLED lighting for Autodarts boards, driven by your live games.

## Installation

AutoGlow is a Rust program that is built on your computer during setup (a few minutes the first time).

### Windows
1. Install **Rust** from [rustup.rs](https://rustup.rs) (it asks to install the Visual Studio C++ build tools; say yes).
2. Download the latest [release](https://github.com/IteraThor/Autoglow-2/releases) (or **Code › Download ZIP**) and extract it.
3. Double-click **`setup.bat`** once, then start AutoGlow with **`run_autoglow.bat`**. Keep its window open.
4. Open **http://localhost:8080**.

### Linux (Debian/Ubuntu, Fedora)
```bash
git clone https://github.com/IteraThor/Autoglow-2.git
cd Autoglow-2
sudo bash setup.sh
```
This installs everything (Rust too, when the system's is too old), builds AutoGlow, starts it as the `autoglow` systemd service and installs the Chrome extension. Open **http://localhost:8080** (or **http://autoglow.local:8080**).

Status: `sudo systemctl status autoglow` · Logs: `journalctl -u autoglow -f`

## Chrome extension (AutoGlow Bridge)
AutoGlow receives live game events from the **AutoGlow Bridge** extension while you play on **https://play.autodarts.com**. Chrome must run on the **same computer** as AutoGlow and stay open with a play.autodarts.com tab.

* **Linux:** installed by `setup.sh` for Chrome, Chromium, Brave and Edge. Restart the browser once. Flatpak browsers need the manual install.
* **Windows / manual:** open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and select the `chrome_extension` folder.

The icon shows **ON** while AutoGlow receives the game. The extension only reads the data the Autodarts page already gets. It never sends anything to Autodarts and never reads your login.

## Updating
Your settings, flows and profiles are kept on every update.

* **Linux:** `git pull`, then `sudo bash setup.sh`.
* **Windows:** close AutoGlow, extract the new ZIP over your folder, run `setup.bat`, then `run_autoglow.bat`.

**Coming from a Python version (v0.6 and older)?** Run setup once after updating (`sudo bash setup.sh` on Linux, `setup.bat` on Windows); it builds the new program and points the service at it. Your settings, flows, profiles and Studio players are kept. The old `venv` folder is no longer used and can be deleted.

**Coming from 2.1?**
* **Installed with git:** `git pull` refuses to update the first time. Run this once:
  ```bash
  cp game_flows.json ../game_flows.backup.json
  git checkout -- game_flows.json presets/Default.json
  git pull
  cp ../game_flows.backup.json game_flows.json
  sudo bash setup.sh
  ```
* **Updated with 2.1's "Upload update ZIP":** restart AutoGlow afterwards. On Linux run `sudo bash setup.sh`, on Windows restart `run_autoglow.bat`.

## Classic mode (AutoGlow 1)
The original AutoGlow lives on its own page, **Classic** in the menu. It is the simple USB-only status light: it listens to the Autodarts Board Manager on this computer (`http://localhost:3180`) and sends one color per board status (Throw, Takeout, Takeout in progress, Starting, Stopped, Calibrating, Error) to a WLED ESP32 plugged in over USB. No Wi-Fi, Autodarts login or Chrome extension needed.

* Switch it **On**, pick an effect and color per status and press **Save**. **Test** shows a look right away.
* The ESP32 is found on its own (CP210x, CH340, FTDI, ESP32-S2/S3); enter the port (e.g. `/dev/ttyUSB0` or `COM3`) if it is not.
* It runs next to the Flow Matrix. Do not also add the USB controller under **Setup**.
* On Linux, `setup.sh` adds the AutoGlow user to the `dialout` group for USB access; log out and in once (or restart) afterwards. Settings are kept in `classic.json`.

## Settings
* **Port:** `8080`, changeable with `AUTOGLOW_PORT`. The extension only connects to 8080.
* **Config file:** `config.json`, or set `AUTOGLOW_CONFIG`. Logs go to `autoglow.log`; `AUTOGLOW_DEBUG=1` logs more.
* **Access PIN:** by default anyone on your network can change settings. Set a PIN under **Settings → Access PIN**. Forgot it? Stop AutoGlow, delete `access_pin_hash` from `config.json` and start again.
