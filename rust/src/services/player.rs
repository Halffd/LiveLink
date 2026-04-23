use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use dashmap::DashMap;
use thiserror::Error;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Notify};
use tracing::{debug, error, info, warn};

#[derive(Error, Debug)]
pub enum PlayerError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("No player for screen {0}")]
    NoPlayer(u32),
    #[error("No player for screen {0} instance {1}")]
    NoPlayerInstance(u32, u32),
    #[error("Player already exists for screen {0}")]
    AlreadyRunning(u32),
    #[error("Player already exists for screen {0} instance {1}")]
    AlreadyRunningInstance(u32, u32),
    #[error("Failed to spawn process: {0}")]
    SpawnFailed(String),
    #[error("Process exited unexpectedly: {0}")]
    ProcessExited(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerType {
    Embedded,
    MpvProcess,
    Streamlink,
    VlcProcess,
}

impl Default for PlayerType {
    fn default() -> Self {
        PlayerType::MpvProcess
    }
}

#[derive(Debug, Clone)]
pub struct PlayerConfig {
    pub player_type: PlayerType,
    pub mpv_path: String,
    pub streamlink_path: String,
    pub vlc_path: String,
    pub default_quality: String,
    pub default_volume: u8,
    pub window_maximized: bool,
    pub log_rotation: bool,
    pub ipc_dir: String,
    pub mpv_gpu_context: String,
    pub mpv_priority: String,
    pub mpv_extra_args: Vec<String>,
    pub streamlink_options: std::collections::HashMap<String, serde_json::Value>,
    pub streamlink_http_header: std::collections::HashMap<String, String>,
}

impl Default for PlayerConfig {
    fn default() -> Self {
        Self {
            player_type: PlayerType::MpvProcess,
            mpv_path: "mpv".to_string(),
            streamlink_path: "streamlink".to_string(),
            vlc_path: "vlc".to_string(),
            default_quality: "best".to_string(),
            default_volume: 50,
            window_maximized: false,
            log_rotation: true,
            ipc_dir: "/tmp".to_string(),
            mpv_gpu_context: "auto".to_string(),
            mpv_priority: "normal".to_string(),
            mpv_extra_args: vec![],
            streamlink_options: std::collections::HashMap::new(),
            streamlink_http_header: std::collections::HashMap::new(),
        }
    }
}

#[derive(Debug)]
pub struct PlayerInstance {
    screen: u32,
    instance_id: u32,
    process: Option<Child>,
    ipc_path: Option<PathBuf>,
    playback_time: f64,
}

impl PlayerInstance {
    fn new(screen: u32, instance_id: u32) -> Self {
        Self {
            screen,
            instance_id,
            process: None,
            ipc_path: None,
            playback_time: 0.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProcessExit {
    pub screen: u32,
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub playback_time: f64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub enum PlayerEvent {
    Started { screen: u32, url: String },
    Stopped { screen: u32, normal: bool, playback_time: f64 },
    Error { screen: u32, error: String, is_network: bool },
}

pub struct PlayerService {
    instances: Arc<DashMap<(u32, u32), PlayerInstance>>,
    config: PlayerConfig,
    event_sender: mpsc::Sender<ProcessExit>,
    shutdown_notify: Arc<Notify>,
}

impl PlayerService {
    pub fn new(event_sender: mpsc::Sender<ProcessExit>, config: PlayerConfig) -> Self {
        Self {
            instances: Arc::new(DashMap::new()),
            config,
            event_sender,
            shutdown_notify: Arc::new(Notify::new()),
        }
    }

    pub fn with_defaults(event_sender: mpsc::Sender<ProcessExit>) -> Self {
        Self::new(event_sender, PlayerConfig::default())
    }

    pub async fn start_mpv_process(
        &self,
        screen: u32,
        instance_id: u32,
        url: &str,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
    ) -> Result<u32, PlayerError> {
        let key = (screen, instance_id);
        if self.instances.contains_key(&key) {
            return Err(PlayerError::AlreadyRunningInstance(screen, instance_id));
        }

        let ipc_path = format!("{}/mpv-ipc-{}-{}", self.config.ipc_dir, screen, instance_id);

        let mut args = vec![
            "--input-ipc-server".to_string(),
            ipc_path.clone(),
            "--geometry".to_string(),
            format!("{}x{}+{}+{}", width, height, x, y),
            "--volume".to_string(),
            self.config.default_volume.to_string(),
            "--gpu-context".to_string(),
            self.config.mpv_gpu_context.clone(),
        ];

        if self.config.mpv_priority != "normal" {
            args.push("--priority".to_string());
            args.push(self.config.mpv_priority.clone());
        }

        args.extend(self.config.mpv_extra_args.clone());

        args.push("--".to_string());
        args.push(url.to_string());

        let child = Command::new(&self.config.mpv_path)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| PlayerError::SpawnFailed(e.to_string()))?;

        let pid = child.id().ok_or_else(|| PlayerError::SpawnFailed("Failed to get pid".to_string()))?;

        let mut instance = PlayerInstance::new(screen, instance_id);
        instance.process = Some(child);
        instance.ipc_path = Some(PathBuf::from(&ipc_path));

        self.instances.insert(key, instance);
        info!(screen, instance_id, pid, url = %url, "Started mpv process");
        Ok(pid)
    }

    pub async fn start_streamlink(
        &self,
        screen: u32,
        instance_id: u32,
        url: &str,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
    ) -> Result<u32, PlayerError> {
        let key = (screen, instance_id);
        if self.instances.contains_key(&key) {
            return Err(PlayerError::AlreadyRunningInstance(screen, instance_id));
        }

        let ipc_path = format!("{}/streamlink-ipc-{}-{}", self.config.ipc_dir, screen, instance_id);

        let mpv_args = vec![
            "--input-ipc-server".to_string(),
            ipc_path.clone(),
            "--geometry".to_string(),
            format!("{}x{}+{}+{}", width, height, x, y),
            "--volume".to_string(),
            self.config.default_volume.to_string(),
        ];

        let streamlink_args = vec![
            url.to_string(),
            self.config.default_quality.clone(),
            "--player".to_string(),
            self.config.mpv_path.clone(),
            "--player-args".to_string(),
            mpv_args.join(" "),
        ];

        let child = Command::new(&self.config.streamlink_path)
            .args(&streamlink_args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| PlayerError::SpawnFailed(e.to_string()))?;

        let pid = child.id().ok_or_else(|| PlayerError::SpawnFailed("Failed to get pid".to_string()))?;

        let mut instance = PlayerInstance::new(screen, instance_id);
        instance.process = Some(child);
        instance.ipc_path = Some(PathBuf::from(&ipc_path));

        self.instances.insert(key, instance);
        info!(screen, instance_id, pid, url = %url, "Started streamlink process");
        Ok(pid)
    }

    pub async fn start_vlc_process(
        &self,
        screen: u32,
        instance_id: u32,
        url: &str,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
    ) -> Result<u32, PlayerError> {
        let key = (screen, instance_id);
        if self.instances.contains_key(&key) {
            return Err(PlayerError::AlreadyRunningInstance(screen, instance_id));
        }

        let mut args = vec![
            "--no-video-title".to_string(),
            "--volume".to_string(),
            self.config.default_volume.to_string(),
            "--geometry".to_string(),
            format!("{}x{}+{}+{}", width, height, x, y),
        ];

        if self.config.window_maximized {
            args.push("--fullscreen".to_string());
        }

        args.push(url.to_string());

        let child = Command::new(&self.config.vlc_path)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| PlayerError::SpawnFailed(e.to_string()))?;

        let pid = child.id().ok_or_else(|| PlayerError::SpawnFailed("Failed to get pid".to_string()))?;

        let mut instance = PlayerInstance::new(screen, instance_id);
        instance.process = Some(child);

        self.instances.insert(key, instance);
        info!(screen, instance_id, pid, url = %url, "Started VLC process");
        Ok(pid)
    }

    /// Start a player for the given screen and URL.
    /// Uses the configured player type (MpvProcess or Streamlink).
    /// instance_id allows multiple players per screen.
    pub async fn start(
        &self,
        screen: u32,
        instance_id: u32,
        url: &str,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
    ) -> Result<u32, PlayerError> {
        match self.config.player_type {
            PlayerType::Embedded => {
                self.start_mpv_process(screen, instance_id, url, width, height, x, y).await
            }
            PlayerType::MpvProcess => {
                self.start_mpv_process(screen, instance_id, url, width, height, x, y).await
            }
            PlayerType::Streamlink => {
                self.start_streamlink(screen, instance_id, url, width, height, x, y).await
            }
            PlayerType::VlcProcess => {
                self.start_vlc_process(screen, instance_id, url, width, height, x, y).await
            }
        }
    }

    /// Stop the player for the given screen and instance.
    /// Returns the playback time if the player was running.
    pub async fn stop(&self, screen: u32, instance_id: u32) -> Result<f64, PlayerError> {
        let key = (screen, instance_id);
        let instance = self.instances.remove(&key);
        let (mut instance, playback_time) = match instance {
            Some((_, inst)) => {
                let pt = inst.playback_time;
                (inst, pt)
            }
            None => return Err(PlayerError::NoPlayerInstance(screen, instance_id)),
        };

        if let Some(ref mut child) = instance.process {
            if let Err(e) = child.kill().await {
                warn!(screen, instance_id, "Error killing process: {}", e);
            }
        }

        if let Some(path) = instance.ipc_path {
            if path.exists() {
                if let Err(e) = tokio::fs::remove_file(&path).await {
                    debug!(screen, instance_id, path = %path.display(), "Failed to remove IPC file: {}", e);
                }
            }
        }

        let screen_for_event = instance.screen;
        let instance_for_event = instance.instance_id;
        let sender = self.event_sender.clone();
        tokio::spawn(async move {
            let exit = ProcessExit {
                screen: screen_for_event,
                pid: 0,
                exit_code: None,
                playback_time,
                error: None,
            };
            if let Err(e) = sender.send(exit).await {
                error!(screen_for_event, "Failed to send stop event: {}", e);
            }
        });
        info!(screen, instance_id, "Stopped player");
        Ok(playback_time)
    }

    /// Stop all players for a screen.
    pub async fn stop_all(&self, screen: u32) -> Result<(), PlayerError> {
        let keys: Vec<(u32, u32)> = self.instances.iter()
            .filter(|r| r.key().0 == screen)
            .map(|r| *r.key())
            .collect();

        for key in keys {
            if let Err(e) = self.stop(key.0, key.1).await {
                warn!(screen = key.0, instance = key.1, "Error stopping: {}", e);
            }
        }
        Ok(())
    }

    pub fn is_running(&self, screen: u32, instance_id: u32) -> bool {
        self.instances.contains_key(&(screen, instance_id))
    }

    pub fn get_pid(&self, screen: u32, instance_id: u32) -> Option<u32> {
        self.instances.get(&(screen, instance_id)).and_then(|inst| {
            inst.process.as_ref().and_then(|p| p.id())
        })
    }

/// Poll for process exits and send events for any that have terminated.
    pub fn poll_exits(&self) {
        let keys: Vec<(u32, u32)> = self.instances.iter().map(|r| *r.key()).collect();
        let sender = self.event_sender.clone();
        let instances = self.instances.clone();

        for key in keys {
            let should_remove = if let Some(mut inst_ref) = instances.get_mut(&key) {
                if let Some(ref mut child) = inst_ref.process {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let code = status.code();
                            info!(screen = key.0, instance = key.1, code, "Process exited");
                            inst_ref.process = None;
                            true
                        }
                        Ok(None) => false,
                        Err(e) => {
                            warn!(screen = key.0, instance = key.1, "Error checking process: {}", e);
                            true
                        }
                    }
                } else {
                    true
                }
            } else {
                false
            };

            if should_remove {
                if let Some((_, inst)) = instances.remove(&key) {
                    let playback_time = inst.playback_time;
                    let screen_for_event = inst.screen;
                    let sender = self.event_sender.clone();
                    tokio::spawn(async move {
                        let exit = ProcessExit {
                            screen: screen_for_event,
                            pid: 0,
                            exit_code: None,
                            playback_time,
                            error: None,
                        };
                        if let Err(e) = sender.send(exit).await {
                            error!(screen_for_event, "Failed to send exit event: {}", e);
                        }
                    });
                }
            }
        }
    }

    pub fn get_playback_time(&self, screen: u32, instance_id: u32) -> Option<f64> {
        self.instances.get(&(screen, instance_id)).map(|inst| inst.playback_time)
    }

    /// Set volume for a screen via IPC command to mpv
    pub async fn set_volume(&self, screen: u32, instance_id: u32, volume: u8) -> Result<(), PlayerError> {
        let ipc_path = self.instances.get(&(screen, instance_id))
            .and_then(|inst| inst.ipc_path.clone())
            .ok_or(PlayerError::NoPlayerInstance(screen, instance_id))?;

        let script = format!(
            "echo 'set property volume {}' | socat - {}",
            volume,
            ipc_path.display()
        );

        tokio::process::Command::new("sh")
            .args(&["-c", &script])
            .output()
            .await
            .map_err(|e| PlayerError::Io(e))?;

        Ok(())
    }

    /// Send a property set command to mpv via IPC
    pub async fn set_property(&self, screen: u32, instance_id: u32, property: &str, value: &str) -> Result<(), PlayerError> {
        let ipc_path = self.instances.get(&(screen, instance_id))
            .and_then(|inst| inst.ipc_path.clone())
            .ok_or(PlayerError::NoPlayerInstance(screen, instance_id))?;

        let script = format!(
            "echo 'set property {} {}' | socat - {}",
            property,
            value,
            ipc_path.display()
        );

        tokio::process::Command::new("sh")
            .args(&["-c", &script])
            .output()
            .await
            .map_err(|e| PlayerError::Io(e))?;

        Ok(())
    }

    /// Send a command to mpv via IPC
    pub async fn command(&self, screen: u32, instance_id: u32, cmd: &[&str]) -> Result<(), PlayerError> {
        let ipc_path = self.instances.get(&(screen, instance_id))
            .and_then(|inst| inst.ipc_path.clone())
            .ok_or(PlayerError::NoPlayerInstance(screen, instance_id))?;

        let cmd_str = cmd.join(" ");
        let script = format!(
            "echo '{}' | socat - {}",
            cmd_str,
            ipc_path.display()
        );

        tokio::process::Command::new("sh")
            .args(&["-c", &script])
            .output()
            .await
            .map_err(|e| PlayerError::Io(e))?;

        Ok(())
    }

    pub fn shutdown(&self) {
        self.shutdown_notify.notify_waiters();
    }
}

impl Default for PlayerService {
    fn default() -> Self {
        Self::new(
            mpsc::channel(100).0,
            PlayerConfig::default(),
        )
    }
}

#[derive(Debug)]
pub enum ExitReason {
    Normal,
    Crashed,
    Killed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_player_config_defaults() {
        let config = PlayerConfig::default();
        assert_eq!(config.player_type, PlayerType::MpvProcess);
        assert_eq!(config.default_volume, 50);
        assert_eq!(config.default_quality, "best");
    }

    #[test]
    fn test_player_instance_new() {
        let instance = PlayerInstance::new(0, 0);
        assert_eq!(instance.screen, 0);
        assert_eq!(instance.instance_id, 0);
        assert!(instance.process.is_none());
    }
}