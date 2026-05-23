use crate::queue::queue::StreamSource;
use tracing::{debug, warn};

use super::Orchestrator;

impl Orchestrator {
    pub async fn fetch_streams_for_screen(&self, _screen: u32) -> Vec<StreamSource> {
        let streams = self.fetch_all_streams_internal().await;
        self.apply_filters(streams)
    }

    pub(crate) async fn fetch_all_streams_internal(&self) -> Vec<StreamSource> {
        if self.holodex_service.is_enabled() {
            match self.holodex_service.get_live_streams().await {
                Ok(streams) => {
                    debug!(count = streams.len(), "Fetched streams from Holodex API");
                    return streams;
                }
                Err(e) => {
                    warn!(error = %e, "Holodex API failed, falling back to favorites");
                }
            }
        }

        if self.twitch_service.lock().await.is_enabled() {
            let twitch_channels: Vec<String> = self.config
                .favorite_channels
                .twitch
                .default
                .iter()
                .map(|ch| ch.id.clone())
                .collect();

            if !twitch_channels.is_empty() {
                let mut twitch = self.twitch_service.lock().await;
                if twitch.authenticate().await.is_ok() {
                    match twitch.get_live_streams(&twitch_channels).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched streams from Twitch API");
                            let sorted = self.sort_streams_by_favorites(streams, "twitch");
                            return sorted;
                        }
                        Err(e) => {
                            warn!(error = %e, "Twitch API failed, falling back");
                        }
                    }
                } else {
                    warn!("Twitch authentication failed");
                }
            }
        }

        let yt_channels: Vec<String> = self.config
            .favorite_channels
            .youtube
            .default
            .iter()
            .map(|ch| ch.id.clone())
            .collect();

        if !yt_channels.is_empty() {
            let mut yt_service = self.youtube_service.lock().await;
            if yt_service.is_enabled() || true {
                match yt_service.get_live_streams(&yt_channels).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched streams from YouTube");
                            let sorted = self.sort_streams_by_favorites(streams, "youtube");
                            return sorted;
                        }
                        Err(e) => {
                            warn!(error = %e, "YouTube service failed, falling back");
                        }
                }
            }
        }

        let kick_channels: Vec<String> = self.config
            .favorite_channels
            .kick
            .default
            .iter()
            .map(|ch| ch.id.clone())
            .collect();

        if !kick_channels.is_empty() {
            match self.kick_service.get_live_streams(&kick_channels).await {
                Ok(streams) => {
                    debug!(count = streams.len(), "Fetched streams from Kick");
                    let sorted = self.sort_streams_by_favorites(streams, "kick");
                    return sorted;
                }
                Err(e) => {
                    warn!(error = %e, "Kick service failed, falling back");
                }
            }
        }

        let niconico_channels: Vec<String> = self.config
            .favorite_channels
            .niconico
            .default
            .iter()
            .map(|ch| ch.id.clone())
            .collect();

        if !niconico_channels.is_empty() {
            match self.niconico_service.get_live_streams(&niconico_channels).await {
                Ok(streams) => {
                    debug!(count = streams.len(), "Fetched streams from Niconico");
                    let sorted = self.sort_streams_by_favorites(streams, "niconico");
                    return sorted;
                }
                Err(e) => {
                    warn!(error = %e, "Niconico service failed, falling back");
                }
            }
        }

        let bilibili_rooms: Vec<String> = self.config
            .favorite_channels
            .bilibili
            .default
            .iter()
            .map(|ch| ch.id.clone())
            .collect();

        if !bilibili_rooms.is_empty() {
            match self.bilibili_service.get_live_streams(&bilibili_rooms).await {
                Ok(streams) => {
                    debug!(count = streams.len(), "Fetched streams from Bilibili");
                    let sorted = self.sort_streams_by_favorites(streams, "bilibili");
                    return sorted;
                }
                Err(e) => {
                    warn!(error = %e, "Bilibili service failed, falling back");
                }
            }
        }

        if self.fallback_service.is_empty() {
            warn!("No favorite channels configured and no API services available");
            return Vec::new();
        }

        let streams = self.fallback_service.all_streams();
        debug!(count = streams.len(), "Fetched streams from fallback service");
        streams
    }
}