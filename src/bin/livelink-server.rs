//! `livelink-server` — headless LiveLink server daemon.
//!
//! Runs the orchestrator and HTTP API server without player windows:
//! queues, channel switching, transcriptions, and the same endpoints as
//! `livelink start`. Intended for systemd / service supervision, with
//! players auto-connecting over their control ports and IPC sockets.
//!
//! Usage: `livelink-server [OPTIONS]`

use clap::Parser;
use livelink::config::ConfigLoader;
use livelink::server::serve_api;

#[derive(Parser)]
#[command(name = "livelink-server", about = "Headless LiveLink server daemon")]
struct Args {
  #[arg(short, long, default_value = "config", help = "Config directory")]
  config_dir: String,
  #[arg(short = 'P', long, default_value_t = 3001, help = "API server port")]
  port: u16,
}

#[tokio::main]
async fn main() {
  let args = Args::parse();
  let _ = ConfigLoader::with_base_path(&args.config_dir).load();

  tracing_subscriber::fmt()
    .with_env_filter(
      tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    )
    .init();

  if let Err(e) = run(args).await {
    eprintln!("{e}");
    std::process::exit(1);
  }
}

async fn run(args: Args) -> Result<(), String> {
  let config = ConfigLoader::with_base_path(&args.config_dir).load();
  let mpv_config_dir = config
    .mpv
    .config_dir
    .clone()
    .unwrap_or_else(|| "mpv_config".to_string());

  let (orchestrator, transcribe_tx) =
    livelink::server::build_orchestrator(
      args.config_dir.clone(),
      mpv_config_dir,
      false,
      "info".to_string(),
      "server.log".to_string(),
      "logs".to_string(),
    )
    .await?;

  serve_api(orchestrator, transcribe_tx, args.port).await?;
  Ok(())
}
