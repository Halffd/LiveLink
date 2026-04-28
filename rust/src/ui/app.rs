use std::sync::Arc;
use eframe::egui;
use crate::core::orchestrator::Orchestrator;
use crate::core::state::StreamState;
use crate::queue::queue::StreamSource;

pub struct LiveLinkApp {
    orchestrator: Arc<Orchestrator>,
    selected_screen: u32,
    volume: u8,
    cached_state_0: StreamState,
    cached_state_1: StreamState,
}

impl LiveLinkApp {
    pub fn new(orchestrator: Arc<Orchestrator>) -> Self {
        Self {
            orchestrator,
            selected_screen: 0,
            volume: 50,
            cached_state_0: StreamState::Idle,
            cached_state_1: StreamState::Idle,
        }
    }

    fn get_queue(&self, screen: u32) -> Vec<StreamSource> {
        let queue = self.orchestrator.get_queue();
        let queue = queue.blocking_lock();
        queue.get_queue(screen).map(|q| q.sources().to_vec()).unwrap_or_default()
    }

    fn update_states(&mut self) {
        let orch = self.orchestrator.clone();
        self.cached_state_0 = orch.get_state_sync(0).unwrap_or(StreamState::Idle);
        self.cached_state_1 = orch.get_state_sync(1).unwrap_or(StreamState::Idle);
    }

    fn get_state(&self, screen: u32) -> StreamState {
        if screen == 0 { self.cached_state_0 } else { self.cached_state_1 }
    }
}

impl eframe::App for LiveLinkApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        self.update_states();

        egui::TopBottomPanel::top("top_panel").show(ctx, |ui| {
            ui.heading("LiveLink");
            ui.horizontal(|ui| {
                if ui.button("Screen 0").clicked() {
                    self.selected_screen = 0;
                }
                if ui.button("Screen 1").clicked() {
                    self.selected_screen = 1;
                }
                ui.separator();
                let state = self.get_state(self.selected_screen);
                ui.label(format!("State: {:?}", state));
            });
        });

        egui::CentralPanel::default().show(ctx, |ui| {
            let screen = self.selected_screen;
            let state = self.get_state(screen);
            let queue = self.get_queue(screen);

            ui.heading(format!("Screen {}", screen));

            ui.horizontal(|ui| {
                if ui.add_enabled(state == StreamState::Idle || state == StreamState::Error, egui::Button::new("▶ Start")).clicked() {
                    let orch = self.orchestrator.clone();
                    let s = screen;
                    tokio::spawn(async move {
                        let _ = orch.start_stream(s).await;
                    });
                }
                if ui.add_enabled(state == StreamState::Playing, egui::Button::new("⏹ Stop")).clicked() {
                    let orch = self.orchestrator.clone();
                    let s = screen;
                    tokio::spawn(async move {
                        let _ = orch.stop_stream(s).await;
                    });
                }
                if ui.add_enabled(state == StreamState::Playing, egui::Button::new("⏸ Pause")).clicked() {
                    let orch = self.orchestrator.clone();
                    let s = screen;
                    tokio::spawn(async move {
                        let _ = orch.player_pause(s).await;
                    });
                }
            });

            ui.add_space(10.0);
            ui.heading("Queue");
            ui.separator();

            if queue.is_empty() {
                ui.label("No streams in queue");
            } else {
                egui::ScrollArea::vertical().show(ui, |ui| {
                    for (i, source) in queue.iter().enumerate() {
                        ui.horizontal(|ui| {
                            let live = if source.is_live { "[LIVE] " } else { "" };
                            ui.label(format!("{}. {} {}", i + 1, live, source.title.as_deref().unwrap_or("Unknown")));
                        });
                        ui.label(format!("  {}", source.url));
                        ui.label(format!("  Platform: {}", source.platform.as_deref().unwrap_or("unknown")));
                        if let Some(vc) = source.viewer_count {
                            ui.label(format!("  Viewers: {}", vc));
                        }
                        ui.separator();
                    }
                });
            }

            ui.add_space(10.0);
            ui.heading("Controls");
            ui.separator();

            ui.horizontal(|ui| {
                ui.label("Volume:");
                ui.add(egui::Slider::new(&mut self.volume, 0..=100).text("volume"));
                if ui.button("Set").clicked() {
                    let orch = self.orchestrator.clone();
                    let s = screen;
                    let v = self.volume;
                    tokio::spawn(async move {
                        let _ = orch.player_set_volume(s, v).await;
                    });
                }
            });

            ui.add_space(10.0);
            ui.heading("Refresh");
            if ui.button("Refresh Queue").clicked() {
                let orch = self.orchestrator.clone();
                let s = screen;
                tokio::spawn(async move {
                    let _ = orch.refresh_queue(s).await;
                });
            }
        });

        egui::SidePanel::right("info_panel").show(ctx, |ui| {
            ui.heading("Info");
            ui.label(format!("Active streams: {}", self.orchestrator.count_active_streams()));
            ui.label(format!("Max streams: {}", self.orchestrator.max_streams));

            ui.add_space(20.0);
            ui.heading("Screens");
            for s in [0, 1] {
                let state = self.get_state(s);
                let active = if state == StreamState::Playing { " ●" } else { "" };
                ui.label(format!("Screen {}{}: {:?}", s, active, state));
            }
        });
    }
}