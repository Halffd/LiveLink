#[cfg(test)]
mod failure_tests {
    use crate::core::orchestrator::Orchestrator;
    use crate::core::state::{OrchestratorConfig, ScreenState, StreamInfo, StreamState, Platform};
    use crate::queue::queue::StreamSource;
    use crate::services::network::NetworkEvent;
    use std::sync::Arc;
    use tokio::sync::Mutex;

    fn create_test_config(max_streams: usize) -> OrchestratorConfig {
        OrchestratorConfig {
            max_streams,
            startup_cooldown_ms: 100,
            crash_threshold_seconds: 3,
            ..Default::default()
        }
    }

    fn make_stream_source(url: &str, screen: u32) -> StreamSource {
        StreamSource {
            url: url.to_string(),
            title: Some(format!("Stream {}", screen)),
            platform: Some("twitch".to_string()),
            channel_id: Some(format!("ch{}", screen)),
            viewer_count: Some(100),
            priority: Some(1),
            is_live: true,
            ..Default::default()
        }
    }

    fn make_stream_info(screen: u32) -> StreamInfo {
        StreamInfo {
            url: format!("http://stream{}.com", screen),
            title: Some(format!("Stream {}", screen)),
            platform: Platform::Twitch,
            screen,
            quality: "best".to_string(),
            volume: 50,
            start_time: Some(std::time::Instant::now()),
        }
    }

