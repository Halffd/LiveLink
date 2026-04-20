use clap::{Parser, Subcommand};
use std::sync::Arc;

use crate::core::orchestrator::Orchestrator;

#[derive(Parser)]
#[command(name = "livelink")]
#[command(about = "LiveLink streaming manager", long_about = None)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand)]
pub enum Commands {
    Start {
        #[arg(short, long)]
        screen: u32,
    },
    Stop {
        #[arg(short, long)]
        screen: u32,
    },
    Status {
        #[arg(short, long, default_value_t = false)]
        verbose: bool,
    },
    List {
        #[arg(short, long)]
        screen: Option<u32>,
    },
    ClearWatched {
        #[arg(short, long)]
        screen: Option<u32>,
    },
    Queue {
        #[command(subcommand)]
        command: QueueCommands,
    },
}

#[derive(Subcommand)]
pub enum QueueCommands {
    Sort {
        #[arg(short, long)]
        screen: u32,
        #[arg(value_enum, default_value = "priority")]
        by: SortField,
        #[arg(short, long, default_value_t = false)]
        asc: bool,
    },
    Filter {
        #[arg(short, long)]
        screen: u32,
        #[arg(short, long)]
        platform: Option<String>,
        #[arg(short, long)]
        min_viewers: Option<u64>,
    },
}

#[derive(clap::ValueEnum, Clone, Debug)]
pub enum SortField {
    Priority,
    Viewers,
    Name,
}

pub async fn run_cli(orchestrator: Arc<Orchestrator>, cli: Cli) -> Result<(), String> {
    match cli.command {
        Commands::Start { screen } => {
            orchestrator.start_stream(screen).await?;
            println!("Stream started on screen {}", screen);
        }
        Commands::Stop { screen } => {
            orchestrator.stop_stream(screen).await?;
            println!("Stream stopped on screen {}", screen);
        }
        Commands::Status { verbose } => {
            let active = orchestrator.count_active_streams();
            println!("Active streams: {}", active);
            if verbose {
                for screen in [0, 1] {
                    let state = orchestrator.get_state(screen).await.unwrap_or(crate::core::state::StreamState::Idle);
                    println!(" Screen {}: {}", screen, state);
                }
            }
        }
        Commands::List { screen } => {
            let queue_arc = orchestrator.get_queue();
            let queue = queue_arc.lock().await;
            if let Some(s) = screen {
                if let Some(q) = queue.get_queue(s) {
                    println!("Queue for screen {} ({} items, {} watched):", s, q.len(), q.get_watched_count());
                    for (i, source) in q.sources().iter().enumerate().take(5) {
                        let watched = if q.is_watched(source) { " [watched]" } else { "" };
                        let viewers = source.viewer_count.map(|v| format!("{} viewers", v)).unwrap_or_default();
                        println!(" {}. {} ({}){}{}", i + 1, source.title.as_deref().unwrap_or("Unknown"), source.url, watched, if viewers.is_empty() { String::new() } else { format!(" - {}", viewers) });
                    }
                    if q.len() > 5 {
                        println!(" ... and {} more", q.len() - 5);
                    }
                } else {
                    println!("Screen {} has no queue", s);
                }
            } else {
                println!("All queues:");
                for s in [0, 1] {
                    if let Some(q) = queue.get_queue(s) {
                        println!(" Screen {}: {} items ({} watched)", s, q.len(), q.get_watched_count());
                        if let Some(next) = q.get_next() {
                            let watched = if q.is_watched(next) { " [watched]" } else { "" };
                            println!("   Next: {} ({}){}", next.title.as_deref().unwrap_or("Unknown"), next.url, watched);
                        }
                    }
                }
            }
        }
        Commands::ClearWatched { screen } => {
            match screen {
                Some(s) => {
                    orchestrator.clear_watched(s).await;
                    println!("Cleared watched history for screen {}", s);
                }
                None => {
                    orchestrator.clear_all_watched().await;
                    println!("Cleared all watched history");
                }
            }
        }
        Commands::Queue { command } => {
            match command {
                QueueCommands::Sort { screen, by, asc } => {
                    let queue_arc = orchestrator.get_queue();
                    let mut queue = queue_arc.lock().await;
                    if let Some(q) = queue.get_queue_mut(screen) {
                        match by {
                            SortField::Priority => q.sort_by_priority(),
                            SortField::Viewers => q.sort_by_viewer_count(asc),
                            SortField::Name => q.sort_by_name(asc),
                        }
                        println!("Queue {} sorted by {:?}", screen, by);
                    } else {
                        println!("Screen {} has no queue", screen);
                    }
                }
                QueueCommands::Filter { screen, platform, min_viewers } => {
                    let queue_arc = orchestrator.get_queue();
                    let queue = queue_arc.lock().await;
                    if let Some(q) = queue.get_queue(screen) {
                        let filtered: Vec<_> = if let Some(p) = platform {
                            q.filter_by_platform(&p)
                        } else if let Some(min) = min_viewers {
                            q.filter_by_viewer_count(Some(min), None)
                        } else {
                            q.filter_unwatched()
                        };
                        println!("Filtered queue {} ({} matching):", screen, filtered.len());
                        for (i, source) in filtered.iter().enumerate().take(10) {
                            println!(" {}. {} ({})", i + 1, source.title.as_deref().unwrap_or("Unknown"), source.url);
                        }
                    } else {
                        println!("Screen {} has no queue", screen);
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn parse_cli() -> Cli {
    Cli::parse()
}