use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::os::unix::process::CommandExt;
use thiserror::Error;
use tracing::{debug, error, info};

#[derive(Error, Debug)]
pub enum MpvError {
    #[error("Failed to fork: {0}")]
    Fork(String),
    #[error("Failed to spawn mpv: {0}")]
    Spawn(String),
    #[error("MPV process error: {0}")]
    Process(String),
    #[error("IPC error: {0}")]
    Ipc(String),
    #[error("Not running")]
    NotRunning,
    #[error("Timeout")]
    Timeout,
}

pub struct MpvInstance {
    child_pid: Option<libc::pid_t>,
    ipc_path: PathBuf,
    paused: bool,
    playback_time: f64,
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    volume: u8,
    url: Option<String>,
}

impl MpvInstance {
    pub fn new() -> Result<Self, MpvError> {
        let ipc_dir = std::env::temp_dir();
        let ipc_path = ipc_dir.join(format!("livelink_mpv_ipc_{}", std::process::id()));

        Ok(Self {
            child_pid: None,
            ipc_path,
            paused: false,
            playback_time: 0.0,
            width: 1280,
            height: 720,
            x: 0,
            y: 0,
            volume: 50,
            url: None,
        })
    }

    pub fn configure(&mut self, width: u32, height: u32, x: i32, y: i32, volume: u8) -> Result<(), MpvError> {
        self.width = width;
        self.height = height;
        self.x = x;
        self.y = y;
        self.volume = volume;
        Ok(())
    }

