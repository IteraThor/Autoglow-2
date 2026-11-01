"""
AutoGlow 2 - Studio (TV-style broadcast overlay)
Stores the Studio players (name + picture) and camera choice, and turns the live Autodarts
match state into a compact scoreboard for the broadcast page (web/studio/live.html).

Everything lives in studio/ next to config.json: studio.json plus one picture per player.
"""

import difflib
import json
import logging
import os
import re
import tempfile
import threading
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from core import studio_camera
from core.storage import PROJECT_ROOT

logger = logging.getLogger("autoglow.studio")

STUDIO_DIR = PROJECT_ROOT / "studio"
PLAYERS_DIR = STUDIO_DIR / "players"
SETTINGS_FILE = STUDIO_DIR / "studio.json"

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_NAME_LENGTH = 40
# Picture formats the browser can show, by file signature
IMAGE_TYPES = {
    "png": (b"\x89PNG\r\n\x1a\n", "image/png"),
    "jpg": (b"\xff\xd8\xff", "image/jpeg"),
    "webp": (b"RIFF", "image/webp"),
}
_ID_RE = re.compile(r"^[a-f0-9]{12}$")

# Profile text shown in the intro and on the idle player cards: field -> max length.
# The stat_* values are typed in by hand for now (real stats from match history come later).
PROFILE_FIELDS = {
    "alias": MAX_NAME_LENGTH,     # Autodarts name when it differs from the display name
    "country": 3,
    "nickname": 40,
    "club": 60,
    "hometown": 60,
    "hand": 10,
    "dart_weight": 10,
    "favourite_double": 10,
    "playing_since": 10,
    "stat_average": 10,
    "stat_180s": 10,
    "stat_best_checkout": 10,
}
# Pictures per player: the profile picture, and a photo shown by the "mockup" player camera
PICTURE_SLOTS = ("image", "mockup")
THEMES = ("autodarts", "tv", "arena", "neon", "velocity", "glass", "pub", "daylight")

# Every fixed wording on the broadcast output, editable in Studio › Broadcast › Texts.
# (group, [(key, label in the Studio, default)]). Settings store only the changed ones.
TEXT_GROUPS = [
    ("Logo", [
        ("brand_main", "Logo, first word", "AutoGlow"),
        ("brand_accent", "Logo, second word (accent colour)", "Studio"),
    ]),
    ("Idle screen", [
        ("idle_kicker", "Line above the title", "Live darts"),
        ("idle_tagline", "Line under the title (when no subtitle is set)", "Next match starts with the first game on Autodarts"),
        ("idle_ready", "Status when ready", "Ready – pick the players on Autodarts"),
    ]),
    ("Up next", [
        ("lobby_kicker", "Versus card title", "Up next"),
        ("lobby_status", "Status line", "Match starts soon"),
        ("idle_player_kicker", "Player card, when no club is set", "Player profile"),
    ]),
    ("Scoreboard", [
        ("board_sets", "Sets column", "Sets"),
        ("board_legs", "Legs column", "Legs"),
        ("board_set", "Set (as in Set 2)", "Set"),
        ("board_leg", "Leg (as in Leg 3)", "Leg"),
    ]),
    ("Player card", [
        ("card_avg", "Average", "3-dart avg"),
        ("card_round", "Round", "Round"),
    ]),
    ("Darts of the visit", [
        ("visit_checkout", "Checkout hint", "Checkout"),
        ("visit_bust", "Bust in the visit", "BUST"),
        ("visit_nine", "9-darter alert", "9-darter on"),
    ]),
    ("Mini dartboard", []),
    ("Big moments", [
        ("moment_180", "180", "180"),
        ("moment_game_shot", "Leg won", "GAME SHOT"),
        ("moment_set", "Set won", "SET WON"),
        ("moment_bust", "Bust", "BUST"),
        ("moment_nine", "Nine-darter", "NINE-DARTER"),
        ("moment_match", "Match won", "MATCH WON"),
    ]),
    ("Player intro", [
        ("intro_vs", "Versus badge", "VS"),
    ]),
    ("Bull-off", [
        ("bulloff_title", "Title", "Bull-off"),
        ("bulloff_rule_normal", "Rule: closest to the bull (WDF)", "Closest to the bull throws first"),
        ("bulloff_rule_official", "Rule: bull or 25 only (PDC)", "Bull beats 25 – anything else throws again"),
        ("bulloff_round", "Round (as in Round 2)", "Round"),
        ("bulloff_turn", "Player at the board", "Throwing"),
        ("bulloff_leader", "Best dart so far", "Closest"),
        ("bulloff_first", "Winner", "Throws first"),
        ("bulloff_tie", "Tie banner", "TIE"),
        ("bulloff_again", "Under the tie banner", "Throw again"),
    ]),
    ("Cards", [
        ("leg_title", "Leg card title", "Game shot"),
        ("set_title", "Set card title", "Set won"),
        ("match_winner", "Match card", "Winner"),
        ("fact_from", "Player fact: hometown", "From"),
        ("fact_throws", "Player fact: hand", "Throws"),
        ("fact_darts", "Player fact: dart weight", "Darts"),
        ("fact_since", "Player fact: playing since", "Playing since"),
    ]),
    ("Statistics", [
        ("stat_average", "Average", "Average"),
        ("stat_first9", "First 9 average", "First 9 avg"),
        ("stat_180s", "180s", "180s"),
        ("stat_140", "140+", "140+"),
        ("stat_100", "100+", "100+"),
        ("stat_checkout_pct", "Checkout %", "Checkout %"),
        ("stat_best_checkout", "Best checkout", "Best checkout"),
        ("stat_checkout", "Checkout (leg card)", "Checkout"),
        ("stat_darts", "Darts", "Darts"),
        ("stat_leg_average", "Leg average", "Leg average"),
        ("stat_fav_double", "Favourite double", "Favourite double"),
    ]),
]
TEXT_DEFAULTS = {key: default for _group, items in TEXT_GROUPS for key, _label, default in items}
# Where each group appears on the screens, shown with the group in the Studio
TEXT_GROUP_WHERE = {
    "Logo": "Idle screen, corner logo during the match, transitions",
    "Idle screen": "Between matches, while no players are picked in Autodarts",
    "Up next": "Before the match: the two players picked in the Autodarts lobby, face to face and one by one",
    "Scoreboard": "During the match: the score rows",
    "Player card": "During the match: pictures and averages of the players",
    "Darts of the visit": "During the match: the darts thrown, checkout hint and 9-darter alert",
    "Mini dartboard": "During the match: a small board with where the darts landed (no texts)",
    "Big moments": "Large banners after a 180, a won leg or set, a bust, a nine-darter, the match",
    "Player intro": "Versus intro when a match starts",
    "Bull-off": "Before the first leg, when the Autodarts lobby is set to a bull-off: who throws first",
    "Cards": "Leg card, match end card, player profiles",
    "Statistics": "Match end card, leg card, intro and player profiles",
}
# The overlay setting that each group's checkbox switches; "show" ones hide the element on the screens
TEXT_GROUP_TOGGLES = {
    "Idle screen": {"key": "idle_blur", "label": "Blurred board camera behind it", "show": False},
    "Player card": {"key": "show_player_card", "label": "Show", "show": True},
    "Darts of the visit": {"key": "show_checkout", "label": "Show", "show": True},
    "Mini dartboard": {"key": "show_dartboard", "label": "Show", "show": True},
    "Player intro": {"key": "show_intro", "label": "Show", "show": True},
}
MAX_TEXT_LENGTH = 80
# Texts the Studio can switch off one by one: every editable wording plus the event title and subtitle
HIDEABLE_TEXTS = set(TEXT_DEFAULTS) | {"event_title", "event_subtitle"}


