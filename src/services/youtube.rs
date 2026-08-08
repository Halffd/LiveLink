use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, info, trace, warn};

const YOUTUBE_API_QUOTA_MAX: u32 = 10_000;
const YOUTUBE_API_COST_PER_CALL: u32 = 100;
const YOUTUBE_API_COST_CATEGORIES: u32 = 1;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum YouTubeError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Configuration error: {0}")]
    Config(String),
    #[error("Network error: {0}")]
    Network(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeCategory {
    pub id: String,
    pub title: String,
    pub assignable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeChannel {
    pub id: String,
    pub title: String,
    pub subscriber_count: Option<u64>,
    pub video_count: Option<u64>,
    pub view_count: Option<u64>,
    pub thumbnail_url: Option<String>,
    pub description: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub custom_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct YouTubeLiveStream {
    pub video_id: String,
    pub title: String,
    pub channel_id: String,
    pub channel_title: String,
    pub concurrent_viewers: Option<u64>,
    pub start_time: Option<DateTime<Utc>>,
    pub thumbnail_url: Option<String>,
    pub category_id: Option<String>,
}

pub struct YouTubeService {
    developer_key: String,
    http_client: reqwest::Client,
    /// Remaining API quota units
    quota_remaining: u32,
    /// Last quota reset timestamp (midnight UTC)
    last_reset: DateTime<Utc>,
    /// Cached categories
    categories: Option<Vec<YouTubeCategory>>,
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
            categories: None,
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

    /// Check if we have quota for categories call
    fn has_categories_quota(&mut self) -> bool {
        self.maybe_reset_quota();
        self.quota_remaining >= YOUTUBE_API_COST_CATEGORIES
    }

    /// Reset quota if it's a new day (midnight UTC)
    fn maybe_reset_quota(&mut self) {
        let now = Utc::now();
        let last_reset_date = self.last_reset.date_naive();

        if now.date_naive() > last_reset_date {
            self.quota_remaining = YOUTUBE_API_QUOTA_MAX;
            self.last_reset = now.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc();
            self.categories = None; // Reset cached categories
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

    /// Consume quota for categories call
    fn consume_categories_quota(&mut self) {
        self.maybe_reset_quota();
        if self.quota_remaining >= YOUTUBE_API_COST_CATEGORIES {
            self.quota_remaining -= YOUTUBE_API_COST_CATEGORIES;
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
  _published_at: String,
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
            trace!("No YouTube API key, using RSS fallback");
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
  #[allow(dead_code)]
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

  /// Get live streams from favorite channels
  pub async fn get_live_streams_favorites(&mut self, channel_ids: &[String], limit: u32) -> Result<Vec<StreamSource>, YouTubeError> {
    if channel_ids.is_empty() {
      return Ok(Vec::new());
    }

    if !self.is_enabled() || !self.has_quota_remaining() {
      trace!("No YouTube API key or quota, using RSS fallback");
      return self.check_multiple_via_rss(channel_ids).await;
    }

    // Use the existing get_live_streams with favorite channels
    // but limit to the specified number
    let mut all_streams = Vec::new();

    for channel_id in channel_ids {
      if all_streams.len() >= limit as usize {
        break;
      }

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
                  channel_id: Some(channel_id.to_string()),
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

      if all_streams.len() >= limit as usize {
        break;
      }
    }

    if !all_streams.is_empty() {
      let (remaining, max) = self.quota_status();
      info!(count = all_streams.len(), quota_remaining = remaining, quota_max = max, "Fetched live streams from YouTube favorites");
      return Ok(all_streams.into_iter().take(limit as usize).collect());
    }

    // Quota exhausted or API failed entirely -> use RSS for everything
    debug!(
      quota_remaining = %self.quota_remaining,
      "API quota exhausted, falling back to RSS"
    );
    self.check_multiple_via_rss(channel_ids).await
  }

  /// Get YouTube video categories
  pub async fn get_categories(&mut self) -> Result<Vec<YouTubeCategory>, YouTubeError> {
    if let Some(cached) = &self.categories {
      return Ok(cached.clone());
    }

    if !self.is_enabled() || !self.has_categories_quota() {
      return Err(YouTubeError::Config("YouTube API not available or quota exhausted".into()));
    }

    let url = format!(
      "https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=US&key={}",
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
        "Categories API error: {}",
        response.status()
      )));
    }

    self.consume_categories_quota();

    #[derive(serde::Deserialize)]
    struct CategoriesResponse {
      items: Vec<CategoryItem>,
    }

    #[derive(serde::Deserialize)]
    struct CategoryItem {
      id: String,
      snippet: CategorySnippet,
    }

    #[derive(serde::Deserialize)]
    struct CategorySnippet {
      title: String,
      assignable: bool,
    }

    let response: CategoriesResponse = response
      .json()
      .await
      .map_err(|e| YouTubeError::Api(e.to_string()))?;

    let categories: Vec<YouTubeCategory> = response
      .items
      .into_iter()
      .map(|item| YouTubeCategory {
        id: item.id,
        title: item.snippet.title,
        assignable: item.snippet.assignable,
      })
      .collect();

    self.categories = Some(categories.clone());
    info!(count = categories.len(), "Fetched YouTube categories");
    Ok(categories)
  }

  /// Get category name by ID
  pub fn get_category_name(&self, category_id: &str) -> Option<String> {
    self.categories.as_ref()?.iter()
      .find(|c| c.id == category_id)
      .map(|c| c.title.clone())
  }

  /// Get channel details by ID
  pub async fn get_channel(&mut self, channel_id: &str) -> Result<YouTubeChannel, YouTubeError> {
    if !self.is_enabled() || !self.has_quota_remaining() {
      return Err(YouTubeError::Config("YouTube API not available".into()));
    }

    let url = format!(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics,brandingSettings&id={}&key={}",
      channel_id, self.developer_key
    );

    let response = self
      .http_client
      .get(&url)
      .send()
      .await
      .map_err(|e| YouTubeError::Network(e.to_string()))?;

    if !response.status().is_success() {
      return Err(YouTubeError::Api(format!(
        "Channel API error: {}",
        response.status()
      )));
    }

    self.consume_quota();

    #[derive(serde::Deserialize)]
    struct ChannelsResponse {
      items: Vec<ChannelItem>,
    }

    #[derive(serde::Deserialize)]
    struct ChannelItem {
      id: String,
      snippet: ChannelSnippet,
      statistics: ChannelStatistics,
      branding_settings: Option<ChannelBrandingSettings>,
    }

    #[derive(serde::Deserialize)]
    struct ChannelSnippet {
      title: String,
      description: Option<String>,
      published_at: Option<String>,
      custom_url: Option<String>,
      thumbnails: Option<ChannelThumbnails>,
    }

    #[derive(serde::Deserialize)]
    struct ChannelThumbnails {
      high: Option<Thumbnail>,
      medium: Option<Thumbnail>,
      default: Option<Thumbnail>,
    }

    #[derive(serde::Deserialize)]
    struct Thumbnail {
      url: String,
    }

    #[derive(serde::Deserialize)]
    struct ChannelStatistics {
      subscriber_count: Option<String>,
      video_count: Option<String>,
      view_count: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct ChannelBrandingSettings {
      channel: Option<ChannelBranding>,
    }

    #[derive(serde::Deserialize)]
    struct ChannelBranding {
      #[serde(rename = "unsubscribedTrailer")]
      _unsubscribed_trailer: Option<String>,
    }

    let response: ChannelsResponse = response
      .json()
      .await
      .map_err(|e| YouTubeError::Api(e.to_string()))?;

    if response.items.is_empty() {
      return Err(YouTubeError::Api("Channel not found".into()));
    }

    let item = &response.items[0];
    let thumbnail_url = item.snippet.thumbnails.as_ref().and_then(|t| {
      t.high.as_ref().or(t.medium.as_ref()).or(t.default.as_ref())
    }).map(|t| t.url.clone());

    let published_at = item.snippet.published_at.as_ref()
      .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
      .map(|dt| dt.with_timezone(&Utc));

    Ok(YouTubeChannel {
      id: item.id.clone(),
      title: item.snippet.title.clone(),
      subscriber_count: item.statistics.subscriber_count.as_ref().and_then(|s| s.parse().ok()),
      video_count: item.statistics.video_count.as_ref().and_then(|s| s.parse().ok()),
      view_count: item.statistics.view_count.as_ref().and_then(|s| s.parse().ok()),
      thumbnail_url,
      description: item.snippet.description.clone(),
      published_at,
      custom_url: item.snippet.custom_url.clone(),
    })
  }

  /// Get live streams with enhanced details (concurrent viewers, category, etc.)
  pub async fn get_live_streams_detailed(&mut self, channel_ids: &[String]) -> Result<Vec<StreamSource>, YouTubeError> {
    if !self.is_enabled() || !self.has_quota_remaining() {
      trace!("No YouTube API key or quota, using RSS fallback");
      return self.check_multiple_via_rss(channel_ids).await;
    }

    let mut all_streams = Vec::new();

    for channel_id in channel_ids {
      // Use the search API with eventType=live and channelId
      let url = format!(
        "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&channelId={}&key={}",
        channel_id, self.developer_key
      );

      let response = self
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| YouTubeError::Network(e.to_string()))?;

      if !response.status().is_success() {
        warn!(channel_id = %channel_id, status = %response.status(), "API call failed, trying RSS");
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
        continue;
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
        _published_at: String,
        live_broadcast_content: Option<String>,
      }

      let api_response: YouTubeApiResponse = response
        .json()
        .await
        .map_err(|e| YouTubeError::Api(e.to_string()))?;

      for item in api_response.items {
        let url = format!("https://www.youtube.com/watch?v={}", item.id.video_id);
        debug!(
          channel = %item.snippet.channel_title,
          title = %item.snippet.title,
          "Found YouTube live stream via API"
        );

        // Try to get more details for this live stream
        let (concurrent_viewers, category_id) = self.get_live_stream_details(&item.id.video_id).await.unwrap_or((None, None));

        let category_name = category_id.as_ref().and_then(|id| self.get_category_name(id));

        let mut source = StreamSource {
          url,
          title: Some(item.snippet.title),
          platform: Some("youtube".to_string()),
          channel_id: Some(item.snippet.channel_id),
          channel: Some(item.snippet.channel_title),
          viewer_count: concurrent_viewers,
          start_time: None,
          priority: None,
          is_live: true,
          ..Default::default()
        };

        if let Some(cat) = category_name {
          // Add category to title for display
          source.title = Some(format!("[{}] {}", cat, source.title.unwrap_or_default()));
        }

        all_streams.push(source);
      }
    }

    if !all_streams.is_empty() {
      let (remaining, max) = self.quota_status();
      info!(count = all_streams.len(), quota_remaining = remaining, quota_max = max, "Fetched live streams from YouTube API");
      return Ok(all_streams);
    }

    // Quota exhausted or API failed entirely -> use RSS for everything
    debug!(
      quota_remaining = %self.quota_remaining,
      "API quota exhausted, falling back to RSS"
    );
    self.check_multiple_via_rss(channel_ids).await
  }

  /// Get live stream details (concurrent viewers, category)
  async fn get_live_stream_details(&mut self, video_id: &str) -> Result<(Option<u64>, Option<String>), YouTubeError> {
    if !self.has_quota_remaining() {
      return Ok((None, None));
    }

    let url = format!(
      "https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id={}&key={}",
      video_id, self.developer_key
    );

    let response = self
      .http_client
      .get(&url)
      .send()
      .await
      .map_err(|e| YouTubeError::Network(e.to_string()))?;

    if !response.status().is_success() {
      return Ok((None, None));
    }

    self.consume_quota();

    #[derive(serde::Deserialize)]
    struct VideoResponse {
      items: Vec<VideoItem>,
    }

    #[derive(serde::Deserialize)]
    struct VideoItem {
      live_streaming_details: Option<LiveStreamingDetails>,
      snippet: VideoSnippet,
    }

    #[derive(serde::Deserialize)]
    struct LiveStreamingDetails {
      concurrent_viewers: Option<String>,
      #[allow(dead_code)]
      active_live_chat_id: Option<String>,
      #[allow(dead_code)]
      scheduled_start_time: Option<String>,
      #[allow(dead_code)]
      actual_start_time: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct VideoSnippet {
      category_id: Option<String>,
    }

    let response: VideoResponse = response
      .json()
      .await
      .map_err(|e| YouTubeError::Api(e.to_string()))?;

    if let Some(item) = response.items.first() {
      let viewers = item.live_streaming_details.as_ref()
        .and_then(|d| d.concurrent_viewers.as_ref())
        .and_then(|s| s.parse::<u64>().ok());
      let category_id = item.snippet.category_id.clone();
      Ok((viewers, category_id))
    } else {
      Ok((None, None))
    }
  }

  /// Get live streams by category
  pub async fn get_live_streams_by_category(&mut self, category_id: &str, limit: usize) -> Result<Vec<StreamSource>, YouTubeError> {
    if !self.is_enabled() || !self.has_quota_remaining() {
      return Err(YouTubeError::Config("YouTube API not available".into()));
    }

    // First get the category to validate
    let _ = self.get_categories().await?;
    if !self.categories.as_ref().map(|c| c.iter().any(|cat| cat.id == category_id)).unwrap_or(false) {
      return Err(YouTubeError::Config("Category not found".into()));
    }

    // Search for live streams in this category
    let url = format!(
      "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&videoCategoryId={}&maxResults={}&key={}",
      category_id, limit.min(50), self.developer_key
    );

    let response = self
      .http_client
      .get(&url)
      .send()
      .await
      .map_err(|e| YouTubeError::Network(e.to_string()))?;

    if !response.status().is_success() {
      return Err(YouTubeError::Api(format!(
        "Search API error: {}",
        response.status()
      )));
    }

    self.consume_quota();

    #[derive(serde::Deserialize)]
    struct YouTubeSearchResponse {
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
      _published_at: String,
    }

    let search_response: YouTubeSearchResponse = response
      .json()
      .await
      .map_err(|e| YouTubeError::Api(e.to_string()))?;

    let sources: Vec<StreamSource> = search_response
      .items
      .into_iter()
      .map(|item| {
        let url = format!("https://www.youtube.com/watch?v={}", item.id.video_id);
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

    info!(count = sources.len(), category = %category_id, "Fetched live streams by category from YouTube");
    Ok(sources)
  }
}
