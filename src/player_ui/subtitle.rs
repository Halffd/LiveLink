//! Subtitle file parser for the subtitle list panel.
//!
//! Port of Memento's subtitle parser (src/util/subtitleparser.cpp): supports
//! ASS, SRT, and VTT with the same tag filtering, timecode handling, and
//! ordering rules. Like Memento, any parse error yields an empty list.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

/// One parsed subtitle line.
#[derive(Debug, Clone, PartialEq)]
pub struct SubtitleInfo {
    /// Text with formatting tags removed
    pub text: String,
    /// Start time in seconds
    pub start: f64,
    /// End time in seconds
    pub end: f64,
}

static TIMECODE_SPLITTER: LazyLock<Regex> = LazyLock::new(|| Regex::new("[:.,]").unwrap());
static ASS_FILTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{\\.*?\}").unwrap());
static ASS_NEW_LINE_REPLACER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\n|\\N").unwrap());
static SRT_FILTER: LazyLock<Regex> = LazyLock::new(|| {
    // Removes <b></b> <i></i> <u></u>, {b}{/b} {i}{/i} {u}{/u},
    // <font color="white"></font>, and {\a#} {\an#}
    Regex::new(r"</?[biu]>|\{/?[biu]\}|</?font.*?>|\{\\an?\d\}").unwrap()
});
static ANGLE_BRACE_CLEANER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<[^>]*>").unwrap());

const VTT_SECTIONS: &[&str] = &["NOTE", "STYLE", "REGION"];

/// Parse the subtitle file at `path` (ASS/SRT/VTT by extension). Returns an
/// empty list for unsupported extensions or unparsable files. Accepts
/// `file://` URLs.
pub fn parse_subtitles(path: &str) -> Vec<SubtitleInfo> {
    let path = path.strip_prefix("file://").unwrap_or(path);
    let lower = path.to_lowercase();
    let content = match std::fs::read_to_string(Path::new(path)) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    if lower.ends_with(".ass") {
        parse_ass(&content)
    } else if lower.ends_with(".srt") {
        parse_srt(&content)
    } else if lower.ends_with(".vtt") {
        parse_vtt(&content)
    } else {
        Vec::new()
    }
}

const ASS_HEADER: &str = "[Script Info]";
const EVENT_HEADER: &str = "[Events]";
const FORMAT_PREFIX: &str = "Format: ";
const DIALOGUE_PREFIX: &str = "Dialogue: ";

fn parse_ass(content: &str) -> Vec<SubtitleInfo> {
    let mut out = Vec::new();

    let mut lines = content.lines();
    // Make sure the file isn't empty and starts with the ASS header.
    match lines.next() {
        Some(line) if line.trim() == ASS_HEADER => {}
        _ => return out,
    }

    // Skip to the [Events] section. There being none is odd but valid.
    let mut line = lines.next().unwrap_or("");
    while line.trim() != EVENT_HEADER {
        line = match lines.next() {
            Some(l) => l,
            None => return out,
        };
    }

    // Get the Format line and locate the Start/End/Text columns.
    let format_line = match lines.next() {
        Some(l) if l.starts_with(FORMAT_PREFIX) => l,
        _ => return Vec::new(),
    };
    let format: Vec<&str> = format_line[FORMAT_PREFIX.len()..].split(',').collect();
    let start_index = format.iter().position(|f| f.trim() == "Start");
    let end_index = format.iter().position(|f| f.trim() == "End");
    let text_index = format.iter().position(|f| f.trim() == "Text");
    let (Some(start_index), Some(end_index), Some(text_index)) =
        (start_index, end_index, text_index)
    else {
        return Vec::new();
    };

    // Parse Dialogue lines. Like Memento, a Dialogue/Format mismatch or an
    // invalid timecode discards everything parsed so far.
    for line in lines {
        if !line.starts_with(DIALOGUE_PREFIX) {
            continue;
        }
        let dialogue: Vec<&str> = line[DIALOGUE_PREFIX.len()..].split(',').collect();
        if dialogue.len() < format.len() {
            return Vec::new();
        }
        let Ok(start) = timecode_to_double(dialogue[start_index].trim()) else {
            return Vec::new();
        };
        let Ok(end) = timecode_to_double(dialogue[end_index].trim()) else {
            return Vec::new();
        };
        if end < start {
            return Vec::new();
        }
        let mut text = dialogue[text_index..].join(",");
        text = ASS_FILTER.replace_all(&text, "").to_string();
        text = ASS_NEW_LINE_REPLACER.replace_all(&text, "\n").to_string();
        // Throw out empty subtitles.
        if text.trim().is_empty() {
            continue;
        }
        out.push(SubtitleInfo { text, start, end });
    }

    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

fn parse_srt(content: &str) -> Vec<SubtitleInfo> {
    // (text, start, end, position)
    let mut subs: Vec<(String, f64, f64, u32)> = Vec::new();
    let mut lines = content.lines().peekable();

    'blocks: loop {
        // Skip all empty lines.
        let mut line = match lines.next() {
            Some(l) => l,
            None => break,
        };
        while line.is_empty() {
            line = match lines.next() {
                Some(l) => l,
                None => break 'blocks,
            };
        }

        // Get the position.
        let Ok(position) = line.trim().parse::<u32>() else {
            return Vec::new();
        };

        // Get the timings: "HH:MM:SS,mmm --> HH:MM:SS,mmm".
        let timing = match lines.next() {
            Some(l) => l.trim(),
            None => return Vec::new(),
        };
        let timing: Vec<&str> = timing.split(' ').collect();
        if timing.len() != 3 || timing[1] != "-->" {
            return Vec::new();
        }
        let Ok(start) = timecode_to_double(timing[0]) else {
            return Vec::new();
        };
        let Ok(end) = timecode_to_double(timing[2]) else {
            return Vec::new();
        };
        if end < start {
            return Vec::new();
        }

        // Get the lines until the next empty line.
        let mut text = String::new();
        loop {
            match lines.next() {
                Some(l) if !l.is_empty() => {
                    text.push_str(l);
                    text.push('\n');
                }
                _ => break,
            }
        }
        let text = text.trim_end_matches('\n').to_string();
        let text = SRT_FILTER.replace_all(&text, "").to_string();
        // Don't add subtitles that are only whitespace.
        if text.trim().is_empty() {
            continue;
        }
        subs.push((text, start, end, position));
    }

    // Sorted by start, then position.
    subs.sort_by(|a, b| a.1.total_cmp(&b.1).then(a.3.cmp(&b.3)));
    subs.into_iter()
        .map(|(text, start, end, _)| SubtitleInfo { text, start, end })
        .collect()
}

