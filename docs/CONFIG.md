# Configuration Reference

Complete reference for all configuration files.

## File Overview

| File | Purpose |
|------|---------|
| `config.json` | Main configuration (API keys, paths, global settings) |
| `player.json` | Player settings, screens, sources, filters, favorites |
| `mpv.json` | MPV player options |
| `streamlink.json` | Streamlink settings and MPV overrides |
| `vlc.json` | VLC player settings |
| `filters.json` | Stream filtering rules |
| `favorites.json` | Favorite channels per platform |
| `streams.json` | Stream source configurations |

## config.json

```json
{
  "holodex": {
    "api_key": "your_holodex_api_key"
  },
  "twitch": {
    "client_id": "your_twitch_client_id",
    "client_secret": "your_twitch_client_secret"
  },
  "youtube": {
    "api_key": "your_youtube_api_key"
  },
  "streamlink": {
    "path": "streamlink"
  },
  "mpv": {
    "ipc_dir": "/tmp",
    "gpu_context": "auto",
    "priority": "normal"
  },
  "player": {
    "defaultQuality": "best",
    "defaultVolume": 50,
    "maxStreams": 4,
    "autoStart": true
  },
  "player_type": "mpv",
  "default_volume": 50,
  "default_quality": "best",
  "window_maximized": false,
  "debug": false,
  "mpv_debug": false,
  "player_debug": false,
  "log_level": "info",
  "log_file": "livelink.log",
  "log_dir": "logs",
  "screens": [],
  "filters": {}
}
```

## player.json

Complete player configuration with screens, sources, and filters.

### Top-level Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `defaultQuality` | string | "best" | Default stream quality |
| `defaultVolume` | integer | 50 | Default volume (0-100) |
| `windowMaximized` | boolean | true | Start windows maximized |
| `maxStreams` | integer | 4 | Maximum concurrent streams |
| `autoStart` | boolean | true | Auto-start enabled screens |
| `auto_refresh_interval_seconds` | integer | 60 | Auto-refresh interval |
| `watched_clear_hours` | integer | 10 | Watched history cleanup interval |
| `force_player` | boolean | false | Force specific player |
| `disableHeartbeat` | boolean | true | Disable heartbeat |
| `use_locks` | boolean | true | Enable screen locks |
| `mpv_config_dir` | string | null | MPV config directory |
| `logging` | object | - | Logging configuration |

### Screen Configuration

```json
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
```

### Screen Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | integer | - | Internal ID |
| `screen` | integer | - | Screen number (1-based) |
| `enabled` | boolean | true | Whether screen is active |
| `width` | integer | 1920 | Window width |
| `height` | integer | 1080 | Window height |
| `x` | integer | 0 | X position |
| `y` | integer | 0 | Y position |
| `volume` | integer | 50 | Initial volume (0-100) |
| `quality` | string | "best" | Stream quality |
| `windowMaximized` | boolean | false | Start maximized |
| `playerType` | string | "both" | Player type |
| `primary` | boolean | false | Primary screen |
| `sources` | array | [] | Enabled sources with priority |
| `sorting` | object | null | Sort rules for queue |
| `refresh` | integer | 300 | Refresh interval (seconds) |
| `auto_start` | boolean | true | Auto-start on launch |
| `skip_watched_streams` | boolean | false | Skip watched streams |

### Source Configuration

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
| `type` | string | Platform (youtube, twitch, holodex, kick, niconico, bilibili, facebook) |
| `enabled` | boolean | Whether this source is active |
| `priority` | integer | Lower = higher priority |
| `limit` | integer | Max streams from this source |
| `name` | string | Display name |
| `tags` | array | Tags for filtering |

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

| Field | Values | Description |
|-------|--------|-------------|
| `field` | viewerCount/viewers, priority, name/title, isLive/live, platform | Sort key |
| `order` | asc, desc | Sort direction |

Applied in reverse order (last rule = primary sort).

### Filters Configuration

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

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Enable/disable filtering |
| `mode` | string | "blacklist" | "blacklist" or "whitelist" |
| `filter_members_only` | boolean | true | Exclude members-only streams |
| `channel_names` | array | [] | Exact channel name matches |
| `channel_names_regex` | array | [] | Regex patterns for channel names |
| `title_patterns` | array | [] | Substring matches for titles |
| `title_patterns_regex` | array | [] | Regex patterns for titles |
| `channels` | array | [] | ChannelFilter objects |
| `rules` | array | [] | FilterRule objects |
| `exclude_platforms` | array | [] | Platforms to exclude |

### FilterRule

