mod api;
mod cli;
mod config;
mod core;
mod queue;
mod services;
mod ui;

#[cfg(test)]
mod core_test;

use config::{ConfigLoader, Env};
use core::orchestrator::Orchestrator;
use core::state::OrchestratorConfig;
use services::network::{NetworkEvent, NetworkMonitor};
use tracing::{debug, info};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tokio::sync::mpsc;
use std::path::PathBuf;

fn setup_logging() {
    let log_dir = std::env::var("LIVELINK_LOG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("logs"));

    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = RollingFileAppender::new(
        Rotation::DAILY,
        &log_dir,
        "livelink.log",
    );

    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let base_filter = if std::env::var("RUST_LOG").is_ok() {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
    } else {
        EnvFilter::new("warn,livelink=debug,services=debug,core=debug,queue=debug,config=debug,orchestrator=debug,api=debug,cli=debug,ui=debug")
    };

    let env_filter = base_filter
        .add_directive("reqwest::connect=warn".parse().unwrap())
        .add_directive("reqwest::response=warn".parse().unwrap())
        .add_directive("rustls::=warn".parse().unwrap())
        .add_directive("hyper::=warn".parse().unwrap())
        .add_directive("h2::=warn".parse().unwrap())
        .add_directive("tower::=warn".parse().unwrap())
        .add_directive("tonic::=warn".parse().unwrap())
        .add_directive("ureq::=warn".parse().unwrap())
        .add_directive("tower_layer::=warn".parse().unwrap())
        .add_directive("want::=warn".parse().unwrap());

    let file_layer = fmt::layer()
        .with_writer(non_blocking)
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true);

    let console_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(true)
        .with_file(true)
        .with_line_number(true);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(console_layer)
        .init();

    Box::leak(Box::new(_guard));

    info!(log_dir = %log_dir.display(), log_file = "livelink.log", "Logging initialized");
}

#[tokio::main]
async fn main() {
    setup_logging();

    info!("LiveLink starting...");

let has_cli_args = std::env::args().len() > 1;
  let (mpv_config_dir, config_dir, port, debug, mpv_debug, player_debug, log_level, log_file, log_dir) = if has_cli_args {
    let cli = cli::commands::parse_cli();
    (
      cli.mpv_config_dir.clone(),
      cli.config_dir.clone(),
      cli.port,
      cli.debug,
      cli.mpv_debug,
      cli.player_debug,
      cli.log_level.unwrap_or_else(|| "info".to_string()),
      cli.log_file.unwrap_or_else(|| "player.log".to_string()),
      cli.log_dir.unwrap_or_else(|| "logs".to_string()),
    )
  } else {
    ("mpv_config".to_string(), "config".to_string(), 3001u16, false, false, false, "info".to_string(), "player.log".to_string(), "logs".to_string())
  };

let _env = Env::load();

    debug!(
        holodex_api_key = if _env.holodex_api_key.is_empty() { "not set" } else { "***" },
        twitch_client_id = if _env.twitch_client_id.is_empty() { "not set" } else { "***" },
        youtube_api_key = if _env.youtube_api_key.is_some() { "***" } else { "not set" },
        "Environment variables loaded"
    );

    let loader = ConfigLoader::with_base_path(&config_dir);
    let config = loader.load();

    debug!(
        config_dir = %config_dir,
        config_holodex_api_key = if config.holodex.api_key.is_empty() { "not set" } else { "***" },
        config_twitch_client_id = if config.twitch.client_id.is_empty() { "not set" } else { "***" },
        "Configuration loaded"
    );

    let (network_sender, network_receiver) = mpsc::channel::<NetworkEvent>(100);
    let (_exit_tx, exit_rx) = mpsc::channel(100);

    let network_monitor = NetworkMonitor::new(network_sender);

    let orchestrator_config = OrchestratorConfig {
        max_streams: config.player.max_streams,
        startup_cooldown_ms: 5000,
        crash_threshold_seconds: 3,
        skip_threshold_seconds: 2,
        favorite_channels: config.favorite_channels.clone(),
        holodex_api_key: config.holodex.api_key,
        twitch_client_id: config.twitch.client_id,
        twitch_client_secret: config.twitch.client_secret,
        youtube_api_key: config.youtube.api_key,
        mpv_ipc_dir: mpv_config_dir,
        mpv_gpu_context: config.mpv.gpu_context.clone(),
        mpv_priority: config.mpv.priority.clone(),
        mpv_extra_args: config.mpv.to_args(),
        streamlink_path: config.streamlink.path,
        streamlink_options: config.streamlink.options,
        vlc_path: config.vlc.path,
        player_type: config.player.player_type,
        default_volume: config.player.default_volume,
        default_quality: config.player.default_quality,
        window_maximized: config.player.window_maximized,
        debug,
        mpv_debug,
        player_debug,
        log_level,
        log_file,
        log_dir,
        screens: config.player.screens,
        filters: config.filters,
    };

    let orchestrator = Orchestrator::new(orchestrator_config, exit_rx, network_receiver);

    tokio::spawn(async move {
        network_monitor.start().await;
    });

orchestrator.register_screen(0).await;
  orchestrator.register_screen(1).await;

  let sources_0 = orchestrator.fetch_streams_for_screen(0).await;
  if !sources_0.is_empty() {
    orchestrator.set_queue(0, sources_0).await;
  }

  let sources_1 = orchestrator.fetch_streams_for_screen(1).await;
  if !sources_1.is_empty() {
    orchestrator.set_queue(1, sources_1).await;
  }

info!("LiveLink initialized");
  info!("Active streams: {}", orchestrator.count_active_streams());

  if has_cli_args {
    let cli = cli::commands::parse_cli();

    let run_server_after = matches!(
      cli.command,
      cli::commands::Commands::Start(_) | cli::commands::Commands::StreamStart(_)
    );

    let cli_is_read_only = matches!(
      cli.command,
      cli::commands::Commands::StreamList(_)
        | cli::commands::Commands::QueueShow(_)
        | cli::commands::Commands::List(_)
        | cli::commands::Commands::SessionList
        | cli::commands::Commands::ScreenList
        | cli::commands::Commands::ServerStatus
        | cli::commands::Commands::Diagnostics
        | cli::commands::Commands::Ochs
    );

    if cli_is_read_only {
      let addr = format!("http://localhost:{}/api/queues", port);
      match reqwest::get(&addr).await {
        Ok(resp) if resp.status() == 200 => {
          match resp.text().await {
            Ok(body) => {
              println!("Connected to running server on port {}", port);
              println!("{}", body);
              return;
            }
            Err(_) => {}
          }
        }
        _ => {}
      }
      eprintln!("No server running on port {}. Starting one...", port);
    }

    if let Err(e) = cli::commands::run_cli(orchestrator.clone(), cli).await {
      eprintln!("CLI error: {}", e);
    }

    if !run_server_after {
      return;
    }
  }

  let orchestrator_for_api = orchestrator.clone();
        let app = api::routes::create_router(orchestrator_for_api);

        let addr = format!("0.0.0.0:{}", port);
        info!("Starting API server on {}", addr);

let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
  axum::serve(listener, app).await.unwrap();

    info!("LiveLink shutting down");
}