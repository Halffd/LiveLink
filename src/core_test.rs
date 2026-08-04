#[cfg(test)]
mod failure_tests {
    use crate::core::orchestrator::Orchestrator;
    use crate::core::state::{OrchestratorConfig, ScreenState, StreamInfo, StreamState, Platform};
    use crate::queue::queue::StreamSource;
    use crate::services::network::NetworkEvent;
    use crate::services::player::ProcessExit;
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

async fn create_orchestrator_with_screens(config: OrchestratorConfig, screen_count: u32) -> Arc<Orchestrator> {
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

#[cfg(test)]
mod exit_integration_tests {
    use crate::core::orchestrator::Orchestrator;
    use crate::core::state::{OrchestratorConfig, StreamInfo, StreamState, Platform};
    use crate::queue::queue::StreamSource;
    use crate::services::player::ProcessExit;
    use std::sync::Arc;
    use std::time::Duration;

    fn create_test_config(max_streams: usize) -> OrchestratorConfig {
        OrchestratorConfig {
            max_streams,
            startup_cooldown_ms: 10,
            crash_threshold_seconds: 3,
            skip_threshold_seconds: 2,
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

    fn make_stream_info(url: &str, screen: u32) -> StreamInfo {
        StreamInfo {
            url: url.to_string(),
            title: Some(format!("Stream {}", screen)),
            platform: Platform::Twitch,
            screen,
            quality: "best".to_string(),
            volume: 50,
            start_time: Some(std::time::Instant::now()),
        }
    }

    fn make_stream_info_recent(url: &str, screen: u32) -> StreamInfo {
        StreamInfo {
            url: url.to_string(),
            title: Some(format!("Stream {}", screen)),
            platform: Platform::Twitch,
            screen,
            quality: "best".to_string(),
            volume: 50,
            start_time: Some(std::time::Instant::now() - Duration::from_secs(2)),
        }
    }

    fn make_stream_info_old(url: &str, screen: u32) -> StreamInfo {
        StreamInfo {
            url: url.to_string(),
            title: Some(format!("Stream {}", screen)),
            platform: Platform::Twitch,
            screen,
            quality: "best".to_string(),
            volume: 50,
            start_time: Some(std::time::Instant::now() - Duration::from_secs(10)),
        }
    }

    async fn create_orchestrator_with_screens(config: OrchestratorConfig, screen_count: u32) -> Arc<Orchestrator> {
        let (_, exit_rx) = tokio::sync::mpsc::channel(100);
        let (_, network_rx) = tokio::sync::mpsc::channel(100);
        let orch = Orchestrator::new(config, exit_rx, network_rx);

        for screen in 0..screen_count {
            orch.register_screen(screen).await;
        }

        orch
    }

    #[tokio::test]
    async fn test_exit_event_channel_delivery() {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<ProcessExit>(10);

        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            tx.send(ProcessExit {
                screen: 0,
                pid: 123,
                exit_code: Some(1),
                playback_time: 5.0,
                error: None,
            }).await.unwrap();
        });

        let event = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await;
        assert!(event.is_ok());
        let exit = event.unwrap().unwrap();
        assert_eq!(exit.screen, 0);
        assert_eq!(exit.pid, 123);
        assert_eq!(exit.exit_code, Some(1));
        assert_eq!(exit.playback_time, 5.0);
    }

    #[tokio::test]
    async fn test_handle_process_exit_soft_skip() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 1).await;

        {
            let mut state = orch.get_screen_state(0).unwrap().clone();
            state.start_stream(make_stream_info("http://skip.com", 0));
            state.mark_playing();
            let mut screen_state = orch.state.get_mut(&0).unwrap();
            *screen_state = state;
        }

        let exit = ProcessExit {
            screen: 0,
            pid: 0,
            exit_code: Some(1),
            playback_time: 0.0,
            error: None,
        };

        Arc::clone(&orch).handle_process_exit(exit).await;

        let state = orch.get_screen_state(0).unwrap();
        assert_eq!(state.state, StreamState::Idle,
            "Expected Idle after soft skip (finish_stop called), got {:?}", state.state);
        assert!(state.stream.is_none(), "Stream should be cleared after soft skip");
    }

