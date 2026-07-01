# AutoGlow 2 Beta: Status Light for Autodarts (Web & API Edition)

## Installation & Setup
### 1. Windows Setup
1. **Download and Unpack**

2. **Run the setup script:**
   * Double-click **`setup.bat`**
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
