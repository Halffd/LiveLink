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

/// Parse `mecab` default output into (surface, reading) pairs. Each line is
/// `surface\tPOS,sub,...,base,reading,pron`; `EOS` terminates the input.
fn parse_mecab_output(output: &str) -> Vec<(String, Option<String>)> {
    output
        .lines()
        .filter(|line| !line.is_empty() && *line != "EOS")
        .filter_map(|line| {
            let (surface, features) = line.split_once('\t')?;
            let reading = features
                .split(',')
                .nth(7)
                .filter(|r| !r.is_empty() && *r != "*")
                .map(|r| r.to_string());
            Some((surface.to_string(), reading))
        })
        .collect()
}

/// Tokenize through a system mecab subprocess.
fn mecab_tokens(bin: &Path, text: &str) -> Option<Vec<(String, Option<String>)>> {
    let mut child = std::process::Command::new(bin)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    {
        let mut stdin = child.stdin.take()?;
        // mecab treats every line as an independent input.
        stdin.write_all(text.replace('\n', " ").as_bytes()).ok()?;
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(parse_mecab_output(&String::from_utf8_lossy(&output.stdout)))
}

/// Tokenize with readings, dispatching on the active backend.
fn tokenize(text: &str) -> Vec<(String, Option<String>)> {
    match backend() {
        Some(Backend::Lindera(segmenter)) => {
            let mut worker = segmenter.new_worker();
            match worker.segment(text) {
                Ok(mut tokens) => tokens
                    .iter_mut()
                    .map(|token| {
                        let surface = match &token.surface {
                            Cow::Borrowed(s) => (*s).to_string(),
                            Cow::Owned(s) => s.clone(),
                        };
                        // ipadic word details: POS..., base form, reading
                        // (katakana), phonetic.
                        let details = token.details();
                        let reading = details
                            .get(7)
                            .filter(|r| !r.is_empty() && **r != "*")
                            .map(|r| r.to_string());
                        (surface, reading)
                    })
                    .collect(),
                Err(e) => {
                    tracing::warn!(error = %e, "tokenization failed");
                    Vec::new()
                }
            }
        }
        Some(Backend::Mecab(bin)) => match mecab_tokens(bin, text) {
            Some(tokens) => tokens,
            None => {
                tracing::warn!(path = %bin.display(), "mecab tokenization failed");
                Vec::new()
            }
        },
        None => Vec::new(),
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
        let tokens = parse_mecab_output(output);
        assert_eq!(tokens.len(), 3);
        assert_eq!(
            tokens[0],
            ("日本語".to_string(), Some("ニホンゴ".to_string()))
        );
        assert_eq!(tokens[1], ("を".to_string(), Some("ヲ".to_string())));
        assert_eq!(
            tokens[2],
            ("勉強".to_string(), Some("ベンキョウ".to_string()))
        );
    }

    #[test]
    fn mecab_unknown_reading_is_none() {
        let tokens = parse_mecab_output("＾\t記号,一般,*,*,*,*,＾,*,*\nEOS\n");
        assert_eq!(tokens, vec![("＾".to_string(), None)]);
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
        let tokens = mecab_tokens(Path::new("mecab"), "日本語を勉強しています")
            .expect("mecab should tokenize");
        assert!(!tokens.is_empty());
        assert!(tokens.iter().any(|(surface, reading)| {
            surface.chars().any(is_kanji) && reading.as_deref().is_some_and(|r| !r.is_empty())
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
        let tokens = mecab_tokens(&stub, "日本語").expect("stub tokenizes");
        assert_eq!(
            tokens,
            vec![("日本語".to_string(), Some("ニッポンゴ".to_string()))]
        );

        // And the reading is usable through the mecab backend directly.
        let segments = parse_ruby(&{
            let mut out = String::new();
            for (surface, reading) in &tokens {
                match reading {
                    Some(r) if surface.chars().any(is_kanji) => {
                        out.push_str(&format!("{}（{}）", surface, katakana_to_hiragana(r)));
                    }
                    _ => out.push_str(surface),
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
