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

interface GetStreamsOptions {
  limit?: number;
  tags?: string[];
  language?: string;
  channels?: string[];
}

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

  async getStreams(options?: GetStreamsOptions, channels?: string[] | undefined): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const limit = options?.limit || 25;
      const tags = options?.tags || [];

      let streams: HelixStream[];
      
      if (channels && channels.length > 0) {
        // Fetch streams from specific channels (favorites)
        const channelBatches = [];
        // Process in batches of 100 due to API limitations
        for (let i = 0; i < channels.length; i += 100) {
          const batch = channels.slice(i, i + 100);
          channelBatches.push(batch);
        }

        // Fetch each batch
        const batchResults = await Promise.all(
          channelBatches.map(batch => 
            this.client!.streams.getStreamsByUserNames(batch)
          )
        );

        // Combine all results
        streams = batchResults.flat();
        
        // If no stream data available, create basic entries for offline channels
        if (streams.length === 0) {
          logger.debug('No live favorite channels found, creating basic entries', 'TwitchService');
          return channels.map(channel => ({
            url: `https://twitch.tv/${channel}`,
            title: `${channel}'s channel`,
            platform: 'twitch' as const,
            viewerCount: 0,
            thumbnail: undefined,
            startedAt: undefined
          }));
        }
      } else {
        // Get regular streams with tag filtering
        const response = await this.client.streams.getStreams({
          limit: Math.min(limit * 2, 100), // Ensure we don't exceed Twitch's limit
          language: options?.language
        });

        // Filter by tags if needed
        if (tags.length > 0) {
          streams = response.data.filter(stream => 
            tags.some(requestedTag => 
              stream.tags.some(tag => tag.toLowerCase() === requestedTag.toLowerCase())
            )
          ).slice(0, limit);
        } else {
          streams = response.data;
        }
      }

      return streams
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

      // If this was a favorites request, return basic entries for the channels
      if (options?.channels?.length) {
        logger.debug('Returning basic entries for favorite channels after error', 'TwitchService');
        return options.channels.map(channel => ({
          url: `https://twitch.tv/${channel}`,
          title: `${channel}'s channel`,
          platform: 'twitch' as const,
          viewerCount: 0,
          thumbnail: undefined,
          startedAt: undefined
        }));
      }

      return [];
    }
  }

  async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
    return this.getStreams({
      limit,
      tags: ['VTuber']
    });
  }

  async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
    return this.getStreams({
      limit,
      language: 'ja'
    });
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