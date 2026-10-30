//! Single-window libmpv player: video fills the window, controls overlay on
//! demand, settings persisted to player-ui.json.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use eframe::egui;

use crate::core::subtitles::{resolve_delay, SubtitleMode, MAX_SUB_DELAY};
use crate::player_ui::control::PlayerCommand;
use crate::player_ui::settings::{
    PlayerUiSettings, CONTROLS_ALWAYS, CONTROLS_AUTO, CONTROLS_NEVER,
};
use crate::player_ui::subtitle::{self, SubtitleInfo};
use crate::player_ui::PlayerWindowConfig;
use crate::services::libmpv::{MpvVideo, PlayerEvent};

const OVERLAY_HIDE_AFTER: Duration = Duration::from_secs(3);

/// Pending subtitle action collected from the settings window, applied after
/// the window closes (the window borrows `self.settings` while open).
#[derive(Debug, Clone, Copy)]
enum SubUiAction {
    CycleMode,
    ToggleSecondary,
    Nudge { secondary: bool, delta: f64 },
    Reset(bool),
}

/// Memento's pause-on-subtitle-end tolerance window in seconds.
const PAUSE_DELTA: f64 = 0.04;
/// Memento's seek epsilon when jumping to a subtitle line.
const SEEK_ERROR: f64 = 0.028;

/// One ruby-annotated line: each annotated segment is a centered stack
/// (reading above, base below) laid out horizontally with wrapping. The
/// whole line is clickable.
fn paint_ruby_line(
    ui: &mut egui::Ui,
    segments: &[crate::player_ui::reading::RubySegment],
    base_size: f32,
    reading_size: f32,
) -> egui::Response {
    use crate::player_ui::reading::RubySegment;

    let inner = ui.horizontal_wrapped(|ui| {
        for segment in segments {
            match segment {
                RubySegment::Plain(text) => {
                    ui.label(egui::RichText::new(text).size(base_size));
                }
                RubySegment::Ruby { base, reading } => {
                    ui.with_layout(egui::Layout::top_down(egui::Align::Center), |ui| {
                        if !reading.is_empty() {
                            ui.label(egui::RichText::new(reading).size(reading_size).weak());
                        }
                        ui.label(egui::RichText::new(base).size(base_size).strong());
                    });
                }
            }
        }
    });
    let id = ui.id().with("ruby_line");
    ui.interact(inner.response.rect, id, egui::Sense::click())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EndAction {
    /// Move within the window's own playlist
    AdvanceLocal,
    /// Ask the LiveLink server for the next channel
    NotifyServer,
}

fn end_action(server_driven: bool, has_server: bool) -> EndAction {
    if server_driven && has_server {
        EndAction::NotifyServer
    } else {
        EndAction::AdvanceLocal
    }
}

/// Whether an incoming stop command should stop the window's playback. A
/// server-driven window that already finished its media ignores the redundant
/// transition stop; a stop while playing is always a real stop.
fn apply_stop(server_driven: bool, playing: bool) -> bool {
    !server_driven || playing
}

pub struct PlayerApp {
    mpv: Option<MpvVideo>,
    playlist: Vec<String>,
    index: usize,
    /// External subtitle files/URLs re-attached when each file loads.
    subtitles: Vec<String>,
    settings: PlayerUiSettings,
    settings_dirty: bool,
    config_dir: PathBuf,
    cmd_rx: Receiver<PlayerCommand>,
    screen: u32,
    control_port: Option<u16>,
    last_pointer_move: Option<Instant>,
    settings_open: bool,
    theme_applied: bool,
    /// Slider position while the user is dragging the seek bar.
    seek_drag: Option<f64>,
    /// Whether the subtitle list panel is visible.
    sub_list_open: bool,
    /// Search filter for the subtitle list panel.
    sub_search: String,
    /// Parsed external subtitle lines per track id (Memento's subtitle map).
    subs_parsed: HashMap<i64, Vec<SubtitleInfo>>,
    /// Track id the parsed primary list belongs to.
    tracked_primary_sid: i64,
    /// Track id the parsed secondary list belongs to.
    tracked_secondary_sid: i64,
    /// Set after pausing for the current subtitle (reset when it changes).
    paused_for_subtitle: bool,
    /// Index of the primary subtitle line active at the last frame.
    last_sub_index: Option<usize>,
    /// Ephemeral secondary-lane toggle flag (ToggleSecondary mode).
    secondary_on: bool,
    /// Session-only primary delay override (cleared per media / on reset).
    delay_primary_ephemeral: Option<f64>,
    /// Session-only secondary delay override.
    delay_secondary_ephemeral: Option<f64>,
    /// LiveLink server base URL for channel surfing.
    server_url: Option<String>,
    /// All configured screens (move-to-screen targets).
    screens: Vec<u32>,
    /// Whether the channel panel is visible.
    channels_open: bool,
    /// Latest channel list snapshot from the server (None = not fetched yet).
    channels: Option<ChannelsSnapshot>,
    /// Failed server contact message, shown in the panel.
    channels_error: Option<String>,
    /// Server POST results from the request worker thread. reqwest::blocking
    /// panics when its runtime is dropped on the eframe main thread (that
    /// thread runs inside tokio's runtime via #[tokio::main]), so every
    /// blocking request goes through a spawned thread.
    post_rx: Receiver<Result<(), String>>,
    post_tx: Sender<Result<(), String>>,
    /// Receiver for background channel snapshots.
    channels_rx: Option<std::sync::mpsc::Receiver<ChannelsSnapshot>>,
    /// mpv binary for SRS audio encoding.
    mpv_path: String,
    /// Source URL of the current media (for SRS mining context).
    current_source: String,
    /// Status message from the last SRS mining job, with its timestamp.
    srs_status: Option<(String, Instant)>,
    /// Receiver for SRS mining results from the worker thread.
    srs_rx: Option<std::sync::mpsc::Receiver<String>>,
    /// True while a mining job is running.
    srs_busy: bool,
    /// Whether the reading panel is visible.
    reading_open: bool,
    /// True once the LiveLink server loaded this window's media: end-of-media
    /// then means "tell the server to advance the channel", not local skips.
    server_driven: bool,
    /// Whether the WhisperSubs panel is visible.
    ws_open: bool,
    /// Panel section: 0 library, 1 channels, 2 live, 3 subs.
    ws_section: u8,
    /// Drill-down channel in the channels section.
    ws_channel: Option<String>,
    /// Browse lists fetched on demand (None = not loaded).
    ws_library: Option<Vec<serde_json::Value>>,
    ws_channels: Option<Vec<serde_json::Value>>,
    ws_channel_videos: Option<Vec<serde_json::Value>>,
    ws_live: Option<Vec<serde_json::Value>>,
    ws_subs: Option<Vec<serde_json::Value>>,
    /// Panel-wide error/status line.
    ws_error: Option<String>,
    /// Receiver for the transcription monitor thread.
    ws_rx: Option<std::sync::mpsc::Receiver<super::whisper_subs::WsEvent>>,
    /// Task status line while transcription runs.
    ws_task_status: Option<String>,
    /// Local temp file the growing subtitles stream into.
    ws_live_sub_path: Option<std::path::PathBuf>,
    /// Whether the live subtitle file was already attached to mpv
    /// (sub-add once, sub-reload for every further update).
    ws_live_sub_added: bool,
}

/// One channel row in the panel.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ChannelEntry {
    pub url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub is_live: bool,
}

impl ChannelEntry {
    fn label(&self) -> String {
        let live = if self.is_live { "[LIVE] " } else { "" };
        format!("{}{}", live, self.title.as_deref().unwrap_or(&self.url))
    }
}

/// Snapshot of a screen's current channel and queue from the server.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ChannelsSnapshot {
    #[serde(default)]
    pub current: Option<ChannelEntry>,
    #[serde(default)]
    pub queue: Vec<ChannelEntry>,
}

impl PlayerApp {
    pub fn new(
        cc: &eframe::CreationContext<'_>,
        window: &PlayerWindowConfig,
        cmd_rx: Receiver<PlayerCommand>,
    ) -> Self {
        let screen_cfg = &window.screen_cfg;

        let mut settings = PlayerUiSettings::load(&window.config_dir);
        if window.borderless {
            settings.borderless = true;
        }

        let mut mpv = None;
        if let (Some(gl), Some(proc_addr)) = (&cc.gl, cc.get_proc_address) {
            // SAFETY: the loader is owned by the eframe runner and outlives the app.
            let proc_addr: &'static dyn Fn(&std::ffi::CStr) -> *const std::ffi::c_void =
                unsafe { std::mem::transmute(proc_addr) };
            match MpvVideo::new(gl, proc_addr, screen_cfg.width, screen_cfg.height) {
                Ok(mut m) => {
                    let volume = window.volume.unwrap_or(settings.volume);
                    m.set_volume(volume);
                    if window.rotate != 0 {
                        m.set_rotation(window.rotate);
                    }
                    mpv = Some(m);
                }

                Err(e) => tracing::warn!(error = %e, "libmpv init failed; window will be idle"),
            }
        }

        // Reading layer: imported dictionaries live beside the config unless
        // an explicit directory is configured; mecab is the fallback.
        let dictionary_dir = if settings.reading_dictionary_dir.trim().is_empty() {
            window.config_dir.join("dictionaries")
        } else {
            std::path::PathBuf::from(settings.reading_dictionary_dir.trim())
        };
        crate::player_ui::reading::init(crate::player_ui::reading::ReadingConfig {
            dictionary_dir: Some(dictionary_dir),
            mecab_path: settings.reading_mecab_path.clone(),
        });

        let (post_tx, post_rx) = std::sync::mpsc::channel();

        let mut app = Self {
            mpv,
            playlist: window.playlist.clone(),
            index: 0,
            subtitles: window.subtitles.clone(),
            settings,
            settings_dirty: false,
            config_dir: window.config_dir.clone(),
            cmd_rx,
            screen: screen_cfg.screen,
            control_port: window.control_port,
            last_pointer_move: None,
            settings_open: false,
            theme_applied: false,
            seek_drag: None,
            sub_list_open: false,
            sub_search: String::new(),
            subs_parsed: HashMap::new(),
            tracked_primary_sid: -1,
            tracked_secondary_sid: -1,
            paused_for_subtitle: false,
            last_sub_index: None,
            secondary_on: false,
            delay_primary_ephemeral: None,
            delay_secondary_ephemeral: None,
            server_url: window.server_url.clone(),
            screens: window.screens.clone(),
            channels_open: false,
            channels: None,
            channels_error: None,
            post_rx,
            post_tx,
            channels_rx: None,
            mpv_path: window.mpv_path.clone(),
            current_source: String::new(),
            srs_status: None,
            srs_rx: None,
            srs_busy: false,
            reading_open: false,
            server_driven: false,
            ws_open: false,
            ws_section: 0,
            ws_channel: None,
            ws_library: None,
            ws_channels: None,
            ws_channel_videos: None,
            ws_live: None,
            ws_subs: None,
            ws_error: None,
            ws_rx: None,
            ws_task_status: None,
            ws_live_sub_path: None,
            ws_live_sub_added: false,
        };
        if let Some(server_url) = window.server_url.clone() {
            let (tx, rx) = std::sync::mpsc::channel::<ChannelsSnapshot>();
            Self::spawn_channel_fetch(server_url, screen_cfg.screen, tx);
            app.channels_rx = Some(rx);
        }
        app.apply_sub_settings();
        app
    }

