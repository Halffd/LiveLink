//! Channel-surfing operations: next/prev channel, direct channel selection,
//! and moving a stream between screens (swapping when the target is busy).

use crate::core::state::{StreamInfo, StreamState};
use crate::queue::queue::StreamSource;
use serde::Serialize;
use tracing::info;

use super::Orchestrator;

/// How many past channels per screen `prev_channel` remembers.
const HISTORY_LIMIT: usize = 32;

/// What a screen is currently showing, for API and UI surfaces.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelStatus {
    pub url: String,
    pub title: Option<String>,
    pub platform: String,
    pub playing: bool,
}

impl Orchestrator {
    /// The channel a screen is currently on, if any.
    pub async fn current_channel(&self, screen: u32) -> Option<ChannelStatus> {
        let guard = self.state.lock().await;
        let state = guard.get(&screen)?;
        let info = state.stream.as_ref()?;
        Some(ChannelStatus {
            url: info.url.clone(),
            title: info.title.clone(),
            platform: info.platform.to_string(),
            playing: state.state == StreamState::Playing,
        })
    }
    /// The stream currently playing (or starting) on a screen, as a source.
    async fn current_source(&self, screen: u32) -> Option<StreamSource> {
        let guard = self.state.lock().await;
        let state = guard.get(&screen)?;
        if !matches!(state.state, StreamState::Playing | StreamState::Starting) {
            return None;
        }
        let info: &StreamInfo = state.stream.as_ref()?;
        Some(source_from_info(info))
    }

    fn push_history(&self, screen: u32, source: StreamSource) {
        let mut history = self.channel_history.entry(screen).or_default();
        history.push(source);
        let excess = history.len().saturating_sub(HISTORY_LIMIT);
        if excess > 0 {
            history.drain(0..excess);
        }
    }

    /// Active URLs on other screens (used when dequeueing the next channel).
    async fn active_urls_excluding(&self, screen: u32) -> std::collections::HashSet<String> {
        let guard = self.state.lock().await;
        guard
            .values()
            .filter(|s| s.screen != screen)
            .filter(|s| matches!(s.state, StreamState::Playing | StreamState::Starting))
            .filter_map(|s| s.stream.as_ref().map(|i| i.url.clone()))
            .collect()
    }

    /// Skip to the next channel: the current one is marked watched and
    /// remembered for `prev_channel`.
    pub async fn next_channel(&self, screen: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let current = self.current_source(screen).await;
        let _ = self.stop_stream_locked(screen).await;
        if let Some(cur) = current {
            self.push_history(screen, cur);
        }

        let active_urls = self.active_urls_excluding(screen).await;
        let source = {
            let mut queue = self.queue.lock().await;
            queue.dequeue_next_excluding(screen, &active_urls)
        }
        .ok_or_else(|| format!("No next channel in queue for screen {}", screen))?;

        self.start_stream_with_source(screen, source).await?;
        info!(screen, "Skipped to next channel");
        Ok(())
    }

    /// Go back to the previously watched channel on this screen.
    pub async fn prev_channel(&self, screen: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let source = {
            let mut history = self.channel_history.entry(screen).or_default();
            history.pop()
        }
        .ok_or_else(|| format!("No previous channel on screen {}", screen))?;

        let current = self.current_source(screen).await;
        let _ = self.stop_stream_locked(screen).await;
        if let Some(cur) = current {
            self.push_history(screen, cur);
        }

        self.start_stream_with_source(screen, source).await?;
        info!(screen, "Went back to previous channel");
        Ok(())
    }

    /// Switch a screen to a specific queue entry by URL (channel picker).
    pub async fn play_channel(&self, screen: u32, url: &str) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let source = {
            let mut queues = self.queue.lock().await;
            let queue = queues
                .get_queue_mut(screen)
                .ok_or_else(|| format!("Screen {} not found", screen))?;
            let mut sources = queue.sources().to_vec();
            let index = sources
                .iter()
                .position(|s| s.url == url)
                .ok_or_else(|| format!("Channel {} not in queue for screen {}", url, screen))?;
            let source = sources.remove(index);
            *queue = crate::queue::queue::Queue::with_sources(sources);
            source
        };

        let current = self.current_source(screen).await;
        let _ = self.stop_stream_locked(screen).await;
        if let Some(cur) = current {
            self.push_history(screen, cur);
        }

        self.start_stream_with_source(screen, source).await?;
        info!(screen, url, "Switched to channel");
        Ok(())
    }

    /// Move the current stream of `from` to `to`. When `to` is busy the two
    /// screens swap streams; when it is idle `from` just goes dark.
    pub async fn move_stream(&self, from: u32, to: u32) -> Result<(), String> {
        if from == to {
            return Err("Cannot move a stream to the same screen".to_string());
        }

        // Lock both screens in a fixed order so concurrent moves cannot
        // deadlock.
        let lock_low = self.get_or_create_lock(from.min(to)).await;
        let lock_high = self.get_or_create_lock(from.max(to)).await;
        let _guard_low = lock_low.lock().await;
        let _guard_high = lock_high.lock().await;

        let from_source = self
            .current_source(from)
            .await
            .ok_or_else(|| format!("Nothing playing on screen {}", from))?;
        let to_source = self.current_source(to).await;

        let _ = self.stop_stream_locked(from).await;
        let _ = self.stop_stream_locked(to).await;

        // Remember each moved stream on its old screen for prev-channel.
        self.push_history(from, from_source.clone());
        if let Some(to_old) = &to_source {
            self.push_history(to, to_old.clone());
        }

        self.start_stream_with_source(to, from_source).await?;
        if let Some(to_old) = to_source {
            self.start_stream_with_source(from, to_old).await?;
            info!(from, to, "Swapped streams between screens");
        } else {
            info!(from, to, "Moved stream to idle screen");
        }
        Ok(())
    }
}

fn source_from_info(info: &StreamInfo) -> StreamSource {
    StreamSource {
        url: info.url.clone(),
        title: info.title.clone(),
        platform: Some(info.platform.to_string()),
        is_live: true,
        ..Default::default()
    }
}
