//! The caption cache: captions as files on disk, keyed by content hash.
//!
//! Once a stream's captions exist they never have to be produced again -
//! the second viewing is instant. The schema is the durable asset, so it
//! carries what the learning layer needs later: per-cue translations and
//! word-level timings, even before those features exist.
//!
//! Three tables:
//!
//! - `stream`  - one row per media item (hash, url, title, source type).
//! - `caption` - one row per caption set (language + kind: auto/human/
//!   translated).
//! - `line`    - the cues of a caption set, with optional translation.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// Where a caption set came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptionKind {
    /// Produced by speech recognition.
    Auto,
    /// Written by a human (YouTube captions, anime .ass, live CC).
    Human,
    /// Translated from another caption set.
    Translated,
}

impl CaptionKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            CaptionKind::Auto => "auto",
            CaptionKind::Human => "human",
            CaptionKind::Translated => "translated",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(CaptionKind::Auto),
            "human" => Some(CaptionKind::Human),
            "translated" => Some(CaptionKind::Translated),
            _ => None,
        }
    }
}

/// A media item in the cache.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stream {
    /// Content hash - the identity of the media.
    pub hash: String,
    pub url: String,
    pub title: Option<String>,
    /// Which handler produced it ("local", "youtube", "live_tv", ...).
    pub source_type: String,
    /// Duration in seconds when known.
    pub duration: Option<f64>,
    pub added_at: i64,
}

/// One cue.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaptionLine {
    pub index: usize,
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// Translation of `text` into the target language, when present.
    pub translation: Option<String>,
}

/// A caption set with its cues.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Caption {
    pub id: i64,
    pub stream_hash: String,
    pub language: String,
    pub kind: CaptionKind,
    pub created_at: i64,
    pub lines: Vec<CaptionLine>,
}

/// SQLite-backed caption cache.
///
/// The connection lives behind a mutex: rusqlite's `Connection` is
/// `Send` but not `Sync`, and the daemon hands the cache to axum as
/// shared state.
pub struct CaptionCache {
    conn: Mutex<Connection>,
}