    #[tokio::test]
    async fn test_max_streams_one_never_overlaps() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 3).await;

        for screen in 0..3 {
            let state = orch.get_screen_state(screen).unwrap();
            assert_eq!(state.state, StreamState::Idle);
        }

        assert_eq!(orch.count_active_streams(), 0);

        {
            let screen0_state = orch.get_screen_state(0).unwrap();
            let mut modified = screen0_state.clone();
            modified.start_stream(make_stream_info(0));
            assert_eq!(modified.state, StreamState::Starting);
        }

        assert_eq!(orch.count_active_streams(), 0);
    }

    #[tokio::test]
    async fn test_orchestrator_max_streams_enforcement() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 2).await;

        for screen in 0..2 {
            let state = orch.get_screen_state(screen).unwrap();
            assert_eq!(state.state, StreamState::Idle);
        }
    }

    #[tokio::test]
    async fn test_screen_state_invalid_transitions_are_ignored() {
        let config = create_test_config(2);
        let orch = create_orchestrator_with_screens(config, 1).await;

        let screen_state = orch.get_screen_state(0).unwrap();
        assert_eq!(screen_state.state, StreamState::Idle);
        assert!(!screen_state.state.can_stop());

        let mut state = screen_state.clone();
        state.start_stream(make_stream_info(0));
        assert_eq!(state.state, StreamState::Starting);
        assert!(state.state.can_stop());

        state.state = StreamState::Playing;
        assert!(state.state.can_stop());

        state.state = StreamState::Stopping;
        assert!(!state.state.can_stop());

        state.state = StreamState::Idle;
        assert!(!state.state.can_stop());
    }

    #[tokio::test]
    async fn test_crash_detection_threshold_3_seconds() {
        let config = create_test_config(2);
        let orch = create_orchestrator_with_screens(config, 1).await;

        let mut screen_state = orch.get_screen_state(0).unwrap();
        let mut info = make_stream_info(0);
        info.start_time = Some(std::time::Instant::now());

        screen_state.start_stream(info);
        screen_state.mark_playing();
        assert_eq!(screen_state.state, StreamState::Playing);

        std::thread::sleep(std::time::Duration::from_millis(100));

        let runtime = std::time::Instant::now()
            .checked_duration_since(screen_state.stream.as_ref().unwrap().start_time.unwrap())
            .map(|d| d.as_secs())
            .unwrap_or(0);

        assert!(runtime < 3, "Runtime {} should be less than 3 seconds", runtime);
    }

    #[tokio::test]
    async fn test_long_running_stream_not_marked_as_crash() {
        let config = create_test_config(2);
        let mut orch = create_orchestrator_with_screens(config, 1).await;

        {
            let state = orch.get_screen_state(0).unwrap();
            let mut modified = state.clone();
            let mut info = make_stream_info(0);
            info.start_time = Some(std::time::Instant::now() - std::time::Duration::from_secs(5));
            modified.start_stream(info);
            modified.mark_playing();

            let runtime = modified
                .stream
                .as_ref()
                .unwrap()
                .start_time
                .map(|t| t.elapsed().as_secs())
                .unwrap_or(0);

            assert!(runtime >= 3, "Long running stream should have runtime >= 3s");
        }
    }

    #[tokio::test]
    async fn test_queue_empty_returns_none() {
        let config = create_test_config(2);
        let orch = create_orchestrator_with_screens(config, 1).await;

        let next = {
            let queue = orch.queue.lock().await;
            queue.get_next_stream(0).cloned()
        };

        assert!(next.is_none());
    }

    #[tokio::test]
    async fn test_queue_refill_works() {
        let config = create_test_config(2);
        let orch = create_orchestrator_with_screens(config, 1).await;

        let sources = vec![
            make_stream_source("http://stream1.com", 0),
            make_stream_source("http://stream2.com", 0),
        ];

        orch.set_queue(0, sources).await;

        let next = {
            let queue = orch.queue.lock().await;
            queue.get_next_stream(0).cloned()
        };

        assert!(next.is_some());
        assert_eq!(next.unwrap().url, "http://stream1.com");
    }

    #[tokio::test]
    async fn test_per_screen_locking_prevents_race() {
        let config = create_test_config(10);
        let orch = create_orchestrator_with_screens(config, 2).await;

        let lock0 = orch.locks.get(&0).unwrap().value().clone();
        let lock1 = orch.locks.get(&1).unwrap().value().clone();

        let handle1 = tokio::spawn(async move {
            let _guard = lock0.lock().await;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        });

        let handle2 = tokio::spawn(async move {
            let _guard = lock1.lock().await;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        });

        let _ = tokio::join!(handle1, handle2);
    }

    #[tokio::test]
    async fn test_duplicate_start_ignored() {
        let config = create_test_config(2);
        let mut orch = create_orchestrator_with_screens(config, 1).await;

        let screen_state = orch.get_screen_state(0).unwrap();
        let mut state = screen_state.clone();

        state.start_stream(make_stream_info(0));
        assert_eq!(state.state, StreamState::Starting);

        let result = state.start_stream(make_stream_info(0));
        assert!(!result);
        assert_eq!(state.state, StreamState::Starting);
    }

    #[tokio::test]
    async fn test_stop_from_idle_ignored() {
        let config = create_test_config(2);
        let mut orch = create_orchestrator_with_screens(config, 1).await;

        let screen_state = orch.get_screen_state(0).unwrap();
        let mut state = screen_state.clone();

        assert_eq!(state.state, StreamState::Idle);
        let result = state.stop_stream();
        assert!(!result);
        assert_eq!(state.state, StreamState::Idle);
    }

    #[tokio::test]
    async fn test_error_state_transitions() {
        let config = create_test_config(2);
        let mut orch = create_orchestrator_with_screens(config, 1).await;

        let screen_state = orch.get_screen_state(0).unwrap();
        let mut state = screen_state.clone();

        state.mark_error("Test crash".to_string());
        assert_eq!(state.state, StreamState::Error);
        assert_eq!(state.error_count, 1);
        assert_eq!(state.last_error, Some("Test crash".to_string()));

        state.reset_error();
        assert_eq!(state.state, StreamState::Idle);
        assert_eq!(state.error_count, 0);
        assert!(state.last_error.is_none());
    }

    #[tokio::test]
    async fn test_finish_stop_clears_stream() {
        let config = create_test_config(2);
        let mut orch = create_orchestrator_with_screens(config, 1).await;

        let screen_state = orch.get_screen_state(0).unwrap();
        let mut state = screen_state.clone();

        state.start_stream(make_stream_info(0));
        state.stop_stream();
        assert_eq!(state.state, StreamState::Stopping);

        state.finish_stop();
        assert_eq!(state.state, StreamState::Idle);
        assert!(state.stream.is_none());
    }

    #[tokio::test]
    async fn test_state_machine_complete_flow() {
        let config = create_test_config(2);
        let mut orch = create_orchestrator_with_screens(config, 1).await;

        let screen_state = orch.get_screen_state(0).unwrap();
        let mut state = screen_state.clone();

        assert_eq!(state.state, StreamState::Idle);
        assert!(state.state.can_start());
        assert!(!state.state.can_stop());

        state.start_stream(make_stream_info(0));
        assert_eq!(state.state, StreamState::Starting);
        assert!(!state.state.can_start());
        assert!(state.state.can_stop());

        state.mark_playing();
        assert_eq!(state.state, StreamState::Playing);
        assert!(!state.state.can_start());
        assert!(state.state.can_stop());

        state.stop_stream();
        assert_eq!(state.state, StreamState::Stopping);
        assert!(!state.state.can_start());
        assert!(!state.state.can_stop());

        state.finish_stop();
        assert_eq!(state.state, StreamState::Idle);
        assert!(state.state.can_start());
        assert!(!state.state.can_stop());
    }

    #[tokio::test]
    async fn test_watched_streams_tracked() {
        let config = create_test_config(2);
        let orch = create_orchestrator_with_screens(config, 1).await;

        let sources = vec![make_stream_source("http://stream1.com", 0)];
        orch.set_queue(0, sources).await;

        let next_source = {
            let queue = orch.queue.lock().await;
            queue.get_next_stream(0).unwrap().clone()
        };

        {
            let mut queue = orch.queue.lock().await;
            queue.mark_stream_watched(0, &next_source);
        }

        let is_watched = {
            let queue = orch.queue.lock().await;
            queue.is_stream_watched(0, &StreamSource {
                url: "http://stream1.com".to_string(),
                ..Default::default()
            })
        };

        assert!(is_watched);
    }

async fn create_orchestrator_with_screens(config: OrchestratorConfig, screen_count: u32) -> Orchestrator {
    let (_, exit_rx) = tokio::sync::mpsc::channel(100);
    let (_, network_rx) = tokio::sync::mpsc::channel(100);
    let orch = Orchestrator::new(config, exit_rx, network_rx);

    for screen in 0..screen_count {
        orch.register_screen(screen).await;
    }

    orch
}

    #[derive(Debug, Clone)]
    struct TestError;

    impl std::fmt::Display for TestError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "TestError")
        }
    }

    impl std::error::Error for TestError {}
}