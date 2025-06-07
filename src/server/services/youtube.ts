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
      // In a real implementation, here you would call the YouTube API to fetch only currently live streams.
      // For now, we will simulate by returning an empty list to avoid false positives.
      // TODO: Integrate with YouTube Data API v3 for live stream detection.
      logger.debug('YouTubeService.getLiveStreams called, but no live stream detection is implemented.', 'YouTubeService');
      return [];
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