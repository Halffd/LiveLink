import { z } from 'zod';

// Make schemas accept any string key with any value
export const MpvConfigSchema = z.record(z.any()).default({
  // Video Output & Hardware Acceleration
  vo: 'gpu',
  hwdec: 'auto-copy-safe',
  'gpu-api': 'x11',
  'gpu-context': 'x11',
  'gpu-hwdec-interop': z.string().optional(),
  'hwdec-codecs': z.string().default('all'),
  
  // Process Priority
  priority: 'high',
  
  // Video Quality & Processing
  'deband': z.boolean().default(false),
  'deband-iterations': z.number().default(1),
  'deband-threshold': z.number().default(64),
  'deband-range': z.number().default(16),
  'deband-grain': z.number().default(48),
  'temporal-dither': z.boolean().default(false),
  'dither-depth': z.string().default('auto'),
  'correct-downscaling': z.boolean().default(false),
  'linear-downscaling': z.boolean().default(false),
  'sigmoid-upscaling': z.boolean().default(false),
  
  // Scaling Options
  'scale': z.string().default('bilinear'),
  'cscale': z.string().default('bilinear'),
  'dscale': z.string().default('bilinear'),
  'scale-antiring': z.number().default(0.0),
  'cscale-antiring': z.number().default(0.0),
  'scale-radius': z.number().optional(),
  'scale-blur': z.number().optional(),
  'scale-clamp': z.number().optional(),
  
  // Performance & Sync
  'video-sync': z.string().default('display-resample'),
  'interpolation': z.boolean().default(false),
  'tscale': z.string().default('oversample'),
  'video-sync-max-factor': z.number().default(5),
  'video-sync-adrop-size': z.number().default(0.05),
  'framedrop': z.string().default('vo'),
  
  // Cache & Network
  'cache': z.boolean().default(true),
  'cache-secs': z.number().default(60),
  'demuxer-max-bytes': z.string().default('800M'),
  'demuxer-max-back-bytes': z.string().default('200M'),
  'network-timeout': z.number().default(60),
  'stream-buffer-size': z.string().default('64M'),
  
  // Window Behavior (non-geometry related)
  'keep-open': true,
  'force-window': true,
  'ontop': z.boolean().default(false),
  'border': z.boolean().default(true),
  'cursor-autohide': z.number().default(1),
  
  // Audio
  'audio-channels': z.string().default('auto-safe'),
  'audio-pitch-correction': z.boolean().default(true),
  'audio-fallback-to-null': z.boolean().default(true),
  'audio-buffer': z.number().default(0.2),
  'audio-device': z.string().optional(),
  'audio-normalize-downmix': z.boolean().default(false),
  
  // OSD & UI
  'osd-level': z.number().default(1),
  'osd-duration': z.number().default(1000),
  'osd-font': z.string().default('sans-serif'),
  'osd-font-size': z.number().default(32),
  'osd-color': z.string().default('#CCFFFFFF'),
  'osd-border-color': z.string().default('#DD322640'),
  
  // Debug & Logging
  'msg-level': 'all=v',
  'log-file': z.string().optional(),
  
  // YouTube-DL
  'ytdl-format': z.string().default('bestvideo[height<=?1080]+bestaudio/best'),
  'ytdl-raw-options': z.string().default('ignore-errors=,quiet=,no-warnings=,retries=10'),
  
  // Screenshots
  'screenshot-format': z.string().default('png'),
  'screenshot-png-compression': z.number().default(7),
  'screenshot-directory': z.string().optional(),
  'screenshot-template': z.string().default('%F-%P-%n')
});

export const StreamlinkConfigSchema = z.record(z.any()).default({
  // Stream Quality & Selection
  default_quality: 'best',
  stream_sorting_excludes: z.string().default('>1080p,<480p'),
  default_stream: z.array(z.string()).default(['1080p', '720p', 'best']),
  
  // Timeouts & Retries
  stream_timeout: 60,
  hls_timeout: 60,
  hls_live_edge: z.number().default(3),
  hls_playlist_reload_time: z.number().default(1),
  retry_max: 10,
  retry_streams: 3,
  retry_open: z.number().default(3),
  
  // Stream Optimization
  prefer_cdn: true,
  disable_ads: true,
  low_latency: false,
  
  // Buffer & Performance
  ringbuffer_size: z.string().default('32M'),
  stream_segment_threads: z.number().default(2),
  stream_segment_attempts: z.number().default(5),
  stream_segment_timeout: z.number().default(10),
  
  // Platform Specific
  twitch_disable_hosting: z.boolean().default(true),
  twitch_disable_ads: z.boolean().default(true),
  twitch_low_latency: z.boolean().default(false),
  
  // HTTP Settings
  http_header: z.record(z.string()).default({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
  }),
  
  // Logging & Debug
  loglevel: z.string().default('debug'),
  logfile: z.string().optional()
}); 