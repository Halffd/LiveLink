//! The daemon's client-facing API.
//!
//! Clients (the player, the UI) talk to the daemon over one socket: it
//! owns the queues, the source handlers and the caption cache, so any
//! client can drive any monitor and every client sees the same state.

use crate::cueloop::cache::{Caption, CaptionCache, CaptionKind, CaptionLine, Stream};
use crate::cueloop::queue::{QueueEntry, QueueStore};
use crate::cueloop::sources::HandlerRegistry;
use crate::queue::queue::StreamSource;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Shared daemon state.
pub struct DaemonState {
    pub queue: Mutex<QueueStore>,
    pub cache: CaptionCache,
    pub handlers: HandlerRegistry,
}

pub type SharedState = Arc<DaemonState>;

/// Body of `POST /queue`.
#[derive(Debug, Clone, Deserialize)]
pub struct EnqueueRequest {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
    #[serde(default)]
    pub target_language: Option<String>,
    /// Play this one before everything else.
    #[serde(default)]
    pub pinned: bool,
}

/// Body of `POST /queue/reorder`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReorderRequest {
    pub id: u64,
    pub index: usize,
}

/// Body of `POST /queue/{id}/pin`.
#[derive(Debug, Clone, Deserialize)]
pub struct PinRequest {
    pub pinned: bool,
}

/// Query of `GET /captions/{hash}`.
#[derive(Debug, Clone, Deserialize)]
pub struct CaptionQuery {
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
}

/// Body of `POST /captions/:hash` - the ASR worker writing results back.
#[derive(Debug, Clone, Deserialize)]
pub struct StoreCaptionRequest {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub lines: Vec<StoreLine>,
}

/// One cue of a stored caption set.
#[derive(Debug, Clone, Deserialize)]
pub struct StoreLine {
    #[serde(default)]
    pub index: Option<usize>,
    pub start: f64,
    pub end: f64,
    pub text: String,
    #[serde(default)]
    pub translation: Option<String>,
}

fn default_language() -> String {
    "en".to_string()
}

fn default_kind() -> String {
    "auto".to_string()
}

/// A queue listing.
#[derive(Debug, Clone, Serialize)]
pub struct QueueListing {
    pub entries: Vec<QueueEntry>,
    pub next: Option<QueueEntry>,
}

/// Build the daemon router.
pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/queue", get(list_queue).post(enqueue))
        .route("/queue/next", get(peek_next).post(take_next))
        .route("/queue/reorder", post(reorder))
        .route("/queue/:id/pin", post(set_pinned))
        .route("/queue/:id", delete(skip))
        .route("/captions/:hash", get(get_captions).post(store_caption))
        .route("/captions/:hash/exists", get(caption_exists))
        .with_state(state)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({"ok": true, "service": "cueloopd"}))
}

async fn list_queue(State(state): State<SharedState>) -> Json<QueueListing> {
    let queue = state.queue.lock().expect("queue lock");
    Json(QueueListing {
        entries: queue.entries(),
        next: queue.peek_next().cloned(),
    })
}

async fn enqueue(
    State(state): State<SharedState>,
    Json(request): Json<EnqueueRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let source = StreamSource {
        url: request.url,
        title: request.title,
        platform: request.platform,
        channel: request.channel,
        ..Default::default()
    };
    let now = chrono::Utc::now().timestamp();
    let mut queue = state.queue.lock().expect("queue lock");
    let mut entry = queue.enqueue(source, request.content_hash, request.target_language, now);
    if request.pinned {
        queue.set_pinned(entry.id, true);
        entry.pinned = true;
    }
    (StatusCode::CREATED, Json(serde_json::json!({"id": entry.id, "entry": entry})))
}

async fn peek_next(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let queue = state.queue.lock().expect("queue lock");
    match queue.peek_next() {
        Some(entry) => Json(serde_json::json!({"next": entry})),
        None => Json(serde_json::json!({"next": null})),
    }
}

async fn take_next(State(state): State<SharedState>) -> Json<serde_json::Value> {
    let mut queue = state.queue.lock().expect("queue lock");
    match queue.take_next() {
        Some(entry) => Json(serde_json::json!({"next": entry})),
        None => Json(serde_json::json!({"next": null})),
    }
}

async fn set_pinned(
    State(state): State<SharedState>,
    Path(id): Path<u64>,
    Json(request): Json<PinRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut queue = state.queue.lock().expect("queue lock");
    if queue.set_pinned(id, request.pinned) {
        (StatusCode::OK, Json(serde_json::json!({"ok": true})))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"ok": false, "error": "no such entry"})),
        )
    }
}

async fn skip(
    State(state): State<SharedState>,
    Path(id): Path<u64>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut queue = state.queue.lock().expect("queue lock");
    match queue.remove(id) {
        Some(entry) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "entry": entry}))),
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"ok": false, "error": "no such entry"})),
        ),
    }
}

async fn reorder(
    State(state): State<SharedState>,
    Json(request): Json<ReorderRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let mut queue = state.queue.lock().expect("queue lock");
    if queue.reorder(request.id, request.index) {
        (StatusCode::OK, Json(serde_json::json!({"ok": true})))
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"ok": false, "error": "no such entry"})),
        )
    }
}

