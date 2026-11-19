//! Automatic subtitle generation through the `.whisper-subs` transcription
//! API. When a stream starts (orchestrator `StreamChangeEvent`), the worker
//! submits it for transcription, streams growing subtitles into a cached file
//! while whisper runs, and attaches the file to the screen's player window via
//! its control port. mpv reloads external subtitle files when they change, so
//! updating the file in place is enough to get live-updating captions.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use tracing::{debug, info, warn};

use crate::config::TranscriptConfig;
use crate::core::orchestrator::{Orchestrator, StreamChangeEvent, StreamChangeKind};
use crate::player_ui::control;
use crate::services::whisper_api;

/// Poll interval for task status and growing subtitles.
const POLL_INTERVAL: Duration = Duration::from_secs(3);

/// (screen, url) -> follower handle + API task id, for cancellation.
type Followers = Arc<DashMap<(u32, String), (JoinHandle<()>, String)>>;

pub struct TranscriptWorker {
    pub config: TranscriptConfig,
    client: reqwest::Client,
    api_key: Option<String>,
    transcripts_dir: PathBuf,
    followers: Followers,
}

/// Read the first admin API key out of a .whisper-subs `api_config.json`.
pub fn api_key_from_file(content: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    value
        .get("users")?
        .get("admin")?
        .get("api_keys")?
        .get(0)?
        .as_str()
        .map(str::to_string)
}

impl TranscriptWorker {
    pub fn new(config: TranscriptConfig, config_dir: &std::path::Path) -> Arc<Self> {
        let api_key = config.api_key.clone().or_else(|| {
            std::fs::read_to_string(&config.api_key_file)
                .ok()
                .and_then(|content| api_key_from_file(&content))
        });
        let transcripts_dir = if config.transcript_dir.is_empty() {
            config_dir.join("transcripts")
        } else {
            PathBuf::from(&config.transcript_dir)
        };
        let _ = std::fs::create_dir_all(&transcripts_dir);

        Arc::new(Self {
            config,
            client: reqwest::Client::new(),
            api_key,
            transcripts_dir,
            followers: Arc::new(DashMap::new()),
        })
    }

    /// Stable cache path for a source URL.
    pub fn srt_path(&self, url: &str) -> PathBuf {
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        self
            .transcripts_dir
            .join(format!("{:016x}.srt", hasher.finish()))
    }

    fn request(&self, method: reqwest::Method, url: String) -> reqwest::RequestBuilder {
        let request = self.client.request(method, url).timeout(POLL_INTERVAL);
        match &self.api_key {
            Some(key) => request.header("X-API-Key", key),
            None => request,
        }
    }

    /// True when the worker can try this source: an existing local file or a
    /// remote HTTP(S) URL. Anything else (magnet/rtmp/paths that do not
    /// resolve) has no audio the server can read.
    fn transcribable(url: &str) -> bool {
        url.starts_with("http://")
            || url.starts_with("https://")
            || std::path::Path::new(url).is_file()
    }

    /// Send a sub-add command for the cached srt to the screen's player window.
    async fn attach(&self, screen: u32, path: &std::path::Path) {
        let port = control::DEFAULT_BASE_PORT.saturating_add(u16::try_from(screen).unwrap_or(0));
        let line = serde_json::json!({
            "cmd": "sub-add",
            "url": path.to_string_lossy(),
        })
        .to_string();
        if let Err(e) = control::send_command(port, &line).await {
            debug!(screen, error = %e, "no player window for transcription attach");
        }
    }

