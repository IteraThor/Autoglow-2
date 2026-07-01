import sys
import os

if getattr(sys, 'frozen', False):
    PROJECT_DIR = os.path.dirname(sys.executable)
else:
    PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))

if not getattr(sys, 'frozen', False):
    venv_site = os.path.join(PROJECT_DIR, "venv", "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")
    if os.path.exists(venv_site):
        sys.path.insert(0, venv_site)


import asyncio
import websockets
import json
import serial
import serial.tools.list_ports
import time
import logging
import urllib.request
import urllib.parse

# =============================================================================
# LOGGING & CONFIGURATION
# =============================================================================

CONFIG_FILE = os.path.join(PROJECT_DIR, "config.json")

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("AutoGlow")

def update_sync_status(local_connected=None, online_connected=None):
    status_file = os.path.join(PROJECT_DIR, ".sync_status.json")
    status = {"local": False, "online": False, "timestamp": time.time()}
    if os.path.exists(status_file):
        try:
            with open(status_file, "r") as f:
                status = json.load(f)
        except Exception:
            pass
    if local_connected is not None:
        status["local"] = local_connected
    if online_connected is not None:
        status["online"] = online_connected
    status["timestamp"] = time.time()
    try:
        with open(status_file, "w") as f:
            json.dump(status, f)
    except Exception:
        pass

DEFAULT_CONFIG = {
    "global_brightness": 255,
    "manual_port": "",
    "autodarts_websocket_enabled": True,
    "Throw": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[0, 255, 0]]}, "enabled": True},
    "Takeout in progress": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[255, 0, 0]]}, "enabled": True},
    "Takeout": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[255, 255, 0]]}, "enabled": True},
    "Starting": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[0, 0, 255]]}, "enabled": True},
    "Stopped": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[255, 0, 255]]}, "enabled": True},
    "Calibrating": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[128, 0, 128]]}, "enabled": True},
    "Error": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 1, "col": [[255, 0, 0]]}, "enabled": True},
    "Bust": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 1, "col": [[255, 0, 0]]}, "enabled": True},
    "180": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 9, "col": [[255, 165, 0]]}, "enabled": True},
    "Throw Player 1": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[0, 200, 255]]}, "enabled": False},
    "Throw Player 2": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[255, 100, 0]]}, "enabled": False},
    "Leg Won": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 9, "col": [[255, 0, 0], [0, 255, 0], [0, 0, 255]]}, "enabled": True, "duration": 5.0},
    "Match Won": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 11, "col": [[255, 0, 0], [0, 255, 0], [0, 0, 255]]}, "enabled": True, "duration": 8.0},
    "Triple": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 45, "col": [[255, 215, 0]]}, "enabled": False, "duration": 1.0}
}

def load_config():
    if not os.path.exists(CONFIG_FILE) or os.path.getsize(CONFIG_FILE) == 0:
        with open(CONFIG_FILE, "w") as f:
            json.dump(DEFAULT_CONFIG, f, indent=4)
        return DEFAULT_CONFIG
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Failed to load config: {e}")
        return DEFAULT_CONFIG

def get_profile_path(profile_name, strip_type):
    safe_profile = "".join(c for c in profile_name if c.isalnum() or c in (" ", "_", "-")).strip()
    category = "pwm-white" if int(strip_type) == 41 else "ws281x"
    return os.path.join(PROJECT_DIR, "profiles", category, f"{safe_profile}.json")

def check_api_source_enabled(source):
    config = load_config()
    devices = config.get("devices", [])
    if not devices:
        if source == "online":
            return config.get("autodarts_online_enabled", False)
        return config.get("autodarts_websocket_enabled", True)
    for dev in devices:
        for seg in dev.get("segments", []):
            if seg.get("is_split"):
                for sub in seg.get("sub_segments", []):
                    api_src = sub.get("api_source", "local")
                    if api_src == source or api_src == "hybrid":
                        return True
            else:
                api_src = seg.get("api_source", "local")
                if api_src == source or api_src == "hybrid":
                    return True
    return False

