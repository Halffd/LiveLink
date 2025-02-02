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

export class TwitchService {
  private client: ApiClient | null = null;
  private userAuthProvider?: RefreshingAuthProvider;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly filters: string[]
  ) {
    this.initializeClient();
  }

  private async initializeClient() {
    try {
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
    if (!this.client) return [];

    try {
      const filter: HelixPaginatedStreamFilter = {
        limit,
        type: 'live'
      };
      // @ts-ignore - Twitch API types are incomplete
      filter.tags = ['VTuber'];

      const streams = await this.client.streams.getStreams(filter);
      const streamData = (streams as unknown as { data: HelixStream[] }).data;
      
      return streamData.map(stream => ({
        url: `https://twitch.tv/${stream.userName}`,
        title: stream.title,
        platform: 'twitch' as const,
        viewerCount: stream.viewers
      }));
    } catch (error) {
      logger.error(
        'Failed to fetch VTuber streams', 
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