    pub fn play(&mut self, url: &str, mpv_path: &str, extra_args: &[String]) -> Result<(), MpvError> {
        if self.child_pid.is_some() {
            self.stop()?;
        }

        let ipc_server = format!("{}", self.ipc_path.display());
        let mut args = vec![url.to_string()];
        args.push(format!("--input-ipc-server={}", ipc_server));
        args.push(format!("--geometry={}x{}+{}+{}", self.width, self.height, self.x, self.y));
        args.push(format!("--volume={}", self.volume));
        args.push("--idle".to_string());
        args.extend(extra_args.iter().cloned());

        debug!(
            mpv_path = %mpv_path,
            args = ?args,
            url = %url,
            ipc_server = %ipc_server,
            "MPV command"
        );

        match unsafe { libc::fork() } {
            -1 => return Err(MpvError::Fork("fork() failed".to_string())),
            0 => {
                unsafe { libc::setsid(); };
                let _ = Command::new(mpv_path)
                    .args(&args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .exec();

                std::process::exit(1);
            }
            pid => {
                self.child_pid = Some(pid);
                self.url = Some(url.to_string());
                self.paused = false;
                self.playback_time = 0.0;
                info!(url, pid, "Started mpv subprocess via fork");
            }
        }

        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), MpvError> {
        self.send_ipc_command("set pause yes")?;
        self.paused = true;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<(), MpvError> {
        self.send_ipc_command("set pause no")?;
        self.paused = false;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), MpvError> {
        if let Some(pid) = self.child_pid {
            let _ = self.send_ipc_command("quit");
            unsafe { libc::kill(pid, libc::SIGTERM) };
            let _ = std::fs::remove_file(&self.ipc_path);
        }
        self.child_pid = None;
        self.url = None;
        Ok(())
    }

    pub fn seek(&mut self, seconds: f64) -> Result<(), MpvError> {
        self.send_ipc_command(&format!("seek {} relative", seconds))?;
        Ok(())
    }

    pub fn set_volume(&mut self, volume: u8) -> Result<(), MpvError> {
        self.volume = volume;
        self.send_ipc_command(&format!("set volume {}", volume))?;
        Ok(())
    }

    pub fn get_playback_time(&self) -> f64 {
        self.playback_time
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn is_playing(&self) -> bool {
        self.url.is_some() && self.child_pid.is_some()
    }

    pub fn current_url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    pub fn pid(&self) -> Option<i32> {
        self.child_pid
    }

    pub fn poll_event(&mut self, _timeout_ms: u64) -> Result<Option<MpvEvent>, MpvError> {
        if let Some(pid) = self.child_pid {
            let status = unsafe { libc::waitpid(pid as libc::pid_t, std::ptr::null_mut(), libc::WNOHANG) };
            if status == pid as i32 {
                self.child_pid = None;
                let _ = std::fs::remove_file(&self.ipc_path);
                info!("MPV subprocess exited");
                return Ok(Some(MpvEvent::EndFile));
            }
        }
        Ok(None)
    }

    fn send_ipc_command(&self, command: &str) -> Result<(), MpvError> {
        if self.child_pid.is_none() {
            return Err(MpvError::NotRunning);
        }

        let ipc_socket = self.ipc_path.to_str().unwrap();
        let full_cmd = format!("echo '{}' | socat - UNIX-CONNECT:{}", command, ipc_socket);

        match Command::new("sh")
            .args(&["-c", &full_cmd])
            .output()
        {
            Ok(_) => Ok(()),
            Err(e) => Err(MpvError::Ipc(e.to_string())),
        }
    }

    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }
    pub fn x(&self) -> i32 { self.x }
    pub fn y(&self) -> i32 { self.y }
    pub fn volume(&self) -> u8 { self.volume }

    pub fn destroy(&mut self) {
        let _ = self.stop();
    }
}

#[derive(Debug, Clone)]
pub enum MpvEvent {
    EndFile,
    Idle,
    StartFile,
    FileLoaded,
    Pause,
    Unpause,
    Shutdown,
    AudioReconfig,
    VideoReconfig,
    Error(String),
}

#[derive(Clone)]
pub struct MpvController {
    inner: Arc<Mutex<MpvInstance>>,
    mpv_path: String,
    extra_args: Vec<String>,
}

impl MpvController {
    pub fn new(mpv_path: &str) -> Result<Self, MpvError> {
        let instance = MpvInstance::new()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(instance)),
            mpv_path: mpv_path.to_string(),
            extra_args: Vec::new(),
        })
    }

    pub fn with_extra_args(mpv_path: &str, extra_args: Vec<String>) -> Result<Self, MpvError> {
        let instance = MpvInstance::new()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(instance)),
            mpv_path: mpv_path.to_string(),
            extra_args,
        })
    }

    pub fn play(&self, url: &str) -> Result<(), MpvError> {
        self.inner.lock().unwrap().play(url, &self.mpv_path, &self.extra_args)
    }

    pub fn pause(&self) -> Result<(), MpvError> {
        self.inner.lock().unwrap().pause()
    }

    pub fn resume(&self) -> Result<(), MpvError> {
        self.inner.lock().unwrap().resume()
    }

    pub fn stop(&self) -> Result<(), MpvError> {
        self.inner.lock().unwrap().stop()
    }

    pub fn seek(&self, seconds: f64) -> Result<(), MpvError> {
        self.inner.lock().unwrap().seek(seconds)
    }

    pub fn set_volume(&self, volume: u8) -> Result<(), MpvError> {
        self.inner.lock().unwrap().set_volume(volume)
    }

    pub fn get_playback_time(&self) -> f64 {
        self.inner.lock().unwrap().get_playback_time()
    }

    pub fn configure(&self, width: u32, height: u32, x: i32, y: i32, volume: u8) -> Result<(), MpvError> {
        self.inner.lock().unwrap().configure(width, height, x, y, volume)
    }

    pub fn poll_event(&self, timeout_ms: u64) -> Result<Option<MpvEvent>, MpvError> {
        self.inner.lock().unwrap().poll_event(timeout_ms)
    }

    pub fn command(&self, cmd: &[&str]) -> Result<(), MpvError> {
        if cmd.is_empty() {
            return Ok(());
        }
        let full_cmd = cmd.join(" ");
        self.inner.lock().unwrap().send_ipc_command(&full_cmd)
    }

    pub fn is_paused(&self) -> bool {
        self.inner.lock().unwrap().is_paused()
    }

    pub fn is_playing(&self) -> bool {
        self.inner.lock().unwrap().is_playing()
    }

    pub fn current_url(&self) -> Option<String> {
        self.inner.lock().unwrap().current_url().map(String::from)
    }

    pub fn pid(&self) -> Option<i32> {
        self.inner.lock().unwrap().pid()
    }

    pub fn geometry(&self) -> (u32, u32, i32, i32) {
        let inst = self.inner.lock().unwrap();
        (inst.width, inst.height, inst.x, inst.y)
    }

    pub fn volume(&self) -> u8 {
        self.inner.lock().unwrap().volume()
    }

    pub fn destroy(&self) {
        self.inner.lock().unwrap().destroy();
    }

    pub fn run_event_loop(&self) -> std::thread::JoinHandle<()> {
        let inner = Arc::clone(&self.inner);
        std::thread::spawn(move || {
            loop {
                let event = {
                    let mut inst = match inner.lock() {
                        Ok(i) => i,
                        Err(_) => break,
                    };
                    match inst.poll_event(100) {
                        Ok(Some(e)) => e,
                        Ok(None) => continue,
                        Err(e) => {
                            error!("Event poll error: {}", e);
                            break;
                        }
                    }
                };
                if matches!(event, MpvEvent::EndFile) {
                    break;
                }
            }
        })
    }
}

impl Default for MpvController {
    fn default() -> Self {
        Self::new("mpv").expect("Failed to create default mpv controller")
    }
}