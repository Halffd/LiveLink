//! `lvp` — standalone single-window LiveLink player (short form).
//!
//! Usage: `lvp [OPTIONS] [MEDIA] [SUBS] [EXTRA...]`
//! First positional arg = media, second = subtitle file, rest = playlist.
//! Same window and JSON control protocol as `livelink player-ui`, without
//! requiring the LiveLink server.

use clap::Parser;

#[derive(Parser)]
#[command(name = "lvp", about = "Standalone LiveLink player window")]
struct Args {
  #[arg(short, long, default_value = "config", help = "Config directory (screens, mpv, streamlink)")]
  config_dir: String,
  #[arg(short = 'P', long, default_value_t = 3001, help = "LiveLink server port for channel surfing (0 = none)")]
  port: u16,
  #[command(flatten)]
  player: livelink::cli::commands::PlayerUiCommand,
}

fn main() -> Result<(), String> {
  let args = Args::parse();
  let config =
    livelink::config::ConfigLoader::with_base_path(&args.config_dir).load();
  let rt = tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .map_err(|e| format!("tokio runtime: {e}"))?;
  rt.block_on(livelink::cli::commands::run_player_window(
    &args.player,
    &config.player.screens,
    &config.streamlink.path,
    &config.mpv.path,
    &args.config_dir,
    args.port,
    config.player.daemon,
  ))
}
