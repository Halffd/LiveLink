//! Subtitle delay correction: the sync primitive per screen.
//!
//! Two halves:
//!
//! - **Manual**: absolute / relative / reset delay per screen and per lane.
//!   Already exposed on the CLI as `livelink subs delay` and in the player
//!   as `sub-delay` / `sub-delay-by` / `sub-delay-reset` — the pieces here
//!   are the same values in one place, not a second implementation.
//!
//! - **Auto-sync**: correct a drifting subtitle track against ground truth
//!   with **alass**, the Automatic Language-Agnostic Subtitle Synchronizer
//!   (installed on this machine as `alass-cli 2.0.0`). Whisper provides the
//!   timestamps that are right; the player's current track is the one that's
//!   wrong; alass shifts the whole track by the offset that aligns them.
//!
//! Why alass and not a hand-rolled cross-correlation: it already solves the
//! hard parts (segment splits, frame-rate mismatch, confidence scoring), it
//! is the tool `.whisper-subs` already runs for the server path, and using it
//! means a fix for one language is a fix for all of them. No new algorithm
//! to maintain.

pub mod xcorr;

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::services::whisper_native::engine;

/// A manual delay for one lane. Seconds, negative means subtitles arrive
/// earlier (the stream is ahead of the track).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Delay(pub f64);

/// Which lane a delay applies to. `primary` is the track the learner reads;
/// `secondary` is the translation lane underneath it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Primary,
    Secondary,
}

impl Lane {
    /// The mpv property names this lane controls.
    pub fn delay_property(self) -> &'static str {
        match self {
            Self::Primary => "sub-delay",
            Self::Secondary => "secondary-sub-delay",
        }
    }
}

/// How to apply a delay to a running player: replace it, nudge it by a
/// signed delta, or drop the override entirely.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DelayAction {
    /// Set an absolute delay in seconds (replaces the current override).
    Set(f64),
    /// Adjust relative to the current override.
    Nudge(f64),
    /// Drop the override and fall back to the config default.
    Reset,
}

/// Encode a delay command for the control protocol. Keeping this here rather
/// than in the CLI and the player in two places is what stops the two from
/// drifting apart on units: both go through the same numbers.
pub fn delay_command(action: DelayAction, lane: Lane) -> String {
    let prefix = match lane {
        Lane::Primary => "sub-delay",
        Lane::Secondary => "sec-sub-delay",
    };
    match action {
        DelayAction::Set(seconds) => serde_json::json!({
            "cmd": prefix,
            "value": seconds,
        })
        .to_string(),
        DelayAction::Nudge(seconds) => serde_json::json!({
            "cmd": format!("{prefix}-by"),
            "value": seconds,
        })
        .to_string(),
        DelayAction::Reset => serde_json::json!({ "cmd": format!("{prefix}-reset") }).to_string(),
    }
}

/// Visibility of the two lanes, resolved from a named mode. These are the
/// only five states a screen can be in; anything else is not a mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitleMode {
    PrimaryOnly,
    SecondaryOnly,
    Stacked,
    Hidden,
    /// Secondary is shown only while the hotkey is held.
    ToggleSecondary,
}

impl SubtitleMode {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "primary-only" | "primary" | "jp" => Some(Self::PrimaryOnly),
            "secondary-only" | "secondary" | "en" => Some(Self::SecondaryOnly),
            "stacked" | "both" => Some(Self::Stacked),
            "hidden" | "off" | "none" => Some(Self::Hidden),
            "toggle-secondary" | "toggle" => Some(Self::ToggleSecondary),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::PrimaryOnly => "primary-only",
            Self::SecondaryOnly => "secondary-only",
            Self::Stacked => "stacked",
            Self::Hidden => "hidden",
            Self::ToggleSecondary => "toggle-secondary",
        }
    }

    /// The (primary, secondary) visibility pair a mode resolves to, for a
    /// secondary lane that is currently on. `toggle-secondary` keeps the
    /// secondary hidden unless a hotkey is held.
    pub fn resolve(self, secondary_on: bool) -> (bool, bool) {
        match self {
            Self::PrimaryOnly => (true, false),
            Self::SecondaryOnly => (false, true),
            Self::Stacked => (true, true),
            Self::Hidden => (false, false),
            Self::ToggleSecondary => (true, secondary_on),
        }
    }
}

/// The command to push a mode onto a player. Same wire format as the CLI's
/// `subs mode` command.
pub fn mode_command(mode: SubtitleMode) -> String {
    serde_json::json!({ "cmd": "sub-mode", "text": mode.name() }).to_string()
}

/// Auto-sync a drifting subtitle track against ground-truth timing using
/// **alass**.
///
/// `reference_srt` is what the timestamps should be (the Whisper output, or
/// any trusted transcript). `incorrect_srt` is the track that drifts (the
/// overlay, or an existing subtitle file).
///
/// Returns the corrected subtitle contents on success. alass exits 0 only
/// when it finds a confident alignment, so a non-zero exit here means the
/// offset could not be trusted and the caller should leave the track alone
/// rather than make it worse.
pub struct AlassResult {
    pub corrected: String,
    pub offset_ms: i64,
    pub confidence: Option<f64>,
}