    /// Current visibility mode (persisted setting, validated).
    fn sub_mode(&self) -> SubtitleMode {
        SubtitleMode::parse(&self.settings.sub_mode).unwrap_or_default()
    }

    /// Effective delays: ephemeral session override wins over the global
    /// default (resolution order ephemeral > global).
    fn effective_delay_primary(&self) -> f64 {
        resolve_delay(
            self.delay_primary_ephemeral,
            self.settings.sub_delay_primary,
        )
    }

    fn effective_delay_secondary(&self) -> f64 {
        resolve_delay(
            self.delay_secondary_ephemeral,
            self.settings.sub_delay_secondary,
        )
    }

    /// Push subtitle mode (derived visibility) and resolved delays to mpv.
    fn apply_subtitle_state(&mut self) {
        let (primary, secondary) = self.sub_mode().resolve(self.secondary_on);
        let primary_delay = self.effective_delay_primary();
        let secondary_delay = self.effective_delay_secondary();
        if let Some(mpv) = &mut self.mpv {
            mpv.set_sub_visible(primary);
            mpv.set_secondary_sub_visible(secondary);
            mpv.set_sub_delay(primary_delay);
            mpv.set_secondary_sub_delay(secondary_delay);
        }
    }

    /// Nudge one delay lane by `delta` seconds (ephemeral override).
    fn nudge_delay(&mut self, secondary: bool, delta: f64) {
        let current = if secondary {
            self.effective_delay_secondary()
        } else {
            self.effective_delay_primary()
        };
        let next = resolve_delay(Some(current + delta), 0.0);
        if secondary {
            self.delay_secondary_ephemeral = Some(next);
        } else {
            self.delay_primary_ephemeral = Some(next);
        }
        self.apply_subtitle_state();
    }

    /// Set one delay lane to an absolute value (ephemeral override).
    fn set_delay(&mut self, secondary: bool, seconds: f64) {
        let clamped = resolve_delay(Some(seconds), 0.0);
        if secondary {
            self.delay_secondary_ephemeral = Some(clamped);
        } else {
            self.delay_primary_ephemeral = Some(clamped);
        }
        self.apply_subtitle_state();
    }

    /// Drop the ephemeral delay override for one lane (back to the default).
    fn reset_delay(&mut self, secondary: bool) {
        if secondary {
            self.delay_secondary_ephemeral = None;
        } else {
            self.delay_primary_ephemeral = None;
        }
        self.apply_subtitle_state();
    }

    /// Switch to the next visibility mode (cycle hotkey/command).
    fn cycle_sub_mode(&mut self) {
        let next = self.sub_mode().next();
        self.settings.sub_mode = next.as_str().to_string();
        self.apply_subtitle_state();
    }

    /// Set an explicit visibility mode; unknown names are ignored with a warn.
    fn set_sub_mode(&mut self, name: &str) {
        match SubtitleMode::parse(name) {
            Some(mode) => {
                self.settings.sub_mode = mode.as_str().to_string();
                self.apply_subtitle_state();
            }
            None => tracing::warn!(
                mode = %name,
                valid = %SubtitleMode::names(),
                "unknown subtitle mode"
            ),
        }
    }

    /// Toggle the secondary lane. Outside ToggleSecondary the flag has no
    /// effect, so the mode switches as well to make the toggle observable.
    fn toggle_secondary(&mut self) {
        self.secondary_on = !self.secondary_on;
        if self.settings.sub_mode != SubtitleMode::ToggleSecondary.as_str() {
            self.settings.sub_mode = SubtitleMode::ToggleSecondary.as_str().to_string();
        }
        self.apply_subtitle_state();
    }

    /// Toggle the primary lane: hide everything when it is on, otherwise show
    /// the primary track alone (primary is derived from the mode).
    fn toggle_primary_lane(&mut self) {
        let (primary, _) = self.sub_mode().resolve(self.secondary_on);
        self.settings.sub_mode = if primary {
            SubtitleMode::Hidden.as_str()
        } else {
            SubtitleMode::PrimaryOnly.as_str()
        }
        .to_string();
        self.apply_subtitle_state();
    }

    /// Push subtitle and video framing settings to mpv (init + Apply).
    fn apply_sub_settings(&mut self) {
        if let Some(mpv) = &mut self.mpv {
            let s = &self.settings;
            mpv.set_sub_pos(s.sub_pos);
            mpv.set_secondary_sub_track(s.sub_secondary_id);
            if !s.sub_font.is_empty() {
                mpv.set_sub_font(&s.sub_font);
            }
            mpv.set_sub_font_size(s.sub_font_size);
            mpv.set_sub_scale(s.sub_scale);
            mpv.set_sub_colors(&s.sub_color, &s.sub_border_color, s.sub_border_size);
            mpv.set_sub_ass_override(s.sub_ass_override);
            mpv.set_video_pan(s.video_pan_x, s.video_pan_y);
            mpv.set_video_zoom(s.video_zoom);
        }
        self.apply_subtitle_state();
    }

    /// Parse (and cache) the subtitle lines of an external track, mirroring
    /// Memento's per-sid subtitle map.
    fn ensure_parsed(&mut self, sid: i64) {
        if sid <= 0 || self.subs_parsed.contains_key(&sid) {
            return;
        }
        let filename = self.mpv.as_ref().and_then(|m| {
            m.sub_tracks()
                .into_iter()
                .find(|t| t.id == sid)
                .and_then(|t| t.external_filename)
        });
        if let Some(file) = filename {
            let parsed = subtitle::parse_subtitles(&file);
            if !parsed.is_empty() {
                self.subs_parsed.insert(sid, parsed);
            }
        }
    }

    /// Re-resolve the parsed lists when the selected tracks change.
    fn refresh_subtitle_lists(&mut self) {
        let Some(mpv) = &self.mpv else {
            return;
        };
        let primary = mpv.current_sub_id();
        let secondary = mpv.current_secondary_sub_id();
        if primary != self.tracked_primary_sid {
            self.tracked_primary_sid = primary;
            self.last_sub_index = None;
            self.paused_for_subtitle = false;
            self.ensure_parsed(primary);
        }
        if secondary != self.tracked_secondary_sid {
            self.tracked_secondary_sid = secondary;
            self.ensure_parsed(secondary);
        }
    }

    /// The primary subtitle line at the current playback position, from the
    /// parsed external track. None without a parsed track.
    fn current_line(&self) -> Option<SubtitleInfo> {
        let t = self.mpv.as_ref().map(|m| m.time_pos()).unwrap_or(0.0);
        let list = self.subs_parsed.get(&self.tracked_primary_sid)?;
        let idx = list.partition_point(|s| s.start <= t).checked_sub(1)?;
        let line = list.get(idx)?;
        (t < line.end).then(|| line.clone())
    }

    /// Memento's pause-on-subtitle-end: pause once when the current primary
    /// subtitle line reaches its end (within PAUSE_DELTA). No-op without a
    /// parsed track (e.g. embedded youtube subs).
    fn handle_pause_on_subtitle_end(&mut self) {
        if !self.settings.sub_pause_end || self.paused_for_subtitle {
            return;
        }
        let playing = self.mpv.as_ref().map(|m| m.playing).unwrap_or(false);
        let paused = self.mpv.as_ref().map(|m| m.paused).unwrap_or(true);
        if !playing || paused {
            return;
        }
        let Some(line) = self.current_line() else {
            return;
        };
        let t = self.mpv.as_ref().map(|m| m.time_pos()).unwrap_or(0.0);
        if self.last_sub_index.is_none() {
            // Seed the index on the first line so the end check works.
            self.last_sub_index = Some(usize::MAX);
        }
        let idx_changed = self.last_sub_index != self.current_line_index();
        if idx_changed {
            // New subtitle: allow pausing at its end again.
            self.last_sub_index = self.current_line_index();
            self.paused_for_subtitle = false;
            return;
        }
        let time_to_end = line.end - t;
        if time_to_end.abs() <= PAUSE_DELTA && t > PAUSE_DELTA {
            if let Some(mpv) = &mut self.mpv {
                mpv.set_paused(true);
            }
            self.paused_for_subtitle = true;
        }
    }

    /// Index of the current primary subtitle line (None when between lines).
    fn current_line_index(&self) -> Option<usize> {
        let t = self.mpv.as_ref().map(|m| m.time_pos()).unwrap_or(0.0);
        let list = self.subs_parsed.get(&self.tracked_primary_sid)?;
        let idx = list.partition_point(|s| s.start <= t).checked_sub(1)?;
        (t < list[idx].end).then_some(idx)
    }

