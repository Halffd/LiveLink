use crate::core::state::{
    OrchestratorConfig, Platform, ScreenState, StreamInfo, StreamState,
};
use crate::queue::queue::{QueueService, StreamSource};
use crate::services::player::{PlayerService, ProcessExit};
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

pub struct Orchestrator {
    config: OrchestratorConfig,
    state: DashMap<u32, ScreenState>,
    locks: DashMap<u32, Arc<Mutex<()>>>,
    player: Arc<Mutex<PlayerService>>,
    queue: Arc<Mutex<QueueService>>,
    max_streams: usize,
}

impl Orchestrator {
    pub fn new(config: OrchestratorConfig, exit_receiver: mpsc::Receiver<ProcessExit>) -> Self {
        let max_streams = config.max_streams;
        let (exit_sender, receiver) = mpsc::channel(100);
        drop(exit_receiver);

        let player = PlayerService::new(exit_sender);
        let queue = QueueService::new();

        let orchestrator = Self {
            config,
            state: DashMap::new(),
            locks: DashMap::new(),
            player: Arc::new(Mutex::new(player)),
            queue: Arc::new(Mutex::new(queue)),
            max_streams,
        };

        let orchestrator_clone = Arc::new(orchestrator.clone_inner());
        tokio::spawn(async move {
            Self::exit_listener(receiver, orchestrator_clone).await;
        });

        orchestrator
    }

    fn clone_inner(&self) -> Self {
        Self {
            config: self.config.clone(),
            state: DashMap::new(),
            locks: DashMap::new(),
            player: self.player.clone(),
            queue: self.queue.clone(),
            max_streams: self.max_streams,
        }
    }

    async fn exit_listener(
        mut receiver: mpsc::Receiver<ProcessExit>,
        orchestrator: Arc<Orchestrator>,
    ) {
        while let Some(exit) = receiver.recv().await {
            info!(screen = exit.screen, pid = exit.pid, code = ?exit.exit_code, "Process exit received");
            orchestrator.handle_process_exit(exit.screen, exit.exit_code).await;
        }
    }

    pub async fn register_screen(&self, screen: u32) {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let mut state = ScreenState::new(screen);
        state.state = StreamState::Idle;
        self.state.insert(screen, state);
        info!(screen, "Screen registered");
    }

    pub async fn set_queue(&self, screen: u32, sources: Vec<StreamSource>) {
        let mut queue = self.queue.lock().await;
        queue.set_queue(screen, sources);
    }

    pub async fn start_stream(&self, screen: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        let mut screen_state = self
            .state
            .get_mut(&screen)
            .ok_or_else(|| format!("Screen {} not found", screen))?;

        if screen_state.state != StreamState::Idle {
            return Err(format!(
                "Screen {} not idle (state: {})",
                screen, screen_state.state
            ));
        }

        let active_count = self.count_active_streams_internal();
        if active_count >= self.max_streams {
            return Err(format!(
                "Max streams ({}) reached, {} active",
                self.max_streams, active_count
            ));
        }

        let stream_source = {
            let mut queue = self.queue.lock().await;
            queue.dequeue_next(screen)
        };

        let stream_source = stream_source.ok_or_else(|| format!("No stream in queue for screen {}", screen))?;

        let platform = match stream_source.platform.as_deref() {
            Some("twitch") => Platform::Twitch,
            Some("youtube") => Platform::YouTube,
            _ => Platform::Holodex,
        };

        let url = stream_source.url.clone();
        let stream_info = StreamInfo {
            url: url.clone(),
            title: stream_source.title.clone(),
            platform,
            screen,
            quality: "best".to_string(),
            volume: 50,
            start_time: Some(std::time::Instant::now()),
        };

        screen_state.start_stream(stream_info);

        drop(screen_state);

        let player = self.player.clone();
        let player_screen = screen;
        let url_clone = url.clone();

        tokio::spawn(async move {
            let mut player_guard = player.lock().await;
            if let Err(e) = player_guard.start_process(player_screen, &url_clone, 1280, 720, 0, 0).await {
                error!(screen = player_screen, error = %e, "Failed to start process");
            }
        });

        info!(screen, url = %url, "Stream starting");
        Ok(())
    }

