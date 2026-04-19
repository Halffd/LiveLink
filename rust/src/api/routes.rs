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

pub fn create_router(orchestrator: Arc<Orchestrator>) -> Router {
    let app_state = AppState { orchestrator };

    Router::new()
        .route("/status", get(get_status))
        .route("/stream/start", post(start_stream))
        .route("/stream/stop", post(stop_stream))
        .with_state(app_state)
}