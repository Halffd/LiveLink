# LiveLink Architecture (Rust)

## Core Components
- **Orchestrator** (`src/core/orchestrator/`) - Central coordinator managing screens, queues, players, and stream lifecycle
- **QueueService** (`src/queue/`) - Per-screen stream queues with watched tracking, sorting, and filtering
- **PlayerService** (`src/services/player.rs`) - MPV/Streamlink/VLC process management via fork + IPC
- **NetworkMonitor** (`src/services/network.rs`) - Network state detection with automatic recovery
- **Fetch Operations** (`src/core/orchestrator/fetch_ops.rs`) - Multi-platform stream fetching (Holodex, Twitch, YouTube, Kick, Niconico, Bilibili, Facebook)
- **API Server** (`src/api/`) - Axum-based HTTP API server

## Key Services
1. **Orchestrator**
   - Manages screen states (Idle, Starting, Playing, Error)
   - Coordinates queue operations and player lifecycle
   - Handles process exit events with soft-skip/crash/normal-end logic
   - Auto-refresh background task for periodic stream fetching
   - Watched cleanup timer for expiring old watched entries

2. **QueueService**
   - Per-screen queues with StreamSource entries
   - Watched tracking with timestamps and TTL cleanup
   - Sorting by viewerCount, priority, name, isLive, platform (asc/desc)
   - Filtering by platform, channel, viewer count, watched status

3. **PlayerService**
   - Fork-based MPV spawning with kill_on_drop
   - IPC communication via Unix sockets
   - Wait thread (100ms polling) for guaranteed exit detection
   - Supports MPV, Streamlink, VLC players

4. **Fetch Operations**
   - Holodex API (VTuber organizations, channels)
   - Twitch Helix API (favorites + top streams)
   - YouTube (RSS fallback + API)
   - Kick, Niconico, Bilibili, Facebook services
   - Fallback service for offline/degraded operation

## Communication Flow
1. API Request → Axum Router → Orchestrator methods
2. Orchestrator → QueueService (queue operations)
3. Orchestrator → PlayerService (start/stop streams)
4. PlayerService → MPV subprocess (fork + IPC)
5. MPV wait thread → Exit callback → mpsc channel → exit_listener → handle_process_exit
6. NetworkMonitor → NetworkEvent channel → network_listener → recovery_on_network_restore

# Configuration (Rust)

## Environment Variables
- `HOLODEX_API_KEY` - Holodex API key
- `TWITCH_CLIENT_ID` - Twitch client ID
- `TWITCH_CLIENT_SECRET` - Twitch client secret
- `YOUTUBE_API_KEY` - YouTube API key (optional, RSS fallback used if missing)
- `PORT` - API server port (default: 3001)
- `LIVELINK_LOG_DIR` - Log directory (default: logs/)
- `RUST_LOG` - Log level filter (e.g., `info,livelink=debug`)

## Config Files (config/)
| File | Description |
|------|-------------|
| `player.json` | Player settings, screens, auto-refresh, watched cleanup |
| `mpv.json` | MPV player options (global, applied via mpv_extra_args) |
| `streamlink.json` | Streamlink settings and MPV overrides |
| `vlc.json` | VLC player settings |
| `filters.json` | Stream filtering rules (blacklist/whitelist, members-only) |
| `favorites.json` | Favorite channels per platform (holodex, twitch, youtube, kick, niconico, bilibili, facebook) |
| `streams.json` | Stream source configurations |

## player.json - Player & Screen Configuration
```json
{
  "defaultQuality": "best",
  "defaultVolume": 0,
  "windowMaximized": true,
  "maxStreams": 2,
  "autoStart": true,
  "auto_refresh_interval_seconds": 60,
  "watched_clear_hours": 10,
  "force_player": false,
  "disableHeartbeat": true,
  "logging": {
    "enabled": true,
    "level": "info",
    "maxSizeMB": 50,
    "maxFiles": 5
  },
  "screens": [
    {
      "id": 1,
      "screen": 1,
      "enabled": true,
      "width": 1920,
      "height": 1080,
      "x": 1366,
      "y": 0,
      "volume": 0,
      "quality": "best",
      "windowMaximized": true,
      "primary": true,
      "sources": [
        { "type": "youtube", "enabled": true, "priority": 1, "limit": 50 },
        { "type": "twitch", "enabled": true, "priority": 2, "limit": 30 }
      ],
      "sorting": {
        "rules": [
          { "field": "viewerCount", "order": "desc" },
          { "field": "isLive", "order": "desc" }
        ]
      },
      "refresh": 300,
      "auto_start": true,
      "skip_watched_streams": false
    }
  ]
}
```