    /// Mine the current subtitle line into Anki (screenshot + audio clip +
    /// text) on a background thread.
    fn mine_current_line(&mut self) {
        if self.srs_busy {
            self.srs_status = Some(("already mining".to_string(), Instant::now()));
            return;
        }
        let Some(line) = self.current_line() else {
            self.srs_status = Some((
                "no current subtitle line (external subs needed)".to_string(),
                Instant::now(),
            ));
            return;
        };
        if self.mpv.is_none() || self.current_source.is_empty() {
            self.srs_status = Some(("nothing playing to mine".to_string(), Instant::now()));
            return;
        }

        let dir = std::env::temp_dir().join("livelink-srs");
        let _ = std::fs::create_dir_all(&dir);
        let screenshot_path = dir.join(format!("{}.png", crate::player_ui::srs::artifact_stem()));
        if let Some(mpv) = &mut self.mpv {
            mpv.screenshot_to_file(&screenshot_path.to_string_lossy());
        }

        let (tx, rx) = std::sync::mpsc::channel::<String>();
        crate::player_ui::srs::spawn_mine(
            self.settings.clone(),
            line,
            self.current_source.clone(),
            self.mpv_path.clone(),
            screenshot_path,
            tx,
        );
        self.srs_rx = Some(rx);
        self.srs_busy = true;
        self.srs_status = Some(("mining…".to_string(), Instant::now()));
    }

    /// Drain SRS results from the mining thread and clear busy state.
    fn drain_srs(&mut self) {
        let Some(rx) = &self.srs_rx else {
            return;
        };
        if let Ok(message) = rx.try_recv() {
            self.srs_status = Some((message, Instant::now()));
            self.srs_busy = false;
            self.srs_rx = None;
        }
    }

