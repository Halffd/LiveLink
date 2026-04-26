use crate::core::state::{Platform, StreamInfo, StreamState};
use crate::queue::queue::StreamSource;
use crate::services::player::ProcessExit;
use tracing::{debug, error, info, warn};

use super::Orchestrator;

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

        drop(screen_state);

        let player = self.player.clone();
        let player_screen = screen;
        let player_instance = 0;
        let url_clone = url.clone();

        tokio::spawn(async move {
            let mut player_guard = player.lock().await;
            if let Err(e) = player_guard.start(player_screen, player_instance, &url_clone, 1280, 720, 0, 0).await {
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
            let mut player_guard = player.lock().await;
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

    pub async fn handle_process_exit(&self, exit: ProcessExit) {
        let screen = exit.screen;
        let lock = match self.locks.get(&screen) {
            Some(l) => l.value().clone(),
            None => {
                warn!(screen, "Process exit but no lock, ignoring");
                return;
            }
        };

        let _guard = lock.lock().await;

        let mut screen_state = match self.state.get_mut(&screen) {
            Some(s) => s,
            None => {
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

        if runtime < self.config.crash_threshold_seconds {
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
                    url: url_for_queue,
                    ..Default::default()
                });
            }

            info!(screen, url = %url, runtime, "Stream ended normally");
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
            let mut player_guard = player.lock().await;
            if let Err(e) = player_guard.start(screen, instance_id, &url_for_spawn, 1280, 720, 0, 0).await {
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
            let mut player_guard = player.lock().await;
            if let Err(e) = player_guard.stop(screen, instance_id).await {
                warn!(screen, instance_id, error = %e, "Failed to stop instance");
            }
        });

        info!(screen, instance_id, "Stream instance stopped");
        Ok(())
    }
}