### Screen Configuration Options
| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `id` | u32 | - | Internal ID |
| `screen` | u32 | - | Screen number (matches CLI `--screens`) |
| `enabled` | bool | true | Whether screen is active |
| `width` | u32 | 1920 | Window width (X11 geometry) |
| `height` | u32 | 1080 | Window height |
| `x` | i32 | 0 | X position |
| `y` | i32 | 0 | Y position |
| `volume` | u8 | 50 | Initial volume (0-100) |
| `quality` | string | "best" | Stream quality |
| `windowMaximized` | bool | false | Start maximized |
| `primary` | bool | false | Primary screen |
| `sources` | SourceConfig[] | [] | Enabled stream sources with priority |
| `sorting` | SortingConfig | null | Sort rules for queue |
| `refresh` | u32 | 300 | Legacy refresh interval (seconds) |
| `auto_start` | bool | true | Auto-start on startup |
| `skip_watched_streams` | bool | false | Skip already-watched streams |

### SourceConfig
```json
{
  "type": "youtube",
  "enabled": true,
  "priority": 1,
  "limit": 50,
  "name": "YouTube",
  "tags": ["vtuber"]
}
```
| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Platform: "youtube", "twitch", "kick", "holodex", "niconico", "bilibili", "facebook" |
| `enabled` | bool | Whether this source is active |
| `priority` | u32 | Lower = higher priority when merging sources |
| `limit` | usize | Max streams to fetch from this source |
| `name` | string | Display name |
| `tags` | string[] | Tags for filtering |

### SortingConfig
```json
{
  "rules": [
    { "field": "viewerCount", "order": "desc" },
    { "field": "priority", "order": "asc" },
    { "field": "name", "order": "asc" },
    { "field": "isLive", "order": "desc" },
    { "field": "platform", "order": "asc" }
  ]
}
```
| Field | Values | Description |
|-------|--------|-------------|
| `field` | viewerCount/viewers, priority, name/title, isLive/live, platform | Sort key |
| `order` | asc, desc | Sort direction |
| `ignore` | string | Unused (reserved) |

**Applied in reverse order** (last rule = primary sort) via `Queue.apply_sorting()`.

## mpv.json - MPV Configuration
Global MPV options applied via `MpvConfig.to_args()` → `mpv_extra_args` in OrchestratorConfig.

```json
{
  "path": "mpv",
  "priority": "normal",
  "gpu-context": "auto",
  "volume": 0,
  "border": false,
  "fullscreen": false,
  "ontop": true,
  "pause": false,
  "mute": false,
  "loop": null,
  "vid": "auto",
  "aid": "auto",
  "sid": "auto",
  "keep-open": true,
  "input-default-bindings": true,
  "input-terminal": true,
  "osd-level": 1,
  "force-window": false,
  "cursor": false,
  "extra": {
    "force-seekable": true,
    "video-latency-hacks": true,
    "vd-lavc-threads": 4,
    "ad-lavc-threads": 4,
    "audio-buffer": 0.2,
    "demuxer-max-bytes": "150MiB",
    "demuxer-max-back-bytes": "50MiB",
    "demuxer-lavf-oob": true,
    "hls-bitrate": "auto"
  }
}
```

### Key MPV Options
| Option | Values | Description |
|--------|--------|-------------|
| `path` | string | MPV binary path |
| `priority` | idle, below_normal, normal, above_normal, high, realtime | Process priority |
| `gpu-context` | auto, wayland, x11, cocoa, etc. | GPU backend (auto-detected by display server) |
| `volume` | 0-100 | Initial volume |
| `border` | bool | Window border |
| `fullscreen` | bool | Start fullscreen |
| `ontop` | bool | Keep window on top |
| `pause` | bool | Start paused |
| `mute` | bool | Start muted |
| `loop` | null, "inf", "no", "force" | Loop behavior |
| `speed` | f64 | Playback speed (1.0 = normal) |
| `keep-open` | bool | Keep window open after playback ends |
| `extra` | object | Additional mpv options (passthrough) |

**Note:** `gpu-context` is auto-detected (wayland/x11). Per-screen geometry (width, height, x, y) from `player.json` screens config is applied separately and overrides any geometry in mpv.json.

## filters.json - Stream Filtering
```json
{
  "enabled": true,
  "mode": "blacklist",
  "filter_members_only": true,
  "channel_names": ["channel1", "channel2"],
  "channel_names_regex": [],
  "title_patterns": ["membership", "members only"],
  "title_patterns_regex": [],
  "channels": [],
  "rules": [],
  "exclude_platforms": []
}
```
| Option | Description |
|--------|-------------|
| `enabled` | Enable/disable filtering |
| `mode` | "blacklist" (exclude matches) or "whitelist" (only allow matches) |
| `filter_members_only` | Exclude members-only streams |
| `channel_names` | Exact channel name matches to filter |
| `channel_names_regex` | Regex patterns for channel names |
| `title_patterns` | Substring matches for stream titles |
| `title_patterns_regex` | Regex patterns for stream titles |
| `exclude_platforms` | Platforms to exclude entirely |

