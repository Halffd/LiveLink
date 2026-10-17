//! Single-window libmpv player: video fills the window, controls overlay on
//! demand, settings persisted to player-ui.json.

use std::path::PathBuf;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use eframe::egui;

use crate::player_ui::control::PlayerCommand;
use crate::player_ui::settings::{
    PlayerUiSettings, CONTROLS_ALWAYS, CONTROLS_AUTO, CONTROLS_NEVER,
};
use crate::player_ui::PlayerWindowConfig;
use crate::services::libmpv::{MpvVideo, PlayerEvent};

const OVERLAY_HIDE_AFTER: Duration = Duration::from_secs(3);

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
                    m.set_volume(settings.volume);
                    if window.rotate != 0 {
                        m.set_rotation(window.rotate);
                    }
                    mpv = Some(m);
                }
                Err(e) => tracing::warn!(error = %e, "libmpv init failed; window will be idle"),
            }
        }

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
        };
        app.apply_sub_settings();
        app
    }

    /// Push subtitle and video framing settings to mpv (init + Apply).
    fn apply_sub_settings(&mut self) {
        if let Some(mpv) = &mut self.mpv {
            let s = &self.settings;
            mpv.set_sub_visible(s.sub_visible);
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
                PlayerEvent::Loaded => {
                    let subs = self.subtitles.clone();
                    if !subs.is_empty() {
                        if let Some(mpv) = &mut self.mpv {
                            for sub in &subs {
                                mpv.sub_add(sub);
                            }
                        }
                    }
                }
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
                                self.advance(-1);
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
                                self.advance(1);
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
        let sub_tracks = self
            .mpv
            .as_ref()
            .map(|m| m.sub_tracks())
            .unwrap_or_default();
        let current_sub = self.mpv.as_ref().map(|m| m.current_sub_id()).unwrap_or(0);
        let mut sub_pick: Option<i64> = None;
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
                ui.checkbox(&mut s.sub_visible, "Show subtitles");
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
                ui.label("shortcuts: space pause · ←/→ seek ±10s · ↑/↓ volume · m mute · v subs · j next sub · f fullscreen · , . frame step");
            });
        if let Some(id) = sub_pick {
            if let Some(mpv) = &mut self.mpv {
                mpv.set_sub_track(id);
            }
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
            )
        });
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
        if mute_key {
            if let Some(mpv) = &mut self.mpv {
                mpv.set_mute(!mpv.muted());
            }
        }
        if full {
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
            if let Some(mpv) = &mut self.mpv {
                mpv.set_sub_visible(!mpv.sub_visible());
            }
        }
        if sub_next {
            if let Some(mpv) = &mut self.mpv {
                mpv.cycle_sub();
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
