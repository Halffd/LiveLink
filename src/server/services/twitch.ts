import { 
  ApiClient,
  type HelixPaginatedStreamFilter,
  type HelixStream
} from '@twurple/api';
import { 
  RefreshingAuthProvider,
  type AccessToken
} from '@twurple/auth';
import type { TwitchAuth } from '../db/database.js';
import type { StreamSource } from '../../types/stream.js';
import { logger } from './logger.js';
import { db } from '../db/database.js';
import { env } from '../../config/env.js';

export class TwitchService {
  private client: ApiClient | null = null;
  private userAuthProvider?: RefreshingAuthProvider;
  private filters: string[];

  constructor(
    private clientId: string = env.TWITCH_CLIENT_ID,
    private clientSecret: string = env.TWITCH_CLIENT_SECRET,
    filters: string[] = []
  ) {
    this.filters = filters;
    this.initialize();
  }

  private initialize() {
    try {
      if (!this.clientId || !this.clientSecret) {
        logger.warn('Missing Twitch credentials - some features will be disabled', 'TwitchService');
        return;
      }

      const authProvider = new RefreshingAuthProvider({
        clientId: this.clientId,
        clientSecret: this.clientSecret
      });
      this.client = new ApiClient({ authProvider });
      logger.info('Twitch client initialized', 'TwitchService');
    } catch (error) {
      logger.error(
        'Failed to initialize Twitch client',
        'TwitchService',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  async getStreams(limit = 50): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const streams = await this.client.streams.getStreams({ limit });
      const streamData = (streams as unknown as { data: HelixStream[] }).data;
      
      return streamData
        .filter(stream => !this.filters.includes(stream.userName.toLowerCase()))
        .map(stream => ({
          url: `https://twitch.tv/${stream.userName}`,
          title: stream.title,
          platform: 'twitch' as const,
          viewerCount: stream.viewers
        }));
    } catch (error) {
      logger.error(
        'Failed to fetch Twitch streams', 
        'TwitchService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
    if (!this.client) {
      logger.warn('Twitch client not initialized', 'TwitchService');
      return [];
    }

    try {
      const streams = await this.client.streams.getStreams({
        type: 'live',
        language: 'en',
        limit
      });

      return streams.data
        .filter(stream => 
          !this.filters.length || 
          !this.filters.some(filter => 
            stream.title.toLowerCase().includes(filter.toLowerCase())
          )
        )
        .map(stream => ({
          title: stream.title,
          url: `https://twitch.tv/${stream.userName}`,
          platform: 'twitch' as const,
          thumbnail: stream.thumbnailUrl,
          viewerCount: stream.viewers,
          startedAt: stream.startDate
        }));
    } catch (error) {
      logger.error(
        'Failed to fetch Twitch streams',
        'TwitchService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const streams = await this.client.streams.getStreams({
        limit,
        language: 'ja'
      });

      const streamData = (streams as unknown as { data: HelixStream[] }).data;
      return streamData
        .filter(stream => !this.filters.includes(stream.userName.toLowerCase()))
        .map(stream => ({
          url: `https://twitch.tv/${stream.userName}`,
          title: stream.title,
          platform: 'twitch' as const,
          viewerCount: stream.viewers
        }));
    } catch (error) {
      logger.error(
        'Failed to fetch Japanese streams', 
        'TwitchService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  async getFollowedStreams(userId: string): Promise<StreamSource[]> {
    if (!this.client || !this.userAuthProvider) {
      logger.warn('User not authenticated', 'TwitchService');
      return [];
    }

    try {
      const userClient = new ApiClient({ authProvider: this.userAuthProvider });
      // @ts-ignore - Twitch API types are incomplete
      const follows = await userClient.users.getFollows({ userId });
      const channelIds = follows.data.map((follow: { followedUserId: string }) => follow.followedUserId);
      
      const streams = await this.client.streams.getStreamsByUserIds(channelIds);
      const streamData = (streams as unknown as { data: HelixStream[] }).data;
      
      return streamData.map(stream => ({
        url: `https://twitch.tv/${stream.userName}`,
        title: stream.title,
        platform: 'twitch' as const,
        viewerCount: stream.viewers
      }));
    } catch (error) {
      logger.error(
        'Failed to fetch followed streams', 
        'TwitchService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  async setUserAuth(auth: TwitchAuth): Promise<void> {
    const provider = new RefreshingAuthProvider({
      clientId: this.clientId,
      clientSecret: this.clientSecret
    });

    provider.onRefresh(async (userId: string, newToken: AccessToken) => {
      if (newToken.refreshToken && newToken.expiresIn) {
        await db.saveTwitchAuth({
          userId,
          accessToken: newToken.accessToken,
          refreshToken: newToken.refreshToken,
          expiresAt: Date.now() + (newToken.expiresIn * 1000)
        });
      }
    });

    await provider.addUserForToken({
      accessToken: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresIn: Math.floor((auth.expiresAt - Date.now()) / 1000),
      obtainmentTimestamp: Date.now()
    }, ['user:read:follows']);

    this.userAuthProvider = provider;
  }
} 