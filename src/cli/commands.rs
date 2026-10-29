use clap::{Parser, Subcommand};
use tracing::warn;
use std::sync::Arc;

use std::process::{Command, Stdio};
use tokio::time::{sleep, Duration};

use crate::core::orchestrator::Orchestrator;
use crate::queue::queue::{Queue, StreamSource};
use crate::services::holodex::QueryOptions;

#[derive(Parser)]
#[command(name = "livelink")]
#[command(about = "LiveLink streaming manager", long_about = None)]
pub struct Cli {
  #[arg(short, long, global = true, default_value = "config")]
  pub config_dir: String,
  #[arg(long, global = true, default_value = "mpv_config")]
  pub mpv_config_dir: String,
  #[arg(short = 'P', long, global = true, default_value_t = 3001)]
  pub port: u16,
  #[arg(short = 'd', long, global = true, help = "Enable debug logging")]
  pub debug: bool,
  #[arg(long, global = true, help = "Enable mpv debug output")]
  pub mpv_debug: bool,
  #[arg(long, global = true, help = "Enable player debug output")]
  pub player_debug: bool,
  #[arg(long, global = true, help = "Player log level (error, warn, info, debug, trace)")]
  pub log_level: Option<String>,
  #[arg(long, global = true, help = "Player log file name")]
  pub log_file: Option<String>,
  #[arg(long, global = true, help = "Player log directory")]
  pub log_dir: Option<String>,
  #[command(subcommand)]
  pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
  Start(StartCommand),
  Stop(StopCommand),
  StopAll,
  List(ListCommand),
  SessionCreate { screen: u32 },
  SessionDelete { screen: u32 },
  SessionEnable { screen: u32 },
  SessionDisable { screen: u32 },
  SessionToggle { screen: u32 },
  SessionList,
  StreamList(StreamListCommand),
  StreamStart(StreamStartCommand),
  StreamStop { screen: Option<u32> },
  StreamRestart { screen: Option<u32> },
  StreamRefresh { screen: Option<u32> },
  QueueShow(QueueShowCommand),
  QueueAdd(QueueAddCommand),
  QueueRemove(QueueRemoveCommand),
  QueueClear { screen: u32 },
  QueueWatched { screen: Option<u32> },
  QueueMarkWatched { url: String },
  QueueClearWatched { screen: Option<u32> },
  QueueSort(QueueSortCommand),
  QueueFilter(QueueFilterCommand),
  ScreenList,
  ScreenEnable { screen: u32 },
  ScreenDisable { screen: u32 },
  ScreenToggle { screen: u32 },
  PlayerPause { screen: Option<String> },
  PlayerVolume { volume: u8, screen: Option<String> },
  PlayerSeek { seconds: i64, screen: u32 },
  ChannelNext { screen: u32 },
  ChannelPrev { screen: u32 },
  ChannelMove { from: u32, to: u32 },
  Player(PlayerCommand),
  Download(DownloadCommand),
  Query(QueryCommand),
  ServerStatus,
  Ochs,
  Diagnostics,
  Ui,
  PlayerUi(PlayerUiCommand),
  Subs(SubsCommand),
  Config(ConfigCommand),
}

#[derive(Parser)]
pub struct StartCommand {
    #[arg(short, long, help = "Single screen number")]
    pub screen: Option<u32>,
    #[arg(long, value_delimiter = ',', help = "Multiple screens: --screens 0,1 or --screens 0 --screens 1")]
    pub screens: Option<Vec<u32>>,
    #[arg(short = 'n', long, default_value_t = 1, help = "Number of instances per screen")]
    pub count: usize,
    #[arg(long, help = "Multiple instances per screen: --instances 0,1 or --instances 0 --instances 1")]
    pub instances: Option<Vec<u32>>,
    #[arg(long, help = "Starting instance number (for multiple players per screen)")]
    pub instance_start: Option<u32>,
}

#[derive(Parser)]
pub struct StopCommand {
    pub screen: Option<u32>,
    #[arg(short, long)]
    pub instance: Option<u32>,
}

#[derive(Parser)]
pub struct ListCommand {
    #[arg(short, long, default_value_t = false)]
    pub verbose: bool,
}

#[derive(Parser)]
pub struct StreamListCommand {
    #[arg(short, long)]
    pub screen: Option<u32>,
    #[arg(long, default_value_t = false)]
    pub watch: bool,
}

#[derive(Parser)]
pub struct StreamStartCommand {
    #[arg(long)]
    pub url: String,
    #[arg(short, long, default_value_t = 1)]
    pub screen: u32,
    #[arg(short, long, default_value = "best")]
    pub quality: String,
}

#[derive(Parser)]
pub struct QueueShowCommand {
    #[arg(short, long, default_value_t = 1)]
    pub screen: u32,
}

#[derive(Parser)]
pub struct QueueAddCommand {
    pub screen: u32,
    pub url: String,
    pub title: Option<String>,
}

#[derive(Parser)]
pub struct QueueRemoveCommand {
    pub screen: u32,
    pub indices: Vec<usize>,
}

#[derive(Parser)]
pub struct QueueSortCommand {
    pub screen: u32,
    #[arg(short, long, value_enum, default_value = "priority")]
    pub by: QueueSortField,
    #[arg(short, long, default_value_t = false)]
    pub asc: bool,
}

#[derive(Parser)]
pub struct QueueFilterCommand {
  pub screen: u32,
  #[arg(short, long)]
  pub platform: Option<String>,
  #[arg(short, long)]
  pub min_viewers: Option<u64>,
}

