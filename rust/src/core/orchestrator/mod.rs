pub mod clone_impl;
pub mod fetch_ops;
pub mod lock_ops;
pub mod queue_ops;
pub mod recovery_ops;
pub mod state_ops;
pub mod stream_ops;
pub mod player_ops;

use crate::core::state::{OrchestratorConfig, ScreenState, StreamState};
use crate::queue::queue::{QueueService, StreamSource};
use crate::services::fallback::FallbackService;
use crate::services::holodex::HolodexService;
use crate::services::kick::KickService;
use crate::services::niconico::NiconicoService;
use crate::services::bilibili::BilibiliService;
use crate::services::network::{NetworkEvent, NetworkState};
use crate::services::player::{PlayerConfig, PlayerService, ProcessExit};
use crate::services::twitch::TwitchService;
use crate::services::youtube::YouTubeService;
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tracing::{debug, info, warn};

pub struct Orchestrator {
    pub config: OrchestratorConfig,
    pub(crate) state: DashMap<u32, ScreenState>,
    pub(crate) locks: DashMap<u32, Arc<Mutex<()>>>,
    player: Arc<Mutex<PlayerService>>,
    pub(crate) queue: Arc<Mutex<QueueService>>,
    fallback_service: Arc<FallbackService>,
    holodex_service: Arc<HolodexService>,
    twitch_service: Arc<Mutex<TwitchService>>,
    youtube_service: Arc<Mutex<YouTubeService>>,
    kick_service: Arc<KickService>,
    niconico_service: Arc<NiconicoService>,
    bilibili_service: Arc<BilibiliService>,
    pub max_streams: usize,
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
            player_type: match config.player_type.as_str() {
                "streamlink" => crate::services::player::PlayerType::Streamlink,
                "vlc" => crate::services::player::PlayerType::VlcProcess,
                _ => crate::services::player::PlayerType::MpvProcess,
            },
            mpv_path: "mpv".to_string(),
            streamlink_path: if config.streamlink_path.is_empty() {
                "streamlink".to_string()
            } else {
                config.streamlink_path.clone()
            },
            vlc_path: if config.vlc_path.is_empty() {
                "vlc".to_string()
            } else {
                config.vlc_path.clone()
            },
            default_quality: "best".to_string(),
            default_volume: 50,
            window_maximized: false,
            log_rotation: true,
            ipc_dir: config.mpv_ipc_dir.clone(),
            mpv_gpu_context: config.mpv_gpu_context.clone(),
            mpv_priority: config.mpv_priority.clone(),
            mpv_extra_args: config.mpv_extra_args.clone(),
            streamlink_options: config.streamlink_options.clone(),
            streamlink_http_header: std::collections::HashMap::new(),
        };
        let player = PlayerService::new(exit_sender, player_config);
        let queue = QueueService::new();
        let fallback_service = FallbackService::new(config.favorite_channels.clone());
        let holodex_service = HolodexService::new(config.holodex_api_key.clone());
        let twitch_service = TwitchService::new(config.twitch_client_id.clone(), config.twitch_client_secret.clone());
        let youtube_service = YouTubeService::new(config.youtube_api_key.clone());
        let kick_service = KickService::new();
        let niconico_service = NiconicoService::new();
        let bilibili_service = BilibiliService::new();

        let orchestrator = Self {
            config: config.clone(),
            state: DashMap::new(),
            locks: DashMap::new(),
            player: Arc::new(Mutex::new(player)),
            queue: Arc::new(Mutex::new(queue)),
            fallback_service: Arc::new(fallback_service),
            holodex_service: Arc::new(holodex_service),
            twitch_service: Arc::new(Mutex::new(twitch_service)),
            youtube_service: Arc::new(Mutex::new(youtube_service)),
            kick_service: Arc::new(kick_service),
            niconico_service: Arc::new(niconico_service),
            bilibili_service: Arc::new(bilibili_service),
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
            kick_service: self.kick_service.clone(),
            niconico_service: self.niconico_service.clone(),
            bilibili_service: self.bilibili_service.clone(),
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

    pub async fn unregister_screen(&self, screen: u32) {
        let lock = self.get_or_create_lock(screen).await;
        let _guard = lock.lock().await;

        self.state.remove(&screen);
        self.locks.remove(&screen);
        info!(screen, "Screen unregistered");
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
            kick_service: self.kick_service.clone(),
            niconico_service: self.niconico_service.clone(),
            bilibili_service: self.bilibili_service.clone(),
            max_streams: self.max_streams,
        }
    }
}