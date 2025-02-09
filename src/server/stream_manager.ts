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
  private cleanupHandler: (() => void) | null = null;

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

    // Set up cleanup handler
    this.cleanupHandler = () => {
      logger.info('Cleaning up stream processes...', 'StreamManager');
      for (const [screen] of this.streams) {
        this.stopStream(screen).catch(error => {
          logger.error(
            `Failed to stop stream on screen ${screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        });
      }
      process.exit(0);
    };

    // Register cleanup handlers
    process.on('SIGINT', this.cleanupHandler);
    process.on('SIGTERM', this.cleanupHandler);
    process.on('exit', this.cleanupHandler);
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
      
      // Process each screen's sources
      for (const streamConfig of this.config.streams) {
        if (!streamConfig.enabled) continue;

        for (const source of streamConfig.sources) {
          if (source.type === 'holodex') {
            // If source name is "All", fetch all streams without organization filter
            if (source.name === 'All') {
              const streams = await this.holodexService.getLiveStreams();
              streams.forEach((stream: StreamSource) => {
                results.push({
                  ...stream,
                  screen: streamConfig.id
                });
              });
            } else {
              const streams = await this.holodexService.getLiveStreams({
                organization: source.name
              });
              streams.forEach((stream: StreamSource) => {
                results.push({
                  ...stream,
                  screen: streamConfig.id
                });
              });
            }
          } else if (source.type === 'twitch') {
            const streams = await this.twitchService.getStreams();
            streams.forEach((stream: StreamSource) => {
              results.push({
                ...stream,
                screen: streamConfig.id
              });
            });
          }
        }
      }

      // Debug log the results
      logger.debug(`Found ${results.length} streams`, 'StreamManager');
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
      const usedUrls = new Set<string>();
      
      // Initialize empty arrays for each enabled screen
      this.config.streams.forEach(streamConfig => {
        if (streamConfig.enabled) {
          streamsByScreen.set(streamConfig.id, []);
        }
      });

      // First, assign streams to their configured screens
      for (const streamConfig of this.config.streams) {
        if (!streamConfig.enabled) continue;

        const screenStreams = streamsByScreen.get(streamConfig.id) || [];
        
        // Filter streams for this screen
        const availableStreams = streams.filter(stream => 
          !usedUrls.has(stream.url) && 
          !this.playerService.isStreamWatched(stream.url) &&
          streamConfig.sources.some(source => 
            (source.type === 'holodex' && stream.platform === 'youtube') ||
            (source.type === 'twitch' && stream.platform === 'twitch')
          )
        );

        // Add streams to this screen's list
        availableStreams.forEach(stream => {
          screenStreams.push({
            ...stream,
            screen: streamConfig.id
          });
          usedUrls.add(stream.url);
        });

        streamsByScreen.set(streamConfig.id, screenStreams);
      }

      // Process each screen's streams
      for (const [screen, screenStreams] of streamsByScreen) {
        const screenConfig = this.config.streams.find(s => s.id === screen);
        if (!screenConfig || screenStreams.length === 0) {
          logger.debug(`No streams available for screen ${screen}`);
          continue;
        }

        // Sort streams if needed
        if (screenConfig?.sorting?.field === 'viewerCount') {
          const platformPriorities = new Map<string, number>();
          screenConfig.sources.forEach((source, index) => {
            if (source.type === 'holodex') {
              platformPriorities.set('youtube', index);
            } else if (source.type === 'twitch') {
              platformPriorities.set('twitch', index);
            }
          });

          screenStreams.sort((a, b) => {
            const aPriority = platformPriorities.get(a.platform) ?? 999;
            const bPriority = platformPriorities.get(b.platform) ?? 999;
            if (aPriority !== bPriority) return aPriority - bPriority;
            
            const aCount = a.viewerCount || 0;
            const bCount = b.viewerCount || 0;
            return screenConfig.sorting.order === 'desc' ? bCount - aCount : aCount - bCount;
          });
        }

        // Start first stream and queue the rest
        const [firstStream, ...remainingStreams] = screenStreams;
        if (firstStream) {
          logger.info(`Starting stream on screen ${screen}: ${firstStream.url} (${firstStream.platform})`);
          
          await this.startStream({
            url: firstStream.url,
            quality: screenConfig?.quality || this.config.player.defaultQuality,
            screen: screen,
            windowMaximized: screenConfig?.windowMaximized ?? this.config.player.windowMaximized
          });

          // Set queue for this screen only
          if (remainingStreams.length > 0) {
            this.streamQueue.set(screen, remainingStreams);
            logger.debug(`Queued ${remainingStreams.length} streams for screen ${screen}`);
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

  cleanup() {
    if (this.cleanupHandler) {
      this.cleanupHandler();
    }
  }
}

// Create and export stream manager instance
export const streamManager = new StreamManager(); 