    /// Submit a stream for transcription; cached transcripts attach instantly.
    pub async fn handle(self: &Arc<Self>, screen: u32, url: &str) {
        if !self.config.enabled || !Self::transcribable(url) {
            return;
        }
        let cache = self.srt_path(url);
        if cache.is_file() {
            info!(screen, "attaching cached transcript");
            self.attach(screen, &cache).await;
            return;
        }
        if self.followers.contains_key(&(screen, url.to_string())) {
            return;
        }

// Native path: no server, capture + whisper.cpp in this process. Same
        // cache file and the same attach() as the server path, so a transcript
        // made either way is reused by the other.
        if self.config.native() {
            self.follow_native(screen, url.to_string());
            return;
        }

let response = self
            .request(
                reqwest::Method::POST,
                format!("{}{}", self.config.api_url, whisper_api::paths::TRANSCRIBE),
            )
            .json(&whisper_api::transcribe_body(
                url,
                &self.config.model,
                // Engine prefix ("whisperx" or empty) routes the request.
                &self.config.engine,
                // Pin the language so code-switched audio keeps one align
                // model instead of switching mid-stream on detected chunks.
                // Empty means auto-detect; the server expects null, not "".
                if self.config.language.is_empty() {
                    None
                } else {
                    Some(self.config.language.as_str())
                },
                // VAD gating drops music/silence before alignment; without
                // it WhisperX aligns intro lyrics to wrong beats.
                self.config.vad,
                // Diarization is optional (pyannote, needs HF_TOKEN).
                self.config.diarization,
            ))
            .send()
            .await;
        let task_id = match response {
            Ok(resp) if resp.status().is_success() => match resp.json::<TaskResponse>().await {
                Ok(task) => task.task_id,
                Err(e) => {
                    warn!(url, error = %e, "transcription response unreadable");
                    return;
                }
            },
            Ok(resp) => {
                debug!(url, status = %resp.status(), "transcription request rejected");
                return;
            }
            Err(e) => {
                debug!(url, error = %e, "transcription api unreachable");
                return;
            }
        };

        info!(screen, task = %task_id, "transcription started");
        let follower = self.spawn_follower(screen, url.to_string(), task_id.clone());
        self.followers
            .insert((screen, url.to_string()), (follower, task_id));
    }

    /// Stop following a stream's transcription (stream stopped or moved away).
    pub async fn cancel(&self, screen: u32, url: &str) {
        if let Some((_, (handle, task_id))) = self.followers.remove(&(screen, url.to_string())) {
            handle.abort();
            debug!(screen, task = %task_id, "cancelled transcription follower");
            let _ = self
                .request(
                    reqwest::Method::GET,
                    format!("{}{}", self.config.api_url, whisper_api::paths::task_cancel(&task_id)),
                )
                .send()
                .await;
        }
    }

    /// Transcribe a stream in this process: capture audio, chunk it, run
    /// whisper.cpp on each chunk, and append the cues to the cached .srt so
    /// the player's subtitle file grows as the stream does.
    ///
    /// Blocking calls run on a dedicated thread (never the reactor), because
    /// both capture (a subprocess) and inference can take seconds per chunk.
    fn follow_native(self: &Arc<Self>, screen: u32, url: String) {
        let worker = Arc::clone(self);
        std::thread::spawn(move || {
            worker.transcribe_native(screen, &url);
        });
    }

    /// The blocking body of [`Self::follow_native`].
    fn transcribe_native(&self, screen: u32, url: &str) {
        use crate::services::whisper_native::{
            capture::{self, download_command, run_pull},
            engine,
        };

        let config = &self.config;
        let cache = self.srt_path(url);

        // 1. Engine.
        let mut engine: Box<dyn engine::Transcriber> = engine::build_engine(config);
        if engine.model_name() == "disabled" {
            debug!(screen, "native transcription disabled; nothing to do");
            return;
        }

        // 2. Capture.
        let (audio, source_label) = match config.capture.as_str() {
            "pa" => match capture::run_pull(&capture::pa_command(&self.pa_target())) {
                Ok(()) => match capture::read_audio(&self.pa_target()) {
                    Ok(audio) => (audio, "pa"),
                    Err(e) => {
                        warn!(screen, error = %e, "pa capture produced no audio");
                        return;
                    }
                },
                Err(e) => {
                    warn!(screen, error = %e, "pa capture failed (is parecord installed and a monitor source set?)");
                    return;
                }
            },
            "record" => match capture::read_audio(&self.record_target()) {
                Ok(audio) => (audio, "record"),
                Err(e) => {
                    warn!(screen, error = %e, "record capture read failed");
                    return;
                }
            },
            // Anything else (including the default) pulls the audio track.
            _ => {
                let target = self.download_target(url);
                let command = download_command(config, url, &target);
                match run_pull(&command) {
                    Ok(()) => match capture::read_audio(&target) {
                        Ok(audio) => (audio, "download"),
                        Err(e) => {
                            warn!(screen, error = %e, path = %target.display(), "downloaded audio unreadable");
                            return;
                        }
                    },
                    Err(e) => {
                        warn!(screen, error = %e, cmd = %command.display(), "audio download failed");
                        return;
                    }
                }
            }
        };

        info!(
            screen,
            source = source_label,
            seconds = audio.len() as f32 / 16_000.0,
            "captured audio for native transcription"
        );

        // 3. Transcribe chunk by chunk, keeping cue offset from the stream
        //    start so a growing .srt stays in sync.
        let mut segments: Vec<engine::Segment> = Vec::new();
        let chunk_seconds = config.chunk_seconds.max(1);
        let chunk_size = (16_000 * chunk_seconds) as usize;

        for (index, chunk) in capture::chunk_audio(&audio, chunk_seconds).into_iter().enumerate() {
            let offset_ms = (index * chunk_size / 16) as u64;
            match engine.transcribe(&chunk) {
                Ok(mut chunk_segments) => {
                    for mut segment in chunk_segments.drain(..) {
                        segment.start_ms += offset_ms;
                        segment.end_ms += offset_ms;
                        segments.push(segment);
                    }
                }
                Err(e) => {
                    warn!(screen, error = %e, chunk = index, "whisper failed on a chunk");
                    return;
                }
            }
        }

        // 4. Publish atomically, then hand it to the player. The writer rewrites
        //    through a temp file and renames, so the player never reads a
        //    half-written .srt mid-update.
        let srt = engine::to_srt(&segments);
        save_if_changed(&cache, &srt);
        info!(screen, path = %cache.display(), "native transcript written");
        // attach() is async because the server path is; this path is a plain
        // thread, so use the blocking port send it wraps.
        // A closed window is the expected case (nothing to tell), so the send's
        // result carries no information worth surfacing.
        let _ = control::send_command_sync(self.control_port(screen), &self.sub_add_line(&cache));
    }

