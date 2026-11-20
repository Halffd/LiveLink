//! Getting audio into the native backend. Three ways, one behind one type,
//! chosen by `capture` in config.
//!
//! The selection matters because they fail differently, and the trade-offs
//! are not interchangeable:
//!
//! - **record** — ask the player to dump its audio to a file and read it.
//!   Cheapest and most reliable, and it works while the stream plays, but it
//!   needs the player to cooperate and cannot start before playback does.
//! - **pa** — capture the system's audio output (PulseAudio monitor, or
//!   PipeWire's monitor source). Works for anything audible, including a
//!   screen showing a source that cannot be pulled directly, but it records
//!   whatever the speakers emit, so a muted screen yields silence, and it is
//!   Linux-only.
//! - **download** — pull the audio track with yt-dlp / streamlink / curl and
//!   read it. Cleanest audio, and free for live (the stream is fetched once),
//!   but it needs a working resolver and a destination that permits it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tracing::debug;

use crate::config::TranscriptConfig;

/// The mpv flag(s) that make a player dump its audio to `out`.
///
/// `--stream-record` writes the *container* as it arrives, which is what a
/// live stream needs; mpv names an `.mkv` even when the target ends in
/// `.wav`, so the caller must expect that and decode accordingly.
///
/// Returned as a vec so a caller can append it to an existing argv
/// (`mpv::play` already forwards `extra_args`) or set it as an option on the
/// embedded player.
pub fn record_args(out: &Path) -> Vec<String> {
    vec![format!("--stream-record={}", out.display())]
}

/// Where `record` capture expects a screen's player to have dumped audio.
/// Named per screen so two screens never clobber each other.
pub fn record_target(dir: &Path, screen: u32) -> PathBuf {
    dir.join(format!("screen-{screen}.mkv"))
}

/// The mpv arguments a player on `screen` needs so `record` capture has
/// something to read. Returned as a `Vec<String>` for the subprocess
/// player's `extra_args`; the embedded player can turn each entry into an
/// `init.set_option` call.
pub fn player_record_args(config: &TranscriptConfig, config_dir: &str, screen: u32) -> Vec<String> {
    if config.capture.as_str() != "record" {
        return Vec::new();
    }
    let dir = if config.audio_dir.trim().is_empty() {
        Path::new(config_dir).join("transcripts")
    } else {
        PathBuf::from(&config.audio_dir)
    };
    record_args(&record_target(&dir, screen))
}

/// What a stream is, for the transcription decision. Live and on-demand
/// sources are genuinely different: a live stream has no end to read, and a
/// local file can be transcribed in one pass with no streaming at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    /// A local file on disk (anime, music, downloaded video).
    LocalFile,
    /// A live stream: no duration, no seeking, still being written.
    Live,
    /// On-demand video behind a URL (a YouTube VOD, a Twitch VOD).
    Video,
}

impl SourceKind {
    /// Classify a source URL.
    ///
    /// Live detection is deliberately shallow — a `/live` path on a known
    /// platform, or a raw live-stream endpoint — because guessing wrong is
    /// the expensive mistake here: treating a VOD as live would make
    /// `capture` read only a fragment of it.
    pub fn of(url: &str) -> Self {
        let lowered = url.to_ascii_lowercase();

        // Platform live pages. A bare "/live" covers niconico and bilibili; the
        // two VTuber/streaming hosts default their channel pages to live, so
        // they need their own markers. HLS (.m3u8) is deliberately absent:
        // it serves both live and VOD, and calling a VOD live would make
        // capture read only a fragment.
        // Platform live pages. A bare "/live" covers niconico and bilibili; the
        // streaming hosts' channel URLs are live by default, but their VOD
        // URLs must not match — classify those first so a /video/ or
        // /videos/ page is treated as on-demand content. HLS (.m3u8) is
        // deliberately absent from live detection: it serves both live and
        // VOD, and calling a VOD live would make capture read only a
        // fragment.
        let video_paths = ["/video/", "/videos/", "/vod/"];
        if video_paths.iter().any(|p| lowered.contains(p)) {
            return Self::Video;
        }

        let live_markers = ["/live", "twitch.tv/", "kick.com/"];
        if live_markers.iter().any(|marker| lowered.contains(marker)) {
            return Self::Live;
        }

        if is_direct_audio_url(url) {
            return Self::LocalFile;
        }
        if url.starts_with("http://") || url.starts_with("https://") {
            return Self::Video;
        }
        Self::LocalFile
    }
}

