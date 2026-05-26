use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use tracing::{info, warn};

mod env;
mod favorites;

pub use env::Env;
pub use favorites::{FavoriteChannel, FavoriteChannels, PlatformFavorites};

#[derive(Debug, Clone, Deserialize)]
#[allow(unused)]
pub struct Config {
    pub streams: Vec<StreamEntry>,
    pub organizations: Vec<String>,
    pub favorite_channels: FavoriteChannels,
    pub holodex: HolodexConfig,
    pub twitch: TwitchConfig,
    pub youtube: YoutubeConfig,
    pub kick: KickConfig,
    pub niconico: NiconicoConfig,
    pub bilibili: BilibiliConfig,
    pub player: PlayerConfig,
    pub mpv: MpvConfig,
    pub streamlink: StreamlinkConfig,
    pub vlc: VlcConfig,
    pub filters: FiltersConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[allow(unused)]
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
    #[serde(alias = "windowMaximized", default)]
    pub window_maximized: bool,
    #[serde(default)]
    pub primary: bool,
    #[serde(default)]
    pub sources: Vec<SourceConfig>,
    #[serde(default)]
    pub sorting: Option<SortingConfig>,
    #[serde(default)]
    pub refresh: u32,
    #[serde(default, alias = "autoStart")]
    pub auto_start: bool,
    #[serde(default)]
    pub skip_watched_streams: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SortRule {
    pub field: String,
    pub order: String,
    #[serde(default)]
    pub ignore: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SortingConfig {
    #[serde(default, alias = "fields")]
    pub rules: Option<Vec<SortRule>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HolodexConfig {
    #[serde(alias = "apiKey")]
    pub api_key: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TwitchConfig {
    #[serde(alias = "clientId")]
    pub client_id: String,
    #[serde(alias = "clientSecret")]
    pub client_secret: String,
    #[serde(default, alias = "streamersFile")]
    pub streamers_file: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct YoutubeConfig {
    #[serde(alias = "apiKey", default)]
    pub api_key: String,
    #[serde(default)]
    pub favorite_channels: Vec<FavoriteChannel>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KickConfig {
  #[serde(default = "default_true")]
  pub enabled: bool,
}

fn default_true() -> bool { true }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NiconicoConfig {
  #[serde(default = "default_true")]
  pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BilibiliConfig {
  #[serde(default = "default_true")]
  pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FacebookConfig {
  #[serde(default = "default_true")]
  pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PlayerConfig {
    #[serde(default = "default_player_type", alias = "playerType")]
    pub player_type: String,
    #[serde(alias = "defaultQuality", default = "default_quality")]
    pub default_quality: String,
    #[serde(alias = "defaultVolume", default = "default_volume")]
    pub default_volume: u8,
    #[serde(alias = "windowMaximized", default)]
    pub window_maximized: bool,
    #[serde(alias = "maxStreams", default = "default_max_streams")]
    pub max_streams: usize,
    #[serde(alias = "autoStart", default = "default_auto_start")]
    pub auto_start: bool,
    #[serde(alias = "disableHeartbeat", default)]
    pub disable_heartbeat: bool,
    #[serde(alias = "forcePlayer", default)]
    pub force_player: bool,
    pub logging: LoggingConfig,
    pub screens: Vec<ScreenConfig>,
}

fn default_player_type() -> String { "mpv".to_string() }
fn default_quality() -> String { "best".to_string() }
fn default_volume() -> u8 { 50 }
fn default_max_streams() -> usize { 4 }
fn default_auto_start() -> bool { true }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LoggingConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_log_level")]
    pub level: String,
    #[serde(alias = "maxSizeMB", default = "default_max_size_mb")]
    pub max_size_mb: u32,
    #[serde(alias = "maxFiles", default = "default_max_files")]
    pub max_files: u32,
}

fn default_log_level() -> String { "info".to_string() }
fn default_max_size_mb() -> u32 { 50 }
fn default_max_files() -> u32 { 5 }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MpvConfig {
    #[serde(default = "default_mpv_path")]
    pub path: String,
    #[serde(default = "default_mpv_priority")]
    pub priority: String,
    #[serde(rename = "gpu-context", default = "default_gpu_context")]
    pub gpu_context: String,
    #[serde(default)]
    pub volume: u8,
    #[serde(default)]
    pub border: bool,
    #[serde(default)]
    pub fullscreen: bool,
    #[serde(default)]
    pub ontop: bool,
    #[serde(default)]
    pub pause: bool,
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub speed: f64,
    #[serde(default)]
    pub loop_: Option<String>,
    #[serde(rename = "audio-file", default)]
    pub audio_file: Option<String>,
    #[serde(default)]
    pub sub_file: Option<String>,
    #[serde(default)]
    pub sub_lang: Option<String>,
    #[serde(default)]
    pub vid: Option<String>,
    #[serde(default)]
    pub aid: Option<String>,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub cache: Option<i64>,
    #[serde(default)]
    pub cache_min: Option<i64>,
    #[serde(default)]
    pub cache_seek_min: Option<i64>,
    #[serde(default)]
    pub keep_open: bool,
    #[serde(default)]
    pub input_default_bindings: bool,
    #[serde(default)]
    pub input_terminal: bool,
    #[serde(rename = "osd-level", default)]
    pub osd_level: Option<u32>,
    #[serde(default)]
    pub force_window: bool,
    #[serde(default)]
    pub cursor: bool,
    #[serde(default)]
    pub no_cursor: bool,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

fn default_mpv_path() -> String { "mpv".to_string() }
fn default_streamlink_path() -> String { "streamlink".to_string() }
fn default_mpv_priority() -> String { "normal".to_string() }
fn default_gpu_context() -> String { "auto".to_string() }

impl MpvConfig {
    pub fn to_args(&self) -> Vec<String> {
        use std::collections::HashSet;
        let mut seen: HashSet<String> = HashSet::new();
        let mut args = vec![];

        macro_rules! add_arg {
            ($arg:expr) => {
                if seen.insert($arg.clone()) {
                    args.push($arg);
                }
            };
        }

        macro_rules! add_bool_arg {
            ($key:expr, $value:expr) => {
                if $value {
                    add_arg!(format!("--{}", $key));
                } else {
                    add_arg!(format!("--{}=no", $key));
                }
            };
        }

        add_bool_arg!("border", self.border);
        add_bool_arg!("fullscreen", self.fullscreen);
        add_bool_arg!("ontop", self.ontop);
        add_bool_arg!("pause", self.pause);
        add_bool_arg!("mute", self.mute);

        if self.speed > 0.0 && self.speed != 1.0 {
            add_arg!(format!("--speed={}", self.speed));
        }

        if let Some(ref loop_val) = self.loop_ {
            add_arg!(format!("--loop={}", loop_val));
        }

        if let Some(ref audio_file) = self.audio_file {
            add_arg!(format!("--audio-file={}", audio_file));
        }

        if let Some(ref sub_file) = self.sub_file {
            add_arg!(format!("--sub-file={}", sub_file));
        }

        if let Some(ref sub_lang) = self.sub_lang {
            add_arg!(format!("--sub-lang={}", sub_lang));
        }

        if let Some(ref vid) = self.vid {
            add_arg!(format!("--vid={}", vid));
        }

        if let Some(ref aid) = self.aid {
            add_arg!(format!("--aid={}", aid));
        }

        if let Some(ref sid) = self.sid {
            add_arg!(format!("--sid={}", sid));
        }

        if let Some(cache) = self.cache {
            add_arg!(format!("--cache={}", cache));
        }

        if let Some(cache_min) = self.cache_min {
            add_arg!(format!("--cache-min={}", cache_min));
        }

        if let Some(cache_seek_min) = self.cache_seek_min {
            add_arg!(format!("--cache-seek-min={}", cache_seek_min));
        }

        if self.keep_open {
            add_arg!("--keep-open".to_string());
        }

        add_bool_arg!("input-default-bindings", self.input_default_bindings);
        add_bool_arg!("input-terminal", self.input_terminal);

        if let Some(osd_level) = self.osd_level {
            add_arg!(format!("--osd-level={}", osd_level));
        }

        if self.force_window {
            add_arg!("--force-window".to_string());
        }

        if self.cursor {
            add_arg!("--cursor".to_string());
        }

        if self.no_cursor {
            add_arg!("--no-cursor".to_string());
        }

        for (key, value) in &self.extra {
            let arg = match value {
                serde_json::Value::Bool(b) => {
                    if *b { format!("--{}", key) } else { format!("--{}=no", key) }
                }
                serde_json::Value::Number(n) => format!("--{}={}", key, n),
                serde_json::Value::String(s) => format!("--{}={}", key, s),
                _ => continue,
            };
            add_arg!(arg);
        }

        args
    }
    
    fn value_to_arg(&self, key: &str, value: &serde_json::Value) -> Option<String> {
        match value {
            serde_json::Value::Bool(b) => {
                if *b {
                    Some(format!("--{}", key))
                } else {
                    Some(format!("--{}=no", key))
                }
            }
            serde_json::Value::Number(n) => {
                Some(format!("--{}={}", key, n))
            }
            serde_json::Value::String(s) => {
                Some(format!("--{}={}", key, s))
            }
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[allow(unused)]
pub struct StreamlinkConfig {
    #[serde(default = "default_streamlink_path")]
    pub path: String,
    #[serde(default)]
    pub options: HashMap<String, serde_json::Value>,
    #[serde(default)]
    pub http_header: HashMap<String, String>,
    #[serde(default)]
    pub mpv: MpvConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(unused)]
pub struct VlcConfig {
    #[serde(default = "default_vlc_path")]
    pub path: String,
    #[serde(default)]
    pub extra_args: Vec<String>,
}

fn default_vlc_path() -> String { "cvlc".to_string() }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FilterRule {
    #[serde(rename = "type", default)]
    pub rule_type: Option<String>,
    pub pattern: String,
    #[serde(default)]
    pub regex: bool,
    #[serde(default)]
    pub ignore_case: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ChannelFilter {
    pub name: String,
    #[serde(default)]
    pub english_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub exclude_titles: Vec<String>,
    #[serde(default)]
    pub exclude_titles_regex: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct FiltersConfig {
    #[serde(default = "default_filters_enabled")]
    pub enabled: bool,
    #[serde(default = "default_filter_mode")]
    pub mode: String,
    #[serde(default)]
    pub channel_names: Vec<String>,
    #[serde(default)]
    pub channel_names_regex: Vec<String>,
    #[serde(default)]
    pub title_patterns: Vec<String>,
    #[serde(default)]
    pub title_patterns_regex: Vec<String>,
    #[serde(default)]
    pub channels: Vec<ChannelFilter>,
    #[serde(default)]
    pub rules: Vec<FilterRule>,
    #[serde(default)]
    pub exclude_platforms: Vec<String>,
    #[serde(default = "default_filter_members_only")]
    pub filter_members_only: bool,
}

fn default_filters_enabled() -> bool { false }
fn default_filter_mode() -> String { "exclude".to_string() }
fn default_filter_members_only() -> bool { true }

impl FiltersConfig {
    pub fn matches_channel(&self, channel_name: &str) -> bool {
        if !self.enabled {
            return false;
        }

        let name_lower = channel_name.to_lowercase();

        let is_exclude_mode = self.mode == "exclude" || self.mode == "blacklist";

        for pattern in &self.channel_names {
            if name_lower.contains(&pattern.to_lowercase()) {
                return is_exclude_mode;
            }
        }

        for pattern in &self.channel_names_regex {
            if let Ok(re) = regex::Regex::new(&pattern) {
                if re.is_match(channel_name) {
                    return is_exclude_mode;
                }
            }
        }

        for channel in &self.channels {
            if channel.name.to_lowercase() == name_lower {
                return is_exclude_mode;
            }
            if let Some(ref en_name) = channel.english_name {
                if en_name.to_lowercase() == name_lower {
                    return is_exclude_mode;
                }
            }
            for alias in &channel.aliases {
                if alias.to_lowercase() == name_lower {
                    return is_exclude_mode;
                }
            }
        }

        !is_exclude_mode
    }

    pub fn matches_title(&self, title: &str) -> bool {
        if !self.enabled {
            return false;
        }

        let title_lower = title.to_lowercase();

        let is_exclude_mode = self.mode == "exclude" || self.mode == "blacklist";

        let matched_pattern = self.title_patterns.iter()
            .any(|p| title_lower.contains(&p.to_lowercase()));

        let matched_regex = self.title_patterns_regex.iter()
            .any(|p| regex::Regex::new(p).map(|re| re.is_match(title)).unwrap_or(false));

        let any_matched = matched_pattern || matched_regex;

        if any_matched {
            is_exclude_mode
        } else {
            !is_exclude_mode
        }
    }

    pub fn should_filter(&self, channel_name: &str, title: &str) -> bool {
        let channel_matches = self.channel_names.iter().any(|p| {
            channel_name.to_lowercase().contains(&p.to_lowercase())
        });

        let title_matches = self.title_patterns.iter().any(|p| {
            title.to_lowercase().contains(&p.to_lowercase())
        });

        channel_matches || title_matches
    }
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

    pub fn with_base_path(path: &str) -> Self {
        Self {
            config_dir: PathBuf::from(path),
        }
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

    let vlc: VlcConfig = self
        .try_load_json_file("vlc.json")
        .unwrap_or_else(|| self.default_vlc_config());

    let filters: FiltersConfig = self
            .try_load_json_file("filters.json")
            .unwrap_or_else(|| FiltersConfig::default());

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
youtube: {
        let yt_config_path = self.config_dir.join("yt.json");
        let yt_favorites: Vec<FavoriteChannel> = if yt_config_path.exists() {
            match FavoriteChannels::load_from_file(&yt_config_path) {
                Ok(fc) => fc.youtube.default.clone(),
                Err(e) => {
                    warn!("Failed to load yt.json: {}", e);
                    vec![]
                }
            }
        } else {
            vec![]
        };
        YoutubeConfig {
            api_key: if let Some(ref key) = env.youtube_api_key {
                key.clone()
            } else {
                main_config
                    .as_ref()
                    .and_then(|c| c.youtube.as_ref().map(|y| y.api_key.clone()))
                    .unwrap_or_default()
            },
            favorite_channels: yt_favorites,
        }
    },
kick: main_config
        .as_ref()
        .and_then(|c| c.kick.clone())
        .unwrap_or(KickConfig { enabled: true }),
    niconico: main_config
        .as_ref()
        .and_then(|c| c.niconico.clone())
        .unwrap_or(NiconicoConfig { enabled: true }),
    bilibili: main_config
        .as_ref()
        .and_then(|c| c.bilibili.clone())
        .unwrap_or(BilibiliConfig { enabled: true }),
    player,
        mpv,
        streamlink,
        vlc,
        filters,
    }
}

fn default_favorites(&self) -> FavoriteChannels {
    FavoriteChannels {
      holodex: PlatformFavorites { default: vec![] },
      twitch: PlatformFavorites { default: vec![] },
      youtube: PlatformFavorites { default: vec![] },
      kick: PlatformFavorites { default: vec![] },
      niconico: PlatformFavorites { default: vec![] },
      bilibili: PlatformFavorites { default: vec![] },
      facebook: PlatformFavorites { default: vec![] },
    }
  }

    fn default_player_config(&self) -> PlayerConfig {
        PlayerConfig {
            player_type: "mpv".to_string(),
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
                    sorting: Some(SortingConfig {
                        rules: Some(vec![SortRule {
                            field: "viewerCount".to_string(),
                            order: "desc".to_string(),
                            ignore: None,
                        }]),
                    }),
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
                    sorting: Some(SortingConfig {
                        rules: Some(vec![SortRule {
                            field: "viewerCount".to_string(),
                            order: "desc".to_string(),
                            ignore: None,
                        }]),
                    }),
                    refresh: 300,
                    auto_start: true,
                    skip_watched_streams: None,
                },
            ],
        }
    }

    fn default_mpv_config(&self) -> MpvConfig {
        MpvConfig {
            path: "mpv".to_string(),
            priority: "normal".to_string(),
            gpu_context: "auto".to_string(),
            extra: HashMap::new(),
            ..Default::default()
        }
    }

    fn default_streamlink_config(&self) -> StreamlinkConfig {
        StreamlinkConfig {
            path: "streamlink".to_string(),
            options: HashMap::new(),
            http_header: HashMap::new(),
            mpv: MpvConfig::default(),
        }
    }

    fn default_vlc_config(&self) -> VlcConfig {
        VlcConfig {
path: "vlc".to_string(),
    extra_args: vec![],
  }
  }

  pub fn save_json_file<T: Serialize>(&self, filename: &str, data: &T) -> Result<(), String> {
    let path = self.config_dir.join(filename);
    let content = serde_json::to_string_pretty(data)
      .map_err(|e| format!("Failed to serialize {}: {}", filename, e))?;
    fs::write(&path, content)
      .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    info!("Saved config file: {}", path.display());
    Ok(())
  }

  pub fn save_main_config(&self, config: &MainConfig) -> Result<(), String> {
    self.save_json_file("config.json", config)
  }
}

impl Default for ConfigLoader {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize, Clone)]
pub(crate) struct StreamEntry {
    pub id: u32,
    pub screen: u32,
    #[serde(default = "default_true_bool")]
    pub enabled: bool,
    #[serde(default)]
    pub sources: Vec<SourceConfig>,
    #[serde(default)]
    pub sorting: Option<SortingConfig>,
    #[serde(default)]
    pub refresh: Option<u32>,
    #[serde(default, alias = "autoStart")]
    pub auto_start: Option<bool>,
    #[serde(default, alias = "skipWatchedStreams")]
    pub skip_watched_streams: Option<bool>,
}

fn default_true_bool() -> bool { true }

#[derive(Debug, Deserialize)]
struct StreamsFile {
    #[serde(default, alias = "skipWatchedStreams")]
    pub skip_watched_streams: Option<bool>,
    #[serde(default, alias = "sorting")]
    pub sorting: Option<SortingConfig>,
    pub streams: Vec<StreamEntry>,
    #[serde(default)]
    pub organizations: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MainConfig {
  pub holodex: Option<HolodexConfig>,
  pub twitch: Option<TwitchConfig>,
  pub youtube: Option<YoutubeConfig>,
  pub kick: Option<KickConfig>,
  pub niconico: Option<NiconicoConfig>,
  pub bilibili: Option<BilibiliConfig>,
  pub facebook: Option<FacebookConfig>,
  pub player: Option<PlayerConfig>,
}