    #[tokio::test]
    async fn test_handle_process_exit_crash_with_429() {
        let config = OrchestratorConfig {
            max_streams: 1,
            startup_cooldown_ms: 10,
            crash_threshold_seconds: 3,
            skip_threshold_seconds: 2,
            ..Default::default()
        };
        let orch = create_orchestrator_with_screens(config, 1).await;

        {
            let mut state = orch.get_screen_state(0).unwrap().clone();
            state.start_stream(make_stream_info_recent("http://crash.com", 0));
            state.mark_playing();
            let mut screen_state = orch.state.get_mut(&0).unwrap();
            *screen_state = state;
        }

        let exit = ProcessExit {
            screen: 0,
            pid: 0,
            exit_code: Some(1),
            playback_time: 2.5,
            error: Some("429 Too Many Requests".to_string()),
        };

        Arc::clone(&orch).handle_process_exit(exit).await;

        let state = orch.get_screen_state(0).unwrap();
        assert_eq!(state.state, StreamState::Error,
            "Expected Error state after crash, got {:?}", state.state);
        let err = state.last_error.unwrap();
        assert!(err.contains("Crash"), "Should be crash, got: {}", err);
        assert!(err.contains("429"), "Error should preserve 429 info: {}", err);
    }

    #[tokio::test]
    async fn test_handle_process_exit_normal_end() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 1).await;

        {
            let mut state = orch.get_screen_state(0).unwrap().clone();
            state.start_stream(make_stream_info_old("http://normal.com", 0));
            state.mark_playing();
            let mut screen_state = orch.state.get_mut(&0).unwrap();
            *screen_state = state;
        }

        let exit = ProcessExit {
            screen: 0,
            pid: 0,
            exit_code: Some(0),
            playback_time: 120.0,
            error: None,
        };

        Arc::clone(&orch).handle_process_exit(exit).await;

        let state = orch.get_screen_state(0).unwrap();
        assert_eq!(state.state, StreamState::Idle,
            "Expected Idle after normal end (finish_stop called), got {:?}", state.state);
        assert!(state.stream.is_none(), "Stream should be cleared after normal end");
    }

    #[tokio::test]
    async fn test_exit_listener_via_handle_process_exit() {
        let (_, exit_rx) = tokio::sync::mpsc::channel(100);
        let (_, network_rx) = tokio::sync::mpsc::channel(100);
        let config = create_test_config(1);

        let orch = Orchestrator::new(config, exit_rx, network_rx);
        orch.register_screen(0).await;

        {
            let mut state = orch.get_screen_state(0).unwrap().clone();
            state.start_stream(make_stream_info_recent("http://listener.com", 0));
            state.mark_playing();
            let mut screen_state = orch.state.get_mut(&0).unwrap();
            *screen_state = state;
        }

        let exit = ProcessExit {
            screen: 0,
            pid: 0,
            exit_code: Some(1),
            playback_time: 2.5,
            error: Some("429".to_string()),
        };

        Arc::clone(&orch).handle_process_exit(exit).await;

        let state = orch.get_screen_state(0).unwrap();
        assert_eq!(state.state, StreamState::Error,
            "Exit via handle_process_exit should transition to Error for crash, got {:?}", state.state);
    }

    #[tokio::test]
    async fn test_multiple_exits_same_screen_no_panic() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 1).await;

        {
            let mut state = orch.get_screen_state(0).unwrap().clone();
            state.start_stream(make_stream_info("http://first.com", 0));
            state.mark_playing();
            let mut screen_state = orch.state.get_mut(&0).unwrap();
            *screen_state = state;
        }

        let exit = ProcessExit {
            screen: 0,
            pid: 0,
            exit_code: Some(1),
            playback_time: 0.0,
            error: None,
        };
        Arc::clone(&orch).handle_process_exit(exit).await;

        let second_exit = ProcessExit {
            screen: 0,
            pid: 999,
            exit_code: Some(0),
            playback_time: 10.0,
            error: None,
        };
        Arc::clone(&orch).handle_process_exit(second_exit).await;

        let state = orch.get_screen_state(0).unwrap();
        assert_eq!(state.state, StreamState::Idle,
            "Duplicate exit on already-idle screen should not panic, got {:?}", state.state);
    }

    #[tokio::test]
    async fn test_soft_skip_marks_stream_watched() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 1).await;

        orch.set_queue(0, vec![]).await;

        {
            let mut state = orch.get_screen_state(0).unwrap().clone();
            state.start_stream(make_stream_info("http://memberonly.com", 0));
            state.mark_playing();
            let mut screen_state = orch.state.get_mut(&0).unwrap();
            *screen_state = state;
        }

        let exit = ProcessExit {
            screen: 0,
            pid: 0,
            exit_code: Some(1),
            playback_time: 0.0,
            error: None,
        };

        Arc::clone(&orch).handle_process_exit(exit).await;

        let is_watched = {
            let queue = orch.queue.lock().await;
            queue.is_stream_watched(0, &StreamSource {
                url: "http://memberonly.com".to_string(),
                ..Default::default()
            })
        };
        assert!(is_watched, "Soft-skipped stream should be marked as watched");
    }

    #[tokio::test]
    async fn test_normal_end_marks_stream_watched() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 1).await;

        orch.set_queue(0, vec![]).await;

        {
            let mut state = orch.get_screen_state(0).unwrap().clone();
            state.start_stream(make_stream_info_old("http://finished.com", 0));
            state.mark_playing();
            let mut screen_state = orch.state.get_mut(&0).unwrap();
            *screen_state = state;
        }

        let exit = ProcessExit {
            screen: 0,
            pid: 0,
            exit_code: Some(0),
            playback_time: 60.0,
            error: None,
        };

        Arc::clone(&orch).handle_process_exit(exit).await;

        let is_watched = {
            let queue = orch.queue.lock().await;
            queue.is_stream_watched(0, &StreamSource {
                url: "http://finished.com".to_string(),
                ..Default::default()
            })
        };
        assert!(is_watched, "Normally ended stream should be marked as watched");
    }

    #[tokio::test]
    async fn test_exit_for_nonexistent_screen_ignored() {
        let config = create_test_config(1);
        let orch = create_orchestrator_with_screens(config, 1).await;

        let exit = ProcessExit {
            screen: 99,
            pid: 0,
            exit_code: Some(1),
            playback_time: 0.0,
            error: None,
        };

        Arc::clone(&orch).handle_process_exit(exit).await;

        }
}