/// A note about how a capture mode behaves for a given source, when the
/// pairing is worth a word. `None` means the pairing is unremarkable.
pub fn capture_note(kind: SourceKind) -> Option<&'static str> {
    match kind {
        // `download` on a live stream has no defined end, so it runs until
        // the timeout kills it and the chunk in hand is what gets
        // transcribed. `record` is the mode that matches live streaming.
        SourceKind::Live => Some(
            "live source with download capture: the pull runs until the \
             timeout and transcribes what it captured",
        ),
        SourceKind::LocalFile => None,
        SourceKind::Video => None,
    }
}

/// The command that will pull the audio, and the arguments it gets.
///
/// Kept separate from running it so a caller (and a test) can see exactly
/// what would be executed before anything is spawned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl PullCommand {
    pub fn display(&self) -> String {
        let mut line = self.program.clone();
        for arg in &self.args {
            line.push(' ');
            line.push_str(arg);
        }
        line
    }
}

/// Build the command for the `download` capture.
///
/// `out` is where the audio goes; the command must be deterministic for a
/// given (url, out) so a retry does not overwrite a different file.
pub fn download_command(config: &TranscriptConfig, url: &str, out: &Path) -> PullCommand {
    let out_path = out.to_string_lossy().to_string();
    let program = config.downloader.clone();
    let args = if is_direct_audio_url(url) {
        // A direct audio file needs no resolver at all: fetch it.
        vec![url.to_string(), "-o".into(), out_path]
    } else if program.contains("streamlink") {
        vec![
            url.to_string(),
            "best".into(),
            "--stream-url".into(),
            out_path,
        ]
    } else {
        // yt-dlp: audio only, no metadata overhead, quiet.
        vec![
            "--no-playlist".into(),
            "-f".into(),
            "bestaudio".into(),
            "--no-progress".into(),
            "-o".into(),
            out_path,
            url.to_string(),
        ]
    };
    PullCommand { program, args }
}

/// True when a URL points at a media file directly (no resolver needed).
pub fn is_direct_audio_url(url: &str) -> bool {
    let lowered = url.split('?').next().unwrap_or(url).to_lowercase();
    [".m4a", ".mp3", ".aac", ".ogg", ".opus", ".wav", ".flac", ".webm"]
        .iter()
        .any(|ext| lowered.ends_with(ext))
}

/// How long a download may run before it is abandoned. Live streams have no
/// end, so this must be finite; 10 minutes of audio is far more than a
/// transcription chunk needs.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

pub enum CaptureError {
    /// The capture tool is not installed.
    MissingTool(String),
    /// The capture command failed.
    Failed(String),
    /// It ran too long and was abandoned.
    Timeout(String),
    /// The output never appeared, or is unreadable.
    NoOutput(PathBuf),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTool(t) => write!(f, "capture tool not found: {t}"),
            Self::Failed(e) => write!(f, "capture failed: {e}"),
            Self::Timeout(e) => write!(f, "capture timed out: {e}"),
            Self::NoOutput(p) => write!(f, "capture produced no output: {}", p.display()),
        }
    }
}

impl std::fmt::Debug for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for CaptureError {}

