//! Media source classification and expansion.
//!
//! Every entry the player accepts — positional media, `--url`, `--playlist`,
//! `--dir`, and IPC `{"cmd":"play"}` — flows through [`detect`], then either
//! passes through to mpv or is expanded before playback. mpv natively plays
//! files, network streams, and remote playlists; the player only needs to
//! expand *local* playlist files (so its own next/prev navigation walks the
//! entries) and resolve torrents/magnets via a helper.

use std::path::Path;

/// What kind of media source a string refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// URI passed straight to mpv (http, rtmp, magnet, etc.).
    Uri,
    /// Local playlist file that must be expanded (.m3u/.m3u8/.pls/.m4u).
    Playlist,
    /// Local file or path handed to mpv as-is.
    Local,
}

/// Classify a source string.
pub fn detect(source: &str) -> SourceKind {
    // URIs by scheme — covers http, https, magnet, rtmp, rtp, rtsp, file, ftp…
    if let Some(scheme_end) = source.find("://") {
        let scheme = source[..scheme_end].to_ascii_lowercase();
        if scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-')
            && !scheme.is_empty()
        {
            return SourceKind::Uri;
        }
    }
    if source.starts_with("magnet:") {
        return SourceKind::Uri;
    }
    // Local path: playlist formats need expansion, everything else does not.
    match extension_of(source).as_deref() {
        Some("m3u") | Some("m3u8") | Some("m4u") | Some("pls") => SourceKind::Playlist,
        _ => SourceKind::Local,
    }
}

fn extension_of(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

/// Playlist formats the expander understands.
pub const PLAYLIST_EXTENSIONS: &[&str] = &["m3u", "m3u8", "m4u", "pls"];

/// Expand one source string: local playlist files become their entries,
/// everything else comes back as a single-element vec. Errors reading a
/// playlist degrade to the original source so playback still attempts.
pub fn expand_source(source: &str) -> Vec<String> {
    match detect(source) {
        SourceKind::Playlist => match expand(Path::new(source)) {
            Ok(entries) if !entries.is_empty() => entries,
            Ok(_) => vec![source.to_string()],
            Err(e) => {
                tracing::warn!(source, error = %e, "playlist expansion failed");
                vec![source.to_string()]
            }
        },
        _ => vec![source.to_string()],
    }
}

/// Expand a local playlist file into playable entries.
///
/// Handles M3U (with or without `#EXTM3U`/`#EXTINF`), PLS (`File1=…` keys,
/// 1-based, possibly out of order), and the M4U line-list format. Empty
/// lines and comments are dropped. Relative paths resolve against the
/// playlist's own directory; URI entries are kept verbatim.
///
/// Returns `Err` only when the file cannot be read; format oddities skip
/// lines rather than fail the whole playlist.
pub fn expand(playlist: &Path) -> Result<Vec<String>, String> {
    let content = std::fs::read_to_string(playlist)
        .map_err(|e| format!("failed to read playlist {}: {e}", playlist.display()))?;
    let base = playlist.parent().unwrap_or_else(|| Path::new("."));
    Ok(expand_content(&content, base))
}

fn expand_content(content: &str, base: &Path) -> Vec<String> {
    let is_pls = content.contains("[playlist]") || content.lines().any(|l| {
        let l = l.trim();
        l.starts_with("File") && parse_pls_key(l.trim_start_matches("File")).is_some()
    });
    let mut entries: Vec<(usize, String)> = Vec::new();
    let mut pls_order: Vec<Option<String>> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // PLS format: only FileN= keys are entries; [playlist], TitleN=,
        // LengthN=, NumberOfEntries= and Version= are metadata.
        if is_pls {
            if let Some(rest) = line.strip_prefix("File") {
                if let Some((index, value)) = parse_pls_key(rest) {
                    let idx = index.saturating_sub(1);
                    if pls_order.len() <= idx {
                        pls_order.resize(idx + 1, None);
                    }
                    pls_order[idx] = Some(resolve_entry(value, base));
                }
            }
            continue;
        }
        entries.push((entries.len(), resolve_entry(line, base)));
    }
    if !pls_order.is_empty() {
        let mut result: Vec<String> = pls_order.into_iter().flatten().collect();
        result.extend(entries.into_iter().map(|(_, entry)| entry));
        return result;
    }
    entries.into_iter().map(|(_, entry)| entry).collect()
}

/// Parse `1=http://…` after the `File` prefix; returns `(index, value)`.
fn parse_pls_key(rest: &str) -> Option<(usize, &str)> {
    let eq = rest.find('=')?;
    let digits = rest[..eq].trim();
    if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let index = digits.parse::<usize>().ok()?;
    let value = rest[eq + 1..].trim();
    if value.is_empty() {
        return None;
    }
    Some((index, value))
}

