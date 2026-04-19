use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteChannels {
    pub holodex: PlatformFavorites,
    pub twitch: PlatformFavorites,
    pub youtube: PlatformFavorites,
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

        let legacy: LegacyFavorites = serde_json::from_str(&content)
            .map_err(|e| format!("Invalid favorites.json format: {}", e))?;

        let channels: Vec<FavoriteChannel> = legacy
            .urls
            .split_whitespace()
            .enumerate()
            .map(|(idx, url)| {
                let score = (1000 - idx) as u32;
                let id = url.to_string();
                let name = url
                    .trim_start_matches("https://")
                    .trim_start_matches("http://")
                    .trim_start_matches("www.")
                    .split('/')
                    .next()
                    .unwrap_or(&url)
                    .to_string();
                FavoriteChannel { id, name, score }
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
                default: channels,
            },
        })
    }
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
    }

    #[test]
    fn test_load_new_format() {
        let json = r#"{
            "holodex": {"default": [{"id": "UC1op", "name": "Test", "score": 100}]},
            "twitch": {"default": []},
            "youtube": {"default": []}
        }"#;
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(json.as_bytes()).unwrap();

        let result = FavoriteChannels::load_from_file(&file.path().to_path_buf());
        assert!(result.is_ok());
        assert_eq!(result.unwrap().holodex.default[0].score, 100);
    }
}