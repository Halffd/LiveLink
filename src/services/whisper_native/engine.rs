//! whisper.cpp inference. It owns the model and the sampling parameters and
//! knows nothing about where audio comes from — that is [`crate::services::whisper_native::capture`]'s
//! job — so this can be tested and swapped independently.
//!
//! The parameter set mirrors /host/captioner-rs `crates/captioner-core/src/stt.rs`,
//! which is the working reference for this exact whisper-rs version.

use std::path::PathBuf;

use tracing::{debug, info, warn};

use crate::config::TranscriptConfig;

/// One transcribed segment, timestamps in milliseconds relative to the
/// audio handed in.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

pub enum EngineError {
    /// The model file is not on disk (and could not be downloaded).
    MissingModel(PathBuf),
    /// Loading or running the model failed.
    Whisper(String),
    /// Inference is configured but cannot run (e.g. no model configured).
    NotConfigured(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingModel(p) => write!(f, "whisper model not found: {}", p.display()),
            Self::Whisper(e) => write!(f, "whisper: {e}"),
            Self::NotConfigured(e) => write!(f, "whisper not configured: {e}"),
        }
    }
}

impl std::fmt::Debug for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::error::Error for EngineError {}

/// A whisper engine that transcribes f32 audio and can be called repeatedly
/// (a live stream keeps feeding it chunks).
pub trait Transcriber: Send {
    /// Transcribe one chunk of 16 kHz mono f32 audio.
    fn transcribe(&mut self, audio: &[f32]) -> Result<Vec<Segment>, EngineError>;

    /// Human-readable model name, for logs.
    fn model_name(&self) -> String;
}

/// The real engine, backed by whisper.cpp through whisper-rs.
pub struct WhisperEngine {
    ctx: whisper_rs::WhisperContext,
    model: String,
    language: Option<String>,
    translate: bool,
    threads: i32,
}

impl WhisperEngine {
    /// Load a model from disk. The model file must already exist: this
    /// project does not download models implicitly, because a 1 GB download
    /// should be an explicit operator action, not a surprise at first run.
    pub fn load(config: &TranscriptConfig) -> Result<Self, EngineError> {
        let path = Self::resolve_model_path(config);
        if !path.exists() {
            return Err(EngineError::MissingModel(path));
        }

        let mut params = whisper_rs::WhisperContextParameters::new();
        params.use_gpu = config.whisper_gpu;

        let ctx = whisper_rs::WhisperContext::new_with_params(&path, params)
            .map_err(|e| EngineError::Whisper(format!("failed to load model: {e:?}")))?;

        info!(
            model = %config.whisper_model,
            gpu = config.whisper_gpu,
            "whisper model loaded"
        );

        Ok(Self {
            ctx,
            model: config.whisper_model.clone(),
            language: if config.language.trim().is_empty() {
                None
            } else {
                Some(config.language.clone())
            },
            // A language-learning TV wants the original language captured
            // verbatim; translating to English would lose the vocabulary
            // the whole product exists to teach. Translation stays opt-out.
            translate: false,
            threads: default_threads(),
        })
    }

    /// Where the model file should live. The configured `model_dir` may be
    /// relative, so resolve it against the current directory: a config that
    /// says `models/ggml-small.bin` works from the repo root as well as
    /// from an installed prefix.
    pub fn resolve_model_path(config: &TranscriptConfig) -> PathBuf {
        let model = PathBuf::from(&config.model_dir).join(&config.whisper_model);
        model.canonicalize().unwrap_or(model)
    }
}

impl Transcriber for WhisperEngine {
    fn transcribe(&mut self, audio: &[f32]) -> Result<Vec<Segment>, EngineError> {
        let mut state = self
            .ctx
            .create_state()
            .map_err(|e| EngineError::Whisper(format!("failed to create state: {e:?}")))?;

        let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 0 });
        params.set_n_threads(self.threads);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_print_special(false);
        // Timestamps on: the SRT needs cue times, and the player syncs
        // subtitles to the media clock through them.
        params.set_no_timestamps(false);
        params.set_translate(self.translate);
        params.set_suppress_blank(true);
        params.set_language(self.language.as_deref());

        let started = std::time::Instant::now();
        state
            .full(params, audio)
            .map_err(|e| EngineError::Whisper(format!("transcription failed: {e:?}")))?;

        let mut out = Vec::new();
        let n = state.full_n_segments();
        for i in 0..n {
            let Some(segment) = state.get_segment(i) else { continue };
            let Ok(text) = segment.to_str() else { continue };
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            out.push(Segment {
                // whisper.cpp can hand back negative timestamps; an SRT
                // cue may not, so clamp instead of casting (a wrapped
                // negative lands at a 17-digit cue time and the player
                // never shows the subtitle).
                start_ms: segment.start_timestamp().max(0) as u64,
                end_ms: segment.end_timestamp().max(0) as u64,
                text: text.to_string(),
            });
        }
        debug!(
            seconds = audio.len() as f32 / 16_000.0,
            segments = out.len(),
            took_ms = started.elapsed().as_millis(),
            "whisper transcribed a chunk"
        );
        Ok(out)
    }

    fn model_name(&self) -> String {
        self.model.clone()
    }
}

