use crate::core::state::StreamState;
use tracing::{debug, error, info};

use super::Orchestrator;

impl Orchestrator {
    pub(crate) async fn recover_on_network_restore(&self) {
        info!("Network restored - checking screens for recovery");

        let screens: Vec<u32> = self.state.iter().map(|r| r.screen).collect();
        for screen in screens {
            self.attempt_screen_recovery(screen).await;
        }
    }

    pub(crate) async fn attempt_screen_recovery(&self, screen: u32) {
        let lock = match self.locks.get(&screen) {
            Some(l) => l.value().clone(),
            None => return,
        };

        let _guard = lock.lock().await;

        let screen_state = match self.state.get(&screen) {
            Some(s) => s,
            None => return,
        };

        match screen_state.state {
            StreamState::Idle | StreamState::Error => {
                debug!(screen, state = %screen_state.state, "Screen needs recovery");
            }
            StreamState::Playing | StreamState::Starting | StreamState::Stopping => {
                debug!(screen, state = %screen_state.state, "Screen does not need recovery");
                return;
            }
        }

        if screen_state.stream.is_none() {
            debug!(screen, "No stream info to recover");
            return;
        }

        drop(screen_state);

        let active_count = self.count_active_streams_internal();
        if active_count >= self.max_streams {
            info!(screen, active_count, max = self.max_streams, "Cannot recover - max streams reached");
            return;
        }

        let stream_info = self.state.get(&screen).and_then(|s| s.stream.clone());

        if let Some(info) = stream_info {
            info!(screen, url = %info.url, "Recovering stream");

            let player = self.player.clone();
            let player_screen = screen;
            let player_instance = 0;
            let url = info.url.clone();

            tokio::spawn(async move {
                let player_guard = player.lock().await;
                match player_guard.start(player_screen, player_instance, &url, 1280, 720, 0, 0).await {
                    Ok(_) => info!(screen, url = %url, "Stream recovered successfully"),
                    Err(e) => error!(screen, url = %url, error = %e, "Failed to recover stream"),
                }
            });

            let mut state = self.state.get_mut(&screen).unwrap();
            state.state = StreamState::Starting;
            if let Some(ref mut stream) = state.stream {
                stream.start_time = Some(std::time::Instant::now());
            }
        }
    }
}