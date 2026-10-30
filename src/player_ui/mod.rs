//! Standalone single-window libmpv player. One process per screen: the video
//! fills the window (rendered into an egui texture by `services::libmpv`),
//! an overlay provides controls, and a line-delimited JSON TCP listener
//! (`control`) lets the LiveLink server or scripts drive playback.

pub mod app;
pub mod control;
pub mod reading;
pub mod settings;
pub mod srs;
pub mod subtitle;
pub mod whisper_subs;

use std::path::{Path, PathBuf};
use std::sync::mpsc;

use crate::config::ScreenConfig;

pub use app::PlayerApp;

/// Everything needed to open one player window. Built from the
/// `livelink player-ui` command line and passed to [`run`].
pub struct PlayerWindowConfig {
    pub screen_cfg: ScreenConfig,
    /// URLs and/or local media file paths, in play order.
    pub playlist: Vec<String>,
    /// External subtitle files/URLs attached to every loaded media.
    pub subtitles: Vec<String>,
    /// Directory holding `player-ui.toml`.
    pub config_dir: PathBuf,
    /// Control port; `None` disables the JSON listener.
    pub control_port: Option<u16>,
    /// Unix-socket path for the same JSON protocol; `None` disables it.
    pub ipc_socket: Option<PathBuf>,
    /// Initial playback volume (mpv scale 0-130); `None` uses saved settings.
    pub volume: Option<i64>,
    /// Start the window maximized.
    pub window_maximized: bool,
    /// Force borderless regardless of saved settings.
    pub borderless: bool,
    /// Window position; `None` lets the window manager place it.
    pub position: Option<[f32; 2]>,
    /// Video rotation in degrees (0/90/180/270).
    pub rotate: u32,
    /// LiveLink server base URL (e.g. http://localhost:3001) for channel
    /// surfing; `None` disables server-driven channel switching.
    pub server_url: Option<String>,
    /// All configured screen numbers, for the move-to-screen buttons.
    pub screens: Vec<u32>,
    /// mpv binary used for SRS audio-clip encoding.
    pub mpv_path: String,
}

/// Sensible window defaults for a screen that has no config entry.
pub fn default_screen_config(screen: u32) -> ScreenConfig {
    ScreenConfig {
        id: screen,
        screen,
        enabled: true,
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        volume: 100,
        quality: "best".to_string(),
        window_maximized: false,
        primary: false,
        sources: Vec::new(),
        sorting: None,
        refresh: 0,
        auto_start: false,
        skip_watched_streams: None,
    }
}



/// Supported media source types, detected from file extension or URI scheme.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceType {
    /// Local media file (mp4, mkv, mp3, etc.) — passed directly to mpv.
    File,
    /// Audio-only file — passed directly to mpv.
    Audio,
    /// HTTP/HTTPS stream URL — streamlink-resolved if quality is set.
    Stream,
    /// Playlist file (.m3u, .m3u8, .pls) — expanded to individual entries.
    Playlist,
    /// Torrent file (.torrent) — passed to mpv for native handling.
    Torrent,
    /// Magnet URI (magnet:?xt=...) — passed to mpv for native handling.
    Magnetic,
    /// M4U playlist/text stream list — expanded to individual entries.
    M4U,
    /// Unknown — passed through as-is.
    Other,
}