/// The monitor source to record for the `pa` capture.
///
/// On PipeWire (the default on modern desktops) PulseAudio clients are
/// served through a compatibility layer, so the PulseAudio monitor is the
/// portable naming; the fallback covers a raw PipeWire setup.
pub fn monitor_source() -> String {
    std::env::var("LIVELINK_AUDIO_MONITOR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "auto_null.monitor".to_string())
}

/// Build the command for the `pa` capture. Records the monitor source to a
/// WAV so the reader gets a plain, seekable, well-known format.
pub fn pa_command(out: &Path) -> PullCommand {
    PullCommand {
        program: "parecord".into(),
        args: vec![
            "--device".into(),
            monitor_source(),
            "--file-format=wav".into(),
            out.to_string_lossy().to_string(),
        ],
    }
}

/// Run a capture command to completion, bounded by [`DOWNLOAD_TIMEOUT`].
///
/// Blocking by design: this runs on the worker thread that owns
/// transcription, never on the UI thread. The timeout is enforced by
/// killing the child rather than abandoning it, because a live-stream pull
/// left running would keep writing behind our back.
pub fn run_pull(command: &PullCommand) -> Result<(), CaptureError> {
    if !tool_exists(&command.program) {
        return Err(CaptureError::MissingTool(command.program.clone()));
    }
    debug!(cmd = %command.display(), "capture: running");

    let mut child = std::process::Command::new(&command.program)
        .args(&command.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| CaptureError::Failed(format!("{}: {e}", command.program)))?;

    let deadline = std::time::Instant::now() + DOWNLOAD_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let stderr = child_stderr(&mut child);
                return Err(CaptureError::Failed(format!(
                    "{} exited with {}{}",
                    command.program,
                    status,
                    if stderr.is_empty() { String::new() } else { format!(": {}", stderr.trim()) }
                )));
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(CaptureError::Timeout(command.program.clone()));
                }
                std::thread::sleep(Duration::from_millis(250));
            }
            Err(e) => return Err(CaptureError::Failed(format!("{}: {e}", command.program))),
        }
    }
}

/// Drain whatever the failed child wrote to stderr, for the error message.
fn child_stderr(child: &mut std::process::Child) -> String {
    use std::io::Read;
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut text = String::new();
    let _ = stderr.read_to_string(&mut text);
    text
}

/// Simple existence check without shelling out: PATH scan.
pub fn tool_exists(program: &str) -> bool {
    if which(program) {
        return true;
    }
    // Absolute or relative paths: a direct file check is the honest answer.
    Path::new(program).is_file()
}

fn which(program: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else { return false };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(program);
        candidate.is_file()
    })
}

/// Read captured audio into 16 kHz mono f32 samples.
///
/// Supports what capture produces: WAV from `parecord`, and the audio
/// ffmpeg can decode for anything else. When ffmpeg is available it is the
/// universal path, so capture can hand over an .m4a/.opus/.webm directly.
pub fn read_audio(path: &Path) -> Result<Vec<f32>, CaptureError> {
    if !path.is_file() {
        return Err(CaptureError::NoOutput(path.to_path_buf()));
    }

    // Fast path: WAV via hound, no subprocess, no ffmpeg dependency.
    if path.extension().and_then(|e| e.to_str()) == Some("wav") {
        if let Ok(reader) = hound::WavReader::open(path) {
            return decode_wav(reader);
        }
    }

    decode_with_ffmpeg(path)
}

fn decode_wav(reader: hound::WavReader<std::io::BufReader<std::fs::File>>) -> Result<Vec<f32>, CaptureError> {
    let spec = reader.spec();
    let samples: Vec<f32> = reader
        .into_samples::<i16>()
        .filter_map(Result::ok)
        .map(|s| s as f32 / 32_768.0)
        .collect();
    if samples.is_empty() {
        return Err(CaptureError::NoOutput(PathBuf::from("wav had no samples")));
    }
    resample_mono(&samples, spec.sample_rate, spec.channels)
}

