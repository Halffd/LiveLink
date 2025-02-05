import type { 
  StreamSource, 
  StreamOptions, 
  StreamLimits, 
  StreamSourceType,
  StreamSourceConfig
} from '../types/stream.js';
import type { 
  StreamOutput, 
  StreamError, 
  StreamInstance,
  StreamResponse 
} from '../types/stream_instance.js';
import { logger } from './services/logger.js';
import { loadAllConfigs } from '../config/loader.js';
import { TwitchService } from './services/twitch.js';
import { HolodexService } from './services/holodex.js';
import { PlayerService } from './services/player.js';
import type { TwitchAuth } from './db/database.js';
import { env } from '../config/env.js';

/**
 * Manages multiple video streams across different screens
 */
export class StreamManager {
  private streams: Map<number, StreamInstance> = new Map();
  private config = loadAllConfigs();
  private twitchService: TwitchService;
  private holodexService: HolodexService;
  private playerService: PlayerService;
  private streamQueue: Map<number, StreamSource[]> = new Map(); // Add queue per screen

  /**
   * Creates a new StreamManager instance
   */
  constructor() {
    this.twitchService = new TwitchService(
      env.TWITCH_CLIENT_ID,
      env.TWITCH_CLIENT_SECRET,
      [] // We'll handle filters differently
    );

    this.holodexService = new HolodexService(
      env.HOLODEX_API_KEY,
      [], // We'll handle filters differently
      this.config.favoriteChannels,
      this.config
    );

    this.playerService = new PlayerService();
    logger.info('Stream manager initialized', 'StreamManager');

    this.playerService.onStreamError(async (data) => {
      // Only handle non-retrying streams to avoid duplicate handling
      if (!this.playerService.isRetrying(data.screen)) {
        logger.info(`Stream on screen ${data.screen} ended, finding next stream...`);
        
        // Get current streams if queue is empty
        if (!this.streamQueue.get(data.screen)?.length) {
          const newStreams = await this.getLiveStreams();
          // Filter streams for this screen and not watched yet
          const unwatchedStreams = newStreams.filter(s => 
            s.screen === data.screen && 
            !this.playerService.isStreamWatched(s.url)
          );
          this.streamQueue.set(data.screen, unwatchedStreams);
        }

        // Get next stream from queue
        const queue = this.streamQueue.get(data.screen) || [];
        const nextStream = queue.shift(); // Remove and get first stream
        
        if (nextStream) {
          logger.info(`Starting next stream on screen ${data.screen}: ${nextStream.url}`);
          await this.startStream({
            url: nextStream.url,
            quality: this.config.player.defaultQuality,
            screen: data.screen,
            windowMaximized: this.config.player.windowMaximized
          });
        } else {
          logger.info(`No more unwatched streams for screen ${data.screen}`);
        }
      }
    });
  }

  /**
   * Starts a new stream on the specified screen
   */
  async startStream(options: Partial<StreamOptions> & { url: string }): Promise<StreamResponse> {
    // Find first available screen
    let screen = options.screen;
    if (!screen) {
      const activeScreens = new Set(this.streams.keys());
      for (const streamConfig of this.config.streams) {
        if (!activeScreens.has(streamConfig.id)) {
          screen = streamConfig.id;
          break;
        }
      }
    }

    if (!screen) {
      return {
        screen: options.screen || 1,
        message: 'No available screens'
      };
    }

    const streamConfig = this.config.streams.find(s => s.id === screen);
    if (!streamConfig) {
      return {
        screen,
        message: `Invalid screen number: ${screen}`
      };
    }

    return this.playerService.startStream({
      ...options,
      screen,
      quality: options.quality || streamConfig.quality,
      volume: options.volume || streamConfig.volume,
      windowMaximized: options.windowMaximized ?? streamConfig.windowMaximized
    });
  }

  /**
   * Stops a stream on the specified screen
   */
  async stopStream(screen: number): Promise<boolean> {
    return this.playerService.stopStream(screen);
  }

  /**
   * Gets information about all active streams
   */
  getActiveStreams() {
    return this.playerService.getActiveStreams();
  }

  onStreamOutput(callback: (data: StreamOutput) => void) {
    this.playerService.onStreamOutput(callback);
  }

  onStreamError(callback: (data: StreamError) => void) {
    this.playerService.onStreamError(callback);
  }

  /**
   * Gets available organizations
   */
  getOrganizations(): string[] {
    return this.config.organizations;
  }