#[derive(Parser)]
pub struct QueryCommand {
  #[arg(help = "Search query text")]
  pub search: Option<String>,
  #[arg(short = 's', long, help = "Search query text")]
  pub query: Option<String>,
  #[arg(long, help = "Filter by category/topic")]
  pub category: Option<String>,
  #[arg(long, help = "Filter by tag")]
  pub tag: Option<String>,
  #[arg(long, help = "Video type: stream, video, clip")]
  pub video_type: Option<String>,
  #[arg(long, help = "Status: live, upcoming, past")]
  pub status: Option<String>,
  #[arg(long, help = "Platform: holodex, twitch, youtube, kick, niconico, bilibili")]
  pub platform: Option<String>,
  #[arg(long, alias = "provider", help = "Platform: holodex, twitch, youtube, kick, niconico, bilibili")]
  pub provider: Option<String>,
  #[arg(short, long, default_value_t = 25, help = "Maximum results")]
  pub limit: u32,
}

/// Subtitle control for player windows: `livelink subs delay 1 +2`,
/// `--by -0.5`, `--reset`, `--all`, plus mode and stack toggles. Commands are
/// delivered to the window's JSON control port (3100 + screen by default).
#[derive(Parser)]
pub struct SubsCommand {
    #[command(subcommand)]
    pub action: SubsAction,
}

#[derive(Subcommand)]
pub enum SubsAction {
    /// Set, nudge, or reset the primary subtitle delay (seconds, ±10).
    Delay {
        #[arg(long, help = "Apply to every configured screen")]
        all: bool,
        #[arg(long, help = "Treat the value as a relative nudge")]
        by: bool,
        #[arg(long, help = "Drop the session override (back to the global default)")]
        reset: bool,
        #[arg(help = "Screen number (omit with --all)")]
        screen: Option<u32>,
        #[arg(help = "Seconds, accepts a sign: +2.5, -0.5, 2")]
        value: Option<String>,
    },
    /// Set the subtitle visibility mode.
    Mode {
        #[arg(long, help = "Apply to every configured screen")]
        all: bool,
        #[arg(long, help = "Screen number (omit with --all)")]
        screen: Option<u32>,
        #[arg(help = "primary-only | secondary-only | stacked | hidden | toggle-secondary")]
        mode: String,
    },
    /// Toggle the stacked secondary subtitle lane.
    ToggleSecondary {
        #[arg(help = "Screen number")]
        screen: u32,
    },
}

#[derive(Parser)]
pub struct PlayerUiCommand {
  #[arg(short, long, default_value_t = 1, help = "Screen number (uses config entry when present)")]
  pub screen: u32,
  #[arg(long, help = "URL to play (repeatable)")]
  pub url: Vec<String>,
  #[arg(help = "Media URL or file to play first")]
  pub media: Option<String>,
  #[arg(help = "Subtitle file/URL attached to every media")]
  pub subs: Option<String>,
  #[arg(help = "More media files/URLs appended to the playlist")]
  pub extra: Vec<String>,
  #[arg(long, help = "Playlist file: one URL per line, '#' starts a comment")]
  pub playlist: Option<String>,
  #[arg(long, help = "Play media files from this directory (sorted by name, not recursive)")]
  pub dir: Option<String>,
  #[arg(long, help = "Resolve stream URLs via streamlink at this quality (best, worst, 720p, ...)")]
  pub quality: Option<String>,
  #[arg(long, help = "Window x position")]
  pub x: Option<i32>,
  #[arg(long, help = "Window y position")]
  pub y: Option<i32>,
  #[arg(long, help = "Window width override")]
  pub width: Option<u32>,
  #[arg(long, help = "Window height override")]
  pub height: Option<u32>,
  #[arg(long, help = "Run borderless (no window decorations)")]
  pub borderless: bool,
  #[arg(long, help = "Rotate video 0, 90, 180, or 270 degrees")]
  pub rotate: Option<u32>,
  #[arg(long, help = "External subtitle file or URL (repeatable, attached to every media)")]
  pub sub: Vec<String>,
  #[arg(long, help = "Disable the JSON control port")]
  pub no_control: bool,
  #[arg(long = "control-port", help = "Control port (default 3100 + screen)")]
  pub control_port: Option<u16>,
  #[arg(long = "ipc-socket", help = "Unix socket path for JSON commands (default /tmp/livelink-player-<screen>.sock; empty string disables)")]
  pub ipc_socket: Option<String>,
  #[arg(long = "no-ipc", help = "Disable the Unix-socket IPC listener")]
  pub no_ipc: bool,
  #[arg(long, help = "Initial playback volume (mpv scale 0-130; overrides saved settings)")]
  pub volume: Option<i64>,
  #[arg(long, help = "Start the window maximized")]
  pub maximized: bool,
  #[arg(long, help = "Disable the LiveLink server URL (no channel surfing)")]
  pub no_server: bool,

}

#[derive(Parser)]
pub struct ConfigCommand {
  #[arg(long, help = "Get all config")]
  pub get: bool,
  #[arg(long, help = "Get config value by key")]
  pub key: Option<String>,
  #[arg(long, help = "Set config value (key=value)")]
  pub set: Option<String>,
  #[arg(long, help = "Save config to files")]
  pub save: bool,
}

#[derive(Parser)]
pub struct PlayerCommand {
  #[arg(long, help = "Show current player")]
  pub show: bool,
  #[arg(long, help = "Set player type (mpv, streamlink, vlc)")]
  pub set: Option<String>,
}

#[derive(Parser)]
pub struct DownloadCommand {
  #[arg(help = "Stream URL to download")]
  pub url: String,
  #[arg(short, long, help = "Output file path")]
  pub output: Option<String>,
  #[arg(short, long, help = "Quality (best, worst, 720p, etc)")]
  pub quality: Option<String>,
}

#[derive(clap::ValueEnum, Clone, Debug)]
pub enum QueueSortField {
    Priority,
    Viewers,
    Name,
}

