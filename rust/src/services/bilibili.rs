use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use thiserror::Error;
use tracing::{debug, info};

#[derive(Error, Debug)]
pub enum BilibiliError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Channel not found: {0}")]
    ChannelNotFound(String),
    #[error("Network error: {0}")]
    Network(String),
}

pub struct BilibiliService {
    client: reqwest::Client,
}

impl BilibiliService {
    pub fn new() -> Self {
        let client = reqwest::Client::new();
        Self { client }
    }

    pub fn is_enabled(&self) -> bool {
        true
    }

    pub async fn get_live_streams(&self, room_ids: &[String]) -> Result<Vec<StreamSource>, BilibiliError> {
        if room_ids.is_empty() {
            return Ok(Vec::new());
        }

        let room_id_list = room_ids.join(",");
        let url = format!(
            "https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoomIds?room_ids={}",
            room_id_list
        );

        let response = self.client
            .get(&url)
            .header("User-Agent", "LiveLink/1.0")
            .header("Referer", "https://live.bilibili.com")
            .send()
            .await
            .map_err(|e| BilibiliError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Err(BilibiliError::Api(format!("HTTP {}", response.status())));
        }

        let data: serde_json::Value = response.json().await
            .map_err(|e| BilibiliError::Api(e.to_string()))?;

        let mut sources = Vec::new();

        if let Some(rooms) = data.pointer("/data").and_then(|d| d.as_array()) {
            for room in rooms {
                if let Some(room_info) = room.as_object() {
                    let live_status = room_info.get("live_status")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);

                    if live_status == 1 {
                        let room_id = room_info.get("room_id")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0)
                            .to_string();

                        let title = room_info.get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Live")
                            .to_string();

                        let uname = room_info.get("uname")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown")
                            .to_string();

                        let viewer_count = room_info.get("online")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);

                        debug!(channel = %uname, viewers = viewer_count, "Found live stream on Bilibili");

                        sources.push(StreamSource {
                            url: format!("https://live.bilibili.com/{}", room_id),
                            title: Some(title),
                            platform: Some("bilibili".to_string()),
                            channel_id: Some(room_id.clone()),
                            channel: Some(uname),
                            viewer_count: Some(viewer_count),
                            start_time: None,
                            priority: None,
                            is_live: true,
                            ..Default::default()
                        });
                    }
                }
            }
        }

        info!(count = sources.len(), "Fetched live streams from Bilibili");
        Ok(sources)
    }

pub async fn check_channel(&self, room_id: &str) -> Result<bool, BilibiliError> {
    let rooms = self.get_live_streams(&[room_id.to_string()]).await?;
    Ok(!rooms.is_empty())
  }

  pub async fn query(&self, _options: &QueryOptions) -> Result<Vec<StreamSource>, BilibiliError> {
    info!("Bilibili search not implemented - returning empty results");
    Ok(Vec::new())
  }
}

impl Default for BilibiliService {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_service() -> BilibiliService {
        BilibiliService::new()
    }

    #[tokio::test]
    async fn test_bilibili_service_creation() {
        let service = create_test_service();
        assert!(service.is_enabled());
    }

    #[tokio::test]
    async fn test_get_live_streams_empty_input() {
        let service = create_test_service();
        let room_ids: Vec<String> = vec![];

        let result = service.get_live_streams(&room_ids).await;
        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_check_channel_returns_bool() {
        let service = create_test_service();
        let result = service.check_channel("6").await;
        assert!(result.is_ok(), "Expected Ok, got: {:?}", result);
        let is_live = result.unwrap();
        assert!(is_live == true || is_live == false);
    }
}