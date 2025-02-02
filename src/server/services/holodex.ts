import { 
  HolodexApiClient,
  type VideoStatus,
  type SortOrder,
  type Video
} from 'holodex.js';
import type { StreamSource } from '../../types/stream.js';
import { logger } from './logger.js';

const VIDEO_STATUS = {
  LIVE: 'live' as VideoStatus
};

const SORT_ORDER = {
  DESC: 'desc' as SortOrder
};

export class HolodexService {
  private client: HolodexApiClient | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly filters: string[],
    private readonly favoriteChannels: string[]
  ) {
    this.initializeClient();
  }

  private initializeClient() {
    try {
      this.client = new HolodexApiClient({ apiKey: this.apiKey });
      logger.info('Holodex client initialized', 'HolodexService');
    } catch (error) {
      logger.error(
        'Failed to initialize Holodex client', 
        'HolodexService',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  async getLiveStreams(options: { 
    organization?: string, 
    limit?: number 
  } = {}): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const videos = await this.client.getLiveVideos({
        org: options.organization,
        status: VIDEO_STATUS.LIVE,
        sort: 'live_viewers',
        order: SORT_ORDER.DESC,
        limit: options.limit || 50
      });

      return videos
        .filter(video => !this.isChannelFiltered(video))
        .map(video => ({
          url: `https://youtube.com/watch?v=${video.videoId}`,
          title: video.title,
          platform: 'youtube' as const,
          viewerCount: video.liveViewers,
          channelId: video.channel?.channelId,
          organization: video.channel?.organization
        }));
    } catch (error) {
      logger.error(
        'Failed to fetch Holodex streams', 
        'HolodexService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  async getFavoriteStreams(): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const promises = this.favoriteChannels.map(channelId =>
        this.client!.getLiveVideos({ 
          channel_id: channelId,
          status: VIDEO_STATUS.LIVE
        })
      );

      const videoArrays = await Promise.all(promises);
      const videos = videoArrays.flat();

      return videos.map(video => ({
        url: `https://youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        platform: 'youtube' as const,
        viewerCount: video.liveViewers,
        channelId: video.channel?.channelId,
        organization: video.channel?.organization
      }));
    } catch (error) {
      logger.error(
        'Failed to fetch favorite streams', 
        'HolodexService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  private isChannelFiltered(video: Video): boolean {
    const channelName = video.channel?.name?.toLowerCase();
    const channelId = video.channel?.channelId;
    
    if (channelId && this.favoriteChannels.includes(channelId)) {
      return false;
    }
    
    return Boolean(channelName && this.filters.some(filter => 
      channelName.includes(filter.toLowerCase())
    ));
  }
} 