    pub async fn stop_stream(&self, screen: u32) -> Result<(), String> {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        self.stop_stream_locked(screen).await
    }

    async fn stop_stream_locked(&self, screen: u32) -> Result<(), String> {
        let mut screen_state = self
            .state
            .get_mut(&screen)
            .ok_or_else(|| format!("Screen {} not found", screen))?;

        if !screen_state.state.can_stop() {
            return Err(format!(
                "Screen {} cannot stop (state: {})",
                screen, screen_state.state
            ));
        }

        let url = screen_state.stream.as_ref().map(|s| s.url.clone());

        screen_state.stop_stream();

        drop(screen_state);

        let player = self.player.clone();
        tokio::spawn(async move {
            let mut player_guard = player.lock().await;
            if let Err(e) = player_guard.stop_process(screen).await {
                warn!(screen, error = %e, "Failed to stop process");
            }
        });

        let mut screen_state = self.state.get_mut(&screen).unwrap();
        screen_state.finish_stop();

        if let Some(url) = url {
            let mut queue = self.queue.lock().await;
            queue.mark_stream_watched(screen, &StreamSource {
                url,
                ..Default::default()
            });
        }

        info!(screen, "Stream stopped");
        Ok(())
    }

    pub async fn handle_process_exit(&self, screen: u32, exit_code: Option<i32>) {
        let lock = match self.locks.get(&screen) {
            Some(l) => l.value().clone(),
            None => {
                warn!(screen, "Process exit but no lock, ignoring");
                return;
            }
        };

        let _guard = lock.lock().await;

        let mut screen_state = match self.state.get_mut(&screen) {
            Some(s) => s,
            None => {
                warn!(screen, "Process exit but no screen state");
                return;
            }
        };

        if screen_state.state != StreamState::Playing && screen_state.state != StreamState::Starting {
            debug!(screen, state = %screen_state.state, "Ignoring process exit for non-active stream");
            return;
        }

        let runtime = screen_state
            .stream
            .as_ref()
            .and_then(|s| s.start_time)
            .map(|start| start.elapsed().as_secs())
            .unwrap_or(u64::MAX);

        let url = screen_state.stream.as_ref().map(|s| s.url.clone()).unwrap_or_default();

        if runtime < self.config.crash_threshold_seconds {
            screen_state.mark_error(format!("Crash after {}s (code: {:?})", runtime, exit_code));
            warn!(screen, url = %url, runtime, "Stream crashed - entering error state");

            drop(screen_state);

            tokio::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            });
        } else {
            let url_for_queue = url.clone();
            screen_state.finish_stop();

            drop(screen_state);

            if !url_for_queue.is_empty() {
                let mut queue = self.queue.lock().await;
                queue.mark_stream_watched(screen, &StreamSource {
                    url: url_for_queue,
                    ..Default::default()
                });
            }

            info!(screen, url = %url, runtime, "Stream ended normally");
        }
    }

    pub async fn get_state(&self, screen: u32) -> Option<StreamState> {
        self.state.get(&screen).map(|s| s.state)
    }

    pub fn count_active_streams(&self) -> usize {
        self.count_active_streams_internal()
    }

    fn count_active_streams_internal(&self) -> usize {
        self.state
            .iter()
            .filter(|s| s.state == StreamState::Playing || s.state == StreamState::Starting)
            .count()
    }

    pub fn poll_player_exits(&self) {
        let player = self.player.clone();
        tokio::spawn(async move {
            let mut player_guard = player.lock().await;
            player_guard.poll_processes();
        });
    }

    async fn get_or_create_lock(&self, screen: u32) -> Arc<Mutex<()>> {
        self.locks
            .get(&screen)
            .map(|r| r.value().clone())
            .unwrap_or_else(|| {
                let lock = Arc::new(Mutex::new(()));
                self.locks.insert(screen, lock.clone());
                lock
            })
    }
}

impl Clone for Orchestrator {
    fn clone(&self) -> Self {
        Self {
            config: self.config.clone(),
            state: DashMap::new(),
            locks: DashMap::new(),
            player: self.player.clone(),
            queue: self.queue.clone(),
            max_streams: self.max_streams,
        }
    }
}