import { 
  HolodexApiClient,
  type VideoStatus,
  type Video,
  type VideoType,
} from 'holodex.js';
import type { VideoRaw } from 'holodex.js';
import type { StreamSource } from '../../types/stream.js';
import { logger } from './logger.js';
import type { StreamService } from '../../types/stream.js';

interface GetLiveStreamsOptions {
  channels?: string[];
  organization?: string;
  limit?: number;
  sort?: 'start_scheduled' | 'available_at' | 'live_viewers';
}

export class HolodexService implements StreamService {
  readonly client: HolodexApiClient | null = null;
  private favoriteChannels: string[];
  private filters: string[];

  constructor(apiKey: string, filters: string[], favoriteChannels: string[]) {
    this.favoriteChannels = favoriteChannels;
    this.filters = filters;

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
        sort: options.sort || 'live_viewers',
        order: options.sort === 'available_at' ? 'asc' : 'desc'
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
        
        logger.info(`Fetching streams for ${channels.length} favorite Holodex channels`, 'HolodexService');
        logger.debug(`Holodex favorite channels: ${channels.join(', ')}`, 'HolodexService');

        // Fetch all channels in parallel but preserve order
        const promises = channels.map(async (channelId) => {
          if (!channelId) return [];

          // Use more inclusive parameters for channel searches
          const params = {
            channel_id: channelId,
            status: 'live' as VideoStatus,
            sort: 'viewer_count' as keyof VideoRaw & string,
            include: ''
          };

          logger.debug(
            `Fetching streams for channel ${channelId} with params: ${JSON.stringify(params)}`,
            'HolodexService'
          );

          const topicId = 'ember';
          try {
            const videos = await this.client!.getLiveVideos(params);
            // Check if videos is an array before filtering
            if (Array.isArray(videos)) {
              return videos.filter((video) => video.topic && !video.topic.includes(topicId));
            } else {
              logger.warn(`Unexpected response format for channel ${channelId}`, 'HolodexService');
              return [];
            }
          } catch (error) {
            logger.error(`Failed to fetch streams for channel ${channelId}`, 'HolodexService');
            logger.debug(error instanceof Error ? error.message : String(error), 'HolodexService');
            return [];
          }
        });
        const results = await Promise.all(promises);
        
        // Log individual channel results
        channels.forEach((channelId, index) => {
          logger.debug(`Channel ${channelId} returned ${results[index].length} videos`, 'HolodexService');
        });
        
        // Flatten results but maintain channel order
        videos = [];
        channels.forEach((channelId, index) => {
          let channelVideos = results[index];
          // Don't filter by channel ID since we're requesting by channel ID already
          // This fixes issues with collabs where the primary channel ID might not match
          
          if (channelVideos && channelVideos.length > 0) {
            // Sort videos for each channel: live first, then by start time
            channelVideos = channelVideos.filter(video => video.status === 'live')
              .sort((a, b) => {
              if (a.status === 'live' && b.status !== 'live') return -1;
              if (a.status !== 'live' && b.status === 'live') return 1;
              
              // For upcoming streams, sort by available_at
              const aTime = a.availableAt ? new Date(a.availableAt).getTime() : 0;
              const bTime = b.availableAt ? new Date(b.availableAt).getTime() : 0;
              return aTime - bTime;
            });
            
            logger.debug(`Adding ${channelVideos.length} videos from channel ${channelId}`, 'HolodexService');
            videos.push(...channelVideos);
          }
        });
        
        logger.info(`Found ${videos.length} live/upcoming streams from favorite channels`, 'HolodexService');
      } else {
        // Fetch streams by organization or all
        if (organization) {
          params.org = organization;
        }

        logger.debug(`Fetching ${params.limit} live streams${organization ? ` for ${organization}` : ''}`, 'HolodexService');
        videos = await this.client.getLiveVideos(params);
        videos = videos.filter(v => v.status === 'live');
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
      videos = videos.filter(video => video.status === 'live');

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
      let streamSources = filteredVideos.map(video => {
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
          priority: channelOrder !== undefined ? channelOrder : undefined,
          // Tag streams from favorites for easier identification
          subtype: channels?.includes(channelId) ? 'favorites' : undefined
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
          
          // Finally by viewer count
          return (b.viewerCount || 0) - (a.viewerCount || 0);
        });
      } else {
        // For non-favorite streams, sort by:
        // 1. Live status
        // 2. Viewer count
        streamSources.sort((a, b) => {
          // First by live status
          if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
          if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
          
          // Then by viewer count
          return (b.viewerCount || 0) - (a.viewerCount || 0);
        });
      }
      streamSources = streamSources.filter(video => video.sourceStatus === 'live');

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
      logger.info("Favorites Holodex videos: " + videos.map(v => v.videoId).join(", "));
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
      console.error(error);
      return [];
    }
  }

  private isChannelFiltered(video: Video): boolean {
    const channelId = video.channel?.channelId;
    const channelName = video.channel?.name;
    const englishName = video.channel?.englishName;
    
    // If channel is in favorites, don't filter it
    if (channelId && this.favoriteChannels.includes(channelId)) {
      logger.debug(`Channel ${channelName || englishName || channelId} is in favorites, not filtering`, 'HolodexService');
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
    
    // Check if any of the normalized names are in the filters list
    const isFiltered = this.filters.some(filter => {
      const normalizedFilter = filter.toLowerCase().replace(/[\s\-_]+/g, '');
      return normalizedNames.some(name => name?.includes(normalizedFilter));
    });
    
    if (isFiltered) {
      logger.debug(`Channel ${channelName || englishName || channelId} matched filter, excluding from results`, 'HolodexService');
      return true;
    }
    
    return false;
  }

  public updateFavorites(channels: string[]): void {
    if (!channels || !Array.isArray(channels)) {
      logger.warn('Invalid Holodex favorite channels provided, ignoring update', 'HolodexService');
      return;
    }
    
    logger.info(`Updating Holodex favorites with ${channels.length} channels`, 'HolodexService');
    logger.debug(`New Holodex favorites: ${channels.join(', ')}`, 'HolodexService');
    this.favoriteChannels = channels;
  }
} 
