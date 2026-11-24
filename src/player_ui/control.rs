//! Line-delimited JSON command listener so external processes (the LiveLink
//! server, scripts) can drive a persistent player window.
//!
//! Protocol: one JSON object per line over TCP.
//!   {"cmd":"play","url":"https://..."}   load and play
//!   {"cmd":"stop"}                        stop playback
//!   {"cmd":"pause","value":true}          pause (true) / resume (false)
//!   {"cmd":"volume","value":50}           set volume (mpv scale)
//!   {"cmd":"seek","value":-10}            seek relative in seconds
//!   {"cmd":"speed","value":1.5}           set playback speed multiplier
//!   {"cmd":"mute","value":true}           mute (true/false, omits to toggle)
//!   {"cmd":"sub","value":2}               select subtitle track (0 = off)
//!   {"cmd":"sub-pos","value":50}          subtitle position 0=top .. 100=bottom
//!   {"cmd":"sub-add","url":"subs.srt"}    attach external subtitle file/url
//!   {"cmd":"sub-delay","value":1.5}       primary delay (s, ephemeral override)
//!   {"cmd":"sub-delay-by","value":-0.1}  nudge primary delay relative
//!   {"cmd":"sub-delay-reset"}             drop primary delay override
//!   {"cmd":"sec-sub-delay","value":1.5}   secondary delay (s)
//!   {"cmd":"sec-sub-delay-by","value":0}  nudge secondary delay relative
//!   {"cmd":"sec-sub-delay-reset"}         drop secondary delay override
//!   {"cmd":"sub-mode","text":"stacked"}   visibility mode: primary-only,
//!                                        secondary-only, stacked, hidden,
//!                                        toggle-secondary
//!   {"cmd":"sub-mode-cycle"}              cycle to the next mode
//!   {"cmd":"sub-toggle-secondary"}        toggle the secondary lane
//!   {"cmd":"next"} / {"cmd":"prev"}       playlist navigation
//!   {"cmd":"get-position"}                reply: {"position":12.5,"duration":60}
//!   {"cmd":"get-status"}                  reply: {"playing":true,"paused":false,
//!                                          "volume":80,"speed":1.0,"muted":false,
//!                                          "index":0,"playlist_len":2,
//!                                          "position":12.5,"duration":60,
//!                                          "now_playing":"<url>"}
//!   {"cmd":"reload"}                      reload player-ui.toml
//!   {"cmd":"quit"}                        close this player window
//!
//! Queries (`get-*`) are answered on the **same connection**, so a caller
//! sends one line and reads one line back. Commands are fire-and-forget.

use serde::Deserialize;
use std::net::TcpListener;
use std::sync::mpsc::Sender;

/// First port of the player control port range; a player window on screen N
/// defaults to `DEFAULT_BASE_PORT + N`. The server uses the same convention to
/// forward stream changes.
pub const DEFAULT_BASE_PORT: u16 = 3100;

/// Carries a query from the listener thread to the UI and the answer back.
///
/// The listener thread owns the caller's connection and blocks on `reply`
/// until the UI has read the current player state; the UI answers in
/// `update()`, which is the only place the state is stable. One hub per
/// window, created in [`spawn_listener`]'s caller so both threads share it.
#[derive(Clone)]
pub struct QueryHub {
    pending: std::sync::Arc<std::sync::Mutex<Vec<(String, std::sync::mpsc::Sender<String>)>>>,
}

impl QueryHub {
    pub fn new() -> Self {
        Self {
            pending: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        }
    }

    /// Listener side: queue a query and wait for the UI's answer. Bounded by
    /// [`QUERY_TIMEOUT`] so a wedged UI cannot hang the listener forever.
    pub fn ask(&self, cmd: &str) -> Option<String> {
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let mut pending = self.pending.lock().ok()?;
            pending.push((cmd.to_string(), tx));
        }
        rx.recv_timeout(QUERY_TIMEOUT).ok()
    }

    /// UI side: take every unanswered query. Called from `update()`.
    pub fn take(&self) -> Vec<(String, std::sync::mpsc::Sender<String>)> {
        let Ok(mut pending) = self.pending.lock() else {
            return Vec::new();
        };
        std::mem::take(&mut *pending)
    }
}

/// How long the listener waits for the UI to answer a query. The UI answers
/// within a frame (16 ms at 60 fps), so anything near a second means the
/// window is gone and the caller should give up rather than hang.
const QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct PlayerCommand {
    pub cmd: String,
    #[serde(default)]
    pub url: Option<String>,
    /// String argument for commands like `sub-mode` whose value is a name.
    #[serde(default)]
    pub text: Option<String>,
    /// Accepts a JSON number or boolean (pause sends true/false).
    #[serde(default, deserialize_with = "deserialize_flex_value")]
    pub value: Option<f64>,
}