    /// The subtitle list panel: parsed lines of the primary (and secondary)
    /// track with timestamps, current-line highlight, search, and click to
    /// seek — Memento's subtitle list.
    fn paint_subtitle_list(&mut self, ctx: &egui::Context) {
        let t = self.mpv.as_ref().map(|m| m.time_pos()).unwrap_or(0.0);
        let accent = ctx.style().visuals.hyperlink_color;
        let primary = self
            .subs_parsed
            .get(&self.tracked_primary_sid)
            .cloned()
            .unwrap_or_default();
        let secondary = self
            .subs_parsed
            .get(&self.tracked_secondary_sid)
            .cloned()
            .unwrap_or_default();
        let search = self.sub_search.to_lowercase();
        let matches =
            |line: &SubtitleInfo| search.is_empty() || line.text.to_lowercase().contains(&search);

        egui::SidePanel::right("subtitle_list")
            .resizable(true)
            .default_width(380.0)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.heading("Subtitles");
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        ui.add(
                            egui::TextEdit::singleline(&mut self.sub_search)
                                .hint_text("Search...")
                                .desired_width(160.0),
                        );
                        if ui
                            .button("＋ Anki")
                            .on_hover_text("Mine current line (a)")
                            .clicked()
                        {
                            self.mine_current_line();
                        }
                    });
                });
                if let Some((message, at)) = &self.srs_status {
                    if at.elapsed() < Duration::from_secs(8) || self.srs_busy {
                        ui.label(egui::RichText::new(message).weak());
                    }
                }
                ui.separator();

                let show_secondary = self.tracked_secondary_sid > 0 && !secondary.is_empty();
                let mut render_list = |ui: &mut egui::Ui, title: &str, list: &[SubtitleInfo]| {
                    ui.strong(title);
                    egui::ScrollArea::vertical()
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            for line in list.iter() {
                                if !matches(line) {
                                    continue;
                                }
                                let is_current = t >= line.start && t < line.end;
                                let label = format!(
                                    "[{:02}:{:06.3}] {}",
                                    (line.start / 60.0).floor(),
                                    line.start % 60.0,
                                    line.text.replace('\n', " / ")
                                );
                                let mut text = egui::RichText::new(label);
                                if is_current {
                                    text = text.strong().color(accent);
                                }
                                let response = ui.add(egui::Label::new(text).wrap());
                                if is_current {
                                    response.scroll_to_me(Some(egui::Align::Center));
                                }
                                if response.clicked() {
                                    // Memento seeks to line start + sub-delay + epsilon.
                                    let pos = (line.start + SEEK_ERROR).max(0.0);
                                    if let Some(mpv) = &mut self.mpv {
                                        mpv.seek_absolute(pos);
                                    }
                                }
                            }
                            if list.is_empty() {
                                ui.weak("no parsed lines (external subtitle files only)");
                            }
                        });
                    ui.separator();
                };

                if show_secondary {
                    ui.columns(2, |columns| {
                        render_list(&mut columns[0], "Primary", &primary);
                        render_list(&mut columns[1], "Secondary", &secondary);
                    });
                } else {
                    render_list(ui, "Primary", &primary);
                }
            });
    }

    /// Drain fresh channel snapshots from the background fetch thread.
    fn drain_channels(&mut self) {
        let Some(rx) = &self.channels_rx else {
            return;
        };
        while let Ok(snapshot) = rx.try_recv() {
            self.channels = Some(snapshot);
        }
    }

    /// POST a channel command to the LiveLink server from a worker thread.
    /// Errors surface in the channel panel; they are not fatal. Blocking
    /// reqwest must not run on the eframe main thread (tokio runtime
    /// context), so the result comes back over `post_rx` and is drained in
    /// `update`.
    fn post_channel_command(&mut self, path: &str, body: &serde_json::Value) {
        let Some(server) = self.server_url.clone() else {
            self.channels_error = Some("no server configured".to_string());
            return;
        };
        // The orchestrator API is mounted at the root (see create_router):
        // /channel/next, /channel/prev, /channel/play.
        let url = format!("{}/channel/{}", server, path);
        let body = body.clone();
        let tx = self.post_tx.clone();
        std::thread::spawn(move || {
            let result = (|| {
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(3))
                    .build()
                    .map_err(|e| format!("http client: {e}"))?;
                let resp = client
                    .post(&url)
                    .json(&body)
                    .send()
                    .map_err(|e| format!("server unreachable: {e}"))?;
                if resp.status().is_success() {
                    Ok(())
                } else {
                    Err(format!("server: {}", resp.status()))
                }
            })();
            let _ = tx.send(result);
        });
    }

    /// Poll the server for this screen's channels in the background; sends
    /// snapshots into `tx` every few seconds until the app goes away.
    fn spawn_channel_fetch(
        server_url: String,
        screen: u32,
        tx: std::sync::mpsc::Sender<ChannelsSnapshot>,
    ) {
        std::thread::spawn(move || {
            let client = match reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .build()
            {
                Ok(c) => c,
                Err(_) => return,
            };
            loop {
                if let Ok(resp) = client
                    .get(format!("{}/channels/{}", server_url, screen))
                    .send()
                {
                    if resp.status().is_success() {
                        if let Ok(snapshot) = resp.json::<ChannelsSnapshot>() {
                            if tx.send(snapshot).is_err() {
                                return; // app closed
                            }
                        }
                    }
                }
                std::thread::sleep(std::time::Duration::from_secs(4));
            }
        });
    }

    /// Consume events from the transcription monitor: status line, the
    /// growing subtitle file (written to a temp path, sub-add'ed once,
    /// sub-reloaded afterwards), and completion.
    fn drain_ws(&mut self) {
        let Some(rx) = &self.ws_rx else {
            return;
        };
        while let Ok(event) = rx.try_recv() {
            use super::whisper_subs::WsEvent;
            match event {
                WsEvent::Status(line) => self.ws_task_status = Some(line),
                WsEvent::Srt(text) => {
                    let path = self.ws_live_sub_path.clone().unwrap_or_else(|| {
                        std::env::temp_dir()
                            .join(format!("livelink-ws-live-{}.srt", std::process::id()))
                    });
                    if std::fs::write(&path, &text).is_ok() {
                        let path_str = path.to_string_lossy().to_string();
                        if let Some(mpv) = &mut self.mpv {
                            if self.ws_live_sub_added {
                                mpv.sub_reload();
                            } else {
                                mpv.sub_add(&path_str);
                                self.subtitles.push(path_str);
                                self.ws_live_sub_added = true;
                            }
                        }
                        self.ws_live_sub_path = Some(path);
                    }
                }
                WsEvent::Completed => {
                    self.ws_task_status = Some("completed".to_string());
                }
                WsEvent::Failed(err) => {
                    self.ws_error = Some(format!("transcription failed: {err}"));
                    self.ws_task_status = None;
                }
            }
        }
    }

    /// Kick off transcription of the currently loaded media on the
    /// configured whisper-subs server, then stream the growing subtitles
    /// into the player.
    fn ws_transcribe_current(&mut self) {
        let Some(source) = self.playlist.get(self.index).cloned() else {
            self.ws_error = Some("nothing is loaded".to_string());
            return;
        };
        let client = super::whisper_subs::WhisperSubs::new(
            self.settings.whisper_subs_url.clone(),
            self.settings.whisper_subs_key.clone(),
        );
        match client.start_transcription(&source, "large-v3") {
            Ok(task_id) => {
                let (tx, rx) = std::sync::mpsc::channel();
                super::whisper_subs::monitor_task(client, task_id, tx);
                self.ws_rx = Some(rx);
                self.ws_task_status = Some("queued".to_string());
                self.ws_error = None;
            }
            Err(e) => self.ws_error = Some(e),
        }
    }

    /// The WhisperSubs panel: server browse (library, channels, live,
    /// the subtitle directory) plus transcribe-current with streaming
    /// subtitles.
    fn paint_whisper_subs(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("whisper_subs")
            .resizable(true)
            .default_width(340.0)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.heading("WhisperSubs");
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("↻").on_hover_text("Reload section").clicked() {
                            self.ws_reload_section();
                        }
                    });
                });
                ui.separator();

                if self.settings.whisper_subs_url.trim().is_empty() {
                    ui.weak("configure the server URL in settings");
                    return;
                }
                if let Some(err) = &self.ws_error {
                    ui.colored_label(ui.visuals().error_fg_color, err);
                    ui.separator();
                }

                ui.horizontal(|ui| {
                    for (i, label) in ["Library", "Channels", "Live", "Subs"]
                        .into_iter()
                        .enumerate()
                    {
                        if ui
                            .selectable_label(self.ws_section == i as u8, label)
                            .clicked()
                        {
                            self.ws_section = i as u8;
                            self.ws_channel = None;
                        }
                    }
                });
                ui.separator();

                if let Some(status) = &self.ws_task_status.clone() {
                    ui.weak(format!("task: {status}"));
                    ui.separator();
                }

                let client = super::whisper_subs::WhisperSubs::new(
                    self.settings.whisper_subs_url.clone(),
                    self.settings.whisper_subs_key.clone(),
                );
                match self.ws_section {
                    0 => self.paint_ws_library(ui, &client),
                    1 => self.paint_ws_channels(ui, &client),
                    2 => self.paint_ws_live(ui, &client),
                    _ => self.paint_ws_subs(ui, &client),
                }
            });
    }

    /// Fetch a section list on demand (first view and the reload button).
    fn ws_reload_section(&mut self) {
        self.ws_error = None;
        let client = super::whisper_subs::WhisperSubs::new(
            self.settings.whisper_subs_url.clone(),
            self.settings.whisper_subs_key.clone(),
        );
        match self.ws_section {
            0 => match client.library() {
                Ok(items) => self.ws_library = Some(items),
                Err(e) => self.ws_error = Some(e),
            },
            1 => {
                let target = self.ws_channel.clone();
                match target {
                    Some(name) => match client.channel_videos(&name) {
                        Ok(items) => self.ws_channel_videos = Some(items),
                        Err(e) => self.ws_error = Some(e),
                    },
                    None => match client.channels() {
                        Ok(items) => self.ws_channels = Some(items),
                        Err(e) => self.ws_error = Some(e),
                    },
                }
            }
            2 => match client.live_tasks() {
                Ok(items) => self.ws_live = Some(items),
                Err(e) => self.ws_error = Some(e),
            },
            _ => match client.subtitle_list() {
                Ok(items) => self.ws_subs = Some(items),
                Err(e) => self.ws_error = Some(e),
            },
        }
    }

    fn paint_ws_library(&mut self, ui: &mut egui::Ui, client: &super::whisper_subs::WhisperSubs) {
        if self.ws_library.is_none() {
            match client.library() {
                Ok(items) => self.ws_library = Some(items),
                Err(e) => {
                    self.ws_error = Some(e);
                    return;
                }
            }
        }
        ui.horizontal(|ui| {
            if ui
                .button("Transcribe current")
                .on_hover_text("Send the loaded media to the server and stream its subtitles")
                .clicked()
            {
                self.ws_transcribe_current();
            }
        });
        ui.separator();
        let items = self.ws_library.clone().unwrap_or_default();
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for item in &items {
                    let title = item["title"].as_str().unwrap_or("untitled");
                    let channel = item["channel"].as_str().unwrap_or_default();
                    let media = item["urls"]["media"]
                        .as_array()
                        .map(|a| !a.is_empty())
                        .unwrap_or(false);
                    let srt = item["urls"]["srt"].as_str().unwrap_or_default();
                    let source = item["source_url"].as_str().unwrap_or_default();
                    let playable = (media && !srt.is_empty()) || !source.is_empty();
                    let response = ui.add(egui::Label::new(format!("{title}\n{channel}")).wrap());
                    if playable && response.clicked() {
                        // Play in this window: media URL via the server, with
                        // its SRT attached; otherwise fall back to the source.
                        if let Some(first) =
                            item["urls"]["media"].as_array().and_then(|a| a.first())
                        {
                            let url = client.resolve(first["url"].as_str().unwrap_or_default());
                            let sub = client.resolve(srt);
                            self.playlist = vec![url];
                            self.index = 0;
                            self.subtitles = vec![sub];
                            self.load_current();
                            self.ws_open = false;
                        } else if !source.is_empty() {
                            self.playlist = vec![source.to_string()];
                            self.index = 0;
                            self.subtitles.clear();
                            self.load_current();
                            self.ws_open = false;
                        }
                    }
                    ui.separator();
                }
                if items.is_empty() {
                    ui.weak("no transcriptions on the server");
                }
            });
    }

    fn paint_ws_channels(&mut self, ui: &mut egui::Ui, client: &super::whisper_subs::WhisperSubs) {
        if let Some(name) = self.ws_channel.clone() {
            ui.horizontal(|ui| {
                if ui.button("←").clicked() {
                    self.ws_channel = None;
                    self.ws_channel_videos = None;
                }
                ui.label(&name);
            });
            ui.separator();
            if self.ws_channel_videos.is_none() {
                match client.channel_videos(&name) {
                    Ok(items) => self.ws_channel_videos = Some(items),
                    Err(e) => {
                        self.ws_error = Some(e);
                        return;
                    }
                }
            }
            let items = self.ws_channel_videos.clone().unwrap_or_default();
            egui::ScrollArea::vertical()
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    for v in &items {
                        let title = v["title"].as_str().unwrap_or("untitled");
                        let transcribed = v["transcribed"].as_bool().unwrap_or(false);
                        let source = v["source_url"].as_str().unwrap_or_default();
                        let response = ui.add(
                            egui::Label::new(format!(
                                "{title}\n{}",
                                if transcribed {
                                    "transcribed"
                                } else {
                                    "not transcribed"
                                }
                            ))
                            .wrap(),
                        );
                        if response.clicked() && !source.is_empty() {
                            self.playlist = vec![source.to_string()];
                            self.index = 0;
                            self.subtitles.clear();
                            self.load_current();
                            self.ws_open = false;
                        }
                        ui.separator();
                    }
                    if items.is_empty() {
                        ui.weak("no videos listed for this channel");
                    }
                });
            return;
        }
        if self.ws_channels.is_none() {
            match client.channels() {
                Ok(items) => self.ws_channels = Some(items),
                Err(e) => {
                    self.ws_error = Some(e);
                    return;
                }
            }
        }
        let items = self.ws_channels.clone().unwrap_or_default();
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for c in &items {
                    let name = c["name"].as_str().unwrap_or("?");
                    let transcribed = c["transcribed"].as_i64().unwrap_or(0);
                    if ui
                        .add(egui::Label::new(format!("{name} ({transcribed})")).wrap())
                        .clicked()
                    {
                        self.ws_channel = Some(name.to_string());
                        self.ws_channel_videos = None;
                    }
                    ui.separator();
                }
                if items.is_empty() {
                    ui.weak("no channels on the server");
                }
            });
    }

    fn paint_ws_live(&mut self, ui: &mut egui::Ui, client: &super::whisper_subs::WhisperSubs) {
        if self.ws_live.is_none() {
            match client.live_tasks() {
                Ok(items) => self.ws_live = Some(items),
                Err(e) => {
                    self.ws_error = Some(e);
                    return;
                }
            }
        }
        let items = self.ws_live.clone().unwrap_or_default();
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for t in &items {
                    let source = t["source"].as_str().unwrap_or("?");
                    let status = t["status"].as_str().unwrap_or_default();
                    let model = t["model_name"].as_str().unwrap_or_default();
                    ui.add(egui::Label::new(format!("{source}\n{status} · {model}")).wrap());
                    ui.separator();
                }
                if items.is_empty() {
                    ui.weak("no live or running transcription tasks");
                }
            });
    }

    fn paint_ws_subs(&mut self, ui: &mut egui::Ui, client: &super::whisper_subs::WhisperSubs) {
        if self.ws_subs.is_none() {
            match client.subtitle_list() {
                Ok(items) => self.ws_subs = Some(items),
                Err(e) => {
                    self.ws_error = Some(e);
                    return;
                }
            }
        }
        let items = self.ws_subs.clone().unwrap_or_default();
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                for s in &items {
                    let name = s["filename"].as_str().unwrap_or("?");
                    let created = s["created"].as_str().unwrap_or_default();
                    let path = s["path"].as_str().unwrap_or_default().to_string();
                    let response = ui.add(egui::Label::new(format!("{name}\n{created}")).wrap());
                    if response.clicked() && !path.is_empty() {
                        match client.subtitle_text(&path) {
                            Ok(text) => {
                                let local = std::env::temp_dir().join(format!(
                                    "livelink-ws-{}.srt",
                                    urlencoding::encode(&path)
                                ));
                                if std::fs::write(&local, text).is_ok() {
                                    if let Some(mpv) = &mut self.mpv {
                                        let path_str = local.to_string_lossy().to_string();
                                        mpv.sub_add(&path_str);
                                        self.subtitles.push(path_str);
                                    }
                                }
                            }
                            Err(e) => self.ws_error = Some(e),
                        }
                    }
                    ui.separator();
                }
                if items.is_empty() {
                    ui.weak("no subtitle files on the server");
                }
            });
    }

    /// The channel panel: current channel, queue with click-to-switch, and
    /// move-to-screen buttons — the TV remote.
    fn paint_channels(&mut self, ctx: &egui::Context) {
        egui::SidePanel::left("channels")
            .resizable(true)
            .default_width(320.0)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.heading("Channels");
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("≫").on_hover_text("Next channel (n)").clicked() {
                            self.post_channel_command(
                                "next",
                                &serde_json::json!({ "screen": self.screen }),
                            );
                        }
                        if ui
                            .button("≪")
                            .on_hover_text("Previous channel (b)")
                            .clicked()
                        {
                            self.post_channel_command(
                                "prev",
                                &serde_json::json!({ "screen": self.screen }),
                            );
                        }
                    });
                });
                ui.separator();

                if self.server_url.is_none() {
                    ui.weak("channel surfing needs the LiveLink server (start livelink)");
                    return;
                }
                if let Some(err) = &self.channels_error {
                    ui.weak(format!("server: {err}"));
                    ui.separator();
                }

                let snapshot = self.channels.clone();
                let Some(snapshot) = snapshot else {
                    ui.weak("loading channels...");
                    return;
                };

                if let Some(current) = &snapshot.current {
                    ui.label(egui::RichText::new(format!("now: {}", current.label())).strong());
                } else {
                    ui.weak("idle");
                }
                ui.separator();

                let other_screens: Vec<u32> = self
                    .screens
                    .iter()
                    .copied()
                    .filter(|s| *s != self.screen)
                    .collect();
                if !other_screens.is_empty() {
                    ui.horizontal(|ui| {
                        ui.label("move to:");
                        for target in other_screens {
                            if ui.button(format!("screen {target}")).clicked() {
                                self.post_channel_command(
                                    "move",
                                    &serde_json::json!({
                                        "from": self.screen,
                                        "to": target,
                                    }),
                                );
                            }
                        }
                    });
                    ui.separator();
                }

                let current_url = snapshot.current.as_ref().map(|c| c.url.clone());
                egui::ScrollArea::vertical()
                    .auto_shrink([false, false])
                    .show(ui, |ui| {
                        for entry in &snapshot.queue {
                            let is_current = current_url.as_deref() == Some(entry.url.as_str());
                            let mut text = egui::RichText::new(entry.label());
                            if is_current {
                                text = text.strong().color(ui.visuals().hyperlink_color);
                            }
                            let response = ui.add(egui::Label::new(text).wrap());
                            if response.clicked() {
                                self.post_channel_command(
                                    "play",
                                    &serde_json::json!({
                                        "screen": self.screen,
                                        "url": entry.url,
                                    }),
                                );
                            }
                        }
                        if snapshot.queue.is_empty() {
                            ui.weak("queue empty");
                        }
                    });
            });
    }

    fn load_current(&mut self) {
        if let Some(url) = self.playlist.get(self.index).cloned() {
            self.current_source = url.clone();
            if let Some(mpv) = &mut self.mpv {
                mpv.load(&url);
            }
        }
    }

    /// What to do when the loaded media ends or fails: a server-driven window
    /// asks the orchestrator for the next channel (it decides queue rules,
    /// watched marking, and history); a local playlist advances itself.
    fn handle_media_end(&mut self) {
        tracing::info!("media end; advancing");
        self.navigate(1);
    }

    /// Playlist/channel navigation shared by the overlay buttons and the
    /// control-port next/prev commands: server-driven windows navigate the
    /// orchestrator queue, local playlists advance themselves.
    fn navigate(&mut self, dir: i32) {
        if end_action(self.server_driven, self.server_url.is_some()) == EndAction::NotifyServer {
            let command = if dir > 0 { "next" } else { "prev" };
            self.post_channel_command(command, &serde_json::json!({ "screen": self.screen }));
        } else {
            self.advance(dir);
        }
    }

    fn advance(&mut self, dir: i32) {
        if self.playlist.is_empty() {
            return;
        }
        let mut idx = self.index as i64 + dir as i64;
        if idx < 0 {
            idx = 0;
        }
        if idx as usize >= self.playlist.len() {
            if self.settings.loop_playlist {
                idx = 0;
            } else {
                if let Some(mpv) = &mut self.mpv {
                    mpv.stop();
                }
                return;
            }
        }
        self.index = idx as usize;
        self.load_current();
    }

    fn drain_commands(&mut self, ctx: &egui::Context) {
        while let Ok(cmd) = self.cmd_rx.try_recv() {
            match cmd.cmd.as_str() {
                "play" => {
                    if let Some(url) = cmd.url {
                        tracing::info!(url = %url, "window play command");
                        self.playlist = vec![url];
                        self.index = 0;
                        // The server drives this window now: media ends go
                        // back to it as channel-next, not local advances.
                        self.server_driven = true;
                        self.load_current();
                    }
                }
                "stop" => {
                    // A server-driven window receives transition stops after
                    // end-of-file (the server stops the old stream before
                    // starting the next); applying them would flash the idle
                    // screen between channels. Only stop real, playing media.
                    let playing = self.mpv.as_ref().map(|m| m.playing).unwrap_or(false);
                    if apply_stop(self.server_driven, playing) {
                        if let Some(mpv) = &mut self.mpv {
                            mpv.stop();
                        }
                    }
                }
                "pause" => {
                    if let Some(mpv) = &mut self.mpv {
                        let value = cmd.value.map(|v| v != 0.0).unwrap_or(!mpv.paused);
                        mpv.set_paused(value);
                    }
                }
                "volume" => {
                    if let Some(mpv) = &mut self.mpv {
                        let v = cmd.value.unwrap_or(100.0).clamp(0.0, 130.0) as i64;
                        mpv.set_volume(v);
                        self.settings.volume = v;
                    }
                }
                "seek" => {
                    if let Some(mpv) = &mut self.mpv {
                        mpv.seek_relative(cmd.value.unwrap_or(10.0));
                    }
                }
                "speed" => {
                    if let Some(mpv) = &mut self.mpv {
                        mpv.set_speed(cmd.value.unwrap_or(1.0).clamp(0.25, 4.0));
                    }
                }
                "mute" => {
                    if let Some(mpv) = &mut self.mpv {
                        let value = cmd.value.map(|v| v != 0.0).unwrap_or(!mpv.muted());
                        mpv.set_mute(value);
                    }
                }
                "sub" => {
                    if let Some(mpv) = &mut self.mpv {
                        mpv.set_sub_track(cmd.value.unwrap_or(0.0) as i64);
                    }
                }
                "sub-pos" => {
                    if let Some(mpv) = &mut self.mpv {
                        mpv.set_sub_pos(cmd.value.unwrap_or(100.0) as i64);
                    }
                }
                "sub-add" => {
                    if let (Some(mpv), Some(url)) = (&mut self.mpv, cmd.url) {
                        mpv.sub_add(&url);
                        self.subtitles.push(url);
                    }
                }
                "mine" => self.mine_current_line(),
                "sub-delay" => self.set_delay(false, cmd.value.unwrap_or(0.0)),
                "sub-delay-by" => self.nudge_delay(false, cmd.value.unwrap_or(0.0)),
                "sub-delay-reset" => self.reset_delay(false),
                "sec-sub-delay" => self.set_delay(true, cmd.value.unwrap_or(0.0)),
                "sec-sub-delay-by" => self.nudge_delay(true, cmd.value.unwrap_or(0.0)),
                "sec-sub-delay-reset" => self.reset_delay(true),
                "sub-mode" => {
                    if let Some(name) = cmd.text.as_deref() {
                        self.set_sub_mode(name);
                    } else {
                        tracing::warn!(command = %cmd.cmd, "sub-mode needs a text argument");
                    }
                }
                "sub-mode-cycle" => self.cycle_sub_mode(),
                "sub-toggle-secondary" => self.toggle_secondary(),
                "next" => self.navigate(1),
                "prev" => self.navigate(-1),
                "reload" => {
                    self.settings = PlayerUiSettings::load(&self.config_dir);
                    self.apply_viewport_settings(ctx);
                    self.theme_applied = false;
                }
                "quit" => ctx.send_viewport_cmd(egui::ViewportCommand::Close),
                other => tracing::warn!(command = %other, "unknown player command"),
            }
        }
    }

    fn handle_events(&mut self) {
        let events = if let Some(mpv) = &mut self.mpv {
            mpv.poll_events()
        } else {
            Vec::new()
        };
        for ev in events {
            tracing::debug!(?ev, "player event");
            match ev {
                PlayerEvent::Loaded => {
                    let subs = self.subtitles.clone();
                    if !subs.is_empty() {
                        if let Some(mpv) = &mut self.mpv {
                            for sub in &subs {
                                mpv.sub_add(sub);
                            }
                        }
                    }
                    // New media: drop session delay overrides (ephemeral) and
                    // re-assert mode visibility, which mpv resets per file.
                    self.delay_primary_ephemeral = None;
                    self.delay_secondary_ephemeral = None;
                    self.apply_subtitle_state();
                }
                PlayerEvent::Eof => self.handle_media_end(),
                PlayerEvent::Stopped => {}
                PlayerEvent::Failed => {
                    tracing::warn!(
                        screen = self.screen,
                        url = self
                            .playlist
                            .get(self.index)
                            .map(|s| s.as_str())
                            .unwrap_or(""),
                        "playback failed, advancing"
                    );
                    self.handle_media_end();
                }
            }
        }
    }

    fn render_mpv(&mut self, frame: &mut eframe::Frame) {
        if let Some(mpv) = &mut self.mpv {
            mpv.register_texture(frame);
            mpv.render();
        }
    }

    fn pointer_recently_moved(&mut self, ctx: &egui::Context) -> bool {
        let moved = ctx.input(|i| i.pointer.velocity().length_sq() > 0.0);
        if moved {
            self.last_pointer_move = Some(Instant::now());
        }
        self.last_pointer_move
            .map(|t| t.elapsed() < OVERLAY_HIDE_AFTER)
            .unwrap_or(true)
    }

    fn apply_theme(&mut self, ctx: &egui::Context) {
        ctx.set_pixels_per_point(self.settings.font_scale);
        ctx.set_visuals(self.settings.build_visuals());
        self.theme_applied = true;
    }

    fn apply_viewport_settings(&self, ctx: &egui::Context) {
        ctx.send_viewport_cmd(egui::ViewportCommand::Decorations(
            !self.settings.borderless,
        ));
        ctx.send_viewport_cmd(egui::ViewportCommand::WindowLevel(
            if self.settings.always_on_top {
                egui::WindowLevel::AlwaysOnTop
            } else {
                egui::WindowLevel::Normal
            },
        ));
        ctx.send_viewport_cmd(egui::ViewportCommand::Fullscreen(self.settings.fullscreen));
    }

    fn save_settings(&mut self) {
        match self.settings.save(&self.config_dir) {
            Ok(path) => {
                self.settings_dirty = false;
                tracing::info!(path = %path.display(), "player UI settings saved");
            }
            Err(e) => tracing::warn!(error = %e, "failed to save player UI settings"),
        }
    }

    fn paint_video(&mut self, ctx: &egui::Context) {
        let video = self
            .mpv
            .as_mut()
            .map(|m| (m.texture_id(), m.width as f32, m.height as f32, m.playing));
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(egui::Color32::BLACK))
            .show(ctx, |ui| {
                let avail = ui.available_size();
                match video {
                    Some((Some(id), w, h, _)) => {
                        ui.with_layout(
                            egui::Layout::centered_and_justified(egui::Direction::LeftToRight),
                            |ui| {
                                ui.add(
                                    egui::Image::new(egui::load::SizedTexture::new(id, [w, h]))
                                        .max_size(avail),
                                );
                            },
                        );
                    }
                    _ => {
                        ui.centered_and_justified(|ui| {
                            ui.vertical_centered(|ui| {
                                ui.add_space(40.0);
                                ui.heading(format!("LiveLink Player — screen {}", self.screen));
                                ui.label(match self.control_port {
                                    Some(port) => format!("control port: {}", port),
                                    None => "control port: disabled".to_string(),
                                });
                                if self.mpv.is_none() {
                                    ui.label("libmpv failed to initialize");
                                } else if self.playlist.is_empty() {
                                    ui.label("waiting for a stream — pass --url, a playlist file, or send {\"cmd\":\"play\",\"url\":\"...\"}");
                                } else {
                                    ui.label("stopped");
                                }
                            });
                        });
                    }
                }
            });
    }

    fn paint_overlays(&mut self, ctx: &egui::Context) {
        let show_controls = self.settings.controls_always()
            || self.settings_open
            || (self.settings.controls_auto() && self.pointer_recently_moved(ctx));

        let title = self.mpv.as_mut().and_then(|m| {
            if m.playing && self.settings.show_title {
                Some(m.media_title())
            } else {
                None
            }
        });

        if let Some(title) = title {
            egui::Area::new(egui::Id::new("title_overlay"))
                .anchor(egui::Align2::CENTER_TOP, [0.0, 8.0])
                .order(egui::Order::Foreground)
                .show(ctx, |ui| {
                    egui::Frame::default()
                        .fill(egui::Color32::from_black_alpha(
                            (self.settings.overlay_opacity * 255.0) as u8,
                        ))
                        .rounding(8.0)
                        .inner_margin(egui::Margin::symmetric(12.0, 6.0))
                        .show(ui, |ui| {
                            ui.label(
                                egui::RichText::new(title)
                                    .size(16.0)
                                    .color(egui::Color32::WHITE),
                            );
                        });
                });
        }

        if !show_controls {
            return;
        }

        let playing = self.mpv.as_ref().map(|m| m.playing).unwrap_or(false);
        let paused = self.mpv.as_ref().map(|m| m.paused).unwrap_or(false);

        egui::Area::new(egui::Id::new("controls_overlay"))
            .anchor(egui::Align2::CENTER_BOTTOM, [0.0, -10.0])
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                egui::Frame::default()
                    .fill(egui::Color32::from_black_alpha(
                        (self.settings.overlay_opacity * 255.0) as u8,
                    ))
                    .rounding(10.0)
                    .inner_margin(egui::Margin::symmetric(14.0, 8.0))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            if ui.button("⏮").clicked() {
                                self.navigate(-1);
                            }
                            if ui.button("⏪").clicked() {
                                if let Some(mpv) = &mut self.mpv {
                                    mpv.seek_relative(-10.0);
                                }
                            }
                            if ui
                                .add_enabled(
                                    playing,
                                    egui::Button::new(if paused { "▶" } else { "⏸" }),
                                )
                                .clicked()
                            {
                                if let Some(mpv) = &mut self.mpv {
                                    mpv.set_paused(!mpv.paused);
                                }
                            }
                            if ui.add_enabled(playing, egui::Button::new("⏹")).clicked() {
                                if let Some(mpv) = &mut self.mpv {
                                    mpv.stop();
                                }
                            }
                            if ui.button("⏩").clicked() {
                                if let Some(mpv) = &mut self.mpv {
                                    mpv.seek_relative(10.0);
                                }
                            }
                            if ui.button("⏭").clicked() {
                                self.navigate(1);
                            }

                            if self.settings.show_progress && playing {
                                let (mut t, dur) = self
                                    .mpv
                                    .as_mut()
                                    .map(|m| (m.time_pos(), m.duration()))
                                    .unwrap_or((0.0, 0.0));
                                if dur > 0.0 {
                                    if let Some(v) = self.seek_drag {
                                        t = v;
                                    }
                                    let text = format!("{:.0}s / {:.0}s", t, dur);
                                    let slider = egui::Slider::new(&mut t, 0.0..=dur).text(text);
                                    let response = ui.add_sized([380.0, 20.0], slider);
                                    if response.dragged() {
                                        self.seek_drag = Some(t);
                                    } else if let Some(v) = self.seek_drag.take() {
                                        if let Some(mpv) = &mut self.mpv {
                                            mpv.seek_absolute(v);
                                        }
                                    } else if response.changed() {
                                        if let Some(mpv) = &mut self.mpv {
                                            mpv.seek_absolute(t);
                                        }
                                    }
                                } else {
                                    // No duration (live): show elapsed time only.
                                    ui.label(format!("{:.0}s", t));
                                }
                            }

                            if let Some(mpv) = &mut self.mpv {
                                let tracks = mpv.sub_tracks();
                                if !tracks.is_empty() {
                                    let mut current = mpv.current_sub_id();
                                    let mut selected = false;
                                    egui::ComboBox::from_id_salt("sub_track")
                                        .selected_text(if current == 0 {
                                            "CC off".to_string()
                                        } else {
                                            tracks
                                                .iter()
                                                .find(|t| t.id == current)
                                                .map(|t| format!("CC: {}", t.label()))
                                                .unwrap_or_else(|| format!("CC: {current}"))
                                        })
                                        .width(140.0)
                                        .show_ui(ui, |ui| {
                                            if ui.selectable_label(current == 0, "off").clicked() {
                                                current = 0;
                                                selected = true;
                                            }
                                            for t in &tracks {
                                                if ui
                                                    .selectable_label(t.id == current, t.label())
                                                    .clicked()
                                                {
                                                    current = t.id;
                                                    selected = true;
                                                }
                                            }
                                        });
                                    if selected {
                                        mpv.set_sub_track(current);
                                    }
                                }
                            }

                            let mut save_volume = false;
                            if let Some(mpv) = &mut self.mpv {
                                if ui.button(if mpv.muted() { "🔇" } else { "🔊" }).clicked() {
                                    mpv.set_mute(!mpv.muted());
                                }
                                let mut vol = mpv.volume;
                                let slider =
                                    ui.add(egui::Slider::new(&mut vol, 0..=130).text("Vol"));
                                if slider.changed() {
                                    mpv.set_volume(vol);
                                    self.settings.volume = vol;
                                }
                                save_volume = slider.drag_stopped();

                                let mut speed = mpv.speed();
                                let mut speed_selected = false;
                                egui::ComboBox::from_id_salt("playback_speed")
                                    .selected_text(format!("{speed:.2}x"))
                                    .width(72.0)
                                    .show_ui(ui, |ui| {
                                        for s in [0.25, 0.5, 1.0, 1.5, 2.0, 4.0] {
                                            if ui
                                                .selectable_label(
                                                    (speed - s).abs() < 0.01,
                                                    format!("{s}x"),
                                                )
                                                .clicked()
                                            {
                                                speed = s;
                                                speed_selected = true;
                                            }
                                        }
                                    });
                                if speed_selected {
                                    mpv.set_speed(speed);
                                }
                            }
                            if save_volume {
                                self.save_settings();
                            }

                            if ui.button("📖").on_hover_text("Reading (r)").clicked() {
                                self.reading_open = !self.reading_open;
                            }
                            if ui.button("📺").on_hover_text("Channels (c)").clicked() {
                                self.channels_open = !self.channels_open;
                            }
                            if ui.button("☰").on_hover_text("Subtitle list (l)").clicked() {
                                self.sub_list_open = !self.sub_list_open;
                            }
                            ui.menu_button("💬", |ui| {
                                ui.label("WhisperSubs (F1)");
                                ui.separator();
                                for (i, label) in
                                    ["Library", "Channels", "Live", "Subs"].into_iter().enumerate()
                                {
                                    if ui
                                        .selectable_label(self.ws_section == i as u8, label)
                                        .clicked()
                                    {
                                        self.ws_section = i as u8;
                                        self.ws_channel = None;
                                        self.ws_error = None;
                                        self.ws_open = true;
                                        ui.close_menu();
                                    }
                                }
                                ui.separator();
                                if ui
                                    .button("Transcribe current")
                                    .on_hover_text("Send the loaded media to the whisper-subs server and stream its subtitles")
                                    .clicked()
                                {
                                    self.ws_section = 0;
                                    self.ws_open = true;
                                    self.ws_transcribe_current();
                                    ui.close_menu();
                                }
                            });
                            if ui.button("⚙").clicked() {
                                self.settings_open = !self.settings_open;
                            }
                            if ui.button("✕").clicked() {
                                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                            }
                        });
                    });
            });

        if self.settings_open {
            self.paint_settings_window(ctx);
        }
    }

    /// The reading panel: a teleprompter strip at the bottom with the current
    /// line large and ruby-annotated (furigana/pinyin), recent lines above,
    /// and click-to-seek. Falls back to the live mpv sub-text when no parsed
    /// external track exists.
    fn paint_reading(&mut self, ctx: &egui::Context) {
        let t = self.mpv.as_ref().map(|m| m.time_pos()).unwrap_or(0.0);
        let (list, current) = match self.current_line_index() {
            Some(idx) => {
                let list = self
                    .subs_parsed
                    .get(&self.tracked_primary_sid)
                    .cloned()
                    .unwrap_or_default();
                (list, Some(idx))
            }
            None => (Vec::new(), None),
        };

        egui::TopBottomPanel::bottom("reading_panel")
            .resizable(true)
            .default_height(220.0)
            .show(ctx, |ui| {
                let heading_font = egui::TextStyle::Heading.resolve(ui.style());
                let big = heading_font.size * 0.9;
                let big_reading = heading_font.size * 0.5;
                let body_font = egui::TextStyle::Body.resolve(ui.style());
                let small = body_font.size;
                let small_reading = body_font.size * 0.65;

                // Scrollback of recent lines, oldest on top.
                let history_start = current
                    .map(|idx| idx.saturating_sub(15))
                    .unwrap_or(list.len().saturating_sub(15));
                let history_end = current.unwrap_or(list.len());
                if history_end > history_start {
                    egui::ScrollArea::vertical()
                        .max_height(ui.available_height() * 0.55)
                        .auto_shrink([false, false])
                        .show(ui, |ui| {
                            for line in &list[history_start..history_end] {
                                let annotated = crate::player_ui::reading::annotate(&line.text);
                                let response = paint_ruby_line(
                                    ui,
                                    &crate::player_ui::reading::parse_ruby(&annotated),
                                    small,
                                    small_reading,
                                );
                                if response.clicked() {
                                    let pos = (line.start + SEEK_ERROR).max(0.0);
                                    if let Some(mpv) = &mut self.mpv {
                                        mpv.seek_absolute(pos);
                                    }
                                }
                            }
                        });
                    ui.separator();
                }

                // The current line, large.
                let current_text = match current.and_then(|idx| list.get(idx)) {
                    Some(line) => line.text.clone(),
                    None => self.mpv.as_ref().map(|m| m.sub_text()).unwrap_or_default(),
                };
                if current_text.trim().is_empty() {
                    ui.weak("(no subtitle line showing)");
                } else {
                    let annotated = crate::player_ui::reading::annotate(&current_text);
                    paint_ruby_line(
                        ui,
                        &crate::player_ui::reading::parse_ruby(&annotated),
                        big,
                        big_reading,
                    );
                }
            });
        let _ = t;
    }

    fn paint_settings_window(&mut self, ctx: &egui::Context) {
        let mut open = self.settings_open;
        let sub_tracks = self
            .mpv
            .as_ref()
            .map(|m| m.sub_tracks())
            .unwrap_or_default();
        let current_sub = self.mpv.as_ref().map(|m| m.current_sub_id()).unwrap_or(0);
        let mut sub_pick: Option<i64> = None;
        let mode_label = self.sub_mode().as_str();
        let primary_delay = self.effective_delay_primary();
        let secondary_delay = self.effective_delay_secondary();
        let primary_override = self.delay_primary_ephemeral.is_some();
        let secondary_override = self.delay_secondary_ephemeral.is_some();
        let mut sub_action: Option<SubUiAction> = None;
        egui::Window::new("Player settings")
            .open(&mut open)
            .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
            .show(ctx, |ui| {
                let s = &mut self.settings;

                ui.horizontal(|ui| {
                    ui.label("Controls:");
                    egui::ComboBox::from_id_salt("controls_mode")
                        .selected_text(&s.controls)
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut s.controls, CONTROLS_AUTO.to_string(), "auto");
                            ui.selectable_value(
                                &mut s.controls,
                                CONTROLS_ALWAYS.to_string(),
                                "always",
                            );
                            ui.selectable_value(
                                &mut s.controls,
                                CONTROLS_NEVER.to_string(),
                                "never",
                            );
                        });
                });
                ui.checkbox(&mut s.show_title, "Show media title overlay");
                ui.checkbox(&mut s.show_progress, "Show progress bar");
                ui.checkbox(&mut s.loop_playlist, "Loop playlist");
                ui.separator();
                ui.checkbox(&mut s.borderless, "Borderless window");
                ui.checkbox(&mut s.always_on_top, "Always on top");
                ui.checkbox(&mut s.fullscreen, "Fullscreen");
                ui.separator();
                ui.horizontal(|ui| {
                    ui.label("Font scale:");
                    ui.add(egui::Slider::new(&mut s.font_scale, 0.5..=2.0));
                });
                ui.horizontal(|ui| {
                    ui.label("Overlay opacity:");
                    ui.add(egui::Slider::new(&mut s.overlay_opacity, 0.1..=1.0));
                });
                ui.horizontal(|ui| {
                    ui.label("Theme:");
                    egui::ComboBox::from_id_salt("theme")
                        .selected_text(&s.theme)
                        .show_ui(ui, |ui| {
                            for t in crate::player_ui::settings::THEMES {
                                ui.selectable_value(
                                    &mut s.theme,
                                    t.to_string(),
                                    *t,
                                );
                            }
                        });
                });
                ui.horizontal(|ui| {
                    ui.label("Accent (hex, empty = theme default):");
                    ui.text_edit_singleline(&mut s.accent);
                });
                ui.horizontal(|ui| {
                    ui.label("Rounding:");
                    ui.add(egui::Slider::new(&mut s.rounding, 0.0..=24.0));
                });
                ui.separator();
                ui.heading("Subtitles");
                ui.horizontal(|ui| {
                    ui.label("Mode:");
                    egui::ComboBox::from_id_salt("sub_mode")
                        .selected_text(mode_label)
                        .show_ui(ui, |ui| {
                            for mode in SubtitleMode::ALL {
                                ui.selectable_value(
                                    &mut s.sub_mode,
                                    mode.as_str().to_string(),
                                    mode.as_str(),
                                );
                            }
                        });
                    if ui.button("Cycle (ctrl+m)").clicked() {
                        sub_action = Some(SubUiAction::CycleMode);
                    }
                    if ui.button("Toggle stack (ctrl+s)").clicked() {
                        sub_action = Some(SubUiAction::ToggleSecondary);
                    }
                });
                ui.checkbox(&mut s.sub_pause_end, "Pause when a subtitle ends");
                ui.label("Sync (nudge with ctrl+[ / ctrl+], shift for the stack):");
                ui.horizontal(|ui| {
                    ui.label(format!("Primary: {:+.2}s", primary_delay));
                    if ui.button("-0.1").clicked() {
                        sub_action = Some(SubUiAction::Nudge {
                            secondary: false,
                            delta: -0.1,
                        });
                    }
                    if ui.button("+0.1").clicked() {
                        sub_action = Some(SubUiAction::Nudge {
                            secondary: false,
                            delta: 0.1,
                        });
                    }
                    if ui.button("reset").clicked() {
                        sub_action = Some(SubUiAction::Reset(false));
                    }
                    if primary_override {
                        ui.label("(session override)");
                    }
                });
                ui.horizontal(|ui| {
                    ui.label(format!("Stack: {:+.2}s", secondary_delay));
                    if ui.button("-0.1").clicked() {
                        sub_action = Some(SubUiAction::Nudge {
                            secondary: true,
                            delta: -0.1,
                        });
                    }
                    if ui.button("+0.1").clicked() {
                        sub_action = Some(SubUiAction::Nudge {
                            secondary: true,
                            delta: 0.1,
                        });
                    }
                    if ui.button("reset").clicked() {
                        sub_action = Some(SubUiAction::Reset(true));
                    }
                    if secondary_override {
                        ui.label("(session override)");
                    }
                });
                ui.label(format!(
                    "Global defaults: {:+.2}s / {:+.2}s (max ±{:.0}s)",
                    s.sub_delay_primary, s.sub_delay_secondary, MAX_SUB_DELAY
                ));
                if !sub_tracks.is_empty() {
                    ui.horizontal(|ui| {
                        ui.label("Track:");
                        let current_label = if current_sub == 0 {
                            "off".to_string()
                        } else {
                            sub_tracks
                                .iter()
                                .find(|t| t.id == current_sub)
                                .map(|t| t.label())
                                .unwrap_or_else(|| current_sub.to_string())
                        };
                        egui::ComboBox::from_id_salt("settings_sub_track")
                            .selected_text(current_label)
                            .show_ui(ui, |ui| {
                                if ui.selectable_label(current_sub == 0, "off").clicked() {
                                    sub_pick = Some(0);
                                }
                                for t in &sub_tracks {
                                    if ui.selectable_label(t.id == current_sub, t.label()).clicked()
                                    {
                                        sub_pick = Some(t.id);
                                    }
                                }
                            });
                        ui.label("Stack:");
                        egui::ComboBox::from_id_salt("settings_sub_secondary")
                            .selected_text(if s.sub_secondary_id == 0 {
                                "off".to_string()
                            } else {
                                sub_tracks
                                    .iter()
                                    .find(|t| t.id == s.sub_secondary_id)
                                    .map(|t| t.label())
                                    .unwrap_or_else(|| s.sub_secondary_id.to_string())
                            })
                            .show_ui(ui, |ui| {
                                if ui
                                    .selectable_label(s.sub_secondary_id == 0, "off")
                                    .clicked()
                                {
                                    s.sub_secondary_id = 0;
                                }
                                for t in &sub_tracks {
                                    if ui
                                        .selectable_label(t.id == s.sub_secondary_id, t.label())
                                        .clicked()
                                    {
                                        s.sub_secondary_id = t.id;
                                    }
                                }
                            });
                    });
                }
                ui.horizontal(|ui| {
                    ui.label("Position:");
                    ui.add(egui::Slider::new(&mut s.sub_pos, 0..=100).text("0 = top, 100 = bottom"));
                });
                ui.horizontal(|ui| {
                    ui.label("Font:");
                    ui.text_edit_singleline(&mut s.sub_font);
                });
                ui.horizontal(|ui| {
                    ui.label("Font size:");
                    ui.add(egui::Slider::new(&mut s.sub_font_size, 10.0..=120.0));
                });
                ui.horizontal(|ui| {
                    ui.label("Scale:");
                    ui.add(egui::Slider::new(&mut s.sub_scale, 0.1..=5.0));
                });
                ui.horizontal(|ui| {
                    ui.label("Text color (hex, empty = default):");
                    ui.text_edit_singleline(&mut s.sub_color);
                });
                ui.horizontal(|ui| {
                    ui.label("Border color:");
                    ui.text_edit_singleline(&mut s.sub_border_color);
                });
                ui.horizontal(|ui| {
                    ui.label("Border size:");
                    ui.add(egui::Slider::new(&mut s.sub_border_size, 0.0..=10.0));
                });
                ui.checkbox(
                    &mut s.sub_ass_override,
                    "Force styling on ASS subtitles (needed for youtube/position/scale)",
                );
                ui.separator();
                ui.heading("Video framing");
                ui.horizontal(|ui| {
                    ui.label("Pan X:");
                    ui.add(egui::Slider::new(&mut s.video_pan_x, -1.0..=1.0));
                });
                ui.horizontal(|ui| {
                    ui.label("Pan Y:");
                    ui.add(egui::Slider::new(&mut s.video_pan_y, -1.0..=1.0));
                });
                ui.horizontal(|ui| {
                    ui.label("Zoom:");
                    ui.add(egui::Slider::new(&mut s.video_zoom, 0.5..=4.0));
                });
                ui.separator();
                ui.heading("SRS / Anki");
                ui.horizontal(|ui| {
                    ui.label("AnkiConnect URL:");
                    ui.text_edit_singleline(&mut s.srs_url);
                });
                ui.horizontal(|ui| {
                    ui.label("Deck:");
                    ui.text_edit_singleline(&mut s.srs_deck);
                    ui.label("Model:");
                    ui.text_edit_singleline(&mut s.srs_model);
                });
                ui.horizontal(|ui| {
                    ui.label("Tags:");
                    ui.text_edit_singleline(&mut s.srs_tags);
                });
                ui.checkbox(&mut s.srs_screenshot, "Attach screenshot");
                ui.checkbox(&mut s.srs_audio, "Attach audio clip");
                ui.horizontal(|ui| {
                    ui.label("Audio padding (s):");
                    ui.add(egui::Slider::new(&mut s.srs_audio_pad, 0.0..=2.0));
                });
                ui.separator();
                ui.horizontal(|ui| {
                    if ui.button("Apply").clicked() {
                        self.apply_viewport_settings(ctx);
                        self.apply_sub_settings();
                        self.theme_applied = false;
                        self.save_settings();
                    }
                    if ui.button("Reset defaults").clicked() {
                        self.settings = PlayerUiSettings::default();
                        self.apply_viewport_settings(ctx);
                        self.apply_sub_settings();
                        self.theme_applied = false;
                        self.save_settings();
                    }
                });
                ui.label(format!(
                    "settings file: {}",
                    PlayerUiSettings::path(&self.config_dir).display()
                ));
                ui.separator();
                ui.label("shortcuts: space pause · ←/→ seek ±10s · ↑/↓ volume · m mute · f fullscreen · , . frame step · v primary lane · j next track · ctrl+m sub mode · ctrl+s stack lane · ctrl+[ ] sub delay (shift = stack) · [ ] sub size · l sub list");
            });
        if let Some(id) = sub_pick {
            if let Some(mpv) = &mut self.mpv {
                mpv.set_sub_track(id);
            }
        }
        match sub_action {
            Some(SubUiAction::CycleMode) => self.cycle_sub_mode(),
            Some(SubUiAction::ToggleSecondary) => self.toggle_secondary(),
            Some(SubUiAction::Nudge { secondary, delta }) => self.nudge_delay(secondary, delta),
            Some(SubUiAction::Reset(secondary)) => self.reset_delay(secondary),
            None => {}
        }
        self.settings_open = open;
    }
}

