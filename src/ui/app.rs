use std::ffi::{c_void, CStr};
use std::sync::{mpsc::Receiver, Arc};

use eframe::egui;

use crate::core::orchestrator::embedded_ops::EmbeddedEndKind;
use crate::core::orchestrator::Orchestrator;
use crate::core::state::StreamState;
use crate::queue::queue::StreamSource;
use crate::services::libmpv::{MpvVideo, PlayerEvent};

enum Tab {
    Streams,
    Config,
}

/// Periodically refreshed snapshot of orchestrator state, so the UI never
/// blocks on orchestrator locks during repaint.
#[derive(Clone, Default)]
struct UiSnapshot {
    states: [Option<StreamState>; 2],
    queues: [Vec<StreamSource>; 2],
    active: usize,
}

pub struct LiveLinkApp {
    orchestrator: Arc<Orchestrator>,
    players: [Option<MpvVideo>; 2],
    current_url: [Option<String>; 2],
    pending_starts: [Vec<Receiver<Result<StreamSource, String>>>; 2],
    snapshot: UiSnapshot,
    snapshot_rx: Receiver<UiSnapshot>,
    selected_screen: u32,
    volume: u8,
    search_query: String,
    show_multi_view: bool,
    current_tab: Tab,
    config_holodex_key: String,
    config_twitch_client_id: String,
    config_twitch_secret: String,
    config_youtube_key: String,
    config_max_streams: usize,
    config_player_type: String,
    config_default_quality: String,
    config_default_volume: u8,
    config_auto_start: bool,
    config_disable_heartbeat: bool,
    config_screen0_width: u32,
    config_screen0_height: u32,
    config_screen0_quality: String,
    config_screen1_width: u32,
    config_screen1_height: u32,
    config_screen1_quality: String,
    config_log_level: String,
}