/// Detect the source type from a path or URI.
pub fn detect_source_type(source: &str) -> SourceType {
    let lower = source.to_ascii_lowercase();
    if lower.starts_with("magnet:") {
        return SourceType::Magnetic;
    }
    if lower.starts_with("http://") || lower.starts_with("https://") {
        if lower.ends_with(".torrent") {
            return SourceType::Torrent;
        }
        if lower.ends_with(".m3u") || lower.ends_with(".m3u8") || lower.ends_with(".pls") {
            return SourceType::Playlist;
        }
        if lower.ends_with(".m4u") {
            return SourceType::M4U;
        }
        return SourceType::Stream;
    }
    // Local path: inspect extension.
    if let Some(ext) = Path::new(source)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
    {
        return match ext.as_str() {
            "torrent" => SourceType::Torrent,
            "m3u" | "m3u8" | "pls" => SourceType::Playlist,
            "m4u" => SourceType::M4U,
            "mp3" | "m4a" | "ogg" | "wav" | "flac" | "aac" | "wma" => SourceType::Audio,
            "mp4" | "mkv" | "webm" | "avi" | "mov" | "flv" | "ts" | "m2ts" => SourceType::File,
            _ => SourceType::Other,
        };
    }
    SourceType::Other
}

/// Expand a playlist (.m3u, .m3u8, .pls) or m4u file into individual entries.
/// Relative paths are resolved against the playlist file's directory.
pub fn expand_playlist(path: &Path) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("failed to read playlist {}: {}", path.display(), e))?;
    let base = path.parent().unwrap_or(Path::new("."));
    let mut entries = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // m3u8 EXTINF lines are skipped; the URL follows on the next line.
        if line.starts_with("#EXTINF") {
            continue;
        }
        // URI entries (http://, https://, magnet:, file://, rtmp://, ...)
        // and absolute paths are kept as-is; only bare relative paths get
        // the playlist directory prepended.
        let is_uri = line.contains("://") || line.starts_with("magnet:");
        let resolved = if is_uri || Path::new(line).is_absolute() {
            line.to_string()
        } else {
            base.join(line).to_string_lossy().to_string()
        };
        entries.push(resolved);
    }
    Ok(entries)
}

/// Resolve a single source entry, expanding playlists/m4u into multiple entries
/// and passing other types through unchanged. Returns the expanded entries.
/// Expand a playlist for the synchronous IPC path (play commands). Local
/// .m3u/.m3u8/.pls/.m4u files are read and expanded; everything else is
/// returned as-is.
pub fn expand_source_sync(source: &str) -> Vec<String> {
    match detect_source_type(source) {
        SourceType::Playlist | SourceType::M4U => {
            match expand_playlist(Path::new(source)) {
                Ok(entries) if !entries.is_empty() => entries,
                _ => vec![source.to_string()],
            }
        }
        _ => vec![source.to_string()],
    }
}

/// Resolve a torrent or magnet URI to a playable stream URL via a
/// configurable helper command. `{url}` in the template is replaced with
/// the torrent/magnet source; the helper prints the direct stream URL on
/// stdout (e.g. `webtorrent-cli {url} --mpv --not-on-top` prints nothing
/// but streams; prefer resolvers that print a URL such as
/// `peerflix {url} --webtorrent` or `webtorrent-cli {url} --get-url`).
/// Returns `None` when no helper is configured or resolution fails.
pub fn resolve_torrent(
    helper_template: &str,
    source: &str,
) -> Option<String> {
    let template = helper_template.trim();
    if template.is_empty() {
        return None;
    }
    let command_line = template.replace("{url}", source);
    let mut parts = command_line.split_whitespace();
    let program = parts.next()?;
    let args: Vec<&str> = parts.collect();
    let output = std::process::Command::new(program)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        tracing::warn!(
            source,
            stderr = %String::from_utf8_lossy(&output.stderr),
            "torrent helper failed"
        );
        return None;
    }
    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        tracing::warn!(source, "torrent helper printed no stream URL");
        return None;
    }
    Some(url)
}

