use crate::queue::queue::StreamSource;

pub struct HolodexService;

impl HolodexService {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_live_streams(&self, _organization: &str) -> Vec<StreamSource> {
        Vec::new()
    }
}

impl Default for HolodexService {
    fn default() -> Self {
        Self::new()
    }
}