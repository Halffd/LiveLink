//! Standalone single-window libmpv player. One process per screen: the video
//! fills the window (rendered into an egui texture by `services::libmpv`),
//! an overlay provides controls, and a line-delimited JSON TCP listener
//! (`control`) lets the LiveLink server or scripts drive playback.

pub mod app;
pub mod control;
pub mod reading;
pub mod settings;
pub mod srs;
pub mod subtitle;
pub mod whisper_subs;

use std::path::{Path, PathBuf};
use std::sync::mpsc;

use crate::config::ScreenConfig;

pub use app::PlayerApp;

/// Everything needed to open one player window. Built from the
/// `livelink player-ui` command line and passed to [`run`].
pub struct PlayerWindowConfig {
    pub screen_cfg: ScreenConfig,
    /// URLs and/or local media file paths, in play order.
    pub playlist: Vec<String>,
    /// External subtitle files/URLs attached to every loaded media.
    pub subtitles: Vec<String>,
    /// Directory holding `player-ui.toml`.
    pub config_dir: PathBuf,
    /// Control port; `None` disables the JSON listener.
    pub control_port: Option<u16>,
    /// Force borderless regardless of saved settings.
    pub borderless: bool,
    /// Window position; `None` lets the window manager place it.
    pub position: Option<[f32; 2]>,
    /// Video rotation in degrees (0/90/180/270).
    pub rotate: u32,
    /// LiveLink server base URL (e.g. http://localhost:3001) for channel
    /// surfing; `None` disables server-driven channel switching.
    pub server_url: Option<String>,
    /// All configured screen numbers, for the move-to-screen buttons.
    pub screens: Vec<u32>,
    /// mpv binary used for SRS audio-clip encoding.
    pub mpv_path: String,
}

/// Sensible window defaults for a screen that has no config entry.
pub fn default_screen_config(screen: u32) -> ScreenConfig {
    ScreenConfig {
        id: screen,
        screen,
        enabled: true,
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        volume: 100,
        quality: "best".to_string(),
        window_maximized: false,
        primary: false,
        sources: Vec::new(),
        sorting: None,
        refresh: 0,
        auto_start: false,
        skip_watched_streams: None,
    }
}

/// Media file extensions accepted when playing a directory.
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "webm", "avi", "mov", "flv", "ts", "mp3", "m4a", "ogg", "wav",
];

/// Sorted playlist of media files directly inside `dir` (not recursive).
pub fn playlist_from_dir(dir: &Path) -> Result<Vec<String>, String> {
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            matches!(ext.as_deref(), Some(e) if MEDIA_EXTENSIONS.contains(&e))
        })
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    files.sort();
    Ok(files)
}

/// Resolve `url` to a direct stream URL via `streamlink <url> <quality>
/// --stream-url`, mirroring the subprocess player. Returns the input unchanged
/// for non-HTTP URLs and whenever streamlink is missing, times out, or fails
/// (mpv's ytdl hook may still resolve it).
pub async fn resolve_with_streamlink(
    streamlink_path: &str,
    url: &str,
    quality: &str,
) -> String {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return url.to_string();
    }
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new(streamlink_path)
            .args([url, quality, "--stream-url"])
            .output(),
    )
    .await;
    match result {
        Ok(Ok(output)) if output.status.success() && !output.stdout.is_empty() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        Ok(Ok(output)) => {
            tracing::warn!(
                url,
                quality,
                stderr = %String::from_utf8_lossy(&output.stderr),
                "streamlink could not resolve, playing URL directly"
            );
            url.to_string()
        }
        Ok(Err(e)) => {
            tracing::warn!(url, quality, error = %e, "failed to run streamlink");
            url.to_string()
        }
        Err(_) => {
            tracing::warn!(url, quality, "streamlink resolution timed out");
            url.to_string()
        }
    }
}

/// Launch a player window for one screen and block until it closes.
///
/// Starts the control listener (unless disabled) before the window opens so
/// commands sent during startup are queued, then runs the eframe event loop
/// on the current thread: winit refuses to create an event loop anywhere but
/// the main thread on Linux, and the CLI dispatch already runs there.
/// Settings are loaded from `<config_dir>/player-ui.json` inside the app
/// creator; saved settings are overridden by `borderless` and the window
/// geometry from `screen_cfg`.
pub fn run(window: PlayerWindowConfig) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    match window.control_port {
        Some(port) => control::spawn_listener(port, tx),
        None => drop(tx), // receiver reports disconnection; app treats it as idle
    }

    let title = format!("LiveLink Player — screen {}", window.screen_cfg.screen);
    let width = window.screen_cfg.width;
    let height = window.screen_cfg.height;
    let position = window.position;

    let mut viewport = eframe::egui::ViewportBuilder::default()
        .with_title(title)
        .with_inner_size([width as f32, height as f32]);
    if let Some([x, y]) = position {
        viewport = viewport.with_position([x, y]);
    }
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };
    eframe::run_native(
        "LiveLink Player",
        options,
        Box::new(move |cc| Ok(Box::new(app::PlayerApp::new(cc, &window, rx)))),
    )
    .map_err(|e| format!("player window failed: {e}"))
}