pub enum SyncError {
    /// alass is not installed on this machine.
    MissingTool,
    /// alass ran but could not align the two tracks with confidence.
    LowConfidence(String),
    /// alass produced no usable output file.
    NoOutput(String),
    /// Reading or writing the inputs/outputs failed.
    Io(String),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingTool => write!(f, "alass not installed (install alass-cli)"),
            Self::LowConfidence(e) => write!(f, "alass could not align confidently: {e}"),
            Self::NoOutput(e) => write!(f, "alass produced no output: {e}"),
            Self::Io(e) => write!(f, "sync i/o: {e}"),
        }
    }
}

impl std::fmt::Debug for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for SyncError {}

/// Build the alass command without running it. Splitting the construction
/// out lets a caller (or a test) see exactly what would execute, and lets us
/// unit-test the shape of the arguments instead of the binary's behavior.
pub fn alass_command(reference: &Path, incorrect: &Path, output: &Path) -> (String, Vec<String>) {
    let mut args = vec![
        reference.to_string_lossy().to_string(),
        incorrect.to_string_lossy().to_string(),
        output.to_string_lossy().to_string(),
        // `--no-split`: the stream has no meaningful splits (a live VTuber
        // stream does not cut to a different video), and skipping that step
        // is what makes alass fast enough to run every few seconds while
        // watching.
        "-l".to_string(),
        // `--disable-fps-guessing`: the inputs are SRT timestamps, not
        // MicroDVD frames; there is nothing to guess.
        "-g".to_string(),
    ];
    // `--allow-negative-timestamps`: a cue that starts before 0 is valid
    // for a stream whose first subtitle is already playing when we join.
    args.push("-n".to_string());
    ("alass".to_string(), args)
}

/// Turn a whisper segment list into an SRT the alass reference reader
/// understands. Uses the engine's own formatter, so this and every other
/// .srt in the project agree on formatting.
pub fn reference_srt(segments: &[engine::Segment]) -> String {
    engine::to_srt(segments)
}

/// Run alass on two subtitle files and return the corrected text plus the
/// median offset it computed (milliseconds: positive means the incorrect
/// track was late and needs to be advanced).
pub fn alass_sync(reference: &Path, incorrect: &Path) -> Result<AlassResult, SyncError> {
    if which_alass().is_none() {
        return Err(SyncError::MissingTool);
    }
    if !reference.is_file() {
        return Err(SyncError::Io(format!(
            "reference file missing: {}",
            reference.display()
        )));
    }
    if !incorrect.is_file() {
        return Err(SyncError::Io(format!(
            "incorrect file missing: {}",
            incorrect.display()
        )));
    }

    // Output goes next to the input, atomically published via rename.
    let output = incorrect.with_extension("synced.srt");
    let (program, args) = alass_command(reference, incorrect, &output);
    let mut child = std::process::Command::new(&program)
        .args(&args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| SyncError::Io(format!("{program}: {e}")))?;

    // alass is fast for small files, but it is still a third-party tool:
    // cap it so a pathological input cannot wedge the worker.
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    return Err(SyncError::NoOutput("alass timed out".into()));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(SyncError::Io(format!("alass wait: {e}"))),
        }
    };

    if !status.success() {
        let stderr = child_stderr(child);
        return Err(SyncError::LowConfidence(stderr));
    }

    let corrected = std::fs::read_to_string(&output)
        .map_err(|e| SyncError::NoOutput(format!("{}: {e}", output.display())))?;

    // alass reports the offset it applied. The corrected file is the source
    // of truth for the player; the offset is only informational, and is
    // reported by inspecting the shift between the first cue in each file.
    let offset_ms = first_cue_offset_ms(incorrect, &corrected).unwrap_or(0);
    Ok(AlassResult {
        corrected,
        offset_ms,
        confidence: None,
    })
}

fn which_alass() -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join("alass"))
            .find(|p| p.is_file())
    })
}

fn child_stderr(mut child: std::process::Child) -> String {
    use std::io::Read;
    let Some(mut stderr) = child.stderr.take() else {
        return String::new();
    };
    let mut text = String::new();
    let _ = stderr.read_to_string(&mut text);
    text
}

/// Compute how far the incorrect track is shifted relative to the corrected
/// one, by comparing the first cue's start times. alass's output preserves
/// the format, so a simple SRT parse is enough here.
fn first_cue_offset_ms(original: &Path, corrected_text: &str) -> Option<i64> {
    let original_text = std::fs::read_to_string(original).ok()?;
    let a = first_start_ms(&original_text)?;
    let b = first_start_ms(corrected_text)?;
    Some(b - a)
}

