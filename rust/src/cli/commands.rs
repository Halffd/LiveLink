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
                    println!("  Screen {}: {}", screen, state);
                }
            }
        }
        Commands::List { screen } => {
            let queue_arc = orchestrator.get_queue();
            let queue = queue_arc.lock().await;
            if let Some(s) = screen {
                if let Some(q) = queue.get_queue(s) {
                    println!("Queue for screen {} ({} items):", s, q.len());
                    if let Some(next) = q.get_next() {
                        println!("  Next: {} ({})", next.title.as_deref().unwrap_or("Unknown"), next.url);
                    }
                    if q.len() > 1 {
                        println!("  ... and {} more", q.len() - 1);
                    }
                } else {
                    println!("Screen {} has no queue", s);
                }
            } else {
                println!("All queues:");
                for s in [0, 1] {
                    if let Some(q) = queue.get_queue(s) {
                        println!("  Screen {}: {} items", s, q.len());
                        if let Some(next) = q.get_next() {
                            println!("    Next: {} ({})", next.title.as_deref().unwrap_or("Unknown"), next.url);
                        }
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