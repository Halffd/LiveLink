//! The web front end is two embedded files behind two routes. These checks
//! run the real router in-process (no server, no port) so a broken
//! `include_str!` path or a missing route fails loudly here instead of when
//! someone opens the page.
//!
//! Kept out of the lib tests because it needs an orchestrator, and the
//! point of the check is the routes, not the state.

use livelink::api::routes::create_router as api_router;
use livelink::core::orchestrator::Orchestrator;
use livelink::core::state::OrchestratorConfig;
use std::sync::Arc;
use tower::ServiceExt;

async fn router() -> axum::Router {
  let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel::<(u32, String)>();
  api_router(fixture_orchestrator(), Some(sender))
}

/// A live orchestrator with no screens, which is all the routes need to
/// answer; the checks are about the files the UI routes serve.
fn fixture_orchestrator() -> Arc<Orchestrator> {
  let (_exit_tx, exit_rx) = tokio::sync::mpsc::channel(1);
  let (_network_tx, network_rx) = tokio::sync::mpsc::channel(1);
  Orchestrator::new(
    OrchestratorConfig {
      max_streams: 1,
      startup_cooldown_ms: 1000,
      crash_threshold_seconds: 3,
      skip_threshold_seconds: 2,
      ..Default::default()
    },
    exit_rx,
    network_rx,
  )
}

/// GET one path and return (status, content-type, body as text).
async fn get(path: &str) -> (axum::http::StatusCode, String, String) {
  let response = router()
    .await
    .oneshot(
      axum::http::Request::builder()
        .uri(path)
        .body(axum::body::Body::empty())
        .unwrap(),
    )
    .await
    .expect("router answered");
  let status = response.status();
  let content_type = response
    .headers()
    .get("content-type")
    .map(|v| v.to_str().unwrap_or_default().to_string())
    .unwrap_or_default();
  let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
    .await
    .expect("body read");
  (status, content_type, String::from_utf8_lossy(&bytes).to_string())
}

#[tokio::test]
async fn root_serves_the_ui_html() {
  let (status, content_type, html) = get("/").await;
  assert_eq!(status, 200);
  assert_eq!(content_type, "text/html; charset=utf-8");
  assert!(html.contains("LIVELINK"), "page has no app markup");
  assert!(html.contains("/app.js"), "page never loads its script");
}

#[tokio::test]
async fn app_js_serves_the_ui_script() {
  let (status, content_type, js) = get("/app.js").await;
  assert_eq!(status, 200);
  assert_eq!(content_type, "text/javascript; charset=utf-8");
  // The script must be the one that drives the API, not an empty shell.
  assert!(js.contains("function api("), "script has no request helper");
  assert!(js.contains("/screens"), "script never reads the screen list");
  assert!(js.contains("/channel/play"), "script never plays a stream");
}

#[tokio::test]
async fn index_alias_serves_the_same_page() {
  let (status, content_type, html) = get("/index.html").await;
  assert_eq!(status, 200);
  assert_eq!(content_type, "text/html; charset=utf-8");
  assert!(html.contains("LIVELINK"), "alias page is not the UI");
}

#[tokio::test]
async fn the_api_routes_still_answer() {
  // The UI is registered ahead of the API routes; the API must still be
  // reachable rather than shadowed by them.
  let (status, _content_type, body) = get("/health").await;
  assert_eq!(status, 200);
  assert!(body.contains("ok"), "health did not answer ok: {body}");
}

