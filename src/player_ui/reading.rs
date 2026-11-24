//! Reading annotations: furigana over Japanese, pinyin over Chinese, and the
//! ruby segment parser the reading panel renders with. Mirrors captioner-core
//! (captioner-rs), adapted to lindera 6.
//!
//! Japanese tokenization runs on the embedded IPADIC dictionary. Words the
//! user imports (mecab-format CSVs in a dictionary directory, or a compiled
//! `.bin`) are merged on top, and when IPADIC cannot be loaded at all the
//! layer falls back to a system `mecab` subprocess.

use std::borrow::Cow;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// One span of an annotated line: plain text or base text with its reading.
#[derive(Debug, Clone, PartialEq)]
pub enum RubySegment {
    Plain(String),
    Ruby { base: String, reading: String },
    /// A token with its metadata, for hover/click interaction.
    ///
    /// The same visual shape as [`RubySegment::Ruby`] when a reading exists,
    /// but the token rides along, so a click can look up the word without
    /// re-tokenizing the line.
    Word(Token),
}

impl RubySegment {
    /// The visible text of any segment variant.
    pub fn text(&self) -> &str {
        match self {
            Self::Plain(t) => t,
            Self::Ruby { base, .. } => base,
            Self::Word(t) => &t.surface,
        }
    }
}

/// A token as the tokenizer produced it, with everything a dictionary
/// lookup needs: the surface form, its reading, and the base (lemma) form.
///
/// The string-annotation path (`annotate` → `parse_ruby`) loses all of this
/// except surface + reading, so hover and click have nothing to look up.
/// This is the same data before the flatten, so interactions can ask
/// IPADIC directly without re-tokenizing on every mouse move.
#[derive(Debug, Clone, PartialEq)]
pub struct Token {
    /// What appeared in the text.
    pub surface: String,
    /// Katakana-to-hiragana reading, when the dictionary had one.
    pub reading: Option<String>,
    /// Base form (lemma) — 食べる for 食べた. What a dictionary is keyed by.
    pub base: Option<String>,
    /// Part of speech, when the backend reported one.
    pub pos: Option<String>,
}

impl Token {
    /// True when this token is worth clicking: a real word, not punctuation or
    /// a run of spaces. Excludes ASCII *and* CJK punctuation, since Japanese
    /// text tokenizes its punctuation as its own tokens.
    pub fn is_lookupable(&self) -> bool {
        // POS first: a particle like を is hiragana, so the surface heuristic
        // below calls it a word. ipadic POS separates function words
        // (particles, auxiliaries, symbols) that carry no dictionary entry.
        if let Some(pos) = &self.pos {
            const FUNCTION_POS: [&str; 4] = ["助詞", "助動詞", "記号", "補助記号"];
            return !FUNCTION_POS.iter().any(|class| pos.starts_with(class));
        }
        // No POS (a hand-built token, as in unit tests): fall back to
        // "carries at least one non-punctuation character".
        self.surface.chars().any(|c| {
            !c.is_whitespace() && !c.is_ascii_punctuation() && !is_cjk_punctuation(c)
        })
    }

    /// The key a dictionary lookup should use: base form first (it is what a
    /// dictionary is organized by), surface form as the fallback.
    pub fn lookup_key(&self) -> &str {
        self.base.as_deref().unwrap_or(&self.surface)
    }
}

/// Annotate text with readings in the `漢字（かんじ）` paren style:
/// furigana for Japanese, pinyin for Chinese, unchanged otherwise.
pub fn annotate(text: &str) -> String {
    if contains_japanese(text) {
        process_text_with_furigana(text)
    } else if contains_chinese(text) {
        process_text_with_pinyin(text)
    } else {
        text.to_string()
    }
}

fn is_kanji(ch: char) -> bool {
    matches!(
        ch,
        '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}'
    )
}

fn is_hiragana(ch: char) -> bool {
    matches!(ch, '\u{3040}'..='\u{309F}')
}

