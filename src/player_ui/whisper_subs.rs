//! whisper-subs server client for the player panel: library, channels,
//! live tasks, the subtitle directory and on-demand transcription with
//! streaming (growing) subtitles.
//!
//! Same HTTP surface the Android app and the Lang reader use:
//! POST /transcribe, GET /tasks/{id}, GET /api/v1/tasks/{id}/subtitles
//! (the growing SRT), GET /api/v1/library, /api/v1/channels,
//! /api/v1/channels/{c}/videos, /api/v1/live, /subtitles/list,
//! GET /subtitles/{path}. Calls are blocking reqwest on short timeouts;
//! the panel is click-driven like the channels panel.

use std::time::Duration;

/// Base URL + API key against a whisper-subs server.
#[derive(Debug, Clone)]
pub struct WhisperSubs {
    pub base: String,
    pub key: String,
}

impl WhisperSubs {
    pub fn new(base: impl Into<String>, key: impl Into<String>) -> Self {
        let base = base.into();
        let key = key.into();
        Self {
            base: base.trim().trim_end_matches('/').to_string(),
            key: key.trim().to_string(),
        }
    }

    fn client() -> Result<reqwest::blocking::Client, String> {
        reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| format!("http client: {e}"))
    }

    fn get_json(&self, path: &str) -> Result<serde_json::Value, String> {
        let client = Self::client()?;
        let resp = client
            .get(format!("{}{path}", self.base))
            .header("X-API-Key", &self.key)
            .send()
            .map_err(|e| format!("server unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("server: {}", resp.status()));
        }
        resp.json().map_err(|e| format!("bad response: {e}"))
    }

    fn get_text(&self, path: &str) -> Result<Option<String>, String> {
        let client = Self::client()?;
        let resp = client
            .get(format!("{}{path}", self.base))
            .header("X-API-Key", &self.key)
            .send()
            .map_err(|e| format!("server unreachable: {e}"))?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("server: {}", resp.status()));
        }
        resp.text()
            .map(Some)
            .map_err(|e| format!("read: {e}"))
    }

    fn post_json(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        let client = Self::client()?;
        let resp = client
            .post(format!("{}{path}", self.base))
            .header("X-API-Key", &self.key)
            .json(body)
            .send()
            .map_err(|e| format!("server unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("server: {}", resp.status()));
        }
        resp.json().map_err(|e| format!("bad response: {e}"))
    }

    /// Start a transcription task for `source` (URL or server-visible
    /// path), returning the task id. `engine_prefix` ("whisperx" or empty)
    /// routes the request; VAD gates music/silence; diarization is optional.
    pub fn start_transcription(
        &self,
        source: &str,
        model: &str,
        engine_prefix: &str,
        language: Option<&str>,
        vad: bool,
        diarization: bool,
    ) -> Result<String, String> {
        let body = crate::services::whisper_api::transcribe_body(
            source, model, engine_prefix, language, vad, diarization,
        );
        let decoded = self.post_json(crate::services::whisper_api::paths::TRANSCRIBE, &body)?;
        decoded["task_id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "server returned no task id".to_string())
    }

    /// Poll one task: (status, progress-line). status is one of the
    /// server's pending|processing|completed|failed.
    pub fn task_status(&self, task_id: &str) -> Result<(String, String), String> {
        let path = crate::services::whisper_api::paths::task(task_id);
        let decoded = self.get_json(&path)?;
        let status = decoded["status"].as_str().unwrap_or_default().to_string();
        let progress = decoded["progress"].as_str().unwrap_or_default().to_string();
        Ok((status, progress))
    }

    /// The SRT content for a task as it exists right now (grows while the
    /// task runs). None while the server has not registered the subtitle
    /// path yet.
    pub fn task_subtitles(&self, task_id: &str) -> Result<Option<String>, String> {
        let path = crate::services::whisper_api::paths::task_subtitles(task_id);
        self.get_text(&path)
    }

    /// Library entries: {title, channel, has_video, has_audio, urls{...},
    /// source_url} for every finished transcription.
    pub fn library(&self) -> Result<Vec<serde_json::Value>, String> {
        self.list_of(crate::services::whisper_api::paths::LIBRARY, "library")
    }

    /// Channel list: {name, transcribed, unfinished}.
    pub fn channels(&self) -> Result<Vec<serde_json::Value>, String> {
        self.list_of(crate::services::whisper_api::paths::CHANNELS, "channels")
    }

    /// Merged video list for one channel.
    pub fn channel_videos(&self, channel: &str) -> Result<Vec<serde_json::Value>, String> {
        self.list_of(&crate::services::whisper_api::paths::channel_videos(channel), "videos")
    }

    /// Live/running transcription tasks.
    pub fn live_tasks(&self) -> Result<Vec<serde_json::Value>, String> {
        self.get_json(crate::services::whisper_api::paths::LIVE).map(|decoded| {
            list_of(
                &decoded,
                if decoded.get("live").is_some() { "live" } else { "tasks" },
            )
        })
    }

    /// Every subtitle file the server kept (the subtitle directory).
    pub fn subtitle_list(&self) -> Result<Vec<serde_json::Value>, String> {
        let decoded = self.get_json(crate::services::whisper_api::paths::SUBTITLES_LIST)?;
        decoded
            .as_array()
            .cloned()
            .ok_or_else(|| "unexpected /subtitles/list shape".to_string())
    }

    /// Fetch one subtitle file's content by its server-relative path.
    pub fn subtitle_text(&self, path: &str) -> Result<String, String> {
        let path = crate::services::whisper_api::paths::subtitle(path);
        self.get_text(&path)?
            .ok_or_else(|| "server: 404".to_string())
    }

    fn list_of(&self, path: &str, key: &str) -> Result<Vec<serde_json::Value>, String> {
        self.get_json(path).map(|decoded| list_of(&decoded, key))
    }
}

/// Absolute, properly encoded URL for a server-relative link ("/api/v1/
/// subs/file?path=chan/Video.srt") — the server emits raw path values in
/// query strings and titles contain spaces/brackets.
///
/// Free (not a method) so callers building links to hand to mpv do not
/// need a whole client, and so it never smells like a network call.
pub fn resolve(base: &str, rel: &str) -> String {
    let trimmed = rel.trim_start_matches('/');
    if trimmed.is_empty() {
        return base.to_string();
    }
    let encode = crate::services::whisper_api::paths::encode_path;
    match trimmed.split_once('?') {
        None => format!("{base}/{}", encode(trimmed)),
        Some((path, query)) => {
            let mut params = Vec::new();
            for pair in query.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    params.push(format!(
                        "{}={}",
                        crate::services::whisper_api::paths::encode(k),
                        crate::services::whisper_api::paths::encode(v)
                    ));
                }
            }
            format!("{base}/{}?{}", encode(path), params.join("&"))
        }
    }
}

