# AutoGlow 2: Status Light for Autodarts

Real-time WLED lighting for Autodarts boards, driven by your live games.

## Install (Linux)
Open a terminal on the computer that runs Autodarts and run this as your normal user, **without** `sudo` in front:
```bash
curl -fsSL https://github.com/IteraThor/Autoglow-2/releases/latest/download/install.sh | bash
```
It downloads the ready-built AutoGlow (nothing is compiled, it takes seconds), asks for your password once for `sudo`, starts AutoGlow as the `autoglow` service and installs the Chrome extension. Then open **http://localhost:8080** (or **http://autoglow.local:8080**) and restart Chrome once so the extension appears.

Works on Debian/Ubuntu, Raspberry Pi OS (64-bit), Fedora and other Linux with systemd, on x86_64 and 64-bit ARM. AutoGlow lives in `~/autoglow`.

Status: `sudo systemctl status autoglow` · Logs: `journalctl -u autoglow -f`

## Chrome extension (AutoGlow Bridge)
AutoGlow receives live game events from the **AutoGlow Bridge** extension while you play on **https://play.autodarts.com**. Chrome must run on the **same computer** as AutoGlow and stay open with a play.autodarts.com tab.

* Installed automatically for Chrome, Chromium, Brave and Edge. Restart the browser once.
* **Flatpak browsers / manual:** open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked** and select the `chrome_extension` folder.

The icon shows **ON** while AutoGlow receives the game. The extension only reads the data the Autodarts page already gets. It never sends anything to Autodarts and never reads your login.

## Updating
```bash
bash ~/autoglow/install.sh
```
Run it as your normal user, without `sudo`. It fetches the latest release in seconds and restarts AutoGlow. Your settings, flows, profiles and Studio data are kept.

**Installed from a git clone or ZIP before?** Follow the install steps above. The install command copies your settings into `~/autoglow` and moves the service there; the old folder is left as it was and can be deleted afterwards.

**Coming from the Python AutoGlow (2.2 and older)?** If it was installed with git (also by SUIT), update it the way you always did: press **Update** in SUIT, or run `git pull` and `sudo bash setup.sh` in its folder. It switches to the new AutoGlow and downloads it ready-built; your settings, flows and profiles are kept.

**Building from source** (development, or a CPU without a ready-built release): `git clone https://github.com/IteraThor/Autoglow-2.git`, then `sudo bash setup.sh` in that folder. Update with `git pull` and `sudo bash setup.sh`; a checkout of a release downloads its ready-built program instead of building.

## Classic mode (AutoGlow 1)
The original AutoGlow lives on its own page, **Classic** in the menu. It is the simple USB-only status light: it listens to the Autodarts Board Manager on this computer (`http://localhost:3180`) and sends one color per board status (Throw, Takeout, Takeout in progress, Starting, Stopped, Calibrating, Error) to a WLED ESP32 plugged in over USB. No Wi-Fi, Autodarts login or Chrome extension needed.

* Switch it **On**, pick an effect and color per status and press **Save**. **Test** shows a look right away.
* The ESP32 is found on its own (CP210x, CH340, FTDI, ESP32-S2/S3); enter the port (e.g. `/dev/ttyUSB0` or `COM3`) if it is not.
* It runs next to the Flow Matrix. Do not also add the USB controller under **Setup**.
* The installer adds the AutoGlow user to the `dialout` group for USB access; log out and in once (or restart) afterwards. Settings are kept in `classic.json`.

## Settings
* **Port:** `8080`, changeable with `AUTOGLOW_PORT`. The extension only connects to 8080.
* **Config file:** `config.json`, or set `AUTOGLOW_CONFIG`. Logs go to `autoglow.log`; `AUTOGLOW_DEBUG=1` logs more.
* **Access PIN:** by default anyone on your network can change settings. Set a PIN under **Settings → Access PIN**. Forgot it? Stop AutoGlow, delete `access_pin_hash` from `config.json` and start again.