const VTT_HEADER: &str = "WEBVTT";

fn parse_vtt(content: &str) -> Vec<SubtitleInfo> {
    let mut out = Vec::new();
    let mut lines = content.lines();

    // The file must start with the WEBVTT header.
    match lines.next() {
        Some(l) if l.starts_with(VTT_HEADER) => {}
        _ => return out,
    }

    // Skip past header info.
    for line in lines.by_ref() {
        if line.trim().is_empty() {
            break;
        }
    }

    // Read subtitles.
    while let Some(line) = lines.next() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Skip non-subtitle sections (NOTE, STYLE, REGION).
        let first_word = line.split(' ').next().unwrap_or("");
        if VTT_SECTIONS.contains(&first_word) {
            for skip in lines.by_ref() {
                if skip.trim().is_empty() {
                    break;
                }
            }
            continue;
        }

        // The timing line may be preceded by a cue identifier.
        let mut timing: Vec<&str> = line.split(' ').collect();
        if timing.len() < 3 || timing[1] != "-->" {
            let next = match lines.next() {
                Some(l) => l.trim(),
                None => return Vec::new(),
            };
            timing = next.split(' ').collect();
            if timing.len() < 3 || timing[1] != "-->" {
                return Vec::new();
            }
        }
        let Ok(start) = timecode_to_double(timing[0]) else {
            return Vec::new();
        };
        let Ok(end) = timecode_to_double(timing[2]) else {
            return Vec::new();
        };
        if end < start {
            return Vec::new();
        }

        // Get the lines until the next empty line.
        let mut text = String::new();
        loop {
            match lines.next() {
                Some(l) if !l.is_empty() => {
                    text.push_str(l);
                    text.push('\n');
                }
                _ => break,
            }
        }
        let text = text.trim_end_matches('\n').to_string();
        let text = ANGLE_BRACE_CLEANER.replace_all(&text, "").to_string();
        if text.trim().is_empty() {
            continue;
        }
        out.push(SubtitleInfo { text, start, end });
    }

    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    out
}

