use std::sync::Arc;
use std::time::Duration;

use crate::core::state::{Platform, StreamInfo, StreamState};
use crate::queue::queue::StreamSource;
use crate::services::player::ProcessExit;
use tracing::{debug, error, info, warn};

use super::Orchestrator;

fn extract_youtube_video_id(url: &str) -> Option<String> {
    let patterns = [
        r"(?:youtube\.com/watch\?v=)([a-zA-Z0-9_-]{11})",
        r"(?:youtu\.be/)([a-zA-Z0-9_-]{11})",
        r"(?:youtube\.com/embed/)([a-zA-Z0-9_-]{11})",
        r"(?:youtube\.com/v/)([a-zA-Z0-9_-]{11})",
    ];
    for pattern in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(captures) = re.captures(url) {
                return captures.get(1).map(|m| m.as_str().to_string());
            }
        }
    }
    None
}

fn extract_twitch_channel(url: &str) -> Option<String> {
    let patterns = [
        r"(?:twitch\.tv/)([a-zA-Z0-9_]+)",
        r"(?:twitch\.tv/([a-zA-Z0-9_]+)\/?)",
    ];
    for pattern in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(captures) = re.captures(url) {
                return captures.get(1).map(|m| m.as_str().to_string());
            }
        }
    }
    None
}

impl Orchestrator {
    pub async fn start_stream(&self, screen: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let mut screen_state = self
            .state
            .get_mut(&screen)
            .ok_or_else(|| format!("Screen {} not found", screen))?;

        if screen_state.state != StreamState::Idle {
            return Err(format!(
                "Screen {} not idle (state: {})",
                screen, screen_state.state
            ));
        }

        let active_count = self.count_active_streams_internal();
        if active_count >= self.max_streams {
            return Err(format!(
                "Max streams ({}) reached, {} active",
                self.max_streams, active_count
            ));
        }

        let stream_source = {
            let mut queue = self.queue.lock().await;
            queue.dequeue_next(screen)
        };

        let stream_source = stream_source.ok_or_else(|| format!("No stream in queue for screen {}", screen))?;

        let platform = match stream_source.platform.as_deref() {
            Some("twitch") => Platform::Twitch,
            Some("youtube") => Platform::YouTube,
            Some("kick") => Platform::Kick,
            Some("niconico") => Platform::Niconico,
            Some("bilibili") => Platform::Bilibili,
            _ => Platform::Holodex,
        };

        let url = stream_source.url.clone();
        let stream_info = StreamInfo {
            url: url.clone(),
            title: stream_source.title.clone(),
            platform,
            screen,
            quality: "best".to_string(),
            volume: 50,
            start_time: Some(std::time::Instant::now()),
        };

        screen_state.start_stream(stream_info);

        debug!(screen, state = ?self.state.get(&screen).map(|s| s.state), "Stream state after start_stream");
        drop(screen_state);

        let player = self.player.clone();
        let player_screen = screen;
        let player_instance = 0;
        let url_clone = url.clone();

        tokio::spawn(async move {
            let player_guard = player.lock().await;
            if let Err(e) = player_guard.start(player_screen, player_instance, &url_clone).await {
                error!(screen = player_screen, error = %e, "Failed to start process");
            }
        });

        info!(screen, url = %url, "Stream starting");
        Ok(())
    }

    pub async fn stop_stream(&self, screen: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        self.stop_stream_locked(screen).await
    }

    pub async fn stop_stream_locked(&self, screen: u32) -> Result<(), String> {
        let mut screen_state = self
            .state
            .get_mut(&screen)
            .ok_or_else(|| format!("Screen {} not found", screen))?;

        if !screen_state.state.can_stop() {
            return Err(format!(
                "Screen {} cannot stop (state: {})",
                screen, screen_state.state
            ));
        }

        let url = screen_state.stream.as_ref().map(|s| s.url.clone());

        screen_state.stop_stream();

        drop(screen_state);

        let player = self.player.clone();
        tokio::spawn(async move {
            let player_guard = player.lock().await;
            if let Err(e) = player_guard.stop(screen, 0).await {
                warn!(screen, error = %e, "Failed to stop process");
            }
        });

        let mut screen_state = self.state.get_mut(&screen).unwrap();
        screen_state.finish_stop();

        if let Some(url) = url {
            let mut queue = self.queue.lock().await;
            queue.mark_stream_watched(screen, &StreamSource {
                url,
                ..Default::default()
            });
        }

        info!(screen, "Stream stopped");
        Ok(())
    }