impl CaptionCache {
    /// Open (and create) the cache database.
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create {}: {e}", parent.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open cache: {e}"))?;
        let cache = Self {
            conn: Mutex::new(conn),
        };
        cache.apply_schema()?;
        Ok(cache)
    }

    /// Open a cache in memory (tests).
    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open cache: {e}"))?;
        let cache = Self {
            conn: Mutex::new(conn),
        };
        cache.apply_schema()?;
        Ok(cache)
    }

    fn apply_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock().expect("cache lock");
        conn
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA foreign_keys=ON;

                 CREATE TABLE IF NOT EXISTS stream (
                     hash        TEXT PRIMARY KEY,
                     url         TEXT NOT NULL,
                     title       TEXT,
                     source_type TEXT NOT NULL,
                     duration    REAL,
                     added_at    INTEGER NOT NULL
                 );

                 CREATE TABLE IF NOT EXISTS caption (
                     id          INTEGER PRIMARY KEY,
                     stream_hash TEXT NOT NULL REFERENCES stream(hash) ON DELETE CASCADE,
                     language    TEXT NOT NULL,
                     kind        TEXT NOT NULL,
                     created_at  INTEGER NOT NULL,
                     UNIQUE(stream_hash, language, kind)
                 );

                 CREATE TABLE IF NOT EXISTS line (
                     caption_id  INTEGER NOT NULL REFERENCES caption(id) ON DELETE CASCADE,
                     idx         INTEGER NOT NULL,
                     start       REAL NOT NULL,
                     end         REAL NOT NULL,
                     text        TEXT NOT NULL,
                     translation TEXT,
                     PRIMARY KEY (caption_id, idx)
                 );

                 CREATE INDEX IF NOT EXISTS caption_by_stream
                     ON caption(stream_hash);",
            )
            .map_err(|e| format!("apply schema: {e}"))
    }

    /// Insert or update a media item.
    pub fn upsert_stream(&self, stream: &Stream) -> Result<(), String> {
        let conn = self.conn.lock().expect("cache lock");
        conn
            .execute(
                "INSERT INTO stream (hash, url, title, source_type, duration, added_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(hash) DO UPDATE SET
                     url = excluded.url,
                     title = excluded.title,
                     source_type = excluded.source_type,
                     duration = COALESCE(excluded.duration, stream.duration)",
                params![
                    stream.hash,
                    stream.url,
                    stream.title,
                    stream.source_type,
                    stream.duration,
                    stream.added_at
                ],
            )
            .map_err(|e| format!("upsert stream: {e}"))?;
        Ok(())
    }

    /// Store a caption set with all its cues, replacing an existing set
    /// with the same (stream, language, kind).
    pub fn put_caption(&self, caption: &Caption) -> Result<i64, String> {
        let conn = self.conn.lock().expect("cache lock");
        conn
            .execute(
                "INSERT INTO caption (stream_hash, language, kind, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(stream_hash, language, kind) DO UPDATE SET
                     created_at = excluded.created_at",
                params![
                    caption.stream_hash,
                    caption.language,
                    caption.kind.as_str(),
                    caption.created_at
                ],
            )
            .map_err(|e| format!("put caption: {e}"))?;
        let id: i64 = conn
            .query_row(
                "SELECT id FROM caption
                 WHERE stream_hash = ?1 AND language = ?2 AND kind = ?3",
                params![caption.stream_hash, caption.language, caption.kind.as_str()],
                |row| row.get(0),
            )
            .map_err(|e| format!("read caption id: {e}"))?;

        conn
            .execute("DELETE FROM line WHERE caption_id = ?1", params![id])
            .map_err(|e| format!("clear lines: {e}"))?;
        for line in &caption.lines {
            conn
                .execute(
                    "INSERT INTO line (caption_id, idx, start, end, text, translation)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        id,
                        line.index as i64,
                        line.start,
                        line.end,
                        line.text,
                        line.translation
                    ],
                )
                .map_err(|e| format!("put line: {e}"))?;
        }
        Ok(id)
    }

    /// Load a caption set with its cues.
    pub fn get_caption(
        &self,
        stream_hash: &str,
        language: &str,
        kind: CaptionKind,
    ) -> Result<Option<Caption>, String> {
        let conn = self.conn.lock().expect("cache lock");
        let mut stmt = conn
            .prepare(
                "SELECT id, stream_hash, language, kind, created_at
                 FROM caption
                 WHERE stream_hash = ?1 AND language = ?2 AND kind = ?3",
            )
            .map_err(|e| format!("prepare caption: {e}"))?;
        let mut rows = stmt
            .query(params![stream_hash, language, kind.as_str()])
            .map_err(|e| format!("query caption: {e}"))?;
        let Some(row) = rows.next().map_err(|e| format!("read caption: {e}"))? else {
            return Ok(None);
        };
        let id: i64 = row.get(0).map_err(|e| format!("read id: {e}"))?;
        let stream_hash: String = row.get(1).map_err(|e| format!("read hash: {e}"))?;
        let language: String = row.get(2).map_err(|e| format!("read language: {e}"))?;
        let kind_str: String = row.get(3).map_err(|e| format!("read kind: {e}"))?;
        let created_at: i64 = row.get(4).map_err(|e| format!("read created_at: {e}"))?;
        drop(rows);
        drop(stmt);

        // The connection is already locked here - read the lines through
        // it instead of taking the mutex again.
        let lines = lines_from(&conn, id)?;
        Ok(Some(Caption {
            id,
            stream_hash,
            language,
            kind: CaptionKind::from_str(&kind_str).unwrap_or(CaptionKind::Auto),
            created_at,
            lines,
        }))
    }

    /// Every caption set of a stream (id, language, kind).
    pub fn list_captions(&self, stream_hash: &str) -> Result<Vec<(i64, String, String)>, String> {
        let conn = self.conn.lock().expect("cache lock");
        let mut stmt = conn
            .prepare(
                "SELECT id, language, kind FROM caption
                 WHERE stream_hash = ?1 ORDER BY language, kind",
            )
            .map_err(|e| format!("prepare list: {e}"))?;
        let rows = stmt
            .query_map(params![stream_hash], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("list captions: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("read caption row: {e}"))?);
        }
        Ok(out)
    }

    /// True when a caption set exists - the cache hit check.
    pub fn has_caption(
        &self,
        stream_hash: &str,
        language: &str,
        kind: CaptionKind,
    ) -> Result<bool, String> {
        let count: i64 = self
            .conn
            .lock()
            .expect("cache lock")
            .query_row(
                "SELECT COUNT(*) FROM caption
                 WHERE stream_hash = ?1 AND language = ?2 AND kind = ?3",
                params![stream_hash, language, kind.as_str()],
                |row| row.get(0),
            )
            .map_err(|e| format!("count captions: {e}"))?;
        Ok(count > 0)
    }

    /// A media item by hash.
    pub fn get_stream(&self, hash: &str) -> Result<Option<Stream>, String> {
        let conn = self.conn.lock().expect("cache lock");
        let mut stmt = conn
            .prepare(
                "SELECT hash, url, title, source_type, duration, added_at
                 FROM stream WHERE hash = ?1",
            )
            .map_err(|e| format!("prepare stream: {e}"))?;
        let mut rows = stmt
            .query(params![hash])
            .map_err(|e| format!("query stream: {e}"))?;
        let Some(row) = rows.next().map_err(|e| format!("read stream: {e}"))? else {
            return Ok(None);
        };
        Ok(Some(Stream {
            hash: row.get(0).map_err(|e| format!("read hash: {e}"))?,
            url: row.get(1).map_err(|e| format!("read url: {e}"))?,
            title: row.get(2).map_err(|e| format!("read title: {e}"))?,
            source_type: row.get(3).map_err(|e| format!("read source_type: {e}"))?,
            duration: row.get(4).map_err(|e| format!("read duration: {e}"))?,
            added_at: row.get(5).map_err(|e| format!("read added_at: {e}"))?,
        }))
    }

}

