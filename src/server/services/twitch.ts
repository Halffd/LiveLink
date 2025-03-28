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
      
      // If we have channels to fetch
      if (channels.length > 0) {
        // Process channels in batches of 100 (Twitch API limit)
        const batches: string[][] = [];
        for (let i = 0; i < channels.length; i += 100) {
          const batchChannels = channels.slice(i, i + 100);
          batches.push(batchChannels);
        }

        // Fetch all batches in parallel
        const batchResults = await Promise.all(
          batches.map(batchChannels =>
            this.client!.streams.getStreams({
              userName: batchChannels,
              ...(options.language ? { language: options.language } : {})
            }).catch(error => {
              logger.error(
                `Failed to fetch batch of streams: ${error instanceof Error ? error.message : String(error)}`,
                'TwitchService'
              );
              return { data: [] };
            })
          )
        );

        // Combine all batch results
        results = batchResults.flatMap(batch => 
          batch.data.map(stream => ({
            url: `https://twitch.tv/${stream.userName}`,
            title: stream.title,
            platform: 'twitch' as const,
            viewerCount: stream.viewers,
            startTime: stream.startDate.getTime(),
            sourceStatus: 'live' as const,
            channelId: stream.userName.toLowerCase()
          }))
        );

        // If we have a limit, apply it after combining all results
        if (limit) {
          results = results.slice(0, limit);
        }
      } else {
        // No specific channels, just fetch by limit and language
        const streams = await this.client.streams.getStreams({
          limit,
          ...(options.language ? { language: options.language } : {})
        });

        results = streams.data.map(stream => ({
          url: `https://twitch.tv/${stream.userName}`,
          title: stream.title,
          platform: 'twitch' as const,
          viewerCount: stream.viewers,
          startTime: stream.startDate.getTime(),
          sourceStatus: 'live' as const,
          channelId: stream.userName.toLowerCase()
        }));
      }

      // If these are favorite channels, then re-sort preserving favorite order
      if (channels && channels.length > 0) {
        // Create a map of channel IDs to their original position in the favorites array
        const channelOrderMap = new Map<string, number>();
        channels.forEach((channelId, index) => {
          channelOrderMap.set(channelId.toLowerCase(), index);
        });

        // Sort results based on original channel order
        results.sort((a, b) => {
          const aOrder = channelOrderMap.get(a.channelId) ?? Number.MAX_SAFE_INTEGER;
          const bOrder = channelOrderMap.get(b.channelId) ?? Number.MAX_SAFE_INTEGER;
          return aOrder - bOrder;
        });
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
    if (!this.client) return [];

    try {
      // First, search for channels with VTuber tag
      const channels = await this.client.search.searchChannels('vtuber', {
        liveOnly: true,
        limit
      });

      // Convert to StreamSource format
      const results = channels.data.map(channel => ({
        url: `https://twitch.tv/${channel.name}`,
        title: channel.displayName,
        platform: 'twitch' as const,
        viewerCount: 0, // Not available in search results
        startTime: Date.now(), // Not available in search results
        sourceStatus: channel.isLive ? 'live' as const : 'offline' as const,
        channelId: channel.name.toLowerCase(),
        tags: channel.tags || []
      }));

      // Filter to only live streams with VTuber tag
      const vtuberStreams = results.filter(stream => 
        stream.sourceStatus === 'live' && 
        stream.tags?.some(tag => tag.toLowerCase() === 'vtuber')
      );

      // Get actual stream data for live channels to get viewer counts
      if (vtuberStreams.length > 0) {
        const streamData = await this.client.streams.getStreams({
          userName: vtuberStreams.map(s => s.channelId),
          limit: vtuberStreams.length
        });

        // Update viewer counts and start times
        for (const stream of streamData.data) {
          const matchingStream = vtuberStreams.find(
            s => s.channelId === stream.userName.toLowerCase()
          );
          if (matchingStream) {
            matchingStream.viewerCount = stream.viewers;
            matchingStream.startTime = stream.startDate.getTime();
          }
        }
      }

      // Sort by viewer count
      //vtuberStreams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));

      logger.info(`Found ${vtuberStreams.length} VTuber streams on Twitch`, 'TwitchService');
      return vtuberStreams;
    } catch (error) {
      logger.error(
        'Failed to get VTuber streams',
        'TwitchService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
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

  updateFavorites(channels: string[]): void {
    this.favoriteChannels = channels;
  }
} 