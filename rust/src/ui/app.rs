use std::sync::Arc;
use eframe::egui;
use crate::core::orchestrator::Orchestrator;
use crate::core::state::StreamState;
use crate::queue::queue::StreamSource;

pub struct LiveLinkApp {
    orchestrator: Arc<Orchestrator>,
    selected_screen: u32,
    volume: u8,
    search_query: String,
    show_multi_view: bool,
    cached_state_0: StreamState,
    cached_state_1: StreamState,
}

impl LiveLinkApp {
    pub fn new(orchestrator: Arc<Orchestrator>) -> Self {
        Self {
            orchestrator,
            selected_screen: 0,
            volume: 50,
            search_query: String::new(),
            show_multi_view: false,
            cached_state_0: StreamState::Idle,
            cached_state_1: StreamState::Idle,
        }
    }

    fn get_queue(&self, screen: u32) -> Vec<StreamSource> {
        let queue = self.orchestrator.get_queue();
        let queue = queue.blocking_lock();
        queue.get_queue(screen).map(|q| q.sources().to_vec()).unwrap_or_default()
    }

    fn filter_queue(&self, queue: &[StreamSource]) -> Vec<StreamSource> {
        if self.search_query.is_empty() {
            return queue.to_vec();
        }
        let query = self.search_query.to_lowercase();
        queue.iter()
            .filter(|s| {
                s.title.as_ref().map(|t| t.to_lowercase().contains(&query)).unwrap_or(false) ||
                s.url.to_lowercase().contains(&query) ||
                s.channel.as_ref().map(|c| c.to_lowercase().contains(&query)).unwrap_or(false) ||
                s.platform.as_ref().map(|p| p.to_lowercase().contains(&query)).unwrap_or(false)
            })
            .cloned()
            .collect()
    }

    fn update_states(&mut self) {
        self.cached_state_0 = self.orchestrator.get_state_sync(0).unwrap_or(StreamState::Idle);
        self.cached_state_1 = self.orchestrator.get_state_sync(1).unwrap_or(StreamState::Idle);
    }

    fn get_state(&self, screen: u32) -> StreamState {
        if screen == 0 { self.cached_state_0 } else { self.cached_state_1 }
    }

    fn render_screen_panel(&mut self, ui: &mut egui::Ui, screen: u32) {
        let state = self.get_state(screen);
        let queue = self.get_queue(screen);
        let filtered = self.filter_queue(&queue);

        ui.heading(format!("Screen {}", screen));

        let is_idle = state == StreamState::Idle || state == StreamState::Error;
        let is_playing = state == StreamState::Playing;

        ui.horizontal(|ui| {
            if ui.add_enabled(is_idle, egui::Button::new("▶ Start")).clicked() {
                let orch = self.orchestrator.clone();
                tokio::spawn(async move {
                    let _ = orch.start_stream(screen).await;
                });
            }
            if ui.add_enabled(is_playing, egui::Button::new("⏹ Stop")).clicked() {
                let orch = self.orchestrator.clone();
                tokio::spawn(async move {
                    let _ = orch.stop_stream(screen).await;
                });
            }
            if ui.add_enabled(is_playing, egui::Button::new("⏸ Pause")).clicked() {
                let orch = self.orchestrator.clone();
                tokio::spawn(async move {
                    let _ = orch.player_pause(screen).await;
                });
            }
            ui.label(format!("{:?}", state));
        });

        ui.horizontal(|ui| {
            ui.label("Vol:");
            ui.add(egui::Slider::new(&mut self.volume, 0..=100));
            if ui.button("Set").clicked() {
                let orch = self.orchestrator.clone();
                let v = self.volume;
                tokio::spawn(async move {
                    let _ = orch.player_set_volume(screen, v).await;
                });
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
            egui::ScrollArea::vertical().max_height(300.0).show(ui, |ui| {
                for (i, source) in filtered.iter().enumerate() {
                    ui.horizontal(|ui| {
                        let live = if source.is_live { "[LIVE] " } else { "" };
                        ui.label(format!("{}. {} {}", i + 1, live, source.title.as_deref().unwrap_or("Unknown")));
                    });
                    ui.label(format!("  {}", source.url));
                    ui.horizontal(|ui| {
                        ui.label(format!("Platform: {}", source.platform.as_deref().unwrap_or("unknown")));
                        if let Some(ch) = &source.channel {
                            ui.label(format!(" | Channel: {}", ch));
                        }
                        if let Some(vc) = source.viewer_count {
                            ui.label(format!(" | Viewers: {}", vc));
                        }
                    });
                    ui.separator();
                }
            });
        }
    }
}

impl eframe::App for LiveLinkApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.update_states();

        egui::TopBottomPanel::top("top_panel").show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.heading("LiveLink");

                ui.separator();

                ui.label("Search:");
                ui.text_edit_singleline(&mut self.search_query);

                ui.separator();

                let toggle_text = if self.show_multi_view { "Single View" } else { "Multi View" };
                if ui.button(toggle_text).clicked() {
                    self.show_multi_view = !self.show_multi_view;
                }

                ui.separator();
                ui.label(format!("Active: {}/{}", self.orchestrator.count_active_streams(), self.orchestrator.max_streams));
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

            ui.add_space(20.0);
            ui.heading("Quick Actions");

            ui.horizontal(|ui| {
                if ui.button("Refresh All").clicked() {
                    let orch = self.orchestrator.clone();
                    tokio::spawn(async move {
                        let _ = orch.refresh_all_queues().await;
                    });
                }
                if ui.button("Refresh Queue").clicked() {
                    let orch = self.orchestrator.clone();
                    let s = self.selected_screen;
                    tokio::spawn(async move {
                        let _ = orch.refresh_queue(s).await;
                    });
                }
            });
        });

        egui::SidePanel::right("info_panel").show(ctx, |ui| {
            ui.heading("Status");

            for s in [0, 1] {
                let state = self.get_state(s);
                let active = if state == StreamState::Playing { " ●" } else { "" };
                ui.label(format!("Screen {}{}: {:?}", s, active, state));
            }

            let queue_0 = self.get_queue(0);
            let queue_1 = self.get_queue(1);
            ui.label(format!("Queue 0: {} streams", queue_0.len()));
            ui.label(format!("Queue 1: {} streams", queue_1.len()));

            ui.add_space(20.0);
            ui.heading("Platforms");
            ui.label("Holodex: enabled");
            ui.label("Twitch: enabled");
            ui.label("YouTube: RSS fallback");
            ui.label("Kick: enabled");
            ui.label("Niconico: enabled");
            ui.label("Bilibili: enabled");
        });
    }
}