use crate::config::FavoriteChannels;
use crate::queue::queue::StreamSource;

pub struct FallbackService {
    favorite_channels: FavoriteChannels,
}

impl FallbackService {
    pub fn new(favorite_channels: FavoriteChannels) -> Self {
        Self { favorite_channels }
    }

    pub fn get_youtube_streams(&self) -> Vec<StreamSource> {
        self.favorite_channels
            .youtube
            .default
            .iter()
            .map(|ch| {
                let url = if ch.id.starts_with("http") {
                    ch.id.clone()
                } else {
                    format!("https://www.youtube.com/watch?v={}", ch.id)
                };
                StreamSource {
                    url,
                    title: Some(ch.name.clone()),
                    platform: Some("youtube".to_string()),
                    channel_id: Some(ch.id.clone()),
                    channel: Some(ch.name.clone()),
                    priority: Some(ch.score as i32),
                    is_live: true,
                    ..Default::default()
                }
            })
            .collect()
    }

    pub fn get_twitch_streams(&self) -> Vec<StreamSource> {
        self.favorite_channels
            .twitch
            .default
            .iter()
            .map(|ch| {
                let url = if ch.id.starts_with("http") {
                    ch.id.clone()
                } else {
                    format!("https://twitch.tv/{}", ch.id)
                };
                StreamSource {
                    url,
                    title: Some(ch.name.clone()),
                    platform: Some("twitch".to_string()),
                    channel_id: Some(ch.id.clone()),
                    channel: Some(ch.name.clone()),
                    priority: Some(ch.score as i32),
                    is_live: true,
                    ..Default::default()
                }
            })
            .collect()
    }

    pub fn get_holodex_streams(&self) -> Vec<StreamSource> {
        self.favorite_channels
            .holodex
            .default
            .iter()
            .map(|ch| {
                let url = if ch.id.starts_with("http") {
                    ch.id.clone()
                } else {
                    format!("https://holodex.net/channel/{}", ch.id)
                };
                StreamSource {
                    url,
                    title: Some(ch.name.clone()),
                    platform: Some("holodex".to_string()),
                    channel_id: Some(ch.id.clone()),
                    channel: Some(ch.name.clone()),
                    priority: Some(ch.score as i32),
                    is_live: true,
                    ..Default::default()
                }
            })
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.favorite_channels.youtube.default.is_empty()
            && self.favorite_channels.twitch.default.is_empty()
            && self.favorite_channels.holodex.default.is_empty()
    }

    pub fn all_streams(&self) -> Vec<StreamSource> {
        let mut streams = self.get_holodex_streams();
        streams.extend(self.get_twitch_streams());
        streams.extend(self.get_youtube_streams());
        streams
    }
}

impl Default for FallbackService {
    fn default() -> Self {
        Self {
            favorite_channels: FavoriteChannels::default(),
        }
    }
}

impl From<FavoriteChannels> for FallbackService {
    fn from(channels: FavoriteChannels) -> Self {
        Self::new(channels)
    }
}