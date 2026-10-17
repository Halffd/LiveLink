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

/// The subtitle cue currently displayed by mpv, mirrored out of its
/// properties. This is the input layer for anything drawn on top of the
/// video (annotations, ruby text, search) — mpv itself renders the visible
/// subtitles.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SubtitleCue {
    /// Plain text of the current cue (empty when nothing is shown).
    pub text: String,
    /// Raw ASS dialogue text with formatting tags, when the cue is ASS.
    pub ass_text: String,
    /// Cue start in seconds (negative when mpv has no timing yet).
    pub start: f64,
    /// Cue end in seconds (negative when unknown).
    pub end: f64,
}

impl SubtitleCue {
    /// Whether mpv is currently showing a cue.
    pub fn is_active(&self) -> bool {
        !self.text.is_empty() && self.start >= 0.0 && self.end >= 0.0
    }

    /// Whether `time` (seconds) falls inside this cue.
    pub fn covers(&self, time: f64) -> bool {
        self.is_active() && time >= self.start && time <= self.end
    }
}

/// Read the current subtitle cue from an mpv handle. Works headlessly
/// (`vo=null`), which is what makes the mirror testable without GL.
pub fn subtitle_cue(mpv: &Mpv) -> SubtitleCue {
    SubtitleCue {
        text: mpv.get_property::<String>("sub-text").unwrap_or_default(),
        ass_text: mpv
            .get_property::<String>("sub-text-ass")
            .unwrap_or_default(),
        start: mpv.get_property::<f64>("sub-start").unwrap_or(-1.0),
        end: mpv.get_property::<f64>("sub-end").unwrap_or(-1.0),
    }
}

/// One subtitle track of the current file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubTrackInfo {
    pub id: i64,
    pub lang: String,
    pub title: String,
    pub selected: bool,
    /// Whether the track comes from an external file
    pub external: bool,
    /// Path/URL of the external subtitle file, when present
    pub external_filename: Option<String>,
}

impl SubTrackInfo {
    /// Compact label for pickers, e.g. "en — English [CC]".
    pub fn label(&self) -> String {
        let mut label = String::new();
        if !self.lang.is_empty() {
            label.push_str(&self.lang);
        }
        if !self.title.is_empty() {
            if !label.is_empty() {
                label.push_str(" — ");
            }
            label.push_str(&self.title);
        }
        if label.is_empty() {
            label = format!("track {}", self.id);
        }
        label
    }
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
    muted: bool,
    last_time: f64,
    last_duration: f64,
}

/// Resolve GL function pointers for mpv through the eframe-provided loader.
fn gl_get_proc_address(ctx: &&'static dyn Fn(&CStr) -> *const c_void, name: &str) -> *mut c_void {
    let name = CString::new(name).expect("GL function name contains no NUL");
    (*ctx)(&name) as *mut c_void
}

