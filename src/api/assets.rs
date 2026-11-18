//! The built-in web front end: a single page served by the same axum server
//! that exposes the control API.
//!
//! The page is embedded as source on purpose. A front end that needs a
//! bundler, a node_modules directory, or a build step before `cargo build`
//! is a front end that will be stale or broken in six months, and it makes
//! the "web UI" a second product instead of a window onto the one that
//! exists. This is one HTML file plus one script, both inline, calling the
//! endpoints `routes.rs` already serves — so there is exactly one source of
//! truth for what the system can do.
//!
//! What it covers: every screen's live state and queue, plus the actions
//! that need no extra arguments (stop, next, previous, transcribe-current,
//! move a stream between screens).

/// The page served at `/`.
pub const INDEX_HTML: &str = include_str!("../../assets/ui/index.html");

/// The script the page loads (kept in one file so the HTML stays readable).
pub const APP_JS: &str = include_str!("../../assets/ui/app.js");