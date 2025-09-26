export interface LayerConfig {
  zIndex: number;
  opacity: number;
  visible: boolean;
  blendMode: 'normal' | 'multiply' | 'screen' | 'overlay';
}

export interface MPVConfig {
  // Core settings
  priority?: string;
  vo?: string;
  hwdec?: string;
  'gpu-api'?: string;
  
  // Video settings
  'video-sync'?: string;
  interpolation?: boolean;
  tscale?: string;
  
  // Audio settings
  'audio-device'?: string;
  'audio-channels'?: string;
  
  // Performance settings
  'gpu-dumb-mode'?: boolean;
  'vd-lavc-threads'?: number;
  
  // OSD settings
  'osd-level'?: number;
  'osd-duration'?: number;
  
  // Other settings
  'keep-open'?: boolean;
  'force-window'?: boolean;
  'cursor-autohide'?: number;
  'input-default-bindings'?: boolean;
  osc?: boolean;
}

export interface StreamlinkConfig {
  // Core settings
  player?: string;
  'player-args'?: string;
  'default-stream'?: string[];
  'stream-sorting-excludes'?: string;
  
  // Stream settings
  'retry-open'?: number;
  'retry-streams'?: number;
  'retry-max'?: number;
  'stream-timeout'?: number;
  
  // Buffer settings
  'ringbuffer-size'?: string;
  'stream-segment-threads'?: number;
  'stream-segment-attempts'?: number;
  'stream-segment-timeout'?: number;
  
  // Platform-specific settings
  'twitch-disable-hosting'?: boolean;
  'twitch-disable-ads'?: boolean;
  
  // HTTP settings
  'http-header'?: Record<string, string>;
  'http-proxy'?: string;
  'https-proxy'?: string;
}

export interface StreamConfig {
  enabled: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
  volume: number;
  quality: string;
  windowMaximized: boolean;
  layer?: LayerConfig;
}

export interface PlayerSettings {
  preferStreamlink: boolean;
  defaultQuality: string;
  defaultVolume: number;
  windowMaximized: boolean;
  maxStreams: number;
  autoStart: boolean;
  mpv?: MPVConfig;
  streamlink?: StreamlinkConfig;
}

export interface Config {
  player: PlayerSettings & {
    screens: StreamConfig[];
  };
  sorting?: {
    fields: Array<{ 
      field: string;
      order: 'asc' | 'desc';
      ignore?: string | string[];
    }>;
  };
} 