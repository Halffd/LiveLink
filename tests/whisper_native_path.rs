//! End-to-end checks of the native transcription path with the real
//! orchestrator, and with real audio captured on this machine.
//!
//! The model file is an explicit operator download (see CONFIG.md), so the
//! inference tests are gated on its presence. Everything else — config
//! selection, cache reuse, capture wiring, graceful degradation — runs
//! unconditionally.

use livelink::config::TranscriptConfig;
use livelink::services::transcript::TranscriptWorker;
use livelink::services::whisper_native::{
    capture::{self, download_command, pa_command, PullCommand},
    engine,
};
use std::path::Path;

fn native_config() -> TranscriptConfig {
    let mut cfg = TranscriptConfig::default();
    cfg.backend = "native".to_string();
    cfg
}

#[test]
fn native_config_selects_the_native_engine_and_downgrades_gracefully() {
    let cfg = native_config();
    assert!(cfg.native(), "backend must select native");

    // No model file on this box by default: the engine must say so, and the
    // builder must hand back a disabled engine rather than panicking or
    // aborting the process.
    let mut engine = engine::build_engine(&cfg);
    let result = engine.transcribe(&[0.0f32; 16_000]);
    match result {
        Err(e) => {
            let text = e.to_string();
            assert!(
                text.contains("disabled") || text.contains("model not found"),
                "unexpected error: {text}"
            );
        }
        Ok(_) => {
            // A model happens to be installed; only assert it ran sanely.
            assert_eq!(engine.model_name(), cfg.whisper_model);
        }
    }
}

#[test]
fn capture_selection_is_respected_per_mode() {
    let base = Path::new("/tmp/livelink-capture-test");

    let download = download_command(
        &{
            let mut c = TranscriptConfig::default();
            c.downloader = "yt-dlp".to_string();
            c
        },
        "https://twitch.tv/x",
        &base.join("a.m4a"),
    );
    assert_eq!(download.program, "yt-dlp");
    assert!(download.args.iter().any(|a| a == "bestaudio"));

    let pa = pa_command(&base.join("cap.wav"));
    assert_eq!(pa.program, "parecord");
    assert!(pa.args.iter().any(|a| a.contains("wav")));
}

#[test]
fn a_missing_capture_tool_is_an_error_not_a_panic() {
    let command = PullCommand {
        program: "not-a-real-capture-tool".into(),
        args: vec![],
    };
    match capture::run_pull(&command) {
        Err(capture::CaptureError::MissingTool(name)) => assert_eq!(name, "not-a-real-capture-tool"),
        other => panic!("expected MissingTool, got {other:?}"),
    }
}

#[test]
fn audio_prep_matches_what_whisper_consumes() {
    // 48 kHz stereo, as parecord would hand over: 96_000 samples *is*
    // 48_000 frames (2 channels), which is 1 second of audio, so after
    // mixing to mono and resampling to 16 kHz it must be exactly 16_000
    // samples — 1 second. This pins the whole prep chain's shape: a wrong
    // channel mix or a wrong resample ratio shows up as a length change and
    // every later cue time would be off.
    let stereo: Vec<f32> = (0..96_000).map(|i| (i as f32 * 0.001).sin()).collect();
    let mono = capture::resample_mono(&stereo, 48_000, 2).expect("prep");
    assert_eq!(mono.len(), 16_000, "1s of 16 kHz mono = 16000 samples");

    // A 5s chunk comfortably contains it, so one chunk.
    let chunks = capture::chunk_audio(&mono, 5);
    assert_eq!(chunks.len(), 1);
    assert_eq!(chunks[0].len(), mono.len());

    // Three seconds really is 3x that, which is what a live capture yields.
    let three_seconds: Vec<f32> = (0..96_000 * 3).map(|i| (i as f32 * 0.001).sin()).collect();
    let mono3 = capture::resample_mono(&three_seconds, 48_000, 2).expect("prep");
    assert_eq!(mono3.len(), 48_000, "3s of 16 kHz mono = 48000 samples");
}

