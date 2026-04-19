use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Notify};
use tracing::{info, warn, error};

pub struct MpvProcess {
    pub screen: u32,
    pub pid: u32,
    child: Option<Child>,
}

#[derive(Debug, Clone)]
pub struct ProcessExit {
    pub screen: u32,
    pub pid: u32,
    pub exit_code: Option<i32>,
}

pub struct PlayerService {
    processes: HashMap<u32, MpvProcess>,
    shutdown_notify: Arc<Notify>,
    exit_sender: mpsc::Sender<ProcessExit>,
}

impl PlayerService {
    pub fn new(exit_sender: mpsc::Sender<ProcessExit>) -> Self {
        Self {
            processes: HashMap::new(),
            shutdown_notify: Arc::new(Notify::new()),
            exit_sender,
        }
    }

    pub async fn start_process(
        &mut self,
        screen: u32,
        url: &str,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
    ) -> Result<u32, String> {
        if self.processes.contains_key(&screen) {
            return Err(format!("Process already exists for screen {}", screen));
        }

        let ipc_path = format!("/tmp/mpv-ipc-{}", screen);

        let args = vec![
            "--input-ipc-server".to_string(),
            ipc_path.clone(),
            "--geometry".to_string(),
            format!("{}x{}+{}+{}", width, height, x, y),
            "--".to_string(),
            url.to_string(),
        ];

        let child = Command::new("mpv")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn mpv: {}", e))?;

        let pid = child
            .id()
            .ok_or_else(|| "Failed to get pid".to_string())?;

        info!(screen, pid, url, "Started mpv process");

        let process = MpvProcess {
            screen,
            pid,
            child: Some(child),
        };

        self.processes.insert(screen, process);

        Ok(pid)
    }

    pub async fn stop_process(&mut self, screen: u32) -> Result<(), String> {
        let process = self
            .processes
            .remove(&screen)
            .ok_or_else(|| format!("No process found for screen {}", screen))?;

        if let Some(mut child) = process.child {
            match child.kill().await {
                Ok(_) => info!(screen, "Killed mpv process"),
                Err(e) => warn!(screen, error = %e, "Failed to kill mpv process"),
            }
        }

        Ok(())
    }

    pub fn is_running(&self, screen: u32) -> bool {
        self.processes.contains_key(&screen)
    }

    pub fn get_pid(&self, screen: u32) -> Option<u32> {
        self.processes.get(&screen).map(|p| p.pid)
    }

    pub fn poll_processes(&mut self) {
        let screens: Vec<u32> = self.processes.keys().copied().collect();

        for screen in screens {
            if let Some(exit_code) = self.check_process_exit(screen) {
                let pid = self.processes.get(&screen).map(|p| p.pid).unwrap_or(0);
                let sender = self.exit_sender.clone();
                tokio::spawn(async move {
                    let exit = ProcessExit {
                        screen,
                        pid,
                        exit_code: Some(exit_code),
                    };
                    if let Err(e) = sender.send(exit).await {
                        error!(screen, "Failed to send exit event: {}", e);
                    }
                });
            }
        }
    }

    fn check_process_exit(&mut self, screen: u32) -> Option<i32> {
        let process = self.processes.get_mut(&screen)?;

        if let Some(ref mut child) = process.child {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let code = status.code();
                    info!(screen, code, "Process exited");
                    self.processes.remove(&screen);
                    return code;
                }
                Ok(None) => return None,
                Err(e) => {
                    warn!(screen, error = %e, "Failed to check process status");
                    return None;
                }
            }
        }

        self.processes.remove(&screen);
        Some(0)
    }

    pub fn shutdown(&self) {
        self.shutdown_notify.notify_waiters();
    }
}

pub struct PlayerExitEvent {
    pub screen: u32,
    pub exit_code: Option<i32>,
}

#[derive(Debug)]
pub enum ExitReason {
    Normal,
    Crashed,
    Killed,
}