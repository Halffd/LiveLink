use crate::config::FavoriteChannels;
use serde::{Deserialize, Serialize};
use std::fmt;
use tracing::debug;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StreamState {
    Idle,
    Starting,
    Playing,
    Stopping,
    Error,
}

impl fmt::Display for StreamState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StreamState::Idle => write!(f, "Idle"),
            StreamState::Starting => write!(f, "Starting"),
            StreamState::Playing => write!(f, "Playing"),
            StreamState::Stopping => write!(f, "Stopping"),
            StreamState::Error => write!(f, "Error"),
        }
    }
}

impl StreamState {
    pub fn can_start(&self) -> bool {
        matches!(self, StreamState::Idle)
    }

    pub fn can_stop(&self) -> bool {
        matches!(self, StreamState::Playing | StreamState::Starting)
    }

    pub fn valid_transition_to(&self, new_state: StreamState) -> bool {
        match (self, new_state) {
            (StreamState::Idle, StreamState::Starting) => true,
            (StreamState::Starting, StreamState::Playing) => true,
            (StreamState::Starting, StreamState::Idle) => true,
            (StreamState::Starting, StreamState::Error) => true,
            (StreamState::Playing, StreamState::Stopping) => true,
            (StreamState::Playing, StreamState::Idle) => true,
            (StreamState::Playing, StreamState::Error) => true,
            (StreamState::Stopping, StreamState::Idle) => true,
            (StreamState::Stopping, StreamState::Error) => true,
            (StreamState::Error, StreamState::Idle) => true,
            (StreamState::Error, StreamState::Starting) => true,
            _ => false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamInfo {
    pub url: String,
    pub title: Option<String>,
    pub platform: Platform,
    pub screen: u32,
    pub quality: String,
    pub volume: u32,
    #[serde(skip)]
    pub start_time: Option<std::time::Instant>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    Twitch,
    YouTube,
    Holodex,
    Kick,
}

impl fmt::Display for Platform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Platform::Twitch => write!(f, "Twitch"),
            Platform::YouTube => write!(f, "YouTube"),
            Platform::Holodex => write!(f, "Holodex"),
            Platform::Kick => write!(f, "Kick"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScreenState {
    pub screen: u32,
    pub state: StreamState,
    pub stream: Option<StreamInfo>,
    pub error_count: u32,
    pub last_error: Option<String>,
    pub enabled: bool,
}

impl ScreenState {
    pub fn new(screen: u32) -> Self {
        Self {
            screen,
            state: StreamState::Idle,
            stream: None,
            error_count: 0,
            last_error: None,
            enabled: true,
        }
    }

    pub fn transition_to(&mut self, new_state: StreamState) -> bool {
        if !self.state.valid_transition_to(new_state) {
            debug!(
                screen = self.screen,
                from = %self.state,
                to = %new_state,
                "Invalid state transition"
            );
            return false;
        }

        debug!(
            screen = self.screen,
            from = %self.state,
            to = %new_state,
            "State transition"
        );

        self.state = new_state;
        true
    }

    pub fn start_stream(&mut self, info: StreamInfo) -> bool {
        if self.state != StreamState::Idle {
            debug!(
                screen = self.screen,
                current_state = %self.state,
                "Cannot start stream - not idle"
            );
            return false;
        }

        self.stream = Some(info);
        self.state = StreamState::Starting;
        self.error_count = 0;
        self.last_error = None;
        true
    }

    pub fn stop_stream(&mut self) -> bool {
        if !self.state.can_stop() {
            debug!(
                screen = self.screen,
                current_state = %self.state,
                "Cannot stop stream"
            );
            return false;
        }

        self.state = StreamState::Stopping;
        true
    }

    pub fn finish_stop(&mut self) {
        self.state = StreamState::Idle;
        self.stream = None;
    }

    pub fn mark_playing(&mut self) {
        self.state = StreamState::Playing;
    }

    pub fn mark_error(&mut self, error: String) {
        self.state = StreamState::Error;
        self.error_count += 1;
        self.last_error = Some(error);
    }

    pub fn reset_error(&mut self) {
        self.state = StreamState::Idle;
        self.error_count = 0;
        self.last_error = None;
    }
}

#[derive(Debug, Clone, Default)]
pub struct OrchestratorConfig {
    pub max_streams: usize,
    pub startup_cooldown_ms: u64,
    pub crash_threshold_seconds: u64,
    pub favorite_channels: FavoriteChannels,
    pub holodex_api_key: String,
    pub twitch_client_id: String,
    pub twitch_client_secret: String,
    pub youtube_api_key: String,
    pub mpv_ipc_dir: String,
    pub mpv_gpu_context: String,
    pub mpv_priority: String,
    pub mpv_extra_args: Vec<String>,
    pub streamlink_path: String,
    pub streamlink_options: std::collections::HashMap<String, serde_json::Value>,
    pub vlc_path: String,
    pub player_type: String,
}

