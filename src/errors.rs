//! API error model: one error shape for every API failure, so the UI can show the right message,
//! mark the right field and offer a retry only where retrying can help.
//!
//!   {"ok": false, "error": {"code", "message", "field", "retryable"}, "status": "error", "message"}
//!
//! "status" and "message" duplicate the error for UI code that still reads the old flat shape.

use crate::py::Obj;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

pub fn error_body(code: &str, message: &str, field: Option<&str>, retryable: bool, details: Option<Value>) -> Value {
    let mut err = crate::obj! {"code" => code, "message" => message, "retryable" => retryable};
    if let Some(f) = field.filter(|f| !f.is_empty()) {
        err.insert("field".into(), json!(f));
    }
    if let Some(d) = details.filter(|d| d.as_object().map_or(true, |o| !o.is_empty())) {
        err.insert("details".into(), d);
    }
    json!({"ok": false, "error": err, "status": "error", "message": message})
}

#[derive(Debug, Clone)]
pub struct AppError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub field: Option<String>,
    pub retryable: bool,
    pub details: Option<Value>,
}

impl AppError {
    fn make(status: u16, code: &str, retryable: bool, msg: impl Into<String>) -> AppError {
        AppError {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            code: code.into(),
            message: msg.into(),
            field: None,
            retryable,
            details: None,
        }
    }
    pub fn validation(msg: impl Into<String>) -> AppError {
        AppError::make(400, "VALIDATION", false, msg)
    }
    pub fn not_found(msg: impl Into<String>) -> AppError {
        AppError::make(404, "NOT_FOUND", false, msg)
    }
    pub fn conflict(msg: impl Into<String>) -> AppError {
        AppError::make(409, "CONFLICT", false, msg)
    }
    pub fn persistence(msg: impl Into<String>) -> AppError {
        AppError::make(500, "PERSISTENCE", true, msg)
    }
    pub fn unreachable(msg: impl Into<String>) -> AppError {
        AppError::make(502, "DEVICE_UNREACHABLE", true, msg)
    }
    pub fn unavailable(msg: impl Into<String>) -> AppError {
        AppError::make(503, "UNAVAILABLE", true, msg)
    }
    pub fn internal(msg: impl Into<String>) -> AppError {
        AppError::make(500, "INTERNAL", false, msg)
    }
    pub fn field(mut self, f: &str) -> AppError {
        self.field = Some(f.into());
        self
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = error_body(&self.code, &self.message, self.field.as_deref(), self.retryable, self.details.clone());
        (self.status, Json(body)).into_response()
    }
}

pub type ApiResult = Result<Response, AppError>;

/// Parse a JSON object body, or fail with a VALIDATION error the UI can show as-is
pub fn read_json(body: &[u8]) -> Result<Obj, AppError> {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(o)) => Ok(o),
        Ok(_) => Err(AppError::validation("Expected a JSON object")),
        Err(_) => Err(AppError::validation("Invalid JSON payload")),
    }
}

/// A JSON response with status 200
pub fn ok(v: Value) -> ApiResult {
    Ok(Json(v).into_response())
}

pub fn json_status(status: u16, v: Value) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::OK), Json(v)).into_response()
}
