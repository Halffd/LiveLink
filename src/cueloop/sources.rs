//! Source handlers: turn a queue entry into something playable.
//!
//! Every source type is a handler that resolves an entry into a URL, a
//! duration and - when the media already carries captions - the subtitle
//! file to use as-is. Adding a new source type means adding one handler,
//! not touching the queue or the player.

use crate::cueloop::queue::QueueEntry;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A resolved, playable source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedSource {
    /// The url the player opens.
    pub url: String,
    /// The handler that produced this.
    pub source_type: String,
    /// Duration in seconds when it can be determined.
    pub duration: Option<f64>,
    /// Subtitle file that already exists for this media - no ASR needed.
    pub existing_subs: Option<String>,
    /// True when the media has no captions and needs transcription.
    pub needs_transcription: bool,
}

/// Resolves queue entries into playable sources.
pub trait SourceHandler: Send + Sync {
    /// The type name this handler owns ("local", "youtube", ...).
    fn source_type(&self) -> &str;

    /// Resolve one entry.
    fn resolve(&self, entry: &QueueEntry) -> Result<ResolvedSource, String>;
}

/// Local files: the first source type, and the one that needs no network.
pub struct LocalFileHandler {
    root: Option<PathBuf>,
}

impl LocalFileHandler {
    /// Handler for files under `root` (absolute paths allowed when
    /// `root` is None).
    pub fn new(root: Option<PathBuf>) -> Self {
        Self { root }
    }

    fn resolve_path(&self, path: &str) -> Result<PathBuf, String> {
        let candidate = PathBuf::from(path);
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            match &self.root {
                Some(root) => root.join(path),
                None => return Err(format!("relative path {path} needs a configured root")),
            }
        };
        if !candidate.exists() {
            return Err(format!("file not found: {}", candidate.display()));
        }
        Ok(candidate)
    }

    /// The subtitle file that sits next to the media, if any.
    fn adjacent_subs(media: &Path) -> Option<String> {
        let stem = media.file_stem()?.to_string_lossy().to_string();
        let candidates = [
            media.with_file_name(format!("{stem}.srt")),
            media.with_file_name(format!("{stem}.vtt")),
            media.with_file_name(format!("{stem}.ass")),
        ];
        candidates
            .iter()
            .find(|p| p.exists())
            .map(|p| p.to_string_lossy().to_string())
    }
}

impl SourceHandler for LocalFileHandler {
    fn source_type(&self) -> &str {
        "local"
    }

    fn resolve(&self, entry: &QueueEntry) -> Result<ResolvedSource, String> {
        let path = self.resolve_path(&entry.source.url)?;
        let subs = Self::adjacent_subs(&path);
        Ok(ResolvedSource {
            url: format!("file://{}", path.display()),
            source_type: self.source_type().to_string(),
            duration: None,
            existing_subs: subs.clone(),
            needs_transcription: subs.is_none(),
        })
    }
}

/// The handlers the daemon knows about.
#[derive(Default)]
pub struct HandlerRegistry {
    handlers: Vec<Box<dyn SourceHandler>>,
}

impl HandlerRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a handler.
    pub fn register(&mut self, handler: Box<dyn SourceHandler>) {
        self.handlers.push(handler);
    }

    /// The handler for a source type.
    pub fn get(&self, source_type: &str) -> Option<&dyn SourceHandler> {
        self.handlers
            .iter()
            .find(|h| h.source_type() == source_type)
            .map(|h| h.as_ref())
    }

    /// The handler for an entry, guessed from the entry's platform or url.
    pub fn for_entry(&self, entry: &QueueEntry) -> Option<&dyn SourceHandler> {
        if let Some(platform) = entry.source.platform.as_deref() {
            if let Some(handler) = self.get(platform) {
                return Some(handler);
            }
        }
        if entry.source.url.starts_with("file://") || Path::new(&entry.source.url).exists() {
            return self.get("local");
        }
        self.handlers.first().map(|h| h.as_ref())
    }

    /// Every registered source type.
    pub fn types(&self) -> Vec<&str> {
        self.handlers.iter().map(|h| h.source_type()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::queue::queue::StreamSource;

    fn entry(url: &str) -> QueueEntry {
        QueueEntry {
            id: 1,
            source: StreamSource {
                url: url.to_string(),
                ..Default::default()
            },
            pinned: false,
            added_at: 0,
            content_hash: None,
            target_language: None,
        }
    }

    #[test]
    fn local_file_without_subs_needs_transcription() {
        let dir = std::env::temp_dir().join("cueloop-src-test");
        std::fs::create_dir_all(&dir).unwrap();
        let media = dir.join("clip.mp4");
        std::fs::write(&media, b"video").unwrap();
        let handler = LocalFileHandler::new(Some(dir.clone()));
        let resolved = handler.resolve(&entry("clip.mp4")).unwrap();
        assert_eq!(resolved.url, format!("file://{}", media.display()));
        assert!(resolved.existing_subs.is_none());
        assert!(resolved.needs_transcription);
        let _ = std::fs::remove_file(&media);
    }

    #[test]
    fn local_file_with_adjacent_srt_uses_it() {
        let dir = std::env::temp_dir().join("cueloop-src-test-subs");
        std::fs::create_dir_all(&dir).unwrap();
        let media = dir.join("clip.mkv");
        let subs = dir.join("clip.srt");
        std::fs::write(&media, b"video").unwrap();
        std::fs::write(&subs, b"1\n00:00:00,000 --> 00:00:01,000\nhi\n").unwrap();
        let handler = LocalFileHandler::new(Some(dir.clone()));
        let resolved = handler.resolve(&entry("clip.mkv")).unwrap();
        assert_eq!(
            resolved.existing_subs.as_deref(),
            Some(subs.to_str().unwrap())
        );
        assert!(!resolved.needs_transcription);
        let _ = std::fs::remove_file(&media);
        let _ = std::fs::remove_file(&subs);
    }

    #[test]
    fn missing_file_is_an_error() {
        let handler = LocalFileHandler::new(None);
        assert!(handler.resolve(&entry("/nope/missing.mp4")).is_err());
    }

    #[test]
    fn registry_picks_the_handler_by_platform() {
        let mut registry = HandlerRegistry::new();
        registry.register(Box::new(LocalFileHandler::new(None)));
        assert_eq!(registry.types(), vec!["local"]);
        let mut e = entry("x.mp4");
        e.source.platform = Some("local".to_string());
        assert!(registry.for_entry(&e).is_some());
    }
}
