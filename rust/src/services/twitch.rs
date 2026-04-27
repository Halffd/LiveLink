use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use thiserror::Error;
use tracing::{debug, info, warn};

#[derive(Error, Debug)]
pub enum TwitchError {
    #[error("API error: {0}")]
    Api(String),
    #[error("Configuration error: {0}")]
    Config(String),
    #[error("Authentication error: {0}")]
    Auth(String),
    #[error("Network error: {0}")]
    Network(String),
}

#[derive(Clone)]
pub struct TwitchService {
    client_id: String,
    client_secret: String,
    access_token: Option<String>,
    http_client: reqwest::Client,
}

impl TwitchService {
    pub fn new(client_id: String, client_secret: String) -> Self {
        let is_enabled = !client_id.is_empty() && !client_secret.is_empty();
        if !is_enabled {
            warn!("Twitch client credentials not provided, service will be disabled");
        }

        Self {
            client_id,
            client_secret,
            access_token: None,
            http_client: reqwest::Client::new(),
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.client_id.is_empty() && !self.client_secret.is_empty()
    }

    pub async fn authenticate(&mut self) -> Result<(), TwitchError> {
        if !self.is_enabled() {
            return Err(TwitchError::Config("Twitch service not enabled".into()));
        }

        let params = [
            ("client_id", self.client_id.as_str()),
            ("client_secret", self.client_secret.as_str()),
            ("grant_type", "client_credentials"),
        ];

        let response = self
            .http_client
            .post("https://id.twitch.tv/oauth2/token")
            .form(&params)
            .send()
            .await
            .map_err(|e| TwitchError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Err(TwitchError::Auth(format!(
                "Failed to get access token: {}",
                response.status()
            )));
        }

        #[derive(serde::Deserialize)]
        struct TokenResponse {
            access_token: String,
            expires_in: i64,
            token_type: String,
        }

        let token_response: TokenResponse =
            response
                .json()
                .await
                .map_err(|e| TwitchError::Api(e.to_string()))?;

        info!("Twitch authentication successful");
        self.access_token = Some(token_response.access_token);
        Ok(())
    }

    pub async fn get_live_streams(&self, channels: &[String]) -> Result<Vec<StreamSource>, TwitchError> {
        let access_token = self
            .access_token
            .as_ref()
            .ok_or_else(|| TwitchError::Auth("Not authenticated with Twitch".into()))?;

        let login_param = channels
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("&user_login=");

        let url = if channels.is_empty() {
            "https://api.twitch.tv/helix/streams".to_string()
        } else {
            format!("https://api.twitch.tv/helix/streams?user_login={}", login_param)
        };

        let response = self
            .http_client
            .get(&url)
            .header("Client-ID", &self.client_id)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await
            .map_err(|e| TwitchError::Network(e.to_string()))?;

        if !response.status().is_success() {
            return Err(TwitchError::Api(format!(
                "Failed to get streams: {}",
                response.status()
            )));
        }

        #[derive(serde::Deserialize)]
        struct HelixResponse {
            data: Vec<TwitchStream>,
        }

        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct TwitchStream {
            id: String,
            user_id: String,
            user_login: String,
            user_name: String,
            game_id: String,
            game_name: String,
            #[serde(rename = "type")]
            type_: String,
            title: String,
            viewer_count: u64,
            started_at: String,
            language: String,
            thumbnail_url: String,
        }

        let helix_response: HelixResponse =
            response
                .json()
                .await
                .map_err(|e| TwitchError::Api(e.to_string()))?;

        let sources: Vec<StreamSource> = helix_response
            .data
            .into_iter()
            .map(|stream| {
                let url = format!("https://twitch.tv/{}", stream.user_login);
                debug!(
                    channel = %stream.user_login,
                    title = %stream.title,
                    viewers = stream.viewer_count,
                    "Found live stream"
                );

                // Parse start time from ISO8601
                let start_time = chrono::DateTime::parse_from_rfc3339(&stream.started_at)
                    .ok()
                    .map(|dt| dt.timestamp());

                StreamSource {
                    url,
                    title: Some(stream.title),
                    platform: Some("twitch".to_string()),
                    channel_id: Some(stream.user_id),
                    channel: Some(stream.user_login),
                    viewer_count: Some(stream.viewer_count),
                    start_time,
                    priority: None,
                    is_live: true,
                    ..Default::default()
                }
            })
            .collect();

info!(count = sources.len(), "Fetched live streams from Twitch");
    Ok(sources)
  }

  pub async fn query(&mut self, options: &QueryOptions) -> Result<Vec<StreamSource>, TwitchError> {
    let access_token = self
      .access_token
      .as_ref()
      .ok_or_else(|| TwitchError::Auth("Not authenticated with Twitch".into()))?;

    let search_query = options.search.as_deref().unwrap_or("");
    let limit = options.limit.unwrap_or(25) as usize;

    let url = format!(
      "https://api.twitch.tv/helix/search/channels?query={}&first={}",
      urlencoding::encode(search_query),
      limit.min(100)
    );

    let response = self
      .http_client
      .get(&url)
      .header("Client-ID", &self.client_id)
      .header("Authorization", format!("Bearer {}", access_token))
      .send()
      .await
      .map_err(|e| TwitchError::Network(e.to_string()))?;

    if !response.status().is_success() {
      return Err(TwitchError::Api(format!(
        "Search failed: {}",
        response.status()
      )));
    }

    #[derive(serde::Deserialize)]
    struct HelixResponse {
      data: Vec<TwitchSearchChannel>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TwitchSearchChannel {
      broadcaster_login: String,
      display_name: String,
      game_id: String,
      game_name: String,
      is_live: bool,
      tags: Vec<String>,
      thumbnail_url: String,
      title: String,
      started_at: Option<String>,
    }

    let helix_response: HelixResponse = response
      .json()
      .await
      .map_err(|e| TwitchError::Api(e.to_string()))?;

    let search_lower = options.search.as_ref().map(|s| s.to_lowercase());
    let tag_filter = options.tag.as_ref().map(|t| t.to_lowercase());

    let sources: Vec<StreamSource> = helix_response
      .data
      .into_iter()
      .filter(|ch| ch.is_live)
      .filter(|ch| {
        if let Some(ref search) = search_lower {
          if !ch.display_name.to_lowercase().contains(search) && !ch.title.to_lowercase().contains(search) {
            return false;
          }
        }
        if let Some(ref tag) = tag_filter {
          if !ch.tags.iter().any(|t| t.to_lowercase().contains(tag)) {
            return false;
          }
        }
        true
      })
      .map(|ch| {
        let url = format!("https://twitch.tv/{}", ch.broadcaster_login);
        let start_time = ch.started_at.as_ref().and_then(|s| {
          chrono::DateTime::parse_from_rfc3339(s).ok().map(|dt| dt.timestamp())
        });

        StreamSource {
          url,
          title: Some(ch.title),
          platform: Some("twitch".to_string()),
          channel_id: None,
          channel: Some(ch.broadcaster_login),
          viewer_count: None,
          start_time,
          priority: None,
          is_live: ch.is_live,
          ..Default::default()
        }
      })
      .collect();

    info!(count = sources.len(), "Searched streams from Twitch");
    Ok(sources)
  }
}

impl Default for TwitchService {
    fn default() -> Self {
        Self::new(String::new(), String::new())
    }
}