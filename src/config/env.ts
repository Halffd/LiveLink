import { z } from 'zod';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3001'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  DATABASE_PATH: z.string().default(path.resolve(process.cwd(), 'data/streams.db')),
  HOLODEX_API_KEY: z.string({
    required_error: 'HOLODEX_API_KEY is required'
  }),
  TWITCH_CLIENT_ID: z.string({
    required_error: 'TWITCH_CLIENT_ID is required'
  }),
  TWITCH_CLIENT_SECRET: z.string({
    required_error: 'TWITCH_CLIENT_SECRET is required'
  })
});

export const env = envSchema.parse(process.env); 