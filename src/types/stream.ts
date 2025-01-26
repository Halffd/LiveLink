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