impl LiveLinkApp {
    pub fn new(orchestrator: Arc<Orchestrator>, cc: &eframe::CreationContext<'_>) -> Self {
        let max_streams = orchestrator.max_streams;

        // Background task that polls orchestrator state and queues every
        // 500ms and ships snapshots to the UI thread.
        let (snapshot_tx, snapshot_rx) = std::sync::mpsc::channel::<UiSnapshot>();
        {
            let orch = orchestrator.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
                loop {
                    interval.tick().await;
                    let states = [orch.get_state(0).await, orch.get_state(1).await];
                    let mut queues: [Vec<StreamSource>; 2] = [Vec::new(), Vec::new()];
                    let queue_service = orch.get_queue();
                    if let Ok(q) = queue_service.try_lock() {
                        for s in 0..2u32 {
                            queues[s as usize] = q
                                .get_queue(s)
                                .map(|q| q.sources().to_vec())
                                .unwrap_or_default();
                        }
                    }
                    let snapshot = UiSnapshot {
                        states,
                        queues,
                        active: orch.count_active_streams(),
                    };
                    if snapshot_tx.send(snapshot).is_err() {
                        break; // UI closed
                    }
                }
            });
        }

        // Embedded players need the glow context and its proc address loader.
        let mut players: [Option<MpvVideo>; 2] = [None, None];
        if let (Some(gl), Some(proc_addr)) = (&cc.gl, cc.get_proc_address) {
            // SAFETY: the loader is owned by the eframe runner and outlives
            // the app.
            let proc_addr: &'static dyn Fn(&CStr) -> *const c_void =
                unsafe { std::mem::transmute(proc_addr) };
            for (i, player) in players.iter_mut().enumerate() {
                let (w, h) = orchestrator
                    .config
                    .screens
                    .get(i)
                    .map(|s| (s.width, s.height))
                    .unwrap_or((1280, 720));
                match MpvVideo::new(gl, proc_addr, w, h) {
                    Ok(p) => *player = Some(p),
                    Err(e) => tracing::warn!(
                        screen = i,
                        error = %e,
                        "Failed to init embedded mpv player, falling back to subprocess"
                    ),
                }
            }
        }

        Self {
            orchestrator,
            players,
            current_url: [None, None],
            pending_starts: [Vec::new(), Vec::new()],
            snapshot: UiSnapshot::default(),
            snapshot_rx,
            selected_screen: 0,
            volume: 50,
            search_query: String::new(),
            show_multi_view: false,
            current_tab: Tab::Streams,
            config_holodex_key: String::new(),
            config_twitch_client_id: String::new(),
            config_twitch_secret: String::new(),
            config_youtube_key: String::new(),
            config_max_streams: max_streams,
            config_player_type: "mpv".to_string(),
            config_default_quality: "best".to_string(),
            config_default_volume: 50,
            config_auto_start: false,
            config_disable_heartbeat: false,
            config_screen0_width: 1280,
            config_screen0_height: 720,
            config_screen0_quality: "best".to_string(),
            config_screen1_width: 1280,
            config_screen1_height: 720,
            config_screen1_quality: "best".to_string(),
            config_log_level: "info".to_string(),
        }
    }

    // ------------------------------------------------------------------
    // State plumbing
    // ------------------------------------------------------------------

    fn poll_updates(&mut self) {
        // Apply the latest snapshot
        while let Ok(snapshot) = self.snapshot_rx.try_recv() {
            self.snapshot = snapshot;
        }

        // Collect pending queue fetches
        for screen in 0..2 {
            let mut remaining = Vec::new();
            while let Some(rx) = self.pending_starts[screen].pop() {
                match rx.try_recv() {
                    Ok(Ok(source)) => {
                        if let Some(p) = &mut self.players[screen] {
                            tracing::info!(screen, url = %source.url, "UI starting stream");
                            p.load(&source.url);
                            self.current_url[screen] = Some(source.url.clone());
                        }
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(screen, error = %e, "UI failed to take next stream");
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => remaining.push(rx),
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                        tracing::warn!(screen, "Queue fetch task dropped without a result");
                    }
                }
            }
            self.pending_starts[screen] = remaining;
        }

        // Drain player events
        for screen in 0..2 {
            let events =
                if let Some(p) = &mut self.players[screen] { p.poll_events() } else { Vec::new() };
            for ev in events {
                self.on_player_event(screen, ev);
            }
        }
    }

    fn player_time(&self, screen: usize) -> f64 {
        self.players[screen].as_ref().map(|p| p.time_pos()).unwrap_or(0.0)
    }

    fn on_player_event(&mut self, screen: usize, ev: PlayerEvent) {
        let screen_id = screen as u32;
        let url = self.current_url[screen].clone().unwrap_or_default();
        let orch = self.orchestrator.clone();
        match ev {
            PlayerEvent::Loaded => {
                tokio::spawn(async move {
                    orch.mark_embedded_playing(screen_id).await;
                });
            }
            PlayerEvent::Eof => {
                let time = self.player_time(screen);
                tokio::spawn(async move {
                    orch.embedded_stream_ended(screen_id, url, time, EmbeddedEndKind::Eof).await;
                });
                self.current_url[screen] = None;
                self.request_next(screen);
            }
            PlayerEvent::Stopped => {
                let time = self.player_time(screen);
                tokio::spawn(async move {
                    orch.embedded_stream_ended(screen_id, url, time, EmbeddedEndKind::Stop).await;
                });
                self.current_url[screen] = None;
            }
            PlayerEvent::Failed => {
                let time = self.player_time(screen);
                let skip = self.orchestrator.config.skip_threshold_seconds as f64;
                let advance = time >= skip; // soft-skip or long failure -> next stream
                tokio::spawn(async move {
                    orch.embedded_stream_ended(screen_id, url, time, EmbeddedEndKind::Error).await;
                });
                self.current_url[screen] = None;
                if advance {
                    self.request_next(screen);
                }
            }
        }
    }

    fn request_next(&mut self, screen: usize) {
        if self.players[screen].is_none() {
            return;
        }
        let orch = self.orchestrator.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        tokio::spawn(async move {
            let _ = tx.send(orch.take_next_stream(screen as u32).await);
        });
        self.pending_starts[screen].push(rx);
    }

    fn render_players(&mut self, frame: &mut eframe::Frame) {
        for player in self.players.iter_mut().flatten() {
            player.register_texture(frame);
            player.render();
        }
    }

    fn any_playing(&self) -> bool {
        self.players.iter().flatten().any(|p| p.playing)
    }

    fn get_state(&self, screen: u32) -> StreamState {
        self.snapshot.states[screen as usize].unwrap_or(StreamState::Idle)
    }

    fn filter_queue(&self, queue: &[StreamSource]) -> Vec<StreamSource> {
        if self.search_query.is_empty() {
            return queue.to_vec();
        }
        let query = self.search_query.to_lowercase();
        queue
            .iter()
            .filter(|s| {
                s.title.as_ref().map(|t| t.to_lowercase().contains(&query)).unwrap_or(false)
                    || s.url.to_lowercase().contains(&query)
                    || s.channel.as_ref().map(|c| c.to_lowercase().contains(&query)).unwrap_or(false)
                    || s.platform.as_ref().map(|p| p.to_lowercase().contains(&query)).unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------

    fn render_video(&self, ui: &mut egui::Ui, screen: u32) {
        if let Some(player) = &self.players[screen as usize] {
            if let Some(id) = player.texture_id() {
                let avail = ui.available_size();
                ui.add(
                    egui::Image::new(egui::load::SizedTexture::new(
                        id,
                        [player.width as f32, player.height as f32],
                    ))
                    .max_size(avail),
                );
            }
        }
    }

    fn render_screen_panel(&mut self, ui: &mut egui::Ui, screen: u32) {
        let state = self.get_state(screen);
        let queue = self.snapshot.queues[screen as usize].clone();
        let filtered = self.filter_queue(&queue);

        ui.heading(format!("Screen {}", screen));
        self.render_video(ui, screen);

        let is_idle = state == StreamState::Idle || state == StreamState::Error;
        let is_playing = state == StreamState::Playing;

        ui.horizontal(|ui| {
            if ui.add_enabled(is_idle, egui::Button::new("▶ Start")).clicked() {
                if self.players[screen as usize].is_some() {
                    self.request_next(screen as usize);
                } else {
                    let orch = self.orchestrator.clone();
                    tokio::spawn(async move {
                        let _ = orch.start_stream(screen).await;
                    });
                }
            }
            if ui.add_enabled(is_playing, egui::Button::new("⏹ Stop")).clicked() {
                if let Some(p) = &mut self.players[screen as usize] {
                    p.stop();
                } else {
                    let orch = self.orchestrator.clone();
                    tokio::spawn(async move {
                        let _ = orch.stop_stream(screen).await;
                    });
                }
            }
            if ui.add_enabled(is_playing, egui::Button::new("⏸ Pause")).clicked() {
                if let Some(p) = &mut self.players[screen as usize] {
                    p.set_paused(!p.paused);
                } else {
                    let orch = self.orchestrator.clone();
                    tokio::spawn(async move {
                        let _ = orch.player_pause(screen).await;
                    });
                }
            }
            if ui.add_enabled(is_playing, egui::Button::new("⏪")).clicked() {
                if let Some(p) = &mut self.players[screen as usize] {
                    p.seek_relative(-10.0);
                }
            }
            if ui.add_enabled(is_playing, egui::Button::new("⏩")).clicked() {
                if let Some(p) = &mut self.players[screen as usize] {
                    p.seek_relative(10.0);
                }
            }
            ui.label(format!("{:?}", state));
        });

        ui.horizontal(|ui| {
            let mut seek_to = None;
            if let Some(p) = &mut self.players[screen as usize] {
                let t = p.time_pos();
                ui.label(format!("t: {:.0}s", t));
                let dur = p.duration();
                if dur > 0.0 {
                    let mut pos = t;
                    let slider = egui::Slider::new(&mut pos, 0.0..=dur);
                    let r = ui.add_sized([140.0, 18.0], slider);
                    if r.changed() {
                        seek_to = Some(pos);
                    }
                }
                if ui.button(if p.muted() { "🔇" } else { "🔊" }).clicked() {
                    p.set_mute(!p.muted());
                }
            } else {
                ui.label("t:");
            }
            ui.label("Vol:");
            let mut vol = self.players[screen as usize]
                .as_ref()
                .map(|p| p.volume as u8)
                .unwrap_or(self.volume);
            if ui.add(egui::Slider::new(&mut vol, 0..=100)).changed()
                && self.players[screen as usize].is_some()
            {
                if let Some(p) = &mut self.players[screen as usize] {
                    p.set_volume(vol as i64);
                }
            }
            self.volume = vol;
            if let Some(pos) = seek_to {
                if let Some(p) = &mut self.players[screen as usize] {
                    p.seek_absolute(pos);
                }
            }
        });

        ui.separator();

        if filtered.is_empty() {
            if queue.is_empty() {
                ui.label("No streams in queue");
            } else {
                ui.label("No matching streams (search filter)");
            }
        } else {
            egui::ScrollArea::vertical().max_height(220.0).show(ui, |ui| {
                for (i, source) in filtered.iter().enumerate() {
                    ui.horizontal(|ui| {
                        let live = if source.is_live { "[LIVE] " } else { "" };
                        ui.label(format!(
                            "{}. {} {}",
                            i + 1,
                            live,
                            source.title.as_deref().unwrap_or("Unknown")
                        ));
                    });
                    ui.label(format!("  {}", source.url));
                    ui.separator();
                }
            });
        }
    }

    fn render_config_panel(&mut self, ui: &mut egui::Ui) {
        ui.heading("Configuration");
        ui.separator();

        egui::ScrollArea::vertical().show(ui, |ui| {
            ui.group(|ui| {
                ui.heading("API Keys");
                ui.horizontal(|ui| {
                    ui.label("Holodex API Key:");
                    ui.text_edit_singleline(&mut self.config_holodex_key);
                });
                ui.horizontal(|ui| {
                    ui.label("Twitch Client ID:");
                    ui.text_edit_singleline(&mut self.config_twitch_client_id);
                });
                ui.horizontal(|ui| {
                    ui.label("Twitch Client Secret:");
                    ui.text_edit_singleline(&mut self.config_twitch_secret);
                });
                ui.horizontal(|ui| {
                    ui.label("YouTube API Key:");
                    ui.text_edit_singleline(&mut self.config_youtube_key);
                });
            });

            ui.add_space(10.0);

            ui.group(|ui| {
                ui.heading("Player Settings");
                ui.horizontal(|ui| {
                    ui.label("Player:");
                    egui::ComboBox::from_id_salt("player_type")
                        .selected_text(&self.config_player_type)
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.config_player_type, "mpv".to_string(), "mpv");
                            ui.selectable_value(
                                &mut self.config_player_type,
                                "streamlink".to_string(),
                                "streamlink",
                            );
                            ui.selectable_value(&mut self.config_player_type, "vlc".to_string(), "vlc");
                        });
                });
                ui.horizontal(|ui| {
                    ui.label("Max Streams:");
                    ui.add(egui::Slider::new(&mut self.config_max_streams, 1..=8));
                });
                ui.horizontal(|ui| {
                    ui.label("Default Quality:");
                    ui.text_edit_singleline(&mut self.config_default_quality);
                });
                ui.horizontal(|ui| {
                    ui.label("Default Volume:");
                    ui.add(egui::Slider::new(&mut self.config_default_volume, 0..=100));
                });
                ui.checkbox(&mut self.config_auto_start, "Auto Start");
                ui.checkbox(&mut self.config_disable_heartbeat, "Disable Heartbeat");
            });

            ui.add_space(10.0);

            ui.group(|ui| {
                ui.heading("Screen 0 Settings");
                ui.horizontal(|ui| {
                    ui.label("Resolution:");
                    ui.add(egui::Slider::new(&mut self.config_screen0_width, 640..=3840));
                    ui.label("x");
                    ui.add(egui::Slider::new(&mut self.config_screen0_height, 360..=2160));
                });
                ui.horizontal(|ui| {
                    ui.label("Quality:");
                    ui.text_edit_singleline(&mut self.config_screen0_quality);
                });
            });

            ui.add_space(10.0);

            ui.group(|ui| {
                ui.heading("Screen 1 Settings");
                ui.horizontal(|ui| {
                    ui.label("Resolution:");
                    ui.add(egui::Slider::new(&mut self.config_screen1_width, 640..=3840));
                    ui.label("x");
                    ui.add(egui::Slider::new(&mut self.config_screen1_height, 360..=2160));
                });
                ui.horizontal(|ui| {
                    ui.label("Quality:");
                    ui.text_edit_singleline(&mut self.config_screen1_quality);
                });
            });

            ui.add_space(10.0);

            ui.group(|ui| {
                ui.heading("Logging");
                ui.horizontal(|ui| {
                    ui.label("Log Level:");
                    egui::ComboBox::from_id_salt("log_level")
                        .selected_text(&self.config_log_level)
                        .show_ui(ui, |ui| {
                            ui.selectable_value(&mut self.config_log_level, "debug".to_string(), "debug");
                            ui.selectable_value(&mut self.config_log_level, "info".to_string(), "info");
                            ui.selectable_value(&mut self.config_log_level, "warn".to_string(), "warn");
                            ui.selectable_value(&mut self.config_log_level, "error".to_string(), "error");
                        });
                });
            });

            ui.add_space(10.0);

            ui.group(|ui| {
                ui.heading("Actions");
                ui.horizontal(|ui| {
                    if ui.button("Save Config").clicked() {
                        ui.label("Config saved (not implemented - edit config files)");
                    }
                    if ui.button("Reset to Defaults").clicked() {
                        self.config_max_streams = 4;
                        self.config_player_type = "mpv".to_string();
                        self.config_default_quality = "best".to_string();
                        self.config_default_volume = 50;
                        self.config_auto_start = false;
                        self.config_disable_heartbeat = false;
                        self.config_screen0_width = 1280;
                        self.config_screen0_height = 720;
                        self.config_screen0_quality = "best".to_string();
                        self.config_screen1_width = 1280;
                        self.config_screen1_height = 720;
                        self.config_screen1_quality = "best".to_string();
                        self.config_log_level = "info".to_string();
                        self.config_holodex_key.clear();
                        self.config_twitch_client_id.clear();
                        self.config_twitch_secret.clear();
                        self.config_youtube_key.clear();
                    }
                });
            });

            ui.add_space(20.0);

            ui.group(|ui| {
                ui.heading("About");
                ui.label("LiveLink v0.1.0");
                ui.label("Stream management for VTubers");
                ui.label("Supports: Holodex, Twitch, YouTube, Kick, Niconico, Bilibili");
                ui.hyperlink_to("GitHub", "https://github.com/livelink");
            });
        });
    }
}

