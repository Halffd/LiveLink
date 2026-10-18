//! Reading annotations: furigana over Japanese, pinyin over Chinese, and the
//! ruby segment parser the reading panel renders with. Mirrors captioner-core
//! (captioner-rs), adapted to lindera 6.

use std::borrow::Cow;
use std::sync::LazyLock;

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

static SEGMENTER: LazyLock<Result<lindera::segmenter::Segmenter, String>> = LazyLock::new(|| {
    let dictionary = lindera_ipadic::embedded::load()
        .map_err(|e| format!("failed to load embedded ipadic: {}", e))?;
    Ok(lindera::segmenter::Segmenter::new(
        lindera::mode::Mode::Normal,
        dictionary,
        None,
    ))
});

pub fn process_text_with_furigana(text: &str) -> String {
    if !contains_japanese(text) {
        return text.to_string();
    }

    let segmenter = match SEGMENTER.as_ref() {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("{}", e);
            return text.to_string();
        }
    };

    let mut worker = segmenter.new_worker();
    let mut tokens = match worker.segment(text) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("Tokenization failed: {}", e);
            return text.to_string();
        }
    };

    let mut result = String::with_capacity(text.len() * 2);
    for token in &mut tokens {
        let surface = match &token.surface {
            Cow::Borrowed(s) => (*s).to_string(),
            Cow::Owned(s) => s.clone(),
        };
        if !surface.chars().any(is_kanji) {
            result.push_str(&surface);
            continue;
        }

        // ipadic word details: POS..., base form, reading (katakana), phonetic.
        let details = token.details();
        if details.len() >= 8 {
            let reading = details[7];
            if !reading.is_empty() && reading != "*" {
                let hiragana_reading = katakana_to_hiragana(reading);
                if surface != hiragana_reading {
                    result.push_str(&format!("{}（{}）", surface, hiragana_reading));
                    continue;
                }
            }
        }

        result.push_str(&surface);
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
}