def _clean_texts(raw: Any) -> Dict[str, str]:
    """Only known keys with a changed, non-empty value are kept; the rest falls back to the default."""
    if not isinstance(raw, dict):
        return {}
    texts = {}
    for key, value in raw.items():
        if key in TEXT_DEFAULTS and isinstance(value, str):
            value = value.strip()[:MAX_TEXT_LENGTH]
            if value and value != TEXT_DEFAULTS[key]:
                texts[key] = value
    return texts
LAYOUTS = ("split", "board", "player")

DEFAULT_CAMERA = {"kind": "none", "device_id": "", "label": "", "url": "", "mirror": False, "rotation": 0,
                  "zoom": 1.0, "pan_x": 0.0, "pan_y": 0.0, "warp": None, "controls": {}}
ROTATIONS = (0, 90, 180, 270)
# enabled; delay of the board camera (s); zoom factor; lead: the zoom move starts this long before the
# moment Autodarts reported the dart (as seen in the delayed picture); hold: how long it stays zoomed in
DEFAULT_DART_ZOOM = {"enabled": False, "delay": 2.0, "zoom": 2.5, "lead": 1.0, "hold": 2.0}
DEFAULT_SETTINGS: Dict[str, Any] = {
    "title": "AutoGlow Darts Studio",
    "subtitle": "",
    "accent": "#1fa34a",
    "show_player_card": True,
    "show_checkout": True,
    "show_dartboard": True,
    "show_intro": True,
    # False hides every graphic on the output: a clean camera picture
    "show_overlay": True,
    "texts": {},
    # Keys of texts not shown on the screens (their line, row or banner is left out)
    "hidden_texts": [],
    "idle_blur": True,
    "auto_direct": True,
    "layout": "split",
    "theme": "autodarts",
    "camera_resolution": "720p",
    # Frames per second passed on from the Autodarts Board Manager's camera streams (it sends 30)
    "relay_fps": 15,
    # Dart zoom: the board camera is shown `delay` seconds late, so it can zoom to where a dart lands
    # before the picture shows it arriving. Off: no delay at all.
    "dart_zoom": dict(DEFAULT_DART_ZOOM),
    # The match prepared on the Match page: who plays (Studio player ids, throwing order) and the format.
    # A person starts it in Autodarts; AutoGlow only uses it to recognise the players.
    "cameras": {"board": dict(DEFAULT_CAMERA), "player": dict(DEFAULT_CAMERA)},
    "players": [],
}

_lock = threading.Lock()


