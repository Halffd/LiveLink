//! SRS mining: turn the current subtitle line into an Anki card via
//! AnkiConnect, with a screenshot (subs visible) and an audio clip of the line
//! encoded by a background mpv process — the Memento recipe.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Sender;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tracing::warn;

use crate::player_ui::settings::PlayerUiSettings;
use crate::player_ui::subtitle::SubtitleInfo;

static ARTIFACT_SEQ: AtomicU64 = AtomicU64::new(0);

/// Unique file name stem for mining artifacts (unique within the process even
/// when the clock resolution is coarse).
pub fn artifact_stem() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = ARTIFACT_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("livelink_{millis:x}_{seq}")
}

/// Encode the subtitle line's audio range out of `source` into `out`
/// (mp3). Uses a separate mpv process so the UI keeps playing.
fn encode_audio_clip(
    mpv_path: &str,
    source: &str,
    start: f64,
    end: f64,
    out: &Path,
) -> Result<(), String> {
    let start = start.max(0.0);
    let end = end.max(start + 0.01);
    let output = std::process::Command::new(mpv_path)
        .arg(source)
        .arg(format!("--start={start:.3}"))
        .arg(format!("--end={end:.3}"))
        .arg("--vid=no")
        .arg("--sid=no")
        .arg("--no-config")
        .arg("--really-quiet")
        .arg(format!("--o={}", out.display()))
        .arg("--of=mp3")
        .output()
        .map_err(|e| format!("failed to run {}: {e}", mpv_path))?;
    if output.status.success() && out.is_file() {
        Ok(())
    } else {
        Err(format!(
            "mpv audio clip failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// The AnkiConnect `addNote` request for a mined subtitle line.
pub fn build_note_request(
    settings: &PlayerUiSettings,
    line: &SubtitleInfo,
    source_url: &str,
    screenshot: Option<&Path>,
    audio: Option<&Path>,
) -> serde_json::Value {
    let tags: Vec<String> = settings
        .srs_tags
        .split(',')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect();

    let back = format!("{}<br>{}", source_url, format_args!("[{:.1}s]", line.start));

    let mut note = json!({
        "deckName": settings.srs_deck,
        "modelName": settings.srs_model,
        "fields": {
            "Front": line.text.replace('\n', "<br>"),
            "Back": back,
        },
        "options": {
            "allowDuplicate": false,
            "duplicateScope": "deck",
        },
        "tags": tags,
    });

    if let Some(path) = screenshot {
        note["picture"] = json!([{
            "path": path.display().to_string(),
            "filename": path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            "fields": ["Back"],
        }]);
    }
    if let Some(path) = audio {
        note["audio"] = json!([{
            "path": path.display().to_string(),
            "filename": path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            "fields": ["Back"],
        }]);
    }

    json!({
        "action": "addNote",
        "version": 6,
        "params": { "note": note },
    })
}

/// Run the whole mining job off the UI thread: encode the audio clip, then
/// send the note (with media) to AnkiConnect, and report back through `tx`.
pub fn spawn_mine(
    settings: PlayerUiSettings,
    line: SubtitleInfo,
    source_url: String,
    mpv_path: String,
    screenshot_path: PathBuf,
    tx: Sender<String>,
) {
    std::thread::spawn(move || {
        let dir = std::env::temp_dir().join("livelink-srs");
        let _ = std::fs::create_dir_all(&dir);

        let audio_path = if settings.srs_audio {
            let path = dir.join(format!("{}.mp3", artifact_stem()));
            let pad = settings.srs_audio_pad;
            match encode_audio_clip(
                &mpv_path,
                &source_url,
                line.start - pad,
                line.end + pad,
                &path,
            ) {
                Ok(()) => Some(path),
                Err(e) => {
                    warn!(error = %e, "audio clip failed; mining without audio");
                    None
                }
            }
        } else {
            None
        };

        let screenshot = if settings.srs_screenshot {
            Some(screenshot_path)
        } else {
            None
        };

        let request = build_note_request(
            &settings,
            &line,
            &source_url,
            screenshot.as_deref(),
            audio_path.as_deref(),
        );

        let result = (|| -> Result<u64, String> {
            let response = reqwest::blocking::Client::new()
                .post(&settings.srs_url)
                .json(&request)
                .timeout(std::time::Duration::from_secs(30))
                .send()
                .map_err(|e| format!("AnkiConnect unreachable: {e}"))?;
            let body: serde_json::Value = response
                .json()
                .map_err(|e| format!("AnkiConnect response unreadable: {e}"))?;
            if let Some(error) = body.get("error").and_then(|e| e.as_str()) {
                return Err(error.to_string());
            }
            body.get("result")
                .and_then(|r| r.as_u64())
                .ok_or_else(|| "AnkiConnect returned no note id".to_string())
        })();

        let message = match result {
            Ok(id) => format!("added to anki ({}) #{}", settings.srs_deck, id),
            Err(e) => format!("anki failed: {e}"),
        };
        let _ = tx.send(message);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player_ui::settings::PlayerUiSettings;

    fn line() -> SubtitleInfo {
        SubtitleInfo {
            text: "hello\nworld".to_string(),
            start: 12.0,
            end: 14.0,
        }
    }

    #[test]
    fn note_request_shape() {
        let settings = PlayerUiSettings {
            srs_deck: "Japanese".to_string(),
            srs_model: "Basic".to_string(),
            srs_tags: "livelink, tv, ".to_string(),
            ..Default::default()
        };
        let request = build_note_request(
            &settings,
            &line(),
            "https://youtube.com/watch?v=x",
            Some(Path::new("/tmp/shot.png")),
            Some(Path::new("/tmp/clip.mp3")),
        );
        assert_eq!(request["action"], "addNote");
        assert_eq!(request["version"], 6);
        let note = &request["params"]["note"];
        assert_eq!(note["deckName"], "Japanese");
        assert_eq!(note["modelName"], "Basic");
        assert_eq!(note["fields"]["Front"], "hello<br>world");
        assert_eq!(note["tags"], serde_json::json!(["livelink", "tv"]));
        assert_eq!(note["picture"][0]["path"], "/tmp/shot.png");
        assert_eq!(note["audio"][0]["fields"][0], "Back");
    }

    #[test]
    fn media_attachments_optional() {
        let settings = PlayerUiSettings::default();
        let request = build_note_request(&settings, &line(), "file", None, None);
        assert!(request["params"]["note"].get("picture").is_none());
        assert!(request["params"]["note"].get("audio").is_none());
    }

    #[test]
    fn artifact_stems_unique() {
        assert_ne!(artifact_stem(), artifact_stem());
    }
}
