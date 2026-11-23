//! Hand-rolled cross-correlation between whisper words and existing subtitle
//! cues: for when **alass** is not installed, or when a live stream's
//! reference keeps moving and the alignment has to be recomputed from recent
//! words rather than a whole file.
//!
//! The algorithm is deliberately simple and conservative:
//!
//! 1. For each whisper segment, find the subtitle cue that overlaps it most
//!    in time and shares enough text to count as the same utterance.
//! 2. Each accepted pair gives an offset = cue.start - whisper.start.
//! 3. The offset is the **median** of the pairs (not the mean: a handful of
//!    outlier cues from an unrelated language lane must not drag it).
//! 4. Confidence is the fraction of pairs within 500 ms of that median.
//!    Below 0.6 we refuse to change anything, because a bad offset is worse
//!    than a stale one.
//!
//! This is not a replacement for alass's full alignment; it is the cheap
//! in-process check you can run every few seconds while a stream is live.

use super::{DelayAction, Lane};

/// A word or short segment from the whisper engine, with its own timing.
#[derive(Debug, Clone)]
pub struct WhisperWord {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// An existing subtitle cue from the player, with its current (wrong) timing.
#[derive(Debug, Clone)]
pub struct SubtitleCue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// One accepted whisper↔cue match: the offset to apply to this pair.
#[derive(Debug, Clone, Copy)]
pub struct Match {
    pub whisper_start: u64,
    pub cue_start: u64,
}

impl Match {
    /// The signed offset, in milliseconds, that would move the cue onto the
    /// whisper word's time. Positive means the cue was late and needs to be
    /// advanced; negative means it was early.
    pub fn offset_ms(&self) -> i64 {
        self.cue_start as i64 - self.whisper_start as i64
    }
}

/// How much two time ranges overlap, in milliseconds (0 if they do not
/// overlap).
fn overlap_ms(a_start: u64, a_end: u64, b_start: u64, b_end: u64) -> u64 {
    let start = a_start.max(b_start);
    let end = a_end.min(b_end);
    end.saturating_sub(start)
}

/// Normalized text overlap: fraction of the shorter string's tokens that
/// appear in the longer one. Deliberately loose (case and punctuation
/// ignored) because whisper and a subtitle track rarely spell the same word
/// identically.
fn text_overlap(a: &str, b: &str) -> f64 {
    let normalize = |s: &str| {
        s.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
    };
    let a_norm = normalize(a);
    let b_norm = normalize(b);
    if a_norm.is_empty() || b_norm.is_empty() {
        return 0.0;
    }
    let a_tokens: std::collections::HashSet<&str> = a_norm.split_whitespace().collect();
    let b_tokens: std::collections::HashSet<&str> = b_norm.split_whitespace().collect();
    let intersection = a_tokens.intersection(&b_tokens).count();
    let shorter = a_tokens.len().min(b_tokens.len());
    if shorter == 0 {
        return 0.0;
    }
    intersection as f64 / shorter as f64
}

/// Align whisper words to cues: for each whisper word, pick the cue with the
/// largest time overlap that also shares at least half its tokens.
pub fn align_by_text(words: &[WhisperWord], cues: &[SubtitleCue]) -> Vec<Match> {
    let mut matches = Vec::new();
    for word in words {
        let mut best: Option<(u64, &SubtitleCue)> = None;
        for cue in cues {
            let overlap = overlap_ms(word.start_ms, word.end_ms, cue.start_ms, cue.end_ms);
            if overlap == 0 {
                continue;
            }
            if text_overlap(&word.text, &cue.text) < 0.5 {
                continue;
            }
            if best.map_or(true, |(current, _)| overlap > current) {
                best = Some((overlap, cue));
            }
        }
        if let Some((_, cue)) = best {
            matches.push(Match {
                whisper_start: word.start_ms,
                cue_start: cue.start_ms,
            });
        }
    }
    matches
}

/// The median offset of a set of matches, in milliseconds. Outliers beyond
/// 3 s are discarded first: a subtitle track that is wildly off is a
/// different problem, not a drift to nudge.
pub fn median_offset(matches: &[Match]) -> Option<i64> {
    if matches.is_empty() {
        return None;
    }
    let mut offsets: Vec<i64> = matches
        .iter()
        .map(|m| m.offset_ms())
        .filter(|o| o.abs() < 3000)
        .collect();
    if offsets.is_empty() {
        return None;
    }
    offsets.sort_unstable();
    let mid = offsets.len() / 2;
    if offsets.len() % 2 == 0 {
        Some((offsets[mid - 1] + offsets[mid]) / 2)
    } else {
        Some(offsets[mid])
    }
}

/// Fraction of matches whose offset is within `window_ms` of the median.
pub fn confidence(matches: &[Match], median: i64, window_ms: i64) -> f64 {
    if matches.is_empty() {
        return 0.0;
    }
    let agreeing = matches
        .iter()
        .filter(|m| (m.offset_ms() - median).abs() < window_ms)
        .count();
    agreeing as f64 / matches.len() as f64
}

/// The result of a cross-correlation attempt.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SyncResult {
    /// Confident alignment: apply this offset (ms).
    Confident { median: i64, confidence: f64 },
    /// Not enough agreement to act safely.
    LowConfidence { median: Option<i64>, confidence: f64 },
}