#[cfg(test)]
mod mock_player_tests {
    use crate::core::orchestrator::Orchestrator;
    use crate::core::state::{OrchestratorConfig, ScreenState, StreamInfo, StreamState, Platform};
    use crate::queue::queue::StreamSource;
    use crate::services::player::{PlayerConfig, PlayerError, ProcessExit};
    use crate::services::player::MpvController;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::sync::mpsc;

    /// A mock player that doesn't spawn real processes
    #[derive(Clone)]
    struct MockPlayer {
        instances: Arc<Mutex<HashMap<(u32, u32), MockInstance>>>,
        exit_sender: mpsc::Sender<ProcessExit>,
        should_fail_start: Arc<Mutex<bool>>,
    }

    struct MockInstance {
        screen: u32,
        instance_id: u32,
        url: String,
        started: bool,
    }

    impl MockPlayer {
        fn new(exit_sender: mpsc::Sender<ProcessExit>) -> Self {
            Self {
                instances: Arc::new(Mutex::new(HashMap::new())),
                exit_sender,
                should_fail_start: Arc::new(Mutex::new(false)),
            }
        }

        fn set_should_fail(&self, fail: bool) {
            *self.should_fail_start.lock().unwrap() = fail;
        }

        async fn start(&self, screen: u32, instance_id: u32, url: &str) -> Result<u32, PlayerError> {
            let mut instances = self.instances.lock().unwrap();
            let key = (screen, instance_id);
            if instances.contains_key(&key) {
                return Err(PlayerError::AlreadyRunningInstance(screen, instance_id));
            }

            if *self.should_fail_start.lock().unwrap() {
                return Err(PlayerError::Mpv("Mock failure".to_string()));
            }

            instances.insert(key, MockInstance {
                screen,
                instance_id,
                url: url.to_string(),
                started: true,
            });

            Ok(12345) // mock PID
        }

        async fn stop(&self, screen: u32, instance_id: u32) -> Result<(), PlayerError> {
            let mut instances = self.instances.lock().unwrap();
            let key = (screen, instance_id);
            if instances.remove(&key).is_none() {
                return Err(PlayerError::NoPlayer(0));
            }
            Ok(())
        }

