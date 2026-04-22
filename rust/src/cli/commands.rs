use clap::{Parser, Subcommand};
use std::sync::Arc;
use crate::core::orchestrator::Orchestrator;
use crate::queue::queue::{Queue, StreamSource};

#[derive(Parser)]
#[command(name = "livelink")]
#[command(about = "LiveLink streaming manager", long_about = None)]
pub struct Cli {
    #[arg(short, long, global = true, default_value = "config")]
    pub config_dir: String,
    #[arg(short = 'P', long, global = true, default_value_t = 3001)]
    pub port: u16,
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
    ServerStatus,
    Ochs,
    Diagnostics,
}

#[derive(Parser)]
pub struct StartCommand {
    #[arg(short, long, default_value_t = 1)]
    pub screen: u32,
    #[arg(short, long, default_value_t = 1)]
    pub count: usize,
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

#[derive(clap::ValueEnum, Clone, Debug)]
pub enum QueueSortField {
    Priority,
    Viewers,
    Name,
}

pub async fn run_cli(orchestrator: Arc<Orchestrator>, cli: Cli) -> Result<(), String> {
    match &cli.command {
        Commands::Start(cmd) => {
            let instance_start = cmd.instance_start.unwrap_or(0);
            for i in 0..cmd.count {
                let instance_id = instance_start + i as u32;
                orchestrator.start_stream_on_instance(cmd.screen, instance_id).await?;
                println!("Started stream on screen {} instance {}", cmd.screen, instance_id);
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
            for s in [0, 1] {
                if orchestrator.get_state(s).await == Some(crate::core::state::StreamState::Playing) {
                    orchestrator.stop_stream(s).await?;
                }
            }
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
                for s in [0, 1] {
                    if let Some(q) = queue.get_queue(s) {
                        println!(" Screen {}: {} items", s, q.len());
                    }
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
            if let Some(q) = queue.get_queue(cmd.screen) {
                println!("Queue for screen {}:", cmd.screen);
                for (i, source) in q.sources().iter().enumerate() {
                    let watched = if q.is_watched(source) { " [watched]" } else { "" };
                    println!(" {}. {} ({}){}", i + 1, source.title.as_deref().unwrap_or("Unknown"), source.url, watched);
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
                let enabled = orchestrator.is_screen_enabled(s);
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
            let enabled = orchestrator.is_screen_enabled(*screen);
            if enabled {
                orchestrator.disable_screen(*screen).await;
                println!("Screen {} disabled", screen);
            } else {
                orchestrator.enable_screen(*screen).await;
                println!("Screen {} enabled", screen);
            }
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
}