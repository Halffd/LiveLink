use crate::queue::queue::StreamSource;
use tracing::{debug, warn};

use super::Orchestrator;

impl Orchestrator {
    /// Map source type to platform name
    fn source_type_to_platform(source_type: &str) -> &'static str {
        match source_type {
            "holodex_favorites" | "holodex_orgs" | "holodex_orgs_priority" | "holodex_twitch_independents" | "holodex" => "holodex",
            "youtube_favorites" | "youtube" => "youtube",
            "twitch_favorites" | "twitch_followed" | "twitch_vtuber_tag" | "twitch_anime_tag" | "twitch_top" | "twitch" => "twitch",
            "kick" => "kick",
            "niconico" => "niconico",
            "bilibili" => "bilibili",
            "facebook" => "facebook",
            _ => "unknown", // fallback to static string
        }
    }

    pub async fn fetch_streams_for_screen(&self, screen: u32) -> Vec<StreamSource> {
        let all_streams = self.fetch_all_streams_internal().await;
        let mut filtered = self.apply_filters(all_streams);
        
        // Filter by screen's sources configuration
        if let Some(screen_config) = self.config.screens.iter().find(|s| s.screen == screen) {
            if !screen_config.sources.is_empty() {
                let enabled_sources: std::collections::HashSet<_> = screen_config.sources
                    .iter()
                    .filter(|s| s.enabled)
                    .map(|s| Self::source_type_to_platform(&s.type_))
                    .collect();
                
                debug!(screen, enabled_sources = ?enabled_sources, "Screen source filter");
                
                if !enabled_sources.is_empty() {
                    let before_count = filtered.len();
                    filtered = filtered.into_iter()
                        .filter(|s| {
                            let platform = s.platform.as_deref().unwrap_or("unknown");
                            enabled_sources.contains(platform)
                        })
                        .collect();
                    debug!(screen, before = before_count, after = filtered.len(), "After source filter");
                }
            }
            
            // Skip watched streams if configured
            if screen_config.skip_watched_streams.unwrap_or(false) {
                let queue = self.queue.lock().await;
                filtered = filtered.into_iter()
                    .filter(|s| !queue.is_stream_watched(screen, s))
                    .collect();
            }
        }
        
        filtered
    }

    pub(crate) async fn fetch_all_streams_internal(&self) -> Vec<StreamSource> {
        let mut all_streams = Vec::new();

        // Check if we have holodex favorites source
        let has_holodex_favorites = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "holodex_favorites")
        });
        if has_holodex_favorites {
            if self.holodex_service.is_enabled() {
                let holodex_favorites: Vec<String> = self.config
                    .favorite_channels
                    .holodex
                    .default
                    .iter()
                    .map(|ch| ch.id.clone())
                    .collect();
                if !holodex_favorites.is_empty() {
                    match self.holodex_service.get_live_streams_favorites(&holodex_favorites, 200).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched streams from Holodex favorites");
                            all_streams.extend(streams);
                        }
                        Err(e) => {
                            warn!(error = %e, "Holodex favorites failed");
                        }
                    }
                }
            }
        }

        // Try to get streams from holodex organizations (priority order)
        let has_holodex_orgs_priority = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "holodex_orgs_priority")
        });
        if has_holodex_orgs_priority {
            if self.holodex_service.is_enabled() {
                let orgs: Vec<String> = vec![
                    "Hololive".to_string(),
                    "Phase Connect".to_string(),
                    "VOMS".to_string(),
                    "VSPo".to_string(),
                    "Nijisanji".to_string(),
                    "V4Mirai".to_string(),
                    "Varium".to_string(),
                    "WACTOR".to_string(),
                    "VReverie".to_string(),
                    "VEE".to_string(),
                    ".LIVE".to_string(),
                    "Independents".to_string(),
                ];
                match self.holodex_service.get_live_streams_by_orgs(&orgs, 200).await {
                    Ok(streams) => {
                        debug!(count = streams.len(), "Fetched streams from Holodex orgs (priority)");
                        all_streams.extend(streams);
                    }
                    Err(e) => {
                        warn!(error = %e, "Holodex orgs (priority) failed");
                    }
                }
            }
        }

        // Try to get streams from holodex organizations (original)

        // Try to get streams from holodex favorites (YouTube channel IDs)
        let has_holodex_favs = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "holodex_favorites")
        });
        if has_holodex_favs {
            if self.holodex_service.is_enabled() {
                let holodex_favorites: Vec<String> = self.config
                    .favorite_channels
                    .holodex
                    .default
                    .iter()
                    .map(|ch| ch.id.clone())
                    .collect();
                if !holodex_favorites.is_empty() {
                    match self.holodex_service.get_live_streams_favorites(&holodex_favorites, 200).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched streams from Holodex favorites");
                            all_streams.extend(streams);
                        }
                        Err(e) => {
                            warn!(error = %e, "Holodex favorites failed");
                        }
                    }
                }
            }
        }

        // Try to get streams from holodex twitch independents
        let has_twitch_independents = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "holodex_twitch_independents")
        });
        if has_twitch_independents {
            if self.holodex_service.is_enabled() {
                match self.holodex_service.get_live_streams_twitch_independents(200).await {
                    Ok(streams) => {
                        debug!(count = streams.len(), "Fetched streams from Holodex twitch independents");
                        all_streams.extend(streams);
                    }
                    Err(e) => {
                        warn!(error = %e, "Holodex twitch independents failed");
                    }
                }
            }
        }

        // Try to get streams from YouTube favorites
        let has_yt_favorites = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "youtube_favorites")
        });
        if has_yt_favorites {
            if self.youtube_service.lock().await.is_enabled() {
                let yt_favorites: Vec<String> = self.config
                    .favorite_channels
                    .youtube
                    .default
                    .iter()
                    .map(|ch| ch.id.clone())
                    .collect();
                if !yt_favorites.is_empty() {
                    let mut yt_service = self.youtube_service.lock().await;
                    match yt_service.get_live_streams_favorites(&yt_favorites, 200).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched streams from YouTube favorites");
                            all_streams.extend(streams);
                        }
                        Err(e) => {
                            warn!(error = %e, "YouTube favorites failed");
                        }
                    }
                }
            }
        }

        // Try to get streams from Twitch favorites
        let has_twitch_favorites = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "twitch_favorites")
        });
        if has_twitch_favorites {
            if self.twitch_service.lock().await.is_enabled() {
                let twitch_favorites: Vec<String> = self.config
                    .favorite_channels
                    .twitch
                    .default
                    .iter()
                    .map(|ch| ch.id.clone())
                    .collect();
                if !twitch_favorites.is_empty() {
                    let mut twitch = self.twitch_service.lock().await;
                    if twitch.authenticate().await.is_ok() {
                        match twitch.get_live_streams_favorites(&twitch_favorites, 200).await {
                            Ok(streams) => {
                                debug!(count = streams.len(), "Fetched streams from Twitch favorites");
                                all_streams.extend(streams);
                            }
                            Err(e) => {
                                warn!(error = %e, "Twitch favorites failed");
                            }
                        }
                    }
                }
            }
        }

        // Try to get streams from Twitch followed channels
        let has_twitch_followed = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "twitch_followed")
        });
        if has_twitch_followed {
            if self.twitch_service.lock().await.is_enabled() {
                // This would require user OAuth token, for now skip
                debug!("Twitch followed channels requires user OAuth, skipping");
            }
        }

        // Try to get streams from Twitch by tag (vtuber)
        let has_twitch_vtuber_tag = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "twitch_vtuber_tag")
        });
        if has_twitch_vtuber_tag {
            if self.twitch_service.lock().await.is_enabled() {
                let mut twitch = self.twitch_service.lock().await;
                if twitch.authenticate().await.is_ok() {
                    match twitch.get_live_streams_by_tag("vtuber", 200).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched streams from Twitch vtuber tag");
                            all_streams.extend(streams);
                        }
                        Err(e) => {
                            warn!(error = %e, "Twitch vtuber tag failed");
                        }
                    }
                }
            }
        }

        // Try to get streams from Twitch anime tag
        let has_twitch_anime_tag = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "twitch_anime_tag")
        });
        if has_twitch_anime_tag {
            if self.twitch_service.lock().await.is_enabled() {
                let mut twitch = self.twitch_service.lock().await;
                if twitch.authenticate().await.is_ok() {
                    match twitch.get_live_streams_by_tag("anime", 200).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched streams from Twitch anime tag");
                            all_streams.extend(streams);
                        }
                        Err(e) => {
                            warn!(error = %e, "Twitch anime tag failed");
                        }
                    }
                }
            }
        }

        // Try to get streams from Holodex twitch independents
        let has_holodex_twitch_ind = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "holodex_twitch_independents")
        });
        if has_holodex_twitch_ind {
            if self.holodex_service.is_enabled() {
                match self.holodex_service.get_live_streams_twitch_independents(200).await {
                    Ok(streams) => {
                        debug!(count = streams.len(), "Fetched streams from Holodex twitch independents");
                        all_streams.extend(streams);
                    }
                    Err(e) => {
                        warn!(error = %e, "Holodex twitch independents failed");
                    }
                }
            }
        }

        // Try to get top Twitch streams
        let has_twitch_top = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "twitch_top")
        });
        if has_twitch_top {
            if self.twitch_service.lock().await.is_enabled() {
                let mut twitch = self.twitch_service.lock().await;
                if twitch.authenticate().await.is_ok() {
                    match twitch.get_top_streams(200).await {
                        Ok(streams) => {
                            debug!(count = streams.len(), "Fetched top streams from Twitch");
                            all_streams.extend(streams);
                        }
                        Err(e) => {
                            warn!(error = %e, "Twitch top streams failed");
                        }
                    }
                }
            }
        }

        // Try to get streams from YouTube favorites (fallback to old method)
        let has_youtube = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "youtube")
        });
        if has_youtube {
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
                            all_streams.extend(sorted);
                        }
                        Err(e) => {
                            warn!(error = %e, "YouTube service failed, falling back");
                        }
                    }
                }
            }
        }

        // Try to get streams from Twitch favorites (fallback to old method)
        let has_twitch = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "twitch")
        });
        if has_twitch {
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
                                all_streams.extend(sorted);
                            }
                            Err(e) => {
                                warn!(error = %e, "Twitch API failed, falling back");
                            }
                        }
                    }
                }
            }
        }

        // Try to get streams from Kick favorites
        let has_kick = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "kick")
        });
        if has_kick {
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
                        all_streams.extend(sorted);
                    }
                    Err(e) => {
                        warn!(error = %e, "Kick service failed, falling back");
                    }
                }
            }
        }

        // Try to get streams from Niconico favorites
        let has_niconico = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "niconico")
        });
        if has_niconico {
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
                        all_streams.extend(sorted);
                    }
                    Err(e) => {
                        warn!(error = %e, "Niconico service failed, falling back");
                    }
                }
            }
        }

        // Try to get streams from Bilibili favorites
        let has_bilibili = self.config.screens.iter().any(|s| {
            s.sources.iter().any(|src| src.enabled && src.type_ == "bilibili")
        });
        if has_bilibili {
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
                        all_streams.extend(sorted);
                    }
                    Err(e) => {
                        warn!(error = %e, "Bilibili service failed, falling back");
                    }
                }
            }
        }

        // If we still have no streams, try fallback
        if all_streams.is_empty() {
            if self.fallback_service.is_empty() {
                warn!("No favorite channels configured and no API services available");
                return Vec::new();
            }

            let streams = self.fallback_service.all_streams();
            debug!(count = streams.len(), "Fetched streams from fallback service");
            all_streams.extend(streams);
        }

        all_streams
    }
}