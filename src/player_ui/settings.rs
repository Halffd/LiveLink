//! Customizable, persisted UI settings for the standalone libmpv player.
//!
//! Stored as `<config_dir>/player-ui.toml`; the legacy `player-ui.json` is
//! still read when no TOML file exists. Every field has a default, and a
//! missing or corrupt file yields defaults.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use eframe::egui;

use crate::core::subtitles::SubtitleMode;

/// How the control overlay behaves.
pub const CONTROLS_AUTO: &str = "auto"; // show on pointer movement, hide after idle
pub const CONTROLS_ALWAYS: &str = "always";
pub const CONTROLS_NEVER: &str = "never";

/// Named theme presets.
pub const THEMES: &[&str] = &["dark", "light", "midnight", "oled"];

/// Player UI customization. Persisted to `<config_dir>/player-ui.toml`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PlayerUiSettings {
    /// Control overlay mode: "auto" | "always" | "never"
    pub controls: String,
    /// Show current media title as a top overlay
    pub show_title: bool,
    /// Show the playback progress bar in the control overlay
    pub show_progress: bool,
    /// Window without OS decorations
    pub borderless: bool,
    /// Keep the window above all other windows
    pub always_on_top: bool,
    /// Start fullscreen (per-monitor)
    pub fullscreen: bool,
    /// egui pixels-per-point scale (1.0 = default)
    pub font_scale: f32,
    /// Theme preset: "dark" | "light" | "midnight" | "oled"
    pub theme: String,
    /// Accent color as hex ("38bdf8", "#38bdf8", or with alpha "38bdf8cc").
    /// Empty string uses the theme's default accent.
    pub accent: String,
    /// Widget and window corner rounding in points
    pub rounding: f32,
    /// Opacity of the control overlay background (0.0-1.0)
    pub overlay_opacity: f32,
    /// Wrap around to the first entry when the playlist ends
    pub loop_playlist: bool,
    /// Supervisor respawns closed/crashed screen windows
    pub respawn: bool,
    /// Initial playback volume (mpv scale, 0-130)
    pub volume: i64,
    /// AnkiConnect base URL for SRS mining
    pub srs_url: String,
    /// Target deck for mined cards
    pub srs_deck: String,
    /// Note type (model) for mined cards
    pub srs_model: String,
    /// Comma-separated tags for mined cards
    pub srs_tags: String,
    /// Attach an audio clip of the subtitle line
    pub srs_audio: bool,
    /// Attach a screenshot with subtitles visible
    pub srs_screenshot: bool,
    /// Seconds of padding around the mined audio clip
    pub srs_audio_pad: f64,
    /// Subtitle vertical position: 0 = top .. 100 = bottom
    pub sub_pos: i64,
    /// Visibility mode: primary-only | secondary-only | stacked | hidden |
    /// toggle-secondary (visibility is derived from this, not toggled raw)
    pub sub_mode: String,
    /// Global default primary subtitle delay in seconds (session overrides win)
    pub sub_delay_primary: f64,
    /// Global default stacked secondary subtitle delay in seconds
    pub sub_delay_secondary: f64,
    /// Stacked second subtitle language track id (0 = off)
    pub sub_secondary_id: i64,
    /// Pause playback when a subtitle ends (Memento subtitle-pause)
    pub sub_pause_end: bool,
    /// Subtitle font name (empty = mpv default)
    pub sub_font: String,
    /// Subtitle font size for plain text subs (mpv default 55)
    pub sub_font_size: f64,
    /// Subtitle scale factor (0.1-10)
    pub sub_scale: f64,
    /// Subtitle text color hex ("rrggbb", empty = mpv default)
    pub sub_color: String,
    /// Subtitle border color hex (empty = mpv default)
    pub sub_border_color: String,
    /// Subtitle border size in points (mpv default 3)
    pub sub_border_size: f64,
    /// Force styling onto authored ASS subtitles (sub-ass-override)
    pub sub_ass_override: bool,
    /// Video pan X (-1..1, fraction of window size)
    pub video_pan_x: f64,
    /// Video pan Y (-1..1, fraction of window size)
    pub video_pan_y: f64,
    /// Video zoom (1.0 = fit)
    pub video_zoom: f64,
    /// whisper-subs transcription server URL (empty = panel disabled)
    #[serde(default)]
    pub whisper_subs_url: String,
    /// whisper-subs API key (server: POST /auth/api-keys)
    #[serde(default)]
    pub whisper_subs_key: String,
}