fn list_of(value: &serde_json::Value, key: &str) -> Vec<serde_json::Value> {
    value[key].as_array().cloned().unwrap_or_default()
}

/// Message from the transcription monitor thread to the UI loop.
#[derive(Debug)]
pub enum WsEvent {
    /// One-line task state ("processing · 42%").
    Status(String),
    /// Growing or final SRT content for the streamed file.
    Srt(String),
    /// The task finished (final Srt, if any, was already delivered).
    Completed,
    /// The task failed with the server's error.
    Failed(String),
}

/// One request the UI hands to its whisper worker thread. The panel never
/// performs HTTP itself: paint sends a job here and paints whatever the
/// previous reply left in the state.
#[derive(Debug)]
pub enum WsRequest {
    /// Fetch a section list (the panel's first view and reload button).
    Library,
    Channels {
        channel: Option<String>,
    },
    Live,
    Subs,
    /// Fetch one subtitle file's text and adopt it locally.
    Subtitle {
        path: String,
    },
    /// Submit the currently loaded media for transcription.
    Transcribe {
        source: String,
        engine: String,
        language: Option<String>,
        vad: bool,
        diarization: bool,
    },
}

/// The worker's reply to a [`WsRequest`], delivered over an mpsc channel
/// and applied by the UI loop.
#[derive(Debug)]
pub enum WsReply {
    Library {
        result: Result<Vec<serde_json::Value>, String>,
    },
    Channels {
        channel: Option<String>,
        result: Result<Vec<serde_json::Value>, String>,
    },
    Live(Result<Vec<serde_json::Value>, String>),
    Subs(Result<Vec<serde_json::Value>, String>),
    /// Subtitle text for `path`, already written to a local temp file the
    /// player adopted, or the error that prevented it.
    Subtitle {
        path: String,
        local: Option<String>,
        error: Option<String>,
    },
    /// Transcription submit outcome. On success the worker has already
    /// started a monitor for the task and hands its receiver to the UI.
    Transcribe {
        result: Result<(String, std::sync::mpsc::Receiver<WsEvent>), String>,
    },
}

