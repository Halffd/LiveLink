use serde::{Deserialize, Serialize};
use std::fs;

#[derive(Debug, Serialize, Deserialize)]
pub struct AppConfig {
    pub streams: Vec<StreamConfig>,
    pub mpv: MpvConfig,
    pub streamlink: StreamlinkConfig,
    pub favorites: Option<FavoritesConfig>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StreamConfig {
    pub id: u32,
    pub screen: u32,
    pub enabled: bool,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub volume: u8,
    pub quality: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MpvConfig {
    pub priority: String,
    #[serde(rename = "gpu-context")]
    pub gpu_context: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StreamlinkConfig {
    pub path: String,
    pub options: std::collections::HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FavoritesConfig {
    pub holodex: PlatformFavorites,
    pub twitch: PlatformFavorites,
    pub youtube: PlatformFavorites,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlatformFavorites {
    pub default: Vec<FavoriteChannel>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FavoriteChannel {
    pub id: String,
    pub name: String,
    pub score: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            streams: vec![
                StreamConfig {
                    id: 0,
                    screen: 0,
                    enabled: true,
                    width: 640,
                    height: 360,
                    x: 0,
                    y: 0,
                    volume: 50,
                    quality: "best".to_string(),
                },
                StreamConfig {
                    id: 1,
                    screen: 1,
                    enabled: true,
                    width: 640,
                    height: 360,
                    x: 640,
                    y: 0,
                    volume: 50,
                    quality: "best".to_string(),
                },
            ],
            mpv: MpvConfig {
                priority: "high".to_string(),
                gpu_context: "auto".to_string(),
            },
            streamlink: StreamlinkConfig {
                path: "streamlink".to_string(),
                options: std::collections::HashMap::new(),
            },
            favorites: None,
        }
    }
}

#[tauri::command]
pub fn get_config_path() -> Result<String, String> {
    let config_path = dirs::config_dir()
        .ok_or_else(|| "Could not find config directory".to_string())?
        .join("livelink")
        .join("config.json");

    // Create directory if it doesn't exist
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    Ok(config_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_config() -> Result<AppConfig, String> {
    let config_path = dirs::config_dir()
        .ok_or_else(|| "Could not find config directory".to_string())?
        .join("livelink")
        .join("config.json");

    if !config_path.exists() {
        // Return default config if file doesn't exist
        return Ok(AppConfig::default());
    }

    let content = fs::read_to_string(&config_path).map_err(|e| {
        format!("Failed to read config from {}: {}", config_path.display(), e)
    })?;

    serde_json::from_str(&content).map_err(|e| {
        format!("Failed to parse config: {}. Content: {}", e, &content[..content.len().min(500)])
    })
}

#[tauri::command]
pub fn write_config(config: AppConfig) -> Result<(), String> {
    let config_path = dirs::config_dir()
        .ok_or_else(|| "Could not find config directory".to_string())?
        .join("livelink")
        .join("config.json");

    // Create directory if it doesn't exist
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;

    fs::write(&config_path, content).map_err(|e| {
        format!("Failed to write config to {}: {}", config_path.display(), e)
    })?;

    log::info!("Config saved to {}", config_path.display());
    Ok(())
}