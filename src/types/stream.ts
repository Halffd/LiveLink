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
  title: string;
  platform: 'twitch' | 'youtube';
  viewerCount?: number;
  thumbnail?: string;
  startedAt?: Date;
  screen?: number;
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

export interface StreamSourceConfig {
  type: StreamSourceType;
  subtype?: StreamSourceSubtype;
  name?: string;
  enabled: boolean;
  limit: number;
  priority: number;
  tags?: string[];
  language?: string;
} 