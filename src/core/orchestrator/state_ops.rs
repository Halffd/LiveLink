use crate::core::state::StreamState;
use crate::queue::queue::StreamSource;
use futures::executor::block_on;
use tracing::debug;

use super::Orchestrator;

#[allow(dead_code)]
impl Orchestrator {
    /// Where a screen's media clock currently is, in milliseconds.
    ///
    /// Both backends answer: a player window via its `get-position` query,
    /// a subprocess player via the service it holds. `None` when neither can
    /// answer — a closed window has no clock, and `None` (not `0`) is the
    /// honest answer: `0` would silently mean "stream starts at the
    /// beginning" and hide a real offset behind a plausible number.
    pub async fn media_position_ms(&self, screen: u32) -> Option<u64> {
        if self.window_playback() {
            let port = crate::player_ui::control::DEFAULT_BASE_PORT
                .saturating_add(u16::try_from(screen).unwrap_or(0));
            let reply = crate::player_ui::control::query(port, "get-position").await?;
            let position = reply.get("position").and_then(|v| v.as_f64())?;
            return Some((position.max(0.0) * 1000.0) as u64);
        }

        let player = self.player.lock().await;
        player
            .get_playback_time(screen, 0)
            .map(|seconds| (seconds.max(0.0) * 1000.0) as u64)
    }
    pub async fn get_state(&self, screen: u32) -> Option<StreamState> {
        self.state.lock().await.get(&screen).map(|s| s.state)
    }

    pub fn get_state_sync(&self, screen: u32) -> Option<StreamState> {
        block_on(self.state.lock()).get(&screen).map(|s| s.state)
    }

    pub fn count_active_streams(&self) -> usize {
        self.count_active_streams_internal()
    }

    pub(crate) fn count_active_streams_internal(&self) -> usize {
        // Note: Caller must NOT hold the state lock when calling this
        let guard = block_on(self.state.lock());
        guard
            .values()
            .filter(|s| s.state == StreamState::Playing || s.state == StreamState::Starting)
            .count()
    }

    pub(crate) fn count_active_streams_internal_with_guard(guard: &std::collections::HashMap<u32, crate::core::state::ScreenState>) -> usize {
        guard
            .values()
            .filter(|s| s.state == StreamState::Playing || s.state == StreamState::Starting)
            .count()
    }

    pub(crate) fn apply_filters(&self, streams: Vec<StreamSource>) -> Vec<StreamSource> {
        if !self.config.filters.enabled {
            return streams;
        }

        let original_count = streams.len();
        let filters = &self.config.filters;
        let filter_members_only = filters.filter_members_only;
        let filtered: Vec<StreamSource> = streams
            .into_iter()
            .filter(|stream| {
                let channel_excluded = stream.channel.as_ref()
                    .map(|ch| filters.matches_channel(ch))
                    .unwrap_or(false);

                let title_excluded = stream.title.as_ref()
                    .map(|title| filters.matches_title(title))
                    .unwrap_or(false);

                let platform_excluded = filters.exclude_platforms.iter()
                    .any(|p| stream.platform.as_ref()
                        .map(|pl| pl.to_lowercase() == p.to_lowercase())
                        .unwrap_or(false));

                let members_only_excluded = filter_members_only && stream.members_only;

                if channel_excluded || title_excluded || platform_excluded || members_only_excluded {
                    return false;
                }

                true
            })
            .collect();

        let filtered_count = filtered.len();
        if original_count != filtered_count {
            debug!(
                original = original_count,
                filtered = filtered_count,
                removed = original_count - filtered_count,
                "Applied filters"
            );
        }

        filtered
    }

    pub(crate) fn sort_streams_by_favorites(
        &self,
        mut streams: Vec<StreamSource>,
        platform: &str,
    ) -> Vec<StreamSource> {
        let favorites = match platform {
            "twitch" => &self.config.favorite_channels.twitch.default,
            "youtube" => &self.config.favorite_channels.youtube.default,
            "holodex" | "niconico" | "bilibili" | "kick" | "facebook" => {
                &self.config.favorite_channels.twitch.default
            }
            _ => return streams,
        };

        if favorites.is_empty() {
            return streams;
        }

        let channel_to_score: std::collections::HashMap<&str, u32> = favorites
            .iter()
            .enumerate()
            .map(|(idx, ch)| (ch.id.as_str(), 1000 - idx as u32))
            .collect();

        streams.sort_by(|a, b| {
            let a_score = a.channel_id.as_ref()
                .and_then(|id| channel_to_score.get(id.as_str()))
                .copied()
                .unwrap_or(0);
            let b_score = b.channel_id.as_ref()
                .and_then(|id| channel_to_score.get(id.as_str()))
                .copied()
                .unwrap_or(0);
            b_score.cmp(&a_score)
        });

        streams
    }
}