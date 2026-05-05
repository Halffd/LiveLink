use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum MpvError {
    #[error("MPV error: {0}")]
    Error(String),
}

#[derive(Clone)]
pub struct MpvController {
    initialized: Arc<Mutex<bool>>,
}

impl MpvController {
    pub fn new() -> Result<Self, MpvError> {
        Ok(Self {
            initialized: Arc::new(Mutex::new(false)),
        })
    }

    pub fn initialize(&self) -> Result<(), MpvError> {
        *self.initialized.lock().unwrap() = true;
        Ok(())
    }

    pub fn is_initialized(&self) -> bool {
        *self.initialized.lock().unwrap()
    }

    pub fn play(&self, _url: &str) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn pause(&self) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn resume(&self) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn stop(&self) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn seek(&self, _seconds: f64) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn set_volume(&self, _volume: u8) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn get_playback_time(&self) -> f64 {
        0.0
    }

    pub fn set_geometry(&self, _width: u32, _height: u32, _x: i32, _y: i32) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn poll_event(&self, _timeout_ms: u64) -> Result<Option<MpvEvent>, MpvError> {
        Ok(None)
    }

    pub fn command(&self, _cmd: &[&str]) -> Result<(), MpvError> {
        Ok(())
    }

    pub fn is_paused(&self) -> bool {
        false
    }

    pub fn is_playing(&self) -> bool {
        false
    }

    pub fn destroy(&self) {}
}

impl Default for MpvController {
    fn default() -> Self {
        Self::new().expect("Failed to create default mpv controller")
    }
}

impl Default for MpvError {
    fn default() -> Self {
        MpvError::Error("Unknown error".to_string())
    }
}

#[derive(Debug, Clone)]
pub enum MpvEvent {
    EndFile,
    Idle,
    StartFile,
    FileLoaded,
    Error(String),
}

unsafe impl Send for MpvController {}
unsafe impl Sync for MpvController {}