impl eframe::App for PlayerApp {
    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        if !self.theme_applied {
            self.apply_theme(ctx);
            self.apply_viewport_settings(ctx);
        }

        self.drain_commands(ctx);
        while let Ok(result) = self.post_rx.try_recv() {
            self.channels_error = result.err();
        }

        self.refresh_subtitle_lists();
        self.handle_pause_on_subtitle_end();

        // Ignore shortcuts while a text field has the keyboard (search box,
        // settings inputs).
        let typing = ctx.wants_keyboard_input();
        let (
            space,
            left,
            right,
            up,
            down,
            mute_key,
            full,
            step_fwd,
            step_back,
            subs_toggle,
            sub_next,
            list_toggle,
            sub_bigger,
            sub_smaller,
            sec_toggle,
            ctrl,
            shift,
            ch_next,
            ch_prev,
            ch_panel,
            srs_mine,
            reading_toggle,
            f1,
        ) = ctx.input(|i| {
            (
                i.key_pressed(egui::Key::Space),
                i.key_pressed(egui::Key::ArrowLeft),
                i.key_pressed(egui::Key::ArrowRight),
                i.key_pressed(egui::Key::ArrowUp),
                i.key_pressed(egui::Key::ArrowDown),
                i.key_pressed(egui::Key::M),
                i.key_pressed(egui::Key::F),
                i.key_pressed(egui::Key::Period),
                i.key_pressed(egui::Key::Comma),
                i.key_pressed(egui::Key::V),
                i.key_pressed(egui::Key::J),
                i.key_pressed(egui::Key::L),
                i.key_pressed(egui::Key::OpenBracket),
                i.key_pressed(egui::Key::CloseBracket),
                i.key_pressed(egui::Key::S),
                i.modifiers.ctrl,
                i.modifiers.shift,
                i.key_pressed(egui::Key::N),
                i.key_pressed(egui::Key::B),
                i.key_pressed(egui::Key::C),
                i.key_pressed(egui::Key::A),
                i.key_pressed(egui::Key::R),
                i.key_pressed(egui::Key::F1),
            )
        });
        let space = space && !typing;
        let left = left && !typing;
        let right = right && !typing;
        let up = up && !typing;
        let down = down && !typing;
        let mute_key = mute_key && !typing;
        let full = full && !typing;
        let step_fwd = step_fwd && !typing;
        let step_back = step_back && !typing;
        let subs_toggle = subs_toggle && !typing;
        let sub_next = sub_next && !typing;
        let list_toggle = list_toggle && !typing;
        let sub_bigger = sub_bigger && !typing && !ctrl;
        let sub_smaller = sub_smaller && !typing && !ctrl;
        let ch_next = ch_next && !typing;
        let ch_prev = ch_prev && !typing;
        let ch_panel = ch_panel && !typing;
        let srs_mine = srs_mine && !typing;
        let reading_toggle = reading_toggle && !typing;
        if space {
            if let Some(mpv) = &mut self.mpv {
                mpv.set_paused(!mpv.paused);
            }
        }
        if left {
            if let Some(mpv) = &mut self.mpv {
                mpv.seek_relative(-10.0);
            }
        }
        if right {
            if let Some(mpv) = &mut self.mpv {
                mpv.seek_relative(10.0);
            }
        }
        if up || down {
            if let Some(mpv) = &mut self.mpv {
                let v = (mpv.volume + if up { 5 } else { -5 }).clamp(0, 130);
                mpv.set_volume(v);
                self.settings.volume = v;
            }
        }
        if mute_key && !ctrl {
            if let Some(mpv) = &mut self.mpv {
                mpv.set_mute(!mpv.muted());
            }
        }
        if mute_key && ctrl {
            // ctrl+m: cycle subtitle visibility modes.
            self.cycle_sub_mode();
        }
        if sec_toggle && ctrl {
            // ctrl+s: toggle the stacked secondary lane.
            self.toggle_secondary();
        }
        if full && !ctrl {
            self.settings.fullscreen = !self.settings.fullscreen;
            self.apply_viewport_settings(ctx);
            self.save_settings();
        }
        if step_fwd {
            if let Some(mpv) = &mut self.mpv {
                mpv.frame_step();
            }
        }
        if step_back {
            if let Some(mpv) = &mut self.mpv {
                mpv.frame_back_step();
            }
        }
        if subs_toggle {
            // v: toggle the primary lane (mode-derived visibility).
            self.toggle_primary_lane();
        }
        if sub_next {
            if let Some(mpv) = &mut self.mpv {
                mpv.cycle_sub();
            }
        }
        if list_toggle {
            self.sub_list_open = !self.sub_list_open;
        }
        if sub_bigger || sub_smaller {
            // Memento's subtitle size increase/decrease.
            let factor = if sub_bigger { 1.1 } else { 1.0 / 1.1 };
            self.settings.sub_scale = (self.settings.sub_scale * factor).clamp(0.1, 5.0);
            if let Some(mpv) = &mut self.mpv {
                mpv.set_sub_scale(self.settings.sub_scale);
            }
        }
        // Subtitle sync: ctrl+[ ] nudges the primary delay, ctrl+shift+[ ]
        // the secondary lane. Plain [ ] stays subtitle size (above).
        if ctrl && !typing {
            if sub_smaller {
                self.nudge_delay(shift, -0.1);
            }
            if sub_bigger {
                self.nudge_delay(shift, 0.1);
            }
        }

