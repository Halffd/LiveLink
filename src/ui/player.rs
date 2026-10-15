//! Embedded libmpv video player rendered into an egui (glow) texture.

use std::ffi::{c_void, CStr, CString};

use eframe::egui;
use eframe::glow;
use libmpv2::events::Event;
use libmpv2::render::{OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType};
use libmpv2::Mpv;

/// Events produced by the embedded player, mapped from mpv events.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerEvent {
    /// File loaded and playback started
    Loaded,
    /// File finished (end of file)
    Eof,
    /// Stopped by user request
    Stopped,
    /// Playback failed
    Failed,
}

/// An mpv instance rendering into an OpenGL texture that egui can display.
///
/// Must only be used from the egui UI thread (mpv render context + GL context
/// are bound to it).
pub struct MpvVideo {
    // The render context must be freed before the mpv handle. Struct fields
    // drop in declaration order, so `rc` must stay before `mpv`.
    rc: RenderContext<'static>,
    mpv: Mpv,
    texture: Option<glow::Texture>,
    texture_name: u32,
    texture_id: Option<egui::TextureId>,
    pub width: u32,
    pub height: u32,
    pub playing: bool,
    pub paused: bool,
    pub volume: i64,
    last_time: f64,
}

/// Resolve GL function pointers for mpv through the eframe-provided loader.
fn gl_get_proc_address(ctx: &&'static dyn Fn(&CStr) -> *const c_void, name: &str) -> *mut c_void {
    let name = CString::new(name).expect("GL function name contains no NUL");
    (*ctx)(&name) as *mut c_void
}

fn create_video_texture(gl: &glow::Context, width: u32, height: u32) -> glow::Texture {
    use glow::HasContext as _;
    let zero = vec![0u8; (width as usize) * (height as usize) * 4];
    unsafe {
        let tex = gl.create_texture().expect("failed to create GL texture");
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        gl.tex_image_2d(
            glow::TEXTURE_2D,
            0,
            glow::RGBA as i32,
            width as i32,
            height as i32,
            0,
            glow::RGBA,
            glow::UNSIGNED_BYTE,
            Some(&zero),
        );
        gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_MIN_FILTER,
            glow::LINEAR as i32,
        );
        gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_MAG_FILTER,
            glow::LINEAR as i32,
        );
        gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_WRAP_S,
            glow::CLAMP_TO_EDGE as i32,
        );
        gl.tex_parameter_i32(
            glow::TEXTURE_2D,
            glow::TEXTURE_WRAP_T,
            glow::CLAMP_TO_EDGE as i32,
        );
        gl.bind_texture(glow::TEXTURE_2D, None);
        tex
    }
}

impl MpvVideo {
    /// Create an mpv instance with an OpenGL render context targeting a new
    /// texture. Must be called on the UI thread while the GL context is
    /// current (inside the eframe app creator).
    pub fn new(
        gl: &glow::Context,
        get_proc_address: &'static dyn Fn(&CStr) -> *const c_void,
        width: u32,
        height: u32,
    ) -> Result<Self, libmpv2::Error> {
        let mpv = Mpv::with_initializer(|init| {
            init.set_option("vo", "libmpv")?;
            init.set_option("hwdec", "auto-safe")?;
            init.set_option("keep-open", "no")?;
            init.set_option("osc", "no")?;
            init.set_option("input-default-bindings", "no")?;
            init.set_option("input-vo-keyboard", "no")?;
            init.set_option("input-cursor", "no")?;
            Ok(())
        })?;
        mpv.set_property("volume", 100i64)?;

        let rc = mpv.create_render_context([
            RenderParam::ApiType(RenderParamApiType::OpenGl),
            RenderParam::InitParams(OpenGLInitParams {
                get_proc_address: gl_get_proc_address,
                ctx: get_proc_address,
            }),
        ])?;
        // SAFETY: erases only the PhantomData borrow of Mpv. The render
        // context must be freed before the mpv handle, which the struct field
        // order (`rc` before `mpv`) guarantees.
        let rc: RenderContext<'static> = unsafe { std::mem::transmute(rc) };

        let texture = create_video_texture(gl, width, height);
        let texture_name = texture.0.get();

        Ok(Self {
            rc,
            mpv,
            texture: Some(texture),
            texture_name,
            texture_id: None,
            width,
            height,
            playing: false,
            paused: false,
            volume: 100,
            last_time: 0.0,
        })
    }

