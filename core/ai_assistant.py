"""
AutoGlow 2 - In-App AI Assistant (Google Gemini BYOK Integration)
Provides context-aware help, hardware diagnostics, and navigation assistance using the user's free Gemini API key.
"""

import json
import logging
import urllib.request
import urllib.error
from typing import Dict, Any, List, Optional

logger = logging.getLogger("autoglow.ai")

GEMINI_MODELS = [
    "gemini-flash-latest",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.5-flash",
    "gemma-4-26b-a4b-it",
    "gemini-flash-lite-latest",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
]

SYSTEM_KNOWLEDGE = """You are the AutoGlow 2 In-App AI Assistant, an expert AI copilot embedded directly into the AutoGlow 2 Dartboard Lighting Engine.
Your purpose is to help darts players, makers, and enthusiasts configure their lighting setup, troubleshoot WLED microcontrollers, wire LEDs/PWM strips, optimize Autodarts animations, and navigate the application.

### AutoGlow 2 System Architecture & Tabs:
1. Operational Hub (/hub): Live match scoreboard, dart thrown metrics, board status, active match view.
2. WLED Devices (/devices): Multi-controller management, manual IP entry, local network subnet scanner, live ping telemetry, segment boundaries (Start/Stop/Length/Brightness 0-255), and physical GPIO output grouping (e.g. WS281x on GPIO 33, PWM White on GPIO 16).
3. Autodarts (/autodarts): Live game data relayed by the AutoGlow Bridge Chrome extension from play.autodarts.com (direct account login is on hold), extension link status and setup, boards, active game status, real-time match stats.
4. Event Matrix (/matrix): Darts match event triggers mapped to light animations:
   - Events: 180 (3xT20), Match Won, Leg Won, Triple Hit, Bullseye (50), Bust / Miss, Dart Thrown, Turn Change, Takeout.
   - Animations: chase (Radial sweep), rainbow (Spinning spectrum), flash (High-visibility strobe), pulse (Smooth breathing), solid (Fixed color), off (Turn off).
   - Parameters: Animation type, Color (HEX/RGB), Duration (seconds), Speed multiplier, FPS (default 50).
5. Power & Timers (/power): Idle dimming timeout (seconds), dimmed brightness level (0-255), idle auto-off timeout (seconds), restore on activity.
6. Updates & Backups (/updates): GitHub auto-updater, beta safety alerts, 1-click snapshot backup creation (.zip), and 1-click instant system restore.

### Technical & Hardware Protocol Details:
- High-Speed Realtime Protocol: AutoGlow streams live animations to ESP32s at 50 FPS using low-latency UDP DRGB (Port 21324) for zero-latency lighting without TCP socket exhaustion.
- Visual Effects Execution: All event matrix effects stream purely over UDP. Never use HTTP `/json/state` for real-time animations or testing.
- Physical Segment Mapping: WLED is configured with `if.live.mso: false` so UDP streams map directly to discrete physical LED index ranges without mirroring across segments.
- Continuous Illumination: A duration value of `0` holds the illumination state indefinitely until overwritten by a new event.
- Hardware Mutations: Configuration changes (names, pins, PWM default brightness) write to physical WLED devices first (`/json/state` & `/json/cfg`) and verify via Stage 1 readback before committing locally.
- Common Hardware: WS2812B / WS2811 / SK6812 addressable LED rings on GPIO 33, MOSFET-driven PWM white spotlights on GPIO 4, ESP32 controllers running WLED v0.14/v0.15.

### Response Style & Guidelines:
- Be concise, practical, and precise. Avoid unnecessary fluff.
- Strict No-Emoji Rule: Never use emojis in any response. Use clean text or markdown formatting.
- Format responses in clean Markdown (use bullet points, bold keywords, and short code blocks).
- When mentioning a section of the app, mention the exact tab name (e.g. **Operational Hub**, **WLED Devices**, **Event Matrix**, **Power & Timers**, **Settings**).
- If diagnosing a hardware issue, reference the user's active controllers and segments when relevant.
"""


