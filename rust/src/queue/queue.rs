use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tracing::debug;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct StreamSource {
    pub url: String,
    pub title: Option<String>,
    pub platform: Option<String>,
    pub channel_id: Option<String>,
    pub channel: Option<String>,
    pub viewer_count: Option<u64>,
    pub start_time: Option<i64>,
    pub priority: Option<i32>,
    pub is_live: bool,
}

#[derive(Debug, Clone)]
pub struct Queue {
    sources: Vec<StreamSource>,
    watched_keys: HashMap<String, i64>,
}

impl Default for Queue {
    fn default() -> Self {
        Self::new()
    }
}

impl Queue {
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
            watched_keys: HashMap::new(),
        }
    }

    pub fn with_sources(sources: Vec<StreamSource>) -> Self {
        Self {
            sources,
            watched_keys: HashMap::new(),
        }
    }

    pub fn get_next(&self) -> Option<&StreamSource> {
        self.sources.first()
    }

    pub fn remove_next(&mut self) -> Option<StreamSource> {
        if self.sources.is_empty() {
            return None;
        }
        let source = self.sources.remove(0);
        debug!(url = %source.url, "Dequeued stream");
        Some(source)
    }

    pub fn len(&self) -> usize {
        self.sources.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sources.is_empty()
    }

    pub fn mark_watched(&mut self, source: &StreamSource) {
        let key = self.make_key(source);
        let now = chrono::Utc::now().timestamp();
        self.watched_keys.insert(key, now);
        self.watched_keys.insert(source.url.clone(), now);
        debug!(url = %source.url, "Marked stream as watched");
    }

    pub fn is_watched(&self, source: &StreamSource) -> bool {
        self.watched_keys.contains_key(&self.make_key(source))
    }

    pub fn watched_timestamp(&self, source: &StreamSource) -> Option<i64> {
        self.watched_keys.get(&self.make_key(source)).copied()
    }

    fn make_key(&self, source: &StreamSource) -> String {
        if let (Some(ref channel_id), Some(ref platform)) = (&source.channel_id, &source.platform) {
            format!("{}:{}", platform, channel_id)
        } else {
            source.url.clone()
        }
    }

    pub fn filter_unwatched(&self) -> Vec<&StreamSource> {
        self.sources.iter().filter(|s| !self.is_watched(s)).collect()
    }

    pub fn filter_by_platform(&self, platform: &str) -> Vec<&StreamSource> {
        self.sources
            .iter()
            .filter(|s| s.platform.as_deref() == Some(platform))
            .collect()
    }

    pub fn filter_by_channel(&self, channel_id: &str) -> Vec<&StreamSource> {
        self.sources
            .iter()
            .filter(|s| s.channel_id.as_deref() == Some(channel_id))
            .collect()
    }

    pub fn filter_by_viewer_count(&self, min: Option<u64>, max: Option<u64>) -> Vec<&StreamSource> {
        self.sources
            .iter()
            .filter(|s| {
                let viewers = s.viewer_count.unwrap_or(0);
                let above_min = min.map(|m| viewers >= m).unwrap_or(true);
                let below_max = max.map(|m| viewers <= m).unwrap_or(true);
                above_min && below_max
            })
            .collect()
    }

    pub fn sort_by_priority(&mut self) {
        self.sources.sort_by(|a, b| {
            let a_pri = a.priority.unwrap_or(i32::MAX);
            let b_pri = b.priority.unwrap_or(i32::MAX);
            a_pri.cmp(&b_pri)
        });
    }

    pub fn sort_by_viewer_count(&mut self, ascending: bool) {
        self.sources.sort_by(|a, b| {
            let a_views = a.viewer_count.unwrap_or(0);
            let b_views = b.viewer_count.unwrap_or(0);
            if ascending {
                a_views.cmp(&b_views)
            } else {
                b_views.cmp(&a_views)
            }
        });
    }

    pub fn sort_by_name(&mut self, ascending: bool) {
        self.sources.sort_by(|a, b| {
            let a_name = a.title.as_deref().unwrap_or("");
            let b_name = b.title.as_deref().unwrap_or("");
            if ascending {
                a_name.cmp(b_name)
            } else {
                b_name.cmp(a_name)
            }
        });
    }

    pub fn sort_by_is_live(&mut self) {
        self.sources.sort_by(|a, b| {
            b.is_live.cmp(&a.is_live)
        });
    }

    pub fn cleanup_expired_watched(&mut self, max_age_seconds: i64) -> usize {
        let now = chrono::Utc::now().timestamp();
        let before = self.watched_keys.len();
        self.watched_keys.retain(|_, timestamp| now - *timestamp < max_age_seconds);
        before - self.watched_keys.len()
    }

    pub fn clear_watched(&mut self) {
        self.watched_keys.clear();
    }

    pub fn get_watched_count(&self) -> usize {
        self.watched_keys.len()
    }

    pub fn sources(&self) -> &[StreamSource] {
        &self.sources
    }
}

#[derive(Debug, Clone)]
pub struct QueueService {
    queues: HashMap<u32, Queue>,
}

impl QueueService {
    pub fn new() -> Self {
        Self {
            queues: HashMap::new(),
        }
    }

    pub fn set_queue(&mut self, screen: u32, sources: Vec<StreamSource>) {
        let mut queue = Queue::with_sources(sources);
        queue.sort_by_priority();
        self.queues.insert(screen, queue);
    }

    pub fn get_queue(&self, screen: u32) -> Option<&Queue> {
        self.queues.get(&screen)
    }

    pub fn get_queue_mut(&mut self, screen: u32) -> Option<&mut Queue> {
        self.queues.get_mut(&screen)
    }

    pub fn get_next_stream(&self, screen: u32) -> Option<&StreamSource> {
        self.queues.get(&screen)?.get_next()
    }

    pub fn dequeue_next(&mut self, screen: u32) -> Option<StreamSource> {
        self.queues.get_mut(&screen)?.remove_next()
    }

    pub fn mark_stream_watched(&mut self, screen: u32, source: &StreamSource) {
        if let Some(queue) = self.queues.get_mut(&screen) {
            queue.mark_watched(source);
        }
    }

    pub fn is_stream_watched(&self, screen: u32, source: &StreamSource) -> bool {
        self.queues
            .get(&screen)
            .map(|q| q.is_watched(source))
            .unwrap_or(false)
    }

    pub fn is_empty(&self, screen: u32) -> bool {
        self.queues.get(&screen).map(|q| q.is_empty()).unwrap_or(true)
    }

    pub fn clear_queue(&mut self, screen: u32) {
        self.queues.remove(&screen);
    }

    pub fn clear_watched(&mut self, screen: u32) {
        if let Some(queue) = self.queues.get_mut(&screen) {
            queue.clear_watched();
        }
    }

    pub fn clear_all_watched(&mut self) {
        for queue in self.queues.values_mut() {
            queue.clear_watched();
        }
    }

    pub fn cleanup_expired_watched(&mut self, max_age_seconds: i64) -> usize {
        let mut total_removed = 0;
        for queue in self.queues.values_mut() {
            total_removed += queue.cleanup_expired_watched(max_age_seconds);
        }
        total_removed
    }

    pub fn get_all_queues(&self) -> &HashMap<u32, Queue> {
        &self.queues
    }
}

impl Default for QueueService {
    fn default() -> Self {
        Self::new()
    }
}