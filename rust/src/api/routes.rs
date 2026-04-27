use axum::{
  extract::State,
  http::StatusCode,
  response::Json,
  routing::{get, post},
  Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::core::orchestrator::Orchestrator;
use crate::core::state::StreamState;
use crate::services::holodex::QueryOptions;

#[derive(Clone)]
struct AppState {
    orchestrator: Arc<Orchestrator>,
}

#[derive(Serialize)]
struct ScreenStatus {
    screen: u32,
    state: StreamState,
    active_streams: usize,
    max_streams: usize,
}

#[derive(Serialize)]
struct StatusResponse {
    screens: Vec<ScreenStatus>,
    total_active: usize,
    max_streams: usize,
}

#[derive(Deserialize)]
pub struct StartRequest {
    screen: u32,
}

#[derive(Deserialize)]
pub struct StopRequest {
    screen: u32,
}

#[derive(Deserialize)]
pub struct ClearWatchedRequest {
  pub screen: Option<u32>,
}

#[derive(Deserialize)]
pub struct QueryRequest {
  pub search: Option<String>,
  pub category: Option<String>,
  pub tag: Option<String>,
  pub video_type: Option<String>,
  pub status: Option<String>,
  pub platform: Option<String>,
  pub limit: Option<u32>,
}

#[derive(Serialize)]
struct QueueInfo {
    screen: u32,
    count: usize,
    watched_count: usize,
}

async fn get_status(State(state): State<AppState>) -> Json<StatusResponse> {
    let active = state.orchestrator.count_active_streams();
    let screens = vec![
        ScreenStatus {
            screen: 0,
            state: state.orchestrator.get_state(0).await.unwrap_or(StreamState::Idle),
            active_streams: active,
            max_streams: 2,
        },
        ScreenStatus {
            screen: 1,
            state: state.orchestrator.get_state(1).await.unwrap_or(StreamState::Idle),
            active_streams: active,
            max_streams: 2,
        },
    ];

    Json(StatusResponse {
        screens,
        total_active: active,
        max_streams: 2,
    })
}

async fn start_stream(
    State(state): State<AppState>,
    Json(req): Json<StartRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    state
        .orchestrator
        .start_stream(req.screen)
        .await
        .map_err(|_e| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({
        "success": true,
        "screen": req.screen
    })))
}

async fn stop_stream(
    State(state): State<AppState>,
    Json(req): Json<StopRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    state
        .orchestrator
        .stop_stream(req.screen)
        .await
        .map_err(|_e| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(serde_json::json!({
        "success": true,
        "screen": req.screen
    })))
}

async fn clear_watched(
    State(state): State<AppState>,
    Json(req): Json<ClearWatchedRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match req.screen {
        Some(screen) => {
            state.orchestrator.clear_watched(screen).await;
            Ok(Json(serde_json::json!({
                "success": true,
                "message": format!("Cleared watched history for screen {}", screen)
            })))
        }
        None => {
            state.orchestrator.clear_all_watched().await;
            Ok(Json(serde_json::json!({
                "success": true,
                "message": "Cleared all watched history"
            })))
        }
    }
}

async fn get_queues(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let queue_arc = state.orchestrator.get_queue();
  let queue_service = queue_arc.lock().await;
  let queues: Vec<QueueInfo> = queue_service
    .get_all_queues()
    .iter()
    .map(|(screen, q)| QueueInfo {
      screen: *screen,
      count: q.len(),
      watched_count: q.get_watched_count(),
    })
    .collect();

  Json(serde_json::json!({
    "queues": queues
  }))
}

async fn query_streams(
  State(state): State<AppState>,
  Json(req): Json<QueryRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
  let options = QueryOptions {
    search: req.search,
    category: req.category,
    tag: req.tag,
    video_type: req.video_type,
    status: req.status,
    platform: req.platform,
    limit: req.limit,
  };

  match state.orchestrator.query_streams(options).await {
    Ok(streams) => {
      let results: Vec<serde_json::Value> = streams
        .iter()
        .map(|s| {
          serde_json::json!({
            "url": s.url,
            "title": s.title,
            "platform": s.platform,
            "channel_id": s.channel_id,
            "channel": s.channel,
            "viewer_count": s.viewer_count,
            "is_live": s.is_live,
          })
        })
        .collect();

      Ok(Json(serde_json::json!({
        "success": true,
        "count": results.len(),
        "results": results
      })))
    }
    Err(e) => Err(StatusCode::NOT_FOUND),
  }
}

pub fn create_router(orchestrator: Arc<Orchestrator>) -> Router {
  let app_state = AppState { orchestrator };

  Router::new()
    .route("/status", get(get_status))
    .route("/stream/start", post(start_stream))
    .route("/stream/stop", post(stop_stream))
    .route("/queue/clear-watched", post(clear_watched))
    .route("/queues", get(get_queues))
    .route("/query", post(query_streams))
    .with_state(app_state)
}