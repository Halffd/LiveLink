# Architecture Overview

LiveLink is a **personal TV**: it decides what to play next and shows it,
while captions are captured and reused for language learning. This document
describes what is actually in the tree, not a target state.

Read [`PLAYER_BACKENDS.md`](PLAYER_BACKENDS.md) for the two ways pictures are
shown and how the server talks to them — that distinction explains most
questions about this codebase.

## Layers

```
┌──────────────────────── LiveLink (one process) ────────────────────────┐
│                                                                         │
│  Sources        Orchestrator          Players          cueloop daemon   │
│  ┌────────┐     ┌──────────────┐      ┌───────────┐   ┌─────────────┐  │
│  │holodex │     │ screen state │      │subprocess │   │ FIFO queue  │  │
│  │twitch  │────▶│ queues       │────▶ │ mpv       │   │ (with pins) │  │
│  │youtube │     │ watched      │      ├───────────┤   ├─────────────┤  │
│  │kick    │     │ fetch rules  │      │player     │   │ caption     │  │
│  │niconico│     │ per-screen   │      │window     │   │ cache       │  │
│  │bilibili│     │ locks        │      │(embedded) │   │ (SQLite)    │  │
│  │facebook│     └──────────────┘      └───────────┘   ├─────────────┤  │
│  └────────┘            │                              │ source      │  │
│                       │ language path                │ handlers    │  │
│                       ▼                              └─────────────┘  │
│              ┌──────────────────┐                    ↑ same socket API │
│              │ transcript worker│─── sub-add ──▶ player window         │
│              │ whisper panel    │                    └─────────────────┘ │
│              │ reading / SRS    │                                       │
│              └──────────────────┘                                       │
│                                                                         │
│  Control: CLI (`src/cli/`) · HTTP API (`src/api/`) · control ports      │
└─────────────────────────────────────────────────────────────────────────┘
```

## Layer responsibilities

### Sources — `src/services/*.rs` (except the player files)

Adapters that answer "what streams exist?" and "what URL plays this?":

| Module | Notes |
|---|---|
| `holodex.rs` | VTuber orgs, channels, live streams |
| `twitch.rs` | Helix API, favorites, top streams |
| `youtube.rs` | Data API v3, RSS fallback |
| `kick.rs`, `niconico.rs`, `bilibili.rs`, `facebook.rs` | live streams |
| `fallback.rs` | static streams when APIs fail |
| `network.rs` | connectivity monitor + recovery events |
| `transcript.rs` | transcription **worker** (see language path) |
| `player.rs`, `mpv.rs` | subprocess players (see `PLAYER_BACKENDS.md`) |
| `libmpv.rs` | embedded player (see `PLAYER_BACKENDS.md`) |
| `whisper_api.rs` | shared `.whisper-subs` HTTP surface (see language path) |

### Orchestrator — `src/core/orchestrator/`

Central coordinator. Holds screen state and queues, and is the only thing
allowed to change them.

| File | Responsibility |
|---|---|
| `mod.rs` | init, config, stream-change events, `window_playback()` |
| `stream_ops.rs` | stream lifecycle (start/stop/exit handling) |
| `queue_ops.rs` | queue mutation |
| `fetch_ops.rs` | multi-platform fetching, filters, sorting |
| `state_ops.rs` | screen state, filters, sorting view |
| `lock_ops.rs` | **per-screen locks** |
| `recovery_ops.rs` | recovery after network flapping |
| `player_ops.rs` | player commands, forwarded to windows in embedded mode |
| `embedded_ops.rs` | driving a **player window** (take-next, mark-playing, end reasons) |
| `query_ops.rs`, `channel_ops.rs`, `clone_impl.rs` | query joins, channel ops, cloning |

`src/core/state.rs` holds `ScreenState`/`StreamInfo`/`StreamState`;
`src/queue/queue.rs` is `QueueService` (per-screen queues + watched history).

### cueloop — `src/cueloop/`

A **separable daemon** (same code, own HTTP socket) for the newer learning
loop. Three parts:

- `queue.rs` — FIFO entries, **pinned** entries jump but keep relative order.
  Knows nothing about playback.
- `cache.rs` — captions on disk keyed by content hash (SQLite, 3 tables:
  `stream`, `caption`, `line`; `line` already carries per-cue translations
  and word-level timings).
- `sources.rs` — a `SourceHandler` trait: resolve an entry to a URL (+
  duration, existing subs, or "needs transcription"). **Adding a source type
  means adding one handler**, not touching queue or player.
