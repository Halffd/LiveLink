# YouTube API Integration Guide

Complete guide to YouTube Data API v3 integration in LiveLink.

## Overview

LiveLink provides comprehensive YouTube support through the YouTube Data API v3 with intelligent fallback to RSS feeds when API quota is exhausted.

## Features

- **Favorites**: 19 pre-configured YouTube channel IDs
- **Categories**: Fetch and browse video categories
- **Channels/Subscriptions**: Channel details API (stats, branding, thumbnails)
- **Live Streams**: Detailed info (concurrent viewers, category)
- **Categories Search**: Get live streams by YouTube category
- **Search**: Query with optional category filter
- **Fallback**: Automatic RSS fallback when API quota exhausted

## Configuration

### API Key Setup

Set your YouTube Data API v3 key:

```bash
export YOUTUBE_API_KEY=your_api_key_here
```

Or in `config/config.json`:

```json
{
  "youtube": {
    "api_key": "your_api_key_here"
  }
}
```

### Getting an API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable **YouTube Data API v3**
4. Create credentials → API Key
5. Restrict key to YouTube Data API v3
6. Copy the key

## API Quota Management

### Quota Limits

- **Daily quota**: 10,000 units
- **Search/List call**: 100 units
- **Categories call**: 1 unit
- **Channel details**: 1 unit
- **Video details**: 1 unit

### Quota Management

LiveLink automatically manages quota:

1. **Daily reset** at midnight UTC
2. **Priority order**: Favorites → Search → Categories → Channel details
3. **Automatic fallback**: Switches to RSS when quota exhausted
4. **Per-channel tracking**: Individual channel RSS fallback

### Quota Monitoring

Check quota status via API:

```bash
curl http://localhost:3001/api/youtube/quota
```

Response:
```json
{
  "remaining": 9500,
  "max": 10000,
  "reset_at": "2026-08-09T00:00:00Z"
}
```

## YouTube Service Methods

### Get Live Streams (Favorites)

```rust
let streams = youtube_service.get_live_streams(&["UC...", "UC..."]).await?;
```

Fetches live streams from favorite channels with full details.

### Get Live Streams by Category

```rust
let streams = youtube_service.get_live_streams_by_category("20", 20).await?;
// 20 = Gaming category
```

### Get Live Streams with Details

```rust
let streams = youtube_service.get_live_streams_detailed(&["UC...", "UC..."]).await?;
// Returns concurrent viewers, category, thumbnails
```

### Search Live Streams

```rust
let options = QueryOptions {
    search: Some("gaming".to_string()),
    category: Some("Gaming".to_string()),
    limit: Some(25),
    platform: Some("youtube".to_string()),
};

let streams = youtube_service.query(&options).await?;
```

### Get Categories

```rust
let categories = youtube_service.get_categories().await?;
// Returns: [{ id: "20", title: "Gaming", assignable: true }, ...]
```

### Get Channel Details

```rust
let channel = youtube_service.get_channel("UC...").await?;
// Returns: YouTubeChannel { id, title, subscriber_count, video_count, ... }
```

### Get Channel Live Streams

```rust
let streams = youtube_service.get_channel_live_streams("UC...").await?;
// All currently live streams from a specific channel
```

### Get Live Stream Details

```rust
let (viewers, category) = youtube_service.get_live_stream_details("VIDEO_ID").await?;
// Returns: (concurrent_viewers: Option<u64>, category_id: Option<String>)
```

## YouTube Data Models

### YouTubeCategory

```rust
pub struct YouTubeCategory {
    pub id: String,
    pub title: String,
    pub assignable: bool,
}
```

### YouTubeChannel

```rust
pub struct YouTubeChannel {
    pub id: String,
    pub title: String,
    pub subscriber_count: Option<u64>,
    pub video_count: Option<u64>,
    pub view_count: Option<u64>,
    pub thumbnail_url: Option<String>,
    pub description: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub custom_url: Option<String>,
}
```

### YouTubeLiveStream

```rust
pub struct YouTubeLiveStream {
    pub video_id: String,
    pub title: String,
    pub channel_id: String,
    pub channel_title: String,
    pub concurrent_viewers: Option<u64>,
    pub start_time: Option<DateTime<Utc>>,
    pub thumbnail_url: Option<String>,
    pub category_id: Option<String>,
}
```

## API Endpoints

