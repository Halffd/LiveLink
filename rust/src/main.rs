mod api;
mod cli;
mod config;
mod core;
mod queue;
mod services;

#[cfg(test)]
mod core_test;

use config::{ConfigLoader, Env};
use core::orchestrator::Orchestrator;
use core::state::OrchestratorConfig;
use services::network::{NetworkEvent, NetworkMonitor};
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

    let _env = Env::load();

    let loader = ConfigLoader::new();
    let config = loader.load();

    info!(
        max_streams = config.player.max_streams,
        "Configuration loaded"
    );

    let (network_sender, network_receiver) = mpsc::channel::<NetworkEvent>(100);
    let (_exit_tx, exit_rx) = mpsc::channel(100);

    let network_monitor = NetworkMonitor::new(network_sender);

    let orchestrator_config = OrchestratorConfig {
        max_streams: config.player.max_streams,
        startup_cooldown_ms: 5000,
        crash_threshold_seconds: 3,
        favorite_channels: config.favorite_channels.clone(),
        holodex_api_key: config.holodex.api_key,
        twitch_client_id: config.twitch.client_id,
        twitch_client_secret: config.twitch.client_secret,
        youtube_api_key: config.youtube.api_key,
    };

    let orchestrator = Arc::new(Orchestrator::new(orchestrator_config, exit_rx, network_receiver));

    tokio::spawn(async move {
        network_monitor.start().await;
    });

    orchestrator.register_screen(0).await;
    orchestrator.register_screen(1).await;

    let sources = orchestrator.fetch_streams_for_screen(0).await;
    if !sources.is_empty() {
        orchestrator.set_queue(0, sources).await;
    }

    info!("LiveLink initialized");
    info!("Active streams: {}", orchestrator.count_active_streams());

    if std::env::args().len() > 1 {
        let cli = cli::commands::parse_cli();
        if let Err(e) = cli::commands::run_cli(orchestrator.clone(), cli).await {
            eprintln!("CLI error: {}", e);
        }
    } else {
        let orchestrator_for_api = orchestrator.clone();
        let app = api::routes::create_router(orchestrator_for_api);

        let port = 3001;
        let addr = format!("0.0.0.0:{}", port);
        info!("Starting API server on {}", addr);

        let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    }

    info!("LiveLink shutting down");
}