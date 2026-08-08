# Getting Started Guide

Quick start guide for LiveLink.

## Prerequisites

- **Rust 1.70+** - [Install Rust](https://rustup.rs/)
- **MPV Player** - `sudo apt install mpv` / `brew install mpv`
- **Optional**: Streamlink (`pip install streamlink`), VLC

## Installation

```bash
# Clone repository
git clone <repository-url>
cd LiveLink

# Build release binary
cargo build --release

# Binary at: ./target/release/livelink
```

## Configuration

### 1. Create Config Directory

```bash
mkdir -p config
```

### 2. Generate Default Configs

```bash
# Run once to generate default configs
./target/release/livelink start --config-dir ./config --port 3001
# Press Ctrl+C after "Starting API server"
```

### 3. Edit Configuration

```bash
# Edit main config
nano config/player.json

# Edit MPV settings
nano config/mpv.json

# Add API keys
nano config/config.json
```

### 4. Add API Keys

```bash
# Set environment variables (recommended)
export YOUTUBE_API_KEY=your_youtube_key
export TWITCH_CLIENT_ID=your_twitch_client_id
export TWITCH_CLIENT_SECRET=your_twitch_secret
export HOLODEX_API_KEY=your_holodex_key
```

Or edit `config/config.json`:

```json
{
  "youtube": { "api_key": "your_key" },
  "twitch": {
    "client_id": "your_id",
    "client_secret": "your_secret"
  },
  "holodex": { "api_key": "your_key" }
}
```

## Basic Setup

### Minimal Config (player.json)

```json
{
  "defaultQuality": "best",
  "defaultVolume": 0,
  "maxStreams": 2,
  "autoStart": true,
  "screens": [
    {
      "screen": 1,
      "enabled": true,
      "width": 1920,
      "height": 1080,
      "x": 1366,
      "y": 0,
      "sources": [{ "type": "youtube", "enabled": true, "priority": 1 }],
      "auto_start": true
    }
  ]
}
```

### Dual Screen Setup

```json
{
  "screens": [
    {
      "screen": 1,
      "enabled": true,
      "width": 1920,
      "height": 1080,
      "x": 1366,
      "y": 0,
      "sources": [{ "type": "youtube", "enabled": true, "priority": 1 }]
    },
    {
      "screen": 2,
      "enabled": true,
      "width": 1366,
      "height": 768,
      "x": 0,
      "y": 312,
      "sources": [{ "type": "twitch", "enabled": true, "priority": 1 }]
    }
  ]
}
```

## Running

### Development

```bash
# Debug mode with verbose logging
RUST_LOG=debug ./target/debug/livelink start --config-dir ./config --port 3001
```

### Production

```bash
# Release build
cargo build --release

# Run
./target/release/livelink start --config-dir ./config --port 3001
```

### Background Service

```bash
# With systemd (create /etc/systemd/system/livelink.service)
[Unit]
Description=LiveLink
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/LiveLink
ExecStart=/path/to/LiveLink/target/release/livelink start --config-dir ./config --port 3001
Restart=on-failure

[Install]
WantedBy=multi-user.target

# Enable and start
sudo systemctl enable livelink
sudo systemctl start livelink
```

## First Run

```bash
./target/release/livelink start --config-dir ./config --port 3001
```

Expected output:
```
LiveLink starting...
Configuration loaded
Holodex client initialized
Screen registered screen=1
Screen registered screen=2
Fetched live streams from Holodex count=11
Stream starting screen=1 url=https://www.youtube.com/watch?v=...
Auto-start loop completed
Starting API server on 0.0.0.0:3001
```

## Verify It's Working

### Check API

```bash
# Health check
curl http://localhost:3001/health

# Status
curl http://localhost:3001/status

# Streams
curl http://localhost:3001/streams
```

### Web UI (if enabled)

Open browser: `http://localhost:3001`

### Test Stream

```bash
# Add stream to queue
curl -X POST http://localhost:3001/queue/add \
  -H "Content-Type: application/json" \
  -d '{"screen": 1, "url": "https://twitch.tv/xqc"}'
```

## Adding API Keys

### YouTube API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Enable **YouTube Data API v3**
3. Create API Key
4. Set `YOUTUBE_API_KEY` env var

### Twitch

1. Go to [Twitch Dev Console](https://dev.twitch.tv/console)
2. Register Application
3. Get Client ID and Secret
4. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`

### Holodex

1. Get API key from [Holodex](https://holodex.net/)
2. Set `HOLODEX_API_KEY` env var

## Multi-Screen Layout

### Geometry Calculations

For 2 screens side-by-side:
- Screen 1: `1920x1080+1366+0` (right monitor)
- Screen 2: `1366x768+0+312` (left monitor)

Custom geometry in mpv.json:
```json
{
  "extra": {
    "geometry": "1920x1080+1366+0,1366x768+0+312"
  }
}
```

### Screen Ordering

Screens numbered 1, 2, 3... from left to right in config.

## Auto-Start on Boot

### systemd Service

```ini
# /etc/systemd/system/livelink.service
[Unit]
Description=LiveLink Multi-Screen Stream Player
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/LiveLink
ExecStart=/home/youruser/LiveLink/target/release/livelink start --config-dir ./config --port 3001
Restart=on-failure
RestartSec=10
Environment=YOUTUBE_API_KEY=your_key
Environment=TWITCH_CLIENT_ID=your_id
Environment=TWITCH_CLIENT_SECRET=your_secret
Environment=HOLODEX_API_KEY=your_key
Environment=RUST_LOG=info

[Install]
WantedBy=multi-user.target
```

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable livelink
sudo systemctl start livelink
```

## Docker (Optional)

```dockerfile
FROM rust:1.75 as builder
WORKDIR /app
COPY . .
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y mpv streamlink ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/livelink /usr/local/bin/
COPY config /config
EXPOSE 3001
CMD ["livelink", "start", "--config-dir", "/config", "--port", "3001"]
```

```bash
docker build -t livelink .
docker run -d -p 3001:3001 -v $(pwd)/config:/config livelink
```

## Next Steps

1. **Customize screens** in `config/player.json`
2. **Add favorites** in `config/favorites.json`
3. **Adjust filters** in `config/filters.json`
4. **Tune MPV** in `config/mpv.json`
5. **Set up monitoring** (health check at `/health`)
6. **Set up backups** for config directory

## Common Next Steps

1. **Add more screens** - Duplicate screen config with different sources
2. **Configure filters** - Block unwanted content
3. **Set up alerts** - Monitor `/health` endpoint
4. **Log rotation** - Configured in `logging` section
5. **Backup config** - Version control your config directory

## Useful Commands

```bash
# Check status
curl http://localhost:3001/status

# View streams
curl http://localhost:3001/streams

# Force refresh
curl -X POST http://localhost:3001/refresh

# Add to queue
curl -X POST http://localhost:3001/queue/add -H "Content-Type: application/json" -d '{"screen": 1, "url": "https://twitch.tv/xqc"}'

# Stop stream
curl -X POST http://localhost:3001/stream/stop -H "Content-Type: application/json" -d '{"screen": 1}'
```

## Support

- **Logs**: `logs/livelink.log`
- **Config**: `config/` directory
- **Issues**: GitHub Issues
- **Logs**: `tail -f logs/livelink.log`