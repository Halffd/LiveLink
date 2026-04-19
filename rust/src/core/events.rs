use serde::{Deserialize, Serialize};
use crate::core::state::{Platform, StreamState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamStartedEvent {
    pub screen: u32,
    pub url: String,
    pub platform: Platform,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEndedEvent {
    pub screen: u32,
    pub url: String,
    pub reason: StreamEndReason,
    pub playback_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamEndReason {
    ManualStop,
    NaturalEnd,
    Crash { exit_code: Option<i32> },
    NetworkError,
    MaxRetriesExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamErrorEvent {
    pub screen: u32,
    pub url: String,
    pub error: String,
    pub recoverable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateChangedEvent {
    pub screen: u32,
    pub old_state: StreamState,
    pub new_state: StreamState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueEmptyEvent {
    pub screen: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkOfflineEvent;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkOnlineEvent;