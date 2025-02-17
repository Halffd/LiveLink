import { type MpvConfig, type StreamlinkConfig } from '../types/player.js';

export const defaultMpvConfig: MpvConfig = {
  // Video Output & Hardware Acceleration
  vo: 'gpu',
  hwdec: 'auto-copy-safe',
  'gpu-api': 'x11',
  'gpu-context': 'x11',
  'hwdec-codecs': 'all',
  
  // Process Priority
  priority: 'high',
  
  // Video Quality & Processing
  deband: false,
  'deband-iterations': 1,
  'deband-threshold': 64,
  'deband-range': 16,
  'deband-grain': 48,
  'temporal-dither': false,
  'dither-depth': 'auto',
  'correct-downscaling': false,
  'linear-downscaling': false,
  'sigmoid-upscaling': false,
  
  // Scaling Options
  scale: 'bilinear',
  cscale: 'bilinear',
  dscale: 'bilinear',
  'scale-antiring': 0.0,
  'cscale-antiring': 0.0,
  
  // Performance & Sync
  'video-sync': 'display-resample',
  interpolation: false,
  tscale: 'oversample',
  'video-sync-max-factor': 5,
  'video-sync-adrop-size': 0.05,
  framedrop: 'vo',
  
  // Cache & Network
  cache: true,
  'cache-secs': 60,
  'demuxer-max-bytes': '800M',
  'demuxer-max-back-bytes': '200M',
  'network-timeout': 60,
  'stream-buffer-size': '64M',
  
  // Window Behavior
  'keep-open': true,
  'force-window': true,
  ontop: false,
  border: true,
  'cursor-autohide': 1,
  
  // Audio
  'audio-channels': 'auto-safe',
  'audio-pitch-correction': true,
  'audio-fallback-to-null': true,
  'audio-buffer': 0.2,
  'audio-normalize-downmix': false,
  
  // OSD & UI
  'osd-level': 1,
  'osd-duration': 1000,
  'osd-font': 'sans-serif',
  'osd-font-size': 32,
  'osd-color': '#CCFFFFFF',
  'osd-border-color': '#DD322640',
  
  // Debug & Logging
  'msg-level': 'all=v',
  
  // YouTube-DL
  'ytdl-format': 'bestvideo[height<=?1080]+bestaudio/best',
  'ytdl-raw-options': 'ignore-errors=,quiet=,no-warnings=,retries=10',
  
  // Screenshots
  'screenshot-format': 'png',
  'screenshot-png-compression': 7,
  'screenshot-template': '%F-%P-%n'
};

export const defaultStreamlinkConfig: StreamlinkConfig = {
  // Stream Quality & Selection
  default_quality: 'best',
  stream_sorting_excludes: '>1080p,<480p',
  default_stream: ['1080p', '720p', 'best'],
  
  // Timeouts & Retries
  stream_timeout: 60,
  hls_timeout: 60,
  hls_live_edge: 3,
  hls_playlist_reload_time: 1,
  retry_max: 10,
  retry_streams: 3,
  retry_open: 3,
  
  // Stream Optimization
  prefer_cdn: true,
  disable_ads: true,
  low_latency: false,
  
  // Buffer & Performance
  ringbuffer_size: '32M',
  stream_segment_threads: 2,
  stream_segment_attempts: 5,
  stream_segment_timeout: 10,
  
  // Platform Specific
  twitch_disable_hosting: true,
  twitch_disable_ads: true,
  twitch_low_latency: false,
  
  // HTTP Settings
  http_header: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9'
  },
  
  // Logging & Debug
  loglevel: 'debug'
}; 