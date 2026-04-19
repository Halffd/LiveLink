use crate::queue::queue::StreamSource;

pub struct TwitchService;

impl TwitchService {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_live_streams(&self, _channels: &[String]) -> Vec<StreamSource> {
        Vec::new()
    }
}

impl Default for TwitchService {
    fn default() -> Self {
        Self::new()
    }
}