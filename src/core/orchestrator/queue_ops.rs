use crate::queue::queue::{Queue, StreamSource};
use tracing::{debug, info, warn};

use super::Orchestrator;
use std::collections::{HashMap, HashSet};

#[allow(dead_code)]
impl Orchestrator {
    pub async fn set_queue(&self, screen: u32, sources: Vec<StreamSource>) {
        let mut queue_service = self.queue.lock().await;
        
        // Deduplicate: filter out streams already assigned to other screens
        let mut assigned_urls: std::collections::HashSet<String> = std::collections::HashSet::new();
        for (other_screen, other_queue) in &queue_service.queues {
            if *other_screen != screen {
                for source in other_queue.sources() {
                    assigned_urls.insert(source.url.clone());
                }
            }
        }
        
        let filtered_sources: Vec<StreamSource> = sources.into_iter()
            .filter(|s| !assigned_urls.contains(&s.url))
            .collect();
        
        let mut q = Queue::with_sources(filtered_sources);
        
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

    /// Fetch streams for all screens and distribute uniquely (no duplicates across screens)
    pub async fn populate_all_screens(&self, screen_configs: &[crate::config::ScreenConfig]) -> Result<(), String> {
        let mut assigned_urls: HashSet<String> = HashSet::new();
        
        // Process screens in config order (first screen gets first pick)
        for screen_config in screen_configs {
            if !screen_config.enabled || !screen_config.auto_start {
                continue;
            }
            
            // Fetch streams for this screen (already filtered by its sources config)
            let streams = self.fetch_streams_for_screen(screen_config.screen).await;
            
            // Filter out already assigned streams
            let filtered: Vec<StreamSource> = streams.into_iter()
                .filter(|s| !assigned_urls.contains(&s.url))
                .collect();
            
            let filtered_count = filtered.len();
            
            // Mark these URLs as assigned
            for s in &filtered {
                assigned_urls.insert(s.url.clone());
            }
            
            if filtered_count > 0 {
                let mut queue_service = self.queue.lock().await;
                let mut q = Queue::with_sources(filtered);
                
                // Apply screen's sorting configuration
                if let Some(sorting) = &screen_config.sorting {
                    q.apply_sorting(sorting);
                } else {
                    q.sort_by_priority();
                }
                
                queue_service.queues.insert(screen_config.screen, q);
                info!(screen = screen_config.screen, count = filtered_count, "Queue populated uniquely");
            } else {
                warn!(screen = screen_config.screen, "No unique streams available after deduplication");
            }
        }
        
        Ok(())
    }

    pub async fn push_stream(&self, screen: u32, source: StreamSource) {
        let url = source.url.clone();
        let mut queue_service = self.queue.lock().await;
        
        // Check if stream already exists in any screen
        let mut exists = false;
        for queue in queue_service.queues.values() {
            if queue.sources().iter().any(|s| s.url == url) {
                exists = true;
                break;
            }
        }
        
        if exists {
            info!(screen, url = %url, "Stream already assigned to another screen, skipping");
            return;
        }
        
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