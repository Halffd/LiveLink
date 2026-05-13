use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use thiserror::Error;
use tracing::debug;

#[derive(Error, Debug)]
pub enum FacebookError {
  #[error("API error: {0}")]
  Api(String),
  #[error("Channel not found: {0}")]
  ChannelNotFound(String),
  #[error("Network error: {0}")]
  Network(String),
}

pub struct FacebookService {
  enabled: bool,
}

impl FacebookService {
  pub fn new() -> Self {
    Self { enabled: true }
  }

  pub fn is_enabled(&self) -> bool {
    self.enabled
  }

  pub fn set_enabled(&mut self, enabled: bool) {
    self.enabled = enabled;
  }

  pub async fn get_live_streams(&self, _channel_names: &[String]) -> Result<Vec<StreamSource>, FacebookError> {
    debug!("Facebook live checking not fully implemented - use URL matching");
    Ok(vec![])
  }

  pub fn parse_facebook_url(url: &str) -> Option<(String, String)> {
    if !url.contains("facebook.com") && !url.contains("fb.watch") {
      return None;
    }

    let video_id = if url.contains("/video/") {
      url.split("/video/")
        .nth(1)?
        .split(|c| c == '?' || c == '/')
        .next()?
        .to_string()
    } else if url.contains("/watch/") {
      url.split("/watch/")
        .nth(1)?
        .split(|c| c == '?' || c == '/')
        .next()?
        .to_string()
    } else if url.contains("fb.watch") {
      url.split("fb.watch/")
        .nth(1)?
        .split(|c| c == '?' || c == '/')
        .next()?
        .to_string()
    } else {
      return None;
    };

    Some((video_id, url.to_string()))
  }

  pub fn get_stream_url(channel_id: &str) -> String {
    if channel_id.starts_with("http") {
      channel_id.to_string()
    } else {
      format!("https://www.facebook.com/{}", channel_id)
    }
  }

  pub fn is_live_url(url: &str) -> bool {
    url.contains("facebook.com/live") || url.contains("fb.watch")
  }

  pub fn matches_platform(url: &str) -> bool {
    url.contains("facebook.com") || url.contains("fb.watch")
  }

  pub async fn query(&self, options: &QueryOptions) -> Result<Vec<StreamSource>, FacebookError> {
    if !self.enabled {
      return Ok(vec![]);
    }

    let platform_filter = options.platform.as_deref();
    if let Some(p) = platform_filter {
      if p != "facebook" && p != "fb" {
        return Ok(vec![]);
      }
    }

    let sources = vec![];

    if let Some(search) = &options.search {
      debug!(search = %search, "Facebook search not fully implemented");
    }

    Ok(sources)
  }
}

impl Default for FacebookService {
  fn default() -> Self {
    Self::new()
  }
}