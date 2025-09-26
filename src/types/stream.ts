import type { HelixStream } from '@twurple/api';
import type { Video, Channel } from 'holodex.js';
import type { StreamOutput, StreamError as StreamInstanceError } from './stream_instance.js';
import type { ChildProcess } from 'child_process';

export interface WorkerStreamOptions {
  url: string;
  screen: number;
  quality?: string;
  windowMaximized?: boolean;
  volume?: number;
  streamId: number;
}

export type WorkerMessage = 
  | { type: 'start'; data: WorkerStreamOptions }
  | { type: 'stop'; data: number }
  | { type: 'setVolume'; data: { streamId: number; volume: number } }
  | { type: 'setQuality'; data: { streamId: number; quality: string } };

export type WorkerResponse = 
  | { type: 'startResult'; data: StreamResponse }
  | { type: 'stopResult'; data: boolean }
  | { type: 'error'; error: string }
  | { type: 'output'; data: StreamOutput }
  | { type: 'streamError'; data: StreamInstanceError };

export type StreamSourceStatus = 'live' | 'upcoming' | 'ended';
export type PlayerStatus = 'playing' | 'paused' | 'stopped' | 'error';

/**
 * Represents a stream source from various platforms
 */
export interface StreamSource {
  /** Unique identifier for the stream */
  id?: string | number;
  /** URL of the stream */
  url: string;
  /** Title of the stream */
  title?: string;
  /** Platform the stream is from (twitch, youtube, etc.) */
  platform?: 'youtube' | 'twitch';
  /** Current viewer count */
  viewerCount?: number;
  /** Thumbnail URL */
  thumbnail?: string;
  /** Channel name */
  channel?: string;
  /** Channel ID */
  channelId?: string;
  /** Status of the stream at source (live, upcoming, etc.) */
  sourceStatus?: 'live' | 'upcoming' | 'ended' | 'offline';
  /** Start time of the stream */
  startTime?: number;
  /** End time of the stream */
  endTime?: string;
  /** Duration of the stream in seconds */
  duration?: number;
  /** Priority of the stream (lower number = higher priority) */
  priority?: number;
  /** Tags associated with the stream */
  tags?: string[];
  /** Screen number this stream is assigned to */
  screen?: number;
  /** Organization the stream belongs to */
  organization?: string;
  /** Source subtype (favorites, organization, etc.) */
  subtype?: string;
  /** Quality setting of the stream */
  quality?: string;
  /** Volume level (0-100) */
  volume?: number;
  /** Current playback status */
  status?: string;
  /** Score of the stream */
  score?: number;
}

/**
 * Represents an active stream with additional runtime information
 */
export interface Stream extends StreamSource {
  /** Screen number this stream is playing on */
  screen: number;
  /** Quality setting of the stream */
  quality: string;
  /** Current volume level (0-100) */
  volume: number;
  /** Current playback status */
  status?: 'playing' | 'paused' | 'buffering' | 'stopped' | 'error';
  /** Current playback position in seconds */
  position?: number;
  /** Error message if status is 'error' */
  error?: string;
  /** Queue of upcoming streams for this screen */
  queue?: StreamSource[];
  /** Process ID of the player process */
  pid?: number;
  /** Player process */
  process: ChildProcess | null;
  /** Player status */
  playerStatus: PlayerStatus;
}

/**
 * Configuration for a stream screen
 */
export interface ScreenConfig {
  /** Screen identifier */
  screen: number;
  /** Screen ID */
  id: number;
  /** Whether this screen is enabled */
  enabled: boolean;
  /** Whether to skip streams that have been watched */
  skipWatchedStreams?: boolean;
  /** Default volume level (0-100) */
  volume: number;
  /** Default quality setting */
  quality: string;
  /** Whether the window should be maximized */
  windowMaximized: boolean;
  /** Player type to use for this screen (streamlink or mpv) */
  playerType?: 'streamlink' | 'mpv' | 'both';
  /** X position of the window */
  windowX?: number;
  /** Y position of the window */
  windowY?: number;
  /** Width of the window */
  windowWidth?: number;
  /** Height of the window */
  windowHeight?: number;
  /** Width of the screen */
  width?: number;
  /** Height of the screen */
  height?: number;
  /** X position of the screen */
  x?: number;
  /** Y position of the screen */
  y?: number;
  /** Whether this is the primary screen */
  primary?: boolean;
  /** Stream sources for this screen */
  sources?: Array<{
    /** Source type (holodex, twitch, youtube) */
    type: string;
    /** Source subtype (favorites, organization, etc.) */
    subtype?: string;
    /** Whether this source is enabled */
    enabled: boolean;
    /** Priority of this source (lower number = higher priority) */
    priority?: number;
    /** Maximum number of streams to fetch */
    limit?: number;
    /** Name of the organization (for holodex) */
    name?: string;
    /** Tags to filter by */
    tags?: string[];
  }>;
  /** Sorting configuration */
  sorting?: {
    /** Field to sort by */
    field: string;
    /** Sort order */
    order: 'asc' | 'desc';
  };
  /** Refresh interval in seconds */
  refresh?: number;
  /** Whether to auto-start streams on this screen */
  autoStart?: boolean;
  /** Additional screen-specific settings */
  [key: string]: unknown;
}

