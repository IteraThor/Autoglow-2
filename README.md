# AutoGlow 2: Status Light for Autodarts (Web & API Edition)

AutoGlow 2 is a local utility that synchronizes your Autodarts board's real-time match events with a physical WLED strip (via WiFi or direct USB/Serial connection). It features a modern web interface for configuration and offers an HTTP REST API for remote testing and custom event triggering.

---

## Features
* **Modern Web Interface:** Configure WLED devices, manage multi-segment strip layouts, assign effects, and view logs directly in your browser.
* **Dual Event Syncing:** Support for local Autodarts WebSocket events (port `3180`) and remote/online matches (Autodarts Cloud feed).
* **Multi-Segment & Strip Support:** Map multiple WLED endpoints with unique custom event profiles.
* **REST API Integration:** Control, trigger, and test lighting effects programmatically over HTTP.
* **Plug & Play Setup:** Automated installation scripts for Windows, Ubuntu/Debian, and Fedora.

---

## Installation & Setup

Choose the setup instructions for your operating system:

### 1. Windows Setup
1. **Clone the project:**
   ```bash
   git clone https://github.com/IteraThor/Autoglow-2.git
   cd Autoglow-2
   ```
2. **Run the setup script:**
   * Double-click **`setup.bat`** (or run `setup.bat` in command prompt).
   * This will automatically build a Python virtual environment, install requirements, and offer to run the app.

3. **Running the App:**
   * Double-click **`run_autoglow.bat`** to start the app in the background. A system tray icon will appear in your taskbar.
   * Open the configuration interface: **`http://localhost:8080`**

---

### 2. Linux Setup (Ubuntu/Debian & Fedora)
1. **Clone the project:**
   ```bash
   git clone https://github.com/IteraThor/Autoglow-2.git
   cd Autoglow-2
   ```
2. **Run the installation script (requires sudo):**
   ```bash
   sudo bash setup.sh
   ```
   * *Ubuntu/Debian:* Automatically installs required dependencies via `apt`.
   * *Fedora:* Automatically installs required dependencies via `dnf`.
   * Configures dialout permissions for USB/Serial connections.
   * Registers and enables system background services (`systemd`).

3. **Running & Managing Linux Services:**
   AutoGlow runs as two separate background services:
   * **AutoGlow Sync Daemon (`autoglow.service`):**
     * Check status: `sudo systemctl status autoglow.service`
     * Restart: `sudo systemctl restart autoglow.service`
     * Logs: `journalctl -u autoglow.service -f`
   * **AutoGlow Web Config Server (`autoglow-web.service`):**
     * Access UI: Open **`http://<your-ip>:8080`** in your browser.
     * Check status: `sudo systemctl status autoglow-web.service`
     * Restart: `sudo systemctl restart autoglow-web.service`
     * Logs: `journalctl -u autoglow-web.service -f`

---

## Testing LEDs via REST API

You can trigger test colors and effects on WLED devices programmatically by posting to the configuration server API.

### Endpoint: `POST http://localhost:8080/api/test_effect`

#### Payload Schema:
```json
{
  "connection_type": "wifi",
  "wifi_ip": "192.168.2.214",
  "fx": 0,
  "col": [0, 255, 0],
  "bri": 255
}
```
* **`connection_type`**: `"wifi"` or `"serial"`
* **`wifi_ip`**: IP address of the WLED device (required for `wifi`).
* **`manual_port`**: USB serial path e.g. `"/dev/ttyUSB0"` or `"COM3"` (required for `serial`).
* **`fx`**: WLED Effect ID (e.g., `0` for solid color, `9` for rainbow).
* **`col`**: `[Red, Green, Blue]` values (`0-255`).
* **`bri`**: Brightness scale (`0-255`).

#### Example Curl:
```bash
curl -X POST http://localhost:8080/api/test_effect \
  -H "Content-Type: application/json" \
  -d '{"connection_type": "wifi", "wifi_ip": "192.168.2.214", "fx": 0, "col": [0, 255, 0], "bri": 255}'
```
