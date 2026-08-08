# API Reference

Complete API documentation for LiveLink HTTP API.

## Base URL

```
http://localhost:3001
```

Configurable via `--port` CLI argument.

## Authentication

Currently no authentication required. All endpoints are public.

## Response Format

All responses are JSON:

```json
{
  "success": true,
  "data": {},
  "error": null
}
```

Errors:
```json
{
  "success": false,
  "data": null,
  "error": "Error message"
}
```

## Endpoints

### Health Check

```
GET /health
```

Returns service health status.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-08-08T01:23:45.123Z"
}
```

---

### Server Status

```
GET /status
```

Returns overall server status including screen states and active stream count.

**Response:**
```json
{
  "screens": {
    "1": { "running": true, "pid": 12345, "url": "https://..." },
    "2": { "running": false, "enabled": true }
  },
  "activeCount": 1,
  "cached": {
    "youtube": 11,
    "twitch": 0,
    "direct": 0
  },
  "watchedCount": 5,
  "uptime": 3600.5,
  "timestamp": "2026-08-08T01:23:45.123Z"
}
```

---

### All Cached Streams

```
GET /streams
```

Returns all cached streams grouped by platform.

**Response:**
```json
{
  "youtube": [
    {
      "url": "https://www.youtube.com/watch?v=...",
      "title": "Stream Title",
      "platform": "youtube",
      "channel_id": "UC...",
      "channel": "Channel Name",
      "viewer_count": 1234,
      "is_live": true
    }
  ],
  "twitch": [],
  "holodex": [],
  "kick": [],
  "niconico": [],
  "bilibili": [],
  "facebook": []
}
```

---

### Favorites

```
GET /favorites
```

Returns favorite channels grouped by platform.

**Response:**
```json
{
  "twitch": ["channel1", "channel2"],
  "youtube": ["UC...", "UC..."],
  "holodex": [],
  "kick": [],
  "niconico": [],
  "bilibili": [],
  "facebook": []
}
```

---

### Watched History

```
GET /watched
```

Returns watched streams across all screens.

**Response:**
```json
{
  "watched": [
    { "screen": 1, "url": "https://...", "title": "Stream Title" }
  ],
  "count": 5
}
```

---

### Organizations

```
GET /organizations
```

Returns organizations from Holodex favorites.

**Response:**
```json
["Hololive", "Nijisanji", "VShojo", "Phase Connect", "Independents"]
```

---

### Filters

```
GET /filters
```

Returns current filter configuration.

**Response:**
```json
{
  "enabled": true,
  "mode": "blacklist",
  "channel_names": ["channel1"],
  "title_patterns": ["membership", "members only"],
  "exclude_platforms": [],
  "filter_members_only": true
}
```

---

### Screens

```
GET /screens
```

Returns screen configurations and current states.

**Response:**
```json
{
  "screens": [
    {
      "screen": 1,
      "enabled": true,
      "state": "Playing",
      "sources": ["youtube"]
    }
  ]
}
```

---

### Health Check

```
GET /health
```

Simple health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-08-08T01:23:45.123Z"
}
```

---

### Stream Operations

#### Start Stream

```
POST /stream/start
Content-Type: application/json

{
  "screen": 1
}
```

Starts next stream in queue for specified screen.

**Response:**
```json
{ "success": true, "screen": 1 }
```

#### Stop Stream

```
POST /stream/stop
Content-Type: application/json

{
  "screen": 1
}
```

Stops current stream on specified screen.

**Response:**
```json
{ "success": true, "screen": 1 }
```

#### Stop All Streams

```
POST /stream/stop-all
```

Stops all active streams.

**Response:**
```json
{ "success": true }
```

---

### Queue Operations

#### Add to Queue

```
POST /queue/add
Content-Type: application/json

{
  "screen": 1,
  "url": "https://twitch.tv/xqc",
  "title": "XQC"
}
```

Adds URL to screen's queue.

**Response:**
```json
{ "success": true }
```

