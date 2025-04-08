import path from 'path';
import * as fs from 'fs';
import type { FavoriteChannels, Config, PlayerSettings, ScreenConfig } from '../types/stream.js';
import { logger } from '../server/services/logger.js';

function loadJsonFile<T>(filename: string): T {
  const configDir = process.env.LIVELINK_CONFIG || path.join(process.cwd(), 'config');
  const filePath = path.join(configDir, path.basename(filename));
  const fileContents = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(fileContents) as T;
}

export interface PlayerConfig {
  defaultQuality: string;
  preferStreamlink: boolean;
  defaultVolume: number;
  windowMaximized: boolean;
  maxStreams: number;
  autoStart: boolean;
  force_player: boolean;
  screens: Array<{
    id: number;
    width: number;
    height: number;
    x: number;
    y: number;
    primary: boolean;
  }>;
}

export function loadAllConfigs(): Config {
  try {
    // Load individual config files
    const favorites = loadJsonFile<FavoriteChannels>('favorites.json');
    const streams = loadJsonFile<{ streams: ScreenConfig[]; organizations: string[] }>('streams.json');
    const player = loadJsonFile<PlayerSettings & { screens: ScreenConfig[] }>('player.json');
    const mpv = loadJsonFile<Config['mpv']>('mpv.json');
    const streamlink = loadJsonFile<Config['streamlink']>('streamlink.json');
    const filters = loadJsonFile<{ filters: string[] }>('filters.json');

    // Merge into a single config object
    const config: Config = {
      streams: streams.streams || [],
      organizations: streams.organizations || [],
      favoriteChannels: favorites,
  holodex: {
        apiKey: process.env.HOLODEX_API_KEY || ''
      },
      twitch: {
        clientId: process.env.TWITCH_CLIENT_ID || '',
        clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
        streamersFile: 'streamers.json'
      },
      player: {
        ...player,
        screens: player.screens || []
      },
      mpv,
      streamlink,
      filters
    };

    return config;
  } catch (error) {
    // If any config file is missing, use default config
    logger.warn('Failed to load config files, using default config', 'ConfigLoader');
    logger.debug(
      error instanceof Error ? error.message : String(error),
      'ConfigLoader'
    );
    
    return {
      streams: [],
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
        streamersFile: 'streamers.json'
      },
      player: {
        preferStreamlink: false,
        defaultQuality: 'best',
        defaultVolume: 50,
        windowMaximized: false,
        maxStreams: 4,
        autoStart: true,
        force_player: false,
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
            sources: [],
            sorting: {
              field: 'viewerCount',
              order: 'desc'
            },
            refresh: 300,
            autoStart: true
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
            sources: [],
            sorting: {
              field: 'viewerCount',
              order: 'desc'
            },
            refresh: 300,
            autoStart: true
          }
        ]
      },
      mpv: {
        priority: 'normal',
        'gpu-context': 'auto'
      },
      streamlink: {
        path: '',
        options: {},
        http_header: {}
      },
  filters: {
        filters: []
      }
    };
  }
}

export function saveConfig(config: Config): void {
  // Save each part of the config to its respective file
  const configDir = process.env.LIVELINK_CONFIG || path.join(process.cwd(), 'config');

  // Save favorites
  fs.writeFileSync(
    path.join(configDir, 'favorites.json'),
    JSON.stringify(config.favoriteChannels, null, 2)
  );

  // Save streams and organizations
  fs.writeFileSync(
    path.join(configDir, 'streams.json'),
    JSON.stringify({
      streams: config.streams,
      organizations: config.organizations
    }, null, 2)
  );

  // Save player settings
  fs.writeFileSync(
    path.join(configDir, 'player.json'),
    JSON.stringify(config.player, null, 2)
  );

  // Save MPV settings
  fs.writeFileSync(
    path.join(configDir, 'mpv.json'),
    JSON.stringify(config.mpv, null, 2)
  );

  // Save streamlink settings
  fs.writeFileSync(
    path.join(configDir, 'streamlink.json'),
    JSON.stringify(config.streamlink, null, 2)
  );

  // Save filters
  fs.writeFileSync(
    path.join(configDir, 'filters.json'),
    JSON.stringify(config.filters, null, 2)
  );
}

export function saveFavorites(favorites: FavoriteChannels): void {
  const configDir = process.env.LIVELINK_CONFIG || path.join(process.cwd(), 'config');
  const favoritesPath = path.join(configDir, 'favorites.json');
  fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));
} 