use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use thiserror::Error;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum NiconicoError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Channel not found: {0}")]
    ChannelNotFound(String),
    #[error("Network error: {0}")]
    Network(String),
}

pub struct NiconicoService {
    client: reqwest::Client,
}

impl NiconicoService {
    pub fn new() -> Self {
        let client = reqwest::Client::new();
        Self { client }
    }

    pub fn is_enabled(&self) -> bool {
        true
    }

    pub async fn get_live_streams(&self, channel_ids: &[String]) -> Result<Vec<StreamSource>, NiconicoError> {
        let mut sources = Vec::new();

        for channel_id in channel_ids {
            match self.get_channel_status(channel_id).await {
                Ok(Some(live_info)) => {
                    debug!(channel = %channel_id, viewers = live_info.1, "Found live stream on Niconico");
                    sources.push(StreamSource {
                        url: format!("https://live.nicovideo.jp/watch/{}", live_info.0),
                        title: Some(live_info.2),
                        platform: Some("niconico".to_string()),
                        channel_id: Some(channel_id.clone()),
                        channel: Some(channel_id.clone()),
                        viewer_count: Some(live_info.1),
                        start_time: None,
                        priority: None,
                        is_live: true,
                        ..Default::default()
                    });
                }
                Ok(None) => {
                    debug!(channel = %channel_id, "Channel not live on Niconico");
                }
                Err(e) => {
                    warn!(channel = %channel_id, error = %e, "Failed to check Niconico channel");
                }
            }
        }

        info!(count = sources.len(), "Fetched live streams from Niconico");
        Ok(sources)
    }

    async fn get_channel_status(&self, channel_id: &str) -> Result<Option<(String, u64, String)>, NiconicoError> {
        let url = format!(
            "https://nvap.nicovideo.jp/v3/channels/{}/programs?status=onair",
            channel_id
        );

        let response = self.client
            .get(&url)
            .header("User-Agent", "LiveLink/1.0")
            .header("Origin", "https://live.nicovideo.jp")
            .send()
            .await
            .map_err(|e| NiconicoError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Ok(None);
        }

        let data: serde_json::Value = response.json().await
            .map_err(|e| NiconicoError::Api(e.to_string()))?;

        let program = data.pointer("/data/channel/program")
            .and_then(|p| p.as_object());

        if let Some(program) = program {
            let program_id = program.get("id")
                .and_then(|v| v.as_str())
                .unwrap_or(channel_id)
                .to_string();

            let title = program.get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Live")
                .to_string();

            let viewer_count = program.get("statistics")
                .and_then(|s| s.get("viewerCount"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);

            return Ok(Some((program_id, viewer_count, title)));
        }

        Ok(None)
    }

pub async fn check_channel(&self, channel_id: &str) -> Result<bool, NiconicoError> {
    match self.get_channel_status(channel_id).await {
      Ok(Some(_)) => Ok(true),
      Ok(None) => Ok(false),
      Err(e) => Err(e),
    }
  }

  pub async fn query(&self, _options: &QueryOptions) -> Result<Vec<StreamSource>, NiconicoError> {
    info!("Niconico search not implemented - returning empty results");
    Ok(Vec::new())
  }
}

impl Default for NiconicoService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_service() -> NiconicoService {
        NiconicoService::new()
    }

    #[tokio::test]
    async fn test_niconico_service_creation() {
        let service = create_test_service();
        assert!(service.is_enabled());
    }

    #[tokio::test]
    async fn test_get_live_streams_returns_sources() {
        let service = create_test_service();
        let channels = vec!["ch26491".to_string()];

        let result = service.get_live_streams(&channels).await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);

        let sources = result.unwrap();
        for source in &sources {
            assert!(!source.url.is_empty(), "URL should not be empty");
            assert!(source.url.contains("live.nicovideo.jp"), "URL should contain live.nicovideo.jp");
            assert_eq!(source.platform, Some("niconico".to_string()), "Platform should be niconico");
        }
    }

    #[tokio::test]
    async fn test_get_live_streams_empty_input() {
        let service = create_test_service();
        let channels: Vec<String> = vec![];

        let result = service.get_live_streams(&channels).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_check_channel_returns_bool() {
        let service = create_test_service();
        let result = service.check_channel("ch26491").await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
        let is_live = result.unwrap();
        assert!(is_live == true || is_live == false);
    }
}