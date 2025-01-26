import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';

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

class DatabaseService {
  private db: Database | null = null;

  async initialize(): Promise<void> {
    try {
      this.db = await open({
        filename: path.resolve('./data/streams.db'),
        driver: sqlite3.Database
      });

      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS twitch_auth (
          user_id TEXT PRIMARY KEY,
          access_token TEXT NOT NULL,
          refresh_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        )
      `);
    } catch (error) {
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
      const auth = await this.db.get<TwitchAuth>(
        'SELECT * FROM twitch_auth WHERE user_id = ?',
        userId
      );
      
      return auth || null;
    } catch (error) {
      throw new DatabaseError(`Failed to get Twitch auth: ${error}`);
    }
  }
}

export const db = new DatabaseService(); 