impl Default for PlayerUiSettings {
    fn default() -> Self {
        Self {
            controls: CONTROLS_AUTO.to_string(),
            show_title: true,
            show_progress: true,
            borderless: false,
            always_on_top: false,
            fullscreen: false,
            font_scale: 1.0,
            theme: "dark".to_string(),
            accent: String::new(),
            rounding: 6.0,
            overlay_opacity: 0.75,
            loop_playlist: true,
            respawn: true,
            volume: 100,
            srs_url: "http://localhost:8765".to_string(),
            srs_deck: "LiveLink".to_string(),
            srs_model: "Basic".to_string(),
            srs_tags: "livelink".to_string(),
            srs_audio: true,
            srs_screenshot: true,
            srs_audio_pad: 0.35,
            sub_pos: 100,
            sub_mode: SubtitleMode::PrimaryOnly.as_str().to_string(),
            sub_delay_primary: 0.0,
            sub_delay_secondary: 0.0,
            sub_secondary_id: 0,
            sub_pause_end: false,
            sub_font: String::new(),
            sub_font_size: 55.0,
            sub_scale: 1.0,
            sub_color: String::new(),
            sub_border_color: String::new(),
            sub_border_size: 3.0,
            sub_ass_override: false,
            video_pan_x: 0.0,
            video_pan_y: 0.0,
            video_zoom: 1.0,
            whisper_subs_url: String::new(),
            whisper_subs_key: String::new(),
        }
    }
}

impl PlayerUiSettings {
    pub fn controls_auto(&self) -> bool {
        self.controls == CONTROLS_AUTO
    }

    pub fn controls_always(&self) -> bool {
        self.controls == CONTROLS_ALWAYS
    }

    pub fn path(config_dir: &Path) -> PathBuf {
        config_dir.join("player-ui.toml")
    }

    pub fn legacy_path(config_dir: &Path) -> PathBuf {
        config_dir.join("player-ui.json")
    }

    pub fn load(config_dir: &Path) -> Self {
        let toml_path = Self::path(config_dir);
        match std::fs::read_to_string(&toml_path) {
            Ok(content) => match toml::from_str(&content) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "corrupt player UI settings {}: {} - using defaults",
                        toml_path.display(),
                        e
                    );
                    Self::default()
                }
            },
            Err(_) => {
                // Fall back to the legacy JSON settings file.
                let json_path = Self::legacy_path(config_dir);
                match std::fs::read_to_string(&json_path) {
                    Ok(content) => match serde_json::from_str(&content) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!(
                                "corrupt player UI settings {}: {} - using defaults",
                                json_path.display(),
                                e
                            );
                            Self::default()
                        }
                    },
                    Err(_) => Self::default(),
                }
            }
        }
    }

    /// Atomic save (tmp file + rename) as TOML.
    pub fn save(&self, config_dir: &Path) -> Result<PathBuf, String> {
        let path = Self::path(config_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
        }
        let content = toml::to_string_pretty(self)
            .map_err(|e| format!("failed to serialize settings: {}", e))?;
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, content)
            .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("failed to rename into {}: {}", path.display(), e))?;
        Ok(path)
    }

    /// Parse the configured accent color; None when unset or invalid.
    pub fn accent_color(&self) -> Option<egui::Color32> {
        parse_hex_color(&self.accent)
    }

    /// Build egui visuals from the theme preset plus accent/rounding overrides.
    pub fn build_visuals(&self) -> egui::Visuals {
        let mut visuals = base_visuals(&self.theme);
        let accent = self
            .accent_color()
            .unwrap_or_else(|| default_accent(&self.theme));
        let rounding = egui::Rounding::same(self.rounding.max(0.0));

        visuals.selection.bg_fill = accent.gamma_multiply(0.4);
        visuals.selection.stroke = egui::Stroke::new(1.0_f32, accent);
        visuals.hyperlink_color = accent;
        visuals.widgets.hovered.bg_fill = accent.gamma_multiply(0.7);
        visuals.widgets.active.bg_fill = accent;
        visuals.widgets.active.fg_stroke = egui::Stroke::new(1.0_f32, egui::Color32::WHITE);
        for w in [
            &mut visuals.widgets.noninteractive,
            &mut visuals.widgets.inactive,
            &mut visuals.widgets.hovered,
            &mut visuals.widgets.active,
            &mut visuals.widgets.open,
        ] {
            w.rounding = rounding;
        }
        visuals
    }
}