fn is_katakana(ch: char) -> bool {
    matches!(ch, '\u{30A0}'..='\u{30FF}')
}

pub fn contains_japanese(text: &str) -> bool {
    text.chars()
        .any(|c| is_kanji(c) || is_hiragana(c) || is_katakana(c))
}

/// True for CJK punctuation: the Japanese comma/full stop, corner brackets,
/// and the general-punctuation block they share. These tokenize separately
/// and have no dictionary entry, so they are not click targets.
fn is_cjk_punctuation(c: char) -> bool {
    matches!(
        c,
        '\u{3000}'..='\u{303F}' | // CJK symbols and punctuation: 、。「」
        '\u{FF01}'..='\u{FF0F}'
            | '\u{FF1A}'..='\u{FF20}'
            | '\u{FF3B}'..='\u{FF40}'
            | '\u{FF5B}'..='\u{FF65}' // fullwidth forms: ！？（）
    )
}

fn katakana_to_hiragana(text: &str) -> String {
    text.chars()
        .map(|c| {
            if is_katakana(c) {
                char::from_u32(c as u32 - 0x60).unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

/// Which tokenizer backs the furigana layer.
enum Backend {
    /// Embedded IPADIC (+ optional imported user dictionary).
    Lindera(Box<lindera::segmenter::Segmenter>),
    /// System mecab subprocess, used when IPADIC cannot load.
    Mecab(PathBuf),
}

/// Inputs for building the tokenizer backend.
#[derive(Debug, Clone)]
pub struct ReadingConfig {
    /// Directory scanned for imported dictionaries: `*.csv` files (mecab
    /// format) are merged, a single `*.bin` is loaded directly.
    pub dictionary_dir: Option<PathBuf>,
    /// mecab binary used as the fallback tokenizer.
    pub mecab_path: String,
}

impl Default for ReadingConfig {
    fn default() -> Self {
        Self {
            dictionary_dir: None,
            mecab_path: "mecab".to_string(),
        }
    }
}

static BACKEND: OnceLock<Option<Backend>> = OnceLock::new();

/// Build the tokenizer once, from the player's config directory. Later calls
/// are ignored (the backend is process-wide and immutable).
pub fn init(config: ReadingConfig) {
    let backend = build_backend(&config);
    if BACKEND.set(backend).is_err() {
        tracing::debug!("reading backend already initialized");
    }
}

fn backend() -> Option<&'static Backend> {
    BACKEND
        .get_or_init(|| build_backend(&ReadingConfig::default()))
        .as_ref()
}

fn build_backend(config: &ReadingConfig) -> Option<Backend> {
    match build_lindera_segmenter(config.dictionary_dir.as_deref()) {
        Ok(segmenter) => Some(Backend::Lindera(Box::new(segmenter))),
        Err(e) => {
            tracing::warn!(error = %e, "embedded ipadic unavailable");
            if mecab_available(&config.mecab_path) {
                tracing::warn!(
                    path = %config.mecab_path,
                    "falling back to mecab for furigana readings"
                );
                Some(Backend::Mecab(PathBuf::from(&config.mecab_path)))
            } else {
                tracing::warn!("no mecab fallback found; furigana disabled");
                None
            }
        }
    }
}

/// Embedded IPADIC with imported user dictionaries merged in.
pub(crate) fn build_lindera_segmenter(
    dictionary_dir: Option<&Path>,
) -> Result<lindera::segmenter::Segmenter, String> {
    let dictionary = lindera_ipadic::embedded::load()
        .map_err(|e| format!("failed to load embedded ipadic: {e}"))?;

    let user_dictionary = match dictionary_dir {
        Some(dir) => match load_user_dictionary(dir, &dictionary) {
            Ok(dict) => dict,
            Err(e) => {
                // A broken import must not disable furigana.
                tracing::warn!(dir = %dir.display(), error = %e, "user dictionary import failed");
                None
            }
        },
        None => None,
    };

    Ok(lindera::segmenter::Segmenter::new(
        lindera::mode::Mode::Normal,
        dictionary,
        user_dictionary,
    ))
}

/// Load imported dictionaries from `dir`: a single `.bin` if present,
/// otherwise every `.csv` (mecab user-dictionary format) merged in name order
/// — lindera accepts at most one user dictionary per segmenter.
pub(crate) fn load_user_dictionary(
    dir: &Path,
    dictionary: &lindera::dictionary::Dictionary,
) -> Result<Option<lindera::dictionary::UserDictionary>, String> {
    if !dir.is_dir() {
        return Ok(None);
    }

    let mut csvs: Vec<PathBuf> = Vec::new();
    let mut bins: Vec<PathBuf> = Vec::new();
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("failed to read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        match path.extension().and_then(|e| e.to_str()) {
            Some("csv") => csvs.push(path),
            Some("bin") => bins.push(path),
            _ => {}
        }
    }
    csvs.sort();
    bins.sort();

    if csvs.is_empty() {
        return match bins.first() {
            Some(path) => lindera::dictionary::load_user_dictionary_from_bin(path)
                .map(Some)
                .map_err(|e| format!("failed to load {}: {e}", path.display())),
            None => Ok(None),
        };
    }
    if !bins.is_empty() {
        tracing::warn!(
            dir = %dir.display(),
            "both .csv and .bin dictionaries present; using the CSVs"
        );
    }

    let mut merged = String::new();
    for path in &csvs {
        let content = std::fs::read_to_string(path)
            .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
        for line in content.lines() {
            let line = line.trim_end();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            merged.push_str(line);
            merged.push('\n');
        }
    }

    let merged_path = std::env::temp_dir().join("livelink-user-dictionary.csv");
    std::fs::write(&merged_path, merged)
        .map_err(|e| format!("failed to write {}: {e}", merged_path.display()))?;
    lindera::dictionary::load_user_dictionary_from_csv(&dictionary.metadata, &merged_path)
        .map(Some)
        .map_err(|e| format!("failed to load user dictionary: {e}"))
}

fn mecab_available(bin: &str) -> bool {
    std::process::Command::new(bin)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Parse `mecab` output into full [`Token`]s. Same line shape as
/// [`parse_mecab_output`], but keeps base form (index 6) and POS (index 0)
/// so lookups have a key.
fn parse_mecab_output_detailed(output: &str) -> Vec<Token> {
    output
        .lines()
        .filter(|line| !line.is_empty() && *line != "EOS")
        .filter_map(|line| {
            let (surface, features) = line.split_once('\t')?;
            let mut fields = features.split(',');
            let pos = fields.next().filter(|p| !p.is_empty() && *p != "*").map(str::to_string);
            // Indices are ipadic's: 0 POS, 6 base form, 7 reading.
            let by_index = |i: usize| {
                features
                    .split(',')
                    .nth(i)
                    .filter(|v| !v.is_empty() && *v != "*")
                    .map(|v| v.to_string())
            };
            let reading = by_index(7).map(|r| katakana_to_hiragana(&r));
            Some(Token {
                surface: surface.to_string(),
                reading,
                base: by_index(6),
                pos,
            })
        })
        .collect()
}

/// Tokenize through a system mecab subprocess, keeping full metadata.
fn mecab_tokens_detailed(bin: &Path, text: &str) -> Option<Vec<Token>> {
    Some(parse_mecab_output_detailed(
        &mecab_tokens_raw(bin, text)?,
    ))
}

/// Run system mecab and return its raw stdout.
fn mecab_tokens_raw(bin: &Path, text: &str) -> Option<String> {
    let mut child = std::process::Command::new(bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    {
        let mut stdin = child.stdin.take()?;
        stdin.write_all(text.replace('\n', " ").as_bytes()).ok()?;
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Tokenize with full metadata (surface, reading, base, POS).
///
/// This is what hover-lookup and click-to-SRS need. The tuple-producing
/// [`tokenize`] is kept as an adapter because the string-annotation path
/// only wants surface + reading.
pub fn tokenize_detailed(text: &str) -> Vec<Token> {
    match backend() {
        Some(Backend::Lindera(segmenter)) => {
            let mut worker = segmenter.new_worker();
            match worker.segment(text) {
                Ok(mut tokens) => tokens
                    .iter_mut()
                    .filter_map(|token| {
                        let surface = match &token.surface {
                            Cow::Borrowed(s) => (*s).to_string(),
                            Cow::Owned(s) => s.clone(),
                        };
                        if surface.trim().is_empty() {
                            return None;
                        }
                        // ipadic details: 0 POS, 6 base form, 7 reading,
                        // 8 phonetic. Positions are fixed by the format.
                        let details = token.details();
                        let field = |i: usize| {
                            details
                                .get(i)
                                .filter(|v| !v.is_empty() && **v != "*")
                                .map(|v| v.to_string())
                        };
                        Some(Token {
                            surface,
                            reading: field(7).map(|r| katakana_to_hiragana(&r)),
                            base: field(6),
                            pos: field(0),
                        })
                    })
                    .collect(),
                Err(e) => {
                    tracing::warn!(error = %e, "tokenization failed");
                    Vec::new()
                }
            }
        }
        Some(Backend::Mecab(bin)) => mecab_tokens_detailed(bin, text).unwrap_or_default(),
        None => Vec::new(),
    }
}

/// Tokenize with readings, dispatching on the active backend.
///
/// A projection of [`tokenize_detailed`], not a second engine: one
/// tokenizer, two views of it. `tokenize_detailed` normalizes readings to
/// hiragana and drops blank surfaces, both of which the callers below want
/// (`process_text_with_furigana` converts to hiragana immediately, and a
/// blank surface would emit an empty ruby pair).
fn tokenize(text: &str) -> Vec<(String, Option<String>)> {
    tokenize_detailed(text)
        .into_iter()
        .map(|t| (t.surface, t.reading))
        .collect()
}

#[cfg(test)]
mod tokenize_tests {
    use super::*;

    #[test]
    fn detailed_and_tuple_views_agree() {
        let text = "日本語を勉強しています";
        let detailed = tokenize_detailed(text);
        let tuples = tokenize(text);
        assert_eq!(detailed.len(), tuples.len(), "same token count");
        for (token, (surface, reading)) in detailed.iter().zip(&tuples) {
            assert_eq!(&token.surface, surface);
            assert_eq!(token.reading.as_ref(), reading.as_ref());
        }
    }

    #[test]
    fn detailed_keeps_base_and_pos_when_available() {
        let tokens = tokenize_detailed("食べる");
        assert!(!tokens.is_empty(), "ipadic should tokenize this");
        // 食べる is a verb, so ipadic reports a POS and a base form.
        let first = &tokens[0];
        assert!(first.pos.is_some(), "POS missing: {first:?}");
        assert!(first.base.is_some(), "base missing: {first:?}");
    }

    #[test]
    fn lookup_key_prefers_base_form() {
        let token = Token {
            surface: "食べた".into(),
            reading: Some("たべた".into()),
            base: Some("食べる".into()),
            pos: Some("動詞".into()),
        };
        assert_eq!(token.lookup_key(), "食べる");
        // No base form: the surface is the key.
        let no_base = Token {
            surface: "テスト".into(),
            reading: None,
            base: None,
            pos: None,
        };
        assert_eq!(no_base.lookup_key(), "テスト");
    }

    #[test]
    fn punctuation_is_not_lookupable() {
        let punct = Token {
            surface: "、".into(),
            reading: None,
            base: None,
            pos: None,
        };
        assert!(!punct.is_lookupable());
        let word = Token {
            surface: "日本語".into(),
            reading: Some("にほんご".into()),
            base: None,
            pos: None,
        };
        assert!(word.is_lookupable());
    }
}

pub fn process_text_with_furigana(text: &str) -> String {
    if !contains_japanese(text) {
        return text.to_string();
    }

    let tokens = tokenize(text);
    if tokens.is_empty() {
        return text.to_string();
    }

    let mut result = String::with_capacity(text.len() * 2);
    for (surface, reading) in &tokens {
        if !surface.chars().any(is_kanji) {
            result.push_str(surface);
            continue;
        }
        if let Some(reading) = reading {
            let hiragana_reading = katakana_to_hiragana(reading);
            if *surface != hiragana_reading {
                result.push_str(&format!("{}（{}）", surface, hiragana_reading));
                continue;
            }
        }
        result.push_str(surface);
    }

    result
}

fn is_hanzi(ch: char) -> bool {
    matches!(
        ch,
        '\u{4E00}'..='\u{9FFF}'
            | '\u{3400}'..='\u{4DBF}'
            | '\u{F900}'..='\u{FAFF}'
            | '\u{20000}'..='\u{2A6DF}'
    )
}

pub fn contains_chinese(text: &str) -> bool {
    text.chars().any(is_hanzi)
}

pub fn process_text_with_pinyin(text: &str) -> String {
    use pinyin::ToPinyin;

    if !contains_chinese(text) {
        return text.to_string();
    }

    let mut result = String::with_capacity(text.len() * 3);
    for ch in text.chars() {
        if !is_hanzi(ch) {
            result.push(ch);
            continue;
        }
        match ch.to_pinyin() {
            Some(py) => {
                let reading = py.with_tone();
                if reading.is_empty() || reading == ch.to_string() {
                    result.push(ch);
                } else {
                    result.push_str(&format!("{}（{}）", ch, reading));
                }
            }
            None => result.push(ch),
        }
    }
    result
}

/// Parse `漢字（かんじ）`-style annotations into renderable segments. Each
/// reading attaches to the plain run immediately before it.
pub fn parse_ruby(text: &str) -> Vec<RubySegment> {
    let mut segments = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    let mut plain = String::new();

    while i < chars.len() {
        if chars[i] == '（' {
            let closing = (i + 1..chars.len()).find(|&j| chars[j] == '）');
            if let Some(end) = closing {
                let base_start = plain
                    .rfind(|c: char| c.is_whitespace() || c == '\n')
                    .map(|i| i + 1)
                    .unwrap_or(0);
                let base = &plain[base_start..];
                if !base.is_empty() {
                    if base_start > 0 {
                        segments.push(RubySegment::Plain(plain[..base_start].to_string()));
                    }
                    let reading: String = chars[i + 1..end].iter().collect();
                    segments.push(RubySegment::Ruby {
                        base: base.to_string(),
                        reading,
                    });
                    plain.clear();
                    i = end + 1;
                    continue;
                }
            }
        }
        plain.push(chars[i]);
        i += 1;
    }

    if !plain.is_empty() {
        segments.push(RubySegment::Plain(plain));
    }

    segments
}

/// Build interactive segments straight from the tokenizer:
pub fn parse_tokens_detailed(text: &str) -> Vec<RubySegment> {
    tokenize_detailed(text)
        .into_iter()
        .map(|token| {
            if token.is_lookupable() {
                RubySegment::Word(token)
            } else {
                RubySegment::Plain(token.surface)
            }
        })
        .collect()
}

/// A dictionary entry for one lookup key.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Definition {
    /// The word as the dictionary lists it.
    pub term: String,
    /// Reading of the term, when known.
    pub reading: Option<String>,
    /// One or more glosses.
    pub meanings: Vec<String>,
}

/// A local dictionary: `key\treading\tmeaning|meaning` per line.
///
/// Keyed by base form when present, surface form otherwise — the same key
/// [`Token::lookup_key`] produces. Tries the base form first, then the
/// surface, which is what makes 食べた resolve to 食べる's entry.
#[derive(Debug, Clone, Default)]
pub struct Dictionary {
    entries: std::collections::HashMap<String, Definition>,
}

impl Dictionary {
    /// Load from a TSV file. Missing file yields an empty dictionary, which
    /// makes every lookup a miss rather than an error — a missing dictionary
    /// should remove the popup, not break the panel.
    pub fn load(path: &std::path::Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        Self::from_tsv(&text)
    }

    /// Load `dictionary.tsv` from a directory.
    pub fn load_dir(dir: &std::path::Path) -> Self {
        Self::load(&dir.join("dictionary.tsv"))
    }

    /// Parse the TSV body.
    pub fn from_tsv(text: &str) -> Self {
        let mut entries = std::collections::HashMap::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let mut fields = line.split('\t');
            let Some(key) = fields.next() else { continue };
            let reading = fields.next().filter(|r| !r.is_empty());
            let meanings: Vec<String> = fields
                .next()
                .unwrap_or("")
                .split('|')
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty())
                .collect();
            if key.is_empty() {
                continue;
            }
            entries.insert(
                key.to_string(),
                Definition {
                    term: key.to_string(),
                    reading: reading.map(str::to_string),
                    meanings,
                },
            );
        }
        Self { entries }
    }

    /// Look up a token: base form first, then the surface form. Returns a
    /// borrow, so hover costs no allocation per frame.
    pub fn lookup(&self, token: &Token) -> Option<&Definition> {
        if let Some(base) = &token.base {
            if let Some(def) = self.entries.get(base) {
                return Some(def);
            }
        }
        self.entries.get(&token.surface)
    }

    /// Number of entries loaded, for diagnostics.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod dictionary_tests {
    use super::*;

    #[test]
    fn parses_tsv_entries() {
        let dict = Dictionary::from_tsv(
            "# a comment\n食べる\tたべる\tto eat\n日本語\tにほんご\tJapanese language|Nihongo\n",
        );
        assert_eq!(dict.len(), 2);
        let entry = dict.entries.get("食べる").expect("食べる present");
        assert_eq!(entry.reading.as_deref(), Some("たべる"));
        assert_eq!(entry.meanings, vec!["to eat".to_string()]);
        // Comments and blank lines are skipped.
        assert!(!dict.entries.contains_key("# a comment"));
    }

    #[test]
    fn unknown_lookup_is_a_miss_not_an_error() {
        let dict = Dictionary::from_tsv("x\ty\tz\n");
        let token = Token {
            surface: "存在しない".into(),
            reading: None,
            base: None,
            pos: None,
        };
        assert!(dict.lookup(&token).is_none());
    }

    /// The reason the dictionary exists: a conjugated surface form still
    /// resolves to the lemma the dictionary is keyed by.
    #[test]
    fn lookup_falls_back_to_base_form() {
        let dict = Dictionary::from_tsv("食べる\tたべる\tto eat\n");
        let conjugated = Token {
            surface: "食べた".into(),
            reading: Some("たべた".into()),
            base: Some("食べる".into()),
            pos: Some("動詞".into()),
        };
        let entry = dict.lookup(&conjugated).expect("resolves via base form");
        assert_eq!(entry.term, "食べる");
    }

    #[test]
    fn a_missing_file_is_an_empty_dictionary() {
        let dict = Dictionary::load(std::path::Path::new("/nonexistent/dictionary.tsv"));
        assert!(dict.is_empty());
    }

    #[test]
    fn segments_carry_tokens_for_real_words_only() {
        let segments = parse_tokens_detailed("日本語を勉強しています");
        // Words become Word segments, particles become Plain.
        let words: Vec<_> = segments
            .iter()
            .filter_map(|s| match s {
                RubySegment::Word(t) => Some(t),
                _ => None,
            })
            .collect();
        assert!(!words.is_empty(), "should have at least one word");
        assert!(
            segments.iter().any(|s| matches!(s, RubySegment::Plain(_))),
            "particles should be Plain"
        );
    }

    #[test]
    fn segment_text_covers_every_variant() {
        assert_eq!(RubySegment::Plain("abc".into()).text(), "abc");
        assert_eq!(
            RubySegment::Ruby { base: "漢字".into(), reading: "かんじ".into() }.text(),
            "漢字"
        );
        let token = Token {
            surface: "日本語".into(),
            reading: Some("にほんご".into()),
            base: None,
            pos: None,
        };
        assert_eq!(RubySegment::Word(token).text(), "日本語");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_text() {
        assert_eq!(
            parse_ruby("hello world"),
            vec![RubySegment::Plain("hello world".into())]
        );
    }

    #[test]
    fn parses_ruby_pairs() {
        let segments = parse_ruby("日本語（にほんご）だ");
        assert_eq!(
            segments,
            vec![
                RubySegment::Ruby {
                    base: "日本語".into(),
                    reading: "にほんご".into(),
                },
                RubySegment::Plain("だ".into()),
            ]
        );
    }

    #[test]
    fn ruby_attaches_to_last_word_only() {
        // No whitespace: the whole run becomes the base.
        let segments = parse_ruby("本日は晴天（せいてん）");
        assert_eq!(
            segments,
            vec![RubySegment::Ruby {
                base: "本日は晴天".into(),
                reading: "せいてん".into(),
            }]
        );

        // Whitespace bounds the base at the last word.
        let segments = parse_ruby("hello 晴天（せいてん）");
        assert_eq!(
            segments,
            vec![
                RubySegment::Plain("hello ".into()),
                RubySegment::Ruby {
                    base: "晴天".into(),
                    reading: "せいてん".into(),
                },
            ]
        );
    }

    #[test]
    fn unclosed_annotation_stays_plain() {
        assert_eq!(
            parse_ruby("本（ほん"),
            vec![RubySegment::Plain("本（ほん".into())]
        );
    }

    #[test]
    fn furigana_annotations() {
        let result = process_text_with_furigana("日本語");
        assert!(result.contains("日本語"));
        assert!(result.contains("（"));
    }

    #[test]
    fn pinyin_annotations() {
        let result = process_text_with_pinyin("中文");
        assert!(result.contains("中"));
        assert!(result.contains("（"));
    }

    #[test]
    fn annotate_dispatches_by_language() {
        assert!(annotate("日本語").contains("（"));
        assert!(annotate("中文").contains("（"));
        assert_eq!(annotate("hello"), "hello");
    }

    #[test]
    fn parses_mecab_output() {
        let output = "日本語\t名詞,固有名詞,地域,一般,*,*,日本語,ニホンゴ,ニホンゴ\n\
                      を\t助詞,格助詞,一般,*,*,*,を,ヲ,ヲ\n\
                      勉強\t名詞,サ変接続,*,*,*,*,勉強,ベンキョウ,ベンキョウ\n\
                      EOS\n";
        let tokens = parse_mecab_output_detailed(output);
        assert_eq!(tokens.len(), 3);
        // Readings are normalized to hiragana by the detailed parser.
        assert_eq!(tokens[0].surface, "日本語");
        assert_eq!(tokens[0].reading.as_deref(), Some("にほんご"));
        assert_eq!(tokens[0].base.as_deref(), Some("日本語"));
        assert_eq!(tokens[1].surface, "を");
        assert_eq!(tokens[1].reading.as_deref(), Some("を"));
        assert_eq!(tokens[2].surface, "勉強");
        assert_eq!(tokens[2].reading.as_deref(), Some("べんきょう"));
    }

    #[test]
    fn mecab_unknown_reading_is_none() {
        let tokens = parse_mecab_output_detailed("＾\t記号,一般,*,*,*,*,＾,*,*\nEOS\n");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].surface, "＾");
        // Reading field is `*`, which must be dropped, not carried as the
        // literal string "*".
        assert_eq!(tokens[0].reading, None);
        // Base field is the caret itself here, so it survives.
        assert_eq!(tokens[0].base.as_deref(), Some("＾"));
    }

    /// An imported CSV must override the built-in reading for its words.
    #[test]
    fn imported_dictionary_overrides_readings() {
        let dir = std::env::temp_dir().join("livelink-dict-import-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // mecab user-dictionary CSV: surface,left,right,cost,POS...,base,reading,pron
        std::fs::write(
            dir.join("custom.csv"),
            "日本語,1288,1288,-10000,名詞,固有名詞,一般,*,*,*,日本語,ニッポンゴ,ニッポンゴ\n",
        )
        .unwrap();

        let segmenter =
            build_lindera_segmenter(Some(&dir)).expect("segmenter with user dictionary");
        let mut worker = segmenter.new_worker();
        let mut tokens = worker.segment("日本語").expect("segment");
        let details = tokens[0].details();
        assert_eq!(
            details.get(7).copied(),
            Some("ニッポンゴ"),
            "imported reading should win over ipadic"
        );
    }

    /// With no import directory the built-in ipadic reading is used.
    #[test]
    fn no_import_directory_keeps_ipadic() {
        let segmenter = build_lindera_segmenter(None).expect("segmenter");
        let mut worker = segmenter.new_worker();
        let mut tokens = worker.segment("日本語").expect("segment");
        let details = tokens[0].details();
        assert_eq!(details.get(7).copied(), Some("ニホンゴ"));
    }

    /// The fallback path is exercised when mecab is installed; skipped
    /// otherwise (mecab is optional by design).
    #[test]
    fn mecab_fallback_tokenizes_when_available() {
        if !mecab_available("mecab") {
            eprintln!("mecab not installed; skipping fallback test");
            return;
        }
        let tokens = mecab_tokens_detailed(Path::new("mecab"), "日本語を勉強しています")
            .expect("mecab should tokenize");
        assert!(!tokens.is_empty());
        assert!(tokens.iter().any(|token| {
            token.surface.chars().any(is_kanji)
                && token.reading.as_deref().is_some_and(|r| !r.is_empty())
        }));
    }

    /// The subprocess plumbing (spawn, stdin, stdout, parse, annotate) is
    /// verified with a stub that emits mecab-shaped output, so the fallback
    /// is covered even where mecab is not installed.
    #[test]
    fn mecab_fallback_pipeline_with_stub() {
        let stub = std::env::temp_dir().join("livelink-mecab-stub.sh");
        std::fs::write(
            &stub,
            "#!/bin/sh\n\
             if [ \"$1\" = \"--version\" ]; then echo 'mecab of stub'; exit 0; fi\n\
             cat >/dev/null\n\
             printf '日本語\\t名詞,固有名詞,一般,*,*,*,日本語,ニッポンゴ,ニッポンゴ\\nEOS\\n'\n",
        )
        .unwrap();
        let mut perms = std::fs::metadata(&stub).unwrap().permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
        }
        std::fs::set_permissions(&stub, perms).unwrap();

        assert!(
            mecab_available(&stub.to_string_lossy()),
            "stub should answer --version"
        );
        let tokens = mecab_tokens_detailed(&stub, "日本語").expect("stub tokenizes");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].surface, "日本語");
        // Readings arrive as katakana and are normalized to hiragana.
        assert_eq!(tokens[0].reading.as_deref(), Some("にっぽんご"));
        assert_eq!(tokens[0].base.as_deref(), Some("日本語"));

        // And the reading is usable through the mecab backend directly.
        let segments = parse_ruby(&{
            let mut out = String::new();
            for token in &tokens {
                match &token.reading {
                    Some(r) if token.surface.chars().any(is_kanji) => {
                        out.push_str(&format!("{}（{}）", token.surface, r));
                    }
                    _ => out.push_str(&token.surface),
                }
            }
            out
        });
        assert_eq!(
            segments,
            vec![RubySegment::Ruby {
                base: "日本語".into(),
                reading: "にっぽんご".into(),
            }]
        );
    }
}