impl eframe::App for LiveLinkApp {
    fn update(&mut self, ctx: &egui::Context, frame: &mut eframe::Frame) {
        self.poll_updates();
        self.render_players(frame);

        egui::TopBottomPanel::top("top_panel").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("LiveLink");

                ui.separator();

                match self.current_tab {
                    Tab::Streams => {
                        let _ = ui.selectable_label(true, "Streams");
                        if ui.selectable_label(false, "⚙ Config").clicked() {
                            self.current_tab = Tab::Config;
                        }
                        ui.separator();
                        ui.label("Search:");
                        ui.text_edit_singleline(&mut self.search_query);
                    }
                    Tab::Config => {
                        if ui.selectable_label(false, "Streams").clicked() {
                            self.current_tab = Tab::Streams;
                        }
                        let _ = ui.selectable_label(true, "⚙ Config");
                    }
                }
                ui.separator();

                let toggle_text = if self.show_multi_view { "Single View" } else { "Multi View" };
                if ui.button(toggle_text).clicked() {
                    self.show_multi_view = !self.show_multi_view;
                }

                ui.separator();
                ui.label(format!("Active: {}/{}", self.snapshot.active, self.orchestrator.max_streams));
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            if self.show_multi_view {
                ui.columns(2, |columns| {
                    columns[0].group(|ui| {
                        self.render_screen_panel(ui, 0);
                    });
                    columns[1].group(|ui| {
                        self.render_screen_panel(ui, 1);
                    });
                });
            } else {
                ui.horizontal(|ui| {
                    if ui.button("Screen 0").clicked() {
                        self.selected_screen = 0;
                    }
                    if ui.button("Screen 1").clicked() {
                        self.selected_screen = 1;
                    }
                });
                ui.separator();
                self.render_screen_panel(ui, self.selected_screen);
            }

            match self.current_tab {
                Tab::Streams => {}
                Tab::Config => self.render_config_panel(ui),
            }
        });

        egui::SidePanel::right("info_panel").show(ctx, |ui| {
            ui.heading("Status");

            for s in [0, 1] {
                let state = self.get_state(s);
                let active = if state == StreamState::Playing { " ●" } else { "" };
                ui.label(format!("Screen {}{}: {:?}", s, active, state));
            }

            ui.label(format!("Queue 0: {} streams", self.snapshot.queues[0].len()));
            ui.label(format!("Queue 1: {} streams", self.snapshot.queues[1].len()));

            ui.add_space(20.0);
            ui.heading("Platforms");
            ui.label("Holodex: enabled");
            ui.label("Twitch: enabled");
            ui.label("YouTube: RSS fallback");
            ui.label("Kick: enabled");
            ui.label("Niconico: enabled");
            ui.label("Bilibili: enabled");
        });

        // Keep repainting while a video is playing so frames keep flowing.
        if self.any_playing() {
            ctx.request_repaint();
        }
    }
}
