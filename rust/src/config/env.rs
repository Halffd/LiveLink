use serde::Deserialize;
use std::env;

#[derive(Debug, Clone, Deserialize)]
pub struct Env {
    pub node_env: String,
    pub port: u16,
    pub log_level: String,
    pub database_path: String,
    pub holodex_api_key: String,
    pub twitch_client_id: String,
    pub twitch_client_secret: String,
    pub youtube_api_key: Option<String>,
    pub livelink_config_dir: Option<String>,
}

impl Env {
    pub fn load() -> Self {
        load_dotenv();

        Self {
            node_env: env::var("NODE_ENV").unwrap_or_else(|_| "development".into()),
            port: env::var("PORT")
                .unwrap_or_else(|_| "3001".into())
                .parse()
                .unwrap_or(3001),
            log_level: env::var("LOG_LEVEL").unwrap_or_else(|_| "info".into()),
            database_path: env::var("DATABASE_PATH")
                .unwrap_or_else(|_| "data/streams.db".into()),
            holodex_api_key: env::var("HOLODEX_API_KEY").unwrap_or_default(),
            twitch_client_id: env::var("TWITCH_CLIENT_ID").unwrap_or_default(),
            twitch_client_secret: env::var("TWITCH_CLIENT_SECRET").unwrap_or_default(),
            youtube_api_key: env::var("YOUTUBE_API_KEY").ok(),
            livelink_config_dir: env::var("LIVELINK_CONFIG").ok(),
        }
    }
}

fn load_dotenv() {
    if let Ok(content) = std::fs::read_to_string(".env") {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, value)) = line.split_once('=') {
                let key = key.trim();
                let value = value.trim();
                if env::var(key).is_err() {
                    env::set_var(key, value);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_env_load_defaults() {
        let env = Env::load();
        assert!(env.port > 0);
    }
}