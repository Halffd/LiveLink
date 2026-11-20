//! Native whisper.cpp transcription: no server, no network to a second host.
//!
//! Two halves with a deliberate seam:
//!
//! - [`engine`] — whisper.cpp inference. It takes 16 kHz mono f32 and
//!   returns segments. Nothing in it knows where the audio came from, so the
//!   model, sampling and language logic can be tested and swapped without
//!   touching capture.
//! - [`capture`] — the three ways to get that audio, one behind one type:
//!
//!   | `capture` | Where the audio comes from | Trade-offs |
//!   |---|---|---|
//!   | `record`  | the player dumps it to a file (`--stream-record`) | cheapest; needs the player to cooperate |
//!   | `pa`      | the system's audio output (PulseAudio / PipeWire monitor) | works for anything audible, but a muted screen records silence |
//!   | `download`| a short yt-dlp / streamlink / curl subprocess pulls the audio track | cleanest; free for live; needs a working resolver |
//!
//! The reference implementation for the engine is /host/captioner-rs
//! (same whisper-rs version, same 16 kHz f32 target).

pub mod capture;
pub mod engine;

use std::path::{Path, PathBuf};

use crate::config::TranscriptConfig;

/// 16 kHz mono is what whisper.cpp wants.
pub const SAMPLE_RATE: u32 = 16_000;

/// Where captured audio and generated .srt files live.
pub fn audio_dir(config: &TranscriptConfig, config_dir: &str) -> PathBuf {
    if config.audio_dir.trim().is_empty() {
        Path::new(config_dir).join("transcripts")
    } else {
        PathBuf::from(&config.audio_dir)
    }
}

/// If this screen's config wants `record` capture, the path the player on
/// that screen should dump audio to. `None` when `record` is not the chosen
/// mode, so the player never dumps audio it does not need.
///
/// Both the player and the transcription worker compute this path from the
/// same config dir, which is why they agree without any handshake.
pub fn record_for_screen(config_dir: &std::path::Path, screen: u32) -> Option<String> {
    let config = crate::config::ConfigLoader::with_base_path(
        config_dir.to_str().unwrap_or("config"),
    )
    .load()
    .transcript;
    // Only when the native backend is actually in use: a server-backend
    // config that happens to name `record` as its capture must not make the
    // player dump audio it will never read.
    if !config.native() || config.capture.as_str() != "record" {
        return None;
    }
    let dir = if config.audio_dir.trim().is_empty() {
        config_dir.join("transcripts")
    } else {
        PathBuf::from(&config.audio_dir)
    };
    Some(self::capture::record_target(&dir, screen).to_string_lossy().to_string())
}

/// Per-stream cache path. Same digest and file name as the server backend's
/// [`crate::services::transcript::TranscriptWorker::srt_path`], so a
/// transcript produced either way lands in the same place and a re-run with
/// the other backend reuses it.
pub fn srt_path(config: &TranscriptConfig, config_dir: &str, url: &str) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    url.hash(&mut hasher);

    let dir = if config.audio_dir.trim().is_empty() {
        Path::new(config_dir).join("transcripts")
    } else {
        PathBuf::from(&config.audio_dir)
    };
    dir.join(format!("{:016x}.srt", hasher.finish()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_detects_its_own_backend() {
        let mut cfg = TranscriptConfig::default();
        assert!(!cfg.native());
        cfg.backend = "native".to_string();
        assert!(cfg.native());
        // A typo'd synonym, so a config that says "local" works too.
        cfg.backend = "local".to_string();
        assert!(cfg.native());
    }

    #[test]
    fn default_backend_keeps_the_server_path_unless_opted_in() {
        // The default must remain the existing server behavior: turning the
        // native path on silently would change what runs for everyone.
        assert_eq!(TranscriptConfig::default().backend, "server");
        assert!(!TranscriptConfig::default().native());
    }
}