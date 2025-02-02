import type { HelixStream } from '@twurple/api';
import type { Video, Channel } from 'holodex.js';

export interface StreamOptions {
  url: string;
  quality?: string;
  screen?: number;
  windowMaximized?: boolean;
  volume?: number;
}

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

export type StreamSourceType = 'favorites' | 'organization' | 'other' | 'twitch';

export interface StreamSourceConfig {
  type: StreamSourceType;
  name?: string;
  enabled: boolean;
  limit: number;
  priority: number;
} 