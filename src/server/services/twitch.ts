import { ApiClient, type HelixStream } from '@twurple/api';
import { RefreshingAuthProvider } from '@twurple/auth';
import type { TwitchAuth } from '../db/database.js';
import type { StreamSource, StreamService } from '../../types/stream.js';
import { logger } from './logger.js';

interface GetTwitchStreamsOptions {
  channels?: string[];
  limit?: number;
  sort?: 'viewers' | 'started_at';
  tags?: string[];
  language?: string;
}

export class TwitchService implements StreamService {
  private client: ApiClient | null = null;
  private clientId: string;
  private clientSecret: string;
  private authProvider: RefreshingAuthProvider | null = null;
  private filters: string[] = [];
  private favoriteChannels: string[] = [];

  constructor(clientId: string, clientSecret: string, filters: string[] = []) {
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

  async getStreams(options: GetTwitchStreamsOptions): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const limit = options.limit || 25;
      const channels = options.channels || [];
      let results: StreamSource[] = [];
      
      // If we have more than 100 channels, we need to batch the requests
      if (channels.length > 100) {
        logger.info(`Batching ${channels.length} channels into multiple requests (max 100 per request)`, 'TwitchService');
        
        // Process channels in batches of 100
        for (let i = 0; i < channels.length; i += 100) {
          const batchChannels = channels.slice(i, i + 100);
          logger.debug(`Processing batch ${Math.floor(i/100) + 1} with ${batchChannels.length} channels`, 'TwitchService');
          
          const batchStreams = await this.client.streams.getStreams({
            userName: batchChannels,
            language: options.language
          });
          
          // Convert to StreamSource format and add to results
          const batchResults = batchStreams.data.map(stream => ({
            url: `https://twitch.tv/${stream.userName}`,
            title: stream.title,
            platform: 'twitch' as const,
            viewerCount: stream.viewers,
            startTime: stream.startDate.getTime(),
            sourceStatus: 'live' as const,
            channelId: stream.userName.toLowerCase() // Add channelId for sorting
          }));
          
          results = [...results, ...batchResults];
          
          // If we've reached the desired limit, stop processing batches
          if (limit && results.length >= limit) {
            results = results.slice(0, limit);
            break;
          }
        }
      } else {
        // Original logic for <= 100 channels
        const streams = await this.client.streams.getStreams({
          limit,
          userName: channels,
          language: options.language
        });

        // Convert to StreamSource format
        results = streams.data.map(stream => ({
          url: `https://twitch.tv/${stream.userName}`,
          title: stream.title,
          platform: 'twitch' as const,
          viewerCount: stream.viewers,
          startTime: stream.startDate.getTime(),
          sourceStatus: 'live' as const,
          channelId: stream.userName.toLowerCase() // Add channelId for sorting
        }));
      }

      // If these are favorite channels, preserve their original order
      if (channels && channels.length > 0) {
        // Create a map of channel IDs to their original position in the favorites array
        const channelOrderMap = new Map<string, number>();
        channels.forEach((channelId, index) => {
          channelOrderMap.set(channelId.toLowerCase(), index);
        });
        
        // Sort streams by their channel's position in the favorites array
        results.sort((a, b) => {
          const aOrder = a.channelId ? channelOrderMap.get(a.channelId) ?? 999 : 999;
          const bOrder = b.channelId ? channelOrderMap.get(b.channelId) ?? 999 : 999;
          
          // First sort by channel order (favorites order)
          if (aOrder !== bOrder) {
            return aOrder - bOrder;
          }
          
          // Then by viewer count for streams from the same channel
          return (b.viewerCount || 0) - (a.viewerCount || 0);
        });
      }
      // Sort by viewers if requested (for non-favorite channels)
      else if (options.sort === 'viewers') {
        results.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
      }

      logger.info(`Found ${results.length} Twitch streams`, 'TwitchService');
      return results;
    } catch (error) {
      logger.error(
        'Failed to get Twitch streams',
        'TwitchService',
        error instanceof Error ? error : new Error(String(error))
      );
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
      // @ts-expect-error - Twitch API types are incomplete
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

  public updateFavorites(channels: string[]): void {
    this.favoriteChannels = channels;
  }
} 