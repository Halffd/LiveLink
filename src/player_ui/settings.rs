//! Customizable, persisted UI settings for the standalone libmpv player.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How the control overlay behaves.
pub const CONTROLS_AUTO: &str = "auto"; // show on pointer movement, hide after idle
pub const CONTROLS_ALWAYS: &str = "always";
pub const CONTROLS_NEVER: &str = "never";

/// Player UI customization. Persisted to `<config_dir>/player-ui.json`;
/// every field has a default, and a missing or corrupt file yields defaults.
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
    /// "dark" | "light"
    pub theme: String,
    /// Opacity of the control overlay background (0.0-1.0)
    pub overlay_opacity: f32,
    /// Wrap around to the first entry when the playlist ends
    pub loop_playlist: bool,
    /// Supervisor respawns closed/crashed screen windows
    pub respawn: bool,
    /// Initial playback volume (mpv scale, 0-130)
    pub volume: i64,
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
            overlay_opacity: 0.75,
            loop_playlist: true,
            respawn: true,
            volume: 100,
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
        config_dir.join("player-ui.json")
    }

    pub fn load(config_dir: &Path) -> Self {
        let path = Self::path(config_dir);
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str(&content) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!(
                        "corrupt player UI settings {}: {} - using defaults",
                        path.display(),
                        e
                    );
                    Self::default()
                }
            },
            Err(_) => Self::default(),
        }
    }

    /// Atomic save (tmp file + rename).
    pub fn save(&self, config_dir: &Path) -> Result<PathBuf, String> {
        let path = Self::path(config_dir);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create {}: {}", parent.display(), e))?;
        }
        let content = serde_json::to_string_pretty(self)
            .map_err(|e| format!("failed to serialize settings: {}", e))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, content)
            .map_err(|e| format!("failed to write {}: {}", tmp.display(), e))?;
        std::fs::rename(&tmp, &path)
            .map_err(|e| format!("failed to rename into {}: {}", path.display(), e))?;
        Ok(path)
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
    fn roundtrips_through_json() {
        let dir = std::env::temp_dir().join("player-ui-test-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = PlayerUiSettings {
            controls: CONTROLS_ALWAYS.to_string(),
            borderless: true,
            font_scale: 1.25,
            volume: 42,
            ..Default::default()
        };
        s.save(&dir).unwrap();
        let loaded = PlayerUiSettings::load(&dir);
        assert_eq!(loaded, s);
    }

    #[test]
    fn corrupt_file_yields_default() {
        let dir = std::env::temp_dir().join("player-ui-test-corrupt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(PlayerUiSettings::path(&dir), "{ not json").unwrap();
        let s = PlayerUiSettings::load(&dir);
        assert_eq!(s, PlayerUiSettings::default());
    }
}
