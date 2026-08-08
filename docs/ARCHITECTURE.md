# Architecture Overview

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              LiveLink Server                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────────┐  │
│  │   Orchestrator   │    │   QueueService   │    │     PlayerService    │  │
│  │   (Central Hub)  │    │   (Per-Screen)   │    │  (MPV/Streamlink)    │  │
│  └────────┬─────────┘    └────────┬────────┘    └──────────┬───────────┘  │
│           │                       │                        │              │
│           ▼                       ▼                        ▼              │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                     Fetch Operations                                 │  │
│  │  ┌──────────┐ ┌─────────┐ ┌──────────┐ ┌───────┐ ┌───────┐        │  │
│  │  │ Holodex  │ │ Twitch  │ │ YouTube  │ │ Kick  │ │ ...   │        │  │
│  │  └──────────┘ └─────────┘ └──────────┘ └───────┘ └───────┘        │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│           │                                                            │
│           ▼                                                            │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                    Network Monitor                                   │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Orchestrator (`src/core/orchestrator/`)

Central coordinator managing all subsystems.

**Responsibilities:**
- Screen lifecycle management
- Stream scheduling and queue coordination
- Process exit handling
- Network recovery
- Auto-refresh and watched cleanup

**Key Files:**
- `mod.rs` - Main orchestrator, initialization, signal handling
- `stream_ops.rs` - Stream lifecycle (start/stop/exit handling)
- `queue_ops.rs` - Queue management
- `fetch_ops.rs` - Stream fetching from all platforms
- `state_ops.rs` - Screen state, filters, sorting
- `lock_ops.rs` - Per-screen mutex locks
- `recovery_ops.rs` - Network recovery

### 2. QueueService (`src/queue/`)

Per-screen stream queues with watched tracking.

**Features:**
- Per-screen queues with priority ordering
- Watched history with timestamps
- Sorting by favorites, viewers, priority
- Watched cleanup with TTL
- Soft-skip detection

**Key Files:**
- `queue.rs` - Queue implementation, sorting, watched tracking

### 3. PlayerService (`src/services/player.rs`)

Manages MPV/Streamlink/VLC processes.

**Features:**
- Fork-based MPV spawning with kill_on_drop
- IPC communication via Unix sockets
- Wait thread (100ms polling) for exit detection
- Exit callback with actual playback time
- Race condition protection

**Key Files:**
- `player.rs` - PlayerService, process management
- `mpv.rs` - MpvController, MpvInstance, IPC

### 4. NetworkMonitor (`src/services/network.rs`)

Monitors network connectivity.

**Features:**
- Periodic connectivity checks
- Network state events (Online/Offline)
- Automatic recovery on restore

### 5. Platform Services (`src/services/`)

| Service | Platform | Key Features |
|---------|----------|--------------|
| `holodex.rs` | Holodex | VTuber orgs, channels, live streams |
| `twitch.rs` | Twitch | Helix API, favorites, top streams |
| `youtube.rs` | YouTube | Data API v3, RSS fallback, categories |
| `kick.rs` | Kick | Live streams |
| `niconico.rs` | Niconico | Live streams |
| `bilibili.rs` | Bilibili | Live streams |
| `facebook.rs` | Facebook | Live streams |
| `fallback.rs` | Fallback | Static streams when APIs fail |

### 6. API Server (`src/api/`)

Axum-based HTTP server.

**Endpoints:**
- `/health` - Health check
- `/status` - Screen states, active count
- `/streams` - Cached streams by platform
- `/favorites` - Favorite channels
- `/watched` - Watched history
- `/queues` - Queue info
- `/stream/start|stop|stop-all` - Stream control
- `/queue/add|clear` - Queue management
- `/screen/enable|disable|toggle` - Screen control
- `/query` - Search streams
- `/refresh` - Force refresh
- `/save` - Save config

## Data Flow

### Stream Start Flow

```
1. CLI/API → Orchestrator.start_stream(screen)
2. Orchestrator → acquire screen lock
3. Orchestrator → check active stream count
4. Orchestrator → dequeue next stream from QueueService
5. Orchestrator → update ScreenState to Starting
6. Orchestrator → spawn PlayerService.start()
6. PlayerService → MpvController.play()
7. MpvController → fork() + exec mpv with IPC
8. MpvController → spawn wait thread (100ms polling)
9. MpvController → on exit: send ProcessExit via mpsc
10. Orchestrator.exit_listener → handle_process_exit()
11. Orchestrator → determine exit type (soft-skip/crash/normal)
12. Orchestrator → update state, mark watched, start next
```

### Stream Fetch Flow

```
1. Timer/Event → Orchestrator.refresh_all_queues()
2. Orchestrator → FetchOperations.fetch_all_streams_internal()
3. FetchOps → HolodexService.get_live_streams()
4. FetchOps → TwitchService.get_live_streams()
4. FetchOps → YouTubeService.get_live_streams()
5. FetchOps → apply_filters() → filter by platform, members, rules
6. FetchOps → sort_streams_by_favorites()
7. Orchestrator → QueueService.set_queue(screen, streams)
8. Orchestrator → if screen idle & auto_start → start_stream()
```

