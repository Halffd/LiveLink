use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteChannels {
    pub holodex: PlatformFavorites,
    pub twitch: PlatformFavorites,
    pub youtube: PlatformFavorites,
    pub kick: PlatformFavorites,
    pub niconico: PlatformFavorites,
    pub bilibili: PlatformFavorites,
    #[serde(default)]
    pub facebook: PlatformFavorites,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformFavorites {
    pub default: Vec<FavoriteChannel>,
}

impl Default for PlatformFavorites {
    fn default() -> Self {
        Self { default: vec![] }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteChannel {
    pub id: String,
    pub name: String,
    pub score: u32,
}

#[derive(Deserialize)]
struct PlatformFavoritesRaw {
    #[serde(default)]
    default: Vec<FavoriteChannel>,
    #[serde(default)]
    channels: Vec<FavoriteChannel>,
    #[serde(default)]
    ids: Vec<String>,
}

impl From<Vec<String>> for PlatformFavorites {
    fn from(ids: Vec<String>) -> Self {
        let channels: Vec<FavoriteChannel> = ids
            .into_iter()
            .enumerate()
            .map(|(idx, id)| FavoriteChannel {
                id: id.clone(),
                name: id,
                score: (1000 - idx) as u32,
            })
            .collect();
        Self { default: channels }
    }
}

impl From<PlatformFavoritesRaw> for PlatformFavorites {
    fn from(raw: PlatformFavoritesRaw) -> Self {
        let mut all_channels: Vec<FavoriteChannel> = Vec::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        for ch in raw.default {
            if seen_ids.insert(ch.id.clone()) {
                all_channels.push(ch);
            }
        }
        for ch in raw.channels {
            if seen_ids.insert(ch.id.clone()) {
                all_channels.push(ch);
            }
        }

        let start_score = all_channels.len();
        for (idx, id) in raw.ids.into_iter().enumerate() {
            if seen_ids.insert(id.clone()) {
                all_channels.push(FavoriteChannel {
                    id: id.clone(),
                    name: id,
                    score: (1000 - start_score - idx) as u32,
                });
            }
        }

        all_channels.sort_by(|a, b| b.score.cmp(&a.score));
        Self { default: all_channels }
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum PlatformFavoritesInput {
    Array(Vec<String>),
    Raw(PlatformFavoritesRaw),
}

impl<'de> Deserialize<'de> for PlatformFavorites {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let input = PlatformFavoritesInput::deserialize(deserializer)?;
        match input {
            PlatformFavoritesInput::Array(ids) => Ok(PlatformFavorites::from(ids)),
            PlatformFavoritesInput::Raw(raw) => Ok(PlatformFavorites::from(raw)),
        }
    }
}

impl FavoriteChannels {
    pub fn load_from_file(path: &PathBuf) -> Result<Self, String> {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

        if let Ok(standard) = serde_json::from_str::<Self>(&content) {
            return Ok(standard);
        }

        if let Ok(urls) = serde_json::from_str::<Vec<String>>(&content) {
            return Ok(from_url_array(urls));
        }

        let legacy: LegacyFavorites =
            serde_json::from_str(&content).map_err(|e| format!("Invalid favorites.json format: {}", e))?;

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
                default: channels.clone(),
            },
            niconico: PlatformFavorites {
                default: channels.clone(),
            },
            bilibili: PlatformFavorites {
                default: channels,
            },
            facebook: PlatformFavorites {
                default: vec![],
            },
        })
    }
}

fn from_url_array(urls: Vec<String>) -> FavoriteChannels {
    let channels: Vec<FavoriteChannel> = urls
        .into_iter()
        .enumerate()
        .map(|(idx, url)| FavoriteChannel {
            id: url.clone(),
            name: extract_name_from_url(&url),
            score: (1000 - idx) as u32,
        })
        .collect();

    FavoriteChannels {
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
            default: channels.clone(),
        },
        niconico: PlatformFavorites {
            default: channels.clone(),
        },
        bilibili: PlatformFavorites {
            default: channels,
        },
        facebook: PlatformFavorites {
            default: vec![],
        },
    }
}

