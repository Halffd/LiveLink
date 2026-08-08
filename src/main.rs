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
use tracing::{debug, info, warn, error};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tokio::sync::mpsc;
use std::path::PathBuf;

fn setup_logging(debug: bool, log_level: Option<String>, log_file: String, log_dir: String) {
    let log_dir = PathBuf::from(log_dir);

    std::fs::create_dir_all(&log_dir).ok();

    let file_appender = RollingFileAppender::new(
        Rotation::DAILY,
        &log_dir,
        &log_file,
    );

    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let log_level = if debug {
        "debug"
    } else {
        log_level.as_deref().unwrap_or("info")
    };

    let base_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(log_level));

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
          cli.log_level,
          cli.log_file.unwrap_or_else(|| "player.log".to_string()),
          cli.log_dir.unwrap_or_else(|| "logs".to_string()),
        )
    } else {
        ("mpv_config".to_string(), "config".to_string(), 3001u16, false, false, false, None, "player.log".to_string(), "logs".to_string())
    };

    setup_logging(debug, log_level.clone(), log_file.clone(), log_dir.clone());

    info!("LiveLink starting...");

    let loader = ConfigLoader::with_base_path(&config_dir);
    let config = loader.load();

    // Clone screens for later auto-start
    let screen_configs = config.player.screens.clone();

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
log_level: log_level.unwrap_or_else(|| "info".to_string()),
        log_file,
        log_dir,
        screens: config.player.screens,
        filters: config.filters,
        auto_refresh_interval_seconds: config.player.auto_refresh_interval_seconds,
        watched_clear_hours: config.player.watched_clear_hours,
        use_locks: config.player.use_locks,
    };

    let orchestrator = Orchestrator::new(orchestrator_config, exit_rx, network_receiver);

    tokio::spawn(async move {
        network_monitor.start().await;
    });

    let cli = if has_cli_args {
        Some(cli::commands::parse_cli())
    } else {
        None
    };

    let (run_server_after, should_auto_start, run_start_command) = match &cli {
        Some(cli) => {
            let is_start_cmd = matches!(cli.command, cli::commands::Commands::Start(_));
            let is_stream_start = matches!(cli.command, cli::commands::Commands::StreamStart(_));
            let run_server_after = is_start_cmd || is_stream_start;
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
            // For Start command: only run manual start logic if explicit --screens or --instances provided
            let start_cmd_has_explicit = if let cli::commands::Commands::Start(cmd) = &cli.command {
                cmd.screens.is_some() || cmd.instances.is_some()
            } else {
                false
            };
            // Auto-start from config: run when no CLI args, or when Start command without explicit args
            let should_auto_start = !cli_is_read_only && (!is_start_cmd || !start_cmd_has_explicit);
            (run_server_after, should_auto_start, is_start_cmd && start_cmd_has_explicit)
        }
        None => (true, true, false),
    };

    // Handle read-only CLI commands that connect to existing server
    if let Some(ref cli) = cli {
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
    }

    // Register screens and start streams based on config (server mode or non-start CLI commands)
    info!("should_auto_start={}, run_server_after={}", should_auto_start, run_server_after);
    if should_auto_start {
        info!("Running auto-start for {} screens", screen_configs.len());
        for screen_config in &screen_configs {
            if screen_config.enabled && screen_config.auto_start {
                info!("Auto-starting screen {} (enabled={}, auto_start={})", screen_config.screen, screen_config.enabled, screen_config.auto_start);
                orchestrator.register_screen(screen_config.screen).await;
                let streams = orchestrator.fetch_streams_for_screen(screen_config.screen).await;
                if !streams.is_empty() {
                    orchestrator.set_queue(screen_config.screen, streams).await;
                    if let Err(e) = orchestrator.start_stream(screen_config.screen).await {
                        warn!(screen = screen_config.screen, error = %e, "Failed to auto-start screen");
                    }
                } else {
                    warn!("No streams available for screen {}", screen_config.screen);
                }
            } else {
                info!("Skipping screen {} (enabled={}, auto_start={})", screen_config.screen, screen_config.enabled, screen_config.auto_start);
            }
        }
    }
    
    info!("Auto-start loop completed");

    // Execute CLI command (Start with explicit args, Stop, etc.)
    if let Some(cli) = cli {
        let is_start_without_explicit = if let cli::commands::Commands::Start(cmd) = &cli.command {
            cmd.screens.is_none() && cmd.instances.is_none()
        } else {
            false
        };
        
        if !is_start_without_explicit {
            info!("Executing CLI command");
            if let Err(e) = cli::commands::run_cli(orchestrator.clone(), cli).await {
                eprintln!("CLI error: {}", e);
            }
        } else {
            info!("Skipping Start command without explicit args (handled by auto-start)");
        }
    }

    info!("run_server_after={}, proceeding to API server", run_server_after);
    if !run_server_after {
        info!("run_server_after is false, returning early");
        return;
    }

    let orchestrator_for_api = orchestrator.clone();
    let app = api::routes::create_router(orchestrator_for_api);

    let addr = format!("0.0.0.0:{}", port);
    info!("Starting API server on {}", addr);

    let shutdown_signal = async move {
        #[cfg(unix)]
        {
            use tokio::signal::unix::{signal, SignalKind};
            let mut sigterm = signal(SignalKind::terminate()).expect("Failed to install SIGTERM handler");
            let mut sigint = signal(SignalKind::interrupt()).expect("Failed to install SIGINT handler");
            tokio::select! {
                _ = sigterm.recv() => info!("Received SIGTERM, shutting down..."),
                _ = sigint.recv() => info!("Received SIGINT, shutting down..."),
                _ = tokio::signal::ctrl_c() => info!("Received Ctrl-C, shutting down..."),
            }
        }
        #[cfg(not(unix))]
        {
            tokio::signal::ctrl_c().await.ok();
            info!("Received Ctrl-C, shutting down...");
        }
        // Immediately stop all players on shutdown signal
        info!("Stopping all players immediately...");
        for s in 0..10 {
            let _ = orchestrator.stop_stream(s).await;
        }
    };

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

// Start the server with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await
        .unwrap();

    info!("LiveLink shutting down");
}
