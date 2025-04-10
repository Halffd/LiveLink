import { 
  HolodexApiClient,
  type VideoStatus,
  type Video,
  type VideoType,
  VideoRaw
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
      const channelOrderMap = new Map<string, number>();
      
      if (channels && channels.length > 0) {
        // Create a map of channel IDs to their original position in the favorites array
        channels.forEach((channelId, index) => {
          channelOrderMap.set(channelId, index);
        });
        
        // Fetch all channels in parallel but preserve order
        const promises = channels.map(channelId =>
          this.client!.getLiveVideos({
            channel_id: channelId,
            status: 'live' as VideoStatus,
            type: 'stream' as VideoType,
            max_upcoming_hours: 0,
            sort: 'live_viewers' as keyof VideoRaw & string,
          }).catch(error => {
            logger.error(`Failed to fetch streams for channel ${channelId}`, 'HolodexService');
            logger.debug(error instanceof Error ? error.message : String(error), 'HolodexService');
            return [];
          })
        );
        
        const results = await Promise.all(promises);
        
        // Flatten results but maintain channel order
        videos = [];
        channels.forEach((channelId, index) => {
          const channelVideos = results[index]
            // Filter out videos where the channel ID doesn't match (collabs)
            .filter(video => video.channel?.channelId === channelId);
            
          if (channelVideos && channelVideos.length > 0) {
            // Sort videos for each channel: live first, then by viewer count
            channelVideos.sort((a, b) => {
              if (a.status === 'live' && b.status !== 'live') return -1;
              if (a.status !== 'live' && b.status === 'live') return 1;
              return (b.liveViewers || 0) - (a.liveViewers || 0);
            });
            videos.push(...channelVideos);
          }
        });
        
        logger.debug(`Found ${videos.length} live/upcoming streams from favorite channels`, 'HolodexService');
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
      const filteredVideos = videos.filter(video => {
        if (this.isChannelFiltered(video)) {
          logger.info(`Filtering out video from channel ${video.channel?.name}`, 'HolodexService');
          return false;
        }
        return true;
      });
      if (videos.length !== filteredVideos.length) {
        logger.info(`Some videos were filtered out due to channel exclusions`, 'HolodexService');
      }
      // Convert to StreamSource format with channel order preserved
      const streamSources = filteredVideos.map(video => {
        const channelId = video.channel?.channelId;
        const channelOrder = channelId && channels?.includes(channelId) ? channelOrderMap.get(channelId) : undefined;
        
        return {
          url: `https://youtube.com/watch?v=${video.videoId}`,
          title: video.title,
          platform: 'youtube' as const,
          viewerCount: video.liveViewers,
          thumbnail: video.channel?.avatarUrl,
          startTime: video.actualStart ? new Date(video.actualStart).getTime() : 
                    video.availableAt ? new Date(video.availableAt).getTime() : undefined,
          sourceStatus: video.status === 'live' ? 'live' as const : 
                       video.status === 'upcoming' ? 'upcoming' as const : 'ended' as const,
          channelId: channelId,
          organization: video.channel?.organization,
          // Set priority based on channel order for favorites
          priority: channelOrder !== undefined ? channelOrder : undefined
        };
      });

      // Sort streams based on context
      if (channels && channels.length > 0) {
        // For favorites, sort by:
        // 1. Channel order in favorites
        // 2. Live status (live before upcoming)
        // 3. Viewer count for same channel
        streamSources.sort((a, b) => {
          // First by channel order (favorites order)
          const aOrder = a.priority ?? 999;
          const bOrder = b.priority ?? 999;
          if (aOrder !== bOrder) return aOrder - bOrder;
          
          // Then by live status
          if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
          if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
          
          // Then by viewer count for streams from the same channel
          return (b.viewerCount || 0) - (a.viewerCount || 0);
        });
      } else {
        // For non-favorite streams, sort by:
        // 1. Live status
        // 2. Viewer count
        // 3. Start time
        streamSources.sort((a, b) => {
          if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
          if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
          
          if (a.sourceStatus === 'live' && b.sourceStatus === 'live') {
            return (b.viewerCount || 0) - (a.viewerCount || 0);
          }
          
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
    const channelId = video.channel?.channelId;
    const channelName = video.channel?.name;
    const englishName = video.channel?.englishName;
    
    // If channel is in favorites, don't filter it
    if (channelId && this.favoriteChannels.includes(channelId)) {
      logger.debug(`Channel ${channelName} (${channelId}) is in favorites, not filtering`, 'HolodexService');
      return false;
    }
    
    // If no channel names, don't filter
    if (!channelName && !englishName) {
      return false;
    }

    // Normalize channel names: lowercase and remove all spaces and special characters
    const normalizedNames = [
      channelName?.toLowerCase().replace(/[\s\-_]+/g, ''),
      englishName?.toLowerCase().replace(/[\s\-_]+/g, '')
    ].filter(Boolean);
    
    // Check if any of the normalized names exactly match any filter
    for (const filter of this.filters) {
      const normalizedFilter = filter.toLowerCase().replace(/[\s\-_]+/g, '');
      
      // Check if any of the normalized names match the filter
      for (const normalizedName of normalizedNames) {
        // Only filter if the normalized name matches the filter exactly or contains the full filter name
        if (normalizedName === normalizedFilter || normalizedName.includes(normalizedFilter)) {
          logger.info(
            `Filtering out channel ${channelName}${englishName ? ` (${englishName})` : ''} - matched filter "${filter}"`,
            'HolodexService'
          );
          return true;
        }
      }
    }
    
    // If no filters matched, don't filter out the channel
    logger.debug(
      `Channel ${channelName}${englishName ? ` (${englishName})` : ''} does not match any filters, keeping`,
      'HolodexService'
    );
    return false;
  }

  public updateFavorites(channels: string[]): void {
    this.favoriteChannels = channels;
  }
} 