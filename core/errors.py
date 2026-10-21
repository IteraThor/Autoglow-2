"""
AutoGlow 2 - API Error Model
One error shape for every API failure, so the UI can show the right message, mark the right field
and offer a retry only where retrying can help.

Error body:
    {"ok": false, "error": {"code", "message", "field", "retryable"}, "status": "error", "message"}

"status" and "message" duplicate the error for UI code that still reads the old flat shape.

AppError subclasses aiohttp's HTTPException, so raising one from a handler produces this response
even when the app runs without global_error_middleware (as the route tests do).
"""

import json
from typing import Any, Dict, Optional

from aiohttp import web


def error_body(code: str, message: str, field: Optional[str] = None, retryable: bool = False,
               details: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    error: Dict[str, Any] = {"code": code, "message": message, "retryable": retryable}
    if field:
        error["field"] = field
    if details:
        error["details"] = details
    return {"ok": False, "error": error, "status": "error", "message": message}


class AppError(web.HTTPException):
    status_code = 500
    code = "INTERNAL"
    retryable = False

    def __init__(self, message: str, *, field: Optional[str] = None, code: Optional[str] = None,
                 retryable: Optional[bool] = None, details: Optional[Dict[str, Any]] = None):
        self.message = message
        self.field = field
        if code:
            self.code = code
        if retryable is not None:
            self.retryable = retryable
        self.details = details
        super().__init__(
            text=json.dumps(error_body(self.code, message, field, self.retryable, details)),
            content_type="application/json",
        )

    def __str__(self) -> str:
        return self.message


class ValidationError(AppError):
    status_code = 400
    code = "VALIDATION"


class NotFound(AppError):
    status_code = 404
    code = "NOT_FOUND"


class Conflict(AppError):
    status_code = 409
    code = "CONFLICT"


class PersistenceError(AppError):
    status_code = 500
    code = "PERSISTENCE"
    retryable = True


class DeviceUnreachable(AppError):
    status_code = 502
    code = "DEVICE_UNREACHABLE"
    retryable = True


class ServiceUnavailable(AppError):
    status_code = 503
    code = "UNAVAILABLE"
    retryable = True


async def read_json(request: web.Request) -> Dict[str, Any]:
    """Parse a JSON object body, or fail with a VALIDATION error the UI can show as-is."""
    try:
        data = await request.json()
    except Exception:
        raise ValidationError("Invalid JSON payload")
    if not isinstance(data, dict):
        raise ValidationError("Expected a JSON object")
    return data