/// Spawn the panel's worker thread: it owns every blocking HTTP call so the
/// UI thread never waits on the network.
pub fn spawn_worker(
    url: String,
    key: String,
    rx: std::sync::mpsc::Receiver<WsRequest>,
    tx: std::sync::mpsc::Sender<WsReply>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let client = WhisperSubs::new(url, key);
        while let Ok(request) = rx.recv() {
            let reply = match request {
                WsRequest::Library => WsReply::Library {
                    result: client.library(),
                },
                WsRequest::Channels { channel } => WsReply::Channels {
                    channel: channel.clone(),
                    result: match channel {
                        Some(name) => client.channel_videos(&name),
                        None => client.channels(),
                    },
                },
                WsRequest::Live => WsReply::Live(client.live_tasks()),
                WsRequest::Subs => WsReply::Subs(client.subtitle_list()),
                WsRequest::Subtitle { path } => {
                    let outcome = client.subtitle_text(&path);
                    WsReply::Subtitle {
                        error: outcome.as_ref().err().cloned(),
                        local: outcome.ok().and_then(|text| {
                            let local = std::env::temp_dir().join(format!(
                                "livelink-ws-{}.srt",
                                urlencoding::encode(&path)
                            ));
                            std::fs::write(&local, text)
                                .ok()
                                .map(|()| local.to_string_lossy().to_string())
                        }),
                        path,
                    }
                }
                WsRequest::Transcribe {
                    source,
                    engine,
                    language,
                    vad,
                    diarization,
                } => WsReply::Transcribe {
                    result: client
                        .start_transcription(
                            &source,
                            "large-v3",
                            &engine,
                            language.as_deref(),
                            vad,
                            diarization,
                        )
                        .map(|task_id| {
                            let (tx, rx) = std::sync::mpsc::channel();
                            monitor_task(client.clone(), task_id.clone(), tx);
                            (task_id, rx)
                        }),
                },
            };
            if tx.send(reply).is_err() {
                return; // UI is gone
            }
        }
    })
}

/// Poll a transcription task in the background, streaming the growing
/// subtitle file into `tx` until the task completes or fails. Errors
/// after the first poll are surfaced as Failed rather than killing the
/// monitor silently.
pub fn monitor_task(client: WhisperSubs, task_id: String, tx: std::sync::mpsc::Sender<WsEvent>) {
    std::thread::spawn(move || {
        let mut seen_any = false;
        let mut last_sent: Option<String> = None;
        loop {
            std::thread::sleep(Duration::from_secs(3));
            match client.task_status(&task_id) {
                Ok((status, progress)) => {
                    let line = if progress.is_empty() {
                        status.clone()
                    } else {
                        format!("{status} · {progress}")
                    };
                    if tx.send(WsEvent::Status(line)).is_err() {
                        return;
                    }
                    match client.task_subtitles(&task_id) {
                        Ok(Some(text)) => {
                            // The file exists as soon as the run starts but
                            // stays empty for a while; only forward content
                            // that actually changed.
                            if text.is_empty() || last_sent.as_deref() == Some(text.as_str()) {
                                // nothing new
                            } else {
                                seen_any = true;
                                last_sent = Some(text.clone());
                                if tx.send(WsEvent::Srt(text)).is_err() {
                                    return;
                                }
                            }
                        }
                        Ok(None) => {}
                        Err(e) => {
                            // subtitles may legitimately lag status; only
                            // report when nothing ever arrived
                            if !seen_any && tx.send(WsEvent::Status(format!("subs: {e}"))).is_err()
                            {
                                return;
                            }
                        }
                    }
                    if status == "completed" {
                        let _ = tx.send(WsEvent::Completed);
                        return;
                    }
                    if status == "failed" {
                        let _ = tx.send(WsEvent::Failed(status));
                        return;
                    }
                }
                Err(e) => {
                    let _ = tx.send(WsEvent::Failed(e));
                    return;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> WhisperSubs {
        WhisperSubs::new("http://ws.test/", " key1 ")
    }

    #[test]
    fn base_is_trimmed() {
        let client = ws();
        assert_eq!(client.base, "http://ws.test");
        assert_eq!(client.key, "key1");
    }

    #[test]
    fn resolve_encodes_query_values_and_path_segments() {
        let url = resolve("http://ws.test", "/api/v1/subs/file?path=chan/My Video [x].srt");
        assert_eq!(
            url,
            "http://ws.test/api/v1/subs/file?path=chan%2FMy%20Video%20%5Bx%5D.srt"
        );
    }

    #[test]
    fn resolve_encodes_path_only_links() {
        let url = resolve("http://ws.test", "api/v1/media file.mp4");
        assert_eq!(url, "http://ws.test/api/v1/media%20file.mp4");
    }

    #[test]
    fn resolve_handles_empty() {
        assert_eq!(resolve("http://ws.test", "/"), "http://ws.test");
    }
}
