# LiveLink Documentation

LiveLink is a multi-screen live stream player built with Rust. It automatically discovers and plays live streams from multiple platforms (YouTube, Twitch, Holodex, Kick, Niconico, Bilibili, Facebook) across multiple screens.

## Features

- **Multi-platform support**: YouTube, Twitch, Holodex, Kick, Niconico, Bilibili, Facebook
- **Multi-screen playback**: Play different streams on multiple screens simultaneously
- **Auto-discovery**: Automatically finds live streams from configured sources
- **Favorites system**: Prioritize streams from favorite channels
- **Smart filtering**: Exclude unwanted content by channel, title, platform, or custom rules
- **YouTube API support**: Full integration with YouTube Data API v3
- **RSS fallback**: Automatic fallback to RSS when API quota exhausted
- **Categories**: Browse streams by YouTube categories
- **Channel details**: Get channel statistics, branding, thumbnails
- **Graceful shutdown**: Proper cleanup on SIGTERM/SIGINT
- **Configurable locks**: Optional screen locking mechanism
- **Per-screen configuration**: Different sources, geometry, sorting per screen

## Quick Start

### Prerequisites

- Rust 1.70+
- MPV player installed
- Optional: Streamlink, VLC

### Installation

```bash
git clone <repo>
cd LiveLink
cargo build --release
```

### Configuration

Copy and edit configuration files in `config/`:

```bash
cp -r config.example config
# Edit config files as needed
```

### Running

```bash
# Start with default config
./target/release/livelink start --config-dir ./config

# Or specify custom port
./target/release/livelink start --port 8789 --config-dir ./config
```

## Configuration Files

### player.json

