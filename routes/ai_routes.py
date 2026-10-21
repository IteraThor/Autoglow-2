"""
AutoGlow 2 - AI Copilot Routes Module
Handlers for Gemini API Key management and interactive Copilot chat.
"""

import asyncio
import logging
from aiohttp import web

from core.ai_assistant import AiAssistant
from core.storage import load_app_config, save_app_config

logger = logging.getLogger("autoglow.routes.ai")


async def handle_ai_status(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    cfg = request.app.get("current_app_config") or load_app_config(config_path)
    key = (cfg.ai_key or cfg.extra.get("gemini_api_key", "")).strip()
    has_key = bool(key)
    masked = f"{key[:6]}...{key[-4:]}" if len(key) >= 10 else ("***" if key else "")
    return web.json_response({"status": "ok", "has_key": has_key, "masked_key": masked})


async def handle_ai_key_save(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    data = await request.json()
    key = data.get("key", "").strip()
    cfg = load_app_config(config_path)
    cfg.ai_key = key
    cfg.extra["gemini_api_key"] = key
    save_app_config(cfg, config_path)
    request.app["current_app_config"] = cfg
    return web.json_response({"status": "ok", "has_key": bool(key)})


async def handle_ai_chat(request: web.Request) -> web.Response:
    config_path = request.app.get("config_path", "config.json")
    data = await request.json()
    user_msg = data.get("message", "").strip()
    history = data.get("history", [])
    custom_key = data.get("key", "").strip()
    cfg = request.app.get("current_app_config") or load_app_config(config_path)
    api_key = custom_key or (cfg.ai_key or cfg.extra.get("gemini_api_key", "")).strip()

    if not user_msg:
        return web.json_response({"status": "error", "message": "No message provided"}, status=400)

    loop = asyncio.get_running_loop()
    try:
        res = await loop.run_in_executor(
            None,
            lambda: AiAssistant.ask_gemini(
                api_key=api_key,
                user_message=user_msg,
                conversation_history=history,
                app_state=cfg.to_dict()
            )
        )
        return web.json_response(res)
    except Exception as e:
        logger.exception("Error in AI chat handler")
        return web.json_response({"status": "error", "message": str(e)}, status=500)