/// Resolve one playlist line: URIs stay verbatim, absolute paths stay,
/// relative paths join the playlist directory.
fn resolve_entry(line: &str, base: &Path) -> String {
    if line.contains("://") || line.starts_with("magnet:") || Path::new(line).is_absolute() {
        line.to_string()
    } else {
        base.join(line).to_string_lossy().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand_str(content: &str, base: &str) -> Vec<String> {
        expand_content(content, Path::new(base))
    }

    #[test]
    fn detect_uris_by_scheme() {
        assert_eq!(detect("http://x/live"), SourceKind::Uri);
        assert_eq!(detect("https://x/live.m3u8"), SourceKind::Uri);
        assert_eq!(detect("rtmp://server/app"), SourceKind::Uri);
        assert_eq!(detect("magnet:?xt=urn:btih:abc"), SourceKind::Uri);
        assert_eq!(detect("file:///tmp/a.mp4"), SourceKind::Uri);
    }

    #[test]
    fn detect_playlist_extensions() {
        assert_eq!(detect("list.m3u"), SourceKind::Playlist);
        assert_eq!(detect("list.M3U8"), SourceKind::Playlist);
        assert_eq!(detect("list.m4u"), SourceKind::Playlist);
        assert_eq!(detect("list.pls"), SourceKind::Playlist);
        assert_eq!(detect("/media/list.m3u"), SourceKind::Playlist);
    }

    #[test]
    fn detect_local_media_and_unknowns() {
        assert_eq!(detect("video.mp4"), SourceKind::Local);
        assert_eq!(detect("song.flac"), SourceKind::Local);
        assert_eq!(detect("archive.torrent"), SourceKind::Local);
        assert_eq!(detect("mystery.xyz"), SourceKind::Local);
    }

    #[test]
    fn expand_m3u_skips_comments_and_resolves_relative() {
        let entries = expand_str(
            "#EXTM3U\n#EXTINF:123,Local\na.mp4\n\nhttp://stream/live\n/sub/abs.mkv\n",
            "/media",
        );
        assert_eq!(
            entries,
            vec!["/media/a.mp4", "http://stream/live", "/sub/abs.mkv"]
        );
    }

    #[test]
    fn expand_pls_orders_file_keys_and_holds_position() {
        let entries = expand_str(
            "[playlist]\nFile2=http://second\nTitle2=Second\nFile1=/abs/first\nNumberOfEntries=2\n",
            "/media",
        );
        assert_eq!(entries, vec!["/abs/first", "http://second"]);
    }

    #[test]
    fn expand_m4u_is_a_plain_list() {
        let entries = expand_str("b.mp4\nhttp://x/audio.mp3\n", "/media");
        assert_eq!(entries, vec!["/media/b.mp4", "http://x/audio.mp3"]);
    }

    #[test]
    fn expand_empty_playlist_yields_nothing() {
        assert!(expand_str("#EXTM3U\n", "/media").is_empty());
    }

    #[test]
    fn expand_keeps_magnet_entries_verbatim() {
        let entries = expand_str("magnet:?xt=urn:btih:abc\n", "/media");
        assert_eq!(entries, vec!["magnet:?xt=urn:btih:abc"]);
    }
}

/// Configuration for torrent/magnet streaming, read from `player-ui.toml`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TorrentConfig {
    /// Helper command template. `{url}` is replaced with the magnet URI or
    /// `.torrent` path; the helper prints the direct stream URL on stdout
    /// (e.g. `webtorrent-cli {url} --get-url`). Empty disables torrent
    /// playback.
    pub helper: String,
    /// Seconds to wait for the helper before giving up.
    pub timeout_secs: u64,
}

impl TorrentConfig {
    /// Resolve a torrent/magnet source to a playable URL. Blocking; call
    /// from a worker thread. Returns `Err` with a user-facing message when
    /// disabled, timed out, or the helper failed.
    pub fn resolve(&self, source: &str) -> Result<String, String> {
        let template = self.helper.trim();
        if template.is_empty() {
            return Err("torrent_helper not configured in player-ui.toml".to_string());
        }
        let mut command = std::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(template.replace("{url}", source))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|e| format!("torrent helper failed to start: {e}"))?;
        // wait_with_output cannot time out, and reading stdout inline can
        // deadlock on a full pipe. Read both pipes on threads, then bound
        // only the wait; on timeout kill the child and join the readers.
        let mut stdout_pipe = child.stdout.take();
        let mut stderr_pipe = child.stderr.take();
        let stdout_reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = String::new();
            if let Some(pipe) = stdout_pipe.as_mut() {
                let _ = pipe.read_to_string(&mut buf);
            }
            buf
        });
        let stderr_reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = String::new();
            if let Some(pipe) = stderr_pipe.as_mut() {
                let _ = pipe.read_to_string(&mut buf);
            }
            buf
        });
        let timeout = std::time::Duration::from_secs(self.timeout_secs.max(1));
        let status = match wait_timeout(&mut child, timeout) {
            Some(status) => status,
            None => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "torrent helper timed out after {}s",
                    self.timeout_secs.max(1)
                ));
            }
        };
        let stdout = stdout_reader.join().unwrap_or_default();
        let stderr = stderr_reader.join().unwrap_or_default();
        if !status.success() {
            return Err(format!(
                "torrent helper exited with {status}: {}",
                stderr.trim()
            ));
        }
        let url = stdout.trim().to_string();
        if url.is_empty() {
            return Err("torrent helper printed no stream URL".to_string());
        }
        Ok(url)
    }
}

