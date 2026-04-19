use serde::Deserialize;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

mod env;
mod favorites;

pub use env::Env;
pub use favorites::{FavoriteChannel, FavoriteChannels, PlatformFavorites};

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub streams: Vec<ScreenConfig>,
    pub organizations: Vec<String>,
    pub favorite_channels: FavoriteChannels,
    pub holodex: HolodexConfig,
    pub twitch: TwitchConfig,
    pub youtube: YoutubeConfig,
    pub player: PlayerConfig,
    pub mpv: MpvConfig,
    pub streamlink: StreamlinkConfig,
    pub filters: FiltersConfig,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScreenConfig {
    pub id: u32,
    pub screen: u32,
    pub enabled: bool,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub volume: u8,
    pub quality: String,
    pub window_maximized: bool,
    pub primary: bool,
    pub sources: Vec<SourceConfig>,
    pub sorting: SortingConfig,
    pub refresh: u32,
    pub auto_start: bool,
    #[serde(default)]
    pub skip_watched_streams: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SourceConfig {
    #[serde(rename = "type")]
    pub type_: String,
    pub subtype: Option<String>,
    pub enabled: bool,
    pub priority: u32,
    pub limit: Option<usize>,
    pub name: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SortingConfig {
    pub field: String,
    pub order: String,
    #[serde(default)]
    pub ignore: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HolodexConfig {
    pub api_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TwitchConfig {
    pub client_id: String,
    pub client_secret: String,
    pub streamers_file: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct YoutubeConfig {
    pub api_key: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlayerConfig {
    pub prefer_streamlink: bool,
    pub default_quality: String,
    pub default_volume: u8,
    pub window_maximized: bool,
    pub max_streams: usize,
    pub auto_start: bool,
    pub disable_heartbeat: bool,
    pub force_player: bool,
    pub logging: LoggingConfig,
    pub screens: Vec<ScreenConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoggingConfig {
    pub enabled: bool,
    pub level: String,
    pub max_size_mb: u32,
    pub max_files: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MpvConfig {
    pub priority: String,
    #[serde(rename = "gpu-context")]
    pub gpu_context: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamlinkConfig {
    pub path: String,
    pub options: HashMap<String, serde_json::Value>,
    pub http_header: HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FiltersConfig {
    pub filters: Vec<String>,
}

pub struct ConfigLoader {
    config_dir: PathBuf,
}

impl ConfigLoader {
    pub fn new() -> Self {
        let env = Env::load();
        let config_dir = env
            .livelink_config_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("config"));
        Self { config_dir }
    }

    fn load_json_file<T: for<'de> Deserialize<'de>>(&self, filename: &str) -> Result<T, String> {
        let path = self.config_dir.join(filename);
        info!("Loading config file: {}", path.display());
        let content =
            fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
    }

    fn try_load_json_file<T: for<'de> Deserialize<'de>>(&self, filename: &str) -> Option<T> {
        match self.load_json_file(filename) {
            Ok(data) => Some(data),
            Err(e) => {
                warn!("Could not load {}: {}", filename, e);
                None
            }
        }
    }

    pub fn load(&self) -> Config {
        let env = Env::load();
        let favorites_path = self.config_dir.join("favorites.json");
        let favorite_channels = if favorites_path.exists() {
            match FavoriteChannels::load_from_file(&favorites_path) {
                Ok(f) => f,
                Err(e) => {
                    warn!("Failed to load favorites.json: {}, using defaults", e);
                    self.default_favorites()
                }
            }
        } else {
            self.default_favorites()
        };

        let streams_data: Option<StreamsFile> = self.try_load_json_file("streams.json");
        let streams = streams_data.as_ref().map(|s| s.streams.clone()).unwrap_or_default();
        let organizations = streams_data.map(|s| s.organizations).unwrap_or_default();

        let player: PlayerConfig = self
            .try_load_json_file("player.json")
            .unwrap_or_else(|| self.default_player_config());

        let mpv: MpvConfig = self
            .try_load_json_file("mpv.json")
            .unwrap_or_else(|| self.default_mpv_config());

        let streamlink: StreamlinkConfig = self
            .try_load_json_file("streamlink.json")
            .unwrap_or_else(|| self.default_streamlink_config());

        let filters: FiltersConfig = self
            .try_load_json_file("filters.json")
            .unwrap_or_else(|| FiltersConfig { filters: vec![] });

        let main_config: Option<MainConfig> = self.try_load_json_file("config.json");

        Config {
            streams,
            organizations,
            favorite_channels,
            holodex: HolodexConfig {
                api_key: if env.holodex_api_key.is_empty() {
                    main_config
                        .as_ref()
                        .and_then(|c| c.holodex.as_ref().map(|h| h.api_key.clone()))
                        .unwrap_or_default()
                } else {
                    env.holodex_api_key.clone()
                },
            },
            twitch: TwitchConfig {
                client_id: if env.twitch_client_id.is_empty() {
                    main_config
                        .as_ref()
                        .and_then(|c| c.twitch.as_ref().map(|t| t.client_id.clone()))
                        .unwrap_or_default()
                } else {
                    env.twitch_client_id.clone()
                },
                client_secret: if env.twitch_client_secret.is_empty() {
                    main_config
                        .as_ref()
                        .and_then(|c| c.twitch.as_ref().map(|t| t.client_secret.clone()))
                        .unwrap_or_default()
                } else {
                    env.twitch_client_secret.clone()
                },
                streamers_file: "streamers.json".to_string(),
            },
            youtube: YoutubeConfig {
                api_key: if let Some(ref key) = env.youtube_api_key {
                    key.clone()
                } else {
                    main_config
                        .as_ref()
                        .and_then(|c| c.youtube.as_ref().map(|y| y.api_key.clone()))
                        .unwrap_or_default()
                },
            },
            player,
            mpv,
            streamlink,
            filters,
        }
    }

    fn default_favorites(&self) -> FavoriteChannels {
        FavoriteChannels {
            holodex: PlatformFavorites { default: vec![] },
            twitch: PlatformFavorites { default: vec![] },
            youtube: PlatformFavorites { default: vec![] },
        }
    }

    fn default_player_config(&self) -> PlayerConfig {
        PlayerConfig {
            prefer_streamlink: false,
            default_quality: "best".to_string(),
            default_volume: 50,
            window_maximized: false,
            max_streams: 4,
            auto_start: true,
            disable_heartbeat: false,
            force_player: false,
            logging: LoggingConfig {
                enabled: true,
                level: "info".to_string(),
                max_size_mb: 50,
                max_files: 5,
            },
            screens: vec![
                ScreenConfig {
                    id: 1,
                    screen: 1,
                    enabled: true,
                    width: 1280,
                    height: 720,
                    x: 0,
                    y: 0,
                    volume: 50,
                    quality: "best".to_string(),
                    window_maximized: false,
                    primary: true,
                    sources: vec![],
                    sorting: SortingConfig {
                        field: "viewerCount".to_string(),
                        order: "desc".to_string(),
                        ignore: None,
                    },
                    refresh: 300,
                    auto_start: true,
                    skip_watched_streams: None,
                },
                ScreenConfig {
                    id: 2,
                    screen: 2,
                    enabled: true,
                    width: 1280,
                    height: 720,
                    x: 1280,
                    y: 0,
                    volume: 50,
                    quality: "best".to_string(),
                    window_maximized: false,
                    primary: false,
                    sources: vec![],
                    sorting: SortingConfig {
                        field: "viewerCount".to_string(),
                        order: "desc".to_string(),
                        ignore: None,
                    },
                    refresh: 300,
                    auto_start: true,
                    skip_watched_streams: None,
                },
            ],
        }
    }

    fn default_mpv_config(&self) -> MpvConfig {
        MpvConfig {
            priority: "normal".to_string(),
            gpu_context: "auto".to_string(),
            extra: HashMap::new(),
        }
    }

    fn default_streamlink_config(&self) -> StreamlinkConfig {
        StreamlinkConfig {
            path: String::new(),
            options: HashMap::new(),
            http_header: HashMap::new(),
        }
    }
}

impl Default for ConfigLoader {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
struct StreamsFile {
    streams: Vec<ScreenConfig>,
    organizations: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MainConfig {
    holodex: Option<HolodexConfig>,
    twitch: Option<TwitchConfig>,
    youtube: Option<YoutubeConfig>,
}