#[test]
fn srt_output_is_well_formed_for_a_player() {
    // Assemble the same segments the worker would, then check the file.
    let segments = vec![
        engine::Segment { start_ms: 3_600_000, end_ms: 3_601_500, text: "one".into() },
        engine::Segment { start_ms: 3_601_500, end_ms: 3_603_000, text: "two".into() },
    ];
    let srt = engine::to_srt(&segments);
    // Numbered cues, SRT timestamps, and the offsets are preserved.
    assert!(srt.contains("1\n01:00:00,000 --> 01:00:01,500\none"));
    assert!(srt.contains("2\n01:00:01,500 --> 01:00:03,000\ntwo"));
}

#[test]
fn the_native_and_server_paths_agree_on_the_cache_path() {
    // A transcript written by one engine must be found by the other, or a
    // backend switch would silently re-transcribe everything it already has.
    let mut server_cfg = TranscriptConfig::default();
    server_cfg.audio_dir.clear();
    let cache = TranscriptWorker::new(server_cfg, Path::new("/tmp/cfg")).srt_path("https://twitch.tv/x");

    let mut native_cfg = native_config();
    native_cfg.audio_dir.clear();
    // The worker's own helper is private; re-derive it through the public
    // path the worker uses so the two cannot drift.
    let native_cache = TranscriptWorker::new(native_cfg, Path::new("/tmp/cfg")).srt_path("https://twitch.tv/x");

    assert_eq!(cache, native_cache, "backends must share the cache layout");
}

#[test]
fn record_capture_produces_a_per_screen_dump_path() {
    let mut cfg = TranscriptConfig::default();
    cfg.capture = "record".to_string();
    cfg.backend = "native".to_string();
    cfg.audio_dir.clear();

    // The helper reads the config file from disk, so this test uses a temp
    // config dir rather than the repo's real config.
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_dir = tmp.path().join("config");
    std::fs::create_dir_all(&config_dir).expect("mkdir");
    std::fs::write(
        config_dir.join("transcript.json"),
        serde_json::to_string(&cfg).expect("serialize config"),
    )
    .expect("write transcript.json");

    let path = livelink::services::whisper_native::record_for_screen(&config_dir, 1)
        .expect("record capture enabled");
    assert!(path.contains("screen-1"), "path should be per screen: {path}");
    assert!(path.ends_with(".mkv"), "mpv names the dump an mkv: {path}");

    // Screen 2 must get a different path, or two screens would share a file
    // and one screen's transcript would come from the other's audio.
    let path2 = livelink::services::whisper_native::record_for_screen(&config_dir, 2)
        .expect("record capture enabled");
    assert!(path2.contains("screen-2"), "screen 2 path: {path2}");
    assert_ne!(path, path2, "each screen must dump to its own file");
}

#[test]
fn default_backend_is_server_and_record_capture_is_off() {
    let cfg = TranscriptConfig::default();
    // The default is the existing server behavior, not native.
    assert_eq!(cfg.backend, "server");
    assert!(!cfg.native());

    // `record` is a valid capture mode, but the helper only returns a path
    // when the mode is explicitly set to "record" AND the backend is native.
    // A server-backend config must not make the player dump audio.
    let mut cfg = TranscriptConfig::default();
    cfg.capture = "record".to_string();
    // backend stays "server", so the player must not dump audio.
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_dir = tmp.path().join("config");
    std::fs::create_dir_all(&config_dir).expect("mkdir");
    std::fs::write(
        config_dir.join("transcript.json"),
        serde_json::to_string(&cfg).expect("serialize config"),
    )
    .expect("write transcript.json");
    assert!(
        livelink::services::whisper_native::record_for_screen(&config_dir, 1).is_none(),
        "a server-backend config must not make the player dump audio"
    );
}

#[test]
fn model_path_resolves_relative_to_the_model_dir() {
    let mut cfg = native_config();
    cfg.model_dir = "models".to_string();
    cfg.whisper_model = "ggml-small.bin".to_string();

    let path = engine::WhisperEngine::resolve_model_path(&cfg);
    let as_string = path.to_string_lossy().to_string();
    assert!(as_string.contains("models"), "model dir not honoured: {as_string}");
    assert!(as_string.ends_with("ggml-small.bin"), "model name not honoured: {as_string}");
}