impl Default for FavoriteChannels {
    fn default() -> Self {
        Self {
            holodex: PlatformFavorites { default: vec![] },
            twitch: PlatformFavorites { default: vec![] },
            youtube: PlatformFavorites { default: vec![] },
            kick: PlatformFavorites { default: vec![] },
            niconico: PlatformFavorites { default: vec![] },
            bilibili: PlatformFavorites { default: vec![] },
            facebook: PlatformFavorites { default: vec![] },
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
    segments
        .iter()
        .rev()
        .copied()
        .find(|s| !s.is_empty())
        .unwrap_or(url)
        .to_string()
}

#[derive(Deserialize)]
struct LegacyFavorites {
    urls: String,
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
        assert_eq!(favs.niconico.default.len(), 2);
        assert_eq!(favs.bilibili.default.len(), 2);
    }

    #[test]
    fn test_load_new_format() {
        let json = r#"{
  "holodex": {"default": [{"id": "UC1op", "name": "Test", "score": 100}]},
  "twitch": {"default": []},
  "youtube": {"default": []},
  "kick": {"default": []},
  "niconico": {"default": []},
  "bilibili": {"default": []},
  "facebook": {"default": []}
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
        assert_eq!(favs.niconico.default.len(), 3);
        assert_eq!(favs.bilibili.default.len(), 3);
        assert_eq!(favs.twitch.default[0].id, "https://twitch.tv/xqc");
        assert_eq!(favs.twitch.default[0].score, 1000);
        assert_eq!(favs.youtube.default[1].name, "ludwig");
        assert_eq!(favs.kick.default[2].name, "snk");
        assert_eq!(favs.twitch.default[2].score, 998);
    }

    #[test]
    fn test_twitch_ids_array_format() {
        let json = r#"{
  "twitch": ["amemiyanazuna", "nekoko88", "sakuramiko_hololive"],
  "holodex": {"default": []},
  "youtube": {"default": []},
  "kick": {"default": []},
  "niconico": {"default": []},
  "bilibili": {"default": []},
  "facebook": {"default": []}
}"#;
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(json.as_bytes()).unwrap();

        let result = FavoriteChannels::load_from_file(&file.path().to_path_buf());
        assert!(result.is_ok());

        let favs = result.unwrap();
        assert_eq!(favs.twitch.default.len(), 3);
        assert_eq!(favs.twitch.default[0].id, "amemiyanazuna");
        assert_eq!(favs.twitch.default[0].score, 1000);
        assert_eq!(favs.twitch.default[1].id, "nekoko88");
        assert_eq!(favs.twitch.default[1].score, 999);
    }

    #[test]
    fn test_merge_ids_and_channels() {
        let json = r#"{
  "twitch": {
    "default": [{"id": "amemiyanazuna", "name": "Amemiya Nazuna", "score": 100}],
    "ids": ["nekoko88", "sakuramiko_hololive"]
  },
  "holodex": {"default": []},
  "youtube": {"default": []},
  "kick": {"default": []},
  "niconico": {"default": []},
  "bilibili": {"default": []},
  "facebook": {"default": []}
}"#;
        let mut file = NamedTempFile::new().unwrap();
        file.write_all(json.as_bytes()).unwrap();

        let result = FavoriteChannels::load_from_file(&file.path().to_path_buf());
        assert!(result.is_ok());

        let favs = result.unwrap();
        assert_eq!(favs.twitch.default.len(), 3);
        assert_eq!(favs.twitch.default[0].id, "nekoko88");
        assert_eq!(favs.twitch.default[0].score, 999);
        assert_eq!(favs.twitch.default[1].id, "sakuramiko_hololive");
        assert_eq!(favs.twitch.default[1].score, 998);
        assert_eq!(favs.twitch.default[2].id, "amemiyanazuna");
        assert_eq!(favs.twitch.default[2].score, 100);
    }
}