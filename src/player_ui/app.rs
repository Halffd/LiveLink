//! Single-window libmpv player: video fills the window, controls overlay on
//! demand, settings persisted to player-ui.json.

use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use eframe::egui;

use crate::config::ScreenConfig;
use crate::player_ui::control::PlayerCommand;
use crate::player_ui::settings::{
    PlayerUiSettings, CONTROLS_ALWAYS, CONTROLS_AUTO, CONTROLS_NEVER,
};
use crate::services::libmpv::{MpvVideo, PlayerEvent};

const OVERLAY_HIDE_AFTER: Duration = Duration::from_secs(3);

pub struct PlayerApp {
    mpv: Option<MpvVideo>,
    playlist: Vec<String>,
    index: usize,
    settings: PlayerUiSettings,
    settings_dirty: bool,
    config_dir: PathBuf,
    cmd_rx: Receiver<PlayerCommand>,
    screen: u32,
    control_port: u16,
    last_pointer_move: Option<Instant>,
    settings_open: bool,
    theme_applied: bool,
}

impl PlayerApp {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cc: &eframe::CreationContext<'_>,
        screen_cfg: &ScreenConfig,
        playlist: Vec<String>,
        settings: PlayerUiSettings,
        config_dir: PathBuf,
        cmd_rx: Receiver<PlayerCommand>,
        control_port: u16,
    ) -> Self {
        let mut mpv = None;
        if let (Some(gl), Some(proc_addr)) = (&cc.gl, cc.get_proc_address) {
            // SAFETY: the loader is owned by the eframe runner and outlives the app.
            let proc_addr: &'static dyn Fn(&std::ffi::CStr) -> *const std::ffi::c_void =
                unsafe { std::mem::transmute(proc_addr) };
            match MpvVideo::new(gl, proc_addr, screen_cfg.width, screen_cfg.height) {
                Ok(mut m) => {
                    m.set_volume(settings.volume);
                    mpv = Some(m);
                }
                Err(e) => tracing::warn!(error = %e, "libmpv init failed; window will be idle"),
            }
        }

        Self {
            mpv,
            playlist,
            index: 0,
            settings,
            settings_dirty: false,
            config_dir,
            cmd_rx,
            screen: screen_cfg.screen,
            control_port,
            last_pointer_move: None,
            settings_open: false,
            theme_applied: false,
        }
    }

    fn load_current(&mut self) {
        if let Some(url) = self.playlist.get(self.index).cloned() {
            if let Some(mpv) = &mut self.mpv {
                mpv.load(&url);
            }
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
                        self.playlist = vec![url];
                        self.index = 0;
                        self.load_current();
                    }
                }
                "stop" => {
                    if let Some(mpv) = &mut self.mpv {
                        mpv.stop();
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
                "next" => self.advance(1),
                "prev" => self.advance(-1),
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
            match ev {
                PlayerEvent::Loaded => {}
                PlayerEvent::Eof => self.advance(1),
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
                    self.advance(1);
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
        ctx.set_visuals(if self.settings.theme == "light" {
            egui::Visuals::light()
        } else {
            egui::Visuals::dark()
        });
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
                                ui.label(format!(
                                    "control port: {}",
                                    self.control_port
                                ));
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
                                self.advance(-1);
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
                            if ui.button("⏭").clicked() {
                                self.advance(1);
                            }

                            if self.settings.show_progress && playing {
                                let (time, dur) = if let Some(mpv) = &mut self.mpv {
                                    (mpv.time_pos(), mpv.duration())
                                } else {
                                    (0.0, 0.0)
                                };
                                if dur > 0.0 {
                                    ui.add(
                                        egui::ProgressBar::new(
                                            ((time / dur) as f32).clamp(0.0, 1.0),
                                        )
                                        .desired_width(280.0)
                                        .text(format!("{:.0}s / {:.0}s", time, dur)),
                                    );
                                } else {
                                    ui.label(format!("{:.0}s", time));
                                }
                            }

                            if let Some(mpv) = &mut self.mpv {
                                let mut vol = mpv.volume;
                                let slider =
                                    ui.add(egui::Slider::new(&mut vol, 0..=130).text("🔊"));
                                if slider.changed() {
                                    mpv.set_volume(vol);
                                    self.settings.volume = vol;
                                }
                                if slider.drag_stopped() {
                                    self.save_settings();
                                }
                            }

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

    fn paint_settings_window(&mut self, ctx: &egui::Context) {
        let mut open = self.settings_open;
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
                            ui.selectable_value(&mut s.theme, "dark".to_string(), "dark");
                            ui.selectable_value(&mut s.theme, "light".to_string(), "light");
                        });
                });
                ui.separator();
                ui.horizontal(|ui| {
                    if ui.button("Apply").clicked() {
                        self.apply_viewport_settings(ctx);
                        self.theme_applied = false;
                        self.save_settings();
                    }
                    if ui.button("Reset defaults").clicked() {
                        self.settings = PlayerUiSettings::default();
                        self.apply_viewport_settings(ctx);
                        self.theme_applied = false;
                        self.save_settings();
                    }
                });
                ui.label(format!(
                    "settings file: {}",
                    PlayerUiSettings::path(&self.config_dir).display()
                ));
            });
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

        if ctx.input(|i| i.key_pressed(egui::Key::Space)) {
            if let Some(mpv) = &mut self.mpv {
                mpv.set_paused(!mpv.paused);
            }
        }

        self.handle_events();
        self.render_mpv(frame);
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
