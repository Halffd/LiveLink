use crate::queue::queue::StreamSource;
use crate::services::holodex::QueryOptions;
use tracing::{debug, info};

use super::Orchestrator;

impl Orchestrator {
    pub async fn query_streams(&self, options: QueryOptions) -> Result<Vec<StreamSource>, String> {
        debug!(?options, "Querying streams");

        let mut all_sources = Vec::new();
        let platform_filter = options.platform.as_deref();

        if platform_filter.is_none() || platform_filter == Some("holodex") {
            if self.holodex_service.is_enabled() {
                match self.holodex_service.query(&options).await {
                    Ok(sources) => {
                        info!(count = sources.len(), source = "holodex", "Queried streams from Holodex");
                        all_sources.extend(sources);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Holodex query failed");
                    }
                }
            }
        }

        if platform_filter.is_none() || platform_filter == Some("twitch") {
            if self.twitch_service.lock().await.is_enabled() {
                let mut twitch = self.twitch_service.lock().await;
                if twitch.authenticate().await.is_ok() {
                    match twitch.query(&options).await {
                        Ok(sources) => {
                            info!(count = sources.len(), source = "twitch", "Queried streams from Twitch");
                            all_sources.extend(sources);
                        }
                        Err(e) => {
                            tracing::warn!(error = %e, "Twitch query failed");
                        }
                    }
                }
            }
        }

        if platform_filter.is_none() || platform_filter == Some("youtube") {
            let mut youtube = self.youtube_service.lock().await;
            if youtube.is_enabled() {
                match youtube.query(&options).await {
                    Ok(sources) => {
                        info!(count = sources.len(), source = "youtube", "Queried streams from YouTube");
                        all_sources.extend(sources);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "YouTube query failed");
                    }
                }
            }
        }

        if platform_filter.is_none() || platform_filter == Some("kick") {
            if self.kick_service.is_enabled() {
                match self.kick_service.query(&options).await {
                    Ok(sources) => {
                        info!(count = sources.len(), source = "kick", "Queried streams from Kick");
                        all_sources.extend(sources);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Kick query failed");
                    }
                }
            }
        }

        if platform_filter.is_none() || platform_filter == Some("niconico") {
            if self.niconico_service.is_enabled() {
                match self.niconico_service.query(&options).await {
                    Ok(sources) => {
                        info!(count = sources.len(), source = "niconico", "Queried streams from Niconico");
                        all_sources.extend(sources);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Niconico query failed");
                    }
                }
            }
        }

        if platform_filter.is_none() || platform_filter == Some("bilibili") {
            if self.bilibili_service.is_enabled() {
                match self.bilibili_service.query(&options).await {
                    Ok(sources) => {
                        info!(count = sources.len(), source = "bilibili", "Queried streams from Bilibili");
                        all_sources.extend(sources);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "Bilibili query failed");
                    }
                }
            }
        }

        if all_sources.is_empty() {
            return Err("No streams found for the given query".to_string());
        }

        Ok(all_sources)
    }
}