## favorites.json - Favorite Channels
Per-platform favorite channels with scores for priority sorting.

```json
{
  "holodex": { "default": [], "channels": [], "ids": [] },
  "twitch": { "default": [], "channels": [], "ids": [] },
  "youtube": { "default": [], "channels": [], "ids": [] },
  "kick": { "default": [], "channels": [], "ids": [] },
  "niconico": { "default": [], "channels": [], "ids": [] },
  "bilibili": { "default": [], "channels": [], "ids": [] },
  "facebook": { "default": [], "channels": [], "ids": [] }
}
```

Each channel entry:
```json
{ "id": "UC...", "name": "Channel Name", "score": 1000 }
```

**Score**: Higher = higher priority. Default assigns 1000-index.

# API Endpoints (Rust)

Base URL: `http://localhost:3001` (configurable via PORT)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Screen states, active count |
| GET | `/streams` | All cached streams grouped by platform |
| GET | `/favorites` | Favorite channels by platform |
| GET | `/watched` | Watched streams across screens |
| GET | `/organizations` | Organizations from favorites |
| GET | `/filters` | Filter configuration |
| GET | `/screens` | Screen configurations and states |
| GET | `/queues` | Queue info (count, watched count) per screen |
| POST | `/query` | Search streams (Holodex, Twitch, etc.) |
| POST | `/stream/start` | Start stream on screen |
| POST | `/stream/stop` | Stop stream on screen |
| POST | `/stream/stop-all` | Stop all streams |
| POST | `/queue/add` | Add URL to screen queue |
| POST | `/queue/clear` | Clear screen queue |
| POST | `/watched/clear` | Clear watched history |
| POST | `/refresh` | Force refresh all queues |
| POST | `/save` | Save config to disk |
| POST | `/screen/enable` | Enable screen + start stream |
| POST | `/screen/disable` | Disable screen + stop stream |
| POST | `/screen/toggle` | Toggle screen state |

### Example Requests
```bash
# Start stream on screen 1
curl -X POST http://localhost:3001/stream/start -H "Content-Type: application/json" -d '{"screen": 1}'

# Add URL to queue
curl -X POST http://localhost:3001/queue/add -H "Content-Type: application/json" -d '{"screen": 1, "url": "https://twitch.tv/xqc", "title": "XQC"}'

# Query streams
curl -X POST http://localhost:3001/query -H "Content-Type: application/json" -d '{"search": "gaming", "platform": "twitch", "limit": 10}'
```

# CLI Usage

```bash
# Start with screens and instances
livelink start --screens 1,2 --instances 0,1 --port 3001 --config-dir config

# Queue management
livelink queue-add 1 "https://twitch.tv/xqc"
livelink queue-show 1
livelink queue-clear 1

# Screen control
livelink screen-enable 1
livelink screen-disable 1
livelink screen-toggle 1

# Stream control
livelink stream-start --screen 1 --url "https://youtube.com/watch?v=..."
livelink stream-stop 1
livelink stream-restart 1

# Watched history
livelink queue-watched 1
livelink queue-mark-watched "https://..."
livelink queue-clear-watched

# Config
livelink config --get
livelink config --key max_streams
livelink config --set max_streams=4
livelink config --save

# Query
livelink query --search "minecraft" --platform twitch --limit 20
```

# Process Exit Handling

Three-tier exit classification in `handle_process_exit`:

| Condition | Action |
|-----------|--------|
| `playback_time < skip_threshold` (default 2s) | **Soft skip** - mark watched, finish_stop, start next |
| `playback_time < crash_threshold` (default 3s) | **Crash** - mark_error, stay in Error state |
| `playback_time >= crash_threshold` | **Normal end** - finish_stop, mark watched, start next |

Uses actual MPV playback time via IPC (`get_playback_time()`), not wall-clock.

# Auto-Refresh & Cleanup

- **Auto-refresh**: Every `auto_refresh_interval_seconds` (default 60s), fetches new streams and restarts idle enabled screens
- **Watched cleanup**: Every `watched_clear_hours` (default 10h), removes watched entries older than TTL

# Network Recovery

On network restore (NetworkState::Online), `recover_on_network_restore()` refreshes all queues and restarts idle enabled screens.

# Tiling Window Manager Support

Per-screen geometry from `player.json` screens config is applied via MPV `--geometry=WxH+x+y`. On Wayland/X11, use window manager rules for positioning:

```bash
# Hyprland example (auto-generate with: node scripts/generate-wm-config.js hyprland)
windowrule {
  name = livelink-screen-1
  match:class = livelink-screen-1
  float = on
  size = 1920 1080
  move = 1366 0
}
```

MPV window class: `livelink-screen-{screen}`

# Logging

- File: `logs/livelink.log` (daily rotation, 50MB max, 5 files)
- Level: Configurable via `RUST_LOG` or `logging.level` in player.json
- Debug flag: `--debug` enables trace-level MPV command logging