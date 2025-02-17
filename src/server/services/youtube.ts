import type { StreamService } from '../../types/stream.js';
import type { StreamSource } from '../../types/stream.js';
import { logger } from './logger.js';

export class YouTubeService implements StreamService {
  private favoriteChannels: string[] = [];

  constructor(favoriteChannels: string[]) {
    this.favoriteChannels = favoriteChannels;
  }

  async getLiveStreams(options?: { channels?: string[]; limit?: number }): Promise<StreamSource[]> {
    try {
      const channels = options?.channels || this.favoriteChannels;
      const limit = options?.limit || 25;

      // For each channel, create a basic entry that will be updated with live status
      const streams: StreamSource[] = channels.map(channel => ({
        url: `https://youtube.com/${channel}`,
        title: `${channel}'s channel`,
        platform: 'youtube',
        viewerCount: 0,
        channelId: channel
      }));

      logger.debug(`Found ${streams.length} YouTube channels`, 'YouTubeService');
      return streams.slice(0, limit);
    } catch (error) {
      logger.error(
        'Failed to fetch YouTube streams',
        'YouTubeService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  public updateFavorites(channels: string[]): void {
    this.favoriteChannels = channels;
    logger.debug(`Updated YouTube favorites: ${channels.join(', ')}`, 'YouTubeService');
  }
} 