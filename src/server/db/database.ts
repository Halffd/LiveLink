import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs/promises';
import { env } from '../../config/env.js';
import { logger } from '../services/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TwitchAuth {
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

class DatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class DatabaseService {
  private db: Database | null = null;
  private dbPath: string;

  constructor() {
    this.dbPath = path.resolve(process.cwd(), env.DATABASE_PATH);
  }

  async initialize() {
    try {
      // Ensure the database directory exists
      const dbDir = path.dirname(this.dbPath);
      await fs.mkdir(dbDir, { recursive: true });

      logger.debug(`Initializing database at ${this.dbPath}`, 'Database');
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Initialize tables
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS streams (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL,
          screen INTEGER NOT NULL,
          quality TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS twitch_auth (
          user_id TEXT PRIMARY KEY,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);

      logger.info('Database initialized successfully', 'Database');
    } catch (error) {
      logger.error(
        `Failed to initialize database: ${error}`,
        'Database',
        error instanceof Error ? error : new Error(String(error))
      );
      throw new DatabaseError(`Failed to initialize database: ${error}`);
    }
  }

  async saveTwitchAuth(auth: TwitchAuth): Promise<void> {
    if (!this.db) throw new DatabaseError('Database not initialized');
    
    try {
      await this.db.run(
        `INSERT OR REPLACE INTO twitch_auth (user_id, access_token, refresh_token, expires_at)
         VALUES (?, ?, ?, ?)`,
        [auth.userId, auth.accessToken, auth.refreshToken, auth.expiresAt]
      );
    } catch (error) {
      throw new DatabaseError(`Failed to save Twitch auth: ${error}`);
    }
  }

  async getTwitchAuth(userId: string): Promise<TwitchAuth | null> {
    if (!this.db) throw new DatabaseError('Database not initialized');
    
    try {
      const row = await this.db.get(
        'SELECT user_id as userId, access_token as accessToken, refresh_token as refreshToken, expires_at as expiresAt FROM twitch_auth WHERE user_id = ?',
        userId
      ) as TwitchAuth | undefined;
      
      return row || null;
    } catch (error) {
      throw new DatabaseError(`Failed to get Twitch auth: ${error}`);
    }
  }
}

export const db = new DatabaseService(); 