### Network Recovery Flow

```
1. NetworkMonitor → detects Online
2. NetworkMonitor → sends NetworkEvent::Online
3. Orchestrator.network_listener → recover_on_network_restore()
4. Orchestrator → refresh_all_queues()
5. Orchestrator → for idle screens with auto_start → start_stream()
```

## Concurrency Model

### Locks

| Resource | Lock Type | Scope |
|----------|-----------|-------|
| Screen State | `Arc<Mutex<()>>` | Per-screen |
| Queue | `Arc<Mutex<QueueService>>` | Global |
| Player Instances | `DashMap` | Per (screen, instance) |
| MPV Instance | `Mutex<MpvInstance>` | Per controller |
| Network State | `Arc<Mutex<NetworkState>>` | Global |

### Async Patterns

- **Tokio runtime** for async I/O
- **mpsc channels** for inter-task communication
- **spawn_blocking** for blocking MPV operations
- **Tokio mutex** for async locks
- **Std mutex** for sync locks (short critical sections)

### Thread Safety

- `Arc<Orchestrator>` shared across tasks
- `DashMap` for concurrent instance access
- `Arc<Mutex>` for MPV instance
- `mpsc` channels for exit events

## Configuration System

### Config Loader (`src/config/mod.rs`)

```rust
ConfigLoader::with_base_path("./config")
    .load()  // Loads all JSON files
```

**Files Loaded:**
- `config.json` - Main config (API keys, paths)
- `player.json` - Player settings, screens, filters
- `mpv.json` - MPV options
- `streamlink.json` - Streamlink settings
- `vlc.json` - VLC settings
- `filters.json` - Filter rules
- `favorites.json` - Favorite channels
- `streams.json` - Stream sources

### Configuration Merging

1. Load JSON files
2. Override with environment variables
3. Apply defaults for missing values
4. Validate required fields

## State Management

### ScreenState (`src/core/state.rs`)

```rust
pub struct ScreenState {
    pub screen: u32,
    pub state: StreamState,  // Idle, Starting, Playing, Error, Stopping
    pub stream: Option<StreamInfo>,
    pub enabled: bool,
    pub instance_id: u32,
}
```

### StreamInfo

```rust
pub struct StreamInfo {
    pub url: String,
    pub title: Option<String>,
    pub platform: Platform,
    pub screen: u32,
    pub quality: String,
    pub volume: u8,
    pub start_time: Option<Instant>,
}
```

### StreamState Enum

```rust
pub enum StreamState {
    Idle,
    Starting,
    Playing,
    Error,
    Stopping,
}
```

## Process Exit Handling

### Exit Types

| Type | Condition | Action |
|------|-----------|--------|
| Soft Skip | `playback_time < 2s` | Mark watched, start next |
| Crash | `2s < playback_time < 3s` | Mark Error, stay in Error |
| Normal End | `playback_time >= 3s` | Mark watched, start next |

### Exit Detection

1. **Wait Thread** (100ms polling) - Detects process exit
2. **Exit Callback** - Captures actual playback time
3. **mpsc Channel** - Sends ProcessExit to orchestrator
5. **Exit Listener** - Processes exit, determines type
6. **Handle Process Exit** - Updates state, starts next

## Filtering Pipeline

```
Raw Streams → apply_filters() → 
  1. Members-only filter
  2. Channel name exclusion (exact + regex)
  3. Title pattern exclusion (exact + regex)
  4. Platform exclusion
  5. Custom rules (channel/title with regex/ignore_case)
  6. ChannelFilter (name, english_name, aliases)
  7. Sort by favorites → priority → viewers
```

## Testing Architecture

### Unit Tests (`src/core_test.rs`)

- State operations
- Queue operations
- Filter matching
- Sort logic
- Exit handling (mock player)
- Integration tests with mock player

### Mock Player

```rust
struct MockPlayer {
    instances: Arc<Mutex<HashMap<(u32,u32), MockInstance>>>,
    exit_sender: mpsc::Sender<ProcessExit>,
    should_fail_start: Arc<Mutex<bool>>,
}
```

### Running Tests

```bash
cargo test                    # All tests
cargo test mock_player_tests  # Mock player tests only
cargo test -- --test-threads=1  # Sequential
```

## Performance Considerations

1. **DashMap** for concurrent instance access
2. **Arc<Mutex>** for shared state
3. **Tokio spawn** for async tasks
4. **spawn_blocking** for MPV operations
5. **Quota caching** for YouTube categories
6. **Batch API calls** where possible
7. **Lazy loading** for heavy resources

## Security Considerations

1. **API keys** in environment variables, not config files
2. **No authentication** on API (local use assumed)
3. **IPC sockets** in `/tmp` with random names
4. **Fork + setsid** for process isolation
5. **Signal handling** for graceful shutdown
6. **Config validation** on load

## Scaling Considerations

Current limits:
- Max 10 screens (hardcoded in some places)
- Max 4 concurrent streams (configurable)
- Per-screen queue limit: 1000 items
- API quota: 10,000/day YouTube

Future improvements:
- Horizontal scaling via message queue
- Distributed queue
- Redis for shared state
- WebSocket for real-time updates