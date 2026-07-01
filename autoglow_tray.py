import os
import sys
import threading
import time
import asyncio
import webbrowser
import logging
from http.server import HTTPServer

# Set up logging before anything else
if getattr(sys, 'frozen', False):
    EXE_DIR = os.path.dirname(sys.executable)
else:
    EXE_DIR = os.path.dirname(os.path.abspath(__file__))

log_file = os.path.join(EXE_DIR, "autoglow.log")
try:
    sys.stdout = open(log_file, "a", encoding="utf-8", buffering=1)
    sys.stderr = sys.stdout
except Exception:
    pass

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("AutoGlowTray")

# Import dependencies
try:
    import pystray
    from PIL import Image, ImageDraw
except ImportError as e:
    logger.critical(f"Required libraries missing: {e}. Please run: pip install pystray Pillow")
    sys.exit(1)

# Import AutoGlow application modules
# Since these are in the same folder, we import them directly
sys.path.insert(0, EXE_DIR)
try:
    from web_server import AutoGlowHTTPRequestHandler, init_config, CONFIG_FILE, PROFILES_DIR, WEB_DIR
    from autodarts_wled_mini import autodarts_logger, serial_connections
except ImportError as e:
    logger.critical(f"Failed to import AutoGlow components: {e}")
    sys.exit(1)

# Global server variables
web_server_thread = None
sync_thread = None
httpd = None
sync_loop = None
icon = None

def run_web_server():
    global httpd
    logger.info("Initializing config database...")
    init_config()
    
    port = 8080
    logger.info(f"Starting web server on port {port}...")
    try:
        httpd = HTTPServer(("0.0.0.0", port), AutoGlowHTTPRequestHandler)
        logger.info(f"Web server started at http://localhost:{port}")
        httpd.serve_forever()
    except Exception as e:
        logger.error(f"Web server error: {e}")

def run_sync_daemon():
    global sync_loop
    logger.info("Starting sync daemon...")
    sync_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(sync_loop)
    try:
        sync_loop.run_until_complete(autodarts_logger())
    except asyncio.CancelledError:
        logger.info("Sync loop task was cancelled.")
    except Exception as e:
        logger.error(f"Sync daemon error: {e}")
    finally:
        sync_loop.close()
        logger.info("Sync loop closed.")

def start_threads():
    global web_server_thread, sync_thread
    
    # 1. Start web server thread
    web_server_thread = threading.Thread(target=run_web_server, name="WebServerThread", daemon=True)
    web_server_thread.start()
    
    # 2. Start sync daemon thread
    sync_thread = threading.Thread(target=run_sync_daemon, name="SyncDaemonThread", daemon=True)
    sync_thread.start()

def stop_threads():
    global httpd, sync_loop
    logger.info("Stopping all background services...")
    
    # Stop Web Server
    if httpd:
        try:
            httpd.shutdown()
            httpd.server_close()
            logger.info("Web server stopped.")
        except Exception as e:
            logger.error(f"Error stopping web server: {e}")
            
    # Close any active serial connections
    logger.info("Closing active serial connections...")
    for port, ser in list(serial_connections.items()):
        if ser and ser.is_open:
            try:
                ser.close()
                logger.info(f"Closed serial connection on {port}")
            except Exception as e:
                logger.error(f"Error closing serial {port}: {e}")
                
    # Stop Sync Daemon Loop
    if sync_loop and sync_loop.is_running():
        try:
            # Schedule cancellation of all running tasks on the loop
            for task in asyncio.all_tasks(sync_loop):
                task.cancel()
            sync_loop.call_soon_threadsafe(sync_loop.stop)
            logger.info("Sync daemon loop stop scheduled.")
        except Exception as e:
            logger.error(f"Error stopping sync loop: {e}")

def on_open_web(icon, item):
    logger.info("Opening Web UI in default browser...")
    webbrowser.open("http://localhost:8080")

def on_restart(icon, item):
    logger.info("Restarting services...")
    stop_threads()
    time.sleep(1)
    start_threads()
    logger.info("Services restarted successfully.")

def on_exit(icon, item):
    logger.info("Exiting application...")
    stop_threads()
    icon.stop()
    sys.exit(0)

def create_tray_icon(width=64, height=64):
    # Generates a premium concentric-circles (dartboard-like) tray icon
    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    dc = ImageDraw.Draw(image)
    
    # Vibrant orange ring
    dc.ellipse((4, 4, width - 4, height - 4), fill=(30, 30, 30, 255), outline=(255, 165, 0, 255), width=4)
    # Vibrant neon green ring
    dc.ellipse((14, 14, width - 14, height - 14), fill=(15, 15, 15, 255), outline=(57, 255, 20, 255), width=3)
    # Red Bullseye
    dc.ellipse((24, 24, width - 24, height - 24), fill=(255, 30, 30, 255))
    
    return image

def main():
    global icon
    logger.info("Starting AutoGlow 2 Tray Application...")
    
    # Start the services
    start_threads()
    
    # Create and run system tray icon
    # This must run on the main thread for Windows GUI event loop handling
    icon = pystray.Icon(
        "AutoGlow",
        icon=create_tray_icon(),
        title="AutoGlow 2 (Autodarts WLED Sync)",
        menu=pystray.Menu(
            pystray.MenuItem("Open Web UI", on_open_web, default=True),
            pystray.MenuItem("Restart Services", on_restart),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Exit", on_exit)
        )
    )
    
    icon.run()

if __name__ == "__main__":
    main()
