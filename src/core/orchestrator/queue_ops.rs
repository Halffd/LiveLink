use crate::queue::queue::{Queue, StreamSource};
use tracing::info;

use super::Orchestrator;

#[allow(dead_code)]
impl Orchestrator {
    pub async fn set_queue(&self, screen: u32, sources: Vec<StreamSource>) {
        let mut queue_service = self.queue.lock().await;
        let mut q = Queue::with_sources(sources);
        
        // Apply screen's sorting configuration if available
        if let Some(screen_config) = self.config.screens.iter().find(|s| s.screen == screen) {
            if let Some(sorting) = &screen_config.sorting {
                q.apply_sorting(sorting);
            }
        } else {
            q.sort_by_priority();
        }
        
        queue_service.queues.insert(screen, q);
    }

    pub async fn push_stream(&self, screen: u32, source: StreamSource) {
        let url = source.url.clone();
        let mut queue_service = self.queue.lock().await;
        if let Some(queue) = queue_service.queues.get_mut(&screen) {
            queue.push(source);
            info!(screen, url = %url, "Pushed stream to queue");
        } else {
            // Create new queue with the source if it doesn't exist
            let mut q = Queue::new();
            q.push(source);
            queue_service.queues.insert(screen, q);
            info!(screen, url = %url, "Created new queue and pushed stream");
        }
    }

    pub async fn clear_watched(&self, screen: u32) {
        let mut queue = self.queue.lock().await;
        if let Some(q) = queue.queues.get_mut(&screen) {
            q.clear_watched();
            info!(screen, "Cleared watched history for screen");
        }
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