/// Resolve a single source entry. Playlists and m4u files expand into
/// multiple entries; streams are streamlink-resolved when quality is set;
/// files, audio, torrents, and magnets pass through unchanged.
/// Returns the expanded entries.
pub async fn resolve_source(
    streamlink_path: &str,
    streamlink_quality: Option<&str>,
    source: &str,
) -> Vec<String> {
    match detect_source_type(source) {
        SourceType::Playlist | SourceType::M4U => {
            match expand_playlist(Path::new(source)) {
                Ok(entries) => {
                    let mut resolved = Vec::new();
                    for entry in entries {
                        let lower = entry.to_ascii_lowercase();
                        if lower.starts_with("http://") || lower.starts_with("https://") {
                            if let Some(quality) = streamlink_quality {
                                if !quality.is_empty() {
                                    resolved.push(resolve_with_streamlink(streamlink_path, &entry, quality).await);
                                } else {
                                    resolved.push(entry.clone());
                                }
                            } else {
                                resolved.push(entry.clone());
                            }
                        } else {
                            resolved.push(entry.clone());
                        }
                    }
                    resolved
                }
                Err(e) => {
                    tracing::warn!(source, error = %e, "failed to expand playlist");
                    vec![source.to_string()]
                }
            }
        }
        SourceType::Stream => {
            if let Some(quality) = streamlink_quality {
                if !quality.is_empty() {
                    return vec![resolve_with_streamlink(streamlink_path, source, quality).await];
                }
            }
            vec![source.to_string()]
        }
        SourceType::Audio | SourceType::File | SourceType::Torrent | SourceType::Magnetic => {
            vec![source.to_string()]
        }
        SourceType::Other => vec![source.to_string()],
    }
}

/// Media file extensions accepted when playing a directory.
const MEDIA_EXTENSIONS: &[&str] = &[
    // video containers
    "mp4", "mkv", "webm", "avi", "mov", "flv", "ts", "m2ts", "mts", "m2v",
    "mpg", "mpeg", "wmv", "ogv", "3gp", "vob", "rm", "rmvb", "asf",
    // audio containers
    "mp3", "m4a", "ogg", "wav", "flac", "aac", "wma", "opus", "mka",
    "aiff", "ape", "wv", "m4b", "mid",
];

/// Sorted playlist of media files directly inside `dir` (not recursive).
pub fn playlist_from_dir(dir: &Path) -> Result<Vec<String>, String> {
    let mut files: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| format!("failed to read directory {}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .filter(|path| {
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase());
            matches!(ext.as_deref(), Some(e) if MEDIA_EXTENSIONS.contains(&e))
        })
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    files.sort();
    Ok(files)
}

/// Resolve `url` to a direct stream URL via `streamlink <url> <quality>
/// --stream-url`, mirroring the subprocess player. Returns the input unchanged
/// for non-HTTP URLs and whenever streamlink is missing, times out, or fails
/// (mpv's ytdl hook may still resolve it).
pub async fn resolve_with_streamlink(
    streamlink_path: &str,
    url: &str,
    quality: &str,
) -> String {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return url.to_string();
    }
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new(streamlink_path)
            .args([url, quality, "--stream-url"])
            .output(),
    )
    .await;
    match result {
        Ok(Ok(output)) if output.status.success() && !output.stdout.is_empty() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        Ok(Ok(output)) => {
            tracing::warn!(
                url,
                quality,
                stderr = %String::from_utf8_lossy(&output.stderr),
                "streamlink could not resolve, playing URL directly"
            );
            url.to_string()
        }
        Ok(Err(e)) => {
            tracing::warn!(url, quality, error = %e, "failed to run streamlink");
            url.to_string()
        }
        Err(_) => {
            tracing::warn!(url, quality, "streamlink resolution timed out");
            url.to_string()
        }
    }
}

/// Launch a player window for one screen and block until it closes.
///
/// Starts the control listener (unless disabled) before the window opens so
/// commands sent during startup are queued, then runs the eframe event loop
/// on the current thread: winit refuses to create an event loop anywhere but
/// the main thread on Linux, and the CLI dispatch already runs there.
/// Settings are loaded from `<config_dir>/player-ui.json` inside the app
/// creator; saved settings are overridden by `borderless` and the window
/// geometry from `screen_cfg`.

