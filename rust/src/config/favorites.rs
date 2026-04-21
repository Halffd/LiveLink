use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteChannels {
    pub holodex: PlatformFavorites,
    pub twitch: PlatformFavorites,
    pub youtube: PlatformFavorites,
    pub kick: PlatformFavorites,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlatformFavorites {
    pub default: Vec<FavoriteChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteChannel {
    pub id: String,
    pub name: String,
    pub score: u32,
}

impl FavoriteChannels {
    pub fn load_from_file(path: &PathBuf) -> Result<Self, String> {
        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        if let Ok(standard) = serde_json::from_str::<Self>(&content) {
            return Ok(standard);
        }

        if let Ok(urls) = serde_json::from_str::<Vec<String>>(&content) {
            return Ok(Self::from_url_array(urls));
        }

        let legacy: LegacyFavorites = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid favorites.json format: {}", e))?;

        let channels: Vec<FavoriteChannel> = legacy
            .urls
            .split_whitespace()
            .enumerate()
            .map(|(idx, url)| FavoriteChannel {
                id: url.to_string(),
                name: extract_name_from_url(url),
                score: (1000 - idx) as u32,
            })
            .collect();

        Ok(FavoriteChannels {
            holodex: PlatformFavorites {
                default: channels.clone(),
            },
            twitch: PlatformFavorites {
                default: channels.clone(),
            },
            youtube: PlatformFavorites {
                default: channels.clone(),
            },
            kick: PlatformFavorites {
                default: channels,
            },
        })
    }

    fn from_url_array(urls: Vec<String>) -> Self {
        let channels: Vec<FavoriteChannel> = urls
            .into_iter()
            .enumerate()
            .map(|(idx, url)| FavoriteChannel {
                id: url.clone(),
                name: extract_name_from_url(&url),
                score: (1000 - idx) as u32,
            })
            .collect();

        Self {
            holodex: PlatformFavorites {
                default: channels.clone(),
            },
            twitch: PlatformFavorites {
                default: channels.clone(),
            },
            youtube: PlatformFavorites {
                default: channels.clone(),
            },
            kick: PlatformFavorites {
                default: channels,
            },
        }
    }
}

fn extract_name_from_url(url: &str) -> String {
    let cleaned = url
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_start_matches("www.");

    if cleaned.contains('@') {
        return cleaned.split('@').nth(1).unwrap_or(url).to_string();
    }

    let segments: Vec<&str> = cleaned.split('/').collect();
    segments.iter().rev().copied().find(|s| !s.is_empty()).unwrap_or(url).to_string()
}

#[derive(Deserialize)]
struct LegacyFavorites {
    urls: String,
}

impl Default for FavoriteChannels {
    fn default() -> Self {
        Self {
            holodex: PlatformFavorites { default: vec![] },
            twitch: PlatformFavorites { default: vec![] },
            youtube: PlatformFavorites { default: vec![] },
            kick: PlatformFavorites { default: vec![] },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_load_legacy_urls_format() {
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(br#"{"urls": "https://twitch.tv/monstercat https://youtube.com/@ludwig"}"#)
            .unwrap();

        let result = FavoriteChannels::load_from_file(&file.path().to_path_buf());
        assert!(result.is_ok());

        let favs = result.unwrap();
        assert_eq!(favs.twitch.default.len(), 2);
        assert_eq!(favs.youtube.default.len(), 2);
        assert_eq!(favs.holodex.default.len(), 2);
        assert_eq!(favs.kick.default.len(), 2);
    }

    #[test]
    fn test_load_new_format() {
        let json = r#"{
            "holodex": {"default": [{"id": "UC1op", "name": "Test", "score": 100}]},
            "twitch": {"default": []},
            "youtube": {"default": []},
            "kick": {"default": []}
        }"#;
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(json.as_bytes()).unwrap();

        let result = FavoriteChannels::load_from_file(&file.path().to_path_buf());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().holodex.default[0].score, 100);
    }

    #[test]
    fn test_load_array_of_strings() {
        let json = r#"["https://twitch.tv/xqc", "https://youtube.com/@ludwig", "https://kick.com/snk"]"#;
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(json.as_bytes()).unwrap();

        let result = FavoriteChannels::load_from_file(&file.path().to_path_buf());
        assert!(result.is_ok());

        let favs = result.unwrap();
        assert_eq!(favs.twitch.default.len(), 3);
        assert_eq!(favs.youtube.default.len(), 3);
        assert_eq!(favs.holodex.default.len(), 3);
        assert_eq!(favs.kick.default.len(), 3);
        assert_eq!(favs.twitch.default[0].id, "https://twitch.tv/xqc");
        assert_eq!(favs.twitch.default[0].score, 1000);
        assert_eq!(favs.youtube.default[1].name, "ludwig");
        assert_eq!(favs.kick.default[2].name, "snk");
        assert_eq!(favs.twitch.default[2].score, 998);
    }
}