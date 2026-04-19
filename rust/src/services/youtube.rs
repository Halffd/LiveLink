use crate::queue::queue::StreamSource;

pub struct YouTubeService;

impl YouTubeService {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_live_streams(&self, _channels: &[String]) -> Vec<StreamSource> {
        Vec::new()
    }
}

impl Default for YouTubeService {
    fn default() -> Self {
        Self::new()
    }
}