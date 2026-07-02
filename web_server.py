import sys
import os

if not getattr(sys, 'frozen', False):
    PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
    venv_site = os.path.join(PROJECT_DIR, "venv", "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")
    if os.path.exists(venv_site):
        sys.path.insert(0, venv_site)

import json
import argparse
from http.server import HTTPServer, SimpleHTTPRequestHandler
import serial
import serial.tools.list_ports
import time
import re
import urllib.parse
import urllib.request
import base64
import shutil

if getattr(sys, 'frozen', False):
    BASE_DIR = os.path.dirname(sys.executable)
    WEB_DIR = os.path.join(sys._MEIPASS, "web")
    BUNDLE_PROFILES_DIR = os.path.join(sys._MEIPASS, "profiles")
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    WEB_DIR = os.path.join(BASE_DIR, "web")
    BUNDLE_PROFILES_DIR = os.path.join(BASE_DIR, "profiles")

PROJECT_DIR = BASE_DIR
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
PROFILES_DIR = os.path.join(BASE_DIR, "profiles")

def login_to_autodarts(email, password):
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
        return json.loads(response.read().decode('utf-8'))

def refresh_autodarts_token(refresh_token):
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
        return json.loads(response.read().decode('utf-8'))

def decode_jwt_payload(token):
    try:
        parts = token.split('.')
        if len(parts) == 3:
            payload_b64 = parts[1]
            payload_b64 += '=' * (-len(payload_b64) % 4)
            payload_data = base64.urlsafe_b64decode(payload_b64).decode('utf-8')
            return json.loads(payload_data)
    except Exception:
        pass
    return None


KNOWN_VID_PIDS = [(0x10C4, 0xEA60), (0x1A86, 0x7523), (0x0403, 0x6001), (0x303A, 0x1001)]

def get_available_ports():
    ports = serial.tools.list_ports.comports()
    results = []
    for port in ports:
        is_esp32 = (port.vid, port.pid) in KNOWN_VID_PIDS
        if is_esp32:
            results.append({
                "device": port.device,
                "description": port.description or "Unknown",
                "is_esp32": True
            })
    return results

def scan_improv_wifi(port):
    packet = bytearray(b'IMPROV')
    packet.extend([0x01, 0x03, 0x01, 0x04])
    packet.append(sum(packet) & 0xFF)
    
    networks = []
    try:
        with serial.Serial(port, 115200, timeout=1) as ser:
            time.sleep(2.0)
            ser.reset_input_buffer()
            ser.write(packet)
            ser.flush()
            
            start_time = time.time()
            while time.time() - start_time < 8:
                if ser.in_waiting >= 9:
                    resp = ser.read(ser.in_waiting)
                    idx = 0
                    while True:
                        idx = resp.find(b'IMPROV', idx)
                        if idx == -1 or len(resp) < idx + 9:
                            break
                        msg_type = resp[idx + 7]
                        length = resp[idx + 8]
                        if len(resp) < idx + 9 + length + 1:
                            break
                        data = resp[idx + 9 : idx + 9 + length]
                        checksum = resp[idx + 9 + length]
                        
                        expected_checksum = sum(resp[idx : idx + 9 + length]) & 0xFF
                        if checksum != expected_checksum:
                            idx += 1
                            continue
                            
                        if msg_type == 0x04:
                            cmd_id = data[0]
                            if cmd_id == 0x04:
                                if len(data) >= 2 and data[1] == 0:
                                    return networks
                                else:
                                    str_idx = 2
                                    while str_idx < len(data):
                                        try:
                                            # Parse SSID
                                            ssid_len = data[str_idx]
                                            ssid = data[str_idx+1 : str_idx+1+ssid_len].decode('utf-8')
                                            str_idx += 1 + ssid_len
                                            
                                            # Parse RSSI
                                            rssi_len = data[str_idx]
                                            rssi = data[str_idx+1 : str_idx+1+rssi_len].decode('utf-8')
                                            str_idx += 1 + rssi_len
                                            
                                            # Parse Auth
                                            auth_len = data[str_idx]
                                            auth = data[str_idx+1 : str_idx+1+auth_len].decode('utf-8')
                                            str_idx += 1 + auth_len
                                            
                                            networks.append({
                                                "ssid": ssid,
                                                "rssi": int(rssi) if rssi.replace('-','').isdigit() else 0,
                                                "auth": auth == "YES" or auth == "1" or auth.lower() == "true"
                                            })
                                        except Exception:
                                            break
                        idx += 9 + length + 1
                time.sleep(0.2)
    except Exception as e:
        print(f"Serial scan exception on {port}: {e}")
    return networks

def provision_wled_wifi(port, ssid, password):
    ssid_bytes = ssid.encode('utf-8')
    pwd_bytes = password.encode('utf-8')
    
    sub_payload = bytearray([len(ssid_bytes)])
    sub_payload.extend(ssid_bytes)
    sub_payload.append(len(pwd_bytes))
    sub_payload.extend(pwd_bytes)
    
    data = bytearray([0x01, len(sub_payload)])
    data.extend(sub_payload)
    
    packet = bytearray(b'IMPROV')
    packet.extend([0x01, 0x03, len(data)])
    packet.extend(data)
    packet.append(sum(packet) & 0xFF)
    
    result = {"status": "timeout", "message": "Provisioning timed out"}
    try:
        with serial.Serial(port, 115200, timeout=1) as ser:
            time.sleep(2.0)
            ser.reset_input_buffer()
            ser.write(packet)
            ser.flush()
            
            start_time = time.time()
            state_provisioned = False
            ip_address = ""
            while time.time() - start_time < 20:
                if ser.in_waiting > 0:
                    resp = ser.read(ser.in_waiting)
                    
                    # Parse Improv packets
                    idx = 0
                    while True:
                        idx = resp.find(b'IMPROV', idx)
                        if idx == -1 or len(resp) < idx + 9:
                            break
                        msg_type = resp[idx + 7]
                        length = resp[idx + 8]
                        if len(resp) < idx + 9 + length + 1:
                            break
                        data_payload = resp[idx + 9 : idx + 9 + length]
                        checksum = resp[idx + 9 + length]
                        expected_checksum = sum(resp[idx : idx + 9 + length]) & 0xFF
                        if checksum == expected_checksum:
                            if msg_type == 0x01:
                                state = data_payload[0]
                                if state == 0x04:
                                    state_provisioned = True
                            elif msg_type == 0x02:
                                return {"status": "error", "message": f"Device error: {data_payload[0]}"}
                        idx += 9 + length + 1
                    
                    # Parse lines for IP address
                    try:
                        line = resp.decode('utf-8', errors='ignore')
                        ips = re.findall(r'\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}', line)
                        for ip in ips:
                            if ip not in ("0.0.0.0", "255.255.255.255"):
                                ip_address = ip
                                break
                    except Exception:
                        pass
                        
                    # If we got both the provisioned state and a valid IP, we can finish early
                    if state_provisioned and ip_address:
                        break
                time.sleep(0.2)
                
            if state_provisioned or ip_address:
                result = {"status": "success", "ip": ip_address}
    except Exception as e:
        result = {"status": "error", "message": str(e)}
        
    return result

