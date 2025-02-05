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
  private clientId: string;
  private clientSecret: string;
  private authProvider: RefreshingAuthProvider | null = null;
  private filters: string[];

  constructor(clientId: string, clientSecret: string, filters: string[]) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.filters = filters;

    try {
      // Initialize with client credentials flow for non-user-specific requests
      this.authProvider = new RefreshingAuthProvider({
        clientId,
        clientSecret,
      });
      this.client = new ApiClient({ authProvider: this.authProvider });
      logger.info('Twitch service initialized', 'TwitchService');
    } catch (error) {
      logger.warn('Failed to initialize Twitch service - some features will be disabled', 'TwitchService');
      logger.debug(error instanceof Error ? error.message : String(error), 'TwitchService');
    }
  }

  async getStreams(limit = 50, options: { tags?: string[], language?: string } = {}): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const queryOptions: HelixPaginatedStreamFilter = { 
        limit,
        type: 'live'
      };
      
      // Add language filter if specified
      if (options.language) {
        queryOptions.language = options.language;
      }

      // Add tags filter if specified
      if (options.tags?.length) {
        // @ts-expect-error - Twitch API types are incomplete
        queryOptions.tags = options.tags;
      }

      const streams = await this.client.streams.getStreams(queryOptions);
      
      return streams.data
        .filter(stream => !this.filters.includes(stream.userName.toLowerCase()))
        .map(stream => ({
          url: `https://twitch.tv/${stream.userName}`,
          title: stream.title,
          platform: 'twitch' as const,
          viewerCount: stream.viewers,
          thumbnail: stream.thumbnailUrl,
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

  async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
    return this.getStreams(limit, { tags: ['vtuber'] });
  }

  async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
    return this.getStreams(limit, { language: 'ja' });
  }

  async getFollowedStreams(userId: string): Promise<StreamSource[]> {
    if (!this.client || !this.authProvider) {
      logger.warn('User not authenticated', 'TwitchService');
      return [];
    }

    try {
      const userClient = new ApiClient({ authProvider: this.authProvider });
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
    try {
      if (!this.authProvider) {
        throw new Error('Twitch service not initialized');
      }

      await this.authProvider.addUserForToken({
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        expiresIn: Math.floor((auth.expiresAt - Date.now()) / 1000),
        obtainmentTimestamp: Date.now()
      }, ['user:read:follows']);

      logger.info(`Twitch user auth set for user ${auth.userId}`, 'TwitchService');
    } catch (error) {
      logger.error('Failed to set Twitch user auth', 'TwitchService');
      logger.debug(error instanceof Error ? error.message : String(error), 'TwitchService');
      throw error;
    }
  }
} 