# -----------------------------------------------------------------------------
# Settings & players
# -----------------------------------------------------------------------------
def _clamp(value: Any, low: float, high: float, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return round(min(high, max(low, float(value))), 3)


def _clean_camera(raw: Any) -> Dict[str, Any]:
    cam = dict(DEFAULT_CAMERA)
    if isinstance(raw, dict):
        kind = str(raw.get("kind", "none"))
        # server: a camera on the AutoGlow computer, streamed to every viewer (core/studio_camera.py)
        # device: a camera of the browser showing the page; url: a network camera stream
        # mockup: the "mockup" photo of the player at the board, for trying the Studio without a camera
        cam["kind"] = kind if kind in ("none", "server", "device", "url", "mockup") else "none"
        cam["device_id"] = str(raw.get("device_id", ""))[:256]
        cam["label"] = str(raw.get("label", ""))[:200]
        cam["url"] = str(raw.get("url", ""))[:500]
        cam["mirror"] = bool(raw.get("mirror", False))
        # Degrees clockwise, for cameras mounted sideways or upside down
        rotation = raw.get("rotation", 0)
        cam["rotation"] = rotation if rotation in ROTATIONS and not isinstance(rotation, bool) else 0
        # Framing (web/studio/js/framing.js): 1 shows the whole picture, more zooms in; pan moves the crop
        cam["zoom"] = _clamp(raw.get("zoom"), 1.0, 4.0, 1.0)
        cam["pan_x"] = _clamp(raw.get("pan_x"), -1.0, 1.0, 0.0)
        cam["pan_y"] = _clamp(raw.get("pan_y"), -1.0, 1.0, 0.0)
        cam["warp"] = _clean_warp(raw.get("warp"))
        # Picture controls of a USB camera on this computer (V4L2): {"<control id>": value}
        cam["controls"] = studio_camera.clean_control_values(raw.get("controls"))
    return cam


def saved_controls(cam_id: str) -> Dict[int, int]:
    """Picture controls saved for a USB camera (in whichever slot shows it), applied when it opens."""
    for cam in cached_settings()["cameras"].values():
        if cam["kind"] == "server" and cam["device_id"] == cam_id and cam["controls"]:
            return {int(k): v for k, v in cam["controls"].items()}
    return {}


def save_camera_controls(slot: str, cam_id: str, values: Dict[str, int], replace: bool = False) -> None:
    """Merge control values into the saved controls of a slot that shows this camera (replace: only these)."""
    with _lock:
        settings = load_settings()
        cam = settings["cameras"].get(slot)
        if not cam or cam["kind"] != "server" or cam["device_id"] != cam_id:
            return
        cam["controls"] = studio_camera.clean_control_values(values if replace else {**cam["controls"], **values})
        _write_settings(settings)


def _clean_dart_zoom(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    d = DEFAULT_DART_ZOOM
    delay = _clamp(raw.get("delay"), 0.5, 5.0, d["delay"])
    return {
        "enabled": bool(raw.get("enabled", False)),
        "delay": delay,
        "zoom": _clamp(raw.get("zoom"), 1.2, 4.0, d["zoom"]),
        # The move has to start after the dart was reported: at most the delay minus a margin
        "lead": min(_clamp(raw.get("lead"), 0.0, 4.5, d["lead"]), round(delay - 0.3, 3)),
        "hold": _clamp(raw.get("hold"), 0.5, 8.0, d["hold"]),
    }


def _clean_warp(raw: Any) -> Optional[Dict[str, Any]]:
    """Straighten (web/studio/js/framing.js): four points marked on the double ring at 20, 6, 3 and 11
    (0..1 of the raw picture), how far to turn the picture towards a front view (0..1) and how much to
    sharpen the stretched far side (0..1, web/studio/js/sharpwarp.js)."""
    if not isinstance(raw, dict):
        return None
    points = raw.get("points")
    if not isinstance(points, list) or len(points) != 4:
        return None
    clean = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            return None
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in point):
            return None
        clean.append([_clamp(point[0], 0.0, 1.0, 0.5), _clamp(point[1], 0.0, 1.0, 0.5)])
    return {"points": clean, "strength": _clamp(raw.get("strength"), 0.0, 1.0, 0.5),
            "sharpen": _clamp(raw.get("sharpen"), 0.0, 1.0, 0.5)}


def _clean_player(raw: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict) or not _ID_RE.match(str(raw.get("id", ""))):
        return None
    name = str(raw.get("name", "")).strip()[:MAX_NAME_LENGTH]
    if not name:
        return None
    player = {"id": raw["id"], "name": name}
    for slot in PICTURE_SLOTS:
        picture = str(raw.get(slot, ""))
        player[slot] = picture if picture and (PLAYERS_DIR / picture).is_file() else ""
    player.update(_clean_profile(raw))
    return player


def _clean_profile(raw: Dict[str, Any]) -> Dict[str, str]:
    profile = {key: str(raw.get(key, "") or "").strip()[:limit] for key, limit in PROFILE_FIELDS.items()}
    profile["country"] = profile["country"].upper()
    return profile


def _clean_settings(raw: Any) -> Dict[str, Any]:
    raw = raw if isinstance(raw, dict) else {}
    out = json.loads(json.dumps(DEFAULT_SETTINGS))
    out["title"] = str(raw.get("title", out["title"]))[:80]
    out["subtitle"] = str(raw.get("subtitle", ""))[:80]
    accent = str(raw.get("accent", out["accent"]))
    out["accent"] = accent if re.match(r"^#[0-9a-fA-F]{6}$", accent) else DEFAULT_SETTINGS["accent"]
    out["show_player_card"] = bool(raw.get("show_player_card", True))
    out["show_checkout"] = bool(raw.get("show_checkout", True))
    for key in ("show_dartboard", "show_intro", "idle_blur", "auto_direct"):
        out[key] = bool(raw.get(key, DEFAULT_SETTINGS[key]))
    out["layout"] = raw.get("layout") if raw.get("layout") in LAYOUTS else "split"
    out["theme"] = raw.get("theme") if raw.get("theme") in THEMES else "autodarts"
    resolution = str(raw.get("camera_resolution", "720p"))
    out["camera_resolution"] = resolution if resolution in ("480p", "720p", "1080p") else "720p"
    relay_fps = raw.get("relay_fps", 15)
    out["relay_fps"] = relay_fps if relay_fps in (10, 15, 30) and not isinstance(relay_fps, bool) else 15
    out["dart_zoom"] = _clean_dart_zoom(raw.get("dart_zoom"))
    cams = raw.get("cameras") if isinstance(raw.get("cameras"), dict) else {}
    out["cameras"] = {slot: _clean_camera(cams.get(slot)) for slot in ("board", "player")}
    out["players"] = [p for p in (_clean_player(p) for p in raw.get("players", []) or []) if p]
    out["show_overlay"] = bool(raw.get("show_overlay", True))
    out["texts"] = _clean_texts(raw.get("texts"))
    hidden = raw.get("hidden_texts")
    out["hidden_texts"] = sorted({k for k in hidden if isinstance(k, str) and k in HIDEABLE_TEXTS}) if isinstance(hidden, list) else []
    return out


_cache: Dict[str, Any] = {"mtime": None, "settings": None}


def cached_settings() -> Dict[str, Any]:
    """Settings for the scoreboard polls (several per second): read again only when the file changed."""
    try:
        mtime = SETTINGS_FILE.stat().st_mtime_ns
    except FileNotFoundError:
        mtime = None
    if _cache["settings"] is None or mtime != _cache["mtime"]:
        _cache["settings"] = load_settings()
        _cache["mtime"] = mtime
    return _cache["settings"]


def load_settings() -> Dict[str, Any]:
    try:
        with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
            return _clean_settings(json.load(f))
    except FileNotFoundError:
        return _clean_settings({})
    except Exception as e:
        logger.warning(f"Could not read {SETTINGS_FILE}: {e}")
        return _clean_settings({})


def _write_settings(settings: Dict[str, Any]) -> None:
    STUDIO_DIR.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=STUDIO_DIR, prefix=".studio-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    os.replace(tmp, SETTINGS_FILE)


def save_settings(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Save the overlay settings and cameras. The player list keeps its stored pictures."""
    with _lock:
        current = load_settings()
        incoming = _clean_settings({**current, **raw})
        # Pictures are only set through upload; ids that are not stored are dropped
        stored = {p["id"]: p for p in current["players"]}
        players = []
        for p in incoming["players"]:
            if p["id"] in stored:
                players.append({**p, **{slot: stored[p["id"]][slot] for slot in PICTURE_SLOTS}})
        incoming["players"] = players
        _write_settings(incoming)
        return incoming


def detect_image_type(data: bytes) -> Optional[str]:
    for ext, (magic, _mime) in IMAGE_TYPES.items():
        if data.startswith(magic) and (ext != "webp" or data[8:12] == b"WEBP"):
            return ext
    return None


def _remove_image(name: str) -> None:
    if name:
        try:
            (PLAYERS_DIR / name).unlink()
        except FileNotFoundError:
            pass


def _picture_type(data: bytes) -> str:
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Picture is larger than 5 MB")
    ext = detect_image_type(data)
    if not ext:
        raise ValueError("Picture must be a PNG, JPEG or WebP file")
    return ext


def upsert_player(player_id: Optional[str], name: str, profile: Dict[str, str],
                  image: Optional[bytes], mockup: Optional[bytes] = None) -> Dict[str, Any]:
    """Create a player (no id) or update one. A picture left as None stays as it is."""
    name = name.strip()[:MAX_NAME_LENGTH]
    if not name:
        raise ValueError("Player name is required")
    uploads = {slot: (data, _picture_type(data)) for slot, data in (("image", image), ("mockup", mockup)) if data is not None}

    with _lock:
        settings = load_settings()
        player = next((p for p in settings["players"] if p["id"] == player_id), None)
        if player_id and not player:
            raise KeyError(player_id)
        if not player:
            player = {"id": uuid.uuid4().hex[:12], **{slot: "" for slot in PICTURE_SLOTS}}
            settings["players"].append(player)
        player["name"] = name
        player.update(_clean_profile(profile))
        for slot, (data, ext) in uploads.items():
            PLAYERS_DIR.mkdir(parents=True, exist_ok=True)
            # A new file name per upload, so browsers never show a cached old picture
            filename = f"{player['id']}-{uuid.uuid4().hex[:6]}.{ext}"
            (PLAYERS_DIR / filename).write_bytes(data)
            _remove_image(player.get(slot, ""))
            player[slot] = filename
        _write_settings(settings)
        return player


def remember_autodarts_name(player_id: str, autodarts_name: str) -> Dict[str, Any]:
    """Save an Autodarts name as this player's Autodarts name, so the next match maps them by name.
    Another player that had the same Autodarts name loses it."""
    autodarts_name = autodarts_name.strip()[:MAX_NAME_LENGTH]
    if not autodarts_name:
        raise ValueError("Autodarts name is required")
    with _lock:
        settings = load_settings()
        player = next((p for p in settings["players"] if p["id"] == player_id), None)
        if not player:
            raise KeyError(player_id)
        for other in settings["players"]:
            if other is not player and other.get("alias", "").lower() == autodarts_name.lower():
                other["alias"] = ""
        # Same as the display name: nothing to remember
        player["alias"] = "" if player["name"].lower() == autodarts_name.lower() else autodarts_name
        _write_settings(settings)
        return settings


def _norm_name(name: Any) -> str:
    """Lowercase words without accents or punctuation: "Jérôme  O'Neil" -> "jerome o neil"."""
    text = unicodedata.normalize("NFKD", str(name or "")).encode("ascii", "ignore").decode()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def _name_score(autodarts_name: str, studio_player: Dict[str, Any]) -> float:
    """How surely an Autodarts name is this Studio player, 0 to 1: same name written differently,
    only the first or last name, a name that starts the other, or a small typo."""
    a = _norm_name(autodarts_name)
    if not a:
        return 0.0
    best = 0.0
    for candidate in (studio_player.get("name"), studio_player.get("alias"), studio_player.get("nickname")):
        b = _norm_name(candidate)
        if not b:
            continue
        a_compact, b_compact = a.replace(" ", ""), b.replace(" ", "")
        if a_compact == b_compact:
            score = 1.0
        elif min(len(a_compact), len(b_compact)) >= 3 and (set(a.split()) <= set(b.split()) or set(b.split()) <= set(a.split())):
            score = 0.9
        elif min(len(a_compact), len(b_compact)) >= 3 and (a_compact.startswith(b_compact) or b_compact.startswith(a_compact)):
            score = 0.85
        else:
            # A small typo in the whole name, or in one of its words ("LOKKI" for Loki Laufeyson)
            ratio = max((difflib.SequenceMatcher(None, x, y).ratio()
                        for x in (a_compact, *a.split()) for y in (b_compact, *b.split()) if len(x) >= 3 and len(y) >= 3), default=0.0)
            score = ratio * 0.9 if ratio >= 0.8 else 0.0
        best = max(best, score)
    return best


def map_players(players: List[Dict[str, Any]], settings: Dict[str, Any]) -> List[Dict[str, str]]:
    """Which Studio player each Autodarts player is, in whatever order they were added in Autodarts:
    first the exact name or remembered Autodarts name (ignoring case), then a similar name
    (see _name_score). A name that fits two Studio players equally well stays unknown."""
    studio_players = settings.get("players", [])
    by_name = {p["name"].lower(): p["id"] for p in studio_players}
    by_alias = {p["alias"].lower(): p["id"] for p in studio_players if p.get("alias")}
    result: List[Dict[str, str]] = []
    used = set()
    for player in players:
        key = str(player.get("name", "")).strip().lower()
        if key in by_alias and by_alias[key] not in used:
            match = {"studio_id": by_alias[key], "match": "alias"}
        elif key in by_name and by_name[key] not in used:
            match = {"studio_id": by_name[key], "match": "name"}
        else:
            match = {"studio_id": "", "match": ""}
        used.add(match["studio_id"])
        result.append(match)

    # Surest pairs first
    pairs = []
    for i, player in enumerate(players):
        if result[i]["studio_id"]:
            continue
        scores = sorted(((_name_score(str(player.get("name", "")), sp), sp["id"]) for sp in studio_players if sp["id"] not in used), reverse=True)
        if scores and scores[0][0] >= 0.7 and (len(scores) == 1 or scores[1][0] < scores[0][0]):
            pairs.append((scores[0][0], i, scores[0][1]))
    for _score, i, pid in sorted(pairs, reverse=True):
        if not result[i]["studio_id"] and pid not in used:
            result[i] = {"studio_id": pid, "match": "similar"}
            used.add(pid)
    return result


def delete_player(player_id: str) -> None:
    with _lock:
        settings = load_settings()
        player = next((p for p in settings["players"] if p["id"] == player_id), None)
        if not player:
            raise KeyError(player_id)
        for slot in PICTURE_SLOTS:
            _remove_image(player.get(slot, ""))
        settings["players"] = [p for p in settings["players"] if p["id"] != player_id]
        _write_settings(settings)


def image_path(filename: str) -> Optional[Path]:
    """Resolve a stored picture by file name, never outside the players folder."""
    if not re.match(r"^[a-f0-9]{12}-[a-f0-9]{6}\.(png|jpg|webp)$", filename or ""):
        return None
    path = PLAYERS_DIR / filename
    return path if path.is_file() else None


def image_mime(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1]
    return IMAGE_TYPES.get(ext, ("", "application/octet-stream"))[1]


# -----------------------------------------------------------------------------
# Scoreboard from the Autodarts match state
# -----------------------------------------------------------------------------
def _num(value: Any, default: Optional[float] = None) -> Optional[float]:
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, float)):
        return value
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _list(data: Dict[str, Any], key: str) -> List[Any]:
    value = data.get(key)
    return value if isinstance(value, list) else []


def _dict(data: Dict[str, Any], key: str) -> Dict[str, Any]:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def _player_name(raw: Any, fallback: str) -> str:
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    if isinstance(raw, dict):
        for key in ("name", "username", "userName", "nickname", "displayName"):
            val = raw.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip()
        user = raw.get("user")
        if isinstance(user, dict):
            return _player_name(user, fallback)
    return fallback


def _player_extras(raw: Any) -> Dict[str, str]:
    """Avatar picture and country Autodarts has for a player (guests have neither)."""
    if not isinstance(raw, dict):
        return {"avatar_url": "", "country": ""}
    user = _dict(raw, "user")
    avatar = raw.get("avatarUrl") or user.get("avatarUrl") or ""
    country = raw.get("country") or user.get("country") or ""
    return {
        "avatar_url": avatar if isinstance(avatar, str) and avatar.startswith("https://") else "",
        "country": country.strip()[:3].upper() if isinstance(country, str) else "",
    }


def _average(stats: Any) -> Optional[float]:
    """3-dart average from one player's Autodarts stats entry (match stats first, then leg)."""
    if not isinstance(stats, dict):
        return None
    for scope in ("matchStats", "legStats", "setStats"):
        block = stats.get(scope)
        if isinstance(block, dict):
            avg = _num(block.get("average"))
            if avg is not None:
                return round(avg, 2)
    return _num(stats.get("average"))


def _throw_label(throw: Any) -> str:
    if not isinstance(throw, dict):
        return ""
    seg = throw.get("segment")
    if isinstance(seg, dict):
        name = seg.get("name")
        if isinstance(name, str) and name:
            return name
        number, mult = seg.get("number"), seg.get("multiplier")
        if isinstance(number, int) and isinstance(mult, int):
            if number == 0 or mult == 0:
                return "MISS"
            if number == 25:
                return "BULL" if mult == 2 else "25"
            return f"{'SDT'[mult - 1] if 1 <= mult <= 3 else ''}{number}"
    if isinstance(seg, str):
        return seg
    return str(throw.get("name") or "")


# Autodarts stats shown in the overlays (legStats / matchStats of each player)
STAT_KEYS = ("average", "first9Average", "dartsThrown", "total180", "plus170", "plus140", "plus100",
             "checkoutPercent", "checkoutsHit", "checkouts")


def _stats_block(stats: Any, scope: str) -> Dict[str, float]:
    block = stats.get(scope) if isinstance(stats, dict) else None
    if not isinstance(block, dict):
        return {}
    out: Dict[str, float] = {}
    for key in STAT_KEYS:
        value = _num(block.get(key))
        if value is not None:
            out[key] = round(value, 2)
    return out


def throw_detail(throw: Any) -> Dict[str, Any]:
    """One dart: label plus where it landed. coords are board-relative: 1.0 is the outer edge of
    the double ring, +y points to the 20."""
    seg = _dict(throw, "segment") if isinstance(throw, dict) else {}
    coords = _dict(throw, "coords") if isinstance(throw, dict) else {}
    x, y = _num(coords.get("x")), _num(coords.get("y"))
    return {
        "id": str(throw.get("id", "")) if isinstance(throw, dict) else "",
        "label": _throw_label(throw),
        "number": seg.get("number") if isinstance(seg.get("number"), int) else None,
        "multiplier": seg.get("multiplier") if isinstance(seg.get("multiplier"), int) else None,
        "bed": str(seg.get("bed", "") or ""),
        "x": round(x, 4) if x is not None else None,
        "y": round(y, 4) if y is not None else None,
    }


def _rounds(chalkboard: Any) -> List[float]:
    """Points of each visit in the current leg (the Autodarts chalkboard; row 0 is the start score)."""
    rows = chalkboard.get("rows") if isinstance(chalkboard, dict) else None
    if not isinstance(rows, list):
        return []
    points = []
    for row in rows:
        if isinstance(row, dict) and (_num(row.get("round"), 0) or 0) > 0:
            value = _num(row.get("points"))
            if value is not None:
                points.append(value)
    return points


def _guide_labels(guide: Any) -> List[str]:
    if not isinstance(guide, list) or not guide:
        return []
    labels = [g.get("name") if isinstance(g, dict) else str(g) for g in guide]
    return [str(label) for label in labels if label][:3]


def _checkout(state: Dict[str, Any], active: int = 0) -> List[str]:
    """Checkout suggestion Autodarts shows for the player at the board, if any."""
    candidates = [state.get("checkoutGuide")]
    inner = state.get("state")
    if isinstance(inner, dict):
        candidates.append(inner.get("checkoutGuide"))
        per_player = inner.get("checkoutGuides")
        if isinstance(per_player, list) and 0 <= active < len(per_player):
            candidates.append(per_player[active])
    for guide in candidates:
        if isinstance(guide, list) and guide:
            labels = [g.get("name") if isinstance(g, dict) else str(g) for g in guide]
            return [str(label) for label in labels if label][:3]
    return []


def match_target(state: Dict[str, Any]) -> str:
    """'First to 3 legs' / 'First to 7 sets' from the match settings, if known."""
    sets = _num(state.get("sets"), 0) or 0
    legs = _num(state.get("legs"), 0) or 0
    if sets and sets > 1:
        return f"First to {int(sets)} sets"
    if legs:
        return f"First to {int(legs)} leg{'s' if legs != 1 else ''}"
    return ""


def build_scoreboard(state: Optional[Dict[str, Any]], live: bool, phase: str = "") -> Dict[str, Any]:
    """Reduce an Autodarts match state to what the broadcast overlay draws."""
    if not isinstance(state, dict) or not state:
        return {"live": False, "players": []}

    raw_players = _list(state, "players")
    game_scores = _list(state, "gameScores")
    scores = _list(state, "scores")
    stats = _list(state, "stats")
    raw_active = state.get("player")
    active = raw_active if isinstance(raw_active, int) else 0
    settings = _dict(state, "settings")
    chalkboards = _list(state, "chalkboards")

    # Right after the start the tab has only fetched the match summary: no gameScores, leg or round
    # until the first dart. While no leg is won yet, that is an X01 match at its start score in leg 1.
    fresh_start = not game_scores and not any(
        isinstance(s, dict) and ((_num(s.get("legs"), 0) or 0) or (_num(s.get("sets"), 0) or 0)) for s in scores
    )
    start_score = _num(settings.get("baseScore")) if fresh_start and state.get("variant") == "X01" else None
    leg = _num(state.get("leg"))
    if leg is None and fresh_start:
        leg = 1

    count = max(len(raw_players), len(game_scores))
    players = []
    for i in range(count):
        score_entry = scores[i] if i < len(scores) and isinstance(scores[i], dict) else {}
        raw = raw_players[i] if i < len(raw_players) and isinstance(raw_players[i], dict) else {}
        player_stats = stats[i] if i < len(stats) else None
        players.append({
            "index": i,
            "id": str(raw.get("id", "")),
            "name": _player_name(raw or None, f"Player {i + 1}"),
            "remaining": _num(game_scores[i]) if i < len(game_scores) else start_score,
            "legs": int(_num(score_entry.get("legs"), 0) or 0),
            "sets": int(_num(score_entry.get("sets"), 0) or 0),
            "average": _average(player_stats),
            "leg_stats": _stats_block(player_stats, "legStats"),
            "match_stats": _stats_block(player_stats, "matchStats"),
            # Lifetime average of the Autodarts account (guests have none)
            "account_average": _num(_dict(raw, "user").get("average")),
            "rounds": _rounds(chalkboards[i] if i < len(chalkboards) else None),
            **_player_extras(raw or None),
        })

    turns = _list(state, "turns")
    last_turn: Dict[str, Any] = turns[-1] if turns and isinstance(turns[-1], dict) else {}
    throws = _list(last_turn, "throws")
    # The visit belongs to the player whose id it carries; the active index may already have moved on
    turn_player = last_turn.get("player") if isinstance(last_turn.get("player"), int) else None
    if turn_player is None and last_turn.get("playerId"):
        turn_player = next((p["index"] for p in players if p["id"] == last_turn["playerId"]), None)

    winner = state.get("winner")
    return {
        "live": live,
        "match_id": str(state.get("id", "")),
        "variant": str(state.get("variant", "") or ""),
        "base_score": _num(settings.get("baseScore")),
        "out_mode": str(settings.get("outMode", "") or ""),
        "target": match_target(state),
        "uses_sets": bool((_num(state.get("sets"), 0) or 0) > 1),
        "set": _num(state.get("set")),
        "leg": leg,
        "round": _num(state.get("round")),
        "active": active,
        "finished": bool(state.get("finished")) or (isinstance(winner, int) and winner >= 0),
        "winner": winner if isinstance(winner, int) and winner >= 0 else None,
        "players": players,
        "turn": {
            "id": str(last_turn.get("id", len(turns))),
            "player": turn_player if turn_player is not None else active,
            "darts": [_throw_label(t) for t in throws],
            "throws": [throw_detail(t) for t in throws],
            "points": _num(last_turn.get("points")),
            "busted": bool(last_turn.get("busted")) or state.get("turnBusted") is True,
        },
        "checkout": _checkout(state, active),
        # Board phase from Autodarts: throw, takeout_in_progress, takeout, takeout_finished, idle
        "phase": phase,
    }


BULL_OFF_LABELS = {50: "Bull", 25: "25"}


def _bull_off_dart(stats: Any, throw: Any) -> Dict[str, Any]:
    """One player's bull-off dart: where it landed, its distance to the bull centre in mm, its segment."""
    leg = _dict(stats if isinstance(stats, dict) else {}, "legStats")
    coords = _dict(leg, "coords") or _dict(throw if isinstance(throw, dict) else {}, "coords")
    if not coords:
        return {"thrown": False}
    segment = int(_num(leg.get("segmentNumber"), 0) or 0)
    label = _throw_label(throw) if isinstance(throw, dict) else ""
    return {
        "thrown": True,
        "distance": round(_num(leg.get("bullDistance"), 0) or 0, 1),
        "segment": segment,
        "label": label or BULL_OFF_LABELS.get(segment, ""),
        "x": _num(coords.get("x"), 0),
        "y": _num(coords.get("y"), 0),
    }


def _bull_off_round(entry: Dict[str, Any], count: int) -> List[Dict[str, Any]]:
    stats = _list(entry, "stats")
    throws: Dict[Any, Any] = _dict(entry, "throws")  # keyed by player index
    return [_bull_off_dart(stats[i] if i < len(stats) else None, throws.get(i)) for i in range(count)]


def _bull_off_leader(darts: List[Dict[str, Any]], mode: str) -> Optional[int]:
    """Who leads the round: the closest dart (Normal), or the only best of Bull / 25 (Official)."""
    thrown = [(i, d) for i, d in enumerate(darts) if d.get("thrown")]
    if not thrown:
        return None
    if mode.lower() == "official":
        best = max(d["segment"] for _i, d in thrown)
        top = [i for i, d in thrown if d["segment"] == best]
        return top[0] if best > 0 and len(top) == 1 else None
    best = min(d["distance"] for _i, d in thrown)
    top = [i for i, d in thrown if d["distance"] == best]
    return top[0] if len(top) == 1 else None


def build_bull_off(bull_off: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The bull-off before the first leg (see AutodartsClient.bull_off): players, their darts this
    round and in tied rounds before, who leads, and the winner once Autodarts decided it."""
    if not isinstance(bull_off, dict):
        return None
    state = _dict(bull_off, "state")
    lobby = _dict(bull_off, "lobby")
    raw_players = [p for p in (_list(state, "players") or _list(lobby, "players")) if isinstance(p, dict)]
    if not raw_players:
        return None
    mode = str(bull_off.get("mode") or "")
    rounds: Dict[Any, Any] = _dict(bull_off, "rounds")  # keyed by round number
    raw_round = state.get("round")
    current: int = raw_round if isinstance(raw_round, int) else (max(rounds) if rounds else 1)
    darts = _bull_off_round(rounds.get(current, {}), len(raw_players))
    players = []
    for i, raw in enumerate(raw_players):
        players.append({
            "index": i,
            "id": str(raw.get("id", "")),
            "name": _player_name(raw, f"Player {i + 1}"),
            "account_average": _num(_dict(raw, "user").get("average")),
            **_player_extras(raw),
            **darts[i],
        })
    winner = state.get("gameWinner")
    decided = state.get("gameFinished") is True and isinstance(winner, int) and 0 <= winner < len(players)
    active = state.get("player")
    if not isinstance(active, int) and not any(d.get("thrown") for d in darts):
        active = 0  # Lobby just started: the first player is at the board, no match state yet
    lobby_settings = _dict(lobby, "settings")
    return {
        "match_id": str(bull_off.get("match_id") or state.get("id") or ""),
        "mode": mode,
        "round": current,
        "active": active if isinstance(active, int) and not decided else None,
        "decided": decided,
        "winner": winner if decided else None,
        "leader": winner if decided else _bull_off_leader(darts, mode),
        "players": players,
        # Tied rounds before this one, oldest first
        "history": [{"round": r, "darts": _bull_off_round(rounds[r], len(players))} for r in sorted(rounds) if r < current],
        # The match format for the intro (from the lobby; the bull-off state has its own settings)
        "variant": str(lobby.get("variant", "") or ""),
        "base_score": _num(lobby_settings.get("baseScore")),
        "target": match_target(lobby) if lobby else "",
    }


def build_lobby(lobby: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The players picked in an Autodarts lobby and its format, for the pre-match screens."""
    if not isinstance(lobby, dict):
        return None
    settings = _dict(lobby, "settings")
    players = []
    for i, raw in enumerate(p for p in _list(lobby, "players") if isinstance(p, dict)):
        players.append({
            "index": i,
            "id": str(raw.get("id", "")),
            "name": _player_name(raw, f"Player {i + 1}"),
            "account_average": _num(_dict(raw, "user").get("average")),
            **_player_extras(raw),
        })
    return {
        "id": str(lobby.get("id", "")),
        "variant": str(lobby.get("variant", "") or ""),
        "base_score": _num(settings.get("baseScore")),
        "out_mode": str(settings.get("outMode", "") or ""),
        "target": match_target(lobby),
        "players": players,
    }


def demo_scoreboard() -> Dict[str, Any]:
    """Sample match so the overlay can be laid out without a game running."""
    return {
        "live": True, "demo": True, "match_id": "demo", "variant": "X01", "base_score": 501,
        "out_mode": "Double", "target": "First to 7 sets", "uses_sets": True,
        "set": 3, "leg": 2, "round": 6, "active": 0, "finished": False, "winner": None,
        "players": [
            {"index": 0, "name": "Player One", "remaining": 367, "legs": 1, "sets": 0, "average": 98.4, "avatar_url": "", "country": ""},
            {"index": 1, "name": "Player Two", "remaining": 401, "legs": 0, "sets": 2, "average": 101.7, "avatar_url": "", "country": ""},
        ],
        "turn": {"id": "demo", "player": 1, "darts": ["T20", "T20", "S20"], "points": 140, "busted": False},
        "checkout": [],
    }