Main player configuration with screen settings, sources, favorites, and filters.

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
  "use_locks": true,
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
      "playerType": "both",
      "primary": true,
      "sources": [
        { "type": "youtube", "enabled": true, "priority": 1, "limit": 50 }
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

### mpv.json

MPV player configuration with global options.

```json
{
  "path": "mpv",
  "priority": "normal",
  "gpu-context": "auto",
  "volume": 0,
  "border": false,
  "fullscreen": false,
  "ontop": false,
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
  "config_dir": "~/dotfiles/.mpv-live",
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

### favorites.json

Channel favorites for each platform (comma-separated ordered values).

```json
{
  "youtube": "UC5CwaMl1eIgY8h02uZw7u8A,UCxsZ6NCzjU_t4YSxQLBcM5A,...",
  "twitch": "amemiyanazuna,nekoko88,sakuramiko_hololive,...",
  "holodex": "",
  "kick": "",
  "niconico": "",
  "bilibili": "",
  "facebook": ""
}
```

### filters.json

Filter configuration for excluding unwanted content.

```json
{
  "enabled": true,
  "mode": "blacklist",
  "filter_members_only": true,
  "channel_names": ["channel1", "channel2"],
  "channel_names_regex": ["pattern1", "pattern2"],
  "title_patterns": ["membership", "members only", "限定", "歌枠", "雑談", "ASMR"],
  "title_patterns_regex": [],
  "channels": [],
  "rules": [
    {
      "type": "channel",
      "pattern": "pattern",
      "regex": false,
      "ignore_case": true
    },
    {
      "type": "title",
      "pattern": "keyword",
      "regex": false,
      "ignore_case": true
    }
  ],
  "exclude_platforms": []
}
```

## Screen Configuration

Each screen can be configured with:

| Field | Description |
|-------|-------------|
| `id` | Internal screen ID |
| `screen` | Screen number (1-based) |
| `enabled` | Whether screen is active |
| `width` | Window width |
| `height` | Window height |
| `x` | X position |
| `y` | Y position |
| `volume` | Initial volume (0-100) |
| `quality` | Stream quality (best, worst, 720p, etc.) |
| `windowMaximized` | Start maximized |
| `playerType` | Player type (mpv, streamlink, vlc, both) |
| `primary` | Primary screen |
| `sources` | Enabled sources with priority |
| `sorting` | Sort rules for queue |
| `refresh` | Refresh interval (seconds) |
| `auto_start` | Auto-start on launch |
| `skip_watched_streams` | Skip already watched |

### Source Configuration

| Field | Description |
|-------|-------------|
| `type` | Platform (youtube, twitch, holodex, kick, niconico, bilibili, facebook) |
| `enabled` | Enable this source |
| `priority` | Priority (lower = higher priority) |
| `limit` | Max streams from this source |
| `name` | Display name |
| `tags` | Tags for filtering |

### Sorting Configuration

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

## API Endpoints

Base URL: `http://localhost:3001` (configurable via `--port`)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Screen states, active count |
| GET | `/streams` | All cached streams by platform |
| GET | `/favorites` | Favorite channels by platform |
| GET | `/watched` | Watched streams across screens |
| GET | `/organizations` | Organizations from favorites |
| GET | `/filters` | Filter configuration |
| GET | `/screens` | Screen configurations and states |
| GET | `/queues` | Queue info per screen |
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

### Example API Calls

```bash
# Start stream on screen 1
curl -X POST http://localhost:3001/stream/start \
  -H "Content-Type: application/json" \
  -d '{"screen": 1}'

# Add URL to queue
curl -X POST http://localhost:3001/queue/add \
  -H "Content-Type: application/json" \
  -d '{"screen": 1, "url": "https://twitch.tv/xqc", "title": "XQC"}'

# Query streams
curl -X POST http://localhost:3001/query \
  -H "Content-Type: application/json" \
  -d '{"search": "gaming", "platform": "twitch", "limit": 10}'
```

## CLI Commands

```bash
# Start with specific screens
livelink start --screens 1,2 --instances 0,1 --port 3001 --config-dir config

# Queue management
livelink queue-add 1 "https://twitch.tv/xqc"
livelink queue-show 1
livelink queue-clear 1

# Screen control
livelink enable 1
livelink disable 1
livelink stop 1
livelink stop-all
livelink restart 1

# Status
livelink status
livelink streams

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

## YouTube API Integration

### Features

- **Favorites**: 19 YouTube channel IDs configured
- **Categories**: Fetch video categories, get live streams by category
- **Channels/Subscriptions**: Channel details API (stats, branding, thumbnails)
- **Live streams**: Detailed info (concurrent viewers, category)
- **Categories search**: Get live streams by category
- **Search**: Query with optional category filter
- **RSS fallback**: When API quota exhausted
- **Subscriptions**: Channel favorites from config

### YouTube API Key

Set `YOUTUBE_API_KEY` environment variable or configure in `config/config.json`:

```json
{
  "youtube": {
    "api_key": "YOUR_API_KEY"
  }
}
```

## Twitch Integration

Set Twitch credentials:

```bash
export TWITCH_CLIENT_ID=your_client_id
export TWITCH_CLIENT_SECRET=your_client_secret
```

Or configure in `config/config.json`:

```json
{
  "twitch": {
    "client_id": "your_client_id",
    "client_secret": "your_client_secret"
  }
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOLODEX_API_KEY` | Holodex API key | - |
| `TWITCH_CLIENT_ID` | Twitch client ID | - |
| `TWITCH_CLIENT_SECRET` | Twitch client secret | - |
| `YOUTUBE_API_KEY` | YouTube API key | - |
| `PORT` | API server port | 3001 |
| `LIVELINK_LOG_DIR` | Log directory | logs/ |
| `RUST_LOG` | Log level filter | info |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      LiveLink Server                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Orchestrator│  │ QueueService │  │   PlayerService     │  │
│  │  (Central)   │  │  (Queues)    │  │  (MPV/Streamlink)   │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         ▼                ▼                     ▼             │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Fetch Operations                            │ │
│  │  ┌─────────┐ ┌─────────┐ ┌───────┐ ┌───────┐ ┌───────┐  │ │
│  │  │ Holodex │ │ Twitch  │ │ YouTube│ │ Kick  │ │ ...   │  │ │
│  │  └─────────┘ └─────────┘ └───────┘ └───────┘ └───────┘  │ │
│  └─────────────────────────────────────────────────────────┘ │
│                           │                                   │
│                           ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Network Monitor                              │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Process Exit Handling

Three-tier exit classification:

| Condition | Action |
|-----------|--------|
| `playback_time < skip_threshold` (2s) | Soft skip - mark watched, start next |
| `playback_time < crash_threshold` (3s) | Crash - mark error, stay in Error state |
| `playback_time >= crash_threshold` | Normal end - mark watched, start next |

Uses actual MPV playback time via IPC.

## Filters

The filter system supports:

- **Channel name filtering**: Exact and regex matching
- **Title pattern filtering**: Substring and regex matching
- **Platform exclusion**: Exclude entire platforms
- **Members-only filtering**: Skip members-only streams
- **Custom rules**: Flexible rule system with regex/ignore_case support
- **ChannelFilter**: Per-channel configuration with aliases

## Watched Tracking

- Tracks watched streams per screen
- Configurable cleanup interval (`watched_clear_hours`)
- Prevents replaying recently watched streams
- Marks streams as watched on normal end or soft skip

## Network Recovery

- Automatic network state monitoring
- On network restore: refreshes queues, restarts idle screens
- Configurable check interval

## Logging

- File: `logs/livelink.log` (daily rotation, 50MB max, 5 files)
- Level: Configurable via `RUST_LOG` or `logging.level`
- Debug flag: `--debug` enables trace-level MPV command logging

## Development

### Running Tests

```bash
cargo test
```

### Adding a New Platform

1. Create service in `src/services/`
2. Implement stream fetching
3. Register in orchestrator
4. Add to config

### Testing with Mock Player

```bash
cargo test mock_player_tests
```

## Troubleshooting

### MPV won't start
- Check MPV is installed: `mpv --version`
- Check IPC socket permissions
- Check `--config-dir` path exists

### No streams found
- Check API keys are configured
- Check network connectivity
- Check filter rules aren't too restrictive
- Check `auto_start: true` in screen config

### Port already in use
- Change port with `--port`
- Kill existing process: `pkill -f livelink`

### MPV crashes on exit
- Ensure `ontop: false` in mpv.json
- Check `use_locks: true` in player.json
- Check IPC socket cleanup

## License

MIT License