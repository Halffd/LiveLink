# Troubleshooting Guide

Common issues and solutions for LiveLink.

## Quick Diagnostics

```bash
# Check if server is running
curl http://localhost:3001/health

# Check logs
tail -f logs/livelink.log

# Check config
cat config/player.json | jq .
```

## Common Issues

### MPV Won't Start

**Symptoms:**
- "Failed to start process" errors
- Stream shows "starting" but never plays
- MPV process exits immediately

**Diagnosis:**
```bash
# Check MPV installation
mpv --version

# Check IPC socket permissions
ls -la /tmp/livelink_mpv_ipc_*

# Test MPV directly
mpv --input-ipc-server=/tmp/test_ipc "https://www.youtube.com/watch?v=..."
```

**Solutions:**
1. **MPV not installed**: `sudo apt install mpv` / `brew install mpv`
2. **IPC permissions**: Ensure `/tmp` is writable
3. **Config dir**: Check `config_dir` in mpv.json exists
4. **Ontop issue**: Set `ontop: false` in mpv.json
4. **Lock conflicts**: Set `use_locks: true` in player.json

### No Streams Found

**Symptoms:**
- "No streams available for screen X"
- Empty queue

**Diagnosis:**
```bash
# Check API keys
echo $YOUTUBE_API_KEY
echo $TWITCH_CLIENT_ID
echo $TWITCH_CLIENT_SECRET

# Check config
cat config/player.json | jq '.screens'

# Test API directly
curl "https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&eventType=live&channelId=UC...&key=$YOUTUBE_API_KEY"
```

**Solutions:**
1. **Missing API keys**: Set `YOUTUBE_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
2. **Wrong source**: Check screen `sources` config matches available platforms
3. **Filters too strict**: Check `filters.json` - may be blocking all streams
4. **No live streams**: Some times have fewer live streams
5. **API quota exhausted**: Check quota status

### Screen 2 (or N) Not Starting

**Symptoms:**
- Screen 1 works, screen 2+ shows "No streams available"

**Causes:**
1. Screen 2 source is `twitch` but no Twitch auth
2. Screen 2 source is `youtube` but YouTube API key missing
3. Screen source config doesn't match available streams

**Fix:**
```json
// config/player.json - ensure screen 2 has valid source
{
  "screens": [
    { "screen": 1, "sources": [{ "type": "youtube", "enabled": true }] },
    { "screen": 2, "sources": [{ "type": "twitch", "enabled": true }] }
  }
}
```

### Port Already in Use

**Error:** `Os { code: 98, kind: AddrInUse, message: "Address already in use" }`

**Solutions:**
```bash
# Kill existing process
pkill -f livelink

# Or use different port
livelink start --port 8790

# Check what's using port
lsof -i :3001
```

### MPV Crashes on Exit

**Symptoms:**
- MPV process doesn't clean up
- Orphaned MPV processes
- IPC socket files left in `/tmp`

**Solutions:**
1. **Ontop issue**: Set `ontop: false` in mpv.json
2. **SIGKILL fallback**: Already implemented in v0.1.0+
3. **Config dir**: Ensure `config_dir` in mpv.json is valid
4. **Locks**: Enable `use_locks: true` in player.json

### No Audio/Video

**Symptoms:**
- MPV window opens but black screen
- Audio plays but no video (or vice versa)

**Solutions:**
1. **Hardware decoding**: Try `hwdec: "auto"` in mpv.json
2. **Video output**: Try `vo: "gpu"` in mpv.json
3. **Codecs**: Ensure ffmpeg with all codecs installed

### Stream Starts Then Immediately Stops

**Symptoms:**
- Stream plays for 1-2 seconds then stops
- "Stream skipped (members-only or unplayable)" in logs

**Causes:**
1. **Members-only stream**: Filtered by `filter_members_only: true`
2. **Geo-blocked**: Stream not available in region
3. **Age-restricted**: Requires login
4. **Unplayable format**: MPV can't decode

**Solutions:**
1. Disable `filter_members_only: false` in filters.json
2. Check stream URL manually in browser
3. Try different quality: `"quality": "720p"` in screen config

### High CPU/Memory Usage

**Symptoms:**
- High CPU when idle
- Memory grows over time

**Solutions:**
1. **Reduce refresh**: Increase `auto_refresh_interval_seconds`
2. **Limit streams**: Lower `max_streams`
3. **Disable debug**: Remove `--debug` flag
4. **Check leaks**: Restart periodically

### API Quota Exhausted

**Symptoms:**
- "YouTube API quota exhausted" in logs
- Falls back to RSS (fewer streams)

**Solutions:**
1. Wait for midnight UTC reset
2. Get higher quota from Google Cloud Console
4. Reduce refresh interval: `auto_refresh_interval_seconds: 300`
5. Reduce favorites count

### Network Issues

**Symptoms:**
- "Network error" in logs
- Streams fail to start

**Diagnosis:**
```bash
# Test connectivity
curl -I https://www.youtube.com
curl -I https://api.twitch.tv

