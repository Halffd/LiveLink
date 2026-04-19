use crate::queue::queue::StreamSource;
use futures::TryStreamExt;
use holodex::model::{builders::VideoFilterBuilder, VideoStatus, VideoType};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum HolodexError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Configuration error: {0}")]
    Config(String),
    #[error("Network error: {0}")]
    Network(String),
}

#[derive(Clone)]
pub struct HolodexService {
    client: Arc<RwLock<Option<holodex::Client>>>,
    api_key: String,
}

impl HolodexService {
    pub fn new(api_key: String) -> Self {
        let client = if api_key.is_empty() {
            warn!("Holodex API key not provided, service will be disabled");
            None
        } else {
            match holodex::Client::new(&api_key) {
                Ok(c) => {
                    info!("Holodex client initialized");
                    Some(c)
                }
                Err(e) => {
                    warn!("Failed to create Holodex client: {}", e);
                    None
                }
            }
        };

        Self {
            client: Arc::new(RwLock::new(client)),
            api_key,
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.api_key.is_empty()
    }

    pub async fn get_live_streams(&self) -> Result<Vec<StreamSource>, HolodexError> {
        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| HolodexError::Config("Holodex client not initialized".into()))?;

        let filter = VideoFilterBuilder::default()
            .status(&[VideoStatus::Live])
            .video_type(VideoType::Stream)
            .build();

        let video_stream = client.video_stream(&filter);

        let videos: Vec<holodex::model::Video> = video_stream
            .try_collect()
            .await
            .map_err(|e| HolodexError::Network(e.to_string()))?;

        let sources: Vec<StreamSource> = videos
            .into_iter()
            .map(|video| {
                let url = format!("https://www.youtube.com/watch?v={}", video.id);

                debug!(channel_id = %video.channel.id(), title = %video.title, "Found live stream");

                let live_info = video.live_info;
                let viewer_count = live_info.live_viewers.map(|v| v as u64);
                let start_time = live_info
                    .start_scheduled
                    .map(|s| s.timestamp() as i64);

                StreamSource {
                    url,
                    title: Some(video.title),
                    platform: Some("youtube".to_string()),
                    channel_id: Some(video.channel.id().to_string()),
                    channel: None,
                    viewer_count,
                    start_time,
                    priority: None,
                    is_live: true,
                    ..Default::default()
                }
            })
            .collect();

        info!(count = sources.len(), "Fetched live streams from Holodex");
        Ok(sources)
    }
}

impl Default for HolodexService {
    fn default() -> Self {
        Self::new(String::new())
    }
}