### Get YouTube Streams

```
GET /api/youtube/streams?channel_ids=UC...,UC...
```

Returns live streams from specified channels.

### Get YouTube Categories

```
GET /api/youtube/categories
```

### Get YouTube Categories (Detailed)

```
GET /api/youtube/categories?detailed=true
```

### Search YouTube

```
POST /api/youtube/query
Content-Type: application/json

{
  "search": "gaming",
  "platform": "youtube",
  "limit": 25,
  "category": "Gaming"
}
```

### Get YouTube Channel

```
GET /api/youtube/channel/UC...
```

### Get YouTube Categories

```
GET /api/youtube/categories
```

### Get Live Streams by Category

```
GET /api/youtube/category/20?limit=20
```

## YouTube Favorites

Configure favorite channels in `config/favorites.json`:

```json
{
  "youtube": {
    "default": [
      "UC5CwaMl1eIgY8h02uZw7u8A",
      "UCxsZ6NCzjU_t4YSxQLBcM5A",
      "UC9wbdkwvYVSgKtOZ3Oov98g"
    ],
    "channels": [],
    "ids": []
  }
}
```

Channel format:
```json
{ "id": "UC...", "name": "Channel Name", "score": 1000 }
```

**Score**: Higher = higher priority. Default assigns 1000-index.

## YouTube RSS Fallback

When API quota is exhausted, LiveLink automatically falls back to RSS feeds:

```bash
# RSS feed URL format
https://www.youtube.com/feeds/videos.xml?channel_id=UC...
```

RSS detects live streams via `<yt:state value="live">` in feed.

### RSS Limitations

- No concurrent viewer count
- No category information
- No channel statistics
- Less reliable than API

## Quota Optimization Tips

1. **Use favorites**: Only check favorite channels (fewer API calls)
2. **Batch requests**: API processes channels sequentially
3. **Category search**: More efficient than per-channel calls
4. **Cache categories**: Categories cached for 24 hours
5. **Monitor quota**: Check status regularly

## Rate Limiting

YouTube API limits:
- **10,000 units/day** default
- **100 units/search**
- **1 unit/channel**
- **1 unit/video**

LiveLink automatically:
- Resets quota at midnight UTC
- Tracks remaining quota
- Falls back to RSS when exhausted
- Prioritizes favorites

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Config("YouTube API not available")` | No API key | Set `YOUTUBE_API_KEY` |
| `Config("YouTube API not available or quota exhausted")` | Quota exhausted | Wait for reset or use RSS |
| `Api("Channel not found")` | Invalid channel ID | Verify channel ID |
| `Network("Request timeout")` | Connection issue | Check network/firewall |

### Error Responses

```json
{
  "success": false,
  "error": "YouTube API not available"
}
```

## Testing

### Test YouTube Service

```bash
# Test with API key
YOUTUBE_API_KEY=your_key cargo test youtube::tests

# Test without API key (RSS fallback)
cargo test youtube::tests::test_rss_fallback
```

### Unit Tests

```rust
#[tokio::test]
async fn test_get_categories() {
    let mut service = YouTubeService::new("test_key".to_string());
    let categories = service.get_categories().await;
    assert!(categories.is_ok());
}
```

## Troubleshooting

### No Streams Found

1. Check API key is valid
2. Verify channel IDs are correct
3. Check if channels are actually live
4. Check API quota not exhausted

### API Quota Exhausted

```bash
# Check quota status
curl http://localhost:3001/api/youtube/quota

# Wait for midnight UTC reset
# Or use RSS fallback (automatic)
```

### Invalid Channel ID

```bash
# Test channel directly
curl "https://www.googleapis.com/youtube/v3/channels?part=snippet&id=UC...&key=YOUR_KEY"
```

### Rate Limited

- YouTube returns 429 status
- LiveLink automatically backs off
- Wait for quota reset

## Best Practices

1. **Set API key** in environment, not config files
2. **Use favorites** for priority channels
3. **Monitor quota** via health endpoint
3. **Use categories** for broad searches
4. **Enable RSS fallback** for reliability
5. **Monitor logs** for quota warnings

## Changelog

### v0.1.0
- Initial YouTube API integration
- RSS fallback
- Channel details
- Category support
- Search with category filter

### v0.2.0
- Detailed live stream info
- Concurrent viewers
- Category-based search
- Channel details API
- Category caching