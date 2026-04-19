#[cfg(test)]
mod tests {
    use crate::core::state::{OrchestratorConfig, StreamState};
    use crate::queue::queue::{Queue, StreamSource};
    use crate::core::state::ScreenState;
    use crate::core::state::StreamInfo;
    use crate::core::state::Platform;

    fn create_test_config(max_streams: usize) -> OrchestratorConfig {
        OrchestratorConfig {
            max_streams,
            startup_cooldown_ms: 100,
            crash_threshold_seconds: 3,
            ..Default::default()
        }
    }

    #[test]
    fn test_stream_state_idle_transitions() {
        let state = StreamState::Idle;

        assert!(state.can_start());
        assert!(!state.can_stop());
        assert!(state.valid_transition_to(StreamState::Starting));
        assert!(!state.valid_transition_to(StreamState::Playing));
    }

    #[test]
    fn test_stream_state_starting_transitions() {
        let state = StreamState::Starting;

        assert!(!state.can_start());
        assert!(state.can_stop());
        assert!(state.valid_transition_to(StreamState::Playing));
        assert!(state.valid_transition_to(StreamState::Idle));
        assert!(state.valid_transition_to(StreamState::Error));
    }

    #[test]
    fn test_stream_state_playing_transitions() {
        let state = StreamState::Playing;

        assert!(!state.can_start());
        assert!(state.can_stop());
        assert!(state.valid_transition_to(StreamState::Stopping));
        assert!(state.valid_transition_to(StreamState::Idle));
        assert!(state.valid_transition_to(StreamState::Error));
    }

    #[test]
    fn test_stream_state_stopping_transitions() {
        let state = StreamState::Stopping;

        assert!(!state.can_start());
        assert!(!state.can_stop());
        assert!(state.valid_transition_to(StreamState::Idle));
        assert!(state.valid_transition_to(StreamState::Error));
    }

    #[test]
    fn test_screen_state_start_stream() {
        let mut screen = ScreenState::new(0);

        assert_eq!(screen.state, StreamState::Idle);

        let info = StreamInfo {
            url: "http://test.com".to_string(),
            title: Some("Test".to_string()),
            platform: Platform::Twitch,
            screen: 0,
            quality: "best".to_string(),
            volume: 50,
            start_time: None,
        };

        let result = screen.start_stream(info);
        assert!(result);
        assert_eq!(screen.state, StreamState::Starting);
        assert!(screen.stream.is_some());
        assert_eq!(screen.error_count, 0);
    }

    #[test]
    fn test_screen_state_invalid_start() {
        let mut screen = ScreenState::new(0);
        screen.state = StreamState::Starting;

        let info = StreamInfo {
            url: "http://test.com".to_string(),
            title: Some("Test".to_string()),
            platform: Platform::Twitch,
            screen: 0,
            quality: "best".to_string(),
            volume: 50,
            start_time: None,
        };

        let result = screen.start_stream(info);
        assert!(!result);
        assert_eq!(screen.state, StreamState::Starting);
    }

    #[test]
    fn test_screen_state_stop_stream() {
        let mut screen = ScreenState::new(0);
        screen.state = StreamState::Playing;

        let result = screen.stop_stream();
        assert!(result);
        assert_eq!(screen.state, StreamState::Stopping);
    }

    #[test]
    fn test_screen_state_cannot_stop_from_idle() {
        let mut screen = ScreenState::new(0);
        assert_eq!(screen.state, StreamState::Idle);

        let result = screen.stop_stream();
        assert!(!result);
        assert_eq!(screen.state, StreamState::Idle);
    }

    #[test]
    fn test_screen_state_finish_stop() {
        let mut screen = ScreenState::new(0);
        screen.state = StreamState::Stopping;

        screen.finish_stop();

        assert_eq!(screen.state, StreamState::Idle);
        assert!(screen.stream.is_none());
    }

    #[test]
    fn test_screen_state_mark_playing() {
        let mut screen = ScreenState::new(0);
        screen.state = StreamState::Starting;

        screen.mark_playing();

        assert_eq!(screen.state, StreamState::Playing);
    }

    #[test]
    fn test_screen_state_mark_error() {
        let mut screen = ScreenState::new(0);
        screen.state = StreamState::Playing;

        screen.mark_error("Test error".to_string());

        assert_eq!(screen.state, StreamState::Error);
        assert_eq!(screen.error_count, 1);
        assert_eq!(screen.last_error, Some("Test error".to_string()));
    }

