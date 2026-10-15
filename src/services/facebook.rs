use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use thiserror::Error;
use tracing::debug;

#[derive(Error, Debug)]
#[allow(dead_code)]
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