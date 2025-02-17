import { z } from 'zod';
import { MpvConfigSchema, StreamlinkConfigSchema } from '../schemas/player.js';

export type MpvConfig = Record<string, any>;
export type StreamlinkConfig = Record<string, any>;

// Screen-specific settings that come from player.json
export interface PlayerConfig {
  geometry?: string;
  'window-maximized'?: boolean;
} 