/// `/status` used to be hardcoded to two screens (0 and 1) and
/// `max_streams: 2`, so a run configured for four screens reported two and
/// the stream cap callers gate on was fiction. The UI's "Play" button reads
/// that cap, so the numbers have to come from the config the orchestrator
/// actually holds.
#[tokio::test]
async fn status_reports_the_configured_screens_and_cap() {
  // A run configured for screens 3, 5 and 7. `config.screens` is what the
  // server holds after loading config, so that is what drives the response.
  let screens = [3u32, 5, 7]
    .into_iter()
    .map(|screen| livelink::config::ScreenConfig {
      id: screen,
      screen,
      enabled: true,
      width: 640,
      height: 360,
      x: 0,
      y: 0,
      volume: 50,
      quality: "best".to_string(),
      window_maximized: false,
      primary: false,
      sources: Vec::new(),
      sorting: None,
      refresh: 0,
      auto_start: false,
      skip_watched_streams: None,
    })
    .collect::<Vec<_>>();
  let config = OrchestratorConfig {
    max_streams: 1,
    startup_cooldown_ms: 1000,
    crash_threshold_seconds: 3,
    skip_threshold_seconds: 2,
    screens,
    ..Default::default()
  };

  let (_exit_tx, exit_rx) = tokio::sync::mpsc::channel(1);
  let (_network_tx, network_rx) = tokio::sync::mpsc::channel(1);
  let orchestrator = Orchestrator::new(config, exit_rx, network_rx);
  let (sender, _receiver) = tokio::sync::mpsc::unbounded_channel::<(u32, String)>();
  let response = api_router(orchestrator, Some(sender))
    .oneshot(
      axum::http::Request::builder()
        .uri("/status")
        .body(axum::body::Body::empty())
        .unwrap(),
    )
    .await
    .expect("router answered");

  assert_eq!(response.status(), 200);
  let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
    .await
    .expect("body read");
  let payload: serde_json::Value = serde_json::from_slice(&bytes).expect("status json");

  let reported = payload["screens"]
    .as_array()
    .expect("screens array")
    .iter()
    .map(|s| s["screen"].as_u64().expect("screen number"))
    .collect::<Vec<_>>();
  assert_eq!(
    reported,
    vec![3, 5, 7],
    "status must report the configured screens, not a hardcoded 0 and 1"
  );

  // The cap is whatever the orchestrator enforces, not a hardcoded 2.
  assert_eq!(payload["max_streams"].as_u64(), Some(1));
  assert_eq!(payload["total_active"].as_u64(), Some(0));
}

/// POST one path with a JSON body and return (status, body as text).
async fn post_json(path: &str, body: serde_json::Value) -> (axum::http::StatusCode, String) {
  let response = router()
    .await
    .oneshot(
      axum::http::Request::builder()
        .uri(path)
        .method("POST")
        .header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap(),
    )
    .await
    .expect("router answered");
  let status = response.status();
  let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
    .await
    .expect("body read");
  (status, String::from_utf8_lossy(&bytes).to_string())
}

/// The mobile companion depends on `/tokenize`, and the mode that silently
/// fails is "returns 200 with an empty token list" — a client renders an
/// empty overlay and never learns the tokenizer never loaded. These checks
/// pin the response to the one that carries real tokens and readings.
#[tokio::test]
async fn tokenize_returns_tokens_with_readings() {
  // Must not be shadowed by the earlier `/index.html` route either, so a
  // typo in the path is a failing status, not a served page.
  let (status, body) = post_json(
    "/tokenize",
    serde_json::json!({ "text": "日本語を勉強する" }),
  )
  .await;
  assert_eq!(status, 200, "tokenize did not answer 200: {body}");

  let payload: serde_json::Value = serde_json::from_str(&body).expect("tokenize json");
  assert_eq!(payload["japanese"], true, "japanese flag wrong: {body}");

  let tokens = payload["tokens"].as_array().expect("tokens array");
  assert!(!tokens.is_empty(), "tokenize returned no tokens: {body}");

  let surfaces = tokens
    .iter()
    .map(|t| t["surface"].as_str().unwrap_or_default())
    .collect::<String>();
  assert!(
    surfaces.contains("日本語"),
    "tokens do not cover the input: {surfaces}"
  );

  // Readings are the whole point of the route: without one, furigana has
  // nothing to render.
  let with_reading = tokens
    .iter()
    .filter(|t| t["reading"].as_str().is_some_and(|r| !r.is_empty()))
    .count();
  assert!(
    with_reading >= 1,
    "no token carried a reading, furigana would render blank: {body}"
  );
}

/// Non-Japanese must pass through as a flag, not an error: a client asks
/// for every line and skips annotation itself when the flag is false.
#[tokio::test]
async fn tokenize_passes_through_non_japanese() {
  let (status, body) = post_json("/tokenize", serde_json::json!({ "text": "hello world" })).await;
  assert_eq!(status, 200, "plain text must not be an error: {body}");
  let payload: serde_json::Value = serde_json::from_str(&body).expect("tokenize json");
  assert_eq!(payload["japanese"], false, "non-japanese flagged japanese");
  let tokens = payload["tokens"].as_array().expect("tokens array");
  // Tokens may exist — ipadic segments ASCII words as 名詞, and
  // `tokenize_detailed` does not gate on language; `process_text_with_furigana`
  // is what gates, before it tokenizes at all. What must be true is that
  // nothing carries a reading: a client that ignores the flag would otherwise
  // render a blank furigana overlay over "hello".
  let with_reading = tokens
    .iter()
    .filter(|t| t["reading"].as_str().is_some_and(|r| !r.is_empty()))
    .count();
  assert_eq!(with_reading, 0, "non-japanese carried readings: {body}");
}
