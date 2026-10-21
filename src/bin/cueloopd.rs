//! cueloopd - the queue-and-captions daemon.
//!
//! Owns the queues, the source handlers and the caption cache. Clients
//! talk to it over one socket; the player on every monitor reads the
//! same queue.

use clap::Parser;
use livelink::cueloop::cache::CaptionCache;
use livelink::cueloop::queue::QueueStore;
use livelink::cueloop::server::router;
use livelink::cueloop::sources::{HandlerRegistry, LocalFileHandler};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Parser, Debug)]
#[command(name = "cueloopd", about = "cueloop: queue-driven, caption-first daemon")]
struct Args {
    /// Address to listen on.
    #[arg(long, default_value = "127.0.0.1:8787")]
    listen: SocketAddr,
    /// Caption cache database.
    #[arg(long)]
    db: Option<PathBuf>,
    /// Root directory for relative local-file paths.
    #[arg(long)]
    media_root: Option<PathBuf>,
}

fn default_db() -> PathBuf {
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|home| PathBuf::from(home).join(".config"))
                .unwrap_or_else(|_| PathBuf::from("."))
        });
    base.join("cueloop").join("captions.db")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let db_path = args.db.unwrap_or_else(default_db);
    let cache = CaptionCache::open(&db_path)?;
    tracing::info!(db = %db_path.display(), "caption cache ready");

    let mut handlers = HandlerRegistry::new();
    handlers.register(Box::new(LocalFileHandler::new(args.media_root.clone())));
    tracing::info!(handlers = ?handlers.types(), "source handlers registered");

    let state = Arc::new(livelink::cueloop::server::DaemonState {
        queue: Mutex::new(QueueStore::new()),
        cache,
        handlers,
    });

    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    tracing::info!(addr = %args.listen, "cueloopd listening");
    axum::serve(listener, router(state)).await?;
    Ok(())
}