def ensure_valid_token():
    config = load_config()
    access_token = config.get("autodarts_access_token")
    refresh_token = config.get("autodarts_refresh_token")
    expires_at = config.get("autodarts_token_expires_at", 0)
    email = config.get("autodarts_email")
    password = config.get("autodarts_password")
    
    if not access_token or not refresh_token:
        return None
    
    # Check if close to expiration (within 60 seconds)
    if time.time() < (expires_at - 60):
        return access_token
        
    logger.info("Access token is near expiration or expired. Attempting refresh...")
    
    # Attempt to refresh
    try:
        endpoint = "https://auth.autodarts.io/auth/v1/refresh"
        client_id = "auth-ui"
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        body = {
            "refresh_token": refresh_token,
            "client_id": client_id
        }
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(body).encode('utf-8'),
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=10) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            new_access_token = res_data.get("access_token")
            new_refresh_token = res_data.get("refresh_token")
            expires_in = res_data.get("expires_in", 900)
            
            if new_access_token and new_refresh_token:
                config["autodarts_access_token"] = new_access_token
                config["autodarts_refresh_token"] = new_refresh_token
                config["autodarts_token_expires_at"] = time.time() + expires_in
                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)
                logger.info("Successfully refreshed Autodarts access token.")
                return new_access_token
    except Exception as e:
        logger.error(f"Failed to refresh Autodarts token: {e}")
        
    # If refresh failed, attempt full relogin with credentials
    if email and password:
        logger.info("Attempting full relogin with saved credentials...")
        try:
            endpoint = "https://auth.autodarts.io/auth/v1/login"
            client_id = "auth-ui"
            headers = {
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
            body = {
                "email": email,
                "username": email,
                "password": password,
                "client_id": client_id
            }
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(body).encode('utf-8'),
                headers=headers,
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=10) as response:
                res_data = json.loads(response.read().decode('utf-8'))
                new_access_token = res_data.get("access_token")
                new_refresh_token = res_data.get("refresh_token")
                expires_in = res_data.get("expires_in", 900)
                
                if new_access_token and new_refresh_token:
                    config["autodarts_access_token"] = new_access_token
                    config["autodarts_refresh_token"] = new_refresh_token
                    config["autodarts_token_expires_at"] = time.time() + expires_in
                    with open(CONFIG_FILE, "w") as f:
                        json.dump(config, f, indent=4)
                    logger.info("Successfully re-authenticated with Autodarts credentials.")
                    return new_access_token
        except Exception as ex:
            logger.error(f"Failed to re-authenticate with Autodarts credentials: {ex}")
            
    return None

def get_local_board_id():
    # 1. Try querying local board manager config
    try:
        req = urllib.request.Request("http://localhost:3180/api/config")
        with urllib.request.urlopen(req, timeout=3) as response:
            cfg = json.loads(response.read().decode('utf-8'))
            board_id = cfg.get("auth", {}).get("board_id")
            if board_id:
                logger.info(f"Dynamically fetched local board ID: {board_id}")
                # Save to config.json as cache
                config = load_config()
                if config.get("autodarts_board_id") != board_id:
                    config["autodarts_board_id"] = board_id
                    with open(CONFIG_FILE, "w") as f:
                        json.dump(config, f, indent=4)
                return board_id
    except Exception as e:
        logger.warning(f"Could not retrieve board ID from local Board Manager: {e}")
    
    # 2. Fallback to cache in config.json
    config = load_config()
    board_id = config.get("autodarts_board_id")
    if board_id:
        return board_id
        
    return None

