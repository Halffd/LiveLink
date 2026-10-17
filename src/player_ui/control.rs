//! Line-delimited JSON command listener so external processes (the LiveLink
//! server, scripts) can drive a persistent player window.
//!
//! Protocol: one JSON object per line over TCP.
//!   {"cmd":"play","url":"https://..."}   load and play
//!   {"cmd":"stop"}                        stop playback
//!   {"cmd":"pause","value":true}          pause (true) / resume (false)
//!   {"cmd":"volume","value":50}           set volume (mpv scale)
//!   {"cmd":"seek","value":-10}            seek relative in seconds
//!   {"cmd":"speed","value":1.5}           set playback speed multiplier
//!   {"cmd":"mute","value":true}           mute (true/false, omits to toggle)
//!   {"cmd":"next"} / {"cmd":"prev"}       playlist navigation
//!   {"cmd":"reload"}                      reload player-ui.json
//!   {"cmd":"quit"}                        close this player window

use serde::Deserialize;
use std::net::TcpListener;
use std::sync::mpsc::Sender;

/// First port of the player control port range; a player window on screen N
/// defaults to `DEFAULT_BASE_PORT + N`. The server uses the same convention to
/// forward stream changes.
pub const DEFAULT_BASE_PORT: u16 = 3100;

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PlayerCommand {
    pub cmd: String,
    #[serde(default)]
    pub url: Option<String>,
    /// Accepts a JSON number or boolean (pause sends true/false).
    #[serde(default, deserialize_with = "deserialize_flex_value")]
    pub value: Option<f64>,
}

fn deserialize_flex_value<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum FlexValue {
        Bool(bool),
        Num(f64),
    }
    match FlexValue::deserialize(deserializer) {
        Ok(FlexValue::Bool(true)) => Ok(Some(1.0)),
        Ok(FlexValue::Bool(false)) => Ok(Some(0.0)),
        Ok(FlexValue::Num(n)) => Ok(Some(n)),
        Err(e) => Err(e),
    }
}

pub fn parse_line(line: &str) -> Option<PlayerCommand> {
    serde_json::from_str(line.trim()).ok()
}

/// Bind `127.0.0.1:port` and forward parsed commands to `tx`. On bind failure
/// (e.g. TIME_WAIT after a respawn) the thread retries every 5 seconds so a
/// supervised player eventually owns its port. Never returns.
pub fn spawn_listener(port: u16, tx: Sender<PlayerCommand>) {
    std::thread::spawn(move || loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buf = Vec::new();
                    // Read until newline or EOF (one connection per command batch).
                    loop {
                        use std::io::Read;
                        let mut byte = [0u8; 1];
                        match stream.read(&mut byte) {
                            Ok(0) => break,
                            Ok(_) => {
                                buf.push(byte[0]);
                                if byte[0] == b'\n' {
                                    break;
                                }
                                if buf.len() > 64 * 1024 {
                                    break; // absurd line, drop it
                                }
                            }
                            Err(_) => break,
                        }
                    }
                    if let Some(cmd) = parse_line(&String::from_utf8_lossy(&buf)) {
                        if tx.send(cmd).is_err() {
                            return; // UI gone
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(port, error = %e, "player control port unavailable, retrying");
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        }
    });
}

/// Send one newline-terminated JSON command to a player control port. Fails
/// when no player window is listening (the normal case when it is closed).
pub async fn send_command(port: u16, line: &str) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    stream.write_all(line.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_commands() {
        let c = parse_line(r#"{"cmd":"play","url":"https://example.com/live"}"#).unwrap();
        assert_eq!(c.cmd, "play");
        assert_eq!(c.url.as_deref(), Some("https://example.com/live"));

        let c = parse_line(r#"{"cmd":"pause","value":true}"#).unwrap();
        assert_eq!(c.value, Some(1.0));

        let c = parse_line(r#"{"cmd":"seek","value":-10}"#).unwrap();
        assert_eq!(c.cmd, "seek");
        assert_eq!(c.value, Some(-10.0));

        let c = parse_line(r#"{"cmd":"speed","value":1.5}"#).unwrap();
        assert_eq!(c.value, Some(1.5));

        let c = parse_line(r#"{"cmd":"mute"}"#).unwrap();
        assert_eq!(c.cmd, "mute");
        assert_eq!(c.value, None);

        assert!(parse_line(r#"{"cmd":"next"}"#).is_some());
        assert!(parse_line("garbage").is_none());
        assert!(parse_line("").is_none());
    }

    #[test]
    fn playlist_from_dir_filters_and_sorts_media() {
        let dir = std::env::temp_dir().join("player-ui-dir-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.mkv"), "").unwrap();
        std::fs::write(dir.join("a.mp4"), "").unwrap();
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        std::fs::write(dir.join("song.mp3"), "").unwrap();
        std::fs::write(dir.join("no_ext"), "").unwrap();

        let files = super::super::playlist_from_dir(&dir).unwrap();
        assert_eq!(
            files,
            vec![
                dir.join("a.mp4").to_string_lossy().to_string(),
                dir.join("b.mkv").to_string_lossy().to_string(),
                dir.join("song.mp3").to_string_lossy().to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn resolve_keeps_non_http_urls_unchanged() {
        let resolved = super::super::resolve_with_streamlink("streamlink", "/tmp/a.mp4", "best").await;
        assert_eq!(resolved, "/tmp/a.mp4");
    }
}