/// Convert a timecode of `HH:MM:SS,mmm`, `HH:MM:SS.mmm`, or `MM:SS.cc` (split
/// on colon, dot, or comma) to seconds. Mirrors Memento: the last field is
/// always the sub-second field (two digits = hundredths, three = milliseconds).
/// None on error.
fn timecode_to_double(timecode: &str) -> Result<f64, ()> {
    const SECONDS_IN_HOUR: f64 = 3600.0;
    const SECONDS_IN_MINUTE: f64 = 60.0;
    const SECONDS_IN_MILLISECOND: f64 = 0.001;
    const SECONDS_IN_HUNDREDTH: f64 = 0.01;

    let mut pieces: Vec<&str> = TIMECODE_SPLITTER.split(timecode.trim()).collect();
    pieces.reverse();
    if pieces.len() != 3 && pieces.len() != 4 {
        return Err(());
    }

    let mut seconds = 0.0;

    // Sub-second field: two digits (hundredths) or three digits (milliseconds).
    let fraction = pieces[0];
    if fraction.len() == 2 {
        let v: u32 = fraction.parse().map_err(|_| ())?;
        if v > 99 {
            return Err(());
        }
        seconds += v as f64 * SECONDS_IN_HUNDREDTH;
    } else if fraction.len() == 3 {
        let v: u32 = fraction.parse().map_err(|_| ())?;
        if v > 999 {
            return Err(());
        }
        seconds += v as f64 * SECONDS_IN_MILLISECOND;
    } else {
        return Err(());
    }

    let secs: u32 = pieces[1].parse().map_err(|_| ())?;
    if secs > 59 {
        return Err(());
    }
    seconds += secs as f64;

    let minutes: u32 = pieces[2].parse().map_err(|_| ())?;
    if minutes > 59 {
        return Err(());
    }
    seconds += minutes as f64 * SECONDS_IN_MINUTE;

    if pieces.len() == 4 {
        let hours: u32 = pieces[3].parse().map_err(|_| ())?;
        seconds += hours as f64 * SECONDS_IN_HOUR;
    }

    Ok(seconds)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ass_with_overrides_and_commas() {
        let ass = "[Script Info]\n\
                   Title: test\n\
                   \n\
                   [V4+ Styles]\n\
                   Format: Name, Fontname\n\
                   Style: Default,Arial\n\
                   \n\
                   [Events]\n\
                   Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
                   Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\i1}Hello, world{\\i0}\n\
                   Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,line one\\Nline two\n\
                   Dialogue: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,   \n";
        let subs = parse_ass(ass);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].text, "Hello, world");
        assert_eq!(subs[0].start, 1.0);
        assert_eq!(subs[0].end, 3.5);
        assert_eq!(subs[1].text, "line one\nline two");
        assert_eq!(subs[1].start, 2.0);
    }

    #[test]
    fn ass_error_discards_everything() {
        let ass = "[Script Info]\n\
                   [Events]\n\
                   Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n\
                   Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,good\n\
                   Dialogue: 0,bad-time,0:00:04.00,Default,,0,0,0,,after error\n";
        assert!(parse_ass(ass).is_empty());
    }

    #[test]
    fn parses_srt_with_tags() {
        let srt = "1\n00:00:01,000 --> 00:00:02,500\n<b>Hello</b> <i>world</i>\n\n\
                   2\n01:00:00,000 --> 01:00:02,000\nmulti\nline\n\n";
        let subs = parse_srt(srt);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].text, "Hello world");
        assert_eq!(subs[0].start, 1.0);
        assert_eq!(subs[0].end, 2.5);
        assert_eq!(subs[1].text, "multi\nline");
        assert_eq!(subs[1].start, 3600.0);
    }

    #[test]
    fn srt_sorted_by_start_then_position() {
        let srt = "2\n00:00:05,000 --> 00:00:06,000\nsecond\n\n\
                   1\n00:00:05,000 --> 00:00:06,000\nfirst\n\n";
        let subs = parse_srt(srt);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].text, "first");
        assert_eq!(subs[1].text, "second");
    }

    #[test]
    fn parses_vtt_with_cue_ids_and_sections() {
        let vtt = "WEBVTT\n\n\
                   NOTE this is a comment\n\
                   spanning lines\n\n\
                   STYLE\n::cue {}\n\n\
                   cue-1\n00:00:01.000 --> 00:00:02.000\n<b>Hi</b>\n\n\
                   00:00:03.000 --> 00:00:04.000\n<b>Bye</b>\n";
        let subs = parse_vtt(vtt);
        assert_eq!(subs.len(), 2);
        assert_eq!(subs[0].text, "Hi");
        assert_eq!(subs[0].start, 1.0);
        assert_eq!(subs[1].text, "Bye");
        assert_eq!(subs[1].start, 3.0);
    }

    #[test]
    fn timecode_variants() {
        assert_eq!(timecode_to_double("00:00:01,500"), Ok(1.5));
        assert_eq!(timecode_to_double("0:00:01.50"), Ok(1.5));
        assert_eq!(timecode_to_double("01:00:00.000"), Ok(3600.0));
        // Memento semantics: the last field is always sub-second, so a bare
        // HH:MM:SS is read as hundredths of a second.
        assert_eq!(timecode_to_double("00:00:02"), Ok(0.02));
        assert!(timecode_to_double("bad").is_err());
        assert!(timecode_to_double("00:00:60,000").is_err());
    }

    #[test]
    fn unsupported_extension_is_empty() {
        assert!(parse_subtitles("/nonexistent/file.txt").is_empty());
    }
}
