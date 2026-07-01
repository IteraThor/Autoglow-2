# WLED Integration & API Reference Guide

> [!IMPORTANT]
> This reference is a guide for AI coding assistants working on the AutoGlow codebase. Read this document before making any changes to WLED communication, segment mappings, or hardware configuration updates.

---

## 1. WLED API Architectures

WLED exposes two distinct JSON APIs. Conflating them is the most common cause of integration bugs.

### A. State Control API (`/json/state` or POST `/json`)
* **Purpose:** Real-time control of active lighting states, colors, effects, brightness, and runtime segments.
* **Payload Structure:**
  ```json
  {
    "on": true,
    "bri": 255,
    "transition": 0,
    "seg": [
      {
        "id": 0,
        "start": 0,
        "stop": 17,
        "col": [[255, 0, 0]],
        "fx": 0
      }
    ]
  }
  ```
* **Key Properties:**
  * Uses **`start`** and **`stop`** (exclusive upper bound) to define runtime segments.
  * Uses **`id`** (integer index) to target segments.
  * Modifying this API does **not** change hardware layouts or GPIO pin definitions.

### B. Hardware Configuration API (`/json/cfg`)
* **Purpose:** Modifying physical hardware settings, GPIO pins, LED counts, bus types, and limits.
* **GET `/json/cfg` Payload Structure:**
  ```json
  {
    "hw": {
      "led": {
        "total": 18,
        "ins": [
          {
            "start": 0,
            "len": 17,
            "pin": [33],
            "type": 22
          },
          {
            "start": 17,
            "len": 1,
            "pin": [4],
            "type": 41
          }
        ]
      }
    }
  }
  ```
* **POST `/json/cfg` Payload Requirement:**
  To save configuration changes, you **must query the entire configuration first**, modify only the fields under `"hw"` / `"led"` / `"ins"`, and then write the entire JSON payload back to `/json/cfg`. Partial updates will wipe out other system configurations (like buttons, relays, and network settings).

---

## 2. The LED Bus Type Pitfall (`type` vs `typ`)

> [!WARNING]
> WLED represents the LED bus type differently depending on whether you are **reading** the settings or **writing** settings.
> * **When Reading (`GET /json/cfg`):** WLED outputs the key as `"type"`.
> * **When Writing (`POST /json/cfg`):** WLED parses the key as `"typ"` (or `"type"` in newer builds).

### Best Practice Implementation
Always write helper utilities to handle both properties dynamically:

#### Reading WLED Configuration
Extract the bus type safely by falling back:
```python
# Python
typ_value = item.get("type", item.get("typ", 22))
```
```javascript
// JavaScript
const typeVal = seg.type !== undefined ? parseInt(seg.type, 10) : 22;
```

#### Writing WLED Configuration
Reconstruct the input instance payload by populating **both** keys:
```python
new_ins.append({
    "start": start_offset,
    "len": total_l,
    "pin": [p],
    "order": 0,
    "ftr": False,
    "typ": typ_val,   # Traditional WLED configuration key
    "type": typ_val,  # Modern WLED configuration key
    "rev": False
})
```

---

## 3. Physical Strip Types Mappings

Use these integer values when assigning strip types inside the selection options:

| Value | WLED Const Identifier | Description |
|---|---|---|
| **22** | `TYPE_WS2812B` | WS281x (Addressable digital) |
| **30** | `TYPE_SK6812_RGBW` | SK6812 RGBW (Addressable RGBW digital) |
| **41** | `TYPE_PWM_WHITE` | PWM White (Analog single-channel) |
| **42** | `TYPE_PWM_RGB` | PWM RGB (Analog 3-channel) |
| **43** | `TYPE_PWM_RGBW` | PWM RGBW (Analog 4-channel) |

---

## 4. Hardware Pin Mapping Logic

When translating user-facing strips/sections to WLED physical hardware instances:
1. **Combine by Pin:** If multiple logical segments run on the same physical GPIO data pin (daisy-chained), combine their lengths under a single physical bus input entry (`ins`) in `/json/cfg`.
2. **Segment Mapping:** WLED state segments (`/json/state`) are then partitioned by offset bounds (`start` and `stop`) matching the cumulative lengths.
3. **Type Inheritance:** All segments sharing a physical GPIO data pin share the same hardware bus type.