# Check DNS
dig youtube.com
dig api.twitch.tv
```

**Solutions:**
1. Check firewall/proxy
2. Check DNS resolution
3. Try different DNS: `8.8.8.8`, `1.1.1.1`
3. Check proxy settings

### Logs Not Showing

**Symptoms:**
- No logs in `logs/livelink.log`
- Can't debug issues

**Solutions:**
1. **Check log dir**: `LIVELINK_LOG_DIR` or `log_dir` in player.json
2. **Check permissions**: Ensure write access to log directory
3. **Console output**: Run without systemd/service for direct output
4. **Log level**: Set `RUST_LOG=debug` or `logging.level: "debug"`

### Config Not Loading

**Symptoms:**
- Changes to config not reflected
- "Could not load config file" warnings

**Solutions:**
1. **Check path**: `--config-dir` points to correct directory
2. **Validate JSON**: `jq . config/player.json`
3. **Check file permissions**: Readable by livelink process
4. **Config format**: Ensure valid JSON (no trailing commas)

### MPV Config Not Applied

**Symptoms:**
- MPV ignores config_dir settings
- Window geometry wrong

**Solutions:**
1. **Expand tilde**: Use absolute path or `$HOME`
2. **Config format**: Ensure mpv.conf syntax correct
3. **Priority**: CLI args > mpv.json extra > mpv.conf > defaults

### Twitch Authentication Issues

**Symptoms:**
- "Twitch token error"
- No Twitch streams

**Solutions:**
1. **Check credentials**: Valid `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`
2. **Token refresh**: Automatic, but check logs for errors
3. **App registration**: Ensure Twitch app has correct redirect URI

### YouTube API Key Issues

**Symptoms:**
- "YouTube developer key not provided"
- RSS fallback only

**Solutions:**
1. **Set key**: `export YOUTUBE_API_KEY=...`
2. **Enable API**: YouTube Data API v3 in Google Cloud Console
3. **Quota**: Check daily quota not exhausted
4. **Restrictions**: Ensure API key not restricted incorrectly

### Holodex API Issues

**Symptoms:**
- "Holodex client initialized" but no streams
- Empty results

**Solutions:**
1. **Check API key**: `HOLODEX_API_KEY` set
2. **Rate limits**: Holodex has generous limits
3. **Organization filter**: Check `organizations` in config

### Graceful Shutdown Issues

**Symptoms:**
- Server doesn't stop on Ctrl+C
- Processes remain after stop

**Solutions:**
1. **Signal handling**: SIGTERM/SIGINT handlers implemented
2. **Force kill**: `pkill -9 -f livelink` if needed
3. **Cleanup**: IPC sockets cleaned on exit

### Performance Issues

**Symptoms:**
- High latency
- Buffering
- Frame drops

**Solutions:**
1. **Lower quality**: `"quality": "720p"` in screen config
2. **Hardware decode**: `hwdec: "auto-copy"` in mpv.json
3. **Buffer**: Increase `cache-secs` in mpv.json
4. **Network**: Use wired connection

## Debug Mode

Enable debug logging:

```bash
# Via CLI
RUST_LOG=debug ./target/debug/livelink start --config-dir ./config

# Or in config
# player.json:
{
  "logging": {
    "level": "debug"
  }
}

# Or via CLI flag
./target/debug/livelink start --debug
```

### Key Debug Logs

| Log | Meaning |
|-----|---------|
| `start_stream: acquiring lock` | Starting stream process |
| `Stream starting` | MPV launched successfully |
| `MPV subprocess exited` | Stream ended |
| `Auto-refreshing streams` | Periodic fetch |
| `API quota exhausted` | YouTube quota done |
| `Network state changed` | Network status |

## Log Analysis

```bash
# Filter for errors
grep -i error logs/livelink.log

# Filter for specific screen
grep "screen=1" logs/livelink.log

# Follow live
tail -f logs/livelink.log | grep -E "(Stream starting|Error|Warn)"
```

## Getting Help

If issues persist:

1. **Check logs**: `logs/livelink.log`
2. **Enable debug**: `--debug` or `RUST_LOG=debug`
3. **Check GitHub Issues**: Search existing issues
4. **Create Issue**: Include logs, config, steps to reproduce

## Useful Commands

```bash
# Build
cargo build --release

# Run with debug
RUST_LOG=debug ./target/debug/livelink start --config-dir ./config

# Test API
curl http://localhost:3001/health
curl http://localhost:3001/status

# Kill all
pkill -9 -f livelink

# Clean build
cargo clean && cargo build --release

# Check config
cat config/player.json | jq '.screens[] | {screen, sources, enabled}'
```