fn clamp_delay(seconds: f64) -> f64 {
    seconds.clamp(
        -crate::core::subtitles::MAX_SUB_DELAY,
        crate::core::subtitles::MAX_SUB_DELAY,
    )
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
            // Auto-load external subtitle files next to the media (movie.srt).
            init.set_option("sub-auto", "fuzzy")?;
            // Ask yt-dlp for every subtitle track (manual + auto captions) so
            // YouTube and other supported sites come with selectable subs.
            init.set_option(
                "ytdl-raw-options",
                "write-subs=yes,write-auto-subs=yes,sub-langs=all",
            )?;
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
            muted: false,
            last_time: 0.0,
            last_duration: 0.0,
        })
    }

    /// Play a URL, replacing whatever is loaded.
    pub fn load(&mut self, url: &str) {
        self.last_time = 0.0;
        self.last_duration = 0.0;
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

    /// Mute or unmute audio output.
    pub fn set_mute(&mut self, mute: bool) {
        if let Err(e) = self.mpv.set_property("mute", mute) {
            tracing::warn!(error = %e, "mpv set mute failed");
            return;
        }
        self.muted = mute;
    }

    /// Whether audio output is muted.
    pub fn muted(&self) -> bool {
        self.muted
    }

    /// Seek relative to the current position in seconds (negative goes back).
    /// Keyframe-quantized, which keeps network streams responsive.
    pub fn seek_relative(&mut self, seconds: f64) {
        let secs = seconds.to_string();
        if let Err(e) = self.mpv.command("seek", &[&secs, "relative"]) {
            tracing::warn!(error = %e, seconds, "mpv seek failed");
        }
    }

    /// Seek to an absolute position in seconds.
    pub fn seek_absolute(&mut self, seconds: f64) {
        let secs = seconds.max(0.0).to_string();
        if let Err(e) = self.mpv.command("seek", &[&secs, "absolute"]) {
            tracing::warn!(error = %e, seconds, "mpv absolute seek failed");
        }
    }

    /// Seek to a percentage of the stream (usable when duration is unknown).
    pub fn seek_percent(&mut self, percent: f64) {
        let pct = percent.clamp(0.0, 100.0).to_string();
        if let Err(e) = self.mpv.command("seek", &[&pct, "absolute-percent"]) {
            tracing::warn!(error = %e, percent, "mpv percent seek failed");
        }
    }

    /// Advance one video frame and pause (mpv semantics).
    pub fn frame_step(&mut self) {
        if let Err(e) = self.mpv.command("frame-step", &[]) {
            tracing::warn!(error = %e, "mpv frame-step failed");
        }
        self.paused = true;
    }

    /// Go back one video frame and pause (mpv semantics).
    pub fn frame_back_step(&mut self) {
        if let Err(e) = self.mpv.command("frame-back-step", &[]) {
            tracing::warn!(error = %e, "mpv frame-back-step failed");
        }
        self.paused = true;
    }

    /// Set playback speed multiplier (mpv accepts roughly 0.01-100).
    pub fn set_speed(&mut self, speed: f64) {
        if let Err(e) = self.mpv.set_property("speed", speed) {
            tracing::warn!(error = %e, speed, "mpv set speed failed");
        }
    }

    /// Current playback speed multiplier (1.0 when unknown).
    pub fn speed(&self) -> f64 {
        self.mpv.get_property::<f64>("speed").unwrap_or(1.0)
    }

    /// Rotate the video by 0/90/180/270 degrees (mpv `video-rotate`).
    /// The rotated frame is fitted inside the render texture, so pair a 90
    /// degree rotation with swapped window width/height.
    pub fn set_rotation(&mut self, degrees: u32) {
        if let Err(e) = self.mpv.set_property("video-rotate", degrees as i64) {
            tracing::warn!(error = %e, degrees, "mpv set video-rotate failed");
        }
    }

    /// Pan the video inside the window (-1..1, fractions of window size).
    pub fn set_video_pan(&mut self, x: f64, y: f64) {
        if let Err(e) = self.mpv.set_property("video-pan-x", x) {
            tracing::warn!(error = %e, x, "mpv set video-pan-x failed");
        }
        if let Err(e) = self.mpv.set_property("video-pan-y", y) {
            tracing::warn!(error = %e, y, "mpv set video-pan-y failed");
        }
    }

    /// Zoom the video (1.0 = fit, larger crops in).
    pub fn set_video_zoom(&mut self, zoom: f64) {
        if let Err(e) = self.mpv.set_property("video-zoom", zoom) {
            tracing::warn!(error = %e, zoom, "mpv set video-zoom failed");
        }
    }

    /// Add an external subtitle file/URL and select it. Only valid while a
    /// file is loaded.
    pub fn sub_add(&mut self, path: &str) {
        if let Err(e) = self.mpv.command("sub-add", &[path, "select"]) {
            tracing::warn!(error = %e, path, "mpv sub-add failed");
        }
    }

    /// Re-read the current external subtitle track from disk (mpv
    /// sub-reload). Used for streaming subtitles whose file keeps
    /// growing while transcription runs.
    pub fn sub_reload(&mut self) {
        if let Err(e) = self.mpv.command("sub-reload", &["keep-files"]) {
            tracing::warn!(error = %e, "mpv sub-reload failed");
        }
    }

    /// Subtitle tracks of the current file (empty before a file loads).
    pub fn sub_tracks(&self) -> Vec<SubTrackInfo> {
        let count = match self.mpv.get_property::<i64>("track-list/count") {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };
        let mut tracks = Vec::new();
        for i in 0..count {
            let track = format!("track-list/{i}");
            let Ok(kind) = self.mpv.get_property::<String>(&format!("{track}/type")) else {
                continue;
            };
            if kind != "sub" {
                continue;
            }
            tracks.push(SubTrackInfo {
                id: self
                    .mpv
                    .get_property::<i64>(&format!("{track}/id"))
                    .unwrap_or(0),
                lang: self
                    .mpv
                    .get_property::<String>(&format!("{track}/lang"))
                    .unwrap_or_default(),
                title: self
                    .mpv
                    .get_property::<String>(&format!("{track}/title"))
                    .unwrap_or_default(),
                selected: self
                    .mpv
                    .get_property::<bool>(&format!("{track}/selected"))
                    .unwrap_or(false),
                external: self
                    .mpv
                    .get_property::<bool>(&format!("{track}/external"))
                    .unwrap_or(false),
                external_filename: self
                    .mpv
                    .get_property::<String>(&format!("{track}/external-filename"))
                    .ok()
                    .filter(|f| !f.is_empty()),
            });
        }
        tracks
    }

    /// Selected primary subtitle track id (0 = none).
    pub fn current_sub_id(&self) -> i64 {
        self.mpv.get_property::<i64>("sid").unwrap_or(0)
    }

    /// Select the primary subtitle track (0 = off).
    pub fn set_sub_track(&mut self, id: i64) {
        if let Err(e) = self.mpv.set_property("sid", id) {
            tracing::warn!(error = %e, id, "mpv set sid failed");
        }
    }

    /// Selected stacked secondary subtitle track id (0 = none).
    pub fn current_secondary_sub_id(&self) -> i64 {
        self.mpv.get_property::<i64>("secondary-sid").unwrap_or(0)
    }

    /// Select the stacked secondary subtitle track (0 = off). Renders on top
    /// of the primary subtitle.
    pub fn set_secondary_sub_track(&mut self, id: i64) {
        if let Err(e) = self.mpv.set_property("secondary-sid", id) {
            tracing::warn!(error = %e, id, "mpv set secondary-sid failed");
        }
    }

    /// Cycle to the next primary subtitle track (wraps through off).
    pub fn cycle_sub(&mut self) {
        if let Err(e) = self.mpv.command("cycle", &["sid"]) {
            tracing::warn!(error = %e, "mpv cycle sid failed");
        }
    }

    /// Show or hide subtitles.
    pub fn set_sub_visible(&mut self, visible: bool) {
        if let Err(e) = self.mpv.set_property("sub-visibility", visible) {
            tracing::warn!(error = %e, "mpv set sub-visibility failed");
        }
    }

    /// Whether subtitles are shown.
    pub fn sub_visible(&self) -> bool {
        self.mpv
            .get_property::<bool>("sub-visibility")
            .unwrap_or(true)
    }

    /// Show or hide the stacked secondary subtitle track only.
    pub fn set_secondary_sub_visible(&mut self, visible: bool) {
        if let Err(e) = self.mpv.set_property("secondary-sub-visibility", visible) {
            tracing::warn!(error = %e, "mpv set secondary-sub-visibility failed");
        }
    }

    /// Subtitle delay in seconds (negative shows subs earlier).
    pub fn set_sub_delay(&mut self, delay: f64) {
        let delay = clamp_delay(delay);
        if let Err(e) = self.mpv.set_property("sub-delay", delay) {
            tracing::warn!(error = %e, delay, "mpv set sub-delay failed");
        }
    }

    /// Current primary subtitle delay in seconds.
    pub fn sub_delay(&self) -> f64 {
        self.mpv.get_property::<f64>("sub-delay").unwrap_or(0.0)
    }

    /// Delay of the stacked secondary subtitle track in seconds.
    pub fn set_secondary_sub_delay(&mut self, delay: f64) {
        let delay = clamp_delay(delay);
        if let Err(e) = self.mpv.set_property("secondary-sub-delay", delay) {
            tracing::warn!(error = %e, delay, "mpv set secondary-sub-delay failed");
        }
    }

    /// Current secondary subtitle delay in seconds.
    pub fn secondary_sub_delay(&self) -> f64 {
        self.mpv
            .get_property::<f64>("secondary-sub-delay")
            .unwrap_or(0.0)
    }

    /// Text of the currently shown primary subtitle (empty when none).
    pub fn sub_text(&self) -> String {
        self.mpv
            .get_property::<String>("sub-text")
            .unwrap_or_default()
    }

    /// The cue currently displayed by mpv (text plus timing).
    pub fn subtitle_cue(&self) -> SubtitleCue {
        subtitle_cue(&self.mpv)
    }

    /// Subtitle vertical position, 0 = top .. 100 = bottom (default 100).
    pub fn set_sub_pos(&mut self, pos: i64) {
        if let Err(e) = self.mpv.set_property("sub-pos", pos.clamp(0, 100)) {
            tracing::warn!(error = %e, "mpv set sub-pos failed");
        }
    }

    /// Subtitle font name (empty = mpv default).
    pub fn set_sub_font(&mut self, font: &str) {
        if let Err(e) = self.mpv.set_property("sub-font", font) {
            tracing::warn!(error = %e, font, "mpv set sub-font failed");
        }
    }

    /// Subtitle font size for plain text subs (mpv default 55).
    pub fn set_sub_font_size(&mut self, size: f64) {
        if let Err(e) = self.mpv.set_property("sub-font-size", size) {
            tracing::warn!(error = %e, "mpv set sub-font-size failed");
        }
    }

    /// Subtitle scale factor (also affects ASS when overriding).
    pub fn set_sub_scale(&mut self, scale: f64) {
        if let Err(e) = self.mpv.set_property("sub-scale", scale.clamp(0.1, 10.0)) {
            tracing::warn!(error = %e, "mpv set sub-scale failed");
        }
    }

    /// Subtitle text/border colors as hex ("rrggbb", "" = mpv default).
    pub fn set_sub_colors(&mut self, text: &str, border: &str, border_size: f64) {
        let hex = |name: &str, value: &str, prop: &str| {
            if let Some(c) = crate::player_ui::settings::parse_hex_color(value) {
                if let Err(e) = self
                    .mpv
                    .set_property(prop, format!("#{:02x}{:02x}{:02x}", c.r(), c.g(), c.b()))
                {
                    tracing::warn!(error = %e, prop, "mpv set {prop} failed");
                }
            } else if !value.is_empty() {
                tracing::warn!(name, value, "invalid subtitle color hex");
            }
        };
        hex("text", text, "sub-color");
        hex("border", border, "sub-border-color");
        if let Err(e) = self.mpv.set_property("sub-border-size", border_size) {
            tracing::warn!(error = %e, "mpv set sub-border-size failed");
        }
    }

    /// Force our styling onto authored ASS subtitles.
    pub fn set_sub_ass_override(&mut self, yes: bool) {
        let value = if yes { "yes" } else { "no" };
        if let Err(e) = self.mpv.set_property("sub-ass-override", value) {
            tracing::warn!(error = %e, "mpv set sub-ass-override failed");
        }
    }

    /// Seconds of playback of the current/last file.
    pub fn time_pos(&self) -> f64 {
        self.last_time
    }

    /// Duration of the current file in seconds (0 when unknown).
    pub fn duration(&mut self) -> f64 {
        if let Ok(d) = self.mpv.get_property::<f64>("duration") {
            self.last_duration = d;
        }
        self.last_duration
    }

    /// Human-readable title of the current media, when available.
    pub fn media_title(&mut self) -> String {
        self.mpv
            .get_property::<String>("media-title")
            .unwrap_or_default()
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
        // Also poll while paused so seeks and frame steps update the UI.
        if let Ok(t) = self.mpv.get_property::<f64>("time-pos") {
            self.last_time = t;
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

        // Properties used by the player controls.
        mpv.set_property("speed", 1.5f64)
            .expect("speed property must be settable");
        assert_eq!(mpv.get_property::<f64>("speed").unwrap(), 1.5);
        mpv.set_property("mute", true)
            .expect("mute property must be settable");
        assert!(mpv.get_property::<bool>("mute").unwrap());

        // Subtitle control properties.
        mpv.set_property("sub-pos", 80i64)
            .expect("sub-pos must be settable");
        assert_eq!(mpv.get_property::<i64>("sub-pos").unwrap(), 80);
        mpv.set_property("sub-font-size", 42f64)
            .expect("sub-font-size must be settable");
        assert_eq!(mpv.get_property::<f64>("sub-font-size").unwrap(), 42.0);
        mpv.set_property("secondary-sid", 0i64)
            .expect("secondary-sid must be settable");
        assert_eq!(mpv.get_property::<i64>("secondary-sid").unwrap(), 0);
        let _ = mpv.get_property::<i64>("track-list/count");
    }

    /// The cue mirror must work without GL: mpv updates sub-text/sub-start/
    /// sub-end even with vo=null, which is how the annotation layer gets its
    /// input. Loads a generated ASS cue over a lavfi source and polls.
    #[test]
    fn subtitle_cue_mirrors_ass_without_gl() {
        let ass = std::env::temp_dir().join("livelink-cue-probe.ass");
        std::fs::write(
            &ass,
            "[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n\
             [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour\n\
             Style: Default,Sans,32,&H00FFFFFF\n\n\
             [Events]\nFormat: Layer, Start, End, Style, Text\n\
             Dialogue: 0,0:00:00.00,0:00:10.00,Default,\u{65e5}\u{672c}\u{8a9e}\u{3092}\u{5b66}\u{3073}\u{3057}\u{3066}\u{3044}\u{307e}\u{3059}\n",
        )
        .unwrap();

        let mpv = Mpv::with_initializer(|init| {
            init.set_option("vo", "null")?;
            init.set_option("idle", "yes")?;
            Ok(())
        })
        .expect("mpv handle");

        let path = ass.to_string_lossy().to_string();
        mpv.command(
            "loadfile",
            &["av://lavfi:testsrc=size=160x120:rate=5", "replace"],
        )
        .unwrap();

        // sub-add only works once a file is loaded.
        let mut loaded = false;
        for _ in 0..200 {
            if let Some(Ok(Event::FileLoaded)) = mpv.wait_event(0.05) {
                loaded = true;
                break;
            }
        }
        assert!(loaded, "lavfi source should load");
        mpv.command("sub-add", &[&path, "select"]).unwrap();

        // sub-text appears once the first frame is decoded.
        let mut cue = SubtitleCue::default();
        for _ in 0..100 {
            cue = subtitle_cue(&mpv);
            if cue.is_active() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(cue.text, "\u{65e5}\u{672c}\u{8a9e}\u{3092}\u{5b66}\u{3073}\u{3057}\u{3066}\u{3044}\u{307e}\u{3059}");
        assert!(cue.is_active());
        assert!(cue.start <= 0.1, "cue start {:?}", cue.start);
        assert!(cue.end > 9.0, "cue end {:?}", cue.end);
        assert!(
            cue.covers(1.0) && !cue.covers(11.0),
            "cue should cover its own window"
        );
        assert!(
            cue.ass_text == cue.text,
            "raw ass text should carry the unstyled cue: {:?}",
            cue.ass_text
        );
    }
}
