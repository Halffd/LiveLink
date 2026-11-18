use serde_json::json;

use crate::player_ui::control;

use super::Orchestrator;

/// JSON line that toggles pause on a player window.
pub fn pause_line() -> String {
    json!({ "cmd": "pause" }).to_string()
}

/// JSON line that sets absolute volume (mpv scale, 0-130).
pub fn volume_line(volume: u8) -> String {
    json!({ "cmd": "volume", "value": volume as f64 }).to_string()
}

/// JSON line that seeks relative to the current position, in seconds.
pub fn seek_line(seconds: i64) -> String {
    json!({ "cmd": "seek", "value": seconds as f64 }).to_string()
}

/// The control port a screen's player window listens on.
pub fn control_port(screen: u32) -> u16 {
    control::DEFAULT_BASE_PORT.saturating_add(u16::try_from(screen).unwrap_or(0))
}

impl Orchestrator {
    pub async fn player_pause(&self, screen: u32) -> Result<(), String> {
        if self.window_playback() {
            return self.forward(screen, pause_line()).await;
        }
        let player = self.player.lock().await;
        player.command(screen, 0, &["pause"]).await.map_err(|e| e.to_string())
    }

    pub async fn player_set_volume(&self, screen: u32, volume: u8) -> Result<(), String> {
        if self.window_playback() {
            let line = volume_line(volume);
            return self.forward(screen, line).await;
        }
        let player = self.player.lock().await;
        player.set_volume(screen, 0, volume).await.map_err(|e| e.to_string())
    }

    pub async fn player_seek(&self, screen: u32, seconds: i64) -> Result<(), String> {
        if self.window_playback() {
            let line = seek_line(seconds);
            return self.forward(screen, line).await;
        }
        let player = self.player.lock().await;
        player.command(screen, 0, &["seek", &seconds.to_string()]).await.map_err(|e| e.to_string())
    }

    /// Send one command line to the screen's player window. A closed window
    /// is the normal case (nothing to control), not an error worth
    /// surfacing to a caller that just pressed pause.
    async fn forward(&self, screen: u32, line: String) -> Result<(), String> {
        match control::send_command(control_port(screen), &line).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::ConnectionRefused => Ok(()),
            Err(e) => Err(format!("screen {screen}: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player_ui::control::PlayerCommand;

    #[test]
    fn command_lines_match_the_control_protocol() {
        assert_eq!(pause_line(), r#"{"cmd":"pause"}"#);
        assert_eq!(volume_line(75), r#"{"cmd":"volume","value":75.0}"#);
        // Relative seek keeps the sign, as the window's arrow keys do.
        assert_eq!(seek_line(-10), r#"{"cmd":"seek","value":-10.0}"#);
        assert_eq!(seek_line(30), r#"{"cmd":"seek","value":30.0}"#);
    }

    #[test]
    fn control_port_follows_the_screen_offset() {
        assert_eq!(control_port(1), control::DEFAULT_BASE_PORT + 1);
        assert_eq!(control_port(0), control::DEFAULT_BASE_PORT);
        // Absurd screen numbers cannot panic: they fall back to the base
        // port (a real window on such a screen does not exist).
        assert_eq!(control_port(u32::MAX), control::DEFAULT_BASE_PORT);
    }

    #[test]
    fn lines_parse_back_as_player_commands() {
        let pause = control::parse_line(&pause_line()).expect("pause parses");
        assert_eq!(
            pause,
            PlayerCommand { cmd: "pause".into(), url: None, text: None, value: None }
        );

        let volume = control::parse_line(&volume_line(75)).expect("volume parses");
        assert_eq!(volume.value, Some(75.0));
        assert_eq!(volume.cmd, "volume");

        let seek = control::parse_line(&seek_line(-10)).expect("seek parses");
        assert_eq!(seek.value, Some(-10.0));
        assert_eq!(seek.cmd, "seek");
    }
}