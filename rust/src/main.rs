mod api;
mod cli;
mod core;
mod queue;
mod services;

#[cfg(test)]
mod core_test;

use core::orchestrator::Orchestrator;
use core::state::OrchestratorConfig;
use services::player::ProcessExit;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;
use tokio::sync::mpsc;
use std::sync::Arc;

#[tokio::main]
async fn main() {
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::DEBUG)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true)
        .finish();

    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set tracing subscriber");

    info!("LiveLink starting...");

    let config = OrchestratorConfig {
        max_streams: 2,
        startup_cooldown_ms: 5000,
        crash_threshold_seconds: 3,
        ..Default::default()
    };

    let (_exit_tx, exit_rx) = mpsc::channel(100);
    let orchestrator = Arc::new(Orchestrator::new(config, exit_rx));

    orchestrator.register_screen(0).await;
    orchestrator.register_screen(1).await;

    let sources = vec![
        queue::queue::StreamSource {
            url: "https://twitch.tv/channel1".to_string(),
            title: Some("Test Stream 1".to_string()),
            platform: Some("twitch".to_string()),
            viewer_count: Some(100),
            priority: Some(1),
            is_live: true,
            ..Default::default()
        },
        queue::queue::StreamSource {
            url: "https://twitch.tv/channel2".to_string(),
            title: Some("Test Stream 2".to_string()),
            platform: Some("twitch".to_string()),
            viewer_count: Some(200),
            priority: Some(2),
            is_live: true,
            ..Default::default()
        },
    ];

    orchestrator.set_queue(0, sources).await;

    info!("LiveLink initialized");
    info!("Active streams: {}", orchestrator.count_active_streams());

    if std::env::args().len() > 1 {
        let cli = cli::commands::parse_cli();
        if let Err(e) = cli::commands::run_cli(orchestrator.clone(), cli).await {
            eprintln!("CLI error: {}", e);
        }
    } else {
        info!("No CLI command specified, running in server mode");
        tokio::signal::ctrl_c().await.ok();
    }

    info!("LiveLink shutting down");
}