async fn get_captions(
    State(state): State<SharedState>,
    Path(hash): Path<String>,
    Query(query): Query<CaptionQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    let language = query.language.unwrap_or_else(|| "en".to_string());
    let kind = query
        .kind
        .as_deref()
        .and_then(CaptionKind::from_str)
        .unwrap_or(CaptionKind::Auto);
    match state.cache.get_caption(&hash, &language, kind) {
        Ok(Some(caption)) => (StatusCode::OK, Json(serde_json::json!({"caption": caption}))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "no caption cached"})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

/// Store a caption set - the write-back path for the transcription
/// worker.
async fn store_caption(
    State(state): State<SharedState>,
    Path(hash): Path<String>,
    Json(request): Json<StoreCaptionRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    let kind = CaptionKind::from_str(&request.kind).unwrap_or(CaptionKind::Auto);
    let stream = Stream {
        hash: hash.clone(),
        url: request.url.clone().unwrap_or_default(),
        title: request.title.clone(),
        source_type: request.source_type.clone().unwrap_or_else(|| "local".to_string()),
        duration: request.duration,
        added_at: chrono::Utc::now().timestamp(),
    };
    let caption = Caption {
        id: 0,
        stream_hash: hash,
        language: request.language.clone(),
        kind,
        created_at: chrono::Utc::now().timestamp(),
        lines: request
            .lines
            .iter()
            .enumerate()
            .map(|(i, line)| CaptionLine {
                index: line.index.unwrap_or(i),
                start: line.start,
                end: line.end,
                text: line.text.clone(),
                translation: line.translation.clone(),
            })
            .collect(),
    };
    match store_caption_in(&state.cache, &stream, &caption) {
        Ok(id) => (
            StatusCode::CREATED,
            Json(serde_json::json!({"ok": true, "id": id, "lines": caption.lines.len()})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"ok": false, "error": e})),
        ),
    }
}

async fn caption_exists(
    State(state): State<SharedState>,
    Path(hash): Path<String>,
    Query(query): Query<CaptionQuery>,
) -> (StatusCode, Json<serde_json::Value>) {
    let language = query.language.unwrap_or_else(|| "en".to_string());
    let kind = query
        .kind
        .as_deref()
        .and_then(CaptionKind::from_str)
        .unwrap_or(CaptionKind::Auto);
    match state.cache.has_caption(&hash, &language, kind) {
        Ok(exists) => (StatusCode::OK, Json(serde_json::json!({"exists": exists}))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

/// Store a caption set (used by the ASR worker writing results back).
pub fn store_caption_in(
    cache: &CaptionCache,
    stream: &Stream,
    caption: &Caption,
) -> Result<i64, String> {
    cache.upsert_stream(stream)?;
    cache.put_caption(caption)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cueloop::sources::LocalFileHandler;
    use tower::ServiceExt;

    fn state() -> SharedState {
        let mut handlers = HandlerRegistry::new();
        handlers.register(Box::new(LocalFileHandler::new(None)));
        Arc::new(DaemonState {
            queue: Mutex::new(QueueStore::new()),
            cache: CaptionCache::open_in_memory().unwrap(),
            handlers,
        })
    }

    #[tokio::test]
    async fn enqueue_and_take_next() {
        let state = state();
        let app = router(state.clone());
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::post("/queue")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"url":"file:///a.mp4","title":"A"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .oneshot(
                axum::http::Request::get("/queue/next")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["next"]["source"]["title"], "A");
    }

    #[tokio::test]
    async fn pin_and_skip() {
        let state = state();
        let mut queue = state.queue.lock().unwrap();
        let entry = queue.enqueue(
            StreamSource {
                url: "file:///a.mp4".to_string(),
                ..Default::default()
            },
            None,
            None,
            0,
        );
        let id = entry.id;
        drop(queue);

        let app = router(state);
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::post(format!("/queue/{id}/pin"))
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(r#"{"pinned":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                axum::http::Request::delete(format!("/queue/{id}"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn worker_writes_a_caption_back_and_it_is_served() {
        let state = state();
        let app = router(state.clone());
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::post("/captions/h9")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from(
                        r#"{"url":"file:///a.mp4","language":"en","kind":"auto",
                             "lines":[{"start":0.0,"end":1.5,"text":"hola"}]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .clone()
            .oneshot(
                axum::http::Request::get("/captions/h9")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["caption"]["lines"][0]["text"], "hola");

        let response = app
            .oneshot(
                axum::http::Request::get("/captions/h9/exists")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["exists"], true);
    }

    #[tokio::test]
    async fn captions_are_served_from_the_cache() {
        let state = state();
        let stream = Stream {
            hash: "h1".to_string(),
            url: "file:///a.mp4".to_string(),
            title: None,
            source_type: "local".to_string(),
            duration: None,
            added_at: 0,
        };
        let caption = Caption {
            id: 0,
            stream_hash: "h1".to_string(),
            language: "en".to_string(),
            kind: CaptionKind::Auto,
            created_at: 0,
            lines: vec![],
        };
        store_caption_in(&state.cache, &stream, &caption).unwrap();

        let app = router(state);
        let response = app
            .clone()
            .oneshot(
                axum::http::Request::get("/captions/h1")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                axum::http::Request::get("/captions/nope")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }
}
