use crate::core::state::{Platform, ScreenState, StreamInfo, StreamState};
use crate::queue::queue::StreamSource;
use tracing::{info, warn};

use super::{Orchestrator, StreamChangeKind};

/// How an embedded (in-process) stream ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbeddedEndKind {
    /// Reached end of file
    Eof,
    /// Stopped by user request
    Stop,
    /// Playback failed
    Error,
}

impl Orchestrator {
    /// Take the next stream from the screen queue for embedded (in-process)
    /// playback. Marks the screen as Starting; call `mark_embedded_playing`
    /// once the player reports the file loaded.
    pub async fn take_next_stream(&self, screen: u32) -> Result<StreamSource, String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        // URLs currently playing/starting on other screens are excluded
        let active_urls: std::collections::HashSet<String> = {
            let mut state = self.state.lock().await;
            state
                .entry(screen)
                .or_insert_with(|| ScreenState::new(screen));
            state
                .values()
                .filter(|s| s.screen != screen)
                .filter(|s| matches!(s.state, StreamState::Playing | StreamState::Starting))
                .filter_map(|s| s.stream.as_ref().map(|i| i.url.clone()))
                .collect()
        };

        let stream_source = {
            let mut queue = self.queue.lock().await;
            queue.dequeue_next_excluding(screen, &active_urls)
        }
        .ok_or_else(|| format!("No stream in queue for screen {}", screen))?;

        let platform = match stream_source.platform.as_deref() {
            Some("twitch") => Platform::Twitch,
            Some("youtube") => Platform::YouTube,
            Some("kick") => Platform::Kick,
            Some("niconico") => Platform::Niconico,
            Some("bilibili") => Platform::Bilibili,
            _ => Platform::Holodex,
        };

        let info = StreamInfo {
            url: stream_source.url.clone(),
            title: stream_source.title.clone(),
            platform,
            screen,
            quality: "best".to_string(),
            volume: 50,
            start_time: Some(std::time::Instant::now()),
        };

        {
            let mut state = self.state.lock().await;
            if let Some(s) = state.get_mut(&screen) {
                s.start_stream(info);
            }
        }

        self.emit_stream_change(screen, &stream_source.url, StreamChangeKind::Started);

        info!(screen, url = %stream_source.url, "Embedded stream starting");
        Ok(stream_source)
    }

    /// Mark the embedded stream as playing (file loaded).
    pub async fn mark_embedded_playing(&self, screen: u32) {
        let mut state = self.state.lock().await;
        if let Some(s) = state.get_mut(&screen) {
            if s.state == StreamState::Starting {
                s.mark_playing();
                info!(screen, "Embedded stream playing");
            }
        }
    }

    /// Handle the end of embedded playback. `kind` decides watched/error
    /// bookkeeping, mirroring the subprocess exit handling.
    pub async fn embedded_stream_ended(
        &self,
        screen: u32,
        url: String,
        playback_time: f64,
        kind: EmbeddedEndKind,
    ) {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let runtime = playback_time as u64;
        {
            let mut state = self.state.lock().await;
            let Some(screen_state) = state.get_mut(&screen) else {
                return;
            };
            if !matches!(screen_state.state, StreamState::Playing | StreamState::Starting) {
                return; // already handled (e.g. duplicate end event)
            }
            match kind {
                EmbeddedEndKind::Eof | EmbeddedEndKind::Stop => {
                    screen_state.finish_stop();
                }
                EmbeddedEndKind::Error => {
                    if playback_time < self.config.skip_threshold_seconds as f64 {
                        // members-only or otherwise unplayable: skip and move on
                        screen_state.finish_stop();
                    } else if playback_time < self.config.crash_threshold_seconds as f64 {
                        screen_state.mark_error(format!("Crash after {}s", runtime));
                        warn!(screen, runtime, "Embedded stream crashed");
                        return; // no watched marking on crash
                    } else {
                        screen_state.finish_stop();
                    }
                }
            }
        }

        if !url.is_empty() {
            let mut queue = self.queue.lock().await;
            queue.mark_stream_watched(screen, &StreamSource { url, ..Default::default() });
        }
        info!(screen, ?kind, runtime, "Embedded stream ended");
    }
}
