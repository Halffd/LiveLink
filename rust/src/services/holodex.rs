use crate::queue::queue::StreamSource;
use futures::TryStreamExt;
use holodex::model::{builders::VideoFilterBuilder, VideoStatus, VideoType};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryOptions {
    pub search: Option<String>,
    pub category: Option<String>,
    pub tag: Option<String>,
    pub video_type: Option<String>,
    pub status: Option<String>,
    pub limit: Option<u32>,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            search: None,
            category: None,
            tag: None,
            video_type: Some("stream".to_string()),
            status: Some("live".to_string()),
            limit: Some(25),
        }
    }
}

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

    pub async fn query(&self, options: &QueryOptions) -> Result<Vec<StreamSource>, HolodexError> {
        let client_guard = self.client.read().await;
        let client = client_guard
            .as_ref()
            .ok_or_else(|| HolodexError::Config("Holodex client not initialized".into()))?;

        let mut builder = VideoFilterBuilder::new();

        if let Some(status_str) = &options.status {
            let status = match status_str.to_lowercase().as_str() {
                "live" => VideoStatus::Live,
                "upcoming" => VideoStatus::Upcoming,
                "past" => VideoStatus::Past,
                _ => VideoStatus::Live,
            };
            builder = builder.status(&[status]);
        } else {
            builder = builder.status(&[VideoStatus::Live]);
        }

        if let Some(vtype) = &options.video_type {
            let vtype = match vtype.to_lowercase().as_str() {
                "stream" => VideoType::Stream,
                "clip" => VideoType::Clip,
                _ => VideoType::Stream,
            };
            builder = builder.video_type(vtype);
        }

        if let Some(ref _category) = options.category {
        }

        if let Some(limit) = options.limit {
            builder = builder.limit(limit);
        }

        let filter = builder.build();
        let video_stream = client.video_stream(&filter);

        let videos: Vec<holodex::model::Video> = video_stream
            .try_collect()
            .await
            .map_err(|e| HolodexError::Network(e.to_string()))?;

        let search_lower = options.search.as_ref().map(|s| s.to_lowercase());
        let tag_lower = options.tag.as_ref().map(|t| t.to_lowercase());

        let sources: Vec<StreamSource> = videos
            .into_iter()
            .filter(|video| {
                if let Some(ref search) = search_lower {
                    if !video.title.to_lowercase().contains(search) {
                        return false;
                    }
                }
                if let Some(ref _tag) = tag_lower {
                    return true;
                }
                true
            })
            .map(|video| {
                let url = format!("https://www.youtube.com/watch?v={}", video.id);
                let is_live = video.status == VideoStatus::Live;

                debug!(channel_id = %video.channel.id(), title = %video.title, "Found video");

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
                    is_live,
                    ..Default::default()
                }
            })
            .collect();

        info!(count = sources.len(), "Queried videos from Holodex");
        Ok(sources)
    }
}

impl Default for HolodexService {
    fn default() -> Self {
        Self::new(String::new())
    }
}