        if ch_next {
            self.post_channel_command("next", &serde_json::json!({ "screen": self.screen }));
        }
        if ch_prev {
            self.post_channel_command("prev", &serde_json::json!({ "screen": self.screen }));
        }
        if ch_panel {
            self.channels_open = !self.channels_open;
        }
        if f1 {
            // F1: whisper-subs browse panel (library/channels/live/subs).
            self.ws_open = !self.ws_open;
            if self.ws_open {
                self.ws_error = None;
            }
        }
        if srs_mine {
            // a: mine the current subtitle line into Anki.
            self.mine_current_line();
        }
        if reading_toggle {
            // r: reading panel with furigana/pinyin.
            self.reading_open = !self.reading_open;
        }

        self.drain_srs();
        self.drain_channels();
        self.drain_ws();
        self.handle_events();
        self.render_mpv(frame);
        // Panels first, then the central video area (egui gives panels the
        // space they claim; the video takes what remains).
        if self.channels_open {
            self.paint_channels(ctx);
        }
        if self.ws_open {
            self.paint_whisper_subs(ctx);
        }
        if self.sub_list_open {
            self.paint_subtitle_list(ctx);
        }
        if self.reading_open {
            self.paint_reading(ctx);
        }
        self.paint_video(ctx);
        self.paint_overlays(ctx);

        let playing = self.mpv.as_ref().map(|m| m.playing).unwrap_or(false);
        if playing {
            ctx.request_repaint();
        } else {
            ctx.request_repaint_after(Duration::from_millis(200));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_end_routing_prefers_the_server_when_it_drives_the_window() {
        assert_eq!(end_action(true, true), EndAction::NotifyServer);
        assert_eq!(end_action(true, false), EndAction::AdvanceLocal);
        assert_eq!(end_action(false, true), EndAction::AdvanceLocal);
        assert_eq!(end_action(false, false), EndAction::AdvanceLocal);
    }

    #[test]
    fn redundant_transition_stops_are_ignored_when_server_driven() {
        // Server-driven window, media already ended: transition stop ignored.
        assert!(!apply_stop(true, false));
        // Server-driven window mid-playback: a real stop.
        assert!(apply_stop(true, true));
        // Local window: every stop applies.
        assert!(apply_stop(false, false));
        assert!(apply_stop(false, true));
    }
}