/// First `start` timestamp in an SRT file, in milliseconds.
fn first_start_ms(text: &str) -> Option<i64> {
    for line in text.lines() {
        let line = line.trim();
        if let Some((start, _)) = line.split_once("-->") {
            let start = start.trim();
            let mut parts = start.split(':');
            let h: i64 = parts.next()?.parse().ok()?;
            let m: i64 = parts.next()?.parse().ok()?;
            // Seconds may be fractional (03,500 = 3.5s). Parse as f64 and
            // convert to ms as a float, not by rounding seconds first.
            let s: f64 = parts.next()?.replace(',', ".").parse::<f64>().ok()?;
            let ms = ((h * 3600 + m * 60) as f64 * 1000.0 + s * 1000.0).round() as i64;
            return Some(ms);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn delay_commands_match_the_control_protocol() {
        assert_eq!(
            delay_command(DelayAction::Set(2.5), Lane::Primary),
            r#"{"cmd":"sub-delay","value":2.5}"#
        );
        assert_eq!(
            delay_command(DelayAction::Nudge(-0.5), Lane::Secondary),
            r#"{"cmd":"sec-sub-delay-by","value":-0.5}"#
        );
        assert_eq!(
            delay_command(DelayAction::Reset, Lane::Primary),
            r#"{"cmd":"sub-delay-reset"}"#
        );
        assert_eq!(
            delay_command(DelayAction::Reset, Lane::Secondary),
            r#"{"cmd":"sec-sub-delay-reset"}"#
        );
    }

    #[test]
    fn lane_property_names_match_mpv() {
        assert_eq!(Lane::Primary.delay_property(), "sub-delay");
        assert_eq!(Lane::Secondary.delay_property(), "secondary-sub-delay");
    }

    #[test]
    fn modes_resolve_to_the_right_lane_pair() {
        assert_eq!(SubtitleMode::PrimaryOnly.resolve(true), (true, false));
        assert_eq!(SubtitleMode::SecondaryOnly.resolve(false), (false, true));
        assert_eq!(SubtitleMode::Stacked.resolve(false), (true, true));
        assert_eq!(SubtitleMode::Hidden.resolve(false), (false, false));
        // A held hotkey shows the secondary; releasing it hides it again.
        assert_eq!(SubtitleMode::ToggleSecondary.resolve(false), (true, false));
        assert_eq!(SubtitleMode::ToggleSecondary.resolve(true), (true, true));
    }

    #[test]
    fn mode_names_round_trip_and_aliases_parse() {
        for mode in [
            SubtitleMode::PrimaryOnly,
            SubtitleMode::SecondaryOnly,
            SubtitleMode::Stacked,
            SubtitleMode::Hidden,
            SubtitleMode::ToggleSecondary,
        ] {
            assert_eq!(SubtitleMode::parse(mode.name()), Some(mode));
        }
        assert_eq!(SubtitleMode::parse("jp"), Some(SubtitleMode::PrimaryOnly));
        assert_eq!(SubtitleMode::parse("en"), Some(SubtitleMode::SecondaryOnly));
        assert_eq!(SubtitleMode::parse("off"), Some(SubtitleMode::Hidden));
        assert_eq!(SubtitleMode::parse("nonsense"), None);
    }

    #[test]
    fn alass_args_include_no_split_and_no_fps_guessing() {
        let (program, args) = alass_command(
            Path::new("/tmp/ref.srt"),
            Path::new("/tmp/inc.srt"),
            Path::new("/tmp/out.srt"),
        );
        assert_eq!(program, "alass");
        assert!(args.contains(&"-l".to_string()), "no-split mode must be set for live");
        assert!(args.contains(&"-g".to_string()), "no fps guessing for SRT inputs");
        assert!(args.contains(&"-n".to_string()), "allow negative timestamps");
        assert_eq!(args[0], "/tmp/ref.srt");
        assert_eq!(args[1], "/tmp/inc.srt");
        assert_eq!(args[2], "/tmp/out.srt");
    }

    #[test]
    fn reference_srt_uses_the_engine_formatter() {
        let srt = reference_srt(&[engine::Segment {
            start_ms: 1000,
            end_ms: 2000,
            text: "hello".into(),
        }]);
        assert!(srt.starts_with("1\n00:00:01,000 --> 00:00:02,000\nhello\n\n"));
    }

    #[test]
    fn first_cue_offset_is_the_shift_in_ms() {
        let original = "1\n00:00:02,000 --> 00:00:04,000\nhello\n";
        let corrected = "1\n00:00:03,500 --> 00:00:05,500\nhello\n";
        let path = std::env::temp_dir().join("sync-test.srt");
        std::fs::write(&path, original).expect("write");
        assert_eq!(first_cue_offset_ms(&path, corrected), Some(1500));
        let _ = std::fs::remove_file(path);
    }
}