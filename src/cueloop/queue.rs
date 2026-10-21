//! The daemon queue: what plays next.
//!
//! Entries are produced by source handlers and consumed by the player.
//! Pinned entries jump the queue but keep their relative order; the rest
//! are FIFO. The queue knows nothing about playback - it only decides
//! ordering, so queue rules (comprehension thresholds, source filters)
//! can be layered on top without touching the player.

use crate::queue::queue::StreamSource;
use serde::{Deserialize, Serialize};

/// One queued item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueEntry {
    /// Monotonic id, unique for the lifetime of the queue.
    pub id: u64,
    /// Where the item comes from (url + platform metadata).
    pub source: StreamSource,
    /// Pinned entries play before every unpinned one.
    pub pinned: bool,
    /// Unix timestamp of the enqueue.
    pub added_at: i64,
    /// Optional content hash of the media, used to look up cached captions.
    pub content_hash: Option<String>,
    /// Target language for translation, if the user asked for one.
    pub target_language: Option<String>,
}

impl QueueEntry {
    /// The label shown in queue listings.
    pub fn label(&self) -> String {
        self.source
            .title
            .clone()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| self.source.url.clone())
    }
}

/// The queue itself: pinned items in front, then the pending FIFO.
#[derive(Debug, Default)]
pub struct QueueStore {
    pinned: Vec<QueueEntry>,
    pending: Vec<QueueEntry>,
    next_id: u64,
}

impl QueueStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an item to the end of the pending FIFO.
    pub fn enqueue(
        &mut self,
        source: StreamSource,
        content_hash: Option<String>,
        target_language: Option<String>,
        now: i64,
    ) -> QueueEntry {
        self.next_id += 1;
        let entry = QueueEntry {
            id: self.next_id,
            source,
            pinned: false,
            added_at: now,
            content_hash,
            target_language,
        };
        self.pending.push(entry.clone());
        entry
    }

    /// The item that plays next, without removing it.
    pub fn peek_next(&self) -> Option<&QueueEntry> {
        self.pinned.first().or_else(|| self.pending.first())
    }

    /// Remove and return the item that plays next.
    pub fn take_next(&mut self) -> Option<QueueEntry> {
        self.pinned
            .first()
            .cloned()
            .or_else(|| self.pending.first().cloned())
            .map(|entry| {
                self.remove_entry(entry.id);
                entry
            })
    }

    /// Pin or unpin an item.
    ///
    /// Pinning moves the entry into the pinned group, which plays before
    /// every unpinned entry. Unpinning puts it back at the end of the
    /// pending FIFO.
    pub fn set_pinned(&mut self, id: u64, pinned: bool) -> bool {
        let Some(entry) = self.find(id) else {
            return false;
        };
        let entry = entry.clone();
        self.remove_entry(id);
        let mut entry = entry;
        entry.pinned = pinned;
        if pinned {
            self.pinned.push(entry);
        } else {
            self.pending.push(entry);
        }
        true
    }

    /// Drop an item from the queue (the "skip" action).
    pub fn remove(&mut self, id: u64) -> Option<QueueEntry> {
        let entry = self.find(id)?.clone();
        self.remove_entry(id);
        Some(entry)
    }

    /// Move a pending item to a new position in the pending FIFO.
    /// Pinned items are not reorderable - unpin first.
    pub fn reorder(&mut self, id: u64, index: usize) -> bool {
        let Some(position) = self.pending.iter().position(|e| e.id == id) else {
            return false;
        };
        let entry = self.pending.remove(position);
        let target = index.min(self.pending.len());
        self.pending.insert(target, entry);
        true
    }

    /// Every entry, pinned first.
    pub fn entries(&self) -> Vec<QueueEntry> {
        let mut all = self.pinned.clone();
        all.extend(self.pending.iter().cloned());
        all
    }

    /// Number of queued items.
    pub fn len(&self) -> usize {
        self.pinned.len() + self.pending.len()
    }

    /// True when nothing is queued.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn find(&self, id: u64) -> Option<&QueueEntry> {
        self.pinned
            .iter()
            .chain(self.pending.iter())
            .find(|e| e.id == id)
    }

    fn remove_entry(&mut self, id: u64) {
        self.pinned.retain(|e| e.id != id);
        self.pending.retain(|e| e.id != id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(url: &str) -> StreamSource {
        StreamSource {
            url: url.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn enqueue_is_fifo() {
        let mut q = QueueStore::new();
        q.enqueue(source("a"), None, None, 0);
        q.enqueue(source("b"), None, None, 0);
        assert_eq!(q.peek_next().unwrap().source.url, "a");
        assert_eq!(q.take_next().unwrap().source.url, "a");
        assert_eq!(q.peek_next().unwrap().source.url, "b");
    }

    #[test]
    fn pinned_entries_jump_the_queue_but_keep_order() {
        let mut q = QueueStore::new();
        let a = q.enqueue(source("a"), None, None, 0);
        q.enqueue(source("b"), None, None, 0);
        let c = q.enqueue(source("c"), None, None, 0);
        assert!(q.set_pinned(a.id, true));
        assert_eq!(q.peek_next().unwrap().source.url, "a");
        // pinned entries keep their own order
        assert!(q.set_pinned(c.id, true));
        let urls: Vec<String> = q.entries().iter().map(|e| e.source.url.clone()).collect();
        assert_eq!(urls, vec!["a", "c", "b"]);
        // unpinning drops the entry back to the end of the pending FIFO
        assert!(q.set_pinned(a.id, false));
        assert_eq!(q.peek_next().unwrap().source.url, "c");
        assert_eq!(q.take_next().unwrap().source.url, "c");
        assert_eq!(q.peek_next().unwrap().source.url, "b");
    }

    #[test]
    fn skip_removes_the_entry() {
        let mut q = QueueStore::new();
        let a = q.enqueue(source("a"), None, None, 0);
        q.enqueue(source("b"), None, None, 0);
        assert_eq!(q.remove(a.id).unwrap().source.url, "a");
        assert_eq!(q.len(), 1);
        assert_eq!(q.take_next().unwrap().source.url, "b");
        assert!(q.is_empty());
    }

    #[test]
    fn reorder_moves_within_pending() {
        let mut q = QueueStore::new();
        let a = q.enqueue(source("a"), None, None, 0);
        let b = q.enqueue(source("b"), None, None, 0);
        q.enqueue(source("c"), None, None, 0);
        assert!(q.reorder(c_id(&q), 0));
        let _ = (a, b);
        let urls: Vec<String> = q.entries().iter().map(|e| e.source.url.clone()).collect();
        assert_eq!(urls, vec!["c", "a", "b"]);
    }

    fn c_id(q: &QueueStore) -> u64 {
        q.entries().last().unwrap().id
    }

    #[test]
    fn take_next_of_empty_queue_is_none() {
        let mut q = QueueStore::new();
        assert!(q.take_next().is_none());
        assert!(q.peek_next().is_none());
    }
}
