use crate::core::state::{
    OrchestratorConfig, Platform, ScreenState, StreamInfo, StreamState,
};
use crate::queue::queue::{QueueService, StreamSource};
use crate::services::fallback::FallbackService;
use crate::services::holodex::HolodexService;
use crate::services::network::{NetworkEvent, NetworkState};
use crate::services::player::{PlayerConfig, PlayerService, ProcessExit};
use crate::services::twitch::TwitchService;
use crate::services::youtube::YouTubeService;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, error, info, warn};

pub struct Orchestrator {
    config: OrchestratorConfig,
    pub(crate) state: DashMap<u32, ScreenState>,
    pub(crate) locks: DashMap<u32, Arc<Mutex<()>>>,
    player: Arc<Mutex<PlayerService>>,
    pub(crate) queue: Arc<Mutex<QueueService>>,
    fallback_service: Arc<FallbackService>,
    holodex_service: Arc<HolodexService>,
    twitch_service: Arc<Mutex<TwitchService>>,
    youtube_service: Arc<YouTubeService>,
    max_streams: usize,
}

impl Orchestrator {
    pub fn new(
        config: OrchestratorConfig,
        exit_receiver: mpsc::Receiver<ProcessExit>,
        network_receiver: mpsc::Receiver<NetworkEvent>,
    ) -> Self {
        let max_streams = config.max_streams;
        let (exit_sender, receiver) = mpsc::channel(100);
        drop(exit_receiver);

        let player_config = PlayerConfig {
            player_type: crate::services::player::PlayerType::MpvProcess,
            mpv_path: "mpv".to_string(),
            streamlink_path: "streamlink".to_string(),
            default_quality: "best".to_string(),
            default_volume: 50,
            window_maximized: false,
            log_rotation: true,
        };
        let player = PlayerService::new(exit_sender, player_config);
        let queue = QueueService::new();
        let fallback_service = FallbackService::new(config.favorite_channels.clone());
        let holodex_service = HolodexService::new(config.holodex_api_key.clone());
        let twitch_service = TwitchService::new(config.twitch_client_id.clone(), config.twitch_client_secret.clone());
        let youtube_service = YouTubeService::new(config.youtube_api_key.clone());

        let orchestrator = Self {
            config: config.clone(),
            state: DashMap::new(),
            locks: DashMap::new(),
            player: Arc::new(Mutex::new(player)),
            queue: Arc::new(Mutex::new(queue)),
            fallback_service: Arc::new(fallback_service),
            holodex_service: Arc::new(holodex_service),
            twitch_service: Arc::new(Mutex::new(twitch_service)),
            youtube_service: Arc::new(youtube_service),
            max_streams,
        };

        let orchestrator_clone = Arc::new(orchestrator.clone_inner());
        let orchestrator_for_exit = orchestrator_clone.clone();

        tokio::spawn(async move {
            Self::exit_listener(receiver, orchestrator_for_exit).await;
        });

        let orchestrator_for_network = Arc::new(orchestrator.clone_inner());
        tokio::spawn(async move {
            Self::network_listener(network_receiver, orchestrator_for_network).await;
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
            fallback_service: self.fallback_service.clone(),
            holodex_service: self.holodex_service.clone(),
            twitch_service: self.twitch_service.clone(),
            youtube_service: self.youtube_service.clone(),
            max_streams: self.max_streams,
        }
    }

async fn exit_listener(
    mut receiver: mpsc::Receiver<ProcessExit>,
    orchestrator: Arc<Orchestrator>,
) {
    while let Some(exit) = receiver.recv().await {
        info!(screen = exit.screen, pid = exit.pid, code = ?exit.exit_code, playback_time = exit.playback_time, "Process exit received");
        orchestrator.handle_process_exit(exit).await;
    }
}

    async fn network_listener(
        mut receiver: mpsc::Receiver<NetworkEvent>,
        orchestrator: Arc<Orchestrator>,
    ) {
        while let Some(event) = receiver.recv().await {
            info!(state = ?event.state, "Network state changed");
            match event.state {
                NetworkState::Online => {
                    orchestrator.recover_on_network_restore().await;
                }
                NetworkState::Offline => {
                    info!("Network offline - existing streams will continue, no new starts allowed");
                }
            }
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
            if let Err(e) = player_guard.start(player_screen, &url_clone, 1280, 720, 0, 0).await {
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
            if let Err(e) = player_guard.stop(screen).await {
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

pub async fn handle_process_exit(&self, exit: ProcessExit) {
    let screen = exit.screen;
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

    // Use playback_time from mpv if available (more accurate), otherwise fall back to wall clock
    let playback_seconds = exit.playback_time as u64;
    let runtime = if playback_seconds > 0 {
        playback_seconds
    } else {
        screen_state
            .stream
            .as_ref()
            .and_then(|s| s.start_time)
            .map(|start| start.elapsed().as_secs())
            .unwrap_or(u64::MAX)
    };

    let url = screen_state.stream.as_ref().map(|s| s.url.clone()).unwrap_or_default();

    if runtime < self.config.crash_threshold_seconds {
        let error_msg = if let Some(e) = exit.error {
            format!("Crash after {}s: {}", runtime, e)
        } else {
            format!("Crash after {}s (code: {:?})", runtime, exit.exit_code)
        };
        screen_state.mark_error(error_msg);
        warn!(screen, url = %url, runtime, "Stream crashed - entering error state");
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
            let player_guard = player.lock().await;
            player_guard.poll_exits();
        });
    }

    async fn recover_on_network_restore(&self) {
        info!("Network restored - checking screens for recovery");

        let screens: Vec<u32> = self.state.iter().map(|r| r.screen).collect();

        for screen in screens {
            self.attempt_screen_recovery(screen).await;
        }
    }

    async fn attempt_screen_recovery(&self, screen: u32) {
        let lock = match self.locks.get(&screen) {
            Some(l) => l.value().clone(),
            None => return,
        };

        let _guard = lock.lock().await;

        let screen_state = match self.state.get(&screen) {
            Some(s) => s,
            None => return,
        };

        match screen_state.state {
            StreamState::Idle | StreamState::Error => {
                debug!(screen, state = %screen_state.state, "Screen needs recovery");
            }
            StreamState::Playing | StreamState::Starting | StreamState::Stopping => {
                debug!(screen, state = %screen_state.state, "Screen does not need recovery");
                return;
            }
        }

        if screen_state.stream.is_none() {
            debug!(screen, "No stream info to recover");
            return;
        }

        drop(screen_state);

        let active_count = self.count_active_streams_internal();
        if active_count >= self.max_streams {
            info!(screen, active_count, max = self.max_streams, "Cannot recover - max streams reached");
            return;
        }

        let stream_info = self.state.get(&screen).and_then(|s| s.stream.clone());

        if let Some(info) = stream_info {
            info!(screen, url = %info.url, "Recovering stream");

            let player = self.player.clone();
            let player_screen = screen;
            let url = info.url.clone();

            tokio::spawn(async move {
                let mut player_guard = player.lock().await;
                match player_guard.start(player_screen, &url, 1280, 720, 0, 0).await {
                    Ok(_) => info!(screen, url = %url, "Stream recovered successfully"),
                    Err(e) => error!(screen, url = %url, error = %e, "Failed to recover stream"),
                }
            });

            let mut state = self.state.get_mut(&screen).unwrap();
            state.state = StreamState::Starting;
            if let Some(ref mut stream) = state.stream {
                stream.start_time = Some(std::time::Instant::now());
            }
        }
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

    /// Fetch streams for a screen using the fallback chain:
    /// 1. If API service is enabled (API key present) → use API
    /// 2. If no API key → use favorite channels from config (FallbackService)
    ///
    /// This method is intended to be called when populating the queue
    /// from configured sources. The actual service integrations (Twitch, Holodex, YouTube)
    /// will be checked here once they are wired to the Orchestrator.
pub async fn fetch_streams_for_screen(&self, screen: u32) -> Vec<StreamSource> {
    if self.holodex_service.is_enabled() {
        match self.holodex_service.get_live_streams().await {
            Ok(streams) => {
                debug!(screen, count = streams.len(), "Fetched streams from Holodex API");
                return streams;
            }
            Err(e) => {
                warn!(screen, error = %e, "Holodex API failed, falling back to favorites");
            }
        }
    }

    if self.twitch_service.lock().await.is_enabled() {
        let twitch_channels: Vec<String> = self.config
            .favorite_channels
            .twitch
            .default
            .iter()
            .map(|ch| ch.id.clone())
            .collect();

        if !twitch_channels.is_empty() {
            let mut twitch = self.twitch_service.lock().await;
            if twitch.authenticate().await.is_ok() {
                match twitch.get_live_streams(&twitch_channels).await {
                    Ok(streams) => {
                        debug!(screen, count = streams.len(), "Fetched streams from Twitch API");
                        return streams;
                    }
                    Err(e) => {
                        warn!(screen, error = %e, "Twitch API failed, falling back");
                    }
                }
            } else {
                warn!(screen, "Twitch authentication failed");
            }
        }
    }

    if self.youtube_service.is_enabled() {
        let yt_channels: Vec<String> = self.config
            .favorite_channels
            .youtube
            .default
            .iter()
            .map(|ch| ch.id.clone())
            .collect();

        if !yt_channels.is_empty() {
            match self.youtube_service.get_live_streams(&yt_channels).await {
                Ok(streams) => {
                    debug!(screen, count = streams.len(), "Fetched streams from YouTube API");
                    return streams;
                }
                Err(e) => {
                    warn!(screen, error = %e, "YouTube API failed, falling back");
                }
            }
        }
    }

    if self.fallback_service.is_empty() {
        warn!(screen, "No favorite channels configured and no API services available");
        return Vec::new();
    }

    let streams = self.fallback_service.all_streams();
    debug!(screen, count = streams.len(), "Fetched streams from fallback service");
    streams
}

pub fn get_favorite_channels(&self) -> crate::config::FavoriteChannels {
    self.config.favorite_channels.clone()
}

    #[cfg(test)]
    pub fn get_screen_state(&self, screen: u32) -> Option<ScreenState> {
        self.state.get(&screen).map(|r| r.clone())
    }

    #[cfg(test)]
    pub fn queue(&self) -> &Arc<Mutex<QueueService>> {
        &self.queue
    }

    #[cfg(test)]
    pub fn locks(&self) -> &DashMap<u32, Arc<Mutex<()>>> {
        &self.locks
    }

    pub fn get_queue(&self) -> Arc<Mutex<QueueService>> {
        self.queue.clone()
    }

    pub async fn clear_watched(&self, screen: u32) {
        let mut queue = self.queue.lock().await;
        queue.clear_watched(screen);
        info!(screen, "Cleared watched history for screen");
    }

    pub async fn clear_all_watched(&self) {
        let mut queue = self.queue.lock().await;
        queue.clear_all_watched();
        info!("Cleared all watched history");
    }

    pub async fn cleanup_expired_watched(&self, max_age_hours: i64) -> usize {
        let max_age_seconds = max_age_hours * 3600;
        let mut queue = self.queue.lock().await;
        let removed = queue.cleanup_expired_watched(max_age_seconds);
        if removed > 0 {
            info!(count = removed, "Cleaned up expired watched entries");
        }
        removed
    }

    pub fn is_screen_enabled(&self, screen: u32) -> bool {
        self.state.get(&screen).map(|s| s.enabled).unwrap_or(true)
    }

    pub async fn enable_screen(&self, screen: u32) {
        if let Some(mut state) = self.state.get_mut(&screen) {
            state.enabled = true;
            info!(screen, "Screen enabled");
        }
    }

    pub async fn disable_screen(&self, screen: u32) {
        if let Some(mut state) = self.state.get_mut(&screen) {
            state.enabled = false;
            info!(screen, "Screen disabled");
        }
    }

    pub async fn player_pause(&self, screen: u32) -> Result<(), String> {
        let player = self.player.lock().await;
        player.command(screen, &["pause"]).await.map_err(|e| e.to_string())
    }

    pub async fn player_set_volume(&self, screen: u32, volume: u8) -> Result<(), String> {
        let player = self.player.lock().await;
        player.set_volume(screen, volume).await.map_err(|e| e.to_string())
    }

    pub async fn player_seek(&self, screen: u32, seconds: i64) -> Result<(), String> {
        let player = self.player.lock().await;
        player.command(screen, &["seek", &seconds.to_string()]).await.map_err(|e| e.to_string())
    }

    pub async fn refresh_queue(&self, screen: u32) -> Result<(), String> {
        let streams = self.fetch_streams_for_screen(screen).await;
        let mut queue = self.queue.lock().await;
        queue.set_queue(screen, streams);
        info!(screen, "Queue refreshed");
        Ok(())
    }

    pub async fn refresh_all_queues(&self) -> Result<(), String> {
        for screen in [0, 1] {
            let streams = self.fetch_streams_for_screen(screen).await;
            let mut queue = self.queue.lock().await;
            queue.set_queue(screen, streams);
        }
        info!("All queues refreshed");
        Ok(())
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
            fallback_service: self.fallback_service.clone(),
            holodex_service: self.holodex_service.clone(),
            twitch_service: self.twitch_service.clone(),
            youtube_service: self.youtube_service.clone(),
            max_streams: self.max_streams,
        }
    }
}