def init_config():
    ws281x_dir = os.path.join(PROFILES_DIR, "ws281x")
    pwm_white_dir = os.path.join(PROFILES_DIR, "pwm-white")
    os.makedirs(ws281x_dir, exist_ok=True)
    os.makedirs(pwm_white_dir, exist_ok=True)
    
    # 1. Migrate any existing json files in the root profiles directory to profiles/ws281x/
    if os.path.exists(PROFILES_DIR):
        for f_name in os.listdir(PROFILES_DIR):
            p_path = os.path.join(PROFILES_DIR, f_name)
            if os.path.isfile(p_path) and f_name.endswith(".json"):
                dest_p = os.path.join(ws281x_dir, f_name)
                try:
                    shutil.move(p_path, dest_p)
                except Exception:
                    pass

    # Copy default profiles from bundle if missing (migrate to ws281x)
    if os.path.exists(BUNDLE_PROFILES_DIR):
        for f_name in os.listdir(BUNDLE_PROFILES_DIR):
            if f_name.endswith(".json"):
                dest_p = os.path.join(ws281x_dir, f_name)
                if not os.path.exists(dest_p):
                    try:
                        shutil.copy2(os.path.join(BUNDLE_PROFILES_DIR, f_name), dest_p)
                    except Exception:
                        pass
    
    if not os.path.exists(CONFIG_FILE):
        config = {}
    else:
        try:
            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
        except Exception:
            config = {}

    modified = False
    if "connection_type" not in config:
        config["connection_type"] = "serial"
        modified = True
    if "wled_crossfade" not in config:
        config["wled_crossfade"] = False
        modified = True
    if "wifi_ip" not in config:
        config["wifi_ip"] = ""
        modified = True
    if "devices" not in config:
        config["devices"] = []
        modified = True
    if "manual_port" not in config:
        config["manual_port"] = ""
        modified = True
    if "global_brightness" not in config:
        config["global_brightness"] = 255
        modified = True
    if "current_profile" not in config:
        config["current_profile"] = "Default"
        modified = True

    # 2. Migrate inline profiles in config.json to separate files in ws281x
    if "profiles" in config:
        if isinstance(config["profiles"], dict):
            for p_name, p_data in config["profiles"].items():
                safe_name = "".join(c for c in p_name if c.isalnum() or c in (" ", "_", "-")).strip()
                if safe_name:
                    p_path = os.path.join(ws281x_dir, f"{safe_name}.json")
                    with open(p_path, "w") as pf:
                        json.dump(p_data, pf, indent=4)
        config.pop("profiles")
        modified = True

    # 3. Migrate any existing root-level state configs to Default.json in ws281x
    DARTBOARD_STATES = ["Throw", "Takeout in progress", "Takeout", "Starting", "Stopped", "Calibrating", "Error"]
    root_states = {}
    for state in DARTBOARD_STATES:
        if state in config and isinstance(config[state], dict):
            root_states[state] = config.pop(state)
            modified = True

    if root_states:
        default_path = os.path.join(ws281x_dir, "Default.json")
        default_data = {}
        if os.path.exists(default_path):
            try:
                with open(default_path, "r") as df:
                    default_data = json.load(df)
            except Exception:
                pass
        for s_name, s_val in root_states.items():
            default_data[s_name] = s_val
        with open(default_path, "w") as df:
            json.dump(default_data, df, indent=4)

    # 4. Ensure Default.json exists in ws281x
    default_path = os.path.join(ws281x_dir, "Default.json")
    if not os.path.exists(default_path) or os.path.getsize(default_path) == 0:
        default_states = {
            "Throw": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[0, 255, 0]]}, "enabled": True},
            "Takeout in progress": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[255, 0, 0]]}, "enabled": True},
            "Takeout": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[255, 255, 0]]}, "enabled": True},
            "Starting": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[0, 0, 255]]}, "enabled": True},
            "Stopped": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[255, 0, 255]]}, "enabled": True},
            "Calibrating": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 0, "col": [[128, 0, 128]]}, "enabled": True},
            "Error": {"on": True, "bri": 255, "tt": 0, "seg": {"fx": 1, "col": [[255, 0, 0]]}, "enabled": True}
        }
        with open(default_path, "w") as df:
            json.dump(default_states, df, indent=4)

    # 5. Ensure Default.json exists in pwm-white
    pwm_default_path = os.path.join(pwm_white_dir, "Default.json")
    if not os.path.exists(pwm_default_path) or os.path.getsize(pwm_default_path) == 0:
        pwm_default_states = {
            "Throw": {"on": True, "bri": 255, "tt": 0, "seg": {"col": [[255, 255, 255, 255]]}, "enabled": True},
            "Takeout in progress": {"on": True, "bri": 255, "tt": 0, "seg": {"col": [[0, 0, 0, 0]]}, "enabled": True},
            "Takeout": {"on": True, "bri": 255, "tt": 0, "seg": {"col": [[0, 0, 0, 0]]}, "enabled": True},
            "Starting": {"on": True, "bri": 255, "tt": 0, "seg": {"col": [[255, 255, 255, 255]]}, "enabled": True},
            "Stopped": {"on": True, "bri": 255, "tt": 0, "seg": {"col": [[255, 255, 255, 255]]}, "enabled": True},
            "Calibrating": {"on": True, "bri": 255, "tt": 0, "seg": {"col": [[255, 255, 255, 255]]}, "enabled": True},
            "Error": {"on": True, "bri": 255, "tt": 0, "seg": {"col": [[255, 255, 255, 255]]}, "enabled": True}
        }
        with open(pwm_default_path, "w") as df:
            json.dump(pwm_default_states, df, indent=4)

    if modified:
        with open(CONFIG_FILE, "w") as f:
            json.dump(config, f, indent=4)

def scan_all_subnets_for_wled():
    import subprocess
    import re
    import socket
    from concurrent.futures import ThreadPoolExecutor, as_completed

    ips = []
    
    # Try running `ip addr` (works on Linux)
    try:
        res = subprocess.run(["ip", "addr"], capture_output=True, text=True)
        found = re.findall(r'inet\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', res.stdout)
        ips.extend(found)
    except Exception:
        pass

    # Try socket.gethostbyname_ex
    try:
        hostname = socket.gethostname()
        ips.extend(socket.gethostbyname_ex(hostname)[2])
    except Exception:
        pass

    # Try socket.getaddrinfo
    try:
        hostname = socket.gethostname()
        for item in socket.getaddrinfo(hostname, None):
            if item[0] == socket.AF_INET:
                ips.append(item[4][0])
    except Exception:
        pass

    # Try UDP socket connection trick
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.254.254.254', 1))
        ips.append(s.getsockname()[0])
        s.close()
    except Exception:
        pass

    # Filter and deduplicate
    valid_ips = []
    for ip in ips:
        if not ip.startswith("127.") and not ip.startswith("169.254."):
            if ip not in valid_ips:
                valid_ips.append(ip)
    
    subnets = set()
    for ip in valid_ips:
        parts = ip.split('.')
        if len(parts) == 4:
            subnets.add('.'.join(parts[:3]) + '.')
            
    discovered_ips = []
    
    def check_ip(ip):
        try:
            url = f"http://{ip}/json"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=0.6) as response:
                data = json.loads(response.read().decode('utf-8'))
                if data.get('info', {}).get('brand') == 'WLED':
                    name = data.get('info', {}).get('name', 'WLED')
                    return {"ip": ip, "name": name}
        except Exception:
            pass
        return None
        
    ips_to_scan = []
    for subnet in subnets:
        for i in range(1, 255):
            ip_str = f"{subnet}{i}"
            if ip_str not in valid_ips:
                ips_to_scan.append(ip_str)
                
    with ThreadPoolExecutor(max_workers=80) as executor:
        futures = {executor.submit(check_ip, ip): ip for ip in ips_to_scan}
        for future in as_completed(futures):
            res = future.result()
            if res:
                discovered_ips.append(res)
                
    return discovered_ips

