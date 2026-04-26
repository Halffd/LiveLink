use crate::core::state::StreamState;

use super::Orchestrator;

impl Orchestrator {
    pub async fn get_state(&self, screen: u32) -> Option<StreamState> {
        self.state.get(&screen).map(|s| s.state)
    }

    pub fn count_active_streams(&self) -> usize {
        self.count_active_streams_internal()
    }

    pub(crate) fn count_active_streams_internal(&self) -> usize {
        self.state
            .iter()
            .filter(|s| s.state == StreamState::Playing || s.state == StreamState::Starting)
            .count()
    }

    pub fn poll_player_exits(&self) {
        let player = self.player.clone();
        tokio::spawn(async move {
            let player_guard = player.lock().await;
            player_guard.poll_exits();
        });
    }
}