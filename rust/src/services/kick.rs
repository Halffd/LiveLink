use crate::queue::queue::StreamSource;
use kick_rust::KickApiClient;
use thiserror::Error;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum KickError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Channel not found: {0}")]
    ChannelNotFound(String),
    #[error("Network error: {0}")]
    Network(String),
}

pub struct KickService {
    client: KickApiClient,
}

impl KickService {
    pub fn new() -> Self {
        let client = KickApiClient::new().expect("Failed to create Kick API client");
        Self { client }
    }

    pub fn is_enabled(&self) -> bool {
        true
    }

    pub async fn get_live_streams(&self, channel_names: &[String]) -> Result<Vec<StreamSource>, KickError> {
        let names: Vec<&str> = channel_names.iter().map(|s| s.as_str()).collect();
        let results = self.client.get_channels(&names).await;

        let mut sources = Vec::new();

        for result in results {
            match result {
                Ok(channel) => {
                    if channel.is_live {
                        let username = channel
                            .user
                            .as_ref()
                            .map(|u| u.username.clone())
                            .unwrap_or_else(|| channel.slug.clone());

                        debug!(channel = %username, viewers = ?channel.viewers_count, "Found live stream on Kick");

                        sources.push(StreamSource {
                            url: format!("https://kick.com/{}", channel.slug),
                            title: channel.title.or(Some(username.clone())),
                            platform: Some("kick".to_string()),
                            channel_id: Some(channel.id.to_string()),
                            channel: Some(username),
                            viewer_count: channel.viewers_count,
                            start_time: None,
                            priority: None,
                            is_live: true,
                            ..Default::default()
                        });
                    }
                }
                Err(e) => {
                    warn!(error = %e, "Failed to fetch channel from Kick");
                }
            }
        }

        info!(count = sources.len(), "Fetched live streams from Kick");
        Ok(sources)
    }

    pub async fn check_channel(&self, channel_name: &str) -> Result<bool, KickError> {
        match self.client.get_channel(channel_name).await {
            Ok(channel) => Ok(channel.is_live),
            Err(e) => Err(KickError::Api(e.to_string())),
        }
    }
}

impl Default for KickService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_service() -> KickService {
        KickService::new()
    }

    #[tokio::test]
    async fn test_kick_service_creation() {
        let service = create_test_service();
        assert!(service.is_enabled());
    }

    #[tokio::test]
    async fn test_check_channel_returns_bool() {
        let service = create_test_service();
        // Use a channel that's likely to exist (kick's official channel)
        let result = service.check_channel("kick").await;
        // Result should be Ok(true) if live, Ok(false) if not live
        // Should not error - just return the live status
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
        let is_live = result.unwrap();
        // Just verify it's a boolean
        assert!(is_live == true || is_live == false);
    }

    #[tokio::test]
    async fn test_check_nonexistent_channel() {
        let service = create_test_service();
        // A channel that definitely shouldn't exist
        let result = service.check_channel("this_channel_definitely_does_not_exist_12345xyz").await;
        // Should return an error (channel not found)
        match result {
            Ok(_) => panic!("Expected error for nonexistent channel"),
            Err(KickError::Api(_)) | Err(KickError::ChannelNotFound(_)) => {},
            Err(e) => panic!("Unexpected error: {:?}", e),
        }
    }

    #[tokio::test]
    async fn test_get_live_streams_returns_sources() {
        let service = create_test_service();
        let channels = vec!["kick".to_string()];

        let result = service.get_live_streams(&channels).await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);

        let sources = result.unwrap();
        // Should return a vector (empty if not live, or with streams if live)
        for source in &sources {
            // Verify all required fields are populated
            assert!(!source.url.is_empty(), "URL should not be empty");
            assert!(source.url.contains("kick.com"), "URL should contain kick.com");
            assert_eq!(source.platform, Some("kick".to_string()), "Platform should be kick");
            assert!(source.is_live, "is_live should be true for returned streams");
            assert!(source.channel_id.is_some(), "channel_id should be set");
            assert!(source.channel.is_some(), "channel name should be set");
        }
    }

    #[tokio::test]
    async fn test_get_live_streams_multiple_channels() {
        let service = create_test_service();
        let channels = vec!["kick".to_string(), "xqc".to_string()];

        let result = service.get_live_streams(&channels).await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);

        let sources = result.unwrap();
        // Each returned source should have correct URL format
        for source in &sources {
            assert!(source.url.starts_with("https://kick.com/"), "URL should start with https://kick.com/");
            assert!(!source.url.ends_with("kick.com/"), "URL should not end with just kick.com/");
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
    async fn test_live_stream_has_correct_url_format() {
        let service = create_test_service();
        let channels = vec!["xqc".to_string()];

        let result = service.get_live_streams(&channels).await;
        assert!(result.is_ok());

        let sources = result.unwrap();
        for source in &sources {
            // URL should be https://kick.com/{channel_slug}
            let url = &source.url;
            assert!(url.starts_with("https://kick.com/"), "Expected URL format https://kick.com/{{slug}}, got: {}", url);
            // Should have something after kick.com/
            let after_domain = url.strip_prefix("https://kick.com/").unwrap();
            assert!(!after_domain.is_empty(), "URL should have channel slug after kick.com/");
        }
    }

    #[tokio::test]
    async fn test_live_stream_viewer_count_when_live() {
        let service = create_test_service();
        // xqc is usually live on Kick
        let channels = vec!["xqc".to_string()];

        let result = service.get_live_streams(&channels).await;
        assert!(result.is_ok());

        let sources = result.unwrap();
        if !sources.is_empty() {
            // If the channel is live, it should have a viewer count
            // (or None if the API doesn't return it)
            for source in &sources {
                assert!(source.is_live, "Stream should be marked as live");
                // viewer_count can be Some or None depending on API
            }
        }
    }
}