/// A no-op transcriber used when transcription is disabled: it keeps the
/// worker's code path free of `Option<Box<dyn Transcriber>>` plumbing and
/// makes a disabled config explicit at the call site.
pub struct DisabledEngine;

impl Transcriber for DisabledEngine {
    fn transcribe(&mut self, _audio: &[f32]) -> Result<Vec<Segment>, EngineError> {
        Err(EngineError::NotConfigured("transcription is disabled".into()))
    }

    fn model_name(&self) -> String {
        "disabled".to_string()
    }
}

/// Build the engine a config asks for: the real one for `native`, the
/// no-op otherwise. This is the only place that branches on the backend,
/// so callers always hold a working transcriber.
pub fn build_engine(config: &TranscriptConfig) -> Box<dyn Transcriber> {
    if config.native() {
        match WhisperEngine::load(config) {
            Ok(engine) => Box::new(engine),
            Err(e) => {
                warn!(error = %e, "native whisper backend unavailable, transcription off");
                Box::new(DisabledEngine)
            }
        }
    } else {
        Box::new(DisabledEngine)
    }
}

fn default_threads() -> i32 {
    // whisper.cpp is CPU-bound; more than ~4 threads rarely helps and
    // actively hurts on a box sharing the CPU with several player windows.
    std::thread::available_parallelism()
        .map(|n| n.get().min(4) as i32)
        .unwrap_or(1)
}

/// Serialize segments as an SRT with cues spanning the whole file, so a
/// live-updating .srt can simply be rewritten each time more audio lands.
pub fn to_srt(segments: &[Segment]) -> String {
    let mut out = String::new();
    for (index, segment) in segments.iter().enumerate() {
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            index + 1,
            stamp(segment.start_ms),
            stamp(segment.end_ms),
            segment.text
        ));
    }
    out
}

/// `HH:MM:SS,mmm` — the SRT timestamp format.
pub fn stamp(millis: u64) -> String {
    let hours = millis / 3_600_000;
    let minutes = (millis / 60_000) % 60;
    let seconds = (millis / 1000) % 60;
    let rest = millis % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{rest:03}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_timestamps_are_formatted_for_players() {
        assert_eq!(stamp(0), "00:00:00,000");
        assert_eq!(stamp(1_499), "00:00:01,499");
        assert_eq!(stamp(3_723_456), "01:02:03,456");
    }

    #[test]
    fn srt_has_one_numbered_cue_per_segment_in_order() {
        let srt = to_srt(&[
            Segment { start_ms: 0, end_ms: 1500, text: "こんにちは".into() },
            Segment { start_ms: 1500, end_ms: 2900, text: "world".into() },
        ]);
        assert!(srt.starts_with("1\n00:00:00,000 --> 00:00:01,500\nこんにちは\n\n"));
        assert!(srt.contains("2\n00:00:01,500 --> 00:00:02,900\nworld"));
        // Two cues, numbered from 1.
        assert_eq!(srt.matches(" --> ").count(), 2);
    }

    #[test]
    fn empty_segments_produce_an_empty_srt() {
        assert_eq!(to_srt(&[]), "");
    }

    #[test]
    fn disabled_engine_says_so_rather_than_panicking() {
        let mut engine = DisabledEngine;
        let err = engine.transcribe(&[0.0; 160]).expect_err("no inference");
        assert!(err.to_string().contains("disabled"));
        assert_eq!(engine.model_name(), "disabled");
    }

    #[test]
    fn default_threads_stays_small_on_a_shared_box() {
        let threads = default_threads();
        assert!(threads >= 1);
        assert!(threads <= 4, "whisper threads must not crowd out players: {threads}");
    }

    #[test]
    fn an_empty_language_means_auto_and_a_real_one_is_pinned() {
        // Mirrors the engine's own rule, spelled out here so a refactor that
        // breaks it fails in a test rather than in a transcript.
        let resolve = |config: &TranscriptConfig| {
            if config.language.trim().is_empty() {
                None
            } else {
                Some(config.language.clone())
            }
        };

        let mut cfg = TranscriptConfig::default();
        cfg.language.clear();
        assert_eq!(resolve(&cfg), None, "empty language must mean auto-detect");

        cfg.language = "ja".to_string();
        assert_eq!(resolve(&cfg), Some("ja".to_string()));

        // Whitespace-only is still "unset" for the engine's purposes.
        cfg.language = "   ".to_string();
        assert_eq!(resolve(&cfg), None);
    }
}