```json
{
  "type": "channel",
  "pattern": "pattern",
  "regex": false,
  "ignore_case": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | "channel" or "title" (or null for both) |
| `pattern` | string | Pattern to match |
| `regex` | boolean | Treat pattern as regex |
| `ignore_case` | boolean | Case-insensitive matching |

### ChannelFilter

```json
{
  "name": "Channel Name",
  "english_name": "English Name",
  "aliases": ["alias1", "alias2"],
  "exclude_titles": ["title1", "title2"],
  "exclude_titles_regex": ["regex1", "regex2"]
}
```

## mpv.json

Global MPV options.

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

### Key MPV Options

| Option | Values | Description |
|--------|--------|-------------|
| `path` | string | MPV binary path |
| `priority` | idle, below_normal, normal, above_normal, high, realtime | Process priority |
| `gpu-context` | auto, wayland, x11, cocoa, etc. | GPU backend (auto-detected) |
| `volume` | 0-100 | Initial volume |
| `border` | bool | Window border |
| `fullscreen` | bool | Start fullscreen |
| `ontop` | bool | Keep window on top |
| `pause` | bool | Start paused |
| `mute` | bool | Start muted |
| `loop` | null, "inf", "no", "force" | Loop behavior |
| `speed` | float | Playback speed (1.0 = normal) |
| `keep-open` | bool | Keep window open after playback |
| `extra` | object | Additional mpv options (passthrough) |

**Note:** `gpu-context` is auto-detected (wayland/x11). Per-screen geometry from player.json screens config is applied separately and overrides any geometry in mpv.json.

## streamlink.json

Streamlink settings and MPV overrides.

```json
{
  "path": "streamlink",
  "options": {
    "twitch-disable-hosting": true,
    "twitch-disable-ads": true,
    "stream-timeout": 60,
    "hls-live-edge": 3
  },
  "http_header": {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept-Language": "en-US,en;q=0.9"
  },
  "mpv": {
    "vo": "gpu",
    "hwdec": "auto"
  },
  "args": ["--low-latency"]
}
```

**Structure:**
- `path`: Path to streamlink executable
- `options`: Streamlink configuration options
- `http_header`: HTTP headers for requests
- `mpv`: MPV-specific settings when launched by streamlink (merged with mpv.json)
- `args`: Additional CLI arguments for streamlink

## favorites.json

Per-platform favorite channels.

```json
{
  "holodex": { "default": [], "channels": [], "ids": [] },
  "twitch": {
    "default": ["channel1", "channel2"],
    "channels": [],
    "ids": []
  },
  "youtube": {
    "default": ["UC...", "UC..."],
    "channels": [],
    "ids": []
  },
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

## filters.json

See [Filters Configuration](#filters-configuration) above.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOLODEX_API_KEY` | Holodex API key | - |
| `TWITCH_CLIENT_ID` | Twitch client ID | - |
| `TWITCH_CLIENT_SECRET` | Twitch client secret | - |
| `YOUTUBE_API_KEY` | YouTube API key (optional, RSS fallback used if missing) | - |
| `PORT` | API server port | 3001 |
| `LIVELINK_LOG_DIR` | Log directory | logs/ |
| `RUST_LOG` | Log level filter | info |

## Logging Configuration

```json
{
  "enabled": true,
  "level": "info",
  "maxSizeMB": 50,
  "maxFiles": 5
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | true | Enable file logging |
| `level` | string | "info" | Log level (trace, debug, info, warn, error) |
| `maxSizeMB` | integer | 50 | Max log file size in MB |
| `maxFiles` | integer | 5 | Max rotated files to keep |

## CLI Arguments

```bash
livelink start [OPTIONS]

Options:
  --port <PORT>              API server port (default: 3001)
  --screens <SCREENS>        Comma-separated screen numbers (e.g., "1,2")
  --instances <INSTANCES>    Comma-separated instance IDs
  --mpv-config <DIR>         MPV config directory
  --geometry <GEOMETRY>      Screen geometry (WxH+X+Y,...)
  --streamlink <PATH>        Streamlink path
  --no-express               Disable HTTP server
  --refresh-interval <SEC>   Auto-refresh interval
  --max-streams <N>          Maximum concurrent streams
  --config-dir <DIR>         Config directory (default: ./config)
  --debug                    Enable debug logging
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HOLODEX_API_KEY` | Holodex API key | - |
| `TWITCH_CLIENT_ID` | Twitch client ID | - |
| `TWITCH_CLIENT_SECRET` | Twitch client secret | - |
| `YOUTUBE_API_KEY` | YouTube API key | - |
| `PORT` | Server port | 3001 |
| `LIVELINK_LOG_DIR` | Log directory | logs/ |
| `RUST_LOG` | Log level filter | info |

## Default Config Files

If config files don't exist, defaults are generated. Run once to generate:

```bash
livelink start --config-dir ./config
# Edit generated files as needed
```