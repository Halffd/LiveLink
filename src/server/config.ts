import type { StreamConfig, PlayerSettings, FavoriteChannels } from '../types/stream.js';

export interface Config {
  streams: Array<{
    id: number;
    enabled: boolean;
    screen: number;
    sources: Array<{
      type: string;
      subtype?: string;
      name?: string;
      enabled: boolean;
      limit: number;
      priority: number;
      tags?: string[];
    }>;
    sorting: {
      field: string;
      order: 'asc' | 'desc';
    };
    refresh: number;
    autoStart: boolean;
    quality: string;
    volume: number;
    windowMaximized: boolean;
  }>;
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
  player: PlayerSettings & {
    screens: StreamConfig[];
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
  streams: [
    {
      id: 1,
      enabled: true,
      screen: 1,
      sources: [
        {
          type: 'holodex',
          subtype: 'favorites',
          enabled: true,
          limit: 25,
          priority: 1
        },
        {
          type: 'holodex',
          subtype: 'organization',
          name: 'Hololive',
          enabled: true,
          limit: 25,
          priority: 2
        },
        {
          type: 'holodex',
          subtype: 'organization',
          name: 'Independents',
          enabled: true,
          limit: 25,
          priority: 4
        }
      ],
      sorting: {
        field: 'viewerCount',
        order: 'desc'
      },
      refresh: 300,
      autoStart: true,
      quality: 'best',
      volume: 100,
      windowMaximized: false
    },
    {
      id: 2,
      enabled: true,
      screen: 2,
      sources: [
        {
          type: 'twitch',
          subtype: 'favorites',
          enabled: true,
          limit: 100,
          priority: 2
        },
        {
          type: 'twitch',
          enabled: true,
          limit: 25,
          priority: 3,
          tags: ['vtuber']
        }
      ],
      sorting: {
        field: 'viewerCount',
        order: 'desc'
      },
      refresh: 300,
      autoStart: true,
      quality: 'best',
      volume: 0,
      windowMaximized: false
    }
  ],
  organizations: [],
  favoriteChannels: {
    holodex: [],
    twitch: [],
    youtube: []
  },
  holodex: {
    apiKey: process.env.HOLODEX_API_KEY || ''
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID || '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
    streamersFile: 'config/streamers.txt'
  },
  player: {
    preferStreamlink: false,
    defaultQuality: 'best',
    defaultVolume: 50,
    windowMaximized: false,
    maxStreams: 4,
    autoStart: true,
    screens: []
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