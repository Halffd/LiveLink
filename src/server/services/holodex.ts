import { 
  HolodexApiClient,
  type VideoStatus,
  type SortOrder,
  type Video,
  type VideosParam,
  type VideoType,
  type VideoRaw
} from 'holodex.js';
import type { StreamSource, StreamSourceConfig, StreamLimits } from '../../types/stream.js';
import { logger } from './logger.js';
import { env } from '../../config/env.js';
import type { Config } from '../../config/loader.js';

interface StreamSourceResult {
  source: StreamSourceConfig;
  streams: Video[];
}

export class HolodexService {
  private client: HolodexApiClient | null = null;
  private favoriteChannels: string[];
  private filters: string[];
  private config: Config;

  constructor(apiKey: string, filters: string[], favoriteChannels: string[], config: Config) {
    this.favoriteChannels = favoriteChannels;
    this.filters = filters;
    this.config = config;

    try {
      this.client = new HolodexApiClient({
        apiKey: apiKey
      });
      logger.info('Holodex service initialized', 'HolodexService');
    } catch (error) {
      logger.warn('Failed to initialize Holodex service - some features will be disabled', 'HolodexService');
      logger.debug(error instanceof Error ? error.message : String(error), 'HolodexService');
    }
  }

  async getLiveStreams(options: StreamLimits = {}): Promise<StreamSource[]> {
    try {
      if (!this.client) {
        logger.warn('Holodex service not initialized - returning empty streams', 'HolodexService');
        return [];
      }

      const { limit = 25, organization } = options;
      logger.debug(`Fetching ${limit} live streams${organization ? ` for ${organization}` : ''}`, 'HolodexService');

      const videos = await this.client.getLiveVideos({
        limit,
        org: organization,
        status: 'live' as VideoStatus
      });

      logger.info(`Found ${videos.length} live streams`, 'HolodexService');
      logger.debug(`Stream details: ${JSON.stringify(videos.map(v => ({
        title: v.title,
        channel: v.channel?.name,
        viewers: v.liveViewers
      })))}`, 'HolodexService');

      return videos.map(video => ({
        url: `https://youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        platform: 'youtube',
        viewerCount: video.liveViewers,
        thumbnail: video.channel?.avatarUrl,
        startedAt: video.actualStart ? new Date(video.actualStart) : undefined
      }));
    } catch (error) {
      logger.error('Failed to fetch Holodex live streams', 'HolodexService');
      logger.debug(error instanceof Error ? error.message : String(error), 'HolodexService');
      return [];
    }
  }

  async getFavoriteStreams(): Promise<StreamSource[]> {
    if (!this.client) return [];

    try {
      const promises = this.favoriteChannels.map(channelId =>
        this.client!.getLiveVideos({ 
          channel_id: channelId,
          status: 'live' as VideoStatus
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
    
    return Boolean(channelName && this.filters.some((filter: string) => 
      channelName.includes(filter.toLowerCase())
    ));
  }
} 