/// Wait for `child` to exit, giving up after `timeout`. Returns the exit
/// status, or `None` on timeout (the child is left running for the caller
/// to kill). std has no wait_timeout; poll with a short sleep — helpers
/// resolve in seconds, so the 50 ms poll granularity is irrelevant.
fn wait_timeout(
    child: &mut std::process::Child,
    timeout: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if std::time::Instant::now() >= deadline => return None,
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod torrent_tests {
    use super::*;

    #[test]
    fn resolve_substitutes_url_and_returns_stdout() {
        let config = TorrentConfig {
            helper: "printf '%s' {url}".to_string(),
            timeout_secs: 5,
        };
        let result = config.resolve("magnet:?xt=urn:btih:abc");
        assert_eq!(result.unwrap(), "magnet:?xt=urn:btih:abc");
    }

    #[test]
    fn resolve_errors_when_disabled() {
        let config = TorrentConfig::default();
        let err = config.resolve("magnet:?xt=urn:btih:abc").unwrap_err();
        assert!(err.contains("not configured"));
    }

    #[test]
    fn resolve_errors_when_helper_fails() {
        let config = TorrentConfig {
            helper: "exit 3".to_string(),
            timeout_secs: 5,
        };
        let err = config.resolve("magnet:?xt=urn:btih:abc").unwrap_err();
        assert!(err.contains("exited with"));
    }

    #[test]
    fn resolve_errors_when_helper_prints_nothing() {
        let config = TorrentConfig {
            helper: "true".to_string(),
            timeout_secs: 5,
        };
        let err = config.resolve("magnet:?xt=urn:btih:abc").unwrap_err();
        assert!(err.contains("no stream URL"));
    }

    #[test]
    fn resolve_times_out_slow_helper() {
        let config = TorrentConfig {
            helper: "sleep 10".to_string(),
            timeout_secs: 1,
        };
        let err = config.resolve("magnet:?xt=urn:btih:abc").unwrap_err();
        assert!(err.contains("timed out"));
    }

    #[test]
    fn resolve_quotes_preserved_in_template() {
        // Shell quoting in the template must survive substitution.
        let config = TorrentConfig {
            helper: "printf '%s' \"prefix {url} suffix\"".to_string(),
            timeout_secs: 5,
        };
        let result = config.resolve("magnet:?xt=urn:btih:xyz");
        assert_eq!(result.unwrap(), "prefix magnet:?xt=urn:btih:xyz suffix");
    }
}

#[cfg(test)]
mod play_path_tests {
    use super::*;

    /// The IPC play command sets `playlist = expand_source(url)`; verify the
    /// full matrix of source types resolves to what load_current receives.
    /// The playlist fixture is written to a temp dir so the test never
    /// depends on files elsewhere on the machine.
    #[test]
    fn play_command_expansion_matrix() {
        let dir = std::env::temp_dir().join(format!("livelink-src-matrix-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let playlist = dir.join("list.m3u");
        std::fs::write(
            &playlist,
            "#EXTM3U\n#EXTINF:99,Local\na.mp4\nhttp://localhost:9999/live\nmagnet:?xt=urn:btih:abc\n/sub/other.mkv\n",
        )
        .unwrap();

        // Local playlist expands; relative entries resolve against its dir.
        assert_eq!(
            expand_source(&playlist.to_string_lossy()),
            vec![
                dir.join("a.mp4").to_string_lossy().into_owned(),
                "http://localhost:9999/live".to_string(),
                "magnet:?xt=urn:btih:abc".to_string(),
                "/sub/other.mkv".to_string(), // absolute entry stays verbatim
            ]
        );
        // URIs, magnets, files and torrents stay single-entry.
        assert_eq!(
            expand_source("magnet:?xt=urn:btih:abc"),
            vec!["magnet:?xt=urn:btih:abc"]
        );
        assert_eq!(
            expand_source("https://example.com/live"),
            vec!["https://example.com/live"]
        );
        assert_eq!(expand_source("/tmp/song.flac"), vec!["/tmp/song.flac"]);
        assert_eq!(
            expand_source("/tmp/archive.torrent"),
            vec!["/tmp/archive.torrent"]
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
