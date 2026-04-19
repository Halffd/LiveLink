use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
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
    watched_keys: HashSet<String>,
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
            watched_keys: HashSet::new(),
        }
    }

    pub fn with_sources(sources: Vec<StreamSource>) -> Self {
        Self {
            sources,
            watched_keys: HashSet::new(),
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
        if let Some(ref channel_id) = source.channel_id {
            if let Some(ref platform) = source.platform {
                self.watched_keys.insert(format!("{}:{}", platform, channel_id));
            }
        }
        self.watched_keys.insert(source.url.clone());
        debug!(url = %source.url, "Marked stream as watched");
    }

    pub fn is_watched(&self, source: &StreamSource) -> bool {
        if let Some(ref channel_id) = source.channel_id {
            if let Some(ref platform) = source.platform {
                if self.watched_keys.contains(&format!("{}:{}", platform, channel_id)) {
                    return true;
                }
            }
        }
        self.watched_keys.contains(&source.url)
    }

    pub fn get_filtered_unwatched(&self) -> Vec<&StreamSource> {
        self.sources
            .iter()
            .filter(|s| !self.is_watched(s))
            .collect()
    }

    pub fn sort_by_priority(&mut self) {
        self.sources.sort_by(|a, b| {
            let a_pri = a.priority.unwrap_or(i32::MAX);
            let b_pri = b.priority.unwrap_or(i32::MAX);
            a_pri.cmp(&b_pri)
        });
    }
}

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
}

impl Default for QueueService {
    fn default() -> Self {
        Self::new()
    }
}