fn base_visuals(theme: &str) -> egui::Visuals {
    match theme {
        "light" => egui::Visuals::light(),
        "midnight" => {
            let mut v = egui::Visuals::dark();
            v.panel_fill = egui::Color32::from_rgb(13, 17, 30);
            v.window_fill = egui::Color32::from_rgb(13, 17, 30);
            v.extreme_bg_color = egui::Color32::from_rgb(7, 10, 19);
            v
        }
        "oled" => {
            let mut v = egui::Visuals::dark();
            v.panel_fill = egui::Color32::BLACK;
            v.window_fill = egui::Color32::BLACK;
            v.extreme_bg_color = egui::Color32::from_rgb(16, 16, 16);
            v
        }
        _ => egui::Visuals::dark(),
    }
}

fn default_accent(theme: &str) -> egui::Color32 {
    match theme {
        "light" => egui::Color32::from_rgb(10, 90, 200),
        "midnight" => egui::Color32::from_rgb(125, 211, 252),
        "oled" => egui::Color32::from_rgb(57, 211, 83),
        _ => egui::Color32::from_rgb(76, 194, 255),
    }
}

/// Parse "rrggbb", "rrggbbaa", with optional leading '#'.
pub fn parse_hex_color(hex: &str) -> Option<egui::Color32> {
    let hex = hex.trim().trim_start_matches('#');
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        6 => {
            let v = u32::from_str_radix(hex, 16).ok()?;
            Some(egui::Color32::from_rgb(
                (v >> 16) as u8,
                (v >> 8) as u8,
                v as u8,
            ))
        }
        8 => {
            let v = u32::from_str_radix(hex, 16).ok()?;
            Some(egui::Color32::from_rgba_unmultiplied(
                (v >> 24) as u8,
                (v >> 16) as u8,
                (v >> 8) as u8,
                v as u8,
            ))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_yields_default() {
        let dir = std::env::temp_dir().join("player-ui-test-missing");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = PlayerUiSettings::load(&dir);
        assert_eq!(s, PlayerUiSettings::default());
    }

    #[test]
    fn roundtrips_through_toml() {
        let dir = std::env::temp_dir().join("player-ui-test-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = PlayerUiSettings {
            controls: CONTROLS_ALWAYS.to_string(),
            borderless: true,
            font_scale: 1.25,
            volume: 42,
            theme: "midnight".to_string(),
            accent: "#38bdf8".to_string(),
            rounding: 12.0,
            ..Default::default()
        };
        s.save(&dir).unwrap();
        let loaded = PlayerUiSettings::load(&dir);
        assert_eq!(loaded, s);
    }

    #[test]
    fn loads_legacy_json() {
        let dir = std::env::temp_dir().join("player-ui-test-legacy");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            PlayerUiSettings::legacy_path(&dir),
            r#"{"controls": "always", "volume": 33}"#,
        )
        .unwrap();
        let s = PlayerUiSettings::load(&dir);
        assert_eq!(s.controls, CONTROLS_ALWAYS);
        assert_eq!(s.volume, 33);
    }

    #[test]
    fn corrupt_file_yields_default() {
        let dir = std::env::temp_dir().join("player-ui-test-corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(PlayerUiSettings::path(&dir), "{ not toml").unwrap();
        let s = PlayerUiSettings::load(&dir);
        assert_eq!(s, PlayerUiSettings::default());
    }

    #[test]
    fn parses_hex_colors() {
        assert_eq!(
            parse_hex_color("38bdf8"),
            Some(egui::Color32::from_rgb(0x38, 0xbd, 0xf8))
        );
        assert_eq!(
            parse_hex_color("#38bdf8cc"),
            Some(egui::Color32::from_rgba_unmultiplied(
                0x38, 0xbd, 0xf8, 0xcc
            ))
        );
        assert_eq!(parse_hex_color(""), None);
        assert_eq!(parse_hex_color("nope"), None);
        assert_eq!(parse_hex_color("#12345"), None);
    }

    #[test]
    fn visuals_follow_accent_and_rounding() {
        let s = PlayerUiSettings {
            accent: "ff0000".to_string(),
            rounding: 12.0,
            ..Default::default()
        };
        let v = s.build_visuals();
        assert_eq!(v.widgets.active.bg_fill, egui::Color32::from_rgb(255, 0, 0));
        assert_eq!(v.widgets.inactive.rounding, egui::Rounding::same(12.0));
    }
}
