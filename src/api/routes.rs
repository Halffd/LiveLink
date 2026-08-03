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
use crate::queue::queue::StreamSource;
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

async fn get_streams(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let streams = state.orchestrator.fetch_all_streams_internal().await;
  let mut result = serde_json::Map::new();
  for stream in streams {
    let platform = stream.platform.clone().unwrap_or_else(|| "unknown".to_string());
    let entry = result.entry(platform).or_insert_with(|| serde_json::json!([]));
    if let Some(arr) = entry.as_array_mut() {
      arr.push(serde_json::json!({
        "url": stream.url,
        "title": stream.title,
        "platform": stream.platform,
        "channel_id": stream.channel_id,
        "channel": stream.channel,
        "viewer_count": stream.viewer_count,
        "is_live": stream.is_live,
      }));
    }
  }
  Json(serde_json::Value::Object(result))
}

async fn get_favorites(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let favorites = state.orchestrator.get_favorite_channels();
  Json(serde_json::json!({
    "twitch": favorites.twitch.default,
    "youtube": favorites.youtube.default,
    "holodex": favorites.holodex.default,
    "kick": favorites.kick.default,
    "niconico": favorites.niconico.default,
    "bilibili": favorites.bilibili.default,
    "facebook": favorites.facebook.default,
  }))
}

async fn get_watched(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let queue_arc = state.orchestrator.get_queue();
  let queue_service = queue_arc.lock().await;
  let mut all_watched = Vec::new();
  for (screen, queue) in queue_service.get_all_queues() {
    for source in queue.sources() {
      if queue.is_watched(source) {
        all_watched.push(serde_json::json!({
          "screen": screen,
          "url": source.url,
          "title": source.title,
        }));
      }
    }
  }
  Json(serde_json::json!({
    "watched": all_watched,
    "count": all_watched.len()
  }))
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

async fn get_organizations(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let orgs = state.orchestrator.config.favorite_channels.holodex.default
    .iter()
    .filter_map(|ch| Some(ch.name.clone()))
    .collect::<std::collections::HashSet<_>>()
    .into_iter()
    .collect::<Vec<_>>();
  Json(serde_json::json!(orgs))
}

async fn get_filters(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let filters = &state.orchestrator.config.filters;
  Json(serde_json::json!({
    "enabled": filters.enabled,
    "mode": filters.mode,
    "channel_names": filters.channel_names,
    "title_patterns": filters.title_patterns,
    "exclude_platforms": filters.exclude_platforms,
    "filter_members_only": filters.filter_members_only,
  }))
}

async fn get_screens(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let mut screens = Vec::new();
  for screen_config in &state.orchestrator.config.screens {
    let screen_state = state.orchestrator.get_state(screen_config.screen).await.unwrap_or(StreamState::Idle);
    let enabled = state.orchestrator.is_screen_enabled(screen_config.screen);
    screens.push(serde_json::json!({
      "screen": screen_config.screen,
      "enabled": enabled,
      "state": format!("{:?}", screen_state),
      "sources": screen_config.sources.iter().map(|s| s.type_.clone()).collect::<Vec<_>>(),
    }));
  }
  Json(serde_json::json!({ "screens": screens }))
}

async fn health_check() -> Json<serde_json::Value> {
  Json(serde_json::json!({ "status": "ok", "timestamp": chrono::Utc::now().timestamp() }))
}

#[derive(Deserialize)]
pub struct QueueAddRequest {
  pub screen: u32,
  pub url: String,
  pub title: Option<String>,
}

async fn queue_add(
  State(state): State<AppState>,
  Json(req): Json<QueueAddRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
  let source = StreamSource {
    url: req.url,
    title: req.title,
    ..Default::default()
  };
  state.orchestrator.set_queue(req.screen, vec![source]).await;
  Ok(Json(serde_json::json!({ "success": true })))
}

async fn queue_clear(
  State(state): State<AppState>,
  Json(req): Json<StartRequest>,
) -> Result<Json<serde_json::Value>, StatusCode> {
  state.orchestrator.get_queue().lock().await.clear_queue(req.screen);
  Ok(Json(serde_json::json!({ "success": true })))
}

async fn stop_all(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  for s in 0..10 {
    if state.orchestrator.get_state(s).await == Some(StreamState::Playing) {
      let _ = state.orchestrator.stop_stream(s).await;
    }
  }
  Json(serde_json::json!({ "success": true }))
}

async fn watched_clear(
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

async fn refresh(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  let _ = state.orchestrator.refresh_all_queues().await;
  Json(serde_json::json!({ "success": true }))
}

async fn save_config(
  State(state): State<AppState>,
) -> Json<serde_json::Value> {
  if let Err(e) = state.orchestrator.save_config("config") {
    return Json(serde_json::json!({ "success": false, "error": e }));
  }
  Json(serde_json::json!({ "success": true }))
}

#[derive(Deserialize)]
pub struct ScreenToggleRequest {
  pub screen: u32,
}

async fn screen_enable(
  State(state): State<AppState>,
  Json(req): Json<ScreenToggleRequest>,
) -> Json<serde_json::Value> {
  state.orchestrator.enable_screen(req.screen).await;
  let _ = state.orchestrator.start_stream(req.screen).await;
  Json(serde_json::json!({ "success": true, "enabled": true }))
}

async fn screen_disable(
  State(state): State<AppState>,
  Json(req): Json<ScreenToggleRequest>,
) -> Json<serde_json::Value> {
  state.orchestrator.disable_screen(req.screen).await;
  let _ = state.orchestrator.stop_stream(req.screen).await;
  Json(serde_json::json!({ "success": true, "enabled": false }))
}

async fn screen_toggle(
  State(state): State<AppState>,
  Json(req): Json<ScreenToggleRequest>,
) -> Json<serde_json::Value> {
  let enabled = state.orchestrator.is_screen_enabled(req.screen);
  if enabled {
    state.orchestrator.disable_screen(req.screen).await;
    let _ = state.orchestrator.stop_stream(req.screen).await;
  } else {
    state.orchestrator.enable_screen(req.screen).await;
    let _ = state.orchestrator.start_stream(req.screen).await;
  }
  Json(serde_json::json!({ "success": true, "enabled": !enabled }))
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
    Err(_e) => Err(StatusCode::NOT_FOUND),
  }
}

pub fn create_router(orchestrator: Arc<Orchestrator>) -> Router {
  let app_state = AppState { orchestrator };

  Router::new()
    .route("/status", get(get_status))
    .route("/streams", get(get_streams))
    .route("/favorites", get(get_favorites))
    .route("/watched", get(get_watched))
    .route("/organizations", get(get_organizations))
    .route("/filters", get(get_filters))
    .route("/screens", get(get_screens))
    .route("/health", get(health_check))
    .route("/stream/start", post(start_stream))
    .route("/stream/stop", post(stop_stream))
    .route("/stream/stop-all", post(stop_all))
    .route("/queue/add", post(queue_add))
    .route("/queue/clear", post(queue_clear))
    .route("/queue/clear-watched", post(clear_watched))
    .route("/queues", get(get_queues))
    .route("/watched/clear", post(watched_clear))
    .route("/refresh", post(refresh))
    .route("/save", post(save_config))
    .route("/screen/enable", post(screen_enable))
    .route("/screen/disable", post(screen_disable))
    .route("/screen/toggle", post(screen_toggle))
    .route("/query", post(query_streams))
    .with_state(app_state)
}