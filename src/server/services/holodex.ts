import { 
  HolodexApiClient,
  type VideoStatus,
  type SortOrder,
  type Video,
  type VideosParam,
  type VideoType,
  type VideoRaw
} from 'holodex.js';
import type { StreamSource, StreamSourceConfig } from '../../types/stream.js';
import { logger } from './logger.js';
import { env } from '../../config/env.js';
import type { Config } from '../../config/loader.js';

const VIDEO_STATUS = {
  LIVE: 'live' as VideoStatus
};

const SORT_ORDER = {
  DESC: 'desc' as SortOrder
};

interface StreamSourceResult {
  source: StreamSourceConfig;
  streams: Video[];
}

export class HolodexService {
  private client: HolodexApiClient | null = null;

  constructor(
    private apiKey: string = env.HOLODEX_API_KEY,
    private filters: string[] = [],
    private favoriteChannels: string[] = [],
    private config: Config
  ) {
    this.initialize();
  }

  private initialize() {
    try {
      if (!this.apiKey) {
        logger.warn('Missing Holodex API key - some features will be disabled', 'HolodexService');
        return;
      }

      this.client = new HolodexApiClient({
        apiKey: this.apiKey
      });
      logger.info('Holodex client initialized', 'HolodexService');
    } catch (error) {
      logger.error(
        'Failed to initialize Holodex client',
        'HolodexService',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  async getLiveStreams(options: { limit?: number } = {}): Promise<StreamSource[]> {
    if (!this.client) {
      logger.warn('Holodex client not initialized', 'HolodexService');
      return [];
    }

    const { sources, sorting } = this.config.player.limits;
    const enabledSources = sources.filter((s: StreamSourceConfig) => 
      s.enabled && s.type !== 'twitch'
    );
    
    try {
      // Fetch streams for each source in parallel
      const streamsBySource = await Promise.all(
        enabledSources.map(async (source: StreamSourceConfig) => {
          const params: VideosParam = {
            status: VIDEO_STATUS.LIVE,
            type: 'stream' as VideoType,
            sort: 'available_at' as keyof VideoRaw,
            order: sorting.order as SortOrder,
            limit: source.limit
          };

          if (source.type === 'favorites') {
            const streams = await this.getFavoriteStreams();
            return { source, streams: streams as unknown as Video[] };
          } else if (source.type === 'organization' && source.name) {
            params.org = source.name;
          }

          logger.debug(`Fetching ${source.type} streams: ${JSON.stringify(params)}`, 'HolodexService');
          const streams = await this.client!.getLiveVideos(params);
          return { source, streams };
        })
      );

      // Sort sources by priority and merge streams
      const allStreams = streamsBySource
        .sort((a, b) => a.source.priority - b.source.priority)
        .reduce((acc: Video[], { streams }) => {
          return [...acc, ...streams];
        }, []);

      // Remove duplicates (same video ID)
      const uniqueStreams = Array.from(
        new Map(allStreams.map(video => [video.videoId, video])).values()
      );

      // Map to StreamSource format
      return uniqueStreams.map(stream => ({
        title: stream.title,
        url: `https://youtube.com/watch?v=${stream.videoId}`,
        platform: 'youtube' as const,
        thumbnail: stream.channel?.avatarUrl || '',
        viewerCount: stream.liveViewers,
        startedAt: stream.actualStart
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