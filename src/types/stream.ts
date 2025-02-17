import type { HelixStream } from '@twurple/api';
import type { Video, Channel } from 'holodex.js';
import type { StreamOutput, StreamError } from './stream_instance.js';

export interface StreamOptions {
  url: string;
  screen: number;
  quality?: string;
  windowMaximized?: boolean;
  volume?: number;
}

export interface WorkerStreamOptions extends StreamOptions {
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

export interface Stream {
  process: NodeJS.Process;
  url: string;
  quality: string;
  screen: number;
  title?: string;
  platform: 'youtube' | 'twitch';
}

export interface StreamSource {
  url: string;
  title?: string;
  platform?: string;
  viewerCount?: number;
  thumbnailUrl?: string;
  screen?: number;
  priority?: number;
  sourceName?: string;
  source?: string;
}

export interface StreamResponse {
  message: string;
  error?: string;
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

export type StreamSourceType = 'favorites' | 'organization' | 'other' | 'twitch' | 'holodex';
export type StreamSourceSubtype = 'favorites' | 'organization' | null;

export interface FavoriteChannels {
  holodex: string[];
  twitch: string[];
  youtube: string[];
}

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

export interface Stream extends StreamSource {
  screen: number;
  status: 'playing' | 'paused' | 'stopped' | 'error';
  quality: string;
  volume: number;
  error?: string;
  startTime?: number;
  duration?: number;
}

export interface StreamConfig {
  id: number;
  screen: number;
  enabled: boolean;
  quality: string;
  volume: number;
  windowMaximized: boolean;
  width: number;
  height: number;
  x: number;
  y: number;
  primary: boolean;
  sources: StreamSourceConfig[];
}

export interface Config {
  streams: StreamConfig[];
  organizations: string[];
  favoriteChannels: FavoriteChannels;
  holodex: {
    apiKey: string;
  };
  twitch: {
    clientId: string;
    clientSecret: string;
    streamersFile: string;
  };
  player: {
    preferStreamlink: boolean;
    defaultQuality: string;
    defaultVolume: number;
    windowMaximized: boolean;
    maxStreams: number;
    autoStart: boolean;
    screens: StreamConfig[];
  };
  mpv: {
    priority?: string;
    'gpu-context'?: string;
    vo?: string;
    hwdec?: string;
    'gpu-api'?: string;
  };
  streamlink: {
    path?: string;
    options?: Record<string, string>;
    http_header?: Record<string, string>;
  };
  filters: {
    filters: string[];
  };
}

export interface PlayerSettings {
  preferStreamlink: boolean;
  defaultQuality: string;
  defaultVolume: number;
  windowMaximized: boolean;
  maxStreams: number;
  autoStart: boolean;
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