/// Run the full cross-correlation. Returns a confident result only when at
/// least 60% of matches agree within 500 ms of the median.
pub fn cross_correlate(words: &[WhisperWord], cues: &[SubtitleCue]) -> SyncResult {
    let matches = align_by_text(words, cues);
    let Some(median) = median_offset(&matches) else {
        return SyncResult::LowConfidence {
            median: None,
            confidence: 0.0,
        };
    };
    let confidence = confidence(&matches, median, 500);
    if confidence >= 0.6 {
        SyncResult::Confident { median, confidence }
    } else {
        SyncResult::LowConfidence {
            median: Some(median),
            confidence,
        }
    }
}

/// Turn a confident cross-correlation into the delay command for the player.
pub fn apply_result(result: &SyncResult, lane: Lane) -> Option<String> {
    match result {
        SyncResult::Confident { median, .. } => {
            let seconds = *median as f64 / 1000.0;
            Some(super::delay_command(DelayAction::Set(seconds), lane))
        }
        SyncResult::LowConfidence { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(start: u64, end: u64, text: &str) -> WhisperWord {
        WhisperWord {
            start_ms: start,
            end_ms: end,
            text: text.to_string(),
        }
    }

    fn cue(start: u64, end: u64, text: &str) -> SubtitleCue {
        SubtitleCue {
            start_ms: start,
            end_ms: end,
            text: text.to_string(),
        }
    }

    #[test]
    fn overlapping_time_and_text_produces_a_match() {
        // The cue starts 1.5 s after the word starts, and they share a
        // window: a cue that is late by exactly 1500 ms. The fixture must
        // actually overlap — a cue outside the word's window is not "late",
        // it is unrelated, and alignment must reject it (see
        // time_that_does_not_overlap_is_rejected).
        let words = vec![word(1000, 3000, "hello world")];
        let cues = vec![cue(2500, 4500, "hello world")];
        let matches = align_by_text(&words, &cues);
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].offset_ms(), 1500);
    }

    #[test]
    fn text_that_does_not_overlap_is_rejected() {
        let words = vec![word(1000, 2000, "completely different")];
        let cues = vec![cue(2500, 3500, "hello world")];
        assert!(align_by_text(&words, &cues).is_empty());
    }

    #[test]
    fn time_that_does_not_overlap_is_rejected() {
        let words = vec![word(1000, 2000, "hello world")];
        let cues = vec![cue(9000, 10000, "hello world")];
        assert!(align_by_text(&words, &cues).is_empty());
    }

    #[test]
    fn median_ignores_outliers_beyond_three_seconds() {
        let matches = vec![
            Match { whisper_start: 1000, cue_start: 1500 },
            Match { whisper_start: 1000, cue_start: 1500 },
            Match { whisper_start: 1000, cue_start: 1500 },
            Match { whisper_start: 1000, cue_start: 9999 },
        ];
        assert_eq!(median_offset(&matches), Some(500));
    }

    #[test]
    fn median_of_an_empty_set_is_none() {
        assert_eq!(median_offset(&[]), None);
    }

    #[test]
    fn confidence_is_the_agreeing_fraction() {
        let matches = vec![
            Match { whisper_start: 1000, cue_start: 1500 },
            Match { whisper_start: 1000, cue_start: 1500 },
            Match { whisper_start: 1000, cue_start: 1500 },
            Match { whisper_start: 1000, cue_start: 2500 },
        ];
        let median = median_offset(&matches).unwrap();
        assert_eq!(confidence(&matches, median, 500), 0.75);
    }

    #[test]
    fn a_confident_run_produces_a_delay_command() {
        // Each cue is late by 1500 ms but still shares a window with its
        // word, and matches it on text: a uniformly drifting track.
        let words = vec![
            word(1000, 3000, "hello"),
            word(3000, 5000, "world"),
            word(5000, 7000, "again"),
        ];
        let cues = vec![
            cue(2500, 4500, "hello"),
            cue(4500, 6500, "world"),
            cue(6500, 8500, "again"),
        ];
        let result = cross_correlate(&words, &cues);
        match result {
            SyncResult::Confident { median, confidence } => {
                assert_eq!(median, 1500);
                assert!(confidence >= 0.6);
            }
            SyncResult::LowConfidence { .. } => panic!("should be confident"),
        }
    }

    #[test]
    fn a_confident_result_becomes_a_delay_command() {
        let result = SyncResult::Confident {
            median: 1500,
            confidence: 1.0,
        };
        let line = apply_result(&result, Lane::Primary).expect("command");
        assert_eq!(line, r#"{"cmd":"sub-delay","value":1.5}"#);
    }

    #[test]
    fn low_confidence_produces_no_command() {
        let result = SyncResult::LowConfidence {
            median: Some(500),
            confidence: 0.2,
        };
        assert!(apply_result(&result, Lane::Primary).is_none());
    }
}