/**
 * Global player settings
 */
export interface PlayerSettings {
  /** Default volume level (0-100) */
  defaultVolume: number;
  /** Default quality setting */
  defaultQuality: string;
  /** Process priority for the player */
  processPriority: 'normal' | 'high' | 'realtime' | 'above_normal' | 'below_normal' | 'low' | 'idle';
  /** Window mode for the player */
  windowMode: 'windowed' | 'fullscreen' | 'borderless';
  /** Whether to prefer streamlink over direct playback */
  preferStreamlink: boolean;
  /** Whether to maximize the window by default */
  windowMaximized: boolean;
  /** Maximum number of concurrent streams */
  maxStreams: number;
  /** Whether to auto-start streams on startup */
  autoStart: boolean;
  /** Whether to force player to always be running for each enabled screen */
  force_player: boolean;
}

/**
 * Options for starting a stream
 */
export interface StreamOptions {
  /** URL of the stream to play */
  url: string;
  /** Screen number to play on */
  screen?: number;
  /** Quality setting */
  quality?: string;
  /** Volume level (0-100) */
  volume?: number;
  /** Whether to maximize the window */
  windowMaximized?: boolean;
  /** Additional player arguments */
  playerArgs?: string[];
  /** Title of the stream */
  title?: string;
  /** Current viewer count */
  viewerCount?: number;
  /** Start time of the stream */
  startTime?: string | number;
  /** Whether this is a retry attempt */
  isRetry?: boolean;
  /** Whether this stream is live */
  isLive?: boolean;
  /** Whether this stream has been watched before */
  isWatched?: boolean;
}

/**
 * Response from stream operations
 */
export interface StreamResponse {
  /** Screen number the operation was performed on */
  screen: number;
  /** Success or error message */
  message?: string;
  /** Whether the operation was successful */
  success: boolean;
  /** Error details if operation failed */
  error?: string;
}

export interface FavoriteChannel {
  id: string;
  name: string;
  score: number;
}

/**
 * Simplified favorite channels configuration
 */
export interface FavoriteChannels {
  groups?: {
    [groupName: string]: {
      description: string;
      priority: number;
    };
  };
  holodex?: {
    [groupName: string]: FavoriteChannel[];
  };
  twitch?: {
    [groupName: string]: FavoriteChannel[];
  };
  youtube?: {
    [groupName: string]: FavoriteChannel[];
  };
}

export interface MpvConfig {
  vo?: 'gpu' | 'x11';
  'gpu-context'?: string;
  'gpu-api'?: string;
  hwdec?: string;
  border?: string;
  'keep-open'?: string;
  'force-window'?: string;
  'stop-screensaver'?: string;
  'ytdl-format'?: string;
  'demuxer-max-bytes'?: string;
  'demuxer-max-back-bytes'?: string;
  'stream-buffer-size'?: string;
  'cache-secs'?: string;
  'cache-pause'?: string;
  'force-seekable'?: string;
  priority?: string;
  'x11-bypass-compositor'?: string;
  'vd-lavc-threads'?: string;
  'ad-lavc-threads'?: string;
  [key: string]: string | undefined;
}

export interface StreamlinkOptions {
  player?: string;
  'default-stream'?: string;
  'stream-segment-threads'?: string;
  'stream-timeout'?: string;
  'hls-segment-threads'?: string;
  'player-no-close'?: boolean;
  'twitch-disable-hosting'?: boolean;
  'twitch-disable-ads'?: boolean;
  'twitch-low-latency'?: boolean;
  'retry-max'?: string;
  'retry-streams'?: string;
  'ringbuffer-size'?: string;
  'hls-live-edge'?: string;
  'hls-segment-attempts'?: string;
  'player-continuous-http'?: boolean;
  'stream-segment-attempts'?: string;
  [key: string]: string | boolean | undefined;
}