- `server.rs` — routes: `/health`, `/queue` (get/post), `/queue/next`,
  `/queue/reorder`, `/queue/:id/pin`, `/queue/:id`, `/captions/:hash`,
  `/captions/:hash/exists`.

`src/bin/cueloopd.rs` runs it standalone.

### The language path

Captions are produced once and reused forever ("the second viewing is
instant"). Two engines, one shared HTTP surface, one shared cache:

- **Server engine** (the original path):
  - `src/services/whisper_api.rs` — the shared `.whisper-subs` surface:
    `paths`, `transcribe_body`, and response decoding. Both callers of that
    surface use these, so they cannot drift.
  - `src/services/transcript.rs` — the worker: on stream start it submits,
    polls, streams the growing `.srt` into the caption cache, and attaches
    it to the screen's **player window** over its control port
    (`{"cmd":"sub-add","url":"<file>"}`). mpv reloads changed subtitle files,
    so live-updating captions need no player-specific code.
  - `src/player_ui/whisper_subs.rs` — the player-window panel client
    (library/channels/live/subtitles) plus a background monitor thread.

- **Native engine** (`backend: "native"`, no server): `src/services/whisper_native/`
  - `engine.rs` — whisper.cpp via whisper-rs 0.16: 16 kHz mono f32 in,
    timestamped segments out. Knows nothing about where audio came from,
    so it is testable and swappable on its own.
  - `capture.rs` — three audio sources behind one type: `record` (the
    player's dumped file), `pa` (the system's audio output, the only option
    for a source the resolver cannot pull — it records what the speakers
    emit, so a muted screen yields silence), and `download` (yt-dlp /
    streamlink / curl pulls the audio track). Capture is time-bounded,
    decodes WAV natively and everything else through ffmpeg, and mixes to
    mono before resampling to 16 kHz.
  - Wired in `transcript.rs::transcribe_native`, which runs on a dedicated
    thread, accumulates cues with a stream-relative offset so a growing
    `.srt` stays in sync, rewrites it atomically, and attaches it over the
    control port.

Both engines write the same cache files and send the same `sub-add`, so
switching backends reuses existing transcripts.

Learning features live in the player window: `reading.rs` (furigana and
pinyin annotation), `srs.rs` (SRS note building), `subtitle.rs` (overlay,
modes, delays).

## Control surfaces

| Surface | Code | Notes |
|---|---|---|
| CLI | `src/cli/` | `livelink ...` |
| HTTP API | `src/api/` | axum, see `docs/API.md` |
| Player control ports | `src/player_ui/control.rs` | JSON lines over TCP, `3100 + screen` |
| cueloop socket | `src/cueloop/server.rs` | the daemon's own client API |

## Concurrency

| Resource | Lock | Scope |
|---|---|---|
| Screen state | `Arc<Mutex<()>>` | per screen (`lock_ops.rs`) |
| Queue | `Arc<Mutex<QueueService>>` | global |
| Player instances | `DashMap` | per (screen, instance) |
| MPV instance | `Mutex` | per controller |
| Caption cache | `rusqlite` connection in a `Mutex` | global |

Tokio for async I/O, `mpsc`/`broadcast` for inter-task events,
`spawn_blocking` for blocking MPV calls.

## Exit handling

| Type | Condition | Action |
|---|---|---|
| Soft skip | playback < 2s | mark watched, start next |
| Crash | 2s–3s | mark Error, stop retrying that stream |
| Normal end | ≥ 3s | mark watched, start next |

Exit is detected by a wait thread (100 ms polling) and delivered over an
`mpsc` channel to `stream_ops.rs`.

## Configuration

`ConfigLoader::with_base_path(dir).load()` reads `config.json`,
`player.json` (incl. `screens`, `player_type`), `mpv.json`,
`streamlink.json`, `vlc.json`, `filters.json`, `favorites.json`,
`streams.json`, `transcript.json`, with environment overrides.

`player_type` chooses the backend: `mpv`/`streamlink`/`vlc` spawn
subprocesses, `embedded` runs player windows.

## Testing

`cargo test` — unit and integration tests (`src/core_test.rs`, mock player,
plus per-module tests). Roughly 100 test functions across the tree.

## Known asymmetries / rough edges

- **Docs and code drifted**: the language path, `cueloop`, and the embedded
  player backend post-date most of this text. They are described here now.
- **No web or TUI front end**: control is CLI, HTTP API, and control ports.
- `player_type` is global per run, not per screen.