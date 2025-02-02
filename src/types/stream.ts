import type { HelixStream } from '@twurple/api';
import type { Video, Channel } from 'holodex.js';

export interface StreamOptions {
  url: string;
  quality: string;
  screen: number;
  volume?: number;
  useStreamlink?: boolean;
  windowMaximized?: boolean;
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
  platform: 'youtube' | 'twitch';
  viewerCount?: number;
  organization?: string;
  channelId?: string;
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