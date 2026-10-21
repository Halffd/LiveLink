//! cueloop: the queue-and-captions daemon core.
//!
//! Three parts, deliberately separable:
//!
//! - [`queue`] - what plays next (FIFO with pinned entries).
//! - [`cache`] - captions on disk, keyed by content hash (SQLite).
//! - [`sources`] - handlers that turn queue entries into playable urls.
//!
//! [`server`] exposes them over one socket so any client (the egui
//! player, a script, another monitor) drives the same state.

pub mod cache;
pub mod queue;
pub mod server;
pub mod sources;