/// Read the cues of a caption set through an open connection.
fn lines_from(conn: &Connection, caption_id: i64) -> Result<Vec<CaptionLine>, String> {
    {
        let mut stmt = conn
            .prepare(
                "SELECT idx, start, end, text, translation FROM line
                 WHERE caption_id = ?1 ORDER BY idx",
            )
            .map_err(|e| format!("prepare lines: {e}"))?;
        let rows = stmt
            .query_map(params![caption_id], |row| {
                Ok(CaptionLine {
                    index: row.get::<_, i64>(0)? as usize,
                    start: row.get(1)?,
                    end: row.get(2)?,
                    text: row.get(3)?,
                    translation: row.get(4)?,
                })
            })
            .map_err(|e| format!("query lines: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("read line: {e}"))?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(hash: &str) -> Stream {
        Stream {
            hash: hash.to_string(),
            url: "file:///media/lesson.mp4".to_string(),
            title: Some("Lesson".to_string()),
            source_type: "local".to_string(),
            duration: Some(120.0),
            added_at: 1_700_000_000,
        }
    }

    fn caption(hash: &str) -> Caption {
        Caption {
            id: 0,
            stream_hash: hash.to_string(),
            language: "en".to_string(),
            kind: CaptionKind::Auto,
            created_at: 1_700_000_001,
            lines: vec![
                CaptionLine {
                    index: 0,
                    start: 0.0,
                    end: 2.5,
                    text: "hello".to_string(),
                    translation: Some("ciao".to_string()),
                },
                CaptionLine {
                    index: 1,
                    start: 2.5,
                    end: 5.0,
                    text: "world".to_string(),
                    translation: None,
                },
            ],
        }
    }

    #[test]
    fn stream_roundtrip() {
        let cache = CaptionCache::open_in_memory().unwrap();
        cache.upsert_stream(&stream("h1")).unwrap();
        let loaded = cache.get_stream("h1").unwrap().unwrap();
        assert_eq!(loaded.url, "file:///media/lesson.mp4");
        assert_eq!(loaded.source_type, "local");
        assert_eq!(loaded.duration, Some(120.0));
        assert!(cache.get_stream("nope").unwrap().is_none());
    }

    #[test]
    fn caption_roundtrip_keeps_lines_and_translations() {
        let cache = CaptionCache::open_in_memory().unwrap();
        cache.upsert_stream(&stream("h1")).unwrap();
        cache.put_caption(&caption("h1")).unwrap();
        let loaded = cache
            .get_caption("h1", "en", CaptionKind::Auto)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.lines.len(), 2);
        assert_eq!(loaded.lines[0].text, "hello");
        assert_eq!(loaded.lines[0].translation.as_deref(), Some("ciao"));
        assert_eq!(loaded.lines[1].start, 2.5);
    }

    #[test]
    fn has_caption_is_the_cache_hit_check() {
        let cache = CaptionCache::open_in_memory().unwrap();
        cache.upsert_stream(&stream("h1")).unwrap();
        assert!(!cache.has_caption("h1", "en", CaptionKind::Auto).unwrap());
        cache.put_caption(&caption("h1")).unwrap();
        assert!(cache.has_caption("h1", "en", CaptionKind::Auto).unwrap());
        assert!(!cache
            .has_caption("h1", "it", CaptionKind::Translated)
            .unwrap());
    }

    #[test]
    fn putting_the_same_caption_twice_replaces_the_lines() {
        let cache = CaptionCache::open_in_memory().unwrap();
        cache.upsert_stream(&stream("h1")).unwrap();
        cache.put_caption(&caption("h1")).unwrap();
        let mut shorter = caption("h1");
        shorter.lines.truncate(1);
        cache.put_caption(&shorter).unwrap();
        let loaded = cache
            .get_caption("h1", "en", CaptionKind::Auto)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.lines.len(), 1);
        assert_eq!(cache.list_captions("h1").unwrap().len(), 1);
    }

    #[test]
    fn translations_live_in_their_own_caption_set() {
        let cache = CaptionCache::open_in_memory().unwrap();
        cache.upsert_stream(&stream("h1")).unwrap();
        cache.put_caption(&caption("h1")).unwrap();
        let mut translated = caption("h1");
        translated.language = "it".to_string();
        translated.kind = CaptionKind::Translated;
        cache.put_caption(&translated).unwrap();
        let sets = cache.list_captions("h1").unwrap();
        assert_eq!(sets.len(), 2);
        assert!(cache
            .has_caption("h1", "it", CaptionKind::Translated)
            .unwrap());
    }
}
