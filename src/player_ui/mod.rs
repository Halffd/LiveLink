//! Standalone single-window libmpv player. One process per screen: the video
//! fills the window (rendered into an egui texture by `services::libmpv`),
//! an overlay provides controls, and a line-delimited JSON TCP listener
//! (`control`) lets the LiveLink server or scripts drive playback.

pub mod app;
pub mod control;
pub mod settings;

use std::path::PathBuf;
use std::sync::mpsc;

use crate::config::ScreenConfig;

pub use app::PlayerApp;

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

/// Launch a player window for one screen and block until it closes.
///
/// Starts the control listener on `port` before the window opens so commands
/// sent during startup are queued, loads persisted settings from
/// `<config_dir>/player-ui.json`, then runs the eframe event loop on a
/// dedicated thread (eframe must not run on a tokio worker).
pub fn run(
    screen_cfg: &ScreenConfig,
    playlist: Vec<String>,
    config_dir: PathBuf,
    port: u16,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    control::spawn_listener(port, tx);

    let settings = settings::PlayerUiSettings::load(&config_dir);

    let title = format!("LiveLink Player — screen {}", screen_cfg.screen);
    let width = screen_cfg.width;
    let height = screen_cfg.height;
    let screen_cfg = screen_cfg.clone();

    // NativeOptions holds non-Send event-loop hooks, so it must be built on
    // the thread that calls run_native.
    let handle = std::thread::spawn(move || {
        let options = eframe::NativeOptions {
            viewport: eframe::egui::ViewportBuilder::default()
                .with_title(title)
                .with_inner_size([width as f32, height as f32]),
            ..Default::default()
        };
        eframe::run_native(
            "LiveLink Player",
            options,
            Box::new(move |cc| {
                Ok(Box::new(app::PlayerApp::new(
                    cc,
                    &screen_cfg,
                    playlist,
                    settings,
                    config_dir,
                    rx,
                    port,
                )))
            }),
        )
        .map_err(|e| format!("player window failed: {e}"))
    });

    match handle.join() {
        Ok(result) => result,
        Err(_) => Err("player window thread panicked".to_string()),
    }
}
