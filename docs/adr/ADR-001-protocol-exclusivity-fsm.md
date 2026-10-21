# ADR 001: Protocol Exclusivity Finite State Machine (UDP vs HTTP)

## Status
Accepted (Refining Implementation Details)

## Context
WLED microcontrollers cannot reliably process high-frequency UDP real-time streaming (DRGB port 21324) and HTTP JSON API mutations (`/json/state`) concurrently. When a UDP stream is active:
1. WLED enters Live Mode (`lor > 0`), locking hardware state.
2. Single-channel MOSFET PWM White outputs cannot be modulated over 3-channel UDP DRGB.
3. Concurrent HTTP requests during UDP transmission cause socket congestion, dropped packets, or microcontroller crashes.

## Decision
Implement a strict **Two-State Protocol Exclusivity Finite State Machine (FSM)** in the AutoGlow engine:
- **Active Game Mode (Pure UDP):**
  - **Trigger:** `start_game` Autodarts event or Manual UI "Connect UDP" toggle.
  - **Step 1:** Synchronous HTTP `POST /json/state` to set PWM Spotlight to configured brightness (default 100% / 255) and power ON.
  - **Step 2:** Await HTTP 200 OK confirmation.
  - **Step 3:** Establish 50 FPS UDP DRGB broadcast loop exclusively for WS281x RGB LEDs (`0..44`).
  - **Step 4:** Dispatch the `game_start` effect from the Event Matrix over UDP.
- **Idle / Ambient Mode (Pure HTTP):**
  - **Trigger:** `finish_game`, Autodarts client disconnect, Inactivity timer expiration, or Manual UI "Disconnect UDP" toggle.
  - **Step 1:** Cancel UDP broadcast loop.
  - **Step 2:** Send 1x clear/release frame to release WLED Live Mode (`lor: 0`).
  - **Step 3:** Perform Stage 1 verification (`GET /json/state` -> confirm `lor == 0`).
  - **Step 4:** Issue HTTP JSON mutations for ambient presets, spotlight dimming, or power-off.
- **Power & Timers Configurability (`/power`):**
  - **Game Mode Spotlight Brightness:** `0..100%` (Default: `100%`).
  - **Auto-connect UDP on Game Start:** On/Off (Default: `On`).
  - **Play Victory Celebration before Teardown:** On/Off (Default: `On`, plays `game_finish` before releasing UDP).
  - **Inactivity Teardown Timeout:** `1..60 min` (Default: `5 min`).
  - **Idle Dimming Level:** `0..100%` (Default: `20%`).
  - **Idle Power-Off Timer:** `1..120 min` (Default: `30 min`).
- **Sidebar Manual UDP Stream Toggle:**
  - Located at the bottom-left of the main navigation sidebar.
  - Displays real-time status: `UDP Stream Active` vs `HTTP Idle Mode`.
  - Emits real-time state changes via WebSocket telemetry.
- **Event Matrix Additions (`/matrix`):**
  - Added `game_start` (*Game Started*) — default Solid Green (`2.0s`).
  - Added `game_finish` (*Game Finished / Match Won*) — default Solid Gold (`3.0s`).

## Consequences
- **Positive:** Zero protocol collisions, rock-solid spotlight illumination during matches, instant 50 FPS animations on addressable LEDs, clean ambient transitions when idle.
- **Negative:** Mode transitions require an explicit synchronous handshake (approx. 50–100ms) before protocol switching.