    #[test]
    fn test_screen_state_reset_error() {
        let mut screen = ScreenState::new(0);
        screen.state = StreamState::Error;
        screen.error_count = 3;
        screen.last_error = Some("Test error".to_string());

        screen.reset_error();

        assert_eq!(screen.state, StreamState::Idle);
        assert_eq!(screen.error_count, 0);
        assert!(screen.last_error.is_none());
    }

    #[test]
    fn test_queue_ordering() {
        let sources = vec![
            StreamSource {
                url: "http://stream3.com".to_string(),
                priority: Some(3),
                ..Default::default()
            },
            StreamSource {
                url: "http://stream1.com".to_string(),
                priority: Some(1),
                ..Default::default()
            },
            StreamSource {
                url: "http://stream2.com".to_string(),
                priority: Some(2),
                ..Default::default()
            },
        ];

        let mut queue = Queue::with_sources(sources);
        queue.sort_by_priority();

        let next = queue.get_next().unwrap();
        assert_eq!(next.url, "http://stream1.com");
    }

    #[test]
    fn test_queue_dequeue() {
        let sources = vec![
            StreamSource {
                url: "http://stream1.com".to_string(),
                title: Some("Stream 1".to_string()),
                platform: Some("twitch".to_string()),
                ..Default::default()
            },
            StreamSource {
                url: "http://stream2.com".to_string(),
                title: Some("Stream 2".to_string()),
                platform: Some("twitch".to_string()),
                ..Default::default()
            },
        ];

        let mut queue = Queue::with_sources(sources);

        let first = queue.remove_next();
        assert!(first.is_some());
        assert_eq!(first.unwrap().url, "http://stream1.com");

        let second = queue.remove_next();
        assert!(second.is_some());
        assert_eq!(second.unwrap().url, "http://stream2.com");

        assert!(queue.is_empty());
    }

    #[test]
    fn test_queue_mark_watched() {
        let sources = vec![StreamSource {
            url: "http://stream1.com".to_string(),
            channel_id: Some("ch123".to_string()),
            platform: Some("twitch".to_string()),
            ..Default::default()
        }];

        let mut queue = Queue::with_sources(sources);

        {
            let source = queue.get_next().unwrap().clone();
            assert!(!queue.is_watched(&source));
            queue.mark_watched(&source);
        }

        let source_after = queue.get_next().map(|s| s.clone()).unwrap();
        assert!(queue.is_watched(&source_after));
    }

    #[test]
    fn test_queue_is_watched_by_channel_id() {
        let sources = vec![StreamSource {
            url: "http://stream1.com".to_string(),
            channel_id: Some("ch123".to_string()),
            platform: Some("twitch".to_string()),
            ..Default::default()
        }];

        let mut queue = Queue::with_sources(sources);

        let first_source = queue.get_next().map(|s| s.clone()).unwrap();
        queue.mark_watched(&first_source);

        let same_stream = StreamSource {
            url: "http://different-url.com".to_string(),
            channel_id: Some("ch123".to_string()),
            platform: Some("twitch".to_string()),
            ..Default::default()
        };

        assert!(queue.is_watched(&same_stream));
    }

    #[tokio::test]
    async fn test_orchestrator_config_max_streams() {
        let config = create_test_config(1);
        assert_eq!(config.max_streams, 1);

        let config2 = create_test_config(5);
        assert_eq!(config2.max_streams, 5);
    }

    #[test]
    fn test_crash_detection_threshold() {
        let config = create_test_config(2);
        assert_eq!(config.crash_threshold_seconds, 3);
    }

    #[test]
    fn test_platform_display() {
        assert_eq!(format!("{}", Platform::Twitch), "Twitch");
        assert_eq!(format!("{}", Platform::YouTube), "YouTube");
        assert_eq!(format!("{}", Platform::Holodex), "Holodex");
    }

    #[test]
    fn test_stream_state_display() {
        assert_eq!(format!("{}", StreamState::Idle), "Idle");
        assert_eq!(format!("{}", StreamState::Starting), "Starting");
        assert_eq!(format!("{}", StreamState::Playing), "Playing");
        assert_eq!(format!("{}", StreamState::Stopping), "Stopping");
        assert_eq!(format!("{}", StreamState::Error), "Error");
    }
}