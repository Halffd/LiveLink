use crate::queue::queue::StreamSource;
use tracing::info;

use super::Orchestrator;

impl Orchestrator {
    pub async fn set_queue(&self, screen: u32, sources: Vec<StreamSource>) {
        let mut queue = self.queue.lock().await;
        queue.set_queue(screen, sources);
    }

    pub async fn clear_watched(&self, screen: u32) {
        let mut queue = self.queue.lock().await;
        queue.clear_watched(screen);
        info!(screen, "Cleared watched history for screen");
    }

    pub async fn clear_all_watched(&self) {
        let mut queue = self.queue.lock().await;
        queue.clear_all_watched();
        info!("Cleared all watched history");
    }

    pub async fn cleanup_expired_watched(&self, max_age_hours: i64) -> usize {
        let max_age_seconds = max_age_hours * 3600;
        let mut queue = self.queue.lock().await;
        let removed = queue.cleanup_expired_watched(max_age_seconds);
        if removed > 0 {
            info!(count = removed, "Cleaned up expired watched entries");
        }
        removed
    }
}