    /// Where `record` capture expects the player to have dumped audio.
    fn record_target(&self) -> std::path::PathBuf {
        self.audio_root().join("record.wav")
    }

    /// Where `pa` capture writes the monitor recording.
    fn pa_target(&self) -> std::path::PathBuf {
        self.audio_root().join("pa.wav")
    }

    /// Where `download` capture writes the pulled audio track, named per
    /// source so two screens never clobber each other.
    fn download_target(&self, url: &str) -> std::path::PathBuf {
        let mut hasher = DefaultHasher::new();
        url.hash(&mut hasher);
        self
            .audio_root()
            .join(format!("{:016x}.audio", hasher.finish()))
    }

    /// Root for all capture artifacts (one directory, modes aside).
    fn audio_root(&self) -> std::path::PathBuf {
        if self.config.audio_dir.trim().is_empty() {
            self.transcripts_dir.clone()
        } else {
            std::path::PathBuf::from(&self.config.audio_dir)
        }
    }

    /// The control port a screen's player window listens on.
    fn control_port(&self, screen: u32) -> u16 {
        control::DEFAULT_BASE_PORT.saturating_add(u16::try_from(screen).unwrap_or(0))
    }

    /// The sub-add command line for a transcript file.
    fn sub_add_line(&self, path: &std::path::Path) -> String {
        serde_json::json!({ "cmd": "sub-add", "url": path.to_string_lossy() }).to_string()
    }

    fn spawn_follower(self: &Arc<Self>, screen: u32, url: String, task_id: String) -> JoinHandle<()> {
        let worker = Arc::clone(self);
        tokio::spawn(async move {
            worker.follow(screen, url, task_id).await;
        })
    }

    /// Poll the task, streaming growing subtitles into the cache file and
    /// attaching it to the player window on first availability.
    async fn follow(self: Arc<Self>, screen: u32, url: String, task_id: String) {
        let cache = self.srt_path(&url);
        let key = (screen, url);
        let mut attached = cache.is_file(); // cached files were attached by handle()

        loop {
            tokio::time::sleep(POLL_INTERVAL).await;

            let status_url = format!("{}{}", self.config.api_url, whisper_api::paths::task(&task_id));
            let status = match self
                .request(reqwest::Method::GET, status_url)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => match resp.json::<TaskStatus>().await {
                    Ok(task) => task.status,
                    Err(e) => {
                        debug!(task = %task_id, error = %e, "transcription status unreadable");
                        String::new()
                    }
                },
                Ok(resp) => {
                    debug!(task = %task_id, status = %resp.status(), "transcription status poll failed");
                    String::new()
                }
                Err(e) => {
                    debug!(task = %task_id, error = %e, "transcription status poll failed");
                    String::new()
                }
            };

            match status.as_str() {
                "completed" => {
                    if let Some(content) = self.fetch_subtitles(&task_id).await {
                        let changed = save_if_changed(&cache, &content);
                        if changed && !attached {
                            info!(screen, "transcription complete, attaching");
                            self.attach(screen, &cache).await;
                        }
                    }
                    break;
                }
                "failed" | "cancelled" => {
                    debug!(task = %task_id, status = %status, "transcription ended without result");
                    break;
                }
                _ => {
                    // pending/processing: refresh the growing subtitle file.
                    if let Some(content) = self.fetch_subtitles(&task_id).await {
                        if save_if_changed(&cache, &content) && !attached {
                            info!(screen, "attaching in-progress transcription");
                            self.attach(screen, &cache).await;
                            attached = true;
                        }
                    }
                }
            }
        }

