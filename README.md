# AutoGlow 2: Status Light for Autodarts (Web & API Edition)

Real-time smart lighting orchestration for Autodarts boards using WLED controllers and custom game flow automations.

---

## Installation & Setup

### 1. Windows Setup

#### Prerequisites
* **Python 3.10+** installed from [python.org](https://www.python.org/).
  > **Important:** Ensure **"Add Python to PATH"** is checked during Python installation.

#### Steps
1. **Download & Extract:**
   * Download the latest release `.zip` from the [Releases](https://github.com/IteraThor/Autoglow-2/releases) page.
   * Extract the archive to a folder of your choice.

2. **First-Time Setup:**
   * Double-click **`setup.bat`**.
   * This script creates an isolated virtual environment (`venv`), installs all required dependencies from `requirements.txt`, and offers to launch the application.

3. **Running the App:**
   * Double-click **`run_autoglow.bat`** (or run `python start.py`).
   * A terminal window will open running the AutoGlow web server — keep this window open while using the app.
   * Open your browser and navigate to: **`http://localhost:8080`**

---

### 2. Linux Setup (Ubuntu/Debian & Fedora)

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/IteraThor/Autoglow-2.git
   cd Autoglow-2
   ```

2. **Run the Automated Setup Script (requires sudo):**
   ```bash
   sudo bash setup.sh
   ```
   * Installs required system packages (`git`, `python3-venv`, build tools).
   * Grants USB device access (adds user to `dialout` group).
   * Creates a virtual environment and installs Python dependencies.
   * Configures and starts **`autoglow.service`** via systemd for automatic background startup.

3. **Access the Web Interface:**
   * Open **`http://localhost:8080`** (or **`http://autoglow.local:8080`**) in your web browser.

#### Managing the Linux Service
* **Check status:** `sudo systemctl status autoglow`
* **Restart service:** `sudo systemctl restart autoglow`
* **Stop service:** `sudo systemctl stop autoglow`
* **View live logs:** `journalctl -u autoglow -f`

---

### 3. Install the AutoGlow Bridge Chrome Extension
AutoGlow gets live game events (throws, takeouts, leg and match wins) from the **AutoGlow Bridge** extension in the `chrome_extension/` folder.

**Linux:** `setup.sh` installs it automatically in Google Chrome and Chromium through a browser policy (`/etc/opt/chrome/policies/managed/autoglow.json` and `/etc/chromium/policies/managed/autoglow.json`). Restart the browser once after setup. Chrome then shows "Managed by your organization" and lists the extension as installed by policy. To remove it, delete those two files.

**Windows / manual install:**

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and select the `chrome_extension` folder inside your AutoGlow folder.
3. Pin the extension and open **https://play.autodarts.com**. The icon shows **ON** while AutoGlow receives the game. The **Autodarts** page in AutoGlow shows the link status too.

The extension only reads the board and match data that the Autodarts page already receives. It never sends anything to Autodarts and never reads your login. Chrome has to stay open with a play.autodarts.com tab while you play.

**AutoGlow on another computer** (e.g. a Raspberry Pi): click the extension icon, enter the AutoGlow address (e.g. `http://192.168.1.50:8080`) and the **pairing key** from AutoGlow's Autodarts page. Connections from the same computer need no key.

> The previous direct Autodarts login (email/password and device link) is on hold until Autodarts approves it. The code is still in place and can be switched back on with `CLOUD_API_ON_HOLD` in `core/autodarts_bridge.py`.

---

## Configuration & Ports
* **Default Web Port:** `8080` (can be overridden via the `AUTOGLOW_PORT` environment variable).
* **Custom Config Path:** Set `AUTOGLOW_CONFIG` to point to a custom `config.json` location if needed.
* **Application Logs:** Written locally to `autoglow.log` (with automatic log rotation).

## Access PIN (recommended)
By default anyone on your network can open the AutoGlow UI and change settings. Set an access PIN under **Settings → Access PIN** to require it in every browser (sessions last 30 days and end immediately when the PIN changes).

Passwords, tokens and API keys are never sent to the browser, and requests from other websites are rejected.

**Forgot the PIN?** Stop AutoGlow, delete the `access_pin_hash` entry from `config.json`, and start it again.

## Operational Hub
The start page (`/hub`) shows the live lighting engine, stream and power state, the current Autodarts match, and a health card for every WLED controller (power, brightness, live-override lock and segment bounds, read back from `/json/state`). Controllers are not polled while the UDP stream is active.

---

## Development
```bash
python dev.py setup   # create venv + install runtime and dev dependencies
python dev.py check   # ruff lint + full unit test suite (same as CI)
python dev.py run     # start the server
```
CI (`.github/workflows/ci.yml`) runs lint and tests on Python 3.10, 3.12 and 3.14 for every push and pull request.

Tests never touch the production `config.json` or `game_flows.json`. Use `AUTOGLOW_CONFIG` to point a dev server at a scratch config, but note that startup also writes every profile into `presets/`.