pub fn run(window: PlayerWindowConfig) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    if let Some(port) = window.control_port {
        control::spawn_listener(port, tx.clone());
    }
    if let Some(path) = &window.ipc_socket {
        control::spawn_unix_listener(path.clone(), tx.clone());
    }
    if window.control_port.is_none() && window.ipc_socket.is_none() {
        drop(tx); // receiver reports disconnection; app treats it as idle
    }

    let title = format!("LiveLink Player — screen {}", window.screen_cfg.screen);
    let width = window.screen_cfg.width;
    let height = window.screen_cfg.height;
    let position = window.position;

    let mut viewport = eframe::egui::ViewportBuilder::default()
        .with_title(title)
        .with_inner_size([width as f32, height as f32]);
    if window.window_maximized {
        viewport = viewport.with_maximized(true);
    }
    if let Some([x, y]) = position {
        viewport = viewport.with_position([x, y]);
    }
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };
    eframe::run_native(
        "LiveLink Player",
        options,
        Box::new(move |cc| Ok(Box::new(app::PlayerApp::new(cc, &window, rx)))),
    )
    .map_err(|e| format!("player window failed: {e}"))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_source_type_matches_extension_and_scheme() {
        assert_eq!(detect_source_type("video.mp4"), SourceType::File);
        assert_eq!(detect_source_type("video.MP4"), SourceType::File);
        assert_eq!(detect_source_type("song.mp3"), SourceType::Audio);
        assert_eq!(detect_source_type("track.flac"), SourceType::Audio);
        assert_eq!(detect_source_type("magnet:?xt=urn:btih:abc"), SourceType::Magnetic);
        assert_eq!(detect_source_type("file.torrent"), SourceType::Torrent);
        assert_eq!(detect_source_type("https://example.com/file.torrent"), SourceType::Torrent);
        assert_eq!(detect_source_type("list.m3u"), SourceType::Playlist);
        assert_eq!(detect_source_type("list.m3u8"), SourceType::Playlist);
        assert_eq!(detect_source_type("list.pls"), SourceType::Playlist);
        assert_eq!(detect_source_type("stream.m4u"), SourceType::M4U);
        assert_eq!(detect_source_type("https://example.com/live"), SourceType::Stream);
        assert_eq!(detect_source_type("https://youtube.com/watch?v=abc"), SourceType::Stream);
        assert_eq!(detect_source_type("unknown.xyz"), SourceType::Other);
    }

    #[test]
    fn expand_playlist_skips_comments_and_extinf() {
        std::fs::write("/tmp/test_playlist.m3u", "#comment\n#EXTINF:123,Song\nsong.mp3\nhttp://stream.example.com/live\n").unwrap();
        let entries = expand_playlist(Path::new("/tmp/test_playlist.m3u")).unwrap();
        assert_eq!(entries, vec!["/tmp/song.mp3", "http://stream.example.com/live"]);
    }

    #[test]
    fn resolve_torrent_uses_helper_and_substitutes_url() {
        // Echo-style helper: prints back the substituted URL
        let result = resolve_torrent("echo {url}", "magnet:?xt=urn:btih:abc");
        assert_eq!(result, Some("magnet:?xt=urn:btih:abc".to_string()));
    }

    #[test]
    fn resolve_torrent_returns_none_for_empty_helper() {
        assert_eq!(resolve_torrent("", "magnet:?xt=urn:btih:abc"), None);
    }

    #[test]
    fn resolve_torrent_returns_none_for_failing_helper() {
        assert_eq!(resolve_torrent("false", "magnet:?xt=urn:btih:abc"), None);
    }

    #[test]
    fn expand_playlist_resolves_relative_paths() {
        std::fs::write("/tmp/test_rel.m3u", "local.mp4\nsubdir/other.mkv\n").unwrap();
        let entries = expand_playlist(Path::new("/tmp/test_rel.m3u")).unwrap();
        assert_eq!(entries, vec!["/tmp/local.mp4", "/tmp/subdir/other.mkv"]);
    }
}
