## LiveLink

# 📚 LiveLink - Streaming Manager

A high-performance, race-condition-free streaming manager for Twitch, YouTube, and Holodex.

---

## 🚀 Quick Start

### Installation

```bash
git clone https://github.com/yourrepo/LiveLink
cd LiveLink/rust
cargo build --release
```

### Configuration

Create `config/` directory with JSON files:

```bash
mkdir -p config
```

### Environment Variables (Optional)

```bash
# Override config file values
export HOLODEX_API_KEY="your-key"
export TWITCH_CLIENT_ID="your-id"
export TWITCH_CLIENT_SECRET="your-secret"
export YOUTUBE_API_KEY="your-key"
export LIVELINK_CONFIG="/custom/config/path"
export LOG_LEVEL="debug"
export PORT="3001"
```

### Run

```bash
# Server mode
cargo run

# CLI mode
cargo run -- stream list
cargo run -- screen enable 1
```

---

## 📁 Configuration Files

All config files go in `config/` directory.

### 1. `favorites.json` – Favorite Channels

**Format A: Per-platform (recommended)**

```json
{
  "holodex": {
    "default": [
      { "id": "UC3n9mTfC7Ib1P8Z-MqP5M8w", "name": "Mori Calliope", "score": 100 },
      { "id": "UCf5mFVsGjJ5y2qW9T5s5j5A", "name": "Gawr Gura", "score": 95 }
    ]
  },
  "twitch": {
    "default": [
      { "id": "monstercat", "name": "Monstercat", "score": 80 },
      { "id": "sodapoppin", "name": "Sodapoppin", "score": 75 }
    ]
  },
  "youtube": {
    "default": [
      { "id": "UCXuqSBlHAE6Xw-yeJA0Tunw", "name": "Ludwig", "score": 90 }
    ]
  }
}
```

**Format B: Simple array (same for all platforms)**

```json
[
  { "id": "monstercat", "name": "Monstercat", "score": 100 },
  { "id": "sodapoppin", "name": "Sodapoppin", "score": 90 }
]
```

**Format C: URLs only (auto-scores based on order)**

