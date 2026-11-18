//! The `.whisper-subs` HTTP surface, shared by every caller in this crate.
//!
//! Two front ends talk to the same server with the same nouns: the player
//! window panel (a UI loop that must not block) and the server-side
//! transcript worker (an async loop that attaches captions to screens over
//! the control port). They previously spelled the URLs, the `/transcribe`
//! body, and the `X-API-Key` auth independently, which let the two drift.
//!
//! Everything here is transport-free: both sync and async callers use the
//! same [`paths`], [`transcribe_body`] and [`submit_response`] helpers.

use serde::Deserialize;

/// Paths against the whisper-subs server. Every caller builds URLs here so
/// the two front ends cannot disagree.
pub mod paths {
    /// Start a transcription task.
    pub const TRANSCRIBE: &str = "/transcribe";
    /// Cancel a running task.
    pub fn task(task_id: &str) -> String {
        format!("/tasks/{task_id}")
    }
    /// Growing SRT for a task (may not exist yet).
    pub fn task_subtitles(task_id: &str) -> String {
        format!("/api/v1/tasks/{task_id}/subtitles")
    }
    /// Cancel a running task.
    pub fn task_cancel(task_id: &str) -> String {
        format!("/tasks/{task_id}/cancel")
    }
    /// Finished-transcription library.
    pub const LIBRARY: &str = "/api/v1/library";
    /// Channel list.
    pub const CHANNELS: &str = "/api/v1/channels";
    /// Videos belonging to one channel.
    pub fn channel_videos(channel: &str) -> String {
        format!("/api/v1/channels/{}/videos", encode(channel))
    }
    /// Live/running tasks.
    pub const LIVE: &str = "/api/v1/live";
    /// Subtitle directory.
    pub const SUBTITLES_LIST: &str = "/subtitles/list";
    /// One subtitle file by server-relative path.
    pub fn subtitle(path: &str) -> String {
        format!("/subtitles/{}", encode_path(path))
    }

    /// Percent-encode a value used as a single path segment.
    pub fn encode(value: &str) -> String {
        urlencoding::encode(value).to_string()
    }

    /// Encode a server-relative *path* segment-wise: slashes stay as
    /// separators while spaces and brackets are escaped.
    pub fn encode_path(path: &str) -> String {
        path.split('/')
            .map(urlencoding::encode)
            .fold(String::new(), |mut acc, seg| {
                if !acc.is_empty() {
                    acc.push('/');
                }
                acc.push_str(&seg);
                acc
            })
    }
}

/// `POST /transcribe` body. `model_name` carries the engine prefix
/// ("whisperx" or ""); VAD gates music/silence; diarization is optional.
pub fn transcribe_body(
    source: &str,
    model: &str,
    engine_prefix: &str,
    language: Option<&str>,
    vad: bool,
    diarization: bool,
) -> serde_json::Value {
    let model_name = if engine_prefix.is_empty() {
        model.to_string()
    } else {
        format!("{engine_prefix}:{model}")
    };
    serde_json::json!({
        "source": source,
        "model_name": model_name,
        "vad_filter": vad,
        "language": language,
        "diarization": diarization,
        // Never let the server spawn mpv: the caller owns playback.
        "run_mpv": false,
    })
}

/// Task id the server hands back for a submitted transcription.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskId(pub String);

/// Decode a `/transcribe` reply, naming the server's own error when present.
pub fn decode_task_id(body: &str) -> Result<TaskId, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|e| format!("bad response: {e}"))?;
    value
        .get("task_id")
        .and_then(|v| v.as_str())
        .map(|s| TaskId(s.to_string()))
        .ok_or_else(|| match value.get("error").and_then(|v| v.as_str()) {
            Some(message) => format!("server: {message}"),
            None => "server returned no task id".to_string(),
        })
}

/// Task status/progress as reported by `GET /tasks/{id}`.
#[derive(Debug, Deserialize, PartialEq, Eq)]
pub struct TaskStatus {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub progress: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcribe_body_carries_engine_prefix_and_flags() {
        let body = transcribe_body("src", "base", "whisperx", Some("ja"), true, false);
        assert_eq!(body["model_name"], "whisperx:base");
        assert_eq!(body["source"], "src");
        assert_eq!(body["language"], "ja");
        assert_eq!(body["vad_filter"], true);
        assert_eq!(body["diarization"], false);
        assert_eq!(body["run_mpv"], false);

        let plain = transcribe_body("src", "base", "", None, false, false);
        assert_eq!(plain["model_name"], "base");
        assert_eq!(plain["language"], serde_json::Value::Null);
    }

    #[test]
    fn decode_task_id_surfaces_the_server_error() {
        assert_eq!(
            decode_task_id(r#"{"error":"unsupported source"}"#).unwrap_err(),
            "server: unsupported source"
        );
        assert!(decode_task_id(r#"{"ok":true}"#).unwrap_err().contains("no task id"));
        assert!(
            !decode_task_id("not json")
                .unwrap_err()
                .is_empty()
        );
        assert_eq!(decode_task_id(r#"{"task_id":"t7"}"#).unwrap(), TaskId("t7".into()));
    }

    #[test]
    fn paths_encode_segments_and_keep_separators() {
        assert_eq!(
            paths::channel_videos("chan one"),
            "/api/v1/channels/chan%20one/videos"
        );
        assert_eq!(paths::subtitle("a b/c d.srt"), "/subtitles/a%20b/c%20d.srt");
        assert_eq!(paths::task_subtitles("t7"), "/api/v1/tasks/t7/subtitles");
        assert_eq!(paths::task("t7"), "/tasks/t7");
        assert_eq!(paths::task_cancel("t7"), "/tasks/t7/cancel");
    }
}