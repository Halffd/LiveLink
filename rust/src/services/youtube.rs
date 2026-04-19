use crate::queue::queue::StreamSource;
use thiserror::Error;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum YouTubeError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Configuration error: {0}")]
    Config(String),
    #[error("Network error: {0}")]
    Network(String),
}

pub struct YouTubeService {
    developer_key: String,
    http_client: reqwest::Client,
}

impl YouTubeService {
    pub fn new(developer_key: String) -> Self {
        let is_enabled = !developer_key.is_empty();
        if !is_enabled {
            warn!("YouTube developer key not provided, service will be disabled");
        }

        Self {
            developer_key,
            http_client: reqwest::Client::new(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.developer_key.is_empty()
    }

    pub async fn get_live_streams(&self, channel_ids: &[String]) -> Result<Vec<StreamSource>, YouTubeError> {
        if !self.is_enabled() {
            return Err(YouTubeError::Config("YouTube service not enabled".into()));
        }

        let ids_param = channel_ids.join(",");
        let url = format!(
            "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&channelId={}&key={}",
            ids_param, self.developer_key
        );

        let response = self
            .http_client
            .get(&url)
            .send()
            .await
            .map_err(|e| YouTubeError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Err(YouTubeError::Api(format!("YouTube API error: {}", response.status())));
        }

        #[derive(serde::Deserialize)]
        struct YouTubeApiResponse {
            items: Vec<YouTubeSearchItem>,
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct YouTubeSearchItem {
            id: YouTubeVideoId,
            snippet: YouTubeSnippet,
        }

        #[derive(serde::Deserialize)]
        struct YouTubeVideoId {
            video_id: String,
        }

        #[derive(serde::Deserialize)]
        struct YouTubeSnippet {
            title: String,
            channel_title: String,
            channel_id: String,
            #[serde(rename = "publishedAt")]
            published_at: String,
        }

        let api_response: YouTubeApiResponse =
            response.json().await.map_err(|e| YouTubeError::Api(e.to_string()))?;

        let sources: Vec<StreamSource> = api_response
            .items
            .into_iter()
            .map(|item| {
                let url = format!("https://www.youtube.com/watch?v={}", item.id.video_id);
                debug!(
                    channel = %item.snippet.channel_title,
                    title = %item.snippet.title,
                    "Found YouTube live stream"
                );

                StreamSource {
                    url,
                    title: Some(item.snippet.title),
                    platform: Some("youtube".to_string()),
                    channel_id: Some(item.snippet.channel_id),
                    channel: Some(item.snippet.channel_title),
                    viewer_count: None,
                    start_time: None,
                    priority: None,
                    is_live: true,
                    ..Default::default()
                }
            })
            .collect();

        info!(count = sources.len(), "Fetched live streams from YouTube API");
        Ok(sources)
    }
}

impl Default for YouTubeService {
    fn default() -> Self {
        Self::new(String::new())
    }
}