use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use chrono::{DateTime, Utc};
use thiserror::Error;
use tracing::{debug, info, warn};

const YOUTUBE_API_QUOTA_MAX: u32 = 10_000;
const YOUTUBE_API_COST_PER_CALL: u32 = 100;

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
    /// Remaining API quota units
    quota_remaining: u32,
    /// Last quota reset timestamp (midnight UTC)
    last_reset: DateTime<Utc>,
}

impl YouTubeService {
    pub fn new(developer_key: String) -> Self {
        let is_enabled = !developer_key.is_empty();
        if !is_enabled {
            warn!("YouTube developer key not provided, service will use RSS fallback");
        }

        Self {
            developer_key,
            http_client: reqwest::Client::new(),
            quota_remaining: YOUTUBE_API_QUOTA_MAX,
            last_reset: Utc::now(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.developer_key.is_empty()
    }

    /// Check if we have API quota remaining
    fn has_quota_remaining(&mut self) -> bool {
        self.maybe_reset_quota();
        self.quota_remaining >= YOUTUBE_API_COST_PER_CALL
    }

    /// Reset quota if it's a new day (midnight UTC)
    fn maybe_reset_quota(&mut self) {
        let now = Utc::now();
        let last_reset_date = self.last_reset.date_naive();

        if now.date_naive() > last_reset_date {
            self.quota_remaining = YOUTUBE_API_QUOTA_MAX;
            self.last_reset = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
            info!("YouTube API quota reset for new day");
        }
    }

    /// Consume quota for an API call
    fn consume_quota(&mut self) {
        self.maybe_reset_quota();
        if self.quota_remaining >= YOUTUBE_API_COST_PER_CALL {
            self.quota_remaining -= YOUTUBE_API_COST_PER_CALL;
        }
    }

    /// Get current quota status for debugging
    pub fn quota_status(&self) -> (u32, u32) {
        (self.quota_remaining, YOUTUBE_API_QUOTA_MAX)
    }

    /// Check if a single channel is live via RSS feed
    /// This is the fallback when API quota is exhausted or unavailable
    pub async fn check_via_rss(&self, channel_id: &str) -> Result<bool, YouTubeError> {
        let url = format!(
            "https://www.youtube.com/feeds/videos.xml?channel_id={}",
            channel_id
        );

        let response = self
            .http_client
            .get(&url)
            .send()
            .await
            .map_err(|e| YouTubeError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Err(YouTubeError::Api(format!(
                "RSS request failed: {}",
                response.status()
            )));
        }

        let body = response
            .text()
            .await
            .map_err(|e| YouTubeError::Network(e.to_string()))?;

        // In RSS feeds:
        // - Live streams have <yt:state value="live">
        // - Past broadcasts have <yt:recordedOn>
        // - Regular videos don't have either
        let is_live = body.contains("yt:state") && body.contains("value=\"live\"");

        debug!(
            channel_id = %channel_id,
            is_live = is_live,
            "Checked channel via RSS"
        );

        Ok(is_live)
    }

    /// Check multiple channels via RSS (batch version)
    pub async fn check_multiple_via_rss(
        &self,
        channel_ids: &[String],
    ) -> Result<Vec<StreamSource>, YouTubeError> {
        let mut sources = Vec::new();

        for channel_id in channel_ids {
            match self.check_via_rss(channel_id).await {
                Ok(is_live) => {
                    if is_live {
                        sources.push(StreamSource {
                            url: format!("https://www.youtube.com/channel/{}", channel_id),
                            title: None,
                            platform: Some("youtube".to_string()),
                            channel_id: Some(channel_id.clone()),
                            channel: None,
                            viewer_count: None,
                            start_time: None,
                            priority: None,
                            is_live: true,
                            ..Default::default()
                        });
                    }
                }
                Err(e) => {
                    warn!(channel_id = %channel_id, error = %e, "Failed to check channel via RSS");
                }
            }
        }

        info!(count = sources.len(), "Fetched live streams from YouTube RSS");
        Ok(sources)
    }

    /// Get live streams via YouTube Data API v3
    /// Note: YouTube's Search.list with channelId only accepts ONE channel at a time
    async fn check_via_api(&mut self, channel_id: &str) -> Result<Vec<StreamSource>, YouTubeError> {
        let url = format!(
            "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&channelId={}&key={}",
            channel_id,
            self.developer_key
        );

        let response = self
            .http_client
            .get(&url)
            .send()
            .await
            .map_err(|e| YouTubeError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Err(YouTubeError::Api(format!(
                "YouTube API error: {}",
                response.status()
            )));
        }

        self.consume_quota();

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

        let api_response: YouTubeApiResponse = response
            .json()
            .await
            .map_err(|e| YouTubeError::Api(e.to_string()))?;

        let sources: Vec<StreamSource> = api_response
            .items
            .into_iter()
            .map(|item| {
                let url = format!("https://www.youtube.com/watch?v={}", item.id.video_id);
                debug!(
                    channel = %item.snippet.channel_title,
                    title = %item.snippet.title,
                    "Found YouTube live stream via API"
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

        Ok(sources)
    }

    /// Hybrid method: Try API first, fall back to RSS if quota exhausted or API fails
    pub async fn get_live_streams(&mut self, channel_ids: &[String]) -> Result<Vec<StreamSource>, YouTubeError> {
        // If no API key, use RSS directly
        if !self.is_enabled() {
            debug!("No YouTube API key, using RSS fallback");
            return self.check_multiple_via_rss(channel_ids).await;
        }

        // If we have quota, try API first
        if self.has_quota_remaining() {
            let mut all_streams = Vec::new();

            // API requires one channel at a time, so we iterate
            for channel_id in channel_ids {
                match self.check_via_api(channel_id).await {
                    Ok(streams) => {
                        all_streams.extend(streams);
                    }
                    Err(e) => {
                        warn!(channel_id = %channel_id, error = %e, "API call failed, trying RSS");
                        // Fall back to RSS for this specific channel
                        match self.check_via_rss(channel_id).await {
                            Ok(is_live) => {
                                if is_live {
                                    all_streams.push(StreamSource {
                                        url: format!("https://www.youtube.com/channel/{}", channel_id),
                                        title: None,
                                        platform: Some("youtube".to_string()),
                                        channel_id: Some(channel_id.clone()),
                                        channel: None,
                                        viewer_count: None,
                                        start_time: None,
                                        priority: None,
                                        is_live: true,
                                        ..Default::default()
                                    });
                                }
                            }
                            Err(rss_err) => {
                                warn!(channel_id = %channel_id, error = %rss_err, "RSS check also failed");
                            }
                        }
                    }
                }
            }

            if !all_streams.is_empty() {
                let (remaining, max) = self.quota_status();
                info!(count = all_streams.len(), quota_remaining = remaining, quota_max = max, "Fetched live streams from YouTube API");
                return Ok(all_streams);
            }
        }

// Quota exhausted or API failed entirely → use RSS for everything
    debug!(
      quota_remaining = %self.quota_remaining,
      "API quota exhausted, falling back to RSS"
    );
    self.check_multiple_via_rss(channel_ids).await
  }

  pub async fn query(&mut self, options: &QueryOptions) -> Result<Vec<StreamSource>, YouTubeError> {
    let search_query = options.search.as_deref().unwrap_or("");
    let limit = options.limit.unwrap_or(25) as usize;

    if !self.is_enabled() || !self.has_quota_remaining() {
      return Err(YouTubeError::Config("YouTube API not available".into()));
    }

    let url = format!(
      "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q={}&eventType=live&maxResults={}&key={}",
      urlencoding::encode(search_query),
      limit.min(50),
      self.developer_key
    );

    let response = self.http_client
      .get(&url)
      .send()
      .await
      .map_err(|e| YouTubeError::Network(e.to_string()))?;

    if !response.status().is_success() {
      return Err(YouTubeError::Api(format!("Search failed: {}", response.status())));
    }

    #[derive(serde::Deserialize)]
    struct YouTubeSearchResponse {
      items: Vec<YouTubeSearchItem>,
    }

    #[derive(serde::Deserialize)]
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
      channel_title: String,
      channel_id: String,
      title: String,
      description: Option<String>,
    }

    let search_response: YouTubeSearchResponse = response
      .json()
      .await
      .map_err(|e| YouTubeError::Api(e.to_string()))?;

    let sources: Vec<StreamSource> = search_response
      .items
      .iter()
      .map(|item| {
        let url = format!("https://www.youtube.com/watch?v={}", item.id.video_id);
        StreamSource {
          url,
          title: Some(item.snippet.title.clone()),
          platform: Some("youtube".to_string()),
          channel_id: Some(item.snippet.channel_id.clone()),
          channel: Some(item.snippet.channel_title.clone()),
          viewer_count: None,
          start_time: None,
          priority: None,
          is_live: true,
          ..Default::default()
        }
      })
      .collect();

    info!(count = sources.len(), "Searched streams from YouTube");
    Ok(sources)
  }
}

impl Default for YouTubeService {
    fn default() -> Self {
        Self::new(String::new())
    }
}