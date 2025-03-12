import { 
  HolodexApiClient,
  type VideoStatus,
  type Video
} from 'holodex.js';
import type { StreamSource, Config } from '../../types/stream.js';
import { logger } from './logger.js';
import type { StreamService } from '../../types/stream.js';

interface GetLiveStreamsOptions {
  channels?: string[];
  organization?: string;
  limit?: number;
  sort?: 'start_scheduled' | 'available_at' | 'live_viewers';
}

export class HolodexService implements StreamService {
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

  async getLiveStreams(options: GetLiveStreamsOptions): Promise<StreamSource[]> {
    try {
      if (!this.client) {
        logger.warn('Holodex service not initialized - returning empty streams', 'HolodexService');
        return [];
      }

      const params: Record<string, string | number> = {
        limit: options.limit || 25,
        sort: options.sort || 'available_at',
        order: 'asc'
      };

      const organization = options?.organization;
      const channels = options?.channels;

      let videos: Video[];
      
      if (channels && channels.length > 0) {
        // Fetch streams from specific channels
        logger.debug(`Fetching streams for ${channels.length} channels`, 'HolodexService');
        const promises = channels.map(channelId =>
          this.client!.getLiveVideos({
            channel_id: channelId,
            status: 'live' as VideoStatus,
            sort: 'live_viewers',
            max_upcoming_hours: 0
          }).catch(error => {
            logger.error(`Failed to fetch streams for channel ${channelId}`, 'HolodexService');
            logger.debug(error instanceof Error ? error.message : String(error), 'HolodexService');
            return [];
          })
        );
        
        const results = await Promise.all(promises);
        videos = results.flat();
        logger.debug(`Found ${videos.length} live streams from favorite channels`, 'HolodexService');
      } else {
        // Fetch streams by organization or all
        if (organization) {
          params.org = organization;
        }

        logger.debug(`Fetching ${params.limit} live streams${organization ? ` for ${organization}` : ''}`, 'HolodexService');
        videos = await this.client.getLiveVideos(params);
      }

      logger.info(`Found ${videos.length} live streams`, 'HolodexService');
      if (videos.length > 0) {
        logger.debug(`Stream details: ${JSON.stringify(videos.slice(0, 3).map(v => ({
          title: v.title,
          channel: v.channel?.name,
          viewers: v.liveViewers,
          id: v.videoId,
          status: v.status
        })))}`, 'HolodexService');
      }

      // Filter out channels that should be excluded
      const filteredVideos = videos.filter(video => !this.isChannelFiltered(video));
      
      // Convert to StreamSource format
      const streamSources = filteredVideos.map(video => ({
        url: `https://youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        platform: 'youtube' as const,
        viewerCount: video.liveViewers,
        thumbnail: video.channel?.avatarUrl,
        startTime: video.actualStart ? new Date(video.actualStart).getTime() : undefined,
        sourceStatus: video.status === 'live' ? 'live' as const : 
                     video.status === 'upcoming' ? 'upcoming' as const : 'ended' as const,
        channelId: video.channel?.channelId,
        organization: video.channel?.organization
      }));

      // If these are favorite channels, preserve their original order
      if (channels && channels.length > 0) {
        // Create a map of channel IDs to their original position in the favorites array
        const channelOrderMap = new Map<string, number>();
        channels.forEach((channelId, index) => {
          channelOrderMap.set(channelId, index);
        });
        
        // Sort streams by their channel's position in the favorites array
        streamSources.sort((a, b) => {
          const aOrder = a.channelId ? channelOrderMap.get(a.channelId) ?? 999 : 999;
          const bOrder = b.channelId ? channelOrderMap.get(b.channelId) ?? 999 : 999;
          
          // First sort by channel order (favorites order)
          if (aOrder !== bOrder) {
            return aOrder - bOrder;
          }
          
          // For streams from the same channel, sort by live status
          if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
          if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
          
          // Then by viewer count for live streams from the same channel
          if (a.sourceStatus === 'live' && b.sourceStatus === 'live') {
            return (b.viewerCount || 0) - (a.viewerCount || 0);
          }
          
          // Then by start time
          const aTime = a.startTime || 0;
          const bTime = b.startTime || 0;
          return aTime - bTime;
        });
      } else {
        // For non-favorite streams, use the original sorting logic
        streamSources.sort((a, b) => {
          // First by live status (live streams first)
          if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
          if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
          
          // Then by viewer count for live streams
          if (a.sourceStatus === 'live' && b.sourceStatus === 'live') {
            return (b.viewerCount || 0) - (a.viewerCount || 0);
          }
          
          // Then by scheduled start time
          const aTime = a.startTime || 0;
          const bTime = b.startTime || 0;
          return aTime - bTime;
        });
      }

      return streamSources;
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
          status: 'live' as VideoStatus,
          max_upcoming_hours: 0
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
    
    // If channel is in favorites, don't filter it
    if (channelId && this.favoriteChannels.includes(channelId)) {
      return false;
    }
    
    // If channel name matches any filter exactly, filter it
    return Boolean(channelName && this.filters.includes(channelName));
  }

  public updateFavorites(channels: string[]): void {
    this.favoriteChannels = channels;
  }
} 