  /**
   * Fetches live streams from both Holodex and Twitch based on config
   */
  async getLiveStreams(): Promise<StreamSource[]> {
    try {
      const results: StreamSource[] = [];
      const holodexStreams: StreamSource[] = [];
      const twitchStreams: StreamSource[] = [];

      // Process each stream configuration
      for (const streamConfig of this.config.streams) {
        if (!streamConfig.enabled) continue;

        for (const source of streamConfig.sources) {
          if (!source.enabled) continue;

          if (source.type === 'holodex') {
            // Handle both favorites and organization streams
            if (source.subtype === 'favorites') {
              const streams = await this.holodexService.getFavoriteStreams();
              streams.forEach(s => s.screen = streamConfig.screen);
              holodexStreams.push(...streams);
            } else if (source.subtype === 'organization' && source.name) {
              const streams = await this.holodexService.getLiveStreams({
                organization: source.name,
                limit: source.limit
              });
              streams.forEach(s => s.screen = streamConfig.screen);
              holodexStreams.push(...streams);
            }
          } else if (source.type === 'twitch') {
            // Use getVTuberStreams if vtuber tag is present
            const streams = source.tags?.includes('vtuber') 
              ? await this.twitchService.getVTuberStreams(source.limit)
              : await this.twitchService.getStreams(source.limit, {
                  tags: source.tags,
                  language: source.language
                });
            streams.forEach(s => s.screen = streamConfig.screen);
            twitchStreams.push(...streams);
          }
        }
      }

      // Sort and combine streams
      results.push(...holodexStreams, ...twitchStreams);
      
      // Debug log the results
      logger.debug(`Found ${results.length} streams (${holodexStreams.length} Holodex, ${twitchStreams.length} Twitch)`, 'StreamManager');
      logger.debug(`Stream details: ${JSON.stringify(results.map(s => ({
        url: s.url,
        screen: s.screen,
        platform: s.platform
      })))}`, 'StreamManager');

      return results;
    } catch (error) {
      logger.error(
        'Failed to fetch live streams',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }

  /**
   * Gets VTuber streams from Twitch
   */
  async getVTuberStreams(limit = 50): Promise<StreamSource[]> {
    return this.twitchService.getVTuberStreams(limit);
  }

  /**
   * Gets Japanese language streams
   */
  async getJapaneseStreams(limit = 50): Promise<StreamSource[]> {
    return this.twitchService.getJapaneseStreams(limit);
  }

  /**
   * Sets up user authentication for Twitch
   */
  async setTwitchUserAuth(auth: TwitchAuth): Promise<void> {
    await this.twitchService.setUserAuth(auth);
  }

  /**
   * Gets streams from user's followed channels
   */
  async getFollowedStreams(userId: string): Promise<StreamSource[]> {
    return this.twitchService.getFollowedStreams(userId);
  }

  async autoStartStreams() {
    if (!this.config.player.autoStart) return;

    try {
      const streams = await this.getLiveStreams();
      logger.info(`Auto-starting ${streams.length} streams`, 'StreamManager');
      
      // Group streams by screen and initialize queues
      const streamsByScreen = new Map<number, StreamSource[]>();
      streams.forEach(stream => {
        if (stream.screen) {
          const screenStreams = streamsByScreen.get(stream.screen) || [];
          screenStreams.push(stream);
          streamsByScreen.set(stream.screen, screenStreams);
        }
      });

      // Debug log the grouped streams
      logger.debug(`Grouped streams by screen: ${JSON.stringify(Object.fromEntries(streamsByScreen))}`, 'StreamManager');

      // Start first stream for each screen and queue the rest
      for (const [screen, screenStreams] of streamsByScreen) {
        // Sort streams by view count if specified in config
        const screenConfig = this.config.streams.find(s => s.id === screen);
        if (screenConfig?.sorting?.field === 'viewerCount') {
          screenStreams.sort((a, b) => {
            const aCount = a.viewerCount || 0;
            const bCount = b.viewerCount || 0;
            return screenConfig.sorting.order === 'desc' ? bCount - aCount : aCount - bCount;
          });
        }

        const [firstStream, ...remainingStreams] = screenStreams;
        if (firstStream) {
          logger.info(`Starting stream ${firstStream.url} on screen ${screen}`);
          await this.startStream({
            url: firstStream.url,
            quality: screenConfig?.quality || this.config.player.defaultQuality,
            screen: screen,
            windowMaximized: screenConfig?.windowMaximized ?? this.config.player.windowMaximized
          });

          // Queue remaining streams for this screen
          if (remainingStreams.length > 0) {
            this.streamQueue.set(screen, remainingStreams);
            logger.debug(`Queued ${remainingStreams.length} streams for screen ${screen}`, 'StreamManager');
          }
        }
      }

    } catch (error) {
      logger.error(
        'Failed to auto-start streams',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}

// Create and export stream manager instance
export const streamManager = new StreamManager(); 