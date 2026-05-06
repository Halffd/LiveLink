use mpv::{MpvHandler, MpvHandlerBuilder, Event, Format, LogLevel};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use thiserror::Error;
use tracing::{debug, error, info, warn};

#[derive(Error, Debug)]
pub enum MpvError {
    #[error("MPV creation failed: {0}")]
    Creation(String),
    #[error("MPV command failed: {0}")]
    Command(String),
    #[error("MPV event error: {0}")]
    Event(String),
    #[error("MPV property error: {0}")]
    Property(String),
}

pub struct MpvInstance {
    handler: MpvHandler,
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
        let mut builder = MpvHandlerBuilder::new()
            .map_err(|e| MpvError::Creation(e.to_string()))?;

        builder.set_option("idle", "yes")
            .map_err(|e| MpvError::Creation(e.to_string()))?;
        builder.set_option("no-terminal", "")
            .map_err(|e| MpvError::Creation(e.to_string()))?;

        let handler = builder.build()
            .map_err(|e| MpvError::Creation(e.to_string()))?;

        Ok(Self {
            handler,
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

        let geo = format!("{}x{}+{}+{}", width, height, x, y);
        self.handler.set_option("geometry", geo.as_str())
            .map_err(|e| MpvError::Property(e.to_string()))?;

        self.handler.set_property("volume", volume as f64)
            .map_err(|e| MpvError::Property(e.to_string()))?;

        Ok(())
    }

    pub fn play(&mut self, url: &str) -> Result<(), MpvError> {
        self.url = Some(url.to_string());
        self.handler.command(&["loadfile", url, "replace"])
            .map_err(|e| MpvError::Command(e.to_string()))?;
        self.paused = false;
        info!(url, "Started playback");
        Ok(())
    }

    pub fn pause(&mut self) -> Result<(), MpvError> {
        self.handler.set_property("pause", true)
            .map_err(|e| MpvError::Property(e.to_string()))?;
        self.paused = true;
        Ok(())
    }

    pub fn resume(&mut self) -> Result<(), MpvError> {
        self.handler.set_property("pause", false)
            .map_err(|e| MpvError::Property(e.to_string()))?;
        self.paused = false;
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), MpvError> {
        self.handler.command(&["stop"])
            .map_err(|e| MpvError::Command(e.to_string()))?;
        self.url = None;
        Ok(())
    }

    pub fn seek(&mut self, seconds: f64) -> Result<(), MpvError> {
        self.handler.command(&["seek", &seconds.to_string(), "relative"])
            .map_err(|e| MpvError::Command(e.to_string()))?;
        Ok(())
    }

    pub fn set_volume(&mut self, volume: u8) -> Result<(), MpvError> {
        self.volume = volume;
        self.handler.set_property("volume", volume as f64)
            .map_err(|e| MpvError::Property(e.to_string()))?;
        Ok(())
    }

    pub fn get_playback_time(&self) -> f64 {
        self.playback_time
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn is_playing(&self) -> bool {
        self.url.is_some() && !self.paused
    }

    pub fn current_url(&self) -> Option<&str> {
        self.url.as_deref()
    }

    pub fn poll_event(&mut self, timeout_ms: u64) -> Result<Option<MpvEvent>, MpvError> {
        let timeout_secs = timeout_ms as f64 / 1000.0;
        match self.handler.wait_event(timeout_secs) {
            None => Ok(None),
            Some(Event::LogMessage { text, log_level, .. }) => {
                let level = log_level as i32;
                if level <= 20 {
                    error!("mpv: {}", text);
                } else if level <= 30 {
                    warn!("mpv: {}", text);
                } else if level <= 40 {
                    info!("mpv: {}", text);
                } else {
                    debug!(level = ?log_level, "mpv: {}", text);
                }
                Ok(None)
            }
            Some(Event::PropertyChange { name, change, .. }) => {
                if name == "playback-time" {
                    match change {
                        Format::Double(pt) => self.playback_time = pt,
                        Format::Int(pt) => self.playback_time = pt as f64,
                        _ => {}
                    }
                }
                Ok(None)
            }
            Some(Event::Idle) => Ok(Some(MpvEvent::Idle)),
            Some(Event::StartFile) => Ok(Some(MpvEvent::StartFile)),
            Some(Event::FileLoaded) => Ok(Some(MpvEvent::FileLoaded)),
            Some(Event::EndFile(_)) => Ok(Some(MpvEvent::EndFile)),
            Some(Event::Pause) => {
                self.paused = true;
                Ok(Some(MpvEvent::Pause))
            }
            Some(Event::Unpause) => {
                self.paused = false;
                Ok(Some(MpvEvent::Unpause))
            }
            Some(Event::Shutdown) => Ok(Some(MpvEvent::Shutdown)),
            Some(Event::AudioReconfig) => Ok(Some(MpvEvent::AudioReconfig)),
            Some(Event::VideoReconfig) => Ok(Some(MpvEvent::VideoReconfig)),
            Some(Event::Seek) => Ok(None),
            Some(Event::PlaybackRestart) => Ok(None),
            Some(other) => {
                debug!(event = ?other, "MPV event");
                Ok(None)
            }
        }
    }

    pub fn command(&mut self, cmd: &[&str]) -> Result<(), MpvError> {
        self.handler.command(cmd).map_err(|e| MpvError::Command(e.to_string()))
    }

    pub fn get_property(&self, name: &str) -> Result<String, MpvError> {
        let val: f64 = self.handler.get_property(name)
            .map_err(|e| MpvError::Property(e.to_string()))?;
        Ok(val.to_string())
    }

    pub fn set_property<T: mpv::MpvFormat>(&mut self, name: &str, value: T) -> Result<(), MpvError> {
        self.handler.set_property(name, value).map_err(|e| MpvError::Property(e.to_string()))
    }

    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }
    pub fn x(&self) -> i32 { self.x }
    pub fn y(&self) -> i32 { self.y }
    pub fn volume(&self) -> u8 { self.volume }

    pub fn detach(&mut self) {
        let _ = self.handler.command(&["quit"]);
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
}

impl MpvController {
    pub fn new() -> Result<Self, MpvError> {
        let instance = MpvInstance::new()?;
        Ok(Self {
            inner: Arc::new(Mutex::new(instance)),
        })
    }

    pub fn play(&self, url: &str) -> Result<(), MpvError> {
        self.inner.lock().unwrap().play(url)
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
        self.inner.lock().unwrap().command(cmd)
    }

    pub fn set_property<T: mpv::MpvFormat>(&self, name: &str, value: T) -> Result<(), MpvError> {
        self.inner.lock().unwrap().set_property(name, value)
    }

    pub fn get_property(&self, name: &str) -> Result<String, MpvError> {
        self.inner.lock().unwrap().get_property(name)
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

    pub fn geometry(&self) -> (u32, u32, i32, i32) {
        let inst = self.inner.lock().unwrap();
        (inst.width, inst.height, inst.x, inst.y)
    }

    pub fn volume(&self) -> u8 {
        self.inner.lock().unwrap().volume()
    }

    pub fn destroy(&self) {
        if let Ok(mut inst) = self.inner.try_lock() {
            inst.detach();
        }
    }
}

impl Default for MpvController {
    fn default() -> Self {
        Self::new().expect("Failed to create default mpv controller")
    }
}