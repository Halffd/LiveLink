//! Headless server mode: orchestrator + API server, no player windows.
//! Used by `livelink` (no-args / `start`) and `livelink-server`.

use crate::api::routes::create_router;
use crate::config::ConfigLoader;
use crate::core::orchestrator::Orchestrator;
use crate::core::state::OrchestratorConfig;
use crate::services::network::{NetworkEvent, NetworkMonitor};
use crate::services::transcript::TranscriptWorker;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Build the orchestrator from config: register screens, populate queues,
/// auto-start streams, and start the transcript worker + network monitor.
pub async fn build_orchestrator(
  config_dir: String,
  mpv_config_dir: String,
  debug: bool,
  log_level: String,
  log_file: String,
  log_dir: String,
) -> Result<(Arc<Orchestrator>, tokio::sync::mpsc::UnboundedSender<(u32, String)>), String> {
  let loader = ConfigLoader::with_base_path(&config_dir);
  let config = loader.load();


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
    mpv_debug: false,
    player_debug: false,
    log_level,
    log_file,
    log_dir,
    screens: config.player.screens,
    filters: config.filters,
    auto_refresh_interval_seconds: config.player.auto_refresh_interval_seconds,
    watched_clear_hours: config.player.watched_clear_hours,
    use_locks: config.player.use_locks,
    mpv_youtube_cookies: config.player.mpv_youtube_cookies,
    daemon: config.player.daemon,
  };

  let orchestrator = Orchestrator::new(orchestrator_config, exit_rx, network_receiver);

  for screen_cfg in orchestrator.config.screens.iter().filter(|s| s.enabled) {
    orchestrator.register_screen(screen_cfg.screen).await;
  }

  let (transcribe_tx, transcribe_rx) =
    tokio::sync::mpsc::unbounded_channel::<(u32, String)>();
  {
    let transcript_worker = TranscriptWorker::new(
      config.transcript.clone(),
      std::path::Path::new(&config_dir),
    );
    if transcript_worker.config.enabled {
      let worker = transcript_worker.clone();
      let orchestrator_for_transcription = orchestrator.clone();
      tokio::spawn(async move {
        worker.run(&orchestrator_for_transcription, transcribe_rx).await;
      });
    }
  }

  tokio::spawn(async move {
    network_monitor.start().await;
  });

  Ok((orchestrator, transcribe_tx))
}

/// Populate all screens and auto-start enabled ones, per main.rs behavior.
pub async fn populate_and_autostart(
  orchestrator: &Arc<Orchestrator>,
  screen_configs: &[crate::config::ScreenConfig],
) -> Result<(), String> {
  if let Err(e) = orchestrator.populate_all_screens(screen_configs).await {
    return Err(format!("failed to populate screens: {e}"));
  }
  for screen_config in screen_configs {
    if screen_config.enabled && screen_config.auto_start {
      if let Err(e) = orchestrator.start_stream(screen_config.screen).await {
        return Err(format!(
          "failed to auto-start screen {}: {e}",
          screen_config.screen
        ));
      }
    }
  }
  Ok(())
}

/// Bind the API server and serve until shutdown signal (SIGTERM/SIGINT/Ctrl-C).
pub async fn serve_api(
  orchestrator: Arc<Orchestrator>,
  transcribe_tx: tokio::sync::mpsc::UnboundedSender<(u32, String)>,
  port: u16,
) -> Result<(), String> {
  let app = create_router(orchestrator, Some(transcribe_tx));

  let addr = format!("0.0.0.0:{}", port);
  let listener = tokio::net::TcpListener::bind(&addr)
    .await
    .map_err(|e| format!("failed to bind API server on {addr}: {e}"))?;

  let shutdown_signal = async move {
    #[cfg(unix)]
    {
      use tokio::signal::unix::{signal, SignalKind};
      let mut sigterm = signal(SignalKind::terminate())
        .expect("Failed to install SIGTERM handler");
      let mut sigint = signal(SignalKind::interrupt())
        .expect("Failed to install SIGINT handler");
      tokio::select! {
        _ = sigterm.recv() => {},
        _ = sigint.recv() => {},
        _ = tokio::signal::ctrl_c() => {},
      }
    }
    #[cfg(not(unix))]
    {
      tokio::signal::ctrl_c().await.ok();
    }
  };

  axum::serve(listener, app)
    .with_graceful_shutdown(shutdown_signal)
    .await
    .map_err(|e| format!("API server error: {e}"))?;
  Ok(())
}