/// Everything else goes through ffmpeg, which is already a dependency for
/// other tooling here and decodes every container we realistically record.
fn decode_with_ffmpeg(path: &Path) -> Result<Vec<f32>, CaptureError> {
    let program = "ffmpeg";
    if !tool_exists(program) {
        return Err(CaptureError::MissingTool(program.into()));
    }

    let output = std::process::Command::new(program)
        .args([
            "-v", "error",
            "-i",
            &path.to_string_lossy(),
            "-ac", "1",
            "-ar", "16000",
            "-f", "f32le",
            "-",
        ])
        .output()
        .map_err(|e| CaptureError::Failed(format!("ffmpeg: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(CaptureError::Failed(format!("ffmpeg decode: {}", stderr.trim())));
    }

    let bytes = &output.stdout[..];
    if bytes.len() % 4 != 0 {
        return Err(CaptureError::Failed(format!(
            "ffmpeg returned a partial f32 stream ({} bytes)",
            bytes.len()
        )));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

/// Mix to mono and resample to `SAMPLE_RATE` (16 kHz), which is what
/// whisper.cpp consumes. Linear because the inputs are either already 16 kHz
/// (nothing to do) or a monitor capture where speed matters more than the
/// last few dB of alias rejection.
pub fn resample_mono(samples: &[f32], rate: u32, channels: u16) -> Result<Vec<f32>, CaptureError> {
    if rate == 0 || channels == 0 {
        return Err(CaptureError::Failed(format!(
            "unusable audio spec: rate={rate} channels={channels}"
        )));
    }

    let mono: Vec<f32> = if channels == 1 {
        samples.to_vec()
    } else {
        let channels = channels as usize;
        samples
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect()
    };

    if rate == super::SAMPLE_RATE {
        return Ok(mono);
    }
    Ok(linear_resample(&mono, rate, super::SAMPLE_RATE))
}

/// Linear interpolation resample. Good enough for speech going into ASR, and
/// it is the same approach the reference implementation uses.
fn linear_resample(audio: &[f32], from_rate: u32, to_rate: u32) -> Vec<f32> {
    if audio.is_empty() || from_rate == 0 {
        return Vec::new();
    }
    let ratio = from_rate as f64 / to_rate as f64;
    let out_len = ((audio.len() as f64) / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let position = i as f64 * ratio;
        let index = position.floor() as usize;
        let fraction = (position - index as f64) as f32;
        let a = audio.get(index).copied().unwrap_or(0.0);
        let b = audio.get(index + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * fraction);
    }
    out
}

/// Split audio into fixed-size chunks of `seconds`. The last chunk is kept
/// even if short, so the final words of a file are not dropped.
pub fn chunk_audio(audio: &[f32], seconds: u32) -> Vec<Vec<f32>> {
    let size = (super::SAMPLE_RATE * seconds.max(1)) as usize;
    if audio.is_empty() {
        return Vec::new();
    }
    audio.chunks(size).map(|c| c.to_vec()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_and_vod_are_not_confused() {
        // A VOD URL on a live platform must not read as live: it is finite,
        // so a streaming reader would truncate it.
        assert_eq!(
            SourceKind::of("https://www.twitch.tv/videos/12345"),
            SourceKind::Video
        );
        assert_eq!(
            SourceKind::of("https://www.kick.com/someguy/videos/abcde"),
            SourceKind::Video
        );
        assert_eq!(SourceKind::of("https://www.twitch.tv/cellbit"), SourceKind::Live);
        assert_eq!(
            SourceKind::of("https://www.niconico.jp/live/abcde"),
            SourceKind::Live
        );
        assert_eq!(
            SourceKind::of("https://www.youtube.com/watch?v=abc"),
            SourceKind::Video
        );
    }

    #[test]
    fn direct_audio_is_a_local_file() {
        assert_eq!(SourceKind::of("https://x.test/audio.m4a"), SourceKind::LocalFile);
        assert_eq!(SourceKind::of("/home/user/anime.mkv"), SourceKind::LocalFile);
    }

    #[test]
    fn download_command_varies_by_resolver() {
        let mut cfg = TranscriptConfig::default();
        cfg.downloader = "yt-dlp".to_string();

        let video = download_command(&cfg, "https://twitch.tv/x", Path::new("/tmp/a.m4a"));
        assert_eq!(video.program, "yt-dlp");
        assert!(video.args.contains(&"--no-playlist".to_string()));
        assert!(video.args.contains(&"bestaudio".to_string()));

        cfg.downloader = "streamlink".to_string();
        let via_streamlink = download_command(&cfg, "https://twitch.tv/x", Path::new("/tmp/a.m4a"));
        assert!(via_streamlink.args.contains(&"--stream-url".to_string()));
    }

    #[test]
    fn a_direct_audio_url_needs_no_resolver() {
        let cfg = TranscriptConfig::default();
        let command = download_command(&cfg, "https://x.test/audio.m4a", Path::new("/tmp/a.m4a"));
        // Straight fetch: no yt-dlp flags, the url is the first argument.
        assert_eq!(command.args.first().map(String::as_str), Some("https://x.test/audio.m4a"));
        assert!(!command.args.iter().any(|a| a == "bestaudio"));
        assert!(is_direct_audio_url("https://x.test/a.MP3?token=1"));
        assert!(!is_direct_audio_url("https://twitch.tv/x"));
    }

    #[test]
    fn command_is_deterministic_for_the_same_inputs() {
        let cfg = TranscriptConfig::default();
        let out = Path::new("/tmp/same.m4a");
        assert_eq!(
            download_command(&cfg, "https://twitch.tv/x", out),
            download_command(&cfg, "https://twitch.tv/x", out)
        );
    }

    #[test]
    fn pa_capture_targets_a_monitor_and_writes_wav() {
        let command = pa_command(Path::new("/tmp/cap.wav"));
        assert_eq!(command.program, "parecord");
        assert!(command.args.iter().any(|a| a == "--device"));
        assert!(command.args.iter().any(|a| a.contains("wav")));
    }

    #[test]
    fn unknown_tools_are_reported_not_guessed() {
        let err = run_pull(&PullCommand {
            program: "definitely-not-installed-tool-xyz".into(),
            args: vec![],
        });
        assert!(matches!(err, Err(CaptureError::MissingTool(_))), "got {err:?}");
    }

    #[test]
    fn resample_mixes_stereo_to_mono_first() {
        // Stereo where left is +1 and right is -1 must cancel to ~0.
        let stereo = vec![1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0];
        let mono = resample_mono(&stereo, super::super::SAMPLE_RATE, 2).expect("mix");
        assert_eq!(mono.len(), 4);
        assert!(mono.iter().all(|s| s.abs() < 1e-6), "stereo did not cancel: {mono:?}");
    }

    #[test]
    fn resample_passes_mono_16k_through_unchanged() {
        let audio = vec![0.0, 0.5, -0.5, 1.0];
        let out = resample_mono(&audio, 16_000, 1).expect("mono");
        assert_eq!(out, audio);
    }

    #[test]
    fn resample_rejects_a_nonsense_spec() {
        let err = resample_mono(&[0.0; 8], 0, 1).expect_err("zero rate");
        assert!(err.to_string().contains("unusable audio spec"));
    }

    #[test]
    fn resampling_48k_to_16k_lands_on_the_expected_length() {
        let audio: Vec<f32> = (0..48_000).map(|i| (i as f32 * 0.01).sin()).collect();
        let out = resample_mono(&audio, 48_000, 1).expect("resample");
        assert_eq!(out.len(), 16_000);
    }

    #[test]
    fn chunking_covers_the_whole_stream_and_keeps_a_short_tail() {
        let audio = vec![0.0f32; 16_000 * 12]; // 12 seconds
        let chunks = chunk_audio(&audio, 5);
        assert_eq!(chunks.len(), 3, "12s at 5s chunks is ceil(12/5)");
        assert_eq!(chunks[0].len(), 16_000 * 5);
        assert_eq!(chunks[2].len(), 16_000 * 2, "the tail must not be dropped");
        assert!(chunk_audio(&[], 5).is_empty());
    }
}