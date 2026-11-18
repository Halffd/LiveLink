# Player backends

LiveLink has **two ways to show a picture**, and the server picks one per
run. Most confusion about this codebase comes from reading the docs for one
backend while looking at the code for the other. This page is the map.

## The two backends

|  | **Subprocess player** (the original) | **Player window** (`embedded`) |
|---|---|---|
| Code | `src/services/player.rs`, `src/services/mpv.rs` | `src/player_ui/`, `src/services/libmpv.rs` |
| What it is | `fork()` + `exec mpv` per stream, one OS process | one `lvp`/`livelink-player` process per screen, window stays up |
| Video output | mpv's own window | libmpv renders into an FBO → an egui texture |
| Language features | none (subtitles only if mpv loads them) | whisper panel, reading mode, SRS, subtitle overlay |
| Multi-screen | the server spawns one player per screen | the server (or something else) spawns one `lvp` per screen |
| Selected by | any other `player_type` | `player_type: "embedded"` |

## Which one runs

`Orchestrator::window_playback()` (`src/core/orchestrator/mod.rs`) is
`config.player_type == "embedded"`. It is a **deployment choice, not a
per-screen one**: every screen in a run uses the same backend.

Both modes keep the same server-side machinery — queues, watched history,
filters, screen state, network recovery. Only the last hop differs.

## The bridge: control ports

When a screen plays in a player window, the server still owns that screen's
state but the *window* owns playback. The two talk over a TCP control port
(`src/player_ui/control.rs`):

- One line-delimited JSON command per connection; `{"cmd":"play","url":...}`,
  `{"cmd":"pause"}`, `{"cmd":"volume","value":50}`, `{"cmd":"sub-add","url":...}`, …
- A window on screen **N** listens on `3100 + N` (`DEFAULT_BASE_PORT`), the
  same convention the server uses when it forwards stream changes.
- `control::send_command(port, line)` is the client side, used from:
  - `src/core/orchestrator/player_ops.rs` — server-driven pause/volume/seek,
  - `src/services/transcript.rs` — attaching generated `.srt` files
    (`{"cmd":"sub-add","url":"<file>"}`),
  - scripts and anything else that wants to drive a window.

A window that is not listening means the window is closed;
`send_command` fails with connection refused, which callers treat as a
no-op, not an error.

## Because of this, pause/volume/seek behave differently

In subprocess mode the server drives the mpv process directly. In embedded
mode the same server call must be forwarded to the window instead, or it
would silently do nothing. `player_ops.rs` therefore branches on
`window_playback()` and forwards — both paths are exercised by unit tests
that check the generated JSON lines.

## Choosing

- Want the learning features (whisper panel, reading mode, SRS notes,
  subtitle overlay): use `embedded`.
- Want plain TV with no overlay UI and no crash surface: use the subprocess
  player.

Both are first-class; the subprocess path is not deprecated and is what most
of the original docs describe.