def find_wled_on_subnet(wifi_device):
    import subprocess
    import re
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import os
    import socket

    valid_ips = []
    try:
        res_ip = subprocess.run(["ip", "addr", "show", "dev", wifi_device], capture_output=True, text=True)
        ips = re.findall(r'inet\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', res_ip.stdout)
        valid_ips = [ip for ip in ips if not ip.startswith("127.") and not ip.startswith("169.254.")]
    except Exception:
        # Fallback to general socket methods on exception (e.g. Windows or missing ip command)
        try:
            hostname = socket.gethostname()
            for ip in socket.gethostbyname_ex(hostname)[2]:
                if not ip.startswith("127.") and not ip.startswith("169.254."):
                    valid_ips.append(ip)
        except Exception:
            pass

    if not valid_ips:
        return []
    
    local_ip = valid_ips[0]
    ip_parts = local_ip.split('.')
    if len(ip_parts) != 4:
        return []
    
    subnet_prefix = '.'.join(ip_parts[:3]) + '.'
    
    discovered_wleds = []
    
    def check_ip(ip):
        try:
            url = f"http://{ip}/json"
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=0.6) as response:
                data = json.loads(response.read().decode('utf-8'))
                if data.get('info', {}).get('brand') == 'WLED':
                    return ip
        except Exception:
            pass
        return None

    prev_ip = None
    existing_ips = set()
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r") as f:
                cfg = json.load(f)
                prev_ip = cfg.get("wifi_ip")
                for d in cfg.get("devices", []):
                    if d.get("connection_type") == "wifi" and d.get("ip"):
                        existing_ips.add(d.get("ip"))
    except Exception:
        pass

    ips_to_scan = [f"{subnet_prefix}{i}" for i in range(1, 255) if f"{subnet_prefix}{i}" != local_ip and f"{subnet_prefix}{i}" not in existing_ips]
        
    if prev_ip and prev_ip.startswith(subnet_prefix):
        if prev_ip in ips_to_scan:
            ips_to_scan.remove(prev_ip)
            ips_to_scan.insert(0, prev_ip)
        
    with ThreadPoolExecutor(max_workers=60) as executor:
        futures = {executor.submit(check_ip, ip): ip for ip in ips_to_scan}
        for future in as_completed(futures):
            res = future.result()
            if res:
                discovered_wleds.append(res)
                break
                
    return discovered_wleds

class AutoGlowHTTPRequestHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/config":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                
                # Dynamically load individual profiles from profiles/ws281x and profiles/pwm-white folders
                profiles = {"ws281x": {}, "pwm-white": {}}
                ws281x_dir = os.path.join(PROFILES_DIR, "ws281x")
                pwm_white_dir = os.path.join(PROFILES_DIR, "pwm-white")
                
                if os.path.exists(ws281x_dir):
                    for f_name in os.listdir(ws281x_dir):
                        if f_name.endswith(".json"):
                            p_path = os.path.join(ws281x_dir, f_name)
                            try:
                                with open(p_path, "r") as pf:
                                    profiles["ws281x"][f_name[:-5]] = json.load(pf)
                            except Exception:
                                pass
                if os.path.exists(pwm_white_dir):
                    for f_name in os.listdir(pwm_white_dir):
                        if f_name.endswith(".json"):
                            p_path = os.path.join(pwm_white_dir, f_name)
                            try:
                                with open(p_path, "r") as pf:
                                    profiles["pwm-white"][f_name[:-5]] = json.load(pf)
                            except Exception:
                                pass
                config["profiles"] = profiles
                if "current_profile" not in config:
                    config["current_profile"] = "Default"
            except Exception as e:
                config = {"error": str(e)}
            self.wfile.write(json.dumps(config).encode("utf-8"))
        elif self.path == "/api/ports":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                ports = get_available_ports()
            except Exception as e:
                ports = [{"error": str(e)}]
            self.wfile.write(json.dumps(ports).encode("utf-8"))
        elif self.path == "/api/sync_status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            status_file = os.path.join(PROJECT_DIR, ".sync_status.json")
            status = {"local": False, "online": False}
            if os.path.exists(status_file):
                try:
                    with open(status_file, "r") as f:
                        status = json.load(f)
                except Exception:
                    pass
            self.wfile.write(json.dumps(status).encode("utf-8"))
        elif self.path == "/api/has_wifi":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                import subprocess
                res = subprocess.run(["nmcli", "-t", "-f", "TYPE", "device"], capture_output=True, text=True)
                types = [line.split(':')[0].strip().lower() if ':' in line else line.strip().lower() for line in res.stdout.split('\n') if line.strip()]
                has_wifi = "wifi" in types
            except Exception:
                has_wifi = False
            self.wfile.write(json.dumps({"has_wifi": has_wifi}).encode("utf-8"))
        elif self.path.startswith("/api/scan_wifi"):
            parsed_path = urllib.parse.urlparse(self.path)
            query_params = urllib.parse.parse_qs(parsed_path.query)
            port = query_params.get("port", [None])[0]
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            
            if not port:
                self.wfile.write(json.dumps({"error": "No port specified"}).encode("utf-8"))
                return
            try:
                networks = scan_improv_wifi(port)
                self.wfile.write(json.dumps(networks).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        elif self.path.startswith("/api/wled/config"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                parsed = urllib.parse.urlparse(self.path)
                params = urllib.parse.parse_qs(parsed.query)
                ip = params.get("ip", [None])[0]

                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                
                if not ip:
                    ip = config.get("wifi_ip")
                if not ip:
                    raise Exception("WLED IP is not configured")
                
                url = f"http://{ip}/json/cfg"
                with urllib.request.urlopen(url, timeout=4) as response:
                    wled_cfg = json.loads(response.read().decode('utf-8'))
                
                # Build mapping from GPIO pin to LED type from WLED live config
                pin_to_type = {}
                ins_list = wled_cfg.get("hw", {}).get("led", {}).get("ins", [])
                print(f"[DEBUG] Raw WLED LED inputs from http://{ip}/json/cfg: {ins_list}", flush=True)
                if ins_list and isinstance(ins_list, list):
                    for item in ins_list:
                        pin_list = item.get("pin", [])
                        if pin_list:
                            pin_to_type[int(pin_list[0])] = item.get("type", item.get("typ", 22))
                print(f"[DEBUG] Built pin_to_type mapping: {pin_to_type}", flush=True)

                active_device = None
                for dev in config.get("devices", []):
                    if dev.get("ip") == ip:
                        active_device = dev
                        break
                
                # If segments exist in active device DB, return them
                if active_device and "segments" in active_device:
                    segments = active_device["segments"]
                    # Enrich/Overwrite database segments with live WLED bus types based on active pins
                    for seg in segments:
                        pin_val = seg.get("pin")
                        if pin_val is not None:
                            try:
                                pin_int = int(pin_val)
                                if pin_int in pin_to_type:
                                    seg["type"] = pin_to_type[pin_int]
                            except (ValueError, TypeError):
                                pass
                else:
                    # Query current strips from WLED as fallback
                    ins = wled_cfg.get("hw", {}).get("led", {}).get("ins", [])
                    boot_on = wled_cfg.get("def", {}).get("on", True)
                    segments = []
                    if ins and isinstance(ins, list):
                        for idx, first in enumerate(ins):
                            pin_list = first.get("pin", [])
                            pin = pin_list[0] if pin_list else 16
                            length = first.get("len", 60)
                            typ = first.get("type", first.get("typ", 22))
                            segments.append({
                                "pin": pin,
                                "len": length,
                                "type": typ,
                                "boot_on": boot_on
                            })
                    if not segments:
                        segments.append({
                            "pin": 16,
                            "len": 60,
                            "type": 22,
                            "boot_on": boot_on
                        })
                
                legacy_pin = segments[0]["pin"] if segments else 16
                legacy_len = segments[0]["len"] if segments else 60
                legacy_boot = segments[0]["boot_on"] if segments else True
                
                # Extract crossfade and other settings to return to the UI settings modal
                wled_crossfade = wled_cfg.get("light", {}).get("tr", {}).get("mode", True)
                global_brightness = config.get("global_brightness", 255)
                autodarts_online_enabled = config.get("autodarts_online_enabled", False)

                self.wfile.write(json.dumps({
                    "status": "success",
                    "pin": legacy_pin,
                    "len": legacy_len,
                    "boot_on": legacy_boot,
                    "segments": segments,
                    "wled_crossfade": wled_crossfade,
                    "global_brightness": global_brightness,
                    "autodarts_online_enabled": autodarts_online_enabled
                }).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/wled/scan_network":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                results = scan_all_subnets_for_wled()
                self.wfile.write(json.dumps(results).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        elif self.path.startswith("/api/wled/validate_ip"):
            parsed_path = urllib.parse.urlparse(self.path)
            query_params = urllib.parse.parse_qs(parsed_path.query)
            ip = query_params.get("ip", [None])[0]
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            
            if not ip:
                self.wfile.write(json.dumps({"status": "error", "message": "Missing IP parameter"}).encode("utf-8"))
                return
                
            try:
                url = f"http://{ip}/json"
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=1.5) as response:
                    data = json.loads(response.read().decode('utf-8'))
                    if data.get('info', {}).get('brand') == 'WLED':
                        self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
                        return
                raise Exception("Not a WLED device")
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/setup/scan":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            
            from concurrent.futures import ThreadPoolExecutor
            import subprocess
            
            def scan_serial():
                try:
                    ports = get_available_ports()
                    return [p for p in ports if p.get("is_esp32")]
                except Exception as e:
                    return {"error": str(e)}
                    
            def scan_network():
                try:
                    return scan_all_subnets_for_wled()
                except Exception as e:
                    return {"error": str(e)}
                    
            def scan_wifi_ap():
                try:
                    subprocess.run(["nmcli", "dev", "wifi", "rescan"], capture_output=True)
                    time.sleep(1.0)
                    res_scan = subprocess.run(["nmcli", "-t", "-f", "SSID", "dev", "wifi"], capture_output=True, text=True)
                    ssids = [line.strip() for line in res_scan.stdout.split('\n') if line.strip()]
                    matching_ap = []
                    for s in ssids:
                        if "wled-ap" in s.lower():
                            matching_ap.append(s)
                    return list(set(matching_ap))
                except Exception as e:
                    return {"error": str(e)}
                    
            with ThreadPoolExecutor(max_workers=3) as executor:
                f_serial = executor.submit(scan_serial)
                f_network = executor.submit(scan_network)
                f_wifi = executor.submit(scan_wifi_ap)
                
                serial_ports = f_serial.result()
                network_devices = f_network.result()
                wifi_aps = f_wifi.result()
                
            response_data = {
                "serial": {
                    "found": bool(serial_ports) and not isinstance(serial_ports, dict),
                    "devices": serial_ports if not isinstance(serial_ports, dict) else []
                },
                "network": {
                    "found": bool(network_devices) and not isinstance(network_devices, dict),
                    "devices": network_devices if not isinstance(network_devices, dict) else []
                },
                "wifi_ap": {
                    "found": bool(wifi_aps) and not isinstance(wifi_aps, dict),
                    "ssids": wifi_aps if not isinstance(wifi_aps, dict) else []
                }
            }
            self.wfile.write(json.dumps(response_data).encode("utf-8"))
        elif self.path == "/api/auth/autodarts":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                
                access_token = config.get("autodarts_access_token")
                refresh_token = config.get("autodarts_refresh_token")
                email = config.get("autodarts_email")
                
                if not access_token or not refresh_token:
                    self.wfile.write(json.dumps({"connected": False}).encode("utf-8"))
                    return
                
                # Check if expired or near expiration (within 60 seconds)
                expires_at = config.get("autodarts_token_expires_at", 0)
                expired = time.time() >= (expires_at - 60)
                
                if expired:
                    # Attempt refresh
                    try:
                        res = refresh_autodarts_token(refresh_token)
                        new_access_token = res.get("access_token")
                        new_refresh_token = res.get("refresh_token")
                        expires_in = res.get("expires_in", 900)
                        if new_access_token and new_refresh_token:
                            access_token = new_access_token
                            refresh_token = new_refresh_token
                            config["autodarts_access_token"] = access_token
                            config["autodarts_refresh_token"] = refresh_token
                            expires_at = time.time() + expires_in
                            config["autodarts_token_expires_at"] = expires_at
                            with open(CONFIG_FILE, "w") as f:
                                json.dump(config, f, indent=4)
                            expired = False
                    except Exception:
                        # Fallback to email/password if refresh fails
                        password = config.get("autodarts_password")
                        if email and password:
                            try:
                                res = login_to_autodarts(email, password)
                                new_access_token = res.get("access_token")
                                new_refresh_token = res.get("refresh_token")
                                expires_in = res.get("expires_in", 900)
                                if new_access_token and new_refresh_token:
                                    access_token = new_access_token
                                    refresh_token = new_refresh_token
                                    config["autodarts_access_token"] = access_token
                                    config["autodarts_refresh_token"] = refresh_token
                                    expires_at = time.time() + expires_in
                                    config["autodarts_token_expires_at"] = expires_at
                                    with open(CONFIG_FILE, "w") as f:
                                        json.dump(config, f, indent=4)
                                    expired = False
                            except Exception:
                                pass
                
                payload = decode_jwt_payload(access_token)
                if not payload:
                    self.wfile.write(json.dumps({"connected": False}).encode("utf-8"))
                    return
                
                username = payload.get("preferred_username", email)
                name = payload.get("name", username)
                expired = time.time() >= expires_at
                
                self.wfile.write(json.dumps({
                    "connected": True,
                    "email": email,
                    "username": username,
                    "name": name,
                    "expired": expired
                }).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"connected": False, "error": str(e)}).encode("utf-8"))
        elif self.path in ('/menu', '/profile', '/devices', '/devices/scan') or self.path.startswith('/menu/') or self.path.startswith('/settings/'):
            # SPA routes: serve index.html and let the JS handle routing
            index_path = os.path.join(WEB_DIR, 'index.html')
            with open(index_path, 'rb') as f:
                content = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/api/devices":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                self.wfile.write(json.dumps(config.get("devices", [])).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        elif self.path == "/api/devices/scan":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.end_headers()
            try:
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                existing_ips = {d.get("ip") for d in config.get("devices", [])}
                results = scan_all_subnets_for_wled()
                # Filter out already-added devices
                new_devices = [r for r in results if r.get("ip") not in existing_ips]
                self.wfile.write(json.dumps(new_devices).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
        else:
            super().do_GET()


    def do_POST(self):
        if self.path == "/api/devices":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                req_data = json.loads(post_data.decode("utf-8"))
                name = req_data.get("name", "").strip()
                ip = req_data.get("ip", "").strip()
                connection_type = req_data.get("connection_type", "wifi")
                api_type = req_data.get("api_type", "local")
                if not ip and connection_type == "wifi":
                    self.wfile.write(json.dumps({"status": "error", "message": "IP address is required for WiFi devices"}).encode("utf-8"))
                    return
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                devices = config.get("devices", [])
                
                if not name or name in ["WLED Device", "ESP32 Controller", "New Device"]:
                    existing_names = [d.get("name", "") for d in devices]
                    nums = []
                    for n in existing_names:
                        m = re.match(r"^New Device (\d+)$", n)
                        if m:
                            nums.append(int(m.group(1)))
                    next_num = max(nums) + 1 if nums else 1
                    name = f"New Device {next_num}"
                    
                existing_device = None
                for d in devices:
                    if d.get("connection_type") == connection_type and d.get("ip") == ip:
                        existing_device = d
                        break

                if existing_device:
                    self.wfile.write(json.dumps({"status": "success", "device": existing_device, "message": "Device already exists"}).encode("utf-8"))
                    return

                new_id = str(int(time.time() * 1000))
                new_device = {
                    "id": new_id,
                    "name": name,
                    "ip": ip,
                    "connection_type": connection_type,
                    "api_type": api_type
                }
                devices.append(new_device)
                config["devices"] = devices
                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)
                self.wfile.write(json.dumps({"status": "success", "device": new_device}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
            return
        elif self.path == "/api/auth/autodarts":

            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            try:
                req_data = json.loads(post_data.decode("utf-8"))
                email = req_data.get("email")
                password = req_data.get("password")
                
                if not email or not password:
                    self.wfile.write(json.dumps({"status": "error", "message": "Missing email or password"}).encode("utf-8"))
                    return
                
                res = login_to_autodarts(email, password)
                access_token = res.get("access_token")
                refresh_token = res.get("refresh_token")
                expires_in = res.get("expires_in", 900)
                
                if not access_token or not refresh_token:
                    self.wfile.write(json.dumps({"status": "error", "message": "Failed to obtain tokens"}).encode("utf-8"))
                    return
                
                # Save to config.json
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                
                config["autodarts_email"] = email
                config["autodarts_password"] = password
                config["autodarts_access_token"] = access_token
                config["autodarts_refresh_token"] = refresh_token
                config["autodarts_token_expires_at"] = time.time() + expires_in
                config["autodarts_online_enabled"] = True
                
                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)
                    
                payload = decode_jwt_payload(access_token)
                username = payload.get("preferred_username", email) if payload else email
                name = payload.get("name", username) if payload else username
                
                self.wfile.write(json.dumps({
                    "status": "success",
                    "username": username,
                    "name": name,
                    "email": email
                }).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/auth/autodarts/disconnect":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            try:
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                
                # Remove keys
                config.pop("autodarts_email", None)
                config.pop("autodarts_password", None)
                config.pop("autodarts_access_token", None)
                config.pop("autodarts_refresh_token", None)
                config.pop("autodarts_token_expires_at", None)
                config["autodarts_online_enabled"] = False
                
                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)
                
                self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/config/reset":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                default_config = {
                    "connection_type": "serial",
                    "wifi_ip": "",
                    "manual_port": "",
                    "global_brightness": 255,
                    "profiles": {
                        "Default": {}
                    },
                    "current_profile": "Default",
                    "autodarts_websocket_enabled": True
                }
                with open(CONFIG_FILE, "w") as f:
                    json.dump(default_config, f, indent=4)
                self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/config":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            try:
                new_data = json.loads(post_data.decode("utf-8"))
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}

                # Save global keys
                allowed_keys = ["connection_type", "wifi_ip", "manual_port", "global_brightness", "current_profile", "wled_crossfade", "autodarts_websocket_enabled", "autodarts_online_enabled"]
                for key in allowed_keys:
                    if key in new_data:
                        config[key] = new_data[key]

                # Make sure profiles are not saved inside config.json
                config.pop("profiles", None)

                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)

                # Save profiles to separate JSON files
                if "profiles" in new_data and isinstance(new_data["profiles"], dict):
                    ws281x_dir = os.path.join(PROFILES_DIR, "ws281x")
                    pwm_white_dir = os.path.join(PROFILES_DIR, "pwm-white")
                    os.makedirs(ws281x_dir, exist_ok=True)
                    os.makedirs(pwm_white_dir, exist_ok=True)
                    
                    # 1. Save or overwrite all profiles sent in payload
                    payload_ws281x = []
                    payload_pwm_white = []
                    
                    ws_profiles = new_data["profiles"].get("ws281x", {})
                    for p_name, p_data in ws_profiles.items():
                        safe_name = "".join(c for c in p_name if c.isalnum() or c in (" ", "_", "-")).strip()
                        if safe_name:
                            payload_ws281x.append(safe_name)
                            p_path = os.path.join(ws281x_dir, f"{safe_name}.json")
                            with open(p_path, "w") as pf:
                                json.dump(p_data, pf, indent=4)
                                
                    pwm_profiles = new_data["profiles"].get("pwm-white", {})
                    for p_name, p_data in pwm_profiles.items():
                        safe_name = "".join(c for c in p_name if c.isalnum() or c in (" ", "_", "-")).strip()
                        if safe_name:
                            payload_pwm_white.append(safe_name)
                            p_path = os.path.join(pwm_white_dir, f"{safe_name}.json")
                            with open(p_path, "w") as pf:
                                json.dump(p_data, pf, indent=4)
                    
                    # 2. Delete any .json files in subdirectories not present in payload (deleted by user)
                    if os.path.exists(ws281x_dir):
                        for f_name in os.listdir(ws281x_dir):
                            if f_name.endswith(".json"):
                                base_name = f_name[:-5]
                                if base_name not in payload_ws281x:
                                    try:
                                        os.remove(os.path.join(ws281x_dir, f_name))
                                    except Exception:
                                        pass
                    if os.path.exists(pwm_white_dir):
                        for f_name in os.listdir(pwm_white_dir):
                            if f_name.endswith(".json"):
                                base_name = f_name[:-5]
                                if base_name not in payload_pwm_white:
                                    try:
                                        os.remove(os.path.join(pwm_white_dir, f_name))
                                    except Exception:
                                        pass

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.send_response(400)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/provision_wifi":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            try:
                req_data = json.loads(post_data.decode("utf-8"))
                port = req_data.get("port")
                ssid = req_data.get("ssid")
                password = req_data.get("password")
                
                if not port or not ssid:
                    self.wfile.write(json.dumps({"status": "error", "message": "Missing port or SSID"}).encode("utf-8"))
                    return
                    
                result = provision_wled_wifi(port, ssid, password)
                self.wfile.write(json.dumps(result).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/test_effect":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            try:
                req_data = json.loads(post_data.decode("utf-8"))
                fx_id = req_data.get("fx", 0)
                rgb = req_data.get("col", [255, 255, 255])
                brightness = req_data.get("bri", 255)
                seg_id = req_data.get("seg_id", 0)
                if seg_id is None:
                    seg_id = 0
                
                wled_cmd = {
                    "on": True,
                    "bri": brightness,
                    "seg": [{"id": int(seg_id), "fx": fx_id, "col": [rgb]}]
                }
                
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                
                conn_type = req_data.get("connection_type") or config.get("connection_type", "serial")
                
                if conn_type == "serial":
                    port = req_data.get("manual_port") or config.get("manual_port")
                    if not port:
                        ports = serial.tools.list_ports.comports()
                        for p in ports:
                            if (p.vid, p.pid) in KNOWN_VID_PIDS:
                                port = p.device
                                break
                    if not port:
                        self.wfile.write(json.dumps({"status": "error", "message": "No serial port found"}).encode("utf-8"))
                        return
                    with serial.Serial(port, 115200, timeout=1) as ser:
                        time.sleep(1.5)
                        ser.write((json.dumps(wled_cmd) + '\n').encode())
                    self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
                else:
                    ip = req_data.get("wifi_ip") or config.get("wifi_ip")
                    if not ip:
                        self.wfile.write(json.dumps({"status": "error", "message": "No WLED IP configured"}).encode("utf-8"))
                        return
                    url = f"http://{ip}/json/state"
                    req = urllib.request.Request(
                        url,
                        data=json.dumps(wled_cmd).encode('utf-8'),
                        headers={'Content-Type': 'application/json'},
                        method='POST'
                    )
                    with urllib.request.urlopen(req, timeout=3) as response:
                        response.read()
                    self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        elif self.path == "/api/wled/config":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)
            
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            
            try:
                req_data = json.loads(post_data.decode("utf-8"))
                segments = req_data.get("segments")  # list of dicts: [{"pin": 16, "len": 60, "role": "...", "boot_on": True}]
                crossfade = req_data.get("crossfade")  # optional, may be None

                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}

                ip = req_data.get("ip")
                if not ip:
                    ip = config.get("wifi_ip")
                if not ip:
                    raise Exception("WLED IP is not configured")

                # Fallback to single parameters if segments list not provided
                if segments is None:
                    new_pin = req_data.get("pin")
                    new_len = req_data.get("len")
                    boot_on = req_data.get("boot_on")
                    if new_pin is not None and new_len is not None:
                        segments = [{
                            "pin": int(new_pin),
                            "len": int(new_len),
                            "role": "Dartboard Surround",
                            "boot_on": bool(boot_on) if boot_on is not None else True
                        }]
                    else:
                        # Try to load segments from config.json for this device
                        for dev in config.get("devices", []):
                            if dev.get("ip") == ip:
                                segments = dev.get("segments")
                                break
                        if not segments:
                            raise Exception("Missing pin, len or segments parameters")
                        
                        # Update boot_on status if specified in the payload
                        boot_on = req_data.get("boot_on")
                        if boot_on is not None and segments:
                            for s in segments:
                                s["boot_on"] = bool(boot_on)

                # 1. Update the segments array inside the matching device entry in config.json
                for dev in config.get("devices", []):
                    if dev.get("ip") == ip:
                        dev["segments"] = segments
                        break
                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)

                # 2. Get WLED current configuration
                cfg_url = f"http://{ip}/json/cfg"
                with urllib.request.urlopen(cfg_url, timeout=5) as response:
                    wled_cfg = json.loads(response.read().decode('utf-8'))

                # 3. Compile unique pins, total lengths, and types in order of occurrence
                unique_pins = []
                pin_totals = {}
                pin_types = {}
                for seg in segments:
                    p = int(seg["pin"])
                    l = int(seg["len"])
                    t = int(seg.get("type", 22))
                    if p not in pin_totals:
                        unique_pins.append(p)
                        pin_totals[p] = 0
                    pin_totals[p] += l
                    pin_types[p] = t

                # 4. Reconstruct WLED hardware led inputs (ins)
                new_ins = []
                start_offset = 0
                old_ins = wled_cfg.get("hw", {}).get("led", {}).get("ins", [])
                for p in unique_pins:
                    total_l = pin_totals[p]
                    typ_val = pin_types.get(p, 22)
                    
                    # Find existing entry for this pin to preserve other fields
                    existing_entry = None
                    for entry in old_ins:
                        if entry.get("pin") == [p] or p in entry.get("pin", []):
                            existing_entry = entry.copy()
                            break
                            
                    if existing_entry:
                        existing_entry["start"] = start_offset
                        existing_entry["len"] = total_l
                        existing_entry["type"] = typ_val
                        if "typ" in existing_entry:
                            existing_entry["typ"] = typ_val
                        if typ_val == 41:
                            existing_entry["freq"] = 9765
                        ins_entry = existing_entry
                    else:
                        ins_entry = {
                            "start": start_offset,
                            "len": total_l,
                            "pin": [p],
                            "order": 1,
                            "rev": False,
                            "skip": 0,
                            "type": typ_val,
                            "typ": typ_val,
                            "ref": False,
                            "rgbwm": 0,
                            "freq": 9765 if typ_val == 41 else 0,
                            "maxpwr": 0,
                            "ledma": 0
                        }
                    new_ins.append(ins_entry)
                    start_offset += total_l

                if "hw" not in wled_cfg:
                    wled_cfg["hw"] = {}
                if "led" not in wled_cfg["hw"]:
                    wled_cfg["hw"]["led"] = {}
                wled_cfg["hw"]["led"]["ins"] = new_ins
                wled_cfg["hw"]["led"]["total"] = start_offset

                # 5. Build runtime segment definitions for WLED State API
                state_segs = []
                current_offset = 0
                for idx, seg in enumerate(segments):
                    length = int(seg.get("len", 60))
                    
                    if seg.get("is_split"):
                        for sub_idx, sub in enumerate(seg.get("sub_segments", [])):
                            sub_start = int(sub.get("start", 0))
                            sub_stop = int(sub.get("stop", length))
                            state_segs.append({
                                "id": len(state_segs),
                                "start": current_offset + sub_start,
                                "stop": current_offset + sub_stop,
                                "on": bool(sub.get("boot_on", True)),
                                "bri": 255
                            })
                    else:
                        typ_val = int(seg.get("type", 22))
                        seg_data = {
                            "id": len(state_segs),
                            "start": current_offset,
                            "stop": current_offset + length,
                            "on": bool(seg.get("boot_on", True)),
                            "bri": 255
                        }
                        if typ_val == 41:
                            seg_data["col"] = [[255, 255, 255, 255]]
                        state_segs.append(seg_data)
                    current_offset += length

                # 6. Apply crossfade (Crossfade checkbox = light.tr.mode) in the SAME round-trip
                # so it is saved to flash before the reboot wipes any separate call
                if crossfade is not None:
                    if "light" not in wled_cfg:
                        wled_cfg["light"] = {}
                    if "tr" not in wled_cfg["light"]:
                        wled_cfg["light"]["tr"] = {}
                    wled_cfg["light"]["tr"]["mode"] = bool(crossfade)

                # 7. Apply boot defaults (default preset 1, boot on status)
                if "def" not in wled_cfg:
                    wled_cfg["def"] = {}
                wled_cfg["def"]["ps"] = 1  # Boot into Preset 1 containing our segment definitions
                if segments:
                    boot_on_val = bool(segments[0].get("boot_on", True))
                    wled_cfg["def"]["on"] = boot_on_val
                
                # 8. Post WLED configuration first
                req = urllib.request.Request(
                    cfg_url,
                    data=json.dumps(wled_cfg).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=5) as response:
                    response.read()
                
                # 9. Reboot WLED Controller immediately to apply hardware layout limits
                state_url = f"http://{ip}/json/state"
                req_rb = urllib.request.Request(
                    state_url,
                    data=json.dumps({"rb": True}).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                try:
                    with urllib.request.urlopen(req_rb, timeout=5) as response:
                        response.read()
                except Exception:
                    pass  # WLED may disconnect immediately during reboot command
                
                # 10. Wait for WLED Controller to boot up and come back online (up to 12 seconds)
                time.sleep(2.0)
                wled_online = False
                current_wled_segs = []
                for _ in range(20):
                    try:
                        # Query the base JSON API to check if online
                        with urllib.request.urlopen(f"http://{ip}/json", timeout=1.0) as resp:
                            if resp.status == 200:
                                wled_online = True
                                wled_json = json.loads(resp.read().decode('utf-8'))
                                current_wled_segs = wled_json.get("state", {}).get("seg", [])
                                break
                    except Exception:
                        pass
                    time.sleep(0.5)
                
                if not wled_online:
                    raise Exception("WLED Controller failed to come back online after rebooting.")
                
                # 11. Save current segments configuration as Preset 1 via WLED State API
                final_segs = list(state_segs)
                for idx in range(len(state_segs), len(current_wled_segs)):
                    final_segs.append({
                        "id": idx,
                        "start": 0,
                        "stop": 0,
                        "on": False
                    })

                preset_payload = {
                    "psave": 1,
                    "n": "AutoGlow Default",
                    "ib": True,
                    "sb": True,
                    "seg": final_segs
                }
                req_preset = urllib.request.Request(
                    state_url,
                    data=json.dumps(preset_payload).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req_preset, timeout=5) as response:
                    response.read()
                
                # 12. Apply the newly created Preset 1 active state
                req_apply = urllib.request.Request(
                    state_url,
                    data=json.dumps({"ps": 1}).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req_apply, timeout=5) as response:
                    response.read()
                
                self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))

        elif self.path == "/api/wled/set_transition":
            content_length = int(self.headers.get("Content-Length", 0))
            post_data = self.rfile.read(content_length)

            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()

            try:
                req_data = json.loads(post_data.decode("utf-8"))
                enabled = req_data.get("enabled", True)

                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}

                ip = config.get("wifi_ip")
                if not ip:
                    raise Exception("WLED IP is not configured (WiFi mode required)")

                cfg_url = f"http://{ip}/json/cfg"

                # Step 1: GET the full current cfg from WLED (same as LED pin/count logic)
                with urllib.request.urlopen(cfg_url, timeout=5) as response:
                    wled_cfg = json.loads(response.read().decode('utf-8'))

                # Step 2: Modify light.tr.mode (the Crossfade checkbox) in the full cfg
                if "light" not in wled_cfg:
                    wled_cfg["light"] = {}
                if "tr" not in wled_cfg["light"]:
                    wled_cfg["light"]["tr"] = {}
                wled_cfg["light"]["tr"]["mode"] = bool(enabled)

                # Step 3: POST the entire modified cfg back so WLED saves it to flash
                req = urllib.request.Request(
                    cfg_url,
                    data=json.dumps(wled_cfg).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=5) as response:
                    response.read()

                self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))

        elif self.path == "/api/wled/auto_provision":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            
            def log(msg):
                try:
                    self.wfile.write(f"{msg}\n".encode("utf-8"))
                    self.wfile.flush()
                except Exception:
                    pass

            import sys
            if sys.platform == "win32":
                log("❌ Error: Auto-provisioning is not supported on Windows. Please configure your WLED device manually or via the WLED web AP.")
                return

            import subprocess
            
            log("🔍 Scanning for WLED-AP hotspot...")
            subprocess.run(["nmcli", "dev", "wifi", "rescan"], capture_output=True)
            time.sleep(2.0)
            
            res_scan = subprocess.run(["nmcli", "-t", "-f", "SSID", "dev", "wifi"], capture_output=True, text=True)
            ssids = [line.strip() for line in res_scan.stdout.split('\n') if line.strip()]
            wled_ssid = None
            for s in ssids:
                if "wled-ap" in s.lower():
                    wled_ssid = s
                    break
                    
            if not wled_ssid:
                log("❌ Error: No WLED-AP hotspot found in range. Please verify WLED is powered on and in AP mode.")
                return
                
            log(f"📌 Found WLED hotspot: '{wled_ssid}'")
            
            log("🔌 Identifying current active Wi-Fi profile...")
            res_active = subprocess.run(["nmcli", "-t", "-f", "NAME,UUID,TYPE,DEVICE", "connection", "show", "--active"], capture_output=True, text=True)
            active_wifi_profile = None
            wifi_device = None
            for line in res_active.stdout.split('\n'):
                parts = line.split(':')
                if len(parts) >= 4 and parts[2] == '802-11-wireless':
                    active_wifi_profile = parts[0]
                    wifi_device = parts[3]
                    break
                    
            if not active_wifi_profile or not wifi_device:
                log("❌ Error: Could not find any active Wi-Fi connection to read credentials from.")
                return
                
            log(f"📶 Active Wi-Fi Connection: '{active_wifi_profile}' on interface '{wifi_device}'")
            
            log("🔑 Reading Wi-Fi SSID and Password from NetworkManager...")
            res_ssid = subprocess.run(["nmcli", "-s", "-g", "802-11-wireless.ssid", "connection", "show", active_wifi_profile], capture_output=True, text=True)
            target_ssid = None
            for line in res_ssid.stdout.split('\n'):
                if line.strip():
                    target_ssid = line.strip()
                    break
            if not target_ssid:
                target_ssid = active_wifi_profile
                
            res_psk = subprocess.run(["sudo", "-n", "nmcli", "-s", "-g", "802-11-wireless-security.psk", "connection", "show", active_wifi_profile], capture_output=True, text=True)
            target_psk = ""
            for line in res_psk.stdout.split('\n'):
                if line.strip():
                    target_psk = line.strip()
                    break
                    
            log(f"📝 Target Wi-Fi SSID: '{target_ssid}'")
            if target_psk:
                log("📝 Target Wi-Fi Password: [Hidden]")
            else:
                log("📝 Target Wi-Fi Password: [None]")
                
            log(f"🔄 Creating / modifying temporary connection profile for '{wled_ssid}'...")
            # Pre-create/modify the profile to ensure ipv4.never-default is set before activation
            res_prof_check = subprocess.run(["nmcli", "connection", "show", wled_ssid], capture_output=True)
            if res_prof_check.returncode != 0:
                # Add connection
                subprocess.run(["sudo", "-n", "nmcli", "connection", "add", "type", "wifi", "con-name", wled_ssid, "ssid", wled_ssid], capture_output=True)
            
            # Configure to never default (prevents routing general internet through WLED-AP)
            subprocess.run(["sudo", "-n", "nmcli", "connection", "modify", wled_ssid, "wifi-sec.key-mgmt", "wpa-psk", "wifi-sec.psk", "wled1234", "ipv4.never-default", "yes"], capture_output=True)
            
            log(f"🔄 Connecting Wi-Fi interface '{wifi_device}' to WLED AP...")
            res_conn = subprocess.run(["sudo", "-n", "nmcli", "connection", "up", wled_ssid], capture_output=True, text=True)
            if res_conn.returncode != 0:
                log("⚠️ 'nmcli connection up' failed, trying direct device wifi connect...")
                res_conn2 = subprocess.run(["sudo", "-n", "nmcli", "dev", "wifi", "connect", wled_ssid, "password", "wled1234", "ifname", wifi_device], capture_output=True, text=True)
                # Modify again just in case
                subprocess.run(["sudo", "-n", "nmcli", "connection", "modify", wled_ssid, "ipv4.never-default", "yes"], capture_output=True)
                if res_conn2.returncode != 0:
                    log(f"❌ Error: Failed to connect to WLED AP: {res_conn2.stderr.strip()}")
                    log(f"🔄 Reconnecting back to original network '{active_wifi_profile}'...")
                    subprocess.run(["sudo", "-n", "nmcli", "connection", "up", active_wifi_profile])
                    return

            log("🌐 Connected to WLED AP. Waiting for IP address lease...")
            wled_ip = None
            for attempt in range(1, 15):
                time.sleep(1.0)
                res_ip = subprocess.run(["ip", "addr", "show", "dev", wifi_device], capture_output=True, text=True)
                ips = re.findall(r'inet\s+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})', res_ip.stdout)
                for ip in ips:
                    if ip.startswith("4.3.2."):
                        wled_ip = "4.3.2.1"
                        break
                    elif ip.startswith("192.168.4."):
                        wled_ip = "192.168.4.1"
                        break
                if wled_ip:
                    break
            
            if not wled_ip:
                log("⚠️ Warning: Could not detect gateway IP dynamically. Trying fallback IP '4.3.2.1'...")
                wled_ip = "4.3.2.1"
            else:
                log(f"📶 Got IP address lease. WLED AP Gateway: {wled_ip}")
                
            log(f"🚀 Submitting Wi-Fi credentials to WLED JSON API (http://{wled_ip}/json/cfg)...")
            
            success = False
            try:
                # We first fetch the current config from WLED to match the device layout
                get_url = f"http://{wled_ip}/json/cfg"
                with urllib.request.urlopen(get_url, timeout=4) as response:
                    wled_cfg = json.loads(response.read().decode('utf-8'))
                
                if "nw" not in wled_cfg:
                    wled_cfg["nw"] = {}
                if "ins" not in wled_cfg["nw"] or not isinstance(wled_cfg["nw"]["ins"], list) or len(wled_cfg["nw"]["ins"]) == 0:
                    wled_cfg["nw"]["ins"] = [{}]
                
                wled_cfg["nw"]["ins"][0]["ssid"] = target_ssid
                wled_cfg["nw"]["ins"][0]["psk"] = target_psk
                
                # Force AP behavior to 0 (AP opens only if no connection to home Wi-Fi)
                # so the WLED device turns off its AP hotspot once it successfully connects.
                if "ap" not in wled_cfg:
                    wled_cfg["ap"] = {}
                wled_cfg["ap"]["behav"] = 0
                
                # POST the updated network and AP configs to WLED
                req = urllib.request.Request(
                    get_url,
                    data=json.dumps({
                        "nw": wled_cfg["nw"],
                        "ap": wled_cfg["ap"]
                    }).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req, timeout=5) as response:
                    response.read()
                
                log("✅ Credentials successfully submitted! Requesting WLED to reboot...")
                
                # Trigger WLED reboot to apply network configuration
                reboot_url = f"http://{wled_ip}/json/state"
                req_rb = urllib.request.Request(
                    reboot_url,
                    data=json.dumps({"rb": True}).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                with urllib.request.urlopen(req_rb, timeout=4) as response:
                    response.read()
                
                log("✅ WLED rebooted and is now connecting to your home Wi-Fi...")
                success = True
            except Exception as e:
                log(f"❌ Error submitting credentials via JSON API: {e}")
                
            log(f"🔄 Restoring PC Wi-Fi connection to original network '{active_wifi_profile}'...")
            res_restore = subprocess.run(["sudo", "-n", "nmcli", "connection", "up", active_wifi_profile], capture_output=True, text=True)
            if res_restore.returncode == 0:
                log("✅ Reconnected to original network successfully!")
            else:
                log(f"⚠️ Warning: Failed to reconnect to original network: {res_restore.stderr.strip()}")
                
            # Try to delete the temporary profile to keep list clean
            subprocess.run(["sudo", "-n", "nmcli", "connection", "delete", wled_ssid], capture_output=True)
            
            if success:
                log("\n🎉 Auto-provisioning credentials sent!")
                log("⏳ Waiting 12 seconds for WLED to connect to your Wi-Fi...")
                time.sleep(12.0)
                
                log("🔍 Scanning your network to verify WLED connection...")
                try:
                    discovered = find_wled_on_subnet(wifi_device)
                    if discovered:
                        new_ip = discovered[0]
                        log(f"✅ Success! Verified WLED is online on your home Wi-Fi at IP: {new_ip}")
                        
                        if os.path.exists(CONFIG_FILE):
                            with open(CONFIG_FILE, "r") as f:
                                config = json.load(f)
                        else:
                            config = {}
                        
                        config["wifi_ip"] = new_ip
                        config["connection_type"] = "wifi"
                        with open(CONFIG_FILE, "w") as f:
                            json.dump(config, f, indent=4)
                        log("💾 Saved verified WLED IP to configuration file!")
                    else:
                        log("❌ Verification failed: WLED was not found on your home Wi-Fi network. Please verify that your Wi-Fi password was correct and that WLED is in range.")
                except Exception as ex:
                    log(f"⚠️ Verification failed due to error: {ex}")
            else:
                log("\n❌ Auto-provisioning failed.")
        else:
            self.send_response(404)
            self.end_headers()

    def do_PUT(self):
        import re as _re
        m = _re.match(r'^/api/devices/([^/]+)$', self.path)
        if m:
            device_id = m.group(1)
            content_length = int(self.headers.get("Content-Length", 0))
            put_data = self.rfile.read(content_length)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                req_data = json.loads(put_data.decode("utf-8"))
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                devices = config.get("devices", [])
                updated = False
                for dev in devices:
                    if dev.get("id") == device_id:
                        if "name" in req_data:
                            dev["name"] = req_data["name"].strip()
                        if "ip" in req_data:
                            dev["ip"] = req_data["ip"].strip()
                        if "connection_type" in req_data:
                            dev["connection_type"] = req_data["connection_type"]
                        if "api_type" in req_data:
                            dev["api_type"] = req_data["api_type"]
                        if "profile" in req_data:
                            dev["profile"] = req_data["profile"]
                        if "segments" in req_data:
                            dev["segments"] = req_data["segments"]
                        updated = True
                        break
                if not updated:
                    self.wfile.write(json.dumps({"status": "error", "message": "Device not found"}).encode("utf-8"))
                    return
                config["devices"] = devices
                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)
                self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_DELETE(self):
        import re as _re
        m = _re.match(r'^/api/devices/([^/]+)$', self.path)
        if m:
            device_id = m.group(1)
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            try:
                if os.path.exists(CONFIG_FILE):
                    with open(CONFIG_FILE, "r") as f:
                        config = json.load(f)
                else:
                    config = {}
                devices = config.get("devices", [])
                original_len = len(devices)
                devices = [d for d in devices if d.get("id") != device_id]
                if len(devices) == original_len:
                    self.wfile.write(json.dumps({"status": "error", "message": "Device not found"}).encode("utf-8"))
                    return
                config["devices"] = devices
                with open(CONFIG_FILE, "w") as f:
                    json.dump(config, f, indent=4)
                self.wfile.write(json.dumps({"status": "success"}).encode("utf-8"))
            except Exception as e:
                self.wfile.write(json.dumps({"status": "error", "message": str(e)}).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

def main():

    parser = argparse.ArgumentParser(description="AutoGlow 2 Configuration Web Server")
    parser.add_argument("--port", type=int, default=8080, help="Port to bind the server to")
    args = parser.parse_args()

    init_config()
    os.makedirs(WEB_DIR, exist_ok=True)

    server = HTTPServer(("0.0.0.0", args.port), AutoGlowHTTPRequestHandler)
    print(f"AutoGlow 2 Config Server started at http://localhost:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping AutoGlow 2 Config Server...")
        server.server_close()

if __name__ == "__main__":
    main()