/// Screens a `subs` command targets: the explicit one, every configured
/// screen with `--all`, or the two default screens when nothing is configured.
fn subs_target_screens(
    configured: &[u32],
    screen: Option<u32>,
    all: bool,
) -> Result<Vec<u32>, String> {
    if all {
        if configured.is_empty() {
            return Ok(vec![0, 1]);
        }
        return Ok(configured.to_vec());
    }
    screen
        .map(|s| vec![s])
        .ok_or_else(|| "specify a screen number or use --all".to_string())
}

/// Deliver one subtitle command to the player window control port.
async fn send_subtitle_command(screen: u32, line: serde_json::Value) -> Result<(), String> {
    let port = crate::player_ui::control::DEFAULT_BASE_PORT + u16::try_from(screen).unwrap_or(0);
    crate::player_ui::control::send_command(port, &line.to_string())
        .await
        .map_err(|e| {
            format!(
                "screen {}: no player window on control port {} ({})",
                screen, port, e
            )
        })?;
    println!("screen {}: {}", screen, line);
    Ok(())
}

/// Body of the `player-ui` command, shared with the standalone
/// `livelink-player` binary. `screens`/`streamlink_path`/`mpv_path` come from
/// the loaded config; `server_port` is the LiveLink server port.
pub async fn run_player_window(
  cmd: &PlayerUiCommand,
  screens: &[crate::config::ScreenConfig],
  streamlink_path: &str,
  mpv_path: &str,
  config_dir: &str,
  server_port: u16,
  daemon: bool,
) -> Result<(), String> {

  if let Some(deg) = cmd.rotate {
    if deg % 90 != 0 || deg > 270 {
      return Err(format!("invalid --rotate {deg}: use 0, 90, 180, or 270"));
    }
  }

  let mut screen_cfg = screens
    .iter()
    .find(|s| s.screen == cmd.screen)
    .cloned()
    .unwrap_or_else(|| crate::player_ui::default_screen_config(cmd.screen));
  if let Some(x) = cmd.x {
    screen_cfg.x = x;
  }
  if let Some(y) = cmd.y {
    screen_cfg.y = y;
  }
  if let Some(w) = cmd.width {
    screen_cfg.width = w;
  }
  if let Some(h) = cmd.height {
    screen_cfg.height = h;
  }

  let mut urls = cmd.url.clone();
  // Positional args: first = media, second = subtitle file, rest = playlist.
  let mut positional = cmd.extra.clone();
  if let Some(media) = &cmd.media {
    positional.insert(0, media.clone());
  }
  let subtitles = match &cmd.subs {
    Some(sub) => {
      let mut subs = cmd.sub.clone();
      subs.push(sub.clone());
      subs
    }
    None => cmd.sub.clone(),
  };
  urls.extend(positional);

  if let Some(ref path) = cmd.playlist {
    let content = std::fs::read_to_string(path)
      .map_err(|e| format!("failed to read playlist {}: {}", path, e))?;
    for line in content.lines() {
      let line = line.trim();
      if !line.is_empty() && !line.starts_with('#') {
        urls.push(line.to_string());
      }
    }
  }
  if let Some(ref dir) = cmd.dir {
    let files = crate::player_ui::playlist_from_dir(std::path::Path::new(dir))?;
    if files.is_empty() {
      return Err(format!("no media files found in {}", dir));
    }
    urls.extend(files);
  }
  if urls.is_empty() {
    println!("No URLs given — the window will wait for a {{\"cmd\":\"play\"}} command");
  }

  let urls = match (cmd.quality.as_deref(), streamlink_path) {
    (Some(quality), path) if !path.is_empty() => {
      let path = path.to_string();
      let quality = quality.to_string();
      futures::future::join_all(urls.iter().map(|url| {
        crate::player_ui::resolve_with_streamlink(&path, url, &quality)
      }))
      .await
    }
    (Some(_), _) => {
      println!("streamlink path not configured — playing URLs directly");
      urls
    }
    (None, _) => urls,
  };

  let position = match (cmd.x, cmd.y) {
    (Some(x), Some(y)) => Some([x as f32, y as f32]),
    (Some(x), None) => Some([x as f32, screen_cfg.y as f32]),
    (None, Some(y)) => Some([screen_cfg.x as f32, y as f32]),
    (None, None) => None,
  };

  let control_port = if cmd.no_control {
    None
  } else {
    Some(cmd.control_port.unwrap_or(
      crate::player_ui::control::DEFAULT_BASE_PORT + u16::try_from(cmd.screen).unwrap_or(0),
    ))
  };
  let ipc_socket = if cmd.no_ipc {
    None
  } else {
    Some(match &cmd.ipc_socket {
      Some(path) if !path.is_empty() => std::path::PathBuf::from(path),
      _ => std::path::PathBuf::from(format!(
        "/tmp/livelink-player-{}.sock",
        cmd.screen
      )),
    })
  };
  if daemon {
    let server_url = format!("http://localhost:{}/status", server_port);
    let mut server_up = false;
    for _ in 0..5 {
      if reqwest::get(&server_url).await.is_ok() {
        server_up = true;
        break;
      }
      sleep(Duration::from_millis(500)).await;
    }
    if !server_up {
      let daemon_name = std::env::current_exe()
        .ok()
        .map(|mut p| {
          p.set_file_name("livelink-server");
          p
        })
        .unwrap_or_else(|| std::path::PathBuf::from("livelink-server"));
      let _ = Command::new(&daemon_name)
        .arg("--config-dir")
        .arg(config_dir)
        .arg("-P")
        .arg(server_port.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn();
      for _ in 0..10 {
        if reqwest::get(&server_url).await.is_ok() {
          server_up = true;
          break;
        }
        sleep(Duration::from_millis(500)).await;
      }
    }
    if !server_up {
      warn!(screen = cmd.screen, "server daemon not reachable on port {server_port}; player will run without channel surfing");
    }
  }


  println!(
    "Launching player for screen {} (close the window to exit){}{}",
    cmd.screen,
    match control_port {
      Some(port) => format!(" on control port {}", port),
      None => " (control disabled)".to_string(),
    },
    match &ipc_socket {
      Some(path) => format!(" on IPC socket {}", path.display()),
      None => " (IPC disabled)".to_string(),
    }
  );
  crate::player_ui::run(crate::player_ui::PlayerWindowConfig {
    screen_cfg,
    playlist: urls,
    subtitles,
    config_dir: std::path::PathBuf::from(config_dir),
    control_port,
    ipc_socket,
    borderless: cmd.borderless,
    position,
    rotate: cmd.rotate.unwrap_or(0),
    server_url: if cmd.no_server {
      None
    } else {
      Some(format!("http://localhost:{}", server_port))
    },
    volume: cmd.volume,
    window_maximized: cmd.maximized,
    screens: screens.iter().map(|s| s.screen).collect(),
    mpv_path: if mpv_path.is_empty() {
      "mpv".to_string()
    } else {
      mpv_path.to_string()
    },
  })

}

pub async fn run_cli(orchestrator: Arc<Orchestrator>, cli: Cli) -> Result<(), String> {
    match &cli.command {
        Commands::Start(cmd) => {
            let screens: Vec<u32> = if let Some(ref screens) = cmd.screens {
                screens.clone()
            } else {
                vec![cmd.screen.unwrap_or(1)]
            };

            let instance_ids: Vec<u32> = if let Some(ref instances) = cmd.instances {
                instances.clone()
            } else {
                let instance_start = cmd.instance_start.unwrap_or(0);
                (instance_start..instance_start + cmd.count as u32).collect()
            };

            for screen in &screens {
                for &instance_id in &instance_ids {
                    orchestrator.start_stream_on_instance(*screen, instance_id).await?;
                    println!("Started stream on screen {} instance {}", screen, instance_id);
                }
            }
        }
        Commands::Stop(cmd) => {
            match (cmd.screen, cmd.instance) {
                (Some(screen), Some(instance)) => {
                    orchestrator.stop_stream_instance(screen, instance).await?;
                    println!("Stopped screen {} instance {}", screen, instance);
                }
                (Some(screen), None) => {
                    orchestrator.stop_stream(screen).await?;
                    println!("Stopped all streams on screen {}", screen);
                }
                (None, _) => {
                    for s in [0, 1] {
                        if orchestrator.get_state(s).await == Some(crate::core::state::StreamState::Playing) {
                            orchestrator.stop_stream(s).await?;
                            println!("Stopped screen {}", s);
                        }
                    }
                }
            }
        }
        Commands::StopAll => {
            orchestrator.stop_all_players().await?;
            println!("Stopped all streams and exiting...");
        }
        Commands::List(cmd) => {
            let queue_arc = orchestrator.get_queue();
            let queue = queue_arc.lock().await;
            println!("Active streams:");
            for s in [0, 1] {
                if orchestrator.get_state(s).await == Some(crate::core::state::StreamState::Playing) {
                    if let Some(q) = queue.get_queue(s) {
                        println!(" Screen {}: {} active", s, q.len());
                        if cmd.verbose {
                            for source in q.sources().iter().take(5) {
                                println!("  - {} ({})", source.title.as_deref().unwrap_or("Unknown"), source.url);
                            }
                        }
                    }
                }
            }
        }
        Commands::SessionCreate { screen } => {
            orchestrator.register_screen(*screen).await;
            println!("Session/screen {} created", screen);
        }
        Commands::SessionDelete { screen } => {
            orchestrator.unregister_screen(*screen).await;
            println!("Session/screen {} deleted", screen);
        }
        Commands::SessionEnable { screen } => {
            orchestrator.enable_screen(*screen).await;
            println!("Session/screen {} enabled", screen);
        }
        Commands::SessionDisable { screen } => {
            orchestrator.disable_screen(*screen).await;
            println!("Session/screen {} disabled", screen);
        }
Commands::SessionToggle { screen } => {
            let enabled = orchestrator.is_screen_enabled(*screen).await;
            if enabled {
                orchestrator.disable_screen(*screen).await;
                println!("Session/screen {} disabled", screen);
            } else {
                orchestrator.enable_screen(*screen).await;
                println!("Session/screen {} enabled", screen);
            }
        }
        Commands::SessionList => {
            for s in 0..10 {
                if orchestrator.get_state(s).await.is_some() {
                    let state = orchestrator.get_state(s).await;
                    let enabled = orchestrator.is_screen_enabled(s).await;
                    println!("Screen {}: {:?} (enabled: {})", s, state, enabled);
                }
            }
        }
        Commands::StreamList(cmd) => {
            let queue_arc = orchestrator.get_queue();
            let queue = queue_arc.lock().await;
            if let Some(s) = cmd.screen {
                if let Some(q) = queue.get_queue(s) {
                    println!("Queue for screen {} ({} items, {} watched):", s, q.len(), q.get_watched_count());
                    for (i, source) in q.sources().iter().enumerate().take(10) {
                        let watched = if q.is_watched(source) { " [watched]" } else { "" };
                        let viewers = source.viewer_count.map(|v| format!("{} viewers", v)).unwrap_or_default();
                        println!(" {}. {} ({}){}{}", i + 1, source.title.as_deref().unwrap_or("Unknown"), source.url, watched, if viewers.is_empty() { String::new() } else { format!(" - {}", viewers) });
                    }
                }
            } else {
                println!("All queues:");
                let queues = queue.get_all_queues();
                for (s, q) in queues {
                    println!(" Screen {}: {} items", s, q.len());
                }
            }
        }
        Commands::StreamStart(cmd) => {
            orchestrator.start_stream(cmd.screen).await?;
            println!("Stream started on screen {}", cmd.screen);
        }
        Commands::StreamStop { screen } => {
            match screen {
                Some(s) => {
                    orchestrator.stop_stream(*s).await?;
                    println!("Stream stopped on screen {}", s);
                }
                None => {
                    for s in [0, 1] {
                        if orchestrator.get_state(s).await == Some(crate::core::state::StreamState::Playing) {
                            orchestrator.stop_stream(s).await?;
                            println!("Stream stopped on screen {}", s);
                        }
                    }
                }
            }
        }
        Commands::StreamRestart { screen } => {
            match screen {
                Some(s) => {
                    orchestrator.stop_stream(*s).await?;
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    orchestrator.start_stream(*s).await?;
                    println!("Stream restarted on screen {}", s);
                }
                None => {
                    for s in [0, 1] {
                        if orchestrator.get_state(s).await == Some(crate::core::state::StreamState::Playing) {
                            orchestrator.stop_stream(s).await?;
                            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                            orchestrator.start_stream(s).await?;
                            println!("Stream restarted on screen {}", s);
                        }
                    }
                }
            }
        }
        Commands::StreamRefresh { screen } => {
            match screen {
                Some(s) => {
                    orchestrator.refresh_queue(*s).await?;
                    println!("Queue refreshed for screen {}", s);
                }
                None => {
                    orchestrator.refresh_all_queues().await?;
                    println!("All queues refreshed");
                }
            }
        }
        Commands::QueueShow(cmd) => {
            let queue_arc = orchestrator.get_queue();
            let queue = queue_arc.lock().await;
            if cmd.screen == 0 {
                println!("All queues:");
                for (s, q) in queue.get_all_queues() {
                    println!(" Screen {}: {} items", s, q.len());
                }
            } else {
                if let Some(q) = queue.get_queue(cmd.screen) {
                    println!("Queue for screen {}:", cmd.screen);
                    for (i, source) in q.sources().iter().enumerate() {
                        let watched = if q.is_watched(source) { " [watched]" } else { "" };
                        println!(" {}. {} ({}){}", i + 1, source.title.as_deref().unwrap_or("Unknown"), source.url, watched);
                    }
                }
            }
        }
        Commands::QueueAdd(cmd) => {
            let source = StreamSource {
                url: cmd.url.clone(),
                title: cmd.title.clone(),
                ..Default::default()
            };
            let queue_arc = orchestrator.get_queue();
            let mut queue = queue_arc.lock().await;
            if let Some(q) = queue.get_queue_mut(cmd.screen) {
                let mut new_sources = q.sources().to_vec();
                new_sources.push(source);
                *q = Queue::with_sources(new_sources);
            }
            println!("Added to queue {}: {}", cmd.screen, cmd.url);
        }
        Commands::QueueRemove(cmd) => {
            let queue_arc = orchestrator.get_queue();
            let mut queue = queue_arc.lock().await;
            if let Some(q) = queue.get_queue_mut(cmd.screen) {
                let mut sources = q.sources().to_vec();
                let mut removed = Vec::new();
                for &idx in &cmd.indices {
                    if idx > 0 && idx <= sources.len() {
                        removed.push(sources.remove(idx - 1).url.clone());
                    }
                }
                *q = Queue::with_sources(sources);
                println!("Removed: {:?}", removed);
            }
        }
        Commands::QueueClear { screen } => {
            let queue_arc = orchestrator.get_queue();
            let mut queue = queue_arc.lock().await;
            queue.clear_queue(*screen);
            println!("Queue {} cleared", screen);
        }
        Commands::QueueWatched { screen } => {
            let queue_arc = orchestrator.get_queue();
            let queue = queue_arc.lock().await;
            match screen {
                Some(s) => {
                    if let Some(q) = queue.get_queue(*s) {
                        println!("Watched streams for screen {}:", s);
                        for source in q.sources().iter().filter(|s| q.is_watched(s)) {
                            println!(" - {} ({})", source.title.as_deref().unwrap_or("Unknown"), source.url);
                        }
                    }
                }
                None => {
                    for s in [0, 1] {
                        if let Some(q) = queue.get_queue(s) {
                            let watched: Vec<_> = q.sources().iter().filter(|s| q.is_watched(s)).collect();
                            if !watched.is_empty() {
                                println!(" Screen {}: {} watched", s, watched.len());
                            }
                        }
                    }
                }
            }
        }
        Commands::QueueMarkWatched { url } => {
            let queue_arc = orchestrator.get_queue();
            let mut queue = queue_arc.lock().await;
            for s in [0, 1] {
                if let Some(q) = queue.get_queue_mut(s) {
                    let source = StreamSource { url: url.clone(), ..Default::default() };
                    q.mark_watched(&source);
                }
            }
            println!("Marked as watched: {}", url);
        }
        Commands::QueueClearWatched { screen } => {
            match screen {
                Some(s) => {
                    orchestrator.clear_watched(*s).await;
                    println!("Cleared watched history for screen {}", s);
                }
                None => {
                    orchestrator.clear_all_watched().await;
                    println!("Cleared all watched history");
                }
            }
        }
        Commands::QueueSort(cmd) => {
            let queue_arc = orchestrator.get_queue();
            let mut queue = queue_arc.lock().await;
            if let Some(q) = queue.get_queue_mut(cmd.screen) {
                match cmd.by {
                    QueueSortField::Priority => q.sort_by_priority(),
                    QueueSortField::Viewers => q.sort_by_viewer_count(cmd.asc),
                    QueueSortField::Name => q.sort_by_name(cmd.asc),
                }
                println!("Queue {} sorted by {:?}", cmd.screen, cmd.by);
            }
        }
        Commands::QueueFilter(cmd) => {
            let queue_arc = orchestrator.get_queue();
            let queue = queue_arc.lock().await;
            if let Some(q) = queue.get_queue(cmd.screen) {
                let filtered: Vec<_> = if let Some(ref p) = cmd.platform {
                    q.filter_by_platform(p)
                } else if let Some(min) = cmd.min_viewers {
                    q.filter_by_viewer_count(Some(min), None)
                } else {
                    q.filter_unwatched()
                };
                println!("Filtered queue {} ({} matching):", cmd.screen, filtered.len());
                for (i, source) in filtered.iter().enumerate().take(10) {
                    println!(" {}. {} ({})", i + 1, source.title.as_deref().unwrap_or("Unknown"), source.url);
                }
            }
        }
        Commands::ScreenList => {
            for s in [0, 1] {
                let state = orchestrator.get_state(s).await;
                let enabled = orchestrator.is_screen_enabled(s).await;
                println!("Screen {}: {:?} (enabled: {})", s, state, enabled);
            }
        }
        Commands::ScreenEnable { screen } => {
            orchestrator.enable_screen(*screen).await;
            println!("Screen {} enabled", screen);
        }
        Commands::ScreenDisable { screen } => {
            orchestrator.disable_screen(*screen).await;
            println!("Screen {} disabled", screen);
        }
        Commands::ScreenToggle { screen } => {
            let enabled = orchestrator.is_screen_enabled(*screen).await;
            if enabled {
                orchestrator.disable_screen(*screen).await;
                println!("Screen {} disabled", screen);
            } else {
                orchestrator.enable_screen(*screen).await;
                println!("Screen {} enabled", screen);
            }
        }
        Commands::ChannelNext { screen } => {
            orchestrator.next_channel(*screen).await?;
            println!("Skipped to next channel on screen {}", screen);
        }
        Commands::ChannelPrev { screen } => {
            orchestrator.prev_channel(*screen).await?;
            println!("Went back to previous channel on screen {}", screen);
        }
        Commands::ChannelMove { from, to } => {
            orchestrator.move_stream(*from, *to).await?;
            println!("Moved stream from screen {} to screen {}", from, to);
        }
        Commands::PlayerPause { screen } => {
            let screens: Vec<u32> = match screen.as_deref() {
                Some("all") => vec![0, 1],
                Some(s) => vec![s.parse().map_err(|_| "Invalid screen number")?],
                None => vec![1],
            };
            for s in screens {
                orchestrator.player_pause(s).await?;
                println!("Paused screen {}", s);
            }
        }
        Commands::PlayerVolume { volume, screen } => {
            let screens: Vec<u32> = match screen.as_deref() {
                Some("all") => vec![0, 1],
                Some(s) => vec![s.parse().map_err(|_| "Invalid screen number")?],
                None => vec![1],
            };
            for s in screens {
                orchestrator.player_set_volume(s, *volume).await?;
                println!("Volume set to {} on screen {}", volume, s);
            }
        }
Commands::PlayerSeek { seconds, screen } => {
    orchestrator.player_seek(*screen, *seconds).await?;
    println!("Seek {}s on screen {}", seconds, screen);
  }
  Commands::Player(cmd) => {
    if cmd.show {
      let player_type = &orchestrator.config.player_type;
      println!("Current player: {}", player_type);
    } else if let Some(ref set) = cmd.set {
      match set.as_str() {
        "mpv" | "streamlink" | "vlc" => {
          println!("Setting player to {} (reload required)", set);
        }
        _ => {
          println!("Invalid player: {}. Use: mpv, streamlink, vlc", set);
        }
      }
} else {
    println!("Usage: livelink player --show | --set <player>");
    println!("  --show  Show current player");
    println!("  --set   Set player type (mpv, streamlink, vlc)");
  }
  }
  Commands::Download(cmd) => {
    let output = cmd.output.clone().unwrap_or_else(|| {
      let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
      format!("stream_{}.mp4", timestamp)
    });
    let quality = cmd.quality.clone().unwrap_or_else(|| "best".to_string());
    println!("Downloading stream to: {}", output);
    println!("Quality: {}", quality);
    println!("URL: {}", cmd.url);
    println!("Use streamlink CLI directly for actual downloads:");
    println!("  streamlink {} {} -o {}", cmd.url, quality, output);
  }
  Commands::Query(cmd) => {
    let search = cmd.search.clone().or(cmd.query.clone());
    let platform = cmd.platform.clone().or(cmd.provider.clone());
    let options = QueryOptions {
      search,
      category: cmd.category.clone(),
      tag: cmd.tag.clone(),
      video_type: cmd.video_type.clone(),
      status: cmd.status.clone(),
      platform,
      limit: Some(cmd.limit),
    };
    match orchestrator.query_streams(options).await {
      Ok(streams) => {
        println!("Found {} streams:", streams.len());
        for (i, stream) in streams.iter().enumerate().take(20) {
          let status = if stream.is_live { "[LIVE]" } else { "" };
          println!(" {}. {} {} - {}", i + 1, status, stream.title.as_deref().unwrap_or("Unknown"), stream.url);
        }
      }
      Err(e) => {
        println!("Query failed: {}", e);
      }
    }
  }
  Commands::ServerStatus => {
            let active = orchestrator.count_active_streams();
            println!("Server status: running");
            println!("Active streams: {}", active);
            println!("Use API at http://localhost:{}", 3001);
        }
        Commands::Ochs => {
            let favorites = orchestrator.get_favorite_channels();
            println!("Organizations (from favorites):");
            println!(" Holodex: {} channels", favorites.holodex.default.len());
            println!(" Twitch: {} channels", favorites.twitch.default.len());
            println!(" YouTube: {} channels", favorites.youtube.default.len());
            println!(" Kick: {} channels", favorites.kick.default.len());
        }
Commands::Diagnostics => {
    let active = orchestrator.count_active_streams();
    let state = orchestrator.get_state(1).await;
    println!("=== LiveLink Diagnostics ===");
    println!("Active streams: {}", active);
    println!("Primary screen state: {:?}", state);
    println!("Network: online");
    println!("Player service: running");
  }
  Commands::Ui => {
    println!("Launching UI...");
    let orch = orchestrator.clone();
    // winit refuses to create an event loop outside the main thread on
    // Linux, so eframe runs inline: the dispatch is already on the main
    // thread and no server runs after a UI session.
    let options = eframe::NativeOptions {
      viewport: eframe::egui::ViewportBuilder::default().with_inner_size([1600.0, 900.0]),
      ..Default::default()
    };
    eframe::run_native(
      "LiveLink",
      options,
      Box::new(|cc| Ok(Box::new(crate::ui::LiveLinkApp::new(orch, cc)))),
    )
    .map_err(|e| format!("UI failed: {e}"))?;
  }
  Commands::PlayerUi(cmd) => {
    run_player_window(
      cmd,
      &orchestrator.config.screens,
      &orchestrator.config.streamlink_path,
      &orchestrator.config.mpv_path,
      &cli.config_dir,
      cli.port,
      orchestrator.config.daemon,
    )
    .await?;
  }
  Commands::Subs(cmd) => {
    let configured: Vec<u32> = orchestrator.config.screens.iter().map(|s| s.screen).collect();
    match &cmd.action {
      SubsAction::Delay { all, by, reset, screen, value } => {
        let line = if *reset {
          serde_json::json!({"cmd": "sub-delay-reset"})
        } else {
          let raw = value.as_deref().ok_or("delay needs a value or --reset")?;
          let secs = crate::core::subtitles::parse_signed_seconds(raw)
            .ok_or_else(|| format!("invalid seconds: {}", raw))?;
          if *by {
            serde_json::json!({"cmd": "sub-delay-by", "value": secs})
          } else {
            serde_json::json!({"cmd": "sub-delay", "value": secs})
          }
        };
        for screen in subs_target_screens(&configured, *screen, *all)? {
          send_subtitle_command(screen, line.clone()).await?;
        }
      }
      SubsAction::Mode { all, screen, mode } => {
        if crate::core::subtitles::SubtitleMode::parse(mode).is_none() {
          return Err(format!(
            "unknown subtitle mode: {} (valid: {})",
            mode,
            crate::core::subtitles::SubtitleMode::names()
          ));
        }
        let line = serde_json::json!({"cmd": "sub-mode", "text": mode});
        for screen in subs_target_screens(&configured, *screen, *all)? {
          send_subtitle_command(screen, line.clone()).await?;
        }
      }
      SubsAction::ToggleSecondary { screen } => {
        send_subtitle_command(*screen, serde_json::json!({"cmd": "sub-toggle-secondary"})).await?;
      }
    }
  }
  Commands::Config(cmd) => {
    if cmd.get {
      let config = orchestrator.get_favorite_channels();
      println!("=== Configuration ===");
      println!("Max Streams: {}", orchestrator.max_streams);
      println!();
      println!("Favorite Channels:");
      println!("  Holodex: {} channels", config.holodex.default.len());
      println!("  Twitch: {} channels", config.twitch.default.len());
      println!("  YouTube: {} channels", config.youtube.default.len());
      println!("  Kick: {} channels", config.kick.default.len());
      println!("  Niconico: {} channels", config.niconico.default.len());
      println!("  Bilibili: {} channels", config.bilibili.default.len());
      println!("  Facebook: {} channels", config.facebook.default.len());
      for ch in config.holodex.default.iter().take(5) {
        println!("    - {}", ch.id);
      }
} else if let Some(ref key) = cmd.key {
    match key.as_str() {
      "max_streams" => println!("max_streams = {}", orchestrator.max_streams),
      "holodex" => println!("holodex = {} channels", orchestrator.get_favorite_channels().holodex.default.len()),
      "twitch" => println!("twitch = {} channels", orchestrator.get_favorite_channels().twitch.default.len()),
      "youtube" => println!("youtube = {} channels", orchestrator.get_favorite_channels().youtube.default.len()),
      "facebook" | "fb" => println!("facebook = {} channels", orchestrator.get_favorite_channels().facebook.default.len()),
      _ => println!("Unknown key: {}", key),
    }
} else if let Some(ref set) = cmd.set {
    let parts: Vec<&str> = set.splitn(2, '=').collect();
    if parts.len() != 2 {
      println!("Invalid format. Use key=value");
    } else {
      let (key, value) = (parts[0], parts[1]);
      println!("Setting {} = {} (reload required)", key, value);
    }
  } else if cmd.save {
    match orchestrator.save_config(&cli.config_dir) {
      Ok(_) => println!("Config saved to {}", cli.config_dir),
      Err(e) => println!("Failed to save config: {}", e),
    }
  } else {
    println!("Usage: livelink config --get | --key <key> | --set <key=value> | --save");
    println!("  --get     Show all config");
    println!("  --key     Get specific config value");
    println!("  --set     Set config value (key=value)");
    println!("  --save    Save current config to files");
  }
  }
  }
  Ok(())
}

pub fn parse_cli() -> Cli {
    Cli::parse()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_stream_list() {
        let cli = Cli::try_parse_from(["livelink", "stream-list"]);
        assert!(cli.is_ok());
    }

    #[test]
    fn test_parse_queue_add() {
        let cli = Cli::try_parse_from(["livelink", "queue-add", "1", "https://twitch.tv/xqc", "XQC"]);
        assert!(cli.is_ok());
    }

    #[test]
    fn test_screen_enable_command() {
        let cli = Cli::try_parse_from(["livelink", "screen-enable", "1"]);
        assert!(cli.is_ok());
        let cli = cli.unwrap();
        match cli.command {
            Commands::ScreenEnable { screen } => assert_eq!(screen, 1),
            _ => panic!("Expected ScreenEnable"),
        }
    }

    #[test]
    fn test_screen_disable_command() {
        let cli = Cli::try_parse_from(["livelink", "screen-disable", "0"]);
        assert!(cli.is_ok());
        let cli = cli.unwrap();
        match cli.command {
            Commands::ScreenDisable { screen } => assert_eq!(screen, 0),
            _ => panic!("Expected ScreenDisable"),
        }
    }

    #[test]
    fn test_screen_toggle_command() {
        let cli = Cli::try_parse_from(["livelink", "screen-toggle", "1"]);
        assert!(cli.is_ok());
        let cli = cli.unwrap();
        match cli.command {
            Commands::ScreenToggle { screen } => assert_eq!(screen, 1),
            _ => panic!("Expected ScreenToggle"),
        }
    }

    #[test]
    fn test_global_config_dir() {
        let cli = Cli::try_parse_from(["livelink", "--config-dir", "/custom/path", "list"]);
        assert!(cli.is_ok());
        let cli = cli.unwrap();
        assert_eq!(cli.config_dir, "/custom/path");
    }

    #[test]
    fn test_global_port() {
        let cli = Cli::try_parse_from(["livelink", "-P", "8080", "list"]);
        assert!(cli.is_ok());
        let cli = cli.unwrap();
        assert_eq!(cli.port, 8080);
    }

    #[test]
    fn test_parse_channel_commands() {
        let cli = Cli::try_parse_from(["livelink", "channel-next", "1"]).unwrap();
        match cli.command {
            Commands::ChannelNext { screen } => assert_eq!(screen, 1),
            _ => panic!("Expected ChannelNext"),
        }

        let cli = Cli::try_parse_from(["livelink", "channel-prev", "1"]).unwrap();
        match cli.command {
            Commands::ChannelPrev { screen } => assert_eq!(screen, 1),
            _ => panic!("Expected ChannelPrev"),
        }

        let cli = Cli::try_parse_from(["livelink", "channel-move", "0", "1"]).unwrap();
        match cli.command {
            Commands::ChannelMove { from, to } => {
                assert_eq!(from, 0);
                assert_eq!(to, 1);
            }
            _ => panic!("Expected ChannelMove"),
        }
    }

    #[test]
    fn test_parse_player_ui_command() {
        let cli = Cli::try_parse_from([
            "livelink",
            "player-ui",
            "--screen",
            "2",
            "--url",
            "https://example.com/live",
            "--url",
            "https://example.com/vod",
            "--playlist",
            "list.txt",
            "--dir",
            "/tmp/media",
            "--quality",
            "720p",
            "--x",
            "100",
            "--y",
            "50",
            "--width",
            "1280",
            "--height",
            "720",
            "--borderless",
            "--rotate",
            "90",
            "--sub",
            "/tmp/subs.srt",
            "--no-control",
            "--control-port",
            "3105",
        ])
        .unwrap_or_else(|e| panic!("parse failed: {e}"));
        match cli.command {
            Commands::PlayerUi(cmd) => {
                assert_eq!(cmd.screen, 2);
                assert_eq!(cmd.url.len(), 2);
                assert_eq!(cmd.playlist.as_deref(), Some("list.txt"));
                assert_eq!(cmd.dir.as_deref(), Some("/tmp/media"));
                assert_eq!(cmd.quality.as_deref(), Some("720p"));
                assert_eq!(cmd.x, Some(100));
                assert_eq!(cmd.y, Some(50));
                assert_eq!(cmd.width, Some(1280));
                assert_eq!(cmd.height, Some(720));
                assert!(cmd.borderless);
                assert_eq!(cmd.rotate, Some(90));
                assert_eq!(cmd.sub, vec!["/tmp/subs.srt".to_string()]);
                assert!(cmd.no_control);
                assert_eq!(cmd.control_port, Some(3105));
            }
            _ => panic!("Expected PlayerUi"),
        }
    }

    #[test]
    fn test_parse_subs_commands() {
        let cli = Cli::try_parse_from(["livelink", "subs", "delay", "1", "+2.5", "--by"])
            .unwrap_or_else(|e| panic!("parse failed: {e}"));
        match cli.command {
            Commands::Subs(cmd) => match cmd.action {
                SubsAction::Delay {
                    screen,
                    value,
                    by,
                    reset,
                    all,
                } => {
                    assert_eq!(screen, Some(1));
                    assert_eq!(value.as_deref(), Some("+2.5"));
                    assert!(by);
                    assert!(!reset);
                    assert!(!all);
                }
                _ => panic!("Expected SubsAction::Delay"),
            },
            _ => panic!("Expected Subs"),
        }

        let cli = Cli::try_parse_from([
            "livelink",
            "subs",
            "mode",
            "--all",
            "stacked",
        ])
            .unwrap_or_else(|e| panic!("parse failed: {e}"));
        match cli.command {
            Commands::Subs(cmd) => match cmd.action {
                SubsAction::Mode { screen, mode, all } => {
                    assert_eq!(screen, None);
                    assert_eq!(mode, "stacked");
                    assert!(all);
                }
                _ => panic!("Expected SubsAction::Mode"),
            },
            _ => panic!("Expected Subs"),
        }

        let cli = Cli::try_parse_from([
            "livelink",
            "subs",
            "toggle-secondary",
            "2",
        ])
        .unwrap_or_else(|e| panic!("parse failed: {e}"));
        match cli.command {
            Commands::Subs(cmd) => match cmd.action {
                SubsAction::ToggleSecondary { screen } => assert_eq!(screen, 2),
                _ => panic!("Expected SubsAction::ToggleSecondary"),
            },
            _ => panic!("Expected Subs"),
        }
    }

    #[test]
    fn subs_target_screens_resolution() {
        assert_eq!(
            subs_target_screens(&[0, 1], Some(1), false).unwrap(),
            vec![1]
        );
        assert_eq!(
            subs_target_screens(&[0, 1], None, true).unwrap(),
            vec![0, 1]
        );
        assert_eq!(subs_target_screens(&[], None, true).unwrap(), vec![0, 1]);
        assert!(subs_target_screens(&[0], None, false).is_err());
    }
}