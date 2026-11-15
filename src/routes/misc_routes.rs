//! Classic mode routes and the Chrome extension's update manifest and CRX

use super::*;
use crate::classic;
use tokio::sync::OnceCell;

pub async fn get_classic(State(s): State<S>) -> ApiResult {
    let (ports, _) = tokio::join!(async { tokio::task::spawn_blocking(classic::list_ports).await.unwrap_or_default() }, s.classic.check_board_manager());
    ok(classic::payload(&s.classic, ports))
}

pub async fn post_classic(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    if data.contains_key("board_manager_url") && classic::clean_board_manager_url(data.get("board_manager_url")).is_none() {
        return Err(AppError::validation("Enter the Board Manager address, for example http://localhost:3180").field("board_manager_url"));
    }
    let mut merged = s.classic.settings.lock().unwrap().clone();
    merged.extend(data);
    s.classic.apply(&Value::Object(merged)).await.map_err(AppError::persistence)?;
    let ports = tokio::task::spawn_blocking(classic::list_ports).await.unwrap_or_default();
    ok(classic::payload(&s.classic, ports))
}

pub async fn test_classic(State(s): State<S>, req: Req) -> ApiResult {
    let data = req.json()?;
    let key = data.get("status").and_then(Value::as_str).unwrap_or("").to_string();
    if !classic::STATUSES.iter().any(|(n, _, _)| *n == key) {
        return Err(AppError::validation("Unknown status").field("status"));
    }
    let look = data.get("look").filter(|l| l.is_object());
    if !s.classic.test(&key, look, data.get("global_brightness")).await {
        return Err(AppError::unreachable(s.classic.serial_error().unwrap_or_else(|| "No USB controller connected.".into())));
    }
    ok(json!({"status": "ok", "state": s.classic.snapshot()}))
}

pub const UPDATE_XML_PATH: &str = "/extension/update.xml";
pub const CRX_PATH: &str = "/extension/autoglow-bridge.crx";

/// Packed once per process; updates restart the server, which picks up a new version
async fn package() -> Result<&'static (String, String, Vec<u8>), AppError> {
    static P: OnceCell<(String, String, Vec<u8>)> = OnceCell::const_new();
    P.get_or_try_init(|| async {
        let p = tokio::task::spawn_blocking(crate::extension::package).await.map_err(|_| AppError::internal("Packing failed"))?.map_err(AppError::internal)?;
        info!("Packed AutoGlow Bridge extension v{} (id {})", p.1, p.0);
        Ok(p)
    })
    .await
}

pub async fn update_xml(req: Req) -> ApiResult {
    let (id, version, _) = package().await?;
    let host = req.header("host").unwrap_or("localhost:8080");
    let xml = format!(
        "<?xml version='1.0' encoding='UTF-8'?>\n<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n  <app appid='{}'>\n    <updatecheck codebase='http://{}{}' version='{}' />\n  </app>\n</gupdate>\n",
        id, host, CRX_PATH, version
    );
    let mut r = Response::new(axum::body::Body::from(xml));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/xml"));
    Ok(r)
}

pub async fn crx() -> ApiResult {
    let (_, _, crx) = package().await?;
    let mut r = Response::new(axum::body::Body::from(crx.clone()));
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/x-chrome-extension"));
    Ok(r)
}