```json
{
  "urls": "https://twitch.tv/monstercat https://twitch.tv/sodapoppin https://youtube.com/@ludwig"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Channel ID or username |
| `name` | string | Display name |
| `score` | number | Higher = higher priority (default: position-based) |

---

### 2. `streams.json` – Screen & Stream Sources

```json
{
  "streams": [
    {
      "id": 1,
      "screen": 1,
      "enabled": true,
      "width": 1920,
      "height": 1080,
      "x": 0,
      "y": 0,
      "volume": 70,
      "quality": "best",
      "window_maximized": true,
      "primary": true,
      "sources": [
        {
          "type": "holodex",
          "subtype": "organization",
          "enabled": true,
          "priority": 10,
          "limit": 20,
          "name": "Hololive"
        },
        {
          "type": "twitch",
          "subtype": "favorites",
          "enabled": true,
          "priority": 20
        },
        {
          "type": "youtube",
          "subtype": "popular",
          "enabled": true,
          "priority": 30,
          "limit": 10
        }
      ],
      "sorting": {
        "field": "viewerCount",
        "order": "desc",
        "ignore": ["members_only"]
      },
      "refresh": 60,
      "auto_start": true,
      "skip_watched_streams": true
    }
  ],
  "organizations": ["Hololive", "Nijisanji", "VShojo"]
}
```

#### ScreenConfig Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | number | required | Unique screen ID |
| `screen` | number | required | Display/monitor number |
| `enabled` | bool | true | Enable/disable this screen |
| `width` | number | 1280 | Window width |
| `height` | number | 720 | Window height |
| `x` | number | 0 | X position on desktop |
| `y` | number | 0 | Y position on desktop |
| `volume` | number (0-100) | 50 | Default volume |
| `quality` | string | "best" | Stream quality |
| `window_maximized` | bool | false | Start maximized |
| `primary` | bool | false | Primary screen |
| `sources` | array | [] | Stream sources (see below) |
| `sorting` | object | - | Sorting rules |
| `refresh` | number (sec) | 300 | Queue refresh interval |
| `auto_start` | bool | true | Auto-start on launch |
| `skip_watched_streams` | bool | true | Skip already watched |

#### Source Types

| Type | Subtype | Description | Requires |
|------|---------|-------------|----------|
| `holodex` | `organization` | Fetch by org name | `name` field |
| `holodex` | `favorites` | Fetch favorite channels | `favorites.json` |
| `twitch` | `favorites` | Fetch favorite Twitch channels | `favorites.json` |
| `twitch` | `vtuber` | Fetch VTuber streams | - |
| `youtube` | `favorites` | Fetch favorite YouTube channels | `favorites.json` |
| `youtube` | `popular` | Fetch popular live streams | - |

#### Sorting Fields

| Field | Description |
|-------|-------------|
| `viewerCount` | Sort by viewer count |
| `startTime` | Sort by start time (oldest first) |
| `priority` | Sort by priority number |
| `score` | Sort by favorite score |

---

### 3. `player.json` – Player Settings

```json
{
  "prefer_streamlink": false,
  "default_quality": "best",
  "default_volume": 50,
  "window_maximized": false,
  "max_streams": 2,
  "auto_start": true,
  "disable_heartbeat": false,
  "force_player": false,
  "logging": {
    "enabled": true,
    "level": "info",
    "max_size_mb": 50,
    "max_files": 5
  },
  "screens": []
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prefer_streamlink` | bool | false | Use Streamlink over MPV |
| `default_quality` | string | "best" | Default stream quality |
| `default_volume` | number (0-100) | 50 | Default volume |
| `window_maximized` | bool | false | Start maximized |
| `max_streams` | number | 4 | Max concurrent streams |
| `auto_start` | bool | true | Auto-start on launch |
| `disable_heartbeat` | bool | false | Disable health checks |
| `force_player` | bool | false | Keep player running |
| `logging` | object | - | Logging configuration |

---

### 4. `mpv.json` – MPV Player Configuration

```json
{
  "priority": "normal",
  "gpu-context": "auto",
  "cache": "yes",
  "cache-secs": 30,
  "demuxer-max-bytes": 150M,
  "demuxer-max-back-bytes": 50M
}
```

---

### 5. `streamlink.json` – Streamlink Configuration

```json
{
  "path": "/usr/bin/streamlink",
  "options": {
    "player": "mpv",
    "retry-open": 5,
    "retry-streams": 10,
    "hls-segment-threads": 5
  },
  "http_header": {
    "User-Agent": "LiveLink/1.0"
  }
}
```

---

### 6. `filters.json` – Stream Filters

```json
{
  "filters": [
    "members only",
    "member only",
    "membership",
    "unavailable",
    "private",
    "deleted"
  ]
}
```

Filters out streams whose titles contain these keywords.

---

### 7. `config.json` – API Keys (Optional Fallback)

```json
{
  "holodex": { "api_key": "your-holodex-key" },
  "twitch": {
    "client_id": "your-twitch-client-id",
    "client_secret": "your-twitch-client-secret"
  },
  "youtube": { "api_key": "your-youtube-key" }
}
```

> **Note:** Environment variables override this file.

---

## 🖥️ CLI Commands

### Stream Management

```bash
# List active streams
livelink stream list
livelink stream ls

# List with watch mode (refresh every 5s)
livelink stream list --watch

# Start stream
livelink stream start --url https://twitch.tv/xqc --screen 1 --quality best

# Stop stream
livelink stream stop 1

# Restart stream(s)
livelink stream restart --screen 1
livelink stream restart  # all screens

# Refresh stream data
livelink stream refresh 1
livelink stream refresh  # all screens
```

### Queue Management

```bash
# Show queue
livelink queue show 1
livelink queue ls 1

# Add to queue
livelink queue add 1 https://twitch.tv/xqc "XQC Stream"

# Remove from queue (by index)
livelink queue remove 1 2
livelink queue rm 1 1,2,3  # batch remove

# Clear queue
livelink queue clear 1

# Watched streams
livelink queue watched
livelink queue mark-watched https://twitch.tv/xqc
livelink queue clear-watched
```

### Screen Management

```bash
# List screens
livelink screen list
livelink screen ls

# Enable/disable screen
livelink screen enable 1
livelink screen disable 1

# Toggle screen
livelink screen toggle 1
```

### Player Control

```bash
# Pause/unpause
livelink player pause 1
livelink player pause all

# Set volume
livelink player volume 50 1
livelink player volume 50 all

# Seek
livelink player seek 30 1   # forward 30s
livelink player seek -10 1  # backward 10s

# Set process priority
livelink player priority high
```

### Server Control

```bash
# Start server
livelink start

# Stop server
livelink server stop
livelink server stop --all  # stop players too

# Server status
livelink server status
```

### Info & Debug

```bash
# List organizations
livelink orgs

# Run diagnostics
livelink diagnostics
```

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI / API                           │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR                           │
│  • Single authority for all stream operations               │
│  • Per-screen mutex locking                                 │
│  • State machine validation                                 │
│  • Max streams enforcement                                  │
└─────────────────────────────────────────────────────────────┘
              │              │              │
              ▼              ▼              ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│  Holodex    │  │   Twitch    │  │   YouTube   │
│  Service    │  │   Service   │  │   Service   │
└─────────────┘  └─────────────┘  └─────────────┘
                              │
                              ▼
              ┌─────────────────────────────┐
              │         Queue System        │
              │  • Filter (watched, member) │
              │  • Sort (priority, viewers) │
              └─────────────────────────────┘
                              │
                              ▼
              ┌─────────────────────────────┐
              │        Player Service       │
              │  • MPV IPC control          │
              │  • Health monitoring        │
              │  • Crash recovery           │
              └─────────────────────────────┘
```

### State Machine

```
Idle ──start──▶ Starting ──success──▶ Playing
  ▲                │                      │
  │                │ error                │ stop
  │                ▼                      ▼
  └─────────────── Error ◀───────────── Stopping
                                                │
                                                ▼
                                              Idle
```

---

## 🔧 Development

### Build

```bash
cargo build
cargo build --release
```

### Run Tests

```bash
cargo test
cargo test -- --nocapture  # with output
```

### Check (without build)

```bash
cargo check
```

### Lint

```bash
cargo clippy
cargo fmt
```

---

## 📝 Logging

Log levels: `error`, `warn`, `info`, `debug`, `trace`

Set via environment:
```bash
export LOG_LEVEL=debug
cargo run
```

Log rotation is automatic (50MB, 5 files).

---

## 🐛 Troubleshooting

### "Holodex client not initialized"

- Missing `HOLODEX_API_KEY` env var or `config.json` entry
- Service will be disabled, fallback to favorites

### "Twitch service not enabled"

- Missing `TWITCH_CLIENT_ID` or `TWITCH_CLIENT_SECRET`
- Service will be disabled

### "Max streams reached"

- `max_streams` limit hit (default: 4)
- Stop a stream or increase limit in `player.json`

### Streams not starting

Check:
1. Service is enabled (API key present)
2. Screen is enabled
3. Queue has unwatched streams
4. No duplicate stream already playing

---

## 📄 License

MIT

---

## 🙏 Credits

Built with:
- [Tokio](https://tokio.rs) - Async runtime
- [Axum](https://github.com/tokio-rs/axum) - Web framework
- [Clap](https://clap.rs) - CLI parser
- [Serde](https://serde.rs) - Serialization
- [Tracing](https://tokio.rs/tokio/tutorial/tracing) - Logging

---