#### Clear Queue

```
POST /queue/clear
Content-Type: application/json

{
  "screen": 1
}
```

Clears queue for specified screen.

**Response:**
```json
{ "success": true }
```

#### Clear Watched from Queue

```
POST /queue/clear-watched
Content-Type: application/json

{
  "screen": 1,
  "url": "https://..."
}
```

Clears watched status for specific URL in queue.

**Response:**
```json
{ "success": true }
```

#### Get Queues

```
GET /queues
```

Returns queue information for all screens.

**Response:**
```json
{
  "queues": [
    { "screen": 1, "count": 5, "watched_count": 2 },
    { "screen": 2, "count": 0, "watched_count": 0 }
  ]
}
```

---

### Watched History

#### Clear Watched

```
POST /watched/clear
Content-Type: application/json

{
  "screen": 1
}
```

Clears watched history for specific screen (or all if omitted).

**Response:**
```json
{
  "success": true,
  "message": "Cleared watched history for screen 1"
}
```

Or all:
```json
{
  "success": true,
  "message": "Cleared all watched history"
}
```

---

### Refresh

```
POST /refresh
```

Forces refresh of all queues.

**Response:**
```json
{ "success": true }
```

---

### Save Config

```
POST /save
```

Saves current configuration to disk.

**Response:**
```json
{ "success": true }
```

---

### Screen Control

#### Enable Screen

```
POST /screen/enable
Content-Type: application/json

{
  "screen": 1
}
```

Enables screen and starts stream.

**Response:**
```json
{ "success": true, "enabled": true }
```

#### Disable Screen

```
POST /screen/disable
Content-Type: application/json

{
  "screen": 1
}
```

Disables screen and stops stream.

**Response:**
```json
{ "success": true, "enabled": false }
```

#### Toggle Screen

```
POST /screen/toggle
Content-Type: application/json

{
  "screen": 1
}
```

Toggles screen enabled state.

**Response:**
```json
{ "success": true, "enabled": false }
```

---

### Query Streams

```
POST /query
Content-Type: application/json

{
  "search": "gaming",
  "platform": "twitch",
  "limit": 10,
  "category": "Gaming"
}
```

Searches for live streams.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `search` | string | No | Search query |
| `platform` | string | No | Platform filter (youtube, twitch, holodex, etc.) |
| `limit` | integer | No | Max results (default: 25, max: 50) |
| `category` | string | No | YouTube category filter |

**Response:**
```json
{
  "success": true,
  "count": 10,
  "results": [
    {
      "url": "https://twitch.tv/...",
      "title": "Stream Title",
      "platform": "twitch",
      "channel": "channel_name",
      "viewer_count": 1234
    }
  ]
}
```

---

## Error Codes

| Code | Description |
|------|-------------|
| 400 | Bad Request - Invalid parameters |
| 404 | Not Found |
| 500 | Internal Server Error |

Error response format:
```json
{
  "success": false,
  "error": "Error description"
}
```

## Rate Limiting

No rate limiting currently implemented. API is intended for local/private use.

## WebSocket Support

Not currently implemented. Use polling or Server-Sent Events for real-time updates.

## Example Usage

### Start a Stream

```bash
curl -X POST http://localhost:3001/stream/start \
  -H "Content-Type: application/json" \
  -d '{"screen": 1}'
```

### Add to Queue

```bash
curl -X POST http://localhost:3001/queue/add \
  -H "Content-Type: application/json" \
  -d '{"screen": 1, "url": "https://twitch.tv/xqc", "title": "XQC"}'
```

### Query Streams

```bash
curl -X POST http://localhost:3001/query \
  -H "Content-Type: application/json" \
  -d '{"search": "gaming", "platform": "twitch", "limit": 10}'
```

### Get Status

```bash
curl http://localhost:3001/status
```

### Toggle Screen

```bash
curl -X POST http://localhost:3001/screen/toggle \
  -H "Content-Type: application/json" \
  -d '{"screen": 1}'
```