//! Subtitle sync and visibility primitives.
//!
//! Visibility is *derived*: you set a mode (which lanes are shown), not a
//! pair of raw toggles. The two lanes are mpv's primary (`sid`,
//! `sub-visibility`) and the stacked secondary (`secondary-sid`,
//! `secondary-sub-visibility`).
//!
//! Sync is a per-lane delay in seconds with resolution order
//! `ephemeral > per-item > per-source > global`; only ephemeral and global
//! exist today (per-item/per-source would ride on queue entries).

use serde::{Deserialize, Serialize};

/// Delay clamp in seconds, mirroring the useful range for live captions.
pub const MAX_SUB_DELAY: f64 = 10.0;

/// Which subtitle lanes are shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum SubtitleMode {
    /// Primary visible, secondary hidden.
    #[default]
    PrimaryOnly,
    /// Secondary visible, primary hidden (translation on top of blank).
    SecondaryOnly,
    /// Both visible (e.g. native + translation stacked).
    Stacked,
    /// Both hidden (audio only).
    Hidden,
    /// Primary visible; the secondary lane follows the `secondary_on` flag,
    /// i.e. the toggle target for a hotkey.
    ToggleSecondary,
}

impl SubtitleMode {
    pub const ALL: [SubtitleMode; 5] = [
        SubtitleMode::PrimaryOnly,
        SubtitleMode::SecondaryOnly,
        SubtitleMode::Stacked,
        SubtitleMode::Hidden,
        SubtitleMode::ToggleSecondary,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            SubtitleMode::PrimaryOnly => "primary-only",
            SubtitleMode::SecondaryOnly => "secondary-only",
            SubtitleMode::Stacked => "stacked",
            SubtitleMode::Hidden => "hidden",
            SubtitleMode::ToggleSecondary => "toggle-secondary",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|m| m.as_str() == name)
    }

    /// `(sub-visibility, secondary-sub-visibility)` for this mode.
    pub fn resolve(&self, secondary_on: bool) -> (bool, bool) {
        match self {
            SubtitleMode::PrimaryOnly => (true, false),
            SubtitleMode::SecondaryOnly => (false, true),
            SubtitleMode::Stacked => (true, true),
            SubtitleMode::Hidden => (false, false),
            SubtitleMode::ToggleSecondary => (true, secondary_on),
        }
    }

    /// Next mode in cycle order, for the cycle hotkey.
    pub fn next(&self) -> SubtitleMode {
        let idx = Self::ALL.iter().position(|m| m == self).unwrap_or(0);
        Self::ALL[(idx + 1) % Self::ALL.len()]
    }

    /// Comma-separated list for CLI help/errors.
    pub fn names() -> String {
        Self::ALL
            .iter()
            .map(|m| m.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

impl std::fmt::Display for SubtitleMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Per-lane subtitle delay in seconds, clamped to ±[`MAX_SUB_DELAY`].
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct SubtitleSync {
    pub primary: f64,
    pub secondary: f64,
}

impl SubtitleSync {
    pub fn new(primary: f64, secondary: f64) -> Self {
        Self {
            primary: primary.clamp(-MAX_SUB_DELAY, MAX_SUB_DELAY),
            secondary: secondary.clamp(-MAX_SUB_DELAY, MAX_SUB_DELAY),
        }
    }

    /// Nudge one lane relative to its current value.
    pub fn add(&mut self, secondary: bool, delta: f64) {
        let current = if secondary {
            self.secondary
        } else {
            self.primary
        };
        let next = (current + delta).clamp(-MAX_SUB_DELAY, MAX_SUB_DELAY);
        if secondary {
            self.secondary = next;
        } else {
            self.primary = next;
        }
    }

    pub fn reset(&mut self) {
        self.primary = 0.0;
        self.secondary = 0.0;
    }
}

/// Resolution order: ephemeral override wins over the persisted default.
pub fn resolve_delay(ephemeral: Option<f64>, default: f64) -> f64 {
    ephemeral
        .unwrap_or(default)
        .clamp(-MAX_SUB_DELAY, MAX_SUB_DELAY)
}

/// Parse a signed seconds value from the CLI: `+2.5`, `-0.5`, `2`.
pub fn parse_signed_seconds(raw: &str) -> Option<f64> {
    raw.trim()
        .trim_start_matches('+')
        .parse::<f64>()
        .ok()
        .filter(|v| v.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_resolve_to_lane_visibility() {
        assert_eq!(SubtitleMode::PrimaryOnly.resolve(true), (true, false));
        assert_eq!(SubtitleMode::SecondaryOnly.resolve(false), (false, true));
        assert_eq!(SubtitleMode::Stacked.resolve(false), (true, true));
        assert_eq!(SubtitleMode::Hidden.resolve(true), (false, false));
        // toggle-secondary follows the flag either way
        assert_eq!(SubtitleMode::ToggleSecondary.resolve(true), (true, true));
        assert_eq!(SubtitleMode::ToggleSecondary.resolve(false), (true, false));
    }

    #[test]
    fn mode_parses_and_cycles() {
        assert_eq!(SubtitleMode::parse("stacked"), Some(SubtitleMode::Stacked));
        assert_eq!(SubtitleMode::parse("nope"), None);
        assert_eq!(
            SubtitleMode::PrimaryOnly.next(),
            SubtitleMode::SecondaryOnly
        );
        assert_eq!(
            SubtitleMode::ToggleSecondary.next(),
            SubtitleMode::PrimaryOnly
        );
        assert!(SubtitleMode::names().contains("primary-only"));
    }

    #[test]
    fn sync_nudges_and_clamps() {
        let mut sync = SubtitleSync::default();
        sync.add(false, 2.0);
        assert_eq!(sync.primary, 2.0);
        sync.add(true, -1.0);
        assert_eq!(sync.secondary, -1.0);
        sync.add(false, 100.0);
        assert_eq!(sync.primary, MAX_SUB_DELAY);
        sync.add(true, -100.0);
        assert_eq!(sync.secondary, -MAX_SUB_DELAY);
        sync.reset();
        assert_eq!(sync, SubtitleSync::default());
        assert_eq!(SubtitleSync::new(50.0, -50.0).primary, MAX_SUB_DELAY);
    }

    #[test]
    fn delay_resolution_prefers_ephemeral() {
        assert_eq!(resolve_delay(Some(1.5), 0.0), 1.5);
        assert_eq!(resolve_delay(None, 2.0), 2.0);
        assert_eq!(resolve_delay(Some(50.0), 0.0), MAX_SUB_DELAY);
    }

    #[test]
    fn signed_seconds_parse() {
        assert_eq!(parse_signed_seconds("+2.5"), Some(2.5));
        assert_eq!(parse_signed_seconds("-0.5"), Some(-0.5));
        assert_eq!(parse_signed_seconds("2"), Some(2.0));
        assert_eq!(parse_signed_seconds("abc"), None);
        assert_eq!(parse_signed_seconds("inf"), None);
    }
}