def fetch_websocket_ticket(access_token):
    ticket_url = "https://play.ws.autodarts.io/ms/v0/tickets"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    req = urllib.request.Request(ticket_url, method="POST", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            res_data = json.loads(response.read().decode('utf-8'))
            return res_data.get("code")
    except Exception as e:
        logger.error(f"Failed to fetch websocket ticket from Autodarts: {e}")
    return None

# =============================================================================
# CORE LOGIC
# =============================================================================

serial_connections = {}
_last_crossfade = None  # track last applied crossfade to detect changes
_effect_hold_until = 0  # timestamp until which board state changes are suppressed
_queued_status = None   # last board status received during a hold — plays when hold expires
_current_player = -1    # 0-indexed current player from match state (-1 = unknown)

def apply_crossfade_setting(crossfade_enabled):
    """For serial: inject tt=0 (instant) or tt=5 (500ms fade) on next send.
    The actual persistent Crossfade checkbox on the WLED device is set via /json/cfg
    through the web server's /api/wled/set_transition endpoint (WiFi mode).
    For serial, we override tt on every state command instead."""
    # Nothing to do here — tt is injected per-command in handle_status_change
    logger.info(f"Crossfade setting changed: {'ON' if crossfade_enabled else 'OFF'} (will apply tt on next command)")


def find_esp32_port():
    config = load_config()
    manual = config.get("manual_port")
    if manual and os.path.exists(manual):
        logger.info(f"Using manual port: {manual}")
        return manual

    KNOWN_VID_PIDS = [(0x10C4, 0xEA60), (0x1A86, 0x7523), (0x0403, 0x6001), (0x303A, 0x1001)]
    ports = serial.tools.list_ports.comports()
    for port in ports:
        if (port.vid, port.pid) in KNOWN_VID_PIDS:
            return port.device
    return None

async def send_wled_command(device, command_dict):
    conn_type = device.get("connection_type", "wifi")
    ip_or_port = device.get("ip")
    if not ip_or_port:
        return
        
    wled_msg = {k: v for k, v in command_dict.items() if k != "enabled"}
    
    if conn_type == "serial":
        global serial_connections
        ser = serial_connections.get(ip_or_port)
        if not ser or not ser.is_open:
            try:
                ser = serial.Serial(ip_or_port, 115200, timeout=1)
                await asyncio.sleep(2) # settle time
                serial_connections[ip_or_port] = ser
                logger.info(f"Serial connection established on {ip_or_port}.")
            except Exception as e:
                logger.error(f"Failed to open serial port {ip_or_port}: {e}")
        
        if ser and ser.is_open:
            try:
                ser.write((json.dumps(wled_msg) + '\n').encode())
            except Exception as e:
                logger.error(f"Serial write error on {ip_or_port}: {e}")
                try:
                    ser.close()
                except Exception:
                    pass
                serial_connections.pop(ip_or_port, None)
    else:
        url = f"http://{ip_or_port}/json/state"
        
        def do_post():
            import urllib.request
            req = urllib.request.Request(
                url,
                data=json.dumps(wled_msg).encode('utf-8'),
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            with urllib.request.urlopen(req, timeout=1.5) as response:
                return response.read()

        try:
            loop = asyncio.get_running_loop()
            logger.info(f"Sending WLED WiFi payload to {ip_or_port}: {json.dumps(wled_msg)}")
            res = await loop.run_in_executor(None, do_post)
            logger.info(f"WLED WiFi response from {ip_or_port}: {res.decode('utf-8')[:200]}")
        except Exception as e:
            logger.error(f"Failed to send WLED command over WiFi to {ip_or_port}: {e}")

async def handle_status_change(status, api_source):
    global _last_crossfade, _effect_hold_until
    config = load_config()
    global_bri = config.get("global_brightness", 255)
    
    # Apply crossfade setting if it changed since last time
    crossfade = config.get("wled_crossfade", True)
    if crossfade != _last_crossfade:
        apply_crossfade_setting(crossfade)
        _last_crossfade = crossfade
        
    devices = config.get("devices", [])
    if not devices:
        devices = [{
            "id": "default",
            "name": "Default Device",
            "ip": config.get("wifi_ip") if config.get("connection_type") == "wifi" else config.get("manual_port"),
            "connection_type": config.get("connection_type", "wifi"),
            "api_type": "online" if config.get("autodarts_online_enabled") else "local",
            "profile": config.get("current_profile", "Default")
        }]
        
    target_devices = devices
    if not target_devices:
        return
        
    max_duration = 0
    for device in target_devices:
        db_segments = device.get("segments", [])
        
        if db_segments and isinstance(db_segments, list):
            command_segs = []
            start_offset = 0
            has_any_enabled = False
            device_max_duration = 0
            wled_seg_id = 0
            
            for idx, seg in enumerate(db_segments):
                length = int(seg.get("len", 60))
                stop_offset = start_offset + length
                
                if seg.get("is_split"):
                    for sub in seg.get("sub_segments", []):
                        sub_api = sub.get("api_source", "local")
                        if sub_api != api_source and sub_api != "hybrid":
                            wled_seg_id += 1
                            continue
                        sub_start = int(sub.get("start", 0))
                        sub_stop = int(sub.get("stop", length))
                        
                        wled_seg = {
                            "id": wled_seg_id,
                            "start": start_offset + sub_start,
                            "stop": start_offset + sub_stop
                        }
                        wled_seg_id += 1
                        
                        seg_profile = sub.get("profile") or "Default"
                        
                        # 1. Determine player routing for this segment's profile
                        target_status = status
                        if status == "Throw" and _current_player >= 0:
                            player_state = f"Throw Player {_current_player + 1}"
                            if is_state_configured_and_enabled(player_state, seg_profile, seg.get("type", 22)):
                                target_status = player_state
                        
                        # 2. Load profile data for this status
                        profile_path = get_profile_path(seg_profile, seg.get("type", 22))
                        
                        seg_status_config = None
                        if os.path.exists(profile_path):
                            try:
                                with open(profile_path, "r") as pf:
                                    profile_data = json.load(pf)
                                    if target_status in profile_data:
                                        seg_status_config = profile_data[target_status]
                            except Exception as e:
                                logger.error(f"Failed to read profile file {profile_path}: {e}")
                                
                        if seg_status_config is None:
                            seg_status_config = config.get(target_status)
                            
                        if seg_status_config and seg_status_config.get("enabled", True):
                            has_any_enabled = True
                            seg_config = None
                            if "seg" in seg_status_config:
                                if isinstance(seg_status_config["seg"], list) and len(seg_status_config["seg"]) > 0:
                                    seg_config = seg_status_config["seg"][0]
                                elif isinstance(seg_status_config["seg"], dict):
                                    seg_config = seg_status_config["seg"]
                            else:
                                seg_config = {k: v for k, v in seg_status_config.items() if k not in ["enabled", "cf", "duration", "on"]}
                                
                            if seg_config:
                                wled_seg.update(seg_config)
                                
                            duration = seg_status_config.get("duration", 0) or 0
                            if duration > device_max_duration:
                                device_max_duration = duration
                                
                        command_segs.append(wled_seg)
                else:
                    seg_api = seg.get("api_source", "local")
                    if seg_api != api_source and seg_api != "hybrid":
                        wled_seg_id += 1
                        continue
                    wled_seg = {
                        "id": wled_seg_id,
                        "start": start_offset,
                        "stop": stop_offset
                    }
                    wled_seg_id += 1
                    
                    seg_profile = seg.get("profile") or device.get("profile") or "Default"
                    
                    # 1. Determine player routing for this segment's profile
                    target_status = status
                    if status == "Throw" and _current_player >= 0:
                        player_state = f"Throw Player {_current_player + 1}"
                        if is_state_configured_and_enabled(player_state, seg_profile, seg.get("type", 22)):
                            target_status = player_state
                    
                    # 2. Load profile data for this status
                    profile_path = get_profile_path(seg_profile, seg.get("type", 22))
                    
                    seg_status_config = None
                    if os.path.exists(profile_path):
                        try:
                            with open(profile_path, "r") as pf:
                                profile_data = json.load(pf)
                                if target_status in profile_data:
                                    seg_status_config = profile_data[target_status]
                        except Exception as e:
                            logger.error(f"Failed to read profile file {profile_path}: {e}")
                            
                    if seg_status_config is None:
                        seg_status_config = config.get(target_status)
                        
                    if seg_status_config and seg_status_config.get("enabled", True):
                        has_any_enabled = True
                        seg_config = None
                        if "seg" in seg_status_config:
                            if isinstance(seg_status_config["seg"], list) and len(seg_status_config["seg"]) > 0:
                                seg_config = seg_status_config["seg"][0]
                            elif isinstance(seg_status_config["seg"], dict):
                                seg_config = seg_status_config["seg"]
                        else:
                            seg_config = {k: v for k, v in seg_status_config.items() if k not in ["enabled", "cf", "duration", "on"]}
                            
                        if seg_config:
                            wled_seg.update(seg_config)
                            
                        duration = seg_status_config.get("duration", 0) or 0
                        if duration > device_max_duration:
                            device_max_duration = duration
                            
                    command_segs.append(wled_seg)
                
                start_offset = stop_offset
                
            if has_any_enabled:
                logger.info(f"Status change: {status} (Device: {device.get('name')}, Segments Count: {len(db_segments)}, Bri: {global_bri})")
                command = {
                    "on": True,
                    "bri": global_bri,
                    "tt": 5 if crossfade else 0,
                    "seg": command_segs
                }
                asyncio.create_task(send_wled_command(device, command))
                if device_max_duration > max_duration:
                    max_duration = device_max_duration
            else:
                logger.debug(f"Status '{status}' is disabled or unconfigured for all segments of device '{device.get('name')}'.")
                
        else:
            # Fallback for devices without segment configurations (legacy/single-strip mode)
            if device.get("api_type", "local") != api_source:
                continue
            device_profile = device.get("profile") or "Default"
            
            target_status = status
            if status == "Throw" and _current_player >= 0:
                player_state = f"Throw Player {_current_player + 1}"
                if is_state_configured_and_enabled(player_state, device_profile, 22):
                    target_status = player_state
                    logger.info(f"Routing Throw -> {player_state} for device {device.get('name')}")
            
            profile_path = get_profile_path(device_profile, 22)
            
            status_config = None
            if os.path.exists(profile_path):
                try:
                    with open(profile_path, "r") as pf:
                        profile_data = json.load(pf)
                        if target_status in profile_data:
                            status_config = profile_data[target_status]
                except Exception as e:
                    logger.error(f"Failed to read profile file {profile_path}: {e}")
                    
            if status_config is None:
                status_config = config.get(target_status)
                
            if status_config and status_config.get("enabled", True):
                logger.info(f"Status change: {target_status} (Device: {device.get('name')}, Profile: {device_profile}, Bri: {global_bri})")
                command = status_config.copy()
                command.pop("enabled", None)
                command.pop("cf", None)
                command.pop("duration", None)
                command["bri"] = global_bri
                command["tt"] = 5 if crossfade else 0
                
                asyncio.create_task(send_wled_command(device, command))
                
                duration = status_config.get("duration", 0) or 0
                if duration > max_duration:
                    max_duration = duration
            else:
                logger.debug(f"Status '{target_status}' in profile '{device_profile}' is disabled or unconfigured for device '{device.get('name')}'.")

    if max_duration > 0:
        _effect_hold_until = time.time() + max_duration
        logger.info(f"Effect hold set: '{status}' active for {max_duration}s")


def is_state_configured_and_enabled(status, profile_name, strip_type=22):
    """Return True if status has an enabled effect in the given profile or default config."""
    config = load_config()
    profile_path = get_profile_path(profile_name, strip_type)
    if os.path.exists(profile_path):
        try:
            with open(profile_path, "r") as pf:
                profile_data = json.load(pf)
                cfg = profile_data.get(status)
                if cfg is not None:
                    return cfg.get("enabled", True)
        except Exception:
            pass
    cfg = config.get(status)
    return cfg.get("enabled", True) if cfg is not None else False


async def dispatch_status(status, api_source):
    """Dispatch a board status, routing through player-routing per device inside handle_status_change."""
    await handle_status_change(status, api_source)

async def play_startup_animation():
    """Trigger initial Throw state for both APIs on startup."""
    await handle_status_change("Throw", "local")
    await handle_status_change("Throw", "online")

async def token_refresher_loop():
    logger.info("Starting background token refresher loop...")
    while True:
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, ensure_valid_token)
        except Exception as e:
            logger.error(f"Error in token refresher loop: {e}")
        await asyncio.sleep(60)

async def online_board_websocket_loop():
    global _queued_status, _current_player
    logger.info("Starting background online board websocket loop...")
    
    try:
        signals_file = os.path.join(PROJECT_DIR, "online_signals.jsonl")
        with open(signals_file, "a") as sf:
            pass
    except Exception as e:
        logger.error(f"Failed to touch/create online_signals.jsonl file: {e}")
        
    while True:
        cfg = load_config()
        devices = cfg.get("devices", [])
        has_online = check_api_source_enabled("online")
        if not has_online:
            await asyncio.sleep(2)
            continue
            
        access_token = await asyncio.get_running_loop().run_in_executor(None, ensure_valid_token)
        if not access_token:
            logger.warning("Online Board API enabled, but no valid Autodarts account link found. Retrying in 10s...")
            await asyncio.sleep(10)
            continue
            
        board_id = get_local_board_id()
        if not board_id:
            logger.warning("Online Board API enabled, but no Board ID could be found. Retrying in 10s...")
            await asyncio.sleep(10)
            continue
            
        ticket_code = await asyncio.get_running_loop().run_in_executor(None, fetch_websocket_ticket, access_token)
        if not ticket_code:
            logger.warning("Failed to obtain a WebSocket ticket. Retrying in 10s...")
            await asyncio.sleep(10)
            continue
            
        ws_url = f"wss://play.ws.autodarts.io/ms/v0/subscribe?code={ticket_code}"
        logger.info(f"Connecting to Autodarts Online WebSocket at {ws_url}...")
        
        try:
            async with websockets.connect(ws_url) as websocket:
                logger.info("Connected to Autodarts Online WebSocket!")
                update_sync_status(online_connected=True)
                
                # Subscribe to board state updates
                sub_state_msg = {
                    "type": "subscribe",
                    "channel": "autodarts.boards",
                    "topic": f"{board_id}.state"
                }
                await websocket.send(json.dumps(sub_state_msg))
                
                # Subscribe to board events
                sub_event_msg = {
                    "type": "subscribe",
                    "channel": "autodarts.boards",
                    "topic": f"{board_id}.events"
                }
                await websocket.send(json.dumps(sub_event_msg))
                
                # Subscribe to board matches
                sub_matches_msg = {
                    "type": "subscribe",
                    "channel": "autodarts.boards",
                    "topic": f"{board_id}.matches"
                }
                await websocket.send(json.dumps(sub_matches_msg))
                
                logger.info(f"Subscribed to online events and matches for board {board_id}")
                
                active_match_id = None
                _last_bust_fired = False
                _last_180_fired = False
                _last_winner_fired = -1
                _last_game_winner_fired = -1
                _last_triple_throw_id = None
                
                # Poll for any already-active match
                try:
                    poll_url = "https://api.autodarts.io/gs/v0/matches"
                    poll_headers = {
                        "Authorization": f"Bearer {access_token}",
                        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    }
                    poll_req = urllib.request.Request(poll_url, headers=poll_headers)
                    with urllib.request.urlopen(poll_req, timeout=5) as poll_resp:
                        active_matches = json.loads(poll_resp.read().decode('utf-8'))
                        if isinstance(active_matches, list) and len(active_matches) > 0:
                            for m in active_matches:
                                m_id = m.get("id") if isinstance(m, dict) else m
                                if m_id:
                                    active_match_id = m_id
                                    logger.info(f"Found already-active match on connect: {active_match_id}. Subscribing...")
                                    sub_m_state = {
                                        "type": "subscribe",
                                        "channel": "autodarts.matches",
                                        "topic": f"{active_match_id}.state"
                                    }
                                    await websocket.send(json.dumps(sub_m_state))
                                    sub_m_events = {
                                        "type": "subscribe",
                                        "channel": "autodarts.matches",
                                        "topic": f"{active_match_id}.events"
                                    }
                                    await websocket.send(json.dumps(sub_m_events))
                                    break
                except Exception as poll_ex:
                    logger.warning(f"Could not poll for active matches on connect: {poll_ex}")
                
                while True:
                    # Check if configuration was disabled mid-loop
                    cfg = load_config()
                    devices = cfg.get("devices", [])
                    has_online = check_api_source_enabled("online")
                    if not has_online:
                        logger.info("No online API devices configured. Closing WebSocket connection...")
                        break
                        
                    try:
                        message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                        data = json.loads(message)
                        
                        try:
                            signals_file = os.path.join(PROJECT_DIR, "online_signals.jsonl")
                            with open(signals_file, "a") as sf:
                                sf.write(json.dumps({
                                    "timestamp": time.time(),
                                    "message": data
                                }) + "\n")
                        except Exception as log_ex:
                            logger.error(f"Failed to write signal to log file: {log_ex}")
                        
                        # Handle dynamic match subscriptions
                        if data.get("channel") == "autodarts.boards" and data.get("topic") == f"{board_id}.matches":
                            payload = data.get("data")
                            if isinstance(payload, dict):
                                event_type = payload.get("event")
                                new_match_id = payload.get("id")
                                if event_type == "start" and new_match_id:
                                    if new_match_id != active_match_id:
                                        active_match_id = new_match_id
                                        logger.info(f"Detected online match start: {active_match_id}. Subscribing to match topics...")
                                        _last_bust_fired = False
                                        _last_180_fired = False
                                        _last_winner_fired = -1
                                        _last_game_winner_fired = -1
                                        _last_triple_throw_id = None
                                        
                                        sub_m_state = {
                                            "type": "subscribe",
                                            "channel": "autodarts.matches",
                                            "topic": f"{active_match_id}.state"
                                        }
                                        await websocket.send(json.dumps(sub_m_state))
                                        
                                        sub_m_events = {
                                            "type": "subscribe",
                                            "channel": "autodarts.matches",
                                            "topic": f"{active_match_id}.events"
                                        }
                                        await websocket.send(json.dumps(sub_m_events))
                                elif event_type == "stop" or not new_match_id:
                                    if active_match_id:
                                        logger.info(f"Detected online match stop: {active_match_id}")
                                        active_match_id = None
                                        _current_player = -1
                                        _last_bust_fired = False
                                        _last_180_fired = False
                                        _last_winner_fired = -1
                                        _last_game_winner_fired = -1
                                        _last_triple_throw_id = None
                        
                        # Online board state
                        if data.get("channel") == "autodarts.boards" and data.get("topic") == f"{board_id}.state":
                            payload = data.get("data")
                            logger.info(f"Received online board state update: {payload}")
                            if isinstance(payload, dict) and "status" in payload:
                                incoming = payload["status"]
                                if time.time() < _effect_hold_until:
                                    logger.info(f"Queueing online '{incoming}' — effect hold active")
                                    _queued_status = (incoming, "online")
                                else:
                                    await dispatch_status(incoming, "online")
                        
                        # Online match state details (Bust, 180, Leg Won, Match Won, Triple)
                        if data.get("channel") == "autodarts.matches" and data.get("topic", "").endswith(".state"):
                            payload = data.get("data")
                            if isinstance(payload, dict):
                                new_player = payload.get("player", -1)
                                if isinstance(new_player, int) and new_player >= 0 and new_player != _current_player:
                                    logger.info(f"Online match: Player {new_player + 1}'s turn")
                                    _current_player = new_player

                                is_busted = payload.get("turnBusted", False)
                                if is_busted and not _last_bust_fired:
                                    logger.info("Online match: Bust detected! Triggering Bust effect.")
                                    await handle_status_change("Bust", "online")
                                    _last_bust_fired = True
                                elif not is_busted:
                                    _last_bust_fired = False

                                turn_score = payload.get("turnScore", 0)
                                if turn_score == 180 and not _last_180_fired:
                                    logger.info("Online match: 180! Triggering 180 effect.")
                                    await handle_status_change("180", "online")
                                    _last_180_fired = True
                                elif turn_score != 180:
                                    _last_180_fired = False

                                winner = payload.get("winner", -1)
                                try:
                                    winner_int = int(winner) if winner is not None else -1
                                except (ValueError, TypeError):
                                    winner_int = -1
                                
                                if winner_int >= 0:
                                    if winner_int != _last_winner_fired:
                                        logger.info(f"Online match: Leg Won by Player {winner_int + 1}! Triggering Leg Won effect.")
                                        await handle_status_change("Leg Won", "online")
                                        _last_winner_fired = winner_int
                                else:
                                    _last_winner_fired = -1

                                game_winner = payload.get("gameWinner", -1)
                                try:
                                    game_winner_int = int(game_winner) if game_winner is not None else -1
                                except (ValueError, TypeError):
                                    game_winner_int = -1
                                
                                if game_winner_int >= 0:
                                    if game_winner_int != _last_game_winner_fired:
                                        logger.info(f"Online match: Match Won by Player {game_winner_int + 1}! Triggering Match Won effect.")
                                        await handle_status_change("Match Won", "online")
                                        _last_game_winner_fired = game_winner_int
                                else:
                                    _last_game_winner_fired = -1

                                turns = payload.get("turns", [])
                                if isinstance(turns, list) and len(turns) > 0:
                                    last_turn = turns[-1]
                                    if isinstance(last_turn, dict):
                                        throws = last_turn.get("throws", [])
                                        if isinstance(throws, list) and len(throws) > 0:
                                            last_throw = throws[-1]
                                            if isinstance(last_throw, dict):
                                                throw_id = last_throw.get("id")
                                                segment = last_throw.get("segment")
                                                if isinstance(segment, dict) and throw_id:
                                                    if segment.get("bed") == "Triple":
                                                        if throw_id != _last_triple_throw_id:
                                                            logger.info(f"Online match: Triple hit detected ({segment.get('name')})! Triggering Triple effect.")
                                                            await handle_status_change("Triple", "online")
                                                            _last_triple_throw_id = throw_id

                        # Flush queue if hold has expired
                        if _queued_status is not None and time.time() >= _effect_hold_until:
                            queued, source = _queued_status
                            _queued_status = None
                            logger.info(f"Playing queued effect: '{queued}' for {source}")
                            await dispatch_status(queued, source)
                    except asyncio.TimeoutError:
                        if _queued_status is not None and time.time() >= _effect_hold_until:
                            queued, source = _queued_status
                            _queued_status = None
                            logger.info(f"Playing queued effect (timeout flush): '{queued}' for {source}")
                            await dispatch_status(queued, source)
                        continue
        except Exception as e:
            update_sync_status(online_connected=False)
            cfg = load_config()
            devices = cfg.get("devices", [])
            has_online = check_api_source_enabled("online")
            if has_online:
                logger.warning(f"Online WebSocket connection failed or lost: {e}. Retrying in 5s...")
                await asyncio.sleep(5)
            else:
                await asyncio.sleep(2)

async def autodarts_logger():
    global _queued_status, _current_player
    asyncio.create_task(token_refresher_loop())
    asyncio.create_task(online_board_websocket_loop())
    uri = "ws://localhost:3180/api/events"
    
    # Startup animation for all devices
    asyncio.create_task(play_startup_animation())

    while True:
        cfg = load_config()
        devices = cfg.get("devices", [])
        has_local = check_api_source_enabled("local")
        if not has_local:
            await asyncio.sleep(2)
            continue

        try:
            async with websockets.connect(uri) as websocket:
                logger.info(f"Connected to Autodarts at {uri}")
                update_sync_status(local_connected=True)
                while True:
                    cfg = load_config()
                    devices = cfg.get("devices", [])
                    has_local = check_api_source_enabled("local")
                    if not has_local:
                        logger.info("No local API devices configured. Closing WebSocket connection...")
                        break

                    try:
                        message = await asyncio.wait_for(websocket.recv(), timeout=2.0)
                        data = json.loads(message)
                        if data.get("type") == "state" and "status" in data.get("data", {}):
                            local_data = data["data"]
                            status = local_data["status"]
                            local_player = local_data.get("player", -1)
                            if isinstance(local_player, int) and local_player >= 0:
                                if local_player != _current_player:
                                    logger.info(f"Local match: Player {local_player + 1}'s turn")
                                _current_player = local_player
                            if time.time() < _effect_hold_until:
                                logger.info(f"Queueing local '{status}' — effect hold active")
                                _queued_status = (status, "local")
                            else:
                                await dispatch_status(status, "local")
                        
                        # Flush queue if hold has expired
                        if _queued_status is not None and time.time() >= _effect_hold_until:
                            queued, source = _queued_status
                            _queued_status = None
                            logger.info(f"Playing queued effect: '{queued}' for {source}")
                            await dispatch_status(queued, source)
                    except asyncio.TimeoutError:
                        if _queued_status is not None and time.time() >= _effect_hold_until:
                            queued, source = _queued_status
                            _queued_status = None
                            logger.info(f"Playing queued effect (timeout flush): '{queued}' for {source}")
                            await dispatch_status(queued, source)
                        continue
        except Exception as e:
            update_sync_status(local_connected=False)
            cfg = load_config()
            devices = cfg.get("devices", [])
            has_local = check_api_source_enabled("local")
            if has_local:
                logger.warning(f"WebSocket connection failed: {e}. Retrying in 5s...")
                await asyncio.sleep(5)
            else:
                await asyncio.sleep(2)

if __name__ == "__main__":
    try:
        asyncio.run(autodarts_logger())
    except KeyboardInterrupt:
        for port, ser in list(serial_connections.items()):
            if ser and ser.is_open:
                try:
                    ser.close()
                except Exception:
                    pass
        logger.info("Script terminated by user.")
    except Exception as e:
        logger.critical(f"Unexpected error: {e}")