fn deserialize_flex_value<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(serde::Deserialize)]
    #[serde(untagged)]
    enum FlexValue {
        Bool(bool),
        Num(f64),
    }
    match FlexValue::deserialize(deserializer) {
        Ok(FlexValue::Bool(true)) => Ok(Some(1.0)),
        Ok(FlexValue::Bool(false)) => Ok(Some(0.0)),
        Ok(FlexValue::Num(n)) => Ok(Some(n)),
        Err(e) => Err(e),
    }
}

pub fn parse_line(line: &str) -> Option<PlayerCommand> {
    serde_json::from_str(line.trim()).ok()
}

/// True for the `get-*` commands, which are answered on the caller's
/// connection instead of being forwarded to the UI. Everything else is
/// fire-and-forget.
pub fn is_query(cmd: &str) -> bool {
    cmd.starts_with("get-")
}

/// Read one newline-terminated JSON command from an established connection
/// (one connection per command batch). Shared by the TCP and Unix listeners.
fn read_command_line(stream: &mut impl std::io::Read) -> Option<String> {
    let mut buf = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        match stream.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                buf.push(byte[0]);
                if byte[0] == b'\n' {
                    break;
                }
                if buf.len() > 64 * 1024 {
                    break; // absurd line, drop it
                }
            }
            Err(_) => break,
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Answer one query on the caller's connection: ask the UI, write the reply.
///
/// A query the UI cannot answer (timeout) gets an empty JSON object rather
/// than a dropped connection, so a caller can distinguish "no answer" from
/// "window gone".
fn answer_query(stream: &mut impl std::io::Write, cmd: &str, hub: &QueryHub) {
    let reply = hub.ask(cmd).unwrap_or_else(|| "{}".to_string());
    let _ = stream.write_all(reply.as_bytes());
    let _ = stream.write_all(b"\n");
    let _ = stream.flush();
}

/// Bind `127.0.0.1:port` and forward parsed commands to `tx`. On bind failure
/// (e.g. TIME_WAIT after a respawn) the thread retries every 5 seconds so a
/// supervised player eventually owns its port. Never returns.
///
/// `hub` carries `get-*` queries: the listener answers them on the caller's
/// connection, since the UI cannot reach the connection itself.
pub fn spawn_listener(port: u16, tx: Sender<PlayerCommand>, hub: QueryHub) {
    std::thread::spawn(move || loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let Some(line) = read_command_line(&mut stream) else { continue };
                    match parse_line(&line) {
                        Some(cmd) if is_query(&cmd.cmd) => {
                            answer_query(&mut stream, &cmd.cmd, &hub);
                        }
                        Some(cmd) => {
                            if tx.send(cmd).is_err() {
                                return; // UI gone
                            }
                        }
                        None => {
                            if !line.trim().is_empty() {
                                tracing::warn!(source = "tcp", line = %line.trim(), "unparsable control command dropped");
                            }
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(port, error = %e, "player control port unavailable, retrying");
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        }
    });
}

/// Bind a Unix-domain socket at `path` and forward parsed commands to `tx`,
/// same line-delimited JSON protocol as [`spawn_listener`]. Retries every 5
/// seconds on bind failure (e.g. another window still owns the socket).
/// Never returns.
pub fn spawn_unix_listener(path: std::path::PathBuf, tx: Sender<PlayerCommand>, hub: QueryHub) {
    std::thread::spawn(move || loop {
        // A leftover socket file from a previous run makes bind fail; only a
        // live listener would keep accept from succeeding, and remove at
        // startup is standard for this kind of single-owner socket.
        let _ = std::fs::remove_file(&path);
        match std::os::unix::net::UnixListener::bind(&path) {
            Ok(listener) => {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let Some(line) = read_command_line(&mut stream) else { continue };
                    match parse_line(&line) {
                        Some(cmd) if is_query(&cmd.cmd) => {
                            answer_query(&mut stream, &cmd.cmd, &hub);
                        }
                        Some(cmd) => {
                            if tx.send(cmd).is_err() {
                                let _ = std::fs::remove_file(&path);
                                return; // UI gone
                            }
                        }
                        None => {
                            if !line.trim().is_empty() {
                                tracing::warn!(source = "unix", line = %line.trim(), "unparsable control command dropped");
                            }
                        }
                    }
                }
            }
            Err(e) => {
                tracing::warn!(path = %path.display(), error = %e, "player IPC socket unavailable, retrying");
                std::thread::sleep(std::time::Duration::from_secs(5));
            }
        }
    });
}

/// Send one newline-terminated JSON command to a player control port. Fails
/// when no player window is listening (the normal case when it is closed).
pub async fn send_command(port: u16, line: &str) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    stream.write_all(line.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    stream.flush().await?;
    Ok(())
}

