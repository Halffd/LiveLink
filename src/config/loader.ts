import path from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { env } from './env.js';
import * as fs from 'fs';
import type { StreamSourceConfig, FavoriteChannels, Config as StreamConfig } from '../types/stream.js';
import { MpvConfigSchema, StreamlinkConfigSchema } from './schemas/player.js';
import { logger } from '../server/services/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPaths = {
  default: path.join(__dirname, 'default'),
  local: path.join(__dirname, 'local')
};

const StreamSourceConfigSchema = z.object({
  type: z.enum(['favorites', 'organization', 'other', 'twitch', 'holodex']),
  subtype: z.enum(['favorites', 'organization']).nullable().optional(),
  name: z.string().optional(),
  enabled: z.boolean(),
  limit: z.number(),
  priority: z.number(),
  tags: z.array(z.string()).optional(),
  language: z.string().optional(),
  channels: z.array(z.string()).optional()
});

const StreamConfigSchema = z.object({
  id: z.number(),
  screen: z.number(),
  enabled: z.boolean(),
  quality: z.string(),
  volume: z.number(),
  windowMaximized: z.boolean(),
  width: z.number(),
  height: z.number(),
  x: z.number(),
  y: z.number(),
  primary: z.boolean(),
  sources: z.array(StreamSourceConfigSchema)
});

const StreamsConfigSchema = z.object({
  streams: z.array(StreamConfigSchema),
  organizations: z.array(z.string()),
  favoriteChannels: z.object({
    holodex: z.array(z.string()),
    twitch: z.array(z.string())
  }),
  holodex: z.object({
    apiKey: z.string()
  }),
  twitch: z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    streamersFile: z.string()
  }),
  player: z.object({
    preferStreamlink: z.boolean(),
    defaultQuality: z.string(),
    defaultVolume: z.number(),
    windowMaximized: z.boolean(),
    maxStreams: z.number(),
    autoStart: z.boolean(),
    screens: z.array(StreamConfigSchema)
  }),
  mpv: z.object({
    priority: z.string().optional(),
    'gpu-context': z.string().optional(),
    vo: z.string().optional(),
    hwdec: z.string().optional(),
    'gpu-api': z.string().optional()
  }),
  filters: z.object({
    filters: z.array(z.string())
  }),
  streamlink: z.object({
    path: z.string().optional(),
    options: z.record(z.string()).optional(),
    http_header: z.record(z.string()).optional()
  })
});

const FiltersConfigSchema = z.object({
  filters: z.array(z.string())
});

const PlayerConfigSchema = z.object({
  defaultQuality: z.string(),
  preferStreamlink: z.boolean(),
  defaultVolume: z.number(),
  windowMaximized: z.boolean(),
  maxStreams: z.number(),
  autoStart: z.boolean(),
  screens: z.array(z.object({
    id: z.number(),
    width: z.number(),
    height: z.number(),
    x: z.number(),
    y: z.number(),
    primary: z.boolean()
  }))
});

export interface PlayerConfig {
  defaultQuality: string;
  preferStreamlink: boolean;
  defaultVolume: number;
  windowMaximized: boolean;
  maxStreams: number;
  autoStart: boolean;
  screens: Array<{
    id: number;
    width: number;
    height: number;
    x: number;
    y: number;
    primary: boolean;
  }>;
}

export type Config = StreamConfig;

export type StreamsConfig = z.infer<typeof StreamsConfigSchema>;
export type FiltersConfig = z.infer<typeof FiltersConfigSchema>;

function loadConfig<T>(filename: string, schema: z.ZodSchema<T>): T {
  const defaultPath = path.join(configPaths.default, filename);
  const userPath = path.join(configPaths.local, filename);

  // Load default config
  const defaultConfig = JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));

  // Load and merge user config if it exists
  let config = defaultConfig;
  if (fs.existsSync(userPath)) {
    const userConfig = JSON.parse(fs.readFileSync(userPath, 'utf-8'));
    config = { ...defaultConfig, ...userConfig };
  }

  // Validate config
  const result = schema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid configuration in ${filename}: ${result.error.message}`);
  }

  return result.data;
}

function loadJsonFile<T>(filePath: string): T {
  try {
    const fullPath = path.join(process.cwd(), filePath);
    const fileContents = fs.readFileSync(fullPath, 'utf8');
    return JSON.parse(fileContents) as T;
  } catch (error) {
    logger.error(
      `Failed to load JSON file: ${filePath}`,
      'ConfigLoader',
      error instanceof Error ? error : new Error(String(error))
    );
    throw error;
  }
}

export function loadAllConfigs(): Config {
  const config = loadJsonFile<Config>('config/config.json');
  const favorites = loadJsonFile<FavoriteChannels>('config/favorites.json');
  
  // Merge favorites into config
  config.favoriteChannels = favorites;
  
  return config;
}

export function saveConfig(config: Config): void {
  const configPath = path.join(process.cwd(), 'config/config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function saveFavorites(favorites: FavoriteChannels): void {
  const favoritesPath = path.join(process.cwd(), 'config/favorites.json');
  fs.writeFileSync(favoritesPath, JSON.stringify(favorites, null, 2));
} 