def build_system_context(app_state: Dict[str, Any]) -> str:
    """Compile static knowledge with live device telemetry and configuration snapshot."""
    context_lines = [SYSTEM_KNOWLEDGE, "\n--- CURRENT LIVE SYSTEM SNAPSHOT ---"]

    # Active Devices
    devices = app_state.get("devices", [])
    if devices:
        context_lines.append(f"Configured WLED Controllers ({len(devices)}):")
        for idx, dev in enumerate(devices):
            context_lines.append(
                f"  - Device #{idx+1}: Name='{dev.get('name')}', IP={dev.get('ip')}, UDP Port={dev.get('udp_port', 21324)}, RGB Count={dev.get('rgb_count', 45)}"
            )
    else:
        context_lines.append("Configured WLED Controllers: None configured yet.")

    # Autodarts Account Status
    ad_email = app_state.get("autodarts_email") or app_state.get("autodarts", {}).get("email")
    if ad_email:
        context_lines.append(f"Autodarts Account: Connected as {ad_email}")
    else:
        context_lines.append("Autodarts Account: Disconnected / Not logged in.")

    # Power Settings
    context_lines.append(
        f"Power Timers: Idle Dim Timeout={app_state.get('idle_dim_seconds', 300)}s (Bri: {app_state.get('idle_dim_brightness', 40)}), Auto-Off Timeout={app_state.get('idle_off_seconds', 1800)}s"
    )

    context_lines.append("--------------------------------------\n")
    return "\n".join(context_lines)


class AiAssistant:
    """Handles communication with Google Gemini API using BYOK."""

    @staticmethod
    def ask_gemini(
        api_key: str,
        user_message: str,
        conversation_history: Optional[List[Dict[str, str]]] = None,
        app_state: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """Send query to Google Gemini API with system context injection."""
        if not api_key or not api_key.strip():
            return {
                "status": "error",
                "message": "No Google Gemini API key provided. Please enter your free API key in the assistant settings."
            }

        api_key = api_key.strip()
        system_context = build_system_context(app_state or {})

        # Prepare contents payload for Gemini API
        contents = []

        # Previous conversation history
        if conversation_history:
            for msg in conversation_history:
                role = "user" if msg.get("role") == "user" else "model"
                text = msg.get("text", "")
                if text:
                    contents.append({
                        "role": role,
                        "parts": [{"text": text}]
                    })

        # Add current user message
        contents.append({
            "role": "user",
            "parts": [{"text": user_message}]
        })

        payload = {
            "system_instruction": {
                "parts": [{"text": system_context}]
            },
            "contents": contents,
            "generationConfig": {
                "temperature": 0.4,
                "maxOutputTokens": 1024,
                "topP": 0.95
            }
        }

        # Try Gemini models in priority order
        last_error = ""
        for model in GEMINI_MODELS:
            url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={
                    "Content-Type": "application/json"
                }
            )

            try:
                with urllib.request.urlopen(req, timeout=15.0) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode("utf-8"))
                        candidates = data.get("candidates", [])
                        if candidates and "content" in candidates[0]:
                            parts = candidates[0]["content"].get("parts", [])
                            reply_text = "".join(p.get("text", "") for p in parts)
                            return {
                                "status": "ok",
                                "model": model,
                                "reply": reply_text.strip()
                            }
            except urllib.error.HTTPError as e:
                err_body = e.read().decode("utf-8", errors="ignore")
                logger.warning(f"Gemini API error ({model}): {e.code} - {err_body}")
                try:
                    err_json = json.loads(err_body)
                    last_error = err_json.get("error", {}).get("message", str(e))
                except Exception:
                    last_error = f"HTTP Error {e.code}: {e.reason}"
                
                # If invalid key or quota exhausted, no point trying another model
                if e.code in (400, 401, 403):
                    break
            except Exception as e:
                logger.exception(f"Error querying Gemini model {model}")
                last_error = str(e)

        return {
            "status": "error",
            "message": f"Gemini API Error: {last_error or 'Unable to reach Google Gemini API'}"
        }
