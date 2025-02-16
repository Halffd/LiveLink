import type { StreamConfig, PlayerSettings, FavoriteChannels } from '../types/stream.js';

export interface Config {
  player: PlayerSettings & {
    screens: StreamConfig[];
  };
  streams: StreamConfig[];
  organizations: string[];
  favoriteChannels: {
    holodex: string[];
    twitch: string[];
    youtube: string[];
  };
  holodex: {
    apiKey: string;
  };
  twitch: {
    clientId: string;
    clientSecret: string;
    streamersFile: string;
  };
  mpv: {
    priority?: string;
    'gpu-context'?: string;
  };
  streamlink: {
    path?: string;
    options?: Record<string, string>;
    http_header?: Record<string, string>;
  };
}

export const defaultConfig: Config = {
  player: {
    preferStreamlink: false,
    defaultQuality: 'best',
    defaultVolume: 50,
    windowMaximized: false,
    maxStreams: 4,
    autoStart: true,
    screens: [
      {
        id: 1,
        screen: 1,
        enabled: true,
        width: 1280,
        height: 720,
        x: 0,
        y: 0,
        volume: 50,
        quality: 'best',
        windowMaximized: false,
        primary: true,
        sources: []
      },
      {
        id: 2,
        screen: 2,
        enabled: true,
        width: 1280,
        height: 720,
        x: 1280,
        y: 0,
        volume: 50,
        quality: 'best',
        windowMaximized: false,
        primary: false,
        sources: []
      }
    ]
  },
  streams: [],
  organizations: [],
  favoriteChannels: {
    holodex: [],
    twitch: [],
    youtube: []
  },
  holodex: {
    apiKey: ''
  },
  twitch: {
    clientId: '',
    clientSecret: '',
    streamersFile: 'streamers.json'
  },
  mpv: {
    priority: 'normal',
    'gpu-context': 'auto'
  },
  streamlink: {
    path: '',
    options: {},
    http_header: {}
  }
}; 