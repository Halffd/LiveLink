use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Notify};
use tokio::time::sleep;
use tracing::{info, warn};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkState {
    Online,
    Offline,
}

#[derive(Debug, Clone)]
pub struct NetworkEvent {
    pub state: NetworkState,
}

pub struct NetworkMonitor {
    state: NetworkState,
    event_sender: mpsc::Sender<NetworkEvent>,
    shutdown_notify: Arc<Notify>,
}

impl NetworkMonitor {
    pub fn new(event_sender: mpsc::Sender<NetworkEvent>) -> Self {
        Self {
            state: NetworkState::Online,
            event_sender,
            shutdown_notify: Arc::new(Notify::new()),
        }
    }

    pub async fn start(mut self) {
        info!("Network monitor starting");

        let mut checks_failed = 0u32;
        const FAILURE_THRESHOLD: u32 = 3;
        const CHECK_INTERVAL_SECS: u64 = 10;

        loop {
            tokio::select! {
                _ = self.shutdown_notify.notified() => {
                    info!("Network monitor shutting down");
                    break;
                }
                _ = sleep(Duration::from_secs(CHECK_INTERVAL_SECS)) => {
                    let is_online = self.check_connectivity().await;

                    if is_online {
                        checks_failed = 0;
                        if self.state != NetworkState::Online {
                            self.state = NetworkState::Online;
                            self.emit_event(NetworkState::Online).await;
                        }
                    } else {
                        checks_failed += 1;
                        if checks_failed >= FAILURE_THRESHOLD && self.state != NetworkState::Offline {
                            self.state = NetworkState::Offline;
                            warn!("Network connection lost");
                            self.emit_event(NetworkState::Offline).await;
                        }
                    }
                }
            }
        }
    }

    async fn check_connectivity(&self) -> bool {
        tokio::net::TcpStream::connect("8.8.8.8:53")
            .await
            .is_ok()
    }

    async fn emit_event(&self, state: NetworkState) {
        let event = NetworkEvent { state };
        if let Err(e) = self.event_sender.send(event).await {
            warn!(error = %e, "Failed to send network event");
        }
    }

    pub fn shutdown(&self) {
        self.shutdown_notify.notify_waiters();
    }

    pub fn get_state(&self) -> NetworkState {
        self.state
    }
}

impl Default for NetworkState {
    fn default() -> Self {
        NetworkState::Online
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    #[test]
    fn test_network_state_default() {
        let state = NetworkState::default();
        assert_eq!(state, NetworkState::Online);
    }

    #[test]
    fn test_network_state_equality() {
        assert_eq!(NetworkState::Online, NetworkState::Online);
        assert_eq!(NetworkState::Offline, NetworkState::Offline);
        assert_ne!(NetworkState::Online, NetworkState::Offline);
    }

    #[tokio::test]
    async fn test_network_monitor_initial_state() {
        let (sender, _receiver) = mpsc::channel(100);
        let monitor = NetworkMonitor::new(sender);
        assert_eq!(monitor.get_state(), NetworkState::Online);
    }

    #[tokio::test]
    async fn test_network_monitor_shutdown() {
        let (sender, _receiver) = mpsc::channel(100);
        let monitor = NetworkMonitor::new(sender.clone());
        monitor.shutdown();
    }

    #[test]
    fn test_network_event_creation() {
        let event = NetworkEvent { state: NetworkState::Online };
        assert_eq!(event.state, NetworkState::Online);
    }

    #[test]
    fn test_network_state_debug() {
        let state = NetworkState::Online;
        let debug_str = format!("{:?}", state);
        assert!(debug_str.contains("Online"));
    }

    #[test]
    fn test_network_state_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<NetworkState>();
        assert_send_sync::<NetworkEvent>();
        assert_send_sync::<NetworkMonitor>();
    }

    #[tokio::test]
    async fn test_network_monitor_get_state() {
        let (sender, _receiver) = mpsc::channel(100);
        let monitor = NetworkMonitor::new(sender);
        assert_eq!(monitor.get_state(), NetworkState::Online);
    }
}