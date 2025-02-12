import type { 
  StreamSource, 
  StreamOptions, 
  StreamLimits, 
  StreamSourceType,
  StreamSourceConfig,
  FavoriteChannels
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
import { queueService } from './services/queue_service.js';

/**
 * Manages multiple video streams across different screens
 */
export class StreamManager {
  private streams: Map<number, StreamInstance> = new Map();
  private config = loadAllConfigs();
  private twitchService: TwitchService;
  private holodexService: HolodexService;
  private playerService: PlayerService;
  private cleanupHandler: (() => void) | null = null;
  private isShuttingDown = false;
  private favoriteChannels: FavoriteChannels;

  /**
   * Creates a new StreamManager instance
   */
  constructor() {
    // No need for type assertion since Config type is properly defined
    this.favoriteChannels = this.config.favoriteChannels;

    this.twitchService = new TwitchService(
      env.TWITCH_CLIENT_ID,
      env.TWITCH_CLIENT_SECRET,
      this.config.filters?.filters || [] // Handle potential undefined filters
    );

    this.holodexService = new HolodexService(
      env.HOLODEX_API_KEY,
      this.config.filters?.filters || [], // Handle potential undefined filters
      this.favoriteChannels.holodex,
      this.config
    );

    this.playerService = new PlayerService();
    logger.info('Stream manager initialized', 'StreamManager');

    this.playerService.onStreamError(async (data) => {
      if (!this.playerService.isRetrying(data.screen) && !this.isShuttingDown) {
        await this.handleStreamEnd(data.screen);
      }
    });

    // Update cleanup handler
    this.cleanupHandler = () => {
      logger.info('Cleaning up stream processes...', 'StreamManager');
      this.isShuttingDown = true;
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

    // Set up queue event handlers
    queueService.on('all:watched', async (screen) => {
      if (!this.isShuttingDown) {
        await this.handleAllStreamsWatched(screen);
      }
    });

    queueService.on('queue:empty', async (screen) => {
      if (!this.isShuttingDown) {
        await this.handleEmptyQueue(screen);
      }
    });
  }

  private async handleStreamEnd(screen: number) {
    logger.info(`Stream on screen ${screen} ended, finding next stream...`);
    
    // Try to get next stream from current queue
    const nextStream = queueService.getNextStream(screen);
    if (nextStream) {
      await this.startStream({
        url: nextStream.url,
        screen: screen,
        quality: this.config.player.defaultQuality,
        windowMaximized: this.config.player.windowMaximized
      });
      return;
    }

    // If no next stream, try to fetch new streams
    await this.handleEmptyQueue(screen);
  }

  private async handleEmptyQueue(screen: number) {
    logger.info(`Queue empty for screen ${screen}, fetching new streams...`);
    const newStreams = await this.getLiveStreams();
    const screenStreams = newStreams.filter(s => s.screen === screen);
    
    // Check if there are any unwatched streams
    const unwatchedStreams = queueService.filterUnwatchedStreams(screenStreams);
    if (unwatchedStreams.length === 0) {
      await this.handleAllStreamsWatched(screen);
      return;
    }
    
    queueService.setQueue(screen, unwatchedStreams);
  }

  private async handleAllStreamsWatched(screen: number) {
    logger.info(`All streams watched for screen ${screen}, waiting before refetching...`);
    
    // Wait a bit before refetching to avoid hammering the APIs
    await new Promise(resolve => setTimeout(resolve, 30000)); // 30 second delay
    
    if (!this.isShuttingDown) {
      await this.handleEmptyQueue(screen);
    }
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
  async getLiveStreams(retryCount = 0): Promise<StreamSource[]> {
    try {
      const results: StreamSource[] = [];
      const seenUrlsByScreen = new Map<number, Set<string>>(); // Track unique streams per screen
      
      // Process each screen's sources
      for (const streamConfig of this.config.streams) {
        if (!streamConfig.enabled) {
          logger.debug('Screen %s is disabled, skipping', String(streamConfig.id));
          continue;
        }

        // Initialize seen URLs set for this screen
        seenUrlsByScreen.set(streamConfig.id, new Set<string>());
        logger.debug('Processing sources for screen %s', String(streamConfig.id));

        // Sort sources by priority before processing
        const sortedSources = [...streamConfig.sources]
          .filter(source => source.enabled)
          .sort((a, b) => (a.priority || 999) - (b.priority || 999));

        const sourceList = sortedSources
          .map(s => `${s.type}${s.subtype ? `:${s.subtype}` : ''} (priority: ${s.priority})`)
          .join(', ');
        logger.debug('Enabled sources for screen %s: %s', String(streamConfig.id), sourceList);

        for (const source of sortedSources) {
          const limit = source.limit || 25;
          const streams: StreamSource[] = [];

          if (source.type === 'holodex') {
            if (source.subtype === 'favorites') {
              logger.debug('Fetching %s favorite Holodex streams from %s channels', 
                String(limit), String(this.favoriteChannels.holodex.length));
              streams.push(...await this.holodexService.getLiveStreams({
                channels: this.favoriteChannels.holodex,
                limit: limit * 2 // Increase limit to get more streams
              }));
              logger.debug('Fetched %s favorite Holodex streams for screen %s', 
                String(streams.length), String(streamConfig.id));
            } else if (source.subtype === 'organization' && source.name) {
              if (results.some(s => s.screen === streamConfig.id && s.sourceName?.includes('favorites'))) {
                logger.debug('Skipping %s streams as we already have favorite streams for screen %s', 
                  source.name, String(streamConfig.id));
                continue;
              }
              logger.debug('Fetching %s %s streams', String(limit), source.name);
              streams.push(...await this.holodexService.getLiveStreams({
                organization: source.name,
                limit: limit * 2 // Increase limit to get more streams
              }));
              logger.debug('Fetched %s %s streams for screen %s', 
                String(streams.length), source.name, String(streamConfig.id));
            }
          } else if (source.type === 'twitch') {
            if (source.subtype === 'favorites') {
              const favoriteStreams = await this.twitchService.getStreams({
                limit: limit * 2 // Increase limit to get more streams
              }, this.favoriteChannels.twitch);
              favoriteStreams.reverse();
              streams.push(...favoriteStreams);
              logger.debug('Fetched %s favorite Twitch streams for screen %s', 
                String(streams.length), String(streamConfig.id));
            } else if (source.tags) {
              if (results.some(s => s.screen === streamConfig.id && s.sourceName?.includes('favorites'))) {
                logger.debug('Skipping tagged Twitch streams as we already have favorite streams for screen %s', 
                  String(streamConfig.id));
                continue;
              }
              streams.push(...await this.twitchService.getStreams({
                limit: limit * 2, // Increase limit to get more streams
                tags: source.tags
              }));
              logger.debug('Fetched %s tagged Twitch streams for screen %s', 
                String(streams.length), String(streamConfig.id));
            }
          }

          // Filter out duplicate streams only within the same screen
          if (streams.length > 0) {
            logger.debug('Adding %s streams from %s%s to screen %s', 
              String(streams.length), 
              source.type,
              source.subtype ? `:${source.subtype}` : '',
              String(streamConfig.id)
            );

            const seenUrls = seenUrlsByScreen.get(streamConfig.id)!;
            streams
              .filter(stream => !seenUrls.has(stream.url)) // Only filter duplicates within same screen
              .forEach(stream => {
                seenUrls.add(stream.url); // Mark as seen for this screen
                results.push({
                  ...stream,
                  screen: streamConfig.id,
                  priority: source.priority,
                  source: source.type,
                  sourceName: source.subtype === 'favorites' 
                    ? `${source.type} favorites`
                    : source.name || source.type
                });
              });

            // If we have favorite streams, skip lower priority sources for this screen
            if (source.subtype === 'favorites' && streams.length > 0) {
              logger.debug('Found %s favorite streams for screen %s, skipping lower priority sources', 
                String(streams.length), String(streamConfig.id));
              break;
            }
          }
        }

        // After collecting all streams for a screen, sort them according to config
        const screenResults = results.filter(s => s.screen === streamConfig.id);
        logger.info('Total streams found for screen %d: %d', 
          String(streamConfig.id), String(screenResults.length));

        if (screenResults.length > 0) {
          logger.info('First stream for screen %d: %s (Priority: %d)', 
            String(streamConfig.id), 
            screenResults[0].sourceName || 'Unknown Source',
            String(screenResults[0].priority || 999)
          );
        }
      }

      // Final sort of all streams by priority and source type
      const streamsByPriority = new Map<number, StreamSource[]>();
      
      // First, group streams by priority
      results.forEach(stream => {
        const priority = stream.priority ?? 999;
        if (!streamsByPriority.has(priority)) {
          streamsByPriority.set(priority, []);
        }
        streamsByPriority.get(priority)!.push(stream);
      });

      // Sort each priority group separately
      const sortedResults: StreamSource[] = [];
      
      // Process priorities in ascending order (lower number = higher priority)
      Array.from(streamsByPriority.keys())
        .sort((a, b) => a - b)
        .forEach(priority => {
          const streamsInPriority = streamsByPriority.get(priority)!;
          
          // Separate streams by source type
          const favoriteStreams = streamsInPriority.filter(s => s.sourceName?.includes('favorites'));
          const nonFavoriteStreams = streamsInPriority.filter(s => !s.sourceName?.includes('favorites'));
          
          // Sort non-favorites by viewer count (descending)
          nonFavoriteStreams.sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0));
          
          // Add favorites first (in original order), then sorted non-favorites
          sortedResults.push(...favoriteStreams, ...nonFavoriteStreams);
        });

      // Replace the results array with our properly sorted streams
      results.length = 0;
      results.push(...sortedResults);

      // Add debug logging
      logger.info('Sorted streams:', 'StreamManager');
      results.forEach(s => {
        logger.info(
          `  Priority: ${s.priority}, ` +
          `Viewers: ${s.viewerCount}, ` +
          `Platform: ${s.platform}, ` +
          `Source: ${s.sourceName}, ` +
          `Title: ${s.title?.substring(0, 30)}...`,
          'StreamManager'
        );
      });

      if (results.length === 0 && retryCount < 3) {
        logger.info(`No streams found, retrying (attempt ${retryCount + 1})...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return this.getLiveStreams(retryCount + 1);
      }

      return results;
    } catch (error) {
      logger.error(
        'Failed to fetch live streams',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      
      if (retryCount < 3) {
        logger.info(`Error fetching streams, retrying (attempt ${retryCount + 1})...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        return this.getLiveStreams(retryCount + 1);
      }
      
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
      
      // Group streams by screen
      const streamsByScreen = new Map<number, StreamSource[]>();
      
      // First, group streams by their assigned screen
      streams.forEach(stream => {
        if (!stream.screen) return;
        
        const screenStreams = streamsByScreen.get(stream.screen) || [];
        screenStreams.push(stream);
        streamsByScreen.set(stream.screen, screenStreams);
      });

      // Process each screen's streams
      for (const [screen, allScreenStreams] of streamsByScreen) {
        const screenConfig = this.config.streams.find(s => s.id === screen);
        if (!screenConfig || !screenConfig.enabled) continue;

        // Group streams by priority
        const streamsByPriority = new Map<number, StreamSource[]>();
        
        // First, group streams by priority
        allScreenStreams.forEach(stream => {
          const priority = stream.priority ?? 999;
          if (!streamsByPriority.has(priority)) {
            streamsByPriority.set(priority, []);
          }
          streamsByPriority.get(priority)!.push(stream);
        });

        // Sort each priority group separately
        const sortedStreams: StreamSource[] = [];
        
        // Process priorities in ascending order (lower number = higher priority)
        Array.from(streamsByPriority.keys())
          .sort((a, b) => a - b)
          .forEach(priority => {
            const streamsInPriority = streamsByPriority.get(priority)!;
            
            // Separate streams by source type
            const favoriteStreams = streamsInPriority.filter(s => s.sourceName?.includes('favorites'));
            const nonFavoriteStreams = streamsInPriority.filter(s => !s.sourceName?.includes('favorites'));
            
            // Sort non-favorites by viewer count (descending)
            nonFavoriteStreams.sort((a, b) => (b.viewerCount ?? 0) - (a.viewerCount ?? 0));
            
            // Add favorites first (in original order), then sorted non-favorites
            sortedStreams.push(...favoriteStreams, ...nonFavoriteStreams);
          });

        // Get unwatched streams
        const unwatchedStreams = queueService.filterUnwatchedStreams(sortedStreams);
        
        if (unwatchedStreams.length === 0) {
          logger.info(`No unwatched streams for screen ${screen}`, 'StreamManager');
          continue;
        }

        // Start first stream
        const [firstStream, ...remainingStreams] = unwatchedStreams;
        if (firstStream) {
          logger.info(`Starting stream on screen ${screen}: ${firstStream.url} (${firstStream.platform})`);
          logger.info(`Stream details: Priority ${firstStream.priority}, Source: ${firstStream.sourceName}`, 'StreamManager');
          
          await this.startStream({
            url: firstStream.url,
            quality: screenConfig.quality || this.config.player.defaultQuality,
            screen: screen,
            volume: screenConfig.volume,
            windowMaximized: screenConfig.windowMaximized
          });

          // Queue remaining streams
          if (remainingStreams.length > 0) {
            queueService.setQueue(screen, remainingStreams);
            logger.info(
              `Queued ${remainingStreams.length} streams for screen ${screen}. ` +
              `First in queue: ${remainingStreams[0].sourceName} (Priority: ${remainingStreams[0].priority})`,
              'StreamManager'
            );
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