        self.followers.remove(&key);
    }

    async fn fetch_subtitles(&self, task_id: &str) -> Option<String> {
        let url = format!("{}{}", self.config.api_url, whisper_api::paths::task_subtitles(task_id));
        let response = self.request(reqwest::Method::GET, url).send().await.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.text().await.ok().filter(|t| !t.is_empty())
    }

    /// Worker loop: reacts to orchestrator stream changes and manual triggers.
    pub async fn run(
        self: Arc<Self>,
        orchestrator: &Orchestrator,
        mut triggers: mpsc::UnboundedReceiver<(u32, String)>,
    ) {
        let mut changes = orchestrator.subscribe_stream_changes();
        loop {
            tokio::select! {
                event = changes.recv() => match event {
                    Ok(StreamChangeEvent { screen, url, kind }) => match kind {
                        StreamChangeKind::Started => self.handle(screen, &url).await,
                        StreamChangeKind::Stopped => self.cancel(screen, &url).await,
                    },
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!(skipped = n, "transcription worker lagged");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                Some((screen, url)) = triggers.recv() => {
                    self.handle(screen, &url).await;
                }
                else => break,
            }
        }
    }
}

/// Atomic write when the content differs from what is on disk; true when the
/// file changed (so callers attach only on new content).
fn save_if_changed(path: &std::path::Path, content: &str) -> bool {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if existing == content {
            return false;
        }
    }
    let tmp = path.with_extension("srt.tmp");
    if let Err(e) = std::fs::write(&tmp, content) {
        warn!(error = %e, path = %path.display(), "failed to write transcript");
        return false;
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => true,
        Err(e) => {
            warn!(error = %e, path = %path.display(), "failed to store transcript");
            false
        }
    }
}

#[derive(Debug, Deserialize)]
struct TaskResponse {
    task_id: String,
}

#[derive(Debug, Deserialize)]
struct TaskStatus {
    status: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_paths_are_stable_and_inside_the_cache_dir() {
        let worker = TranscriptWorker::new(
            TranscriptConfig::default(),
            std::path::Path::new("/tmp/opencode/livelink-test"),
        );
        let a = worker.srt_path("https://youtube.com/watch?v=abc");
        let b = worker.srt_path("https://youtube.com/watch?v=abc");
        let other = worker.srt_path("https://twitch.tv/foo");
        assert_eq!(a, b);
        assert_ne!(a, other);
        assert_eq!(
            a.parent().unwrap(),
            std::path::Path::new("/tmp/opencode/livelink-test/transcripts")
        );
        assert!(a.file_name().unwrap().to_str().unwrap().ends_with(".srt"));
    }

    #[test]
    fn reads_api_key_from_whisper_subs_config() {
        let content = r#"{
            "users": {"admin": {"password_hash": "x", "api_keys": ["abc123"], "role": "admin"}},
            "settings": {"require_auth": true}
        }"#;
        assert_eq!(api_key_from_file(content), Some("abc123".to_string()));
        assert_eq!(api_key_from_file("{}"), None);
        assert_eq!(api_key_from_file("not json"), None);
    }

    #[test]
    fn saves_only_when_content_differs() {
        let dir = std::env::temp_dir().join("livelink-transcript-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.srt");

        assert!(save_if_changed(&path, "1\n00:00:01,000 --> 00:00:02,000\nhello\n"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1\n00:00:01,000 --> 00:00:02,000\nhello\n");
        // Same content: no rewrite.
        assert!(!save_if_changed(&path, "1\n00:00:01,000 --> 00:00:02,000\nhello\n"));
        // Grown content: rewritten.
        assert!(save_if_changed(&path, "1\n00:00:01,000 --> 00:00:02,000\nhello\n2\n00:00:05,000 --> 00:00:06,000\nbye\n"));
        assert!(!path.with_extension("srt.tmp").exists());
    }

    #[test]
    fn transcribable_sources() {
        assert!(TranscriptWorker::transcribable("http://x/y"));
        assert!(TranscriptWorker::transcribable("https://x/y"));
        assert!(!TranscriptWorker::transcribable("rtmp://x/y"));
        assert!(!TranscriptWorker::transcribable("/definitely/not/a/file.mp4"));
    }
}
