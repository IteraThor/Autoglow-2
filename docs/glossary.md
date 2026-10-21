# AutoGlow 2 Domain Glossary

| Term | Definition |
|---|---|
| **Active Game Mode** | State where an Autodarts match is running. Real-time addressable LED animations are broadcast via low-latency UDP DRGB at 50 FPS, and the PWM spotlight is locked to 100% illumination. |
| **Idle / Ambient Mode** | State where no match is running or the board has timed out. The UDP stream is completely terminated, live mode is released (`lor: 0`), and WLED is controlled via discrete HTTP JSON API mutations. |
| **Live Override Lock (`lor`)** | WLED internal state flag (`0 = off`, `1 = live data running`, `2 = live data with timeout`). When `lor > 0`, HTTP JSON mutations to physical outputs are blocked or overwritten by the real-time buffer. |
| **Protocol Exclusivity FSM** | Finite State Machine ensuring mutual exclusion: HTTP mutations are only permitted when the UDP socket is closed and `lor == 0`. UDP streaming is only started after pending HTTP requests complete. |
| **DRGB Protocol** | Zero-overhead UDP binary protocol (`0x02` identifier + 1-byte timeout + raw RGB bytes) on port `21324` used for sub-5ms animation frames. |
| **Spotlight Channel** | Single-channel MOSFET PWM White output (typically GPIO 4) dedicated to board surface illumination. |
| **WS281x Channel** | Digital addressable RGB LED strip/ring (typically GPIO 33) partitioned into virtual segments for game event celebrations. |
