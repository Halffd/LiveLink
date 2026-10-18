//! Live end-to-end check of the whisper-subs client: start a real
//! transcription, watch the growing subtitle file, then hand the final
//! SRT to mpv (sub-add) and confirm mpv exposes the cue (sub-text).
//!
//! Skipped unless WHISPER_SUBS_URL is set.

use std::process::Command;
use std::time::{Duration, Instant};

use livelink::player_ui::whisper_subs::{monitor_task, WhisperSubs, WsEvent};

#[test]
fn live_transcription_streams_subs_and_mpv_accepts_them() {
    let Ok(base) = std::env::var("WHISPER_SUBS_URL") else {
        println!("skipped: WHISPER_SUBS_URL unset");
        return;
    };
    let key = std::env::var("WHISPER_SUBS_KEY").unwrap_or_default();
    let source = std::env::var("WHISPER_SUBS_SOURCE")
        .unwrap_or_else(|_| "/tmp/opencode/jfk.flac".to_string());
    let client = WhisperSubs::new(base, key);

    println!("browse: library={:?} channels={:?} live={:?} subs={:?}",
        client.library().map(|v| v.len()),
        client.channels().map(|v| v.len()),
        client.live_tasks().map(|v| v.len()),
        client.subtitle_list().map(|v| v.len()),
    );

    let task_id = client.start_transcription(&source, "tiny").expect("start");
    println!("task started: {task_id}");

    let (tx, rx) = std::sync::mpsc::channel();
    monitor_task(client.clone(), task_id.clone(), tx);

    let mut updates = 0usize;
    let mut final_srt = String::new();
    let mut last_len = 0usize;
    let start = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(WsEvent::Status(s)) => println!("status: {s}"),
            Ok(WsEvent::Srt(text)) => {
                updates += 1;
                println!("srt update #{updates}: {} bytes", text.len());
                assert!(
                    text.len() >= last_len && !text.trim().is_empty(),
                    "srt shrank ({last_len} -> {}) or was empty",
                    text.len()
                );
                last_len = text.len();
                final_srt = text;
            }
            Ok(WsEvent::Completed) => {
                println!("completed after {:?}", start.elapsed());
                break;
            }
            Ok(WsEvent::Failed(e)) => panic!("transcription failed: {e}"),
            Err(e) => panic!("monitor stalled: {e}"),
        }
    }
    assert!(updates > 0, "no streaming srt updates observed");
    println!("--- final srt ---\n{final_srt}\n---");

    // Feed the finished SRT to mpv and prove the cue is actually rendered:
    // --term-playing-msg prints ${sub-text} for every displayed line.
    let path = std::env::temp_dir().join("livelink-ws-live-check.srt");
    std::fs::write(&path, &final_srt).expect("write srt");
    let out = Command::new("mpv")
        .args([
            "--no-config",
            "--vo=null",
            "--ao=null",
            "--speed=100",
            "--length=12",
            "--term-playing-msg=SUB:${sub-text}",
            &format!("--sub-file={}", path.display()),
            "/tmp/opencode/jfk.flac",
        ])
        .output()
        .expect("mpv run");
    let text = String::from_utf8_lossy(&out.stdout);
    println!("mpv sub-text output:\n{text}");
    assert!(out.status.success(), "mpv failed: {text}");
    assert!(
        text.contains("ask not what your country can do for you"),
        "mpv never displayed the subtitle cue"
    );
    println!("mpv displayed the cue from the streamed srt");
}