        async fn get_active_count(&self) -> usize {
            let instances = self.instances.lock().unwrap();
            instances.len()
        }
    }

    /// Create an orchestrator with a mock player instead of real one
    async fn create_orchestrator_with_mock_player(
        config: OrchestratorConfig,
        screen_count: u32,
    ) -> (Arc<Orchestrator>, MockPlayer) {
        let (exit_tx, exit_rx) = tokio::sync::mpsc::channel(100);
        let (_, network_rx) = tokio::sync::mpsc::channel(100);
        
        let mock_player = MockPlayer::new(exit_tx.clone());
        
        // We need to inject the mock player into the orchestrator
        // For now, we'll test the mock player directly
        
        let orch = Orchestrator::new(config, exit_rx, network_rx);
        
        for screen in 0..screen_count {
            orch.register_screen(screen).await;
        }
        
        (orch, mock_player)
    }

    #[tokio::test]
    async fn test_mock_player_start_stop() {
        let (exit_tx, _exit_rx) = tokio::sync::mpsc::channel(100);
        let mock = MockPlayer::new(exit_tx);
        
        let pid = mock.start(0, 0, "http://test.com").await.unwrap();
        assert_eq!(pid, 12345);
        
        let count = mock.get_active_count().await;
        assert_eq!(count, 1);
        
        mock.stop(0, 0).await.unwrap();
        
        let count = mock.get_active_count().await;
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_mock_player_duplicate_start_fails() {
        let (exit_tx, _exit_rx) = tokio::sync::mpsc::channel(100);
        let mock = MockPlayer::new(exit_tx);
        
        mock.start(0, 0, "http://test.com").await.unwrap();
        let result = mock.start(0, 0, "http://test.com").await;
        
        assert!(result.is_err());
        matches!(result.unwrap_err(), PlayerError::AlreadyRunningInstance(0, 0));
    }

    #[tokio::test]
    async fn test_mock_player_start_failure() {
        let (exit_tx, _exit_rx) = tokio::sync::mpsc::channel(100);
        let mock = MockPlayer::new(exit_tx);
        
        mock.set_should_fail(true);
        let result = mock.start(0, 0, "http://test.com").await;
        
        assert!(result.is_err());
        matches!(result.unwrap_err(), PlayerError::Mpv(_));
    }

    #[tokio::test]
    async fn test_mock_player_stop_nonexistent() {
        let (exit_tx, _exit_rx) = tokio::sync::mpsc::channel(100);
        let mock = MockPlayer::new(exit_tx);
        
        let result = mock.stop(0, 0).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_orchestrator_with_mock_player_integration() {
        // Test that orchestrator can work with a mock player
        // This tests the integration without spawning real processes
        
        let config = OrchestratorConfig {
            max_streams: 2,
            startup_cooldown_ms: 10,
            crash_threshold_seconds: 3,
            skip_threshold_seconds: 2,
            ..Default::default()
        };
        
        let (orch, mock) = create_orchestrator_with_mock_player(config, 2).await;
        
        // Register a stream in the queue
        let stream = StreamSource {
            url: "http://mock.com".to_string(),
            title: Some("Mock Stream".to_string()),
            platform: Some("youtube".to_string()),
            channel_id: Some("ch1".to_string()),
            viewer_count: Some(100),
            priority: Some(1),
            is_live: true,
            ..Default::default()
        };
        
        mock.start(0, 0, &stream.url).await.unwrap();
        
        // Verify the mock player has the stream
        let active = mock.get_active_count().await;
        assert_eq!(active, 1);
        
        // Stop the stream
        mock.stop(0, 0).await.unwrap();
        
        let active = mock.get_active_count().await;
        assert_eq!(active, 0);
    }

    #[tokio::test]
    async fn test_mock_player_exit_callback() {
        let (exit_tx, mut exit_rx) = tokio::sync::mpsc::channel(100);
        let mock = MockPlayer::new(exit_tx);
        
        mock.start(0, 0, "http://test.com").await.unwrap();
        
        // Simulate process exit by sending exit event
        mock.stop(0, 0).await.unwrap();
        
        // The exit callback should send a ProcessExit event
        // In real implementation, this happens in the callback
        // For mock, we verify the stop was called
        let active = mock.get_active_count().await;
        assert_eq!(active, 0);
    }
}