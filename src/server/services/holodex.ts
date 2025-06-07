import { HolodexApiClient, VideoStatus, VideoType, type Video } from 'holodex.js';
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

  async getLiveStreams(options: GetLiveStreamsOptions = {}): Promise<StreamSource[]> {
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
      const channels = options?.channels || [];

      // If we have specific channels to check
      if (channels.length > 0) {
        return this.getStreamsByChannels(channels);
      }
      
      // Otherwise, fetch by organization or all streams
      if (organization) {
        params.org = organization;
        logger.debug(`Fetching streams for organization: ${organization}`, 'HolodexService');
      }

      logger.debug(`Fetching ${params.limit} live streams${organization ? ` for ${organization}` : ''}`, 'HolodexService');
      const videos = await this.client.getLiveVideos(params);
      
      // Only include live streams
      const liveVideos = videos.filter((video: Video) => video.status === 'live' as VideoStatus);
      
      logger.info(`Found ${liveVideos.length} live streams`, 'HolodexService');
      if (liveVideos.length > 0) {
        const sampleStreams = liveVideos.slice(0, 3).map(v => ({
          title: v.title,
          channel: v.channel?.name,
          viewers: v.liveViewers,
          id: v.videoId
        }));
        logger.debug(`Sample streams: ${JSON.stringify(sampleStreams)}`, 'HolodexService');
      }

      // Map to StreamSource format
      return liveVideos.map(video => ({
        url: `https://youtube.com/watch?v=${video.videoId}`,
        title: video.title,
        platform: 'youtube' as const,
        viewerCount: video.liveViewers || 0,
        channelId: video.channel?.channelId || '',
        channelName: video.channel?.name || 'Unknown Channel',
        organization: video.channel?.organization,
        sourceStatus: 'live' as const,
        startTime: video.actualStart 
          ? new Date(video.actualStart).getTime() 
          : video.availableAt 
            ? new Date(video.availableAt).getTime() 
            : Date.now()
      }));
    } catch (error) {
      logger.error(
        'Error fetching live streams from Holodex',
        'HolodexService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  private async getStreamsByChannels(channelIds: string[]): Promise<StreamSource[]> {
    if (!this.client) return [];
    
    try {
      // Process channels in parallel
      const results = await Promise.all(
        channelIds
          .filter(Boolean)
          .map(channelId => this.fetchChannelVideos(channelId))
      );
      
      // Process results and log channel stats
      const channelStats = new Map<string, number>();
      const liveVideos: Video[] = [];
      
      results.forEach((videos, index) => {
        const channelId = channelIds[index];
        if (!videos || !Array.isArray(videos)) {
          logger.warn(`Unexpected response format for channel ${channelId}`, 'HolodexService');
          channelStats.set(channelId, 0);
          return;
        }
        logger.info(`Channel ${channelId} returned ${videos.length} videos`, 'HolodexService');
        logger.info(`Channel ${channelId} videos: ${videos.map(v => v.status).join(', ')}`, 'HolodexService');
        // Filter out non-live and ember-topic videos
        const filteredVideos = videos.filter((video: Video) => 
          video.status === 'live' as VideoStatus && 
          (!video.topic || !video.topic.includes('ember'))
        );
        
        channelStats.set(channelId, filteredVideos.length);
        liveVideos.push(...filteredVideos);
      });

      // Log channel stats
      channelStats.forEach((count, channelId) => {
        logger.debug(`Channel ${channelId} returned ${count} live videos`, 'HolodexService');
      });
      
      logger.info(`Found ${liveVideos.length} live streams from ${channelStats.size} channels`, 'HolodexService');

      // Map to StreamSource with explicit sourceStatus and proper type handling
      return liveVideos.map(video => {
        // Safely get the video ID, handling both Video and legacy formats
        const videoId = (video as Video).videoId || '';
        
        // Safely get the published date, handling different possible properties
        const publishedDate = 'publishedAt' in video && video.publishedAt ? 
                            video.publishedAt :
                            'published_at' in video && typeof (video as { published_at?: unknown }).published_at === 'string' ? 
                            (video as { published_at: string }).published_at :
                            undefined;
        
        return {
          url: `https://youtube.com/watch?v=${videoId}`,
          title: video.title || 'Untitled Stream',
          platform: 'youtube' as const,
          viewerCount: video.liveViewers || 0,
          channelId: video.channel?.channelId || '',
          channelName: video.channel?.name || 'Unknown Channel',
          organization: video.channel?.organization,
          sourceStatus: 'live' as const,
          startTime: video.actualStart 
            ? new Date(video.actualStart).getTime() 
            : video.availableAt 
              ? new Date(video.availableAt).getTime()
              : publishedDate
                ? new Date(publishedDate).getTime()
                : Date.now()
        };
      });
    } catch (error) {
      logger.error(
        'Error fetching channel streams from Holodex',
        'HolodexService',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  private async fetchChannelVideos(channelId: string): Promise<Video[]> {
    if (!this.client) return [];
    
    try {
      const videos = await this.client.getLiveVideos({
        channel_id: channelId,
        status: VideoStatus.Live,
        type: VideoType.Stream
      });
      
      return Array.isArray(videos) ? videos.filter(v => v.status === VideoStatus.Live) : [];
    } catch (error) {
      logger.error(
        `Failed to fetch videos for channel ${channelId}`,
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