    /// Play a URL, replacing whatever is loaded.
    pub fn load(&mut self, url: &str) {
        self.last_time = 0.0;
        if let Err(e) = self.mpv.command("loadfile", &[url, "replace"]) {
            tracing::warn!(error = %e, url, "mpv loadfile failed");
            return;
        }
        self.playing = true;
        self.paused = false;
    }

    /// Stop playback.
    pub fn stop(&mut self) {
        if let Err(e) = self.mpv.command("stop", &[]) {
            tracing::warn!(error = %e, "mpv stop failed");
        }
        self.playing = false;
    }

    /// Pause or resume playback.
    pub fn set_paused(&mut self, paused: bool) {
        if let Err(e) = self.mpv.set_property("pause", paused) {
            tracing::warn!(error = %e, "mpv set pause failed");
            return;
        }
        self.paused = paused;
    }

    /// Set playback volume (0-130, mpv scale).
    pub fn set_volume(&mut self, volume: i64) {
        if let Err(e) = self.mpv.set_property("volume", volume) {
            tracing::warn!(error = %e, "mpv set volume failed");
            return;
        }
        self.volume = volume;
    }

    /// Seconds of playback of the current/last file.
    pub fn time_pos(&self) -> f64 {
        self.last_time
    }

    /// Drain pending mpv events. Non-blocking.
    pub fn poll_events(&mut self) -> Vec<PlayerEvent> {
        let mut events = Vec::new();
        loop {
            match self.mpv.wait_event(0.0) {
                None => break,
                Some(Ok(Event::FileLoaded)) => {
                    self.playing = true;
                    self.paused = false;
                    events.push(PlayerEvent::Loaded);
                }
                Some(Ok(Event::EndFile(reason))) => {
                    self.playing = false;
                    let ev = if reason == libmpv2_sys::mpv_end_file_reason_MPV_END_FILE_REASON_EOF {
                        PlayerEvent::Eof
                    } else if reason == libmpv2_sys::mpv_end_file_reason_MPV_END_FILE_REASON_STOP {
                        PlayerEvent::Stopped
                    } else {
                        PlayerEvent::Failed
                    };
                    events.push(ev);
                }
                Some(Ok(Event::Shutdown)) => {
                    self.playing = false;
                    events.push(PlayerEvent::Failed);
                }
                Some(Ok(_)) => {}
                Some(Err(err)) => {
                    // mpv reports failed files as Err from wait_event
                    tracing::warn!(error = %err, "mpv playback error");
                    if self.playing {
                        self.playing = false;
                        events.push(PlayerEvent::Failed);
                    }
                }
            }
        }
        events
    }

    /// Register the GL texture with egui (once) so it can be drawn.
    pub fn register_texture(&mut self, frame: &mut eframe::Frame) {
        if self.texture_id.is_none() {
            if let Some(tex) = self.texture.take() {
                self.texture_id = Some(frame.register_native_glow_texture(tex));
            }
        }
    }

    /// Poll playback time and render the current video frame into the texture.
    pub fn render(&mut self) {
        if self.playing {
            if let Ok(t) = self.mpv.get_property::<f64>("time-pos") {
                self.last_time = t;
            }
        }
        // flip=true: mpv writes the video top row first, which is what egui
        // expects. Set to false if the picture appears upside down.
        let _ = self.rc.render::<()>(
            self.texture_name as i32,
            self.width as i32,
            self.height as i32,
            true,
        );
    }

    /// The egui texture id once registered.
    pub fn texture_id(&self) -> Option<egui::TextureId> {
        self.texture_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the linked libmpv client API version matches the libmpv2
    /// crate and that the embedded-player options are accepted.
    #[test]
    fn mpv_initializes_with_embedded_options() {
        let mpv = Mpv::with_initializer(|init| {
            init.set_option("vo", "libmpv")?;
            init.set_option("hwdec", "auto-safe")?;
            init.set_option("keep-open", "no")?;
            init.set_option("osc", "no")?;
            init.set_option("input-default-bindings", "no")?;
            init.set_option("input-vo-keyboard", "no")?;
            init.set_option("input-cursor", "no")?;
            Ok(())
        })
        .expect("libmpv client API version must match the libmpv2 crate");

        // In-process playback of a lavfi test source (no network, no GL).
        mpv.command(
            "loadfile",
            &["av://lavfi:testsrc=size=160x120:rate=10", "replace"],
        )
        .expect("lavfi test source should be accepted");
        let _ = mpv.get_property::<f64>("time-pos");
        let _ = mpv.set_property("pause", true);
        let _ = mpv.set_property("volume", 50i64);
    }
}
