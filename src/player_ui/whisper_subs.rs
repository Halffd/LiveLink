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

    /// Start a transcription task for `source` (URL or server-visible
    /// path), returning the task id.
    pub fn start_transcription(&self, source: &str, model: &str) -> Result<String, String> {
        let client = Self::client()?;
        let resp = client
            .post(format!("{}/transcribe", self.base))
            .header("X-API-Key", &self.key)
            .json(&serde_json::json!({
                "source": source,
                "model_name": model,
                "run_mpv": false,
            }))
            .send()
            .map_err(|e| format!("server unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("server: {}", resp.status()));
        }
        let decoded: serde_json::Value = resp.json().map_err(|e| format!("bad response: {e}"))?;
        decoded["task_id"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "server returned no task id".to_string())
    }

    /// Poll one task: (status, progress-line). status is one of the
    /// server's pending|processing|completed|failed.
    pub fn task_status(&self, task_id: &str) -> Result<(String, String), String> {
        let decoded = self.get_json(&format!("/tasks/{task_id}"))?;
        let status = decoded["status"].as_str().unwrap_or_default().to_string();
        let progress = decoded["progress"].as_str().unwrap_or_default().to_string();
        Ok((status, progress))
    }

    /// The SRT content for a task as it exists right now (grows while the
    /// task runs). None while the server has not registered the subtitle
    /// path yet.
    pub fn task_subtitles(&self, task_id: &str) -> Result<Option<String>, String> {
        let client = Self::client()?;
        let resp = client
            .get(format!("{}/api/v1/tasks/{task_id}/subtitles", self.base))
            .header("X-API-Key", &self.key)
            .send()
            .map_err(|e| format!("server unreachable: {e}"))?;
        if resp.status().as_str() == "404 Not Found" || resp.status() == 404 {
            return Ok(None);
        }
        if !resp.status().is_success() {
            return Err(format!("server: {}", resp.status()));
        }
        Ok(Some(resp.text().map_err(|e| format!("read: {e}"))?))
    }

    /// Library entries: {title, channel, has_video, has_audio, urls{...},
    /// source_url} for every finished transcription.
    pub fn library(&self) -> Result<Vec<serde_json::Value>, String> {
        let decoded = self.get_json("/api/v1/library")?;
        Ok(list_of(&decoded, "library"))
    }

    /// Channel list: {name, transcribed, unfinished}.
    pub fn channels(&self) -> Result<Vec<serde_json::Value>, String> {
        let decoded = self.get_json("/api/v1/channels")?;
        Ok(list_of(&decoded, "channels"))
    }

    /// Merged video list for one channel.
    pub fn channel_videos(&self, channel: &str) -> Result<Vec<serde_json::Value>, String> {
        let encoded = urlencoding::encode(channel).to_string();
        let decoded = self.get_json(&format!("/api/v1/channels/{encoded}/videos"))?;
        Ok(list_of(&decoded, "videos"))
    }

    /// Live/running transcription tasks.
    pub fn live_tasks(&self) -> Result<Vec<serde_json::Value>, String> {
        let decoded = self.get_json("/api/v1/live")?;
        Ok(list_of(
            &decoded,
            if decoded
                .get("live")
                .is_some() { "live" } else { "tasks" },
        ))
    }

    /// Every subtitle file the server kept (the subtitle directory).
    pub fn subtitle_list(&self) -> Result<Vec<serde_json::Value>, String> {
        let decoded = self.get_json("/subtitles/list")?;
        decoded
            .as_array()
            .cloned()
            .ok_or_else(|| "unexpected /subtitles/list shape".to_string())
    }

    /// Fetch one subtitle file's content by its server-relative path.
    pub fn subtitle_text(&self, path: &str) -> Result<String, String> {
        let client = Self::client()?;
        let resp = client
            .get(format!("{}/subtitles/{}", self.base, encode_path(path)))
            .header("X-API-Key", &self.key)
            .send()
            .map_err(|e| format!("server unreachable: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("server: {}", resp.status()));
        }
        resp.text().map_err(|e| format!("read: {e}"))
    }

    /// Absolute, properly encoded URL for a server-relative link
    /// ("/api/v1/subs/file?path=chan/Video.srt") — the server emits raw
    /// path values in query strings and titles contain spaces/brackets.
    pub fn resolve(&self, rel: &str) -> String {
        let trimmed = rel.trim_start_matches('/');
        if trimmed.is_empty() {
            return self.base.clone();
        }
        match trimmed.split_once('?') {
            None => format!("{}/{}", self.base, encode_path(trimmed)),
            Some((path, query)) => {
                let mut params = Vec::new();
                for pair in query.split('&') {
                    if let Some((k, v)) = pair.split_once('=') {
                        params.push(format!(
                            "{}={}",
                            urlencoding::encode(k),
                            urlencoding::encode(v)
                        ));
                    }
                }
                format!("{}/{}?{}", self.base, encode_path(path), params.join("&"))
            }
        }
    }
}

fn list_of(value: &serde_json::Value, key: &str) -> Vec<serde_json::Value> {
    value[key].as_array().cloned().unwrap_or_default()
}

/// Encode a server-relative *path* segment-wise (slashes are separators,
/// spaces and brackets must be encoded).
fn encode_path(path: &str) -> String {
    path.split('/')
        .map(|seg| urlencoding::encode(seg).to_string())
        .collect::<Vec<_>>()
        .join("/")
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
        let client = ws();
        let url = client.resolve("/api/v1/subs/file?path=chan/My Video [x].srt");
        assert_eq!(
            url,
            "http://ws.test/api/v1/subs/file?path=chan%2FMy%20Video%20%5Bx%5D.srt"
        );
    }

    #[test]
    fn resolve_encodes_path_only_links() {
        let url = ws().resolve("api/v1/media file.mp4");
        assert_eq!(url, "http://ws.test/api/v1/media%20file.mp4");
    }

    #[test]
    fn resolve_handles_empty() {
        assert_eq!(ws().resolve("/"), "http://ws.test");
    }
}