/// Ask a player window a `get-*` query and return its parsed answer.
    ///
    /// The window replies on the same connection, so this sends one line and
    /// reads one line. `None` when no window is listening (the normal case
    /// when it is closed) or the reply is not JSON.
    pub async fn query(port: u16, cmd: &str) -> Option<serde_json::Value> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .ok()?;
        let line = serde_json::json!({ "cmd": cmd }).to_string();
        stream.write_all(line.as_bytes()).await.ok()?;
        stream.write_all(b"\n").await.ok()?;
        stream.flush().await.ok()?;

        // One reply, one line. A player that never answers must not wedge
        // the caller, so the read is bounded.
        let mut buf = [0u8; 8192];
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            stream.read(&mut buf),
        )
        .await
        .ok()?
        .ok()?;
        let text = String::from_utf8_lossy(&buf[..read]);
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        serde_json::from_str(text).ok()
    }

    /// The same command without an async caller, for code that runs on a plain
    /// thread with no reactor available (the native transcription worker).
    ///
    /// Same protocol and the same "no window listening is not an error" rule as
    /// [`send_command`]: a closed window simply has nothing to tell.
    pub fn send_command_sync(port: u16, line: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
    stream.write_all(line.as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_commands() {
        let c = parse_line(r#"{"cmd":"play","url":"https://example.com/live"}"#).unwrap();
        assert_eq!(c.cmd, "play");
        assert_eq!(c.url.as_deref(), Some("https://example.com/live"));

        let c = parse_line(r#"{"cmd":"pause","value":true}"#).unwrap();
        assert_eq!(c.value, Some(1.0));

        let c = parse_line(r#"{"cmd":"seek","value":-10}"#).unwrap();
        assert_eq!(c.cmd, "seek");
        assert_eq!(c.value, Some(-10.0));

        let c = parse_line(r#"{"cmd":"speed","value":1.5}"#).unwrap();
        assert_eq!(c.value, Some(1.5));

        let c = parse_line(r#"{"cmd":"mute"}"#).unwrap();
        assert_eq!(c.cmd, "mute");
        assert_eq!(c.value, None);

        let c = parse_line(r#"{"cmd":"sub","value":2}"#).unwrap();
        assert_eq!(c.cmd, "sub");
        assert_eq!(c.value, Some(2.0));

        let c = parse_line(r#"{"cmd":"sub-pos","value":30}"#).unwrap();
        assert_eq!(c.value, Some(30.0));

        let c = parse_line(r#"{"cmd":"sub-add","url":"/tmp/subs.srt"}"#).unwrap();
        assert_eq!(c.cmd, "sub-add");
        assert_eq!(c.url.as_deref(), Some("/tmp/subs.srt"));

        let c = parse_line(r#"{"cmd":"sub-mode","text":"stacked"}"#).unwrap();
        assert_eq!(c.text.as_deref(), Some("stacked"));

        let c = parse_line(r#"{"cmd":"sub-delay-by","value":-0.1}"#).unwrap();
        assert_eq!(c.value, Some(-0.1));

        let c = parse_line(r#"{"cmd":"sub-delay-reset"}"#).unwrap();
        assert_eq!(c.value, None);
        assert_eq!(c.text, None);

        assert!(parse_line(r#"{"cmd":"next"}"#).is_some());
        assert!(parse_line("garbage").is_none());
        assert!(parse_line("").is_none());
    }

    #[test]
    fn playlist_from_dir_filters_and_sorts_media() {
        let dir = std::env::temp_dir().join(format!("player-ui-dir-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("b.mkv"), "").unwrap();
        std::fs::write(dir.join("a.mp4"), "").unwrap();
        std::fs::write(dir.join("notes.txt"), "").unwrap();
        std::fs::write(dir.join("song.mp3"), "").unwrap();
        std::fs::write(dir.join("no_ext"), "").unwrap();

        let files = super::super::playlist_from_dir(&dir).unwrap();
        assert_eq!(
            files,
            vec![
                dir.join("a.mp4").to_string_lossy().to_string(),
                dir.join("b.mkv").to_string_lossy().to_string(),
                dir.join("song.mp3").to_string_lossy().to_string(),
            ]
        );
    }

    /// A `get-*` line is answered on the connection; everything else is
    /// forwarded. Misclassifying would be total: a real command read as a
    /// query gets no UI work done, a query read as a command is dropped.
    #[test]
    fn only_get_prefixed_commands_are_queries() {
        for cmd in ["get-position", "get-status"] {
            let parsed = parse_line(&format!(r#"{{"cmd":"{cmd}"}}"#)).expect("parses");
            assert!(is_query(&parsed.cmd), "{cmd} must be a query");
        }
        for cmd in ["play", "pause", "volume", "seek", "sub-add", "quit"] {
            let parsed = parse_line(&format!(r#"{{"cmd":"{cmd}"}}"#)).expect("parses");
            assert!(!is_query(&parsed.cmd), "{cmd} must not be a query");
        }
        // A command that merely *starts* with get- letters is still a query
        // by this rule; the UI's match arm decides what is answered, and an
        // unknown one replies {} rather than doing work.
        assert!(is_query("get-nonsense"));
    }

    /// The query hub must round-trip: the listener queues, the UI takes, the
    /// answer comes back on the same channel. Without this the listener
    /// would block for the full timeout on every query.
    #[test]
    fn query_hub_round_trips_an_answer() {
        let hub = QueryHub::new();

        // Listener side: parked on its own thread because ask() blocks until
        // the UI answers.
        let listener_hub = hub.clone();
        let listener = std::thread::spawn(move || listener_hub.ask("get-position"));

        // UI side: the query appears exactly once.
        let mut answered = None;
        for _ in 0..200 {
            let pending = hub.take();
            if let Some((cmd, tx)) = pending.into_iter().next() {
                assert_eq!(cmd, "get-position");
                let _ = tx.send(r#"{"position":12.5,"duration":60.0}"#.to_string());
                answered = Some(cmd);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(answered.as_deref(), Some("get-position"));

        // The listener got the answer, and the pending queue is now empty
        // (take() drains, so nothing lingers for the next frame).
        let reply = listener.join().expect("listener thread panicked");
        assert_eq!(reply.as_deref(), Some(r#"{"position":12.5,"duration":60.0}"#));
        assert!(hub.take().is_empty(), "answered query must not linger");
    }

    /// A query the UI never answers must not hang the listener forever.
    #[test]
    fn an_unanswered_query_times_out() {
        let hub = QueryHub::new();
        let queued = hub.ask("get-position");
        // Nothing answers on the UI side, and the timeout is 2s, so the
        // caller must get None rather than blocking forever.
        assert!(queued.is_none(), "ask must give up when nobody answers");
    }

    #[tokio::test]
    async fn resolve_keeps_non_http_urls_unchanged() {
        let resolved = super::super::resolve_with_streamlink("streamlink", "/tmp/a.mp4", "best").await;
        assert_eq!(resolved, "/tmp/a.mp4");
    }

    /// Bind a real Unix socket via spawn_unix_listener, connect to it, send
    /// one JSON command, and assert the listener delivers it over the
    /// channel. Covers the whole IPC path that GL-less smoke tests cannot.
    /// Dropping every Sender (the test's clone and the one moved into the
    /// listener thread ends via its own disconnect path) lets the process
    /// exit instead of hanging on a detached thread.
    #[test]
    fn unix_socket_delivers_commands_to_the_channel() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("livelink-ipc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("player.sock");

        let (tx, rx) = std::sync::mpsc::channel();
        spawn_unix_listener(sock.clone(), tx, QueryHub::new());

        let mut bound = false;
        for _ in 0..50 {
            if sock.exists() {
                bound = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(bound, "listener never bound {}", sock.display());

        {
            let mut stream = std::os::unix::net::UnixStream::connect(&sock).unwrap();
            stream
                .write_all(b"{\"cmd\":\"pause\",\"value\":true}\n")
                .unwrap();
            stream.flush().unwrap();
        } // closing the connection is the "UI gone" signal: the listener
          // thread removes the socket and returns, so no thread outlives
          // the test.

        let cmd = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("no command delivered over the unix socket");
        assert_eq!(cmd.cmd, "pause");
        assert_eq!(cmd.value, Some(1.0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A stale socket file must not wedge the listener: bind succeeds after
    /// the leftover file is removed, and commands still flow.
    #[test]
    fn stale_socket_file_does_not_block_binding() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("livelink-ipc-stale-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("player.sock");
        std::fs::write(&sock, b"garbage").unwrap(); // leftover from a dead run

        let (tx, rx) = std::sync::mpsc::channel();
        spawn_unix_listener(sock.clone(), tx, QueryHub::new());

        let mut stream = None;
        for _ in 0..50 {
            match std::os::unix::net::UnixStream::connect(&sock) {
                Ok(s) => {
                    stream = Some(s);
                    break;
                }
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
            }
        }
        let mut stream = stream.expect("listener never accepted a connection");
        stream.write_all(b"{\"cmd\":\"stop\"}\n").unwrap();
        stream.flush().unwrap();
        drop(stream); // same "UI gone" termination as above

        let cmd = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("stale socket blocked command delivery");
        assert_eq!(cmd.cmd, "stop");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
