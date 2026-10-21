use livelink::cli;
use livelink::config::ConfigLoader;
use livelink::core::orchestrator::Orchestrator;
use livelink::core::state::OrchestratorConfig;
use livelink::services::network::{NetworkEvent, NetworkMonitor};
use tracing::{debug, info, warn};
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
        mpv_path: config.mpv.path.clone(),
        mpv_config_dir: config.mpv.config_dir.clone(),
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
        mpv_youtube_cookies: config.player.mpv_youtube_cookies,
    };

    let orchestrator = Orchestrator::new(orchestrator_config, exit_rx, network_receiver);

    // Automatic subtitle generation: submit streams to the .whisper-subs API
    // and attach the generated subs to the player windows. Disabled by config
    // or silently idle when the transcription API is not running.
    let (transcribe_tx, transcribe_rx) =
        tokio::sync::mpsc::unbounded_channel::<(u32, String)>();
    {
        let transcript_worker = livelink::services::transcript::TranscriptWorker::new(
            config.transcript.clone(),
            std::path::Path::new(&config_dir),
        );
        if transcript_worker.config.enabled {
            let worker = transcript_worker.clone();
            let orchestrator_for_transcription = orchestrator.clone();
            tokio::spawn(async move {
                worker
                    .run(&orchestrator_for_transcription, transcribe_rx)
                    .await;
            });
        }
    }

    // Window playback: launch and supervise one player window per enabled
    // screen, so a single `livelink start` boots the whole desktop TV. A
    // closed or crashed window comes back unless the player-ui respawn
    // setting is off.
    if orchestrator.window_playback() {
        for screen in orchestrator
            .config
            .screens
            .iter()
            .filter(|s| s.enabled)
            .map(|s| s.screen)
        {
            tokio::spawn(supervise_player_window(
                screen,
                config_dir.clone(),
                port,
            ));
        }
    }

    // Forward stream changes to standalone player windows listening on the
    // control port convention (DEFAULT_BASE_PORT + screen). Best-effort: no
    // listener on a screen just means there is no player window for it.
    {
        let mut stream_changes = orchestrator.subscribe_stream_changes();
        tokio::spawn(async move {
            loop {
                match stream_changes.recv().await {
                    Ok(event) => {
                        let port = livelink::player_ui::control::DEFAULT_BASE_PORT
                            .saturating_add(u16::try_from(event.screen).unwrap_or(0));
                        let line = match event.kind {
                            livelink::core::orchestrator::StreamChangeKind::Started => {
                                serde_json::json!({"cmd": "play", "url": event.url}).to_string()
                            }
                            livelink::core::orchestrator::StreamChangeKind::Stopped => {
                                serde_json::json!({"cmd": "stop"}).to_string()
                            }
                        };
                        match livelink::player_ui::control::send_command(port, &line).await {
                            Ok(()) => info!(
                                screen = event.screen,
                                kind = ?event.kind,
                                "forwarded stream change to player window"
                            ),
                            Err(e) => debug!(
                                screen = event.screen,
                                error = %e,
                                "no player window listening on control port"
                            ),
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!(skipped = n, "stream change receiver lagged");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    tokio::spawn(async move {
        network_monitor.start().await;
    });

    let cli = if has_cli_args {
        Some(cli::commands::parse_cli())
    } else {
        None
    };

    let (run_server_after, should_auto_start, _run_start_command) = match &cli {
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
            // Auto-start from config: run when no CLI args, or when Start command without explicit args.
            // The standalone player window manages its own playback and must not spawn players.
            let is_player_ui = matches!(cli.command, cli::commands::Commands::PlayerUi(_));
            let should_auto_start =
                !cli_is_read_only && !is_player_ui && (!is_start_cmd || !start_cmd_has_explicit);
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
                    if let Ok(body) = resp.text().await {
                        println!("Connected to running server on port {}", port);
                        println!("{}", body);
                        return;
                    }
                }
                _ => {}
            }
            eprintln!("No server running on port {}. Starting one...", port);
            
            // For read-only commands with no server: populate queues without starting streams
            if cli_is_read_only {
                info!("Populating queues for read-only CLI command");
                if let Err(e) = orchestrator.populate_all_screens(&screen_configs).await {
                    warn!(error = %e, "Failed to populate screens");
                }
            }
        }
    }

    // Register screens and start streams based on config (server mode or non-start CLI commands)
    info!("should_auto_start={}, run_server_after={}", should_auto_start, run_server_after);
    if should_auto_start {
        info!("Running auto-start for {} screens", screen_configs.len());
        
        // First populate all screens with unique streams
        if let Err(e) = orchestrator.populate_all_screens(&screen_configs).await {
            warn!(error = %e, "Failed to populate screens");
        }
        
        // Then start streams for each screen
        for screen_config in &screen_configs {
            if screen_config.enabled && screen_config.auto_start {
                info!("Auto-starting screen {} (enabled={}, auto_start={})", screen_config.screen, screen_config.enabled, screen_config.auto_start);
                if let Err(e) = orchestrator.start_stream(screen_config.screen).await {
                    warn!(screen = screen_config.screen, error = %e, "Failed to auto-start screen");
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
    let app = livelink::api::routes::create_router(orchestrator_for_api, Some(transcribe_tx));

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
        let _ = orchestrator.stop_all_players().await;
    };

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();

// Start the server with graceful shutdown
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal)
        .await
        .unwrap();

    info!("LiveLink shutting down");
}

/// Command line for one supervised player window subprocess.
fn player_window_args(screen: u32, config_dir: &str, server_port: u16) -> Vec<String> {
    vec![
        "player-ui".to_string(),
        "--screen".to_string(),
        screen.to_string(),
        "--config-dir".to_string(),
        config_dir.to_string(),
        "-P".to_string(),
        server_port.to_string(),
    ]
}

/// Keep a screen's player window alive: spawn it, and when it exits respawn it
/// after a short backoff unless the player-ui respawn setting is off.
async fn supervise_player_window(screen: u32, config_dir: String, server_port: u16) {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            warn!(screen, error = %e, "cannot locate livelink binary for player window");
            return;
        }
    };

    loop {
        let args = player_window_args(screen, &config_dir, server_port);
        let mut child = match tokio::process::Command::new(&exe)
            .args(&args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                warn!(screen, error = %e, "failed to launch player window");
                return;
            }
        };

        let status = child.wait().await;
        debug!(screen, status = ?status, "player window exited");

        let respawn = livelink::player_ui::settings::PlayerUiSettings::load(
            std::path::Path::new(&config_dir),
        )
        .respawn;
        if !respawn {
            info!(screen, "player window gone; respawn disabled in settings");
            return;
        }

        warn!(screen, "player window exited; respawning in 2s");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::player_window_args;

    #[test]
    fn player_window_command_targets_the_screen_and_server() {
        let args = player_window_args(2, "/tmp/livelink-cfg", 8789);
        assert_eq!(
            args,
            vec![
                "player-ui".to_string(),
                "--screen".to_string(),
                "2".to_string(),
                "--config-dir".to_string(),
                "/tmp/livelink-cfg".to_string(),
                "-P".to_string(),
                "8789".to_string(),
            ]
        );
    }
}