export interface StreamlinkConfig {
  path: string;
  mpv?: MpvConfig;
  options?: StreamlinkOptions;
  http_header?: Record<string, string>;
  args?: string[];
}

/**
 * Complete application configuration
 */
export interface Config {
  /** Whether to skip streams that have been watched (global setting) */
  skipWatchedStreams?: boolean;
  /** Player settings */
  player: {
    /** Default quality setting */
    defaultQuality: string;
    /** Default volume level (0-100) */
    defaultVolume: number;
    /** Whether to maximize the window by default */
    windowMaximized: boolean;
    /** Maximum number of concurrent streams */
    maxStreams: number;
    /** Whether to auto-start streams on startup */
    autoStart: boolean;
    /** Whether to prefer streamlink over direct playback */
    preferStreamlink: boolean;
    /** Whether to force player to always be running for each enabled screen */
    force_player: boolean;
    /** Configuration for each screen */
    screens: ScreenConfig[];
  };
  /** Stream source configurations */
  streams: ScreenConfig[];
  /** Holodex API configuration */
  holodex: {
    /** Holodex API key */
    apiKey: string;
  };
  /** Twitch API configuration */
  twitch: {
    /** Twitch client ID */
    clientId: string;
    /** Twitch client secret */
    clientSecret: string;
    /** Path to streamers file */
    streamersFile?: string;
  };
  /** Organizations to include */
  organizations: string[];
  /** Favorite channels configuration */
  favoriteChannels: FavoriteChannels;
  /** MPV player configuration */
  mpv?: MpvConfig;
  /** Streamlink configuration */
  streamlink?: StreamlinkConfig;
  sorting?: {
    fields: Array<{ 
      field: string;
      order: 'asc' | 'desc';
      ignore?: string | string[];
    }>;
  };
  filters?: {
    filters: Array<string | {
      type: string;
      value: string;
      include: boolean;
    }>;
  };
}

export interface TwitchTokenData {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type TwitchStream = HelixStream;
export type HolodexVideo = Video & { status: string };
export type HolodexChannel = Channel;

export interface StreamLimits {
  organization?: string;
  limit?: number;
}

export type StreamSourceType = 'holodex' | 'twitch' | 'youtube' |  'favorites';
export type StreamSourceSubtype = 'favorites' | 'organization' | null;

export interface StreamService {
  updateFavorites(channels: string[]): void;
}

export interface StreamSourceConfig {
  type: StreamSourceType;
  subtype?: StreamSourceSubtype;
  name?: string;
  enabled: boolean;
  limit: number;
  priority: number;
  tags?: string[];
  language?: string;
  channels?: string[]; // For favorite channels
}

export interface StreamUpdate {
  type: 'streamUpdate';
  data: {
    stream: Stream;
  };
}

export interface QueueUpdate {
  type: 'queueUpdate';
  data: {
    screen: number;
    queue: StreamSource[];
  };
}

export interface ScreenUpdate {
  type: 'screenUpdate';
  data: {
    screen: number;
    config: ScreenConfig;
  };
}

export interface SettingsUpdate {
  type: 'settingsUpdate';
  data: {
    settings: PlayerSettings;
  };
}

export interface ErrorUpdate {
  type: 'error';
  data: {
    message: string;
  };
}

export type WebSocketMessage = 
  | StreamUpdate 
  | QueueUpdate 
  | ScreenUpdate 
  | SettingsUpdate 
  | ErrorUpdate;

export interface GetStreamsOptions {
  channels?: string[];
  organization?: string;
  limit?: number;
  sort?: 'viewers' | 'start_scheduled';
  tags?: string[];
}

export interface StreamInfo {
  screen: number;
  url: string;
  title?: string;
  platform?: 'youtube' | 'twitch';
  viewerCount?: number;
  startTime?: number;
  quality?: string;
  volume?: number;
  status?: string;
}

export interface StreamError {
  screen: string;
  url: string;
  error: string;
}

export interface StreamEnd {
  screen: number;
  code?: number;
  url?: string; // Keep url as optional for backward compatibility
} 