    pub async fn handle_process_exit(self: Arc<Self>, exit: ProcessExit) {
        let screen = exit.screen;
        let lock = self.get_or_create_lock(screen).await;

        let _guard = lock.lock().await;

        let mut screen_state = match self.state.get_mut(&screen) {
            Some(s) => s,
            None => {
                debug!(screen, state_keys = ?self.state.iter().map(|r| *r.key()).collect::<Vec<_>>(), "Process exit but no screen state");
                warn!(screen, "Process exit but no screen state");
                return;
            }
        };

        if screen_state.state != StreamState::Playing && screen_state.state != StreamState::Starting {
            debug!(screen, state = %screen_state.state, "Ignoring process exit for non-active stream");
            return;
        }

        let playback_seconds = exit.playback_time as u64;
        let runtime = if playback_seconds > 0 {
            playback_seconds
        } else {
            screen_state
                .stream
                .as_ref()
                .and_then(|s| s.start_time)
                .map(|start| start.elapsed().as_secs())
                .unwrap_or(u64::MAX)
        };

        let url = screen_state.stream.as_ref().map(|s| s.url.clone()).unwrap_or_default();

        let skip_threshold = self.config.skip_threshold_seconds;
        let is_soft_skip = runtime < skip_threshold && playback_seconds < skip_threshold;

        if is_soft_skip {
            let url_for_queue = url.clone();
            screen_state.finish_stop();

            drop(screen_state);

            if !url_for_queue.is_empty() {
                let mut queue = self.queue.lock().await;
                queue.mark_stream_watched(screen, &StreamSource {
                    url: url_for_queue.clone(),
                    ..Default::default()
                });
            }

            info!(screen, url = %url, runtime, "Stream skipped (members-only or unplayable)");

            drop(_guard);

            let screen_for_start = screen;
            let orchestrator = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                if let Err(e) = orchestrator.start_stream(screen_for_start).await {
                    debug!(screen = screen_for_start, error = %e, "No more streams in queue after skip");
                }
            });
        } else if runtime < self.config.crash_threshold_seconds {
            let error_msg = if let Some(e) = exit.error {
                format!("Crash after {}s: {}", runtime, e)
            } else {
                format!("Crash after {}s (code: {:?})", runtime, exit.exit_code)
            };
            screen_state.mark_error(error_msg);
            warn!(screen, url = %url, runtime, "Stream crashed - entering error state");
        } else {
            let url_for_queue = url.clone();
            screen_state.finish_stop();

            drop(screen_state);

            if !url_for_queue.is_empty() {
                let mut queue = self.queue.lock().await;
                queue.mark_stream_watched(screen, &StreamSource {
                    url: url_for_queue.clone(),
                    ..Default::default()
                });
            }

            info!(screen, url = %url, runtime, "Stream ended normally");

            drop(_guard);

            let screen_for_start = screen;
            let orchestrator = self.clone();
            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_millis(orchestrator.config.startup_cooldown_ms)).await;
                if let Err(e) = orchestrator.start_stream(screen_for_start).await {
                    debug!(screen = screen_for_start, error = %e, "No more streams in queue after exit");
                }
            });
        }
    }

    pub async fn start_stream_on_instance(&self, screen: u32, instance_id: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let active_count = self.count_active_streams_internal();
        if active_count >= self.max_streams {
            return Err(format!("Max streams ({}) reached", self.max_streams));
        }

        let stream_source = {
            let mut queue = self.queue.lock().await;
            queue.dequeue_next(screen)
        };

        let stream_source = stream_source.ok_or_else(|| format!("No stream in queue for screen {}", screen))?;

        let url = stream_source.url.clone();
        let url_for_spawn = url.clone();

        let player = self.player.clone();
        tokio::spawn(async move {
            let player_guard = player.lock().await;
            if let Err(e) = player_guard.start(screen, instance_id, &url_for_spawn).await {
                error!(screen, instance_id, error = %e, "Failed to start instance");
            }
        });

        info!(screen, instance_id, url = %url, "Stream starting on instance");
        Ok(())
    }

    pub async fn stop_stream_instance(&self, screen: u32, instance_id: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let player = self.player.clone();
        tokio::spawn(async move {
            let player_guard = player.lock().await;
            if let Err(e) = player_guard.stop(screen, instance_id).await {
                warn!(screen, instance_id, error = %e, "Failed to stop instance");
            }
        });

        info!(screen, instance_id, "Stream instance stopped");
        Ok(())
    }

    pub fn create_stream_source_from_url(&self, url: &str) -> Option<StreamSource> {
        if url.contains("kick.com") {
            let channel = url.split('/').last().unwrap_or("unknown");
            Some(StreamSource {
                url: url.to_string(),
                title: Some(format!("Kick Stream: {}", channel)),
                platform: Some("kick".to_string()),
                channel_id: Some(channel.to_string()),
                channel: Some(channel.to_string()),
                viewer_count: Some(0),
                priority: Some(1),
                is_live: true,
                ..Default::default()
            })
        } else if url.contains("youtube.com/watch") || url.contains("youtu.be") {
            let video_id = extract_youtube_video_id(url)?;
            Some(StreamSource {
                url: url.to_string(),
                title: Some(format!("YouTube Video: {}", video_id)),
                platform: Some("youtube".to_string()),
                channel_id: Some(video_id.to_string()),
                channel: Some(video_id.to_string()),
                viewer_count: Some(0),
                priority: Some(1),
                is_live: true,
                ..Default::default()
            })
        } else if url.contains("twitch.tv") {
            let channel = extract_twitch_channel(url)?;
            Some(StreamSource {
                url: url.to_string(),
                title: Some(format!("Twitch: {}", channel)),
                platform: Some("twitch".to_string()),
                channel_id: Some(channel.to_string()),
                channel: Some(channel.to_string()),
                viewer_count: Some(0),
                priority: Some(1),
                is_live: true,
                ..Default::default()
            })
        } else {
            Some(StreamSource {
                url: url.to_string(),
                title: Some(format!("Direct Stream: {}", url)),
                platform: Some("direct".to_string()),
                channel_id: Some(url.to_string()),
                channel: Some(url.to_string()),
                viewer_count: Some(0),
                priority: Some(1),
                is_live: true,
                ..Default::default()
            })
        }
    }

    pub async fn validate_stream(&self, url: &str) -> bool {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .ok();

        if let Some(client) = client {
            match client.head(url).send().await {
                Ok(response) => {
                    if url.contains("youtube.com") || url.contains("youtu.be") {
                        return response.status().is_success() || response.status().is_redirection();
                    }
                    if url.contains("twitch.tv") {
                        return response.status().is_success();
                    }
                    return response.status().is_success();
                }
                Err(e) => {
                    debug!(url, error = %e, "Stream validation failed");
                    return false;
                }
            }
        }
        false
    }
}