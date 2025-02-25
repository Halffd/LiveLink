import type { HelixStream } from '@twurple/api';
import type { Video, Channel } from 'holodex.js';
import type { StreamOutput, StreamError } from './stream_instance.js';
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
  | { type: 'streamError'; data: StreamError };

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
  platform?: string;
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
  startTime?: string | number;
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
export interface StreamConfig {
  /** Screen identifier */
  screen: number;
  /** Screen ID */
  id: number;
  /** Whether this screen is enabled */
  enabled: boolean;
  /** Default volume level (0-100) */
  volume: number;
  /** Default quality setting */
  quality: string;
  /** Whether the window should be maximized */
  windowMaximized: boolean;
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
  sources?: {
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
  }[];
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
  success?: boolean;
  /** Error details if operation failed */
  error?: string;
}

/**
 * Favorite channels configuration
 */
export interface FavoriteChannels {
  /** Holodex channel IDs */
  holodex: string[];
  /** Twitch channel IDs/names */
  twitch: string[];
  /** YouTube channel IDs */
  youtube: string[];
}

/**
 * Complete application configuration
 */
export interface Config {
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
    /** Configuration for each screen */
    screens: StreamConfig[];
  };
  /** Stream source configurations */
  streams: StreamConfig[];
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
  mpv?: {
    /** Process priority */
    priority?: string;
    /** Additional arguments */
    args?: string[];
    /** GPU context */
    'gpu-context'?: string;
  };
  /** Streamlink configuration */
  streamlink?: {
    /** Path to streamlink executable */
    path?: string;
    /** Additional arguments */
    args?: string[];
    /** HTTP headers */
    http_header?: Record<string, string>;
    /** Additional options */
    options?: Record<string, string>;
  };
  /** Filters configuration */
  filters?: {
    /** List of filters - can be either simple strings or complex filter objects */
    filters: Array<string | {
      /** Filter type */
      type: string;
      /** Filter value */
      value: string;
      /** Whether to include or exclude */
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
export type HolodexVideo = Video;
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
    config: StreamConfig;
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