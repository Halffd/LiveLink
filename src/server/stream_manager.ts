import type { 
  StreamSource, 
  StreamOptions, 
  PlayerSettings,
  Config,
  FavoriteChannels,
  StreamResponse,
  ScreenConfig
} from '../types/stream.js';
import type { 
  StreamOutput, 
  StreamError, 
  StreamInstance,
  StreamPlatform
} from '../types/stream_instance.js';
import { logger } from './services/logger.js';
import { loadAllConfigs } from '../config/loader.js';
import { TwitchService } from './services/twitch.js';
import { HolodexService } from './services/holodex.js';
import { YouTubeService } from './services/youtube.js';
import { PlayerService } from './services/player.js';
import type { TwitchAuth } from './db/database.js';
import { env } from '../config/env.js';
import { queueService } from './services/queue_service.js';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { KeyboardService } from './services/keyboard_service.js';
import './types/events.js';

/**
 * Manages multiple video streams across different screens
 */
export class StreamManager extends EventEmitter {
  private streams: Map<number, StreamInstance> = new Map();
  private config: Config;
  private twitchService: TwitchService;
  private holodexService: HolodexService;
  private youtubeService: YouTubeService;
  private playerService: PlayerService;
  private keyboardService: KeyboardService;
  private cleanupHandler: (() => void) | null = null;
  private isShuttingDown = false;
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly QUEUE_UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
  private readonly STREAM_START_TIMEOUT = 30 * 1000; // 30 seconds timeout for stream start
  private readonly QUEUE_PROCESSING_TIMEOUT = 60 * 1000; // 1 minute timeout for queue processing
  private readonly STREAM_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes refresh interval (increased from 5)
  private favoriteChannels: FavoriteChannels = {
    groups: {
      default: {
        description: 'Default favorite channels',
        priority: 100
      }
    },
    holodex: { default: [] },
    twitch: { default: [] },
    youtube: { default: [] }
  };
  private queues: Map<number, StreamSource[]> = new Map();
  private readonly RETRY_INTERVAL = 10000; // 10 seconds (increased from 5 seconds)
  private errorCallback?: (data: StreamError) => void;
  private manuallyClosedScreens: Set<number> = new Set();
  private streamRetries: Map<number, number> = new Map();
  private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
  private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
  private fifoPaths: Map<number, string> = new Map();
  private ipcPaths: Map<number, string> = new Map();
  private cachedStreams: StreamSource[] = []; // Cache for stream metadata
  private lastStreamFetch: number = 0; // Timestamp of last stream fetch
  private readonly STREAM_CACHE_TTL = 120000; // 2 minute cache TTL (increased from 1 minute)
  private queueProcessing: Set<number> = new Set(); // Track screens where queue is being processed
  private lastStreamRefresh: Map<number, number> = new Map(); // Track last refresh time per screen
  private screenConfigs: Map<number, ScreenConfig> = new Map();
  private isOffline = false; // Added for network recovery logic
  private queueProcessingStartTimes: Map<number, number> = new Map();
  private queueProcessingTimeouts: Map<number, NodeJS.Timeout> = new Map();

  /**
   * Creates a new StreamManager instance
   */
  constructor(
    config: Config,
    holodexService: HolodexService,
    twitchService: TwitchService,
    youtubeService: YouTubeService,
    playerService: PlayerService,
    keyboardService: KeyboardService
  ) {
    super();
    this.config = config;
    this.twitchService = twitchService;
    this.holodexService = holodexService;
    this.youtubeService = youtubeService;
    this.playerService = playerService;
    this.keyboardService = keyboardService;

    // Setup screen configurations
    this.screenConfigs = new Map(this.config.player.screens.map(screen => [
      screen.screen,
      {
        screen: screen.screen,
        id: screen.id || screen.screen,
        enabled: screen.enabled,
        volume: screen.volume || this.config.player.defaultVolume,
        quality: screen.quality || this.config.player.defaultQuality,
        windowMaximized: screen.windowMaximized ?? this.config.player.windowMaximized,
        sources: [],
        sorting: { field: 'viewerCount', order: 'desc' },
        refresh: 300,
        autoStart: true
      }
    ]));

    // Handle stream events from player service
    this.playerService.onStreamError((data) => {
      logger.info(`Stream error on screen ${data.screen}: ${data.error}`, 'StreamManager');
      
      // Don't handle retrying streams or during shutdown
      if (this.playerService.isRetrying(data.screen) || this.isShuttingDown) {
        return;
      }
      
      if (data.moveToNext) {
        this.handleStreamEnd(data.screen).catch(error => {
          logger.error(
            `Failed to handle stream end for screen ${data.screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        });
      }
    });

    this.playerService.onStreamEnd((data) => {
      logger.info(`Stream ended on screen ${data.screen}`, 'StreamManager');
      
      // Don't handle retrying streams or during shutdown
      if (this.playerService.isRetrying(data.screen) || this.isShuttingDown) {
        return;
      }

      this.handleStreamEnd(data.screen).catch(error => {
        logger.error(
          `Failed to handle stream end for screen ${data.screen}`,
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }).finally(() => {
        // Clean up processing state
        const timeout = this.queueProcessingTimeouts.get(data.screen);
        if (timeout) {
          clearTimeout(timeout);
          this.queueProcessingTimeouts.delete(data.screen);
        }
        this.queueProcessing.delete(data.screen);
      });
    });

    this.initializeQueues();
    this.startQueueUpdates();
    this.setupNetworkRecovery();
    this.setupTestSignalHandlers();

    // Initialize stream cleanup
    this.setupStreamCleanup();
  }

  // Add signal handlers for testing purposes
  private setupTestSignalHandlers(): void {
    // Only set up these handlers in test environment
    if (process.env.NODE_ENV === 'test') {
      // SIGUSR1: Simulate network disconnection
      process.on('SIGUSR1', () => {
        logger.warn('Test signal received: Simulating network disconnection', 'StreamManager');
        this.isOffline = true;
        
        // Emit a custom event for testing
        this.emit('network:offline', { timestamp: Date.now() });
      });

      // SIGUSR2: Simulate network reconnection
      process.on('SIGUSR2', () => {
        logger.warn('Test signal received: Simulating network reconnection', 'StreamManager');
        this.isOffline = false;
        
        // Trigger recovery process
        this.emit('network:online', { timestamp: Date.now(), duration: 0 });
        
        // Reset the refresh timestamps to force queue updates
        const enabledScreens = this.getEnabledScreens();
        this.resetRefreshTimestamps(enabledScreens);
        
        // Force a queue refresh
        this.forceQueueRefresh().catch(error => {
          logger.error('Failed to refresh queues after simulated network recovery', 'StreamManager', 
            error instanceof Error ? error : new Error(String(error))
          );
        });
      });
      
      logger.info('Test signal handlers for network simulation initialized', 'StreamManager');
    }
  }

  private async handleStreamEnd(screen: number): Promise<void> {
    // Clear any existing processing state
    this.queueProcessing.delete(screen);
    this.clearQueueProcessingTimeout(screen);

    // Get the current stream before stopping it so we can mark it as watched
    const currentStream = this.streams.get(screen);
    if (currentStream && currentStream.url !== this.playerService.DUMMY_SOURCE) {
      // Mark the current stream as watched when it ends
      queueService.markStreamAsWatched(currentStream.url);
      logger.info(`Marking ended stream as watched: ${currentStream.url}`, 'StreamManager');
    }

    // Make sure the player service has fully stopped the previous stream
    // This ensures we don't have IPC connection issues with the next stream
    await this.playerService.stopStream(screen, true);
    
    // Add a small delay to ensure resources are properly released
    await new Promise(resolve => setTimeout(resolve, 300)); // Reduced from 500ms

    // Special handling for screen 1 - skip processing check delays
    if (screen === 1) {
      const nextStream = this.queues.get(screen)?.[0];
      if (nextStream) {
        try {
          // Check if stream is already watched before starting
          if (this.isStreamWatched(nextStream.url)) {
            logger.info(`Stream ${nextStream.url} is already watched, skipping`, 'StreamManager');
            // Remove the stream from queue and process the next one
            const queue = this.queues.get(screen) || [];
            queue.shift();
            this.queues.set(screen, queue);
            // Continue to the next stream
            await this.handleStreamEnd(screen);
            return;
          }

          // Remove the stream from queue before starting it
          const queue = this.queues.get(screen) || [];
          queue.shift();
          this.queues.set(screen, queue);
          logger.info(`Starting next stream in queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');
          // The stream is already at index 0 and we've removed it from our internal queue
          
          await this.startStream({
            url: nextStream.url,
            screen,
            quality: 'best',
            windowMaximized: true
          });
          return;
        } catch (error: unknown) {
          logger.error(
            `Failed to start next stream on screen ${screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
      return;
    }

    // For other screens, use the normal processing logic
    if (this.queueProcessing.has(screen)) {
      logger.debug(`Queue already being processed for screen ${screen}`, 'StreamManager');
      return;
    }

    this.queueProcessing.add(screen);
    this.queueProcessingStartTimes.set(screen, Date.now());

    try {
      const currentStream = this.streams.get(screen);
      if (currentStream?.url === this.playerService.DUMMY_SOURCE) {
        logger.info(`Screen ${screen} is showing dummy black screen, attempting to start next stream`, 'StreamManager');
        const nextStream = this.queues.get(screen)?.[0];
        if (nextStream) {
          // Check if stream is already watched before starting
          if (this.isStreamWatched(nextStream.url)) {
            logger.info(`Stream ${nextStream.url} is already watched, skipping`, 'StreamManager');
            // Remove the stream from queue and process the next one
            const queue = this.queues.get(screen) || [];
            queue.shift();
            this.queues.set(screen, queue);
            // Continue to the next stream
            await this.handleStreamEnd(screen);
            return;
          }

          // Remove the stream from queue before starting it
          const queue = this.queues.get(screen) || [];
          queue.shift();
          this.queues.set(screen, queue);
          logger.info(`Starting next stream in queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');
          // The stream is already at index 0 and we've removed it from our internal queue
          
          await this.startStream({
            url: nextStream.url,
            screen,
            quality: 'best',
            windowMaximized: true
          });
          return;
        }
      }

      // Get current queue
      const queue = this.queues.get(screen) || [];
      
      // Remove current stream from queue if it exists
      if (currentStream) {
        const currentIndex = queue.findIndex(s => s.url === currentStream.url);
        if (currentIndex !== -1) {
          queue.splice(currentIndex, 1);
          this.queues.set(screen, queue);
        } else {
          // Log but don't throw an error if we can't find the stream in the queue
          logger.warn(`Could not find failed stream ${currentStream.url} in queue for screen ${screen}`, 'StreamManager');
        }
      }

      // Get next stream from queue
      const nextStream = queue[0];
      if (!nextStream) {
        await this.handleEmptyQueue(screen);
        return;
      }

      // Check if stream is already watched
      if (this.isStreamWatched(nextStream.url)) {
        logger.info(`Stream ${nextStream.url} is already watched, skipping`, 'StreamManager');
        queue.shift();
        this.queues.set(screen, queue);
        await this.handleStreamEnd(screen);
        return;
      }

      // Remove the stream from queue before starting it
      queue.shift();
      this.queues.set(screen, queue);
      logger.info(`Starting next stream in queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');
      // The stream is already at index 0 and we've removed it from our internal queue
      
      // Start the next stream
      await this.startStream({
        url: nextStream.url,
        screen,
        quality: 'best',
        windowMaximized: true
      });
    } catch (error: unknown) {
      logger.error(
        `Error handling stream end for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      this.queueProcessing.delete(screen);
      this.clearQueueProcessingTimeout(screen);
    }
  }

  private async handleEmptyQueue(screen: number): Promise<void> {
    try {
      // Clear any existing queue processing flag
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      this.clearQueueProcessingTimeout(screen);

      // If screen was manually closed, don't update queue
      if (this.manuallyClosedScreens.has(screen)) {
        logger.info(`Screen ${screen} was manually closed, not updating queue`, 'StreamManager');
        return;
      }

      // Set queue processing flag with timeout
      this.queueProcessing.add(screen);
      this.queueProcessingStartTimes.set(screen, Date.now());
      
      // Set timeout for queue processing
      const timeoutId = setTimeout(() => {
        logger.warn(`Queue processing timed out for screen ${screen}`, 'StreamManager');
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
      }, this.QUEUE_PROCESSING_TIMEOUT);
      
      this.queueProcessingTimeouts.set(screen, timeoutId);

      // Update queue - force refresh to ensure we get fresh content
      await this.updateQueue(screen);
      
      // Clear processing flag and timeout
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      this.clearQueueProcessingTimeout(screen);

      // Get updated queue
      const queue = this.queues.get(screen) || [];
      
      if (queue.length > 0) {
        // Avoid recursive call that can cause blocking
        // Instead of: await this.handleStreamEnd(screen);
        
        // Get the first stream from queue
        const nextStream = queue[0];
        
        // Skip if stream is already watched
        if (nextStream && this.isStreamWatched(nextStream.url)) {
          logger.info(`Stream ${nextStream.url} is already watched, skipping`, 'StreamManager');
          // Remove from queue
          queue.shift();
          this.queues.set(screen, queue);
          
          // Start next stream after a brief delay
          setTimeout(() => {
            this.handleEmptyQueue(screen).catch(error => {
              logger.error(
                `Error handling empty queue for screen ${screen}`, 
                'StreamManager',
                error instanceof Error ? error : new Error(String(error))
              );
            });
          }, 100);
          
          return;
        }
        
        // Remove from queue
        if (nextStream) {
          queue.shift();
          this.queues.set(screen, queue);
          
          // Start stream directly
          logger.info(`Starting next stream from queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');
          await this.startStream({
            url: nextStream.url,
            screen,
            quality: 'best',
            windowMaximized: true
          });
        }
      } else {
        logger.info(`No streams available for screen ${screen} after queue update`, 'StreamManager');
      }
    } catch (error) {
      logger.error(`Error handling empty queue for screen ${screen}: ${error}`, 'StreamManager');
      // Clear processing flag and timeout on error
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      this.clearQueueProcessingTimeout(screen);
    }
  }

  private clearQueueProcessingTimeout(screen: number): void {
    const timeoutId = this.queueProcessingTimeouts.get(screen);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this.queueProcessingTimeouts.delete(screen);
    }
  }

  private async handleAllStreamsWatched(screen: number) {
    logger.info(`All streams watched for screen ${screen}, waiting before refetching...`);
    
    // Clear watched history to allow playing again
    queueService.clearWatchedStreams();
    logger.info(`Cleared watched streams history for screen ${screen}`, 'StreamManager');
    
    // Check if we should immediately refetch based on time since last refresh
    const now = Date.now();
    const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
    const timeSinceLastRefresh = now - lastRefresh;
    
    if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL) {
      // If refresh interval has elapsed, fetch new streams
      logger.info(`Refresh interval elapsed for screen ${screen}, fetching new streams after all watched`, 'StreamManager');
      
      // Wait a bit before refetching to avoid hammering the APIs
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
      
      if (!this.isShuttingDown) {
        await this.handleEmptyQueue(screen);
      }
    } else {
      logger.info(`Refresh interval not elapsed for screen ${screen}, will wait for next periodic update`, 'StreamManager');
      // Leave it for the next periodic update to handle
    }
  }

  /**
   * Starts a new stream on the specified screen
   */
  async startStream(options: StreamOptions & { url: string }): Promise<StreamResponse> {
    try {
      // Ensure screen is defined
      if (options.screen === undefined) {
        return { screen: 1, success: false, message: 'Screen number is required' };
      }
      const screen = options.screen;

      const stream = this.streams.get(screen);

      // If there's an existing stream, stop it first
      if (stream) {
        await this.stopStream(screen);
      }

      // Clear any existing processing state
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      const timeout = this.queueProcessingTimeouts.get(screen);
      if (timeout) {
        clearTimeout(timeout);
        this.queueProcessingTimeouts.delete(screen);
      }

      // Clear any existing stream from the map
      this.streams.delete(screen);

      // Start the new stream
      const screenConfig = this.screenConfigs.get(screen);
      if (!screenConfig) {
        throw new Error(`Screen ${screen} not found in screenConfigs`);
      }

      const result = await this.playerService.startStream({
        screen,
        config: screenConfig,
        url: options.url,
        quality: options.quality || screenConfig.quality,
        volume: options.volume || screenConfig.volume,
        windowMaximized: options.windowMaximized ?? screenConfig.windowMaximized,
        title: options.title,
        viewerCount: options.viewerCount,
        startTime: typeof options.startTime === 'string' ? Date.parse(options.startTime) : options.startTime
      });

      if (result.success) {
        // Add the new stream to our map
        this.streams.set(screen, {
          url: options.url,
          screen: screen,
          quality: options.quality || 'best',
          platform: options.url.includes('twitch.tv') ? 'twitch' as StreamPlatform : 
                   options.url.includes('youtube.com') ? 'youtube' as StreamPlatform : 'twitch' as StreamPlatform,
          status: 'playing',
          volume: 100,
          process: null,
          id: Date.now() // Use timestamp as unique ID
        });
      }

      return { screen, success: result.success };
    } catch (error) {
      logger.error(
        `Failed to start stream on screen ${options.screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      return { screen: options.screen || 1, success: false };
    }
  }

  /**
   * Stops a stream on the specified screen
   */
  async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
    try {
      if (isManualStop) {
        this.manuallyClosedScreens.add(screen);
        logger.info(`Screen ${screen} manually closed, added to manuallyClosedScreens`, 'StreamManager');
      }

      const success = await this.playerService.stopStream(screen, false, isManualStop);
      if (success) {
        this.streams.delete(screen);
        this.clearInactiveTimer(screen);
        this.clearStreamRefresh(screen);
      }
      return success;
    } catch (error) {
      logger.error(`Error stopping stream on screen ${screen}: ${error}`, 'StreamManager');
      return false;
    }
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
    // Check if we have a recent cache
    const now = Date.now();
    if (this.cachedStreams.length > 0 && now - this.lastStreamFetch < this.STREAM_CACHE_TTL) {
      logger.info(`Using cached streams (${this.cachedStreams.length} streams, age: ${(now - this.lastStreamFetch) / 1000}s)`, 'StreamManager');
      return this.cachedStreams;
    }

    // If we're currently offline based on network checks, use cache and don't try to fetch
    if (this.isOffline && this.cachedStreams.length > 0) {
      logger.warn(`Network appears to be offline, using ${this.cachedStreams.length} cached streams instead of fetching`, 'StreamManager');
      return this.cachedStreams;
    }

    logger.info(`Fetching fresh stream data (cache expired or forced refresh)`, 'StreamManager');
    try {
      const results: Array<StreamSource & { screen?: number; sourceName?: string; priority?: number }> = [];
      const streamConfigs = this.config.streams;
      
      // Defensive check for config
      if (!streamConfigs || !Array.isArray(streamConfigs)) {
        logger.warn('Stream configuration is missing or invalid', 'StreamManager');
        return this.cachedStreams.length > 0 ? this.cachedStreams : [];
      }
      
      for (const streamConfig of streamConfigs) {
        const screenNumber = streamConfig.screen;
        if (!streamConfig.enabled) {
          logger.debug('Screen %s is disabled, skipping', String(screenNumber));
          continue;
        }

        // Sort sources by priority first
        const sortedSources = streamConfig.sources && Array.isArray(streamConfig.sources) 
          ? [...streamConfig.sources]
              .filter(source => source.enabled)
              .sort((a, b) => (a.priority || 999) - (b.priority || 999))
          : [];

        logger.debug(
          'Sources for screen %s: %s',
          String(screenNumber),
          sortedSources.map(s => `${s.type}:${s.subtype || 'other'} (${s.priority || 999})`).join(', ')
        );
        
        for (const source of sortedSources) {
          const limit = source.limit || 25;
          let streams: StreamSource[] = [];
          let sourceSuccess = false;
          let attemptCount = 0;
          const MAX_SOURCE_ATTEMPTS = 2;

          while (!sourceSuccess && attemptCount < MAX_SOURCE_ATTEMPTS) {
          try {
              attemptCount++;
              
            if (source.type === 'holodex') {
                if (!this.holodexService) {
                  logger.warn('Holodex service not initialized, skipping source', 'StreamManager');
                  break;
                }
                
              if (source.subtype === 'favorites') {
                  // Check that we have valid favorite channels
                  // Get flattened list of all holodex favorites across all groups
                  const flattenedHolodexFavorites = this.getFlattenedFavorites('holodex');
                  if (!flattenedHolodexFavorites || flattenedHolodexFavorites.length === 0) {
                    logger.warn('No Holodex favorite channels configured, skipping source', 'StreamManager');
                    break;
                  }
                  
                streams = await this.holodexService.getLiveStreams({
                  channels: this.getFlattenedFavorites('holodex'),
                  limit: limit,
                  sort: 'start_scheduled'  // Sort by scheduled start time
                });
                logger.debug(
                  'Fetched %s favorite Holodex streams for screen %s',
                  String(streams.length),
                  String(screenNumber)
                );
                
                // For favorites, assign a higher priority based on source priority
                // This ensures favorites are always prioritized over other sources
                const basePriority = source.priority || 999;
                streams.forEach(s => {
                  s.priority = basePriority - 100; // Make favorites 100 points higher priority
                    s.screen = screenNumber; // Assign screen number
                });
                  
                  sourceSuccess = true;
              } else if (source.subtype === 'organization' && source.name) {
                streams = await this.holodexService.getLiveStreams({
                  organization: source.name,
                  limit: limit,
                  sort: 'start_scheduled'  // Sort by scheduled start time
                });
                  // Assign screen number and source priority to organization streams
                  streams.forEach(s => {
                    s.screen = screenNumber;
                    s.priority = source.priority || 999;
                  });
                  
                  sourceSuccess = true;
              }
            } else if (source.type === 'twitch') {
                if (!this.twitchService) {
                  logger.warn('Twitch service not initialized, skipping source', 'StreamManager');
                  break;
                }
                
              if (source.subtype === 'favorites') {
                  // Check that we have valid favorite channels
                  // Get flattened list of all twitch favorites across all groups
                  const flattenedTwitchFavorites = this.getFlattenedFavorites('twitch');
                  if (!flattenedTwitchFavorites || flattenedTwitchFavorites.length === 0) {
                    logger.warn('No Twitch favorite channels configured, skipping source', 'StreamManager');
                    break;
                  }
                  
                streams = await this.twitchService.getStreams({
                  channels: this.getFlattenedFavorites('twitch'),
                  limit: limit
                });
                  // Assign screen number and source priority to Twitch favorite streams
                  streams.forEach(s => {
                    s.screen = screenNumber;
                    s.priority = source.priority || 999;
                  });
                  
                  sourceSuccess = true;
                } else {
                  streams = await this.twitchService.getStreams({
                    tags: source.tags,
                    limit: limit
                  });
                  // Assign screen number and source priority to Twitch streams
                streams.forEach(s => {
                    s.screen = screenNumber;
                    s.priority = source.priority || 999;
                  });
                  
                  sourceSuccess = true;
              }
            } else if (source.type === 'youtube') {
                if (!this.youtubeService) {
                  logger.warn('YouTube service not initialized, skipping source', 'StreamManager');
                  break;
                }
                
              if (source.subtype === 'favorites') {
                  // Check that we have valid favorite channels
                  // Get flattened list of all youtube favorites across all groups
                  const flattenedYoutubeFavorites = this.getFlattenedFavorites('youtube');
                  if (!flattenedYoutubeFavorites || flattenedYoutubeFavorites.length === 0) {
                    logger.warn('No YouTube favorite channels configured, skipping source', 'StreamManager');
                    break;
                  }
                  
                streams = await this.youtubeService.getLiveStreams({
                  channels: this.getFlattenedFavorites('youtube'),
                  limit
                });
                
                // For favorites, assign a higher priority based on source priority
                const basePriority = source.priority || 999;
                streams.forEach(s => {
                  s.priority = basePriority - 100; // Make favorites 100 points higher priority
                });
                  
                  sourceSuccess = true;
                }
              }
              
              // Add streams to results
              if (streams.length > 0) {
                results.push(...streams);
              }
          } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              
              if (attemptCount < MAX_SOURCE_ATTEMPTS) {
                logger.warn(
                  `Failed to fetch streams for source ${source.type}:${source.subtype || 'other'} on screen ${screenNumber} (attempt ${attemptCount}/${MAX_SOURCE_ATTEMPTS}), retrying...`,
                  'StreamManager'
                );
                
                // Short delay before retry
                await new Promise(resolve => setTimeout(resolve, 1000));
              } else {
            logger.error(
                  `Failed to fetch streams for source ${source.type}:${source.subtype || 'other'} on screen ${screenNumber} after ${MAX_SOURCE_ATTEMPTS} attempts`,
              'StreamManager',
              error instanceof Error ? error : new Error(String(error))
            );
                
                // If this is a retry and we still failed, increment error count
                if (retryCount > 0) {
                  this.streamRetries.set(screenNumber, (this.streamRetries.get(screenNumber) || 0) + 1);
                }
                
                // Check if error might indicate network failure
                if (errorMsg.includes('network') || 
                    errorMsg.includes('ECONNREFUSED') || 
                    errorMsg.includes('ENOTFOUND') || 
                    errorMsg.includes('timeout')) {
                  this.isOffline = true;
                  logger.warn('Network error detected, marking as offline', 'StreamManager');
                }
              }
            }
          }
        }
      }

      // Update cache if we got results (even if partial)
      if (results.length > 0) {
      this.lastStreamFetch = now;
        this.cachedStreams = results;
        this.isOffline = false; // Reset offline flag if we successfully got results
      } else if (this.cachedStreams.length > 0) {
        // If we got no results but have cached data, use the cache and log a warning
        logger.warn('Failed to fetch new streams, using cached streams (possible network issue)', 'StreamManager');
        return this.cachedStreams;
      }

      return results;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to fetch live streams', 'StreamManager');
      logger.debug(errorMsg, 'StreamManager');
      
      // Check if error might indicate network failure
      if (errorMsg.includes('network') || 
          errorMsg.includes('ECONNREFUSED') || 
          errorMsg.includes('ENOTFOUND') || 
          errorMsg.includes('timeout')) {
        this.isOffline = true;
        logger.warn('Network error detected, marking as offline', 'StreamManager');
      }
      
      // If we haven't exceeded max retries, try again
      if (retryCount < 3) {
        const retryDelay = 2000 * (retryCount + 1); // Increasing backoff
        logger.info(`Retrying stream fetch in ${retryDelay/1000}s (attempt ${retryCount + 1}/3)`, 'StreamManager');
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.getLiveStreams(retryCount + 1);
      }
      
      // Return cached streams if available, even if they're old
      if (this.cachedStreams.length > 0) {
        logger.warn(`Using expired cached streams (${this.cachedStreams.length} streams) after failed fetch attempts`, 'StreamManager');
        return this.cachedStreams;
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
    if (this.isShuttingDown) return;
    
    logger.info('Auto-starting streams...', 'StreamManager');
    
    try {
      // Check for selected screens from environment variables
      let selectedScreens: number[] = [];
      if (process.env.SELECTED_SCREENS) {
        selectedScreens = process.env.SELECTED_SCREENS.split(',').map(Number).filter(n => !isNaN(n));
        logger.info(`Using selected screens from CLI: ${selectedScreens.join(', ')}`, 'StreamManager');
      }
      
      // Get all enabled screens with autoStart enabled from streams config
      let autoStartScreens = this.config.streams
        .filter(stream => stream.enabled && stream.autoStart)
        .map(stream => stream.screen);
      
      // Filter by selected screens if specified
      if (selectedScreens.length > 0) {
        autoStartScreens = autoStartScreens.filter(screen => selectedScreens.includes(screen));
        logger.info(`Filtered auto-start screens to: ${autoStartScreens.join(', ')}`, 'StreamManager');
      }
      
      if (autoStartScreens.length === 0) {
        logger.info('No screens configured for auto-start', 'StreamManager');
        return;
      }
      
      logger.info(`Auto-starting streams for screens: ${autoStartScreens.join(', ')}`, 'StreamManager');
      
      // Check for organization filters from environment variables
      const organizationNames: string[] = [];
      const organizationPriorities: (number | [number, number])[] = [];
      
      if (process.env.ORGANIZATION_NAMES) {
        organizationNames.push(...process.env.ORGANIZATION_NAMES.split(','));
        logger.info(`Using organization names from CLI: ${organizationNames.join(', ')}`, 'StreamManager');
      }
      
      if (process.env.ORGANIZATION_PRIORITIES) {
        const priorities = process.env.ORGANIZATION_PRIORITIES.split(',');
        for (const priority of priorities) {
          // Check if it's a range like "1-4"
          if (priority.includes('-')) {
            const [start, end] = priority.split('-').map(Number);
            if (!isNaN(start) && !isNaN(end)) {
              organizationPriorities.push([start, end]);
            }
          } else {
            const num = Number(priority);
            if (!isNaN(num)) {
              organizationPriorities.push(num);
            }
          }
        }
        logger.info(`Using organization priorities from CLI: ${process.env.ORGANIZATION_PRIORITIES}`, 'StreamManager');
      }
      
      // Get minimum viewers filter
      let minViewers = 0;
      if (process.env.MIN_VIEWERS) {
        minViewers = parseInt(process.env.MIN_VIEWERS);
        if (!isNaN(minViewers)) {
          logger.info(`Filtering streams with minimum ${minViewers} viewers`, 'StreamManager');
        }
      }
      
      // Get stream limit per source
      let streamLimit: number | undefined;
      if (process.env.STREAM_LIMIT) {
        streamLimit = parseInt(process.env.STREAM_LIMIT);
        if (!isNaN(streamLimit)) {
          logger.info(`Setting stream fetch limit to ${streamLimit} per source`, 'StreamManager');
        }
      }
      
      // Get max concurrent streams
      let maxStreams: number | undefined;
      if (process.env.MAX_STREAMS) {
        maxStreams = parseInt(process.env.MAX_STREAMS);
        if (!isNaN(maxStreams)) {
          logger.info(`Setting maximum concurrent streams to ${maxStreams}`, 'StreamManager');
        }
      }
      
      // Get sort direction
      let sortDirection: 'asc' | 'desc' = 'desc';
      if (process.env.STREAM_SORT) {
        if (process.env.STREAM_SORT === 'asc' || process.env.STREAM_SORT === 'desc') {
          sortDirection = process.env.STREAM_SORT;
          logger.info(`Sorting streams by viewer count: ${sortDirection}`, 'StreamManager');
        }
      }
      
      // First, fetch all available streams
      const allStreams = await this.getLiveStreams();
      logger.info(`Fetched ${allStreams.length} live streams for initialization`, 'StreamManager');
      
      // Process each screen
      for (const screen of autoStartScreens) {
        // Check if a stream is already playing on this screen
        const activeStreams = this.getActiveStreams();
        const isStreamActive = activeStreams.some(s => s.screen === screen);
        
        if (isStreamActive) {
          logger.info(`Stream already active on screen ${screen}, skipping auto-start`, 'StreamManager');
          
          // Still update the queue for this screen
          const streamConfig = this.config.streams.find(s => s.screen === screen);
          if (!streamConfig) {
            logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
            continue;
          }
          
          // Filter streams for this screen but exclude the currently playing one
          const currentStream = this.streams.get(screen);
          const currentUrl = currentStream?.url;
          
          const screenStreams = allStreams.filter(stream => {
            // Skip the currently playing stream
            if (currentUrl && stream.url === currentUrl) {
              return false;
            }
            
            // Only include streams that are actually live
            if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
              return false;
            }
            
            // Check if stream is already playing on another screen
            const isPlaying = activeStreams.some(s => s.url === stream.url);
            
            // Never allow duplicate streams across screens
            if (isPlaying) {
              return false;
            }
            
            // Apply minimum viewers filter if set
            if (minViewers > 0 && (stream.viewerCount === undefined || stream.viewerCount < minViewers)) {
              return false;
            }
            
            // Apply organization name filter if set
            if (organizationNames.length > 0 && stream.organization) {
              if (!organizationNames.some(name => stream.organization?.toLowerCase() === name.toLowerCase())) {
                return false;
              }
            }
            
            // Apply organization priority filter if set
            if (organizationPriorities.length > 0 && stream.priority !== undefined) {
              const matchesPriority = organizationPriorities.some(priority => {
                if (Array.isArray(priority)) {
                  // It's a range
                  const [start, end] = priority;
                  return stream.priority !== undefined && stream.priority >= start && stream.priority <= end;
                } else {
                  // It's a single value
                  return stream.priority === priority;
                }
              });
              
              if (!matchesPriority) {
                return false;
              }
            }
            
            // Check if this stream matches the screen's configured sources
            const matchesSource = streamConfig.sources?.some(source => {
              if (!source.enabled) return false;

              switch (source.type) {
                case 'holodex':
                  if (stream.platform !== 'youtube') return false;
                  if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('holodex', stream.channelId)) return true;
                  if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
                  break;
                case 'twitch':
                  if (stream.platform !== 'twitch') return false;
                  if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('twitch', stream.channelId)) return true;
                  if (!source.subtype && source.tags?.includes('vtuber')) return true;
                  break;
              }
              return false;
            });

            return matchesSource;
          }).sort((a, b) => {
            // Sort by priority first
            const aPriority = a.priority ?? 999;
            const bPriority = b.priority ?? 999;
            if (aPriority !== bPriority) return aPriority - bPriority;
            
            // Then sort by viewer count if specified
            if (sortDirection) {
              const aViewers = a.viewerCount ?? 0;
              const bViewers = b.viewerCount ?? 0;
              
              if (sortDirection === 'asc') {
                return aViewers - bViewers;
              } else {
                return bViewers - aViewers;
              }
            }
            
            return 0;
          });
          
          // Apply stream limit if specified
          let limitedStreams = screenStreams;
          if (streamLimit !== undefined && streamLimit > 0 && screenStreams.length > streamLimit) {
            limitedStreams = screenStreams.slice(0, streamLimit);
            logger.info(`Limited streams for screen ${screen} from ${screenStreams.length} to ${limitedStreams.length}`, 'StreamManager');
          }
          
          // Apply max streams setting if specified
          if (maxStreams !== undefined && maxStreams > 0) {
            const screenConfig = this.getScreenConfig(screen);
            if (screenConfig) {
              screenConfig.maxStreams = maxStreams;
              logger.info(`Set maximum concurrent streams for screen ${screen} to ${maxStreams}`, 'StreamManager');
            }
          }
          
          // Set up the queue first
          if (limitedStreams.length > 0) {
            queueService.setQueue(screen, limitedStreams);
            logger.info(`Initialized queue for screen ${screen} with ${limitedStreams.length} streams`, 'StreamManager');
          }
          
          continue; // Skip to next screen
        }
        
        // Reset the last refresh time to force a fresh start
        this.lastStreamRefresh.set(screen, 0);
        
        // Get stream configuration for this screen
        const streamConfig = this.config.streams.find(s => s.screen === screen);
        if (!streamConfig) {
          logger.warn(`No stream configuration found for screen ${screen}`, 'StreamManager');
          continue;
        }
        
        // Filter and sort streams for this screen
        const screenStreams = allStreams.filter(stream => {
          // Only include streams that are actually live
          if (!stream.sourceStatus || stream.sourceStatus !== 'live') {
            return false;
          }
          
          // Check if stream is already playing on another screen
          const isPlaying = activeStreams.some(s => s.url === stream.url);
          
          // Never allow duplicate streams across screens
          if (isPlaying) {
            return false;
          }
          
          // Apply minimum viewers filter if set
          if (minViewers > 0 && (stream.viewerCount === undefined || stream.viewerCount < minViewers)) {
            return false;
          }
          
          // Apply organization name filter if set
          if (organizationNames.length > 0 && stream.organization) {
            if (!organizationNames.some(name => stream.organization?.toLowerCase() === name.toLowerCase())) {
              return false;
            }
          }
          
          // Apply organization priority filter if set
          if (organizationPriorities.length > 0 && stream.priority !== undefined) {
            const matchesPriority = organizationPriorities.some(priority => {
              if (Array.isArray(priority)) {
                // It's a range
                const [start, end] = priority;
                return stream.priority !== undefined && stream.priority >= start && stream.priority <= end;
              } else {
                // It's a single value
                return stream.priority === priority;
              }
            });
            
            if (!matchesPriority) {
              return false;
            }
          }
          
          // Check if this stream matches the screen's configured sources
          const matchesSource = streamConfig.sources?.some(source => {
            if (!source.enabled) return false;

            switch (source.type) {
              case 'holodex':
                if (stream.platform !== 'youtube') return false;
                if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('holodex', stream.channelId)) return true;
                if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
                break;
              case 'twitch':
                if (stream.platform !== 'twitch') return false;
                if (source.subtype === 'favorites' && stream.channelId && this.isChannelInFavorites('twitch', stream.channelId)) return true;
                if (!source.subtype && source.tags?.includes('vtuber')) return true;
                break;
            }
            return false;
          });

          return matchesSource;
        }).sort((a, b) => {
          // Sort by priority first
          const aPriority = a.priority ?? 999;
          const bPriority = b.priority ?? 999;
          if (aPriority !== bPriority) return aPriority - bPriority;
          
          // Then sort by viewer count if specified
          if (sortDirection) {
            const aViewers = a.viewerCount ?? 0;
            const bViewers = b.viewerCount ?? 0;
            
            if (sortDirection === 'asc') {
              return aViewers - bViewers;
            } else {
              return bViewers - aViewers;
            }
          }
          
          return 0;
        });
        
        // Apply stream limit if specified
        let limitedStreams = screenStreams;
        if (streamLimit !== undefined && streamLimit > 0 && screenStreams.length > streamLimit) {
          limitedStreams = screenStreams.slice(0, streamLimit);
          logger.info(`Limited streams for screen ${screen} from ${screenStreams.length} to ${limitedStreams.length}`, 'StreamManager');
        }
        
        // Apply max streams setting if specified
        if (maxStreams !== undefined && maxStreams > 0) {
          const screenConfig = this.getScreenConfig(screen);
          if (screenConfig) {
            screenConfig.maxStreams = maxStreams;
            logger.info(`Set maximum concurrent streams for screen ${screen} to ${maxStreams}`, 'StreamManager');
          }
        }
        
        if (limitedStreams.length > 0) {
          // Take the first stream to play and queue the rest
          const [firstStream, ...queueStreams] = limitedStreams;
          
          // Set up the queue first
          if (queueStreams.length > 0) {
            queueService.setQueue(screen, queueStreams);
            logger.info(`Initialized queue for screen ${screen} with ${queueStreams.length} streams`, 'StreamManager');
          }
          
          // Start playing the first stream
          logger.info(`Starting initial stream on screen ${screen}: ${firstStream.url}`, 'StreamManager');
          await this.startStream({
            url: firstStream.url,
            screen,
            quality: this.config.player.defaultQuality,
            windowMaximized: this.config.player.windowMaximized,
            volume: this.config.player.defaultVolume,
            title: firstStream.title,
            viewerCount: firstStream.viewerCount,
            startTime: firstStream.startTime
          });
        } else {
          logger.info(`No live streams available for screen ${screen}, will try again later`, 'StreamManager');
        }
      }
      
      logger.info('Auto-start complete', 'StreamManager');
    } catch (error) {
      logger.error(`Error during auto-start: ${error instanceof Error ? error.message : String(error)}`, 'StreamManager');
    }
  }

  async disableScreen(screen: number): Promise<void> {
    const streamConfig = this.config.player.screens.find(s => s.screen === screen);
    if (!streamConfig) {
      throw new Error(`Invalid screen number: ${screen}`);
    }
    
    // Notify the PlayerService first that the screen is disabled
    // This ensures any new attempts to start streams will be blocked
    this.playerService.disableScreen(screen);
    
    // Stop any active streams with up to 3 attempts
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.stopStream(screen, true);
      if (result) {
        break;
      }
      // If stopping failed, wait a bit and try again
      if (attempt < 2) {
        logger.warn(`Failed to stop stream on screen ${screen}, attempt ${attempt + 1}, retrying...`, 'StreamManager');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Force kill the stream process if it exists
    const stream = this.streams.get(screen);
    if (stream && stream.process) {
      logger.warn(`Forcibly killing stream process for screen ${screen}`, 'StreamManager');
      try {
        stream.process.kill('SIGKILL');
      } catch (e) {
        logger.error(`Failed to kill stream process: ${e}`, 'StreamManager');
      }
    }
    
    // Force clean up any remaining streams on this screen
    if (this.streams.has(screen)) {
      logger.warn(`Stream on screen ${screen} could not be stopped properly, forcing cleanup`, 'StreamManager');
      this.streams.delete(screen);
    }
    
    // Disable the screen in config
    streamConfig.enabled = false;
    
    // Also make sure PlayerService has cleaned up its stream data
    const activeStreams = this.playerService.getActiveStreams();
    if (activeStreams.some(s => s.screen === screen)) {
      logger.warn(`PlayerService still has active stream for screen ${screen}, forcing cleanup`, 'StreamManager');
      // Send a direct command to clean up
      try {
        await this.playerService.stopStream(screen, true);
      } catch (e) {
        logger.error(`Failed final PlayerService cleanup: ${e}`, 'StreamManager');
      }
    }
    
    logger.info(`Screen ${screen} disabled`, 'StreamManager');
  }

  async enableScreen(screen: number): Promise<void> {
    try {
      const config = this.getScreenConfig(screen);
      if (!config) {
        throw new Error(`No configuration found for screen ${screen}`);
      }

      config.enabled = true;
      this.screenConfigs.set(screen, config);
      await this.saveConfig();

      // Remove from manually closed screens when enabling
      this.manuallyClosedScreens.delete(screen);
      logger.info(`Screen ${screen} enabled and removed from manuallyClosedScreens`, 'StreamManager');

      // Start stream if autoStart is enabled
      if (config.autoStart) {
        await this.handleStreamEnd(screen);
      }
    } catch (error) {
      logger.error(`Error enabling screen ${screen}: ${error}`, 'StreamManager');
      throw error;
    }
  }

  /**
   * Handles empty queue by fetching and starting new streams
   */
  public async handleQueueEmpty(screen: number): Promise<void> {
    return this.handleEmptyQueue(screen);
  }

  /**
   * Restarts streams on specified screen or all screens
   */
  public async restartStreams(screen?: number): Promise<void> {
    if (screen) {
      // Restart specific screen
      await this.stopStream(screen, false);
      await this.handleQueueEmpty(screen);
    } else {
      // Restart all screens
      const activeScreens = Array.from(this.streams.keys());
      for (const screenId of activeScreens) {
        await this.stopStream(screenId, false);
        await this.handleQueueEmpty(screenId);
      }
    }
  }

  async reorderQueue(screen: number, sourceIndex: number, targetIndex: number): Promise<void> {
    const queue = queueService.getQueue(screen);
    if (sourceIndex < 0 || sourceIndex >= queue.length || 
        targetIndex < 0 || targetIndex >= queue.length) {
      throw new Error('Invalid source or target index');
    }

    // Reorder the queue
    const [item] = queue.splice(sourceIndex, 1);
    queue.splice(targetIndex, 0, item);
    queueService.setQueue(screen, queue);
    
    logger.info(`Reordered queue for screen ${screen}: moved item from ${sourceIndex} to ${targetIndex}`, 'StreamManager');
  }

  getQueueForScreen(screen: number): StreamSource[] {
    return queueService.getQueue(screen);
  }

  async setPlayerPriority(priority: string): Promise<void> {
    // Validate priority
    const validPriorities = ['realtime', 'high', 'above_normal', 'normal', 'below_normal', 'low', 'idle'];
    if (!validPriorities.includes(priority.toLowerCase())) {
      throw new Error(`Invalid priority: ${priority}. Valid values are: ${validPriorities.join(', ')}`);
    }

    // Update config
    if (!this.config.mpv) {
      this.config.mpv = {};
    }
    this.config.mpv.priority = priority;

    // Restart all streams to apply new priority
    logger.info(`Setting player priority to ${priority}`, 'StreamManager');
    await this.restartStreams();
  }

  public markStreamAsWatched(url: string): void {
    queueService.markStreamAsWatched(url);
    logger.info(`Stream marked as watched: ${url}`, 'StreamManager');
  }

  public getWatchedStreams(): string[] {
    return queueService.getWatchedStreams();
  }

  public clearWatchedStreams(): void {
    queueService.clearWatchedStreams();
    logger.info('Cleared watched streams history', 'StreamManager');
  }

  async cleanup() {
    this.isShuttingDown = true;
    
    try {
      // Stop all keyboard listeners
      this.keyboardService.cleanup();

      // Get all active screens
      const activeScreens = Array.from(this.streams.keys());
      
      // Stop all streams
      const stopPromises = activeScreens.map(screen => 
        this.stopStream(screen, true).catch(error => {
          logger.error(
            `Failed to stop stream on screen ${screen} during cleanup`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        })
      );

      // Wait for all streams to stop
      await Promise.all(stopPromises);

      // Clear all timers
      for (const screen of this.streamRefreshTimers.keys()) {
        this.clearStreamRefresh(screen);
      }
      
      for (const screen of this.inactiveTimers.keys()) {
        this.clearInactiveTimer(screen);
      }

      // Clear all queues
      this.queues.clear();
      
      // Remove all FIFO files
      for (const [, fifoPath] of this.fifoPaths) {
        try {
          fs.unlinkSync(fifoPath);
        } catch {
          // Ignore errors, file might not exist
          logger.debug(`Failed to remove FIFO file ${fifoPath}`, 'StreamManager');
        }
      }
      this.fifoPaths.clear();
      this.ipcPaths.clear();

      // Clear all event listeners
      this.removeAllListeners();
      
      logger.info('Stream manager cleanup complete', 'StreamManager');
    } catch (error) {
      logger.error(
        'Error during stream manager cleanup',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  public sendCommandToScreen(screen: number, command: string): void {
    this.playerService.sendCommandToScreen(screen, command);
  }

  public sendCommandToAll(command: string): void {
    this.playerService.sendCommandToAll(command);
  }

  public async addToQueue(screen: number, source: StreamSource): Promise<void> {
    const queue = this.queues.get(screen) || [];
    queue.push(source);
    this.queues.set(screen, queue);
    this.emit('queueUpdate', screen, queue);
  }

  public async removeFromQueue(screen: number, index: number): Promise<void> {
    const queue = this.queues.get(screen) || [];
    if (index >= 0 && index < queue.length) {
      queue.splice(index, 1);
      this.queues.set(screen, queue);
      this.emit('queueUpdate', screen, queue);
    }
  }

  public getPlayerSettings() {
    return {
      preferStreamlink: this.config.player.preferStreamlink,
      defaultQuality: this.config.player.defaultQuality,
      defaultVolume: this.config.player.defaultVolume,
      windowMaximized: this.config.player.windowMaximized,
      maxStreams: this.config.player.maxStreams,
      autoStart: this.config.player.autoStart
    };
  }

  public async updatePlayerSettings(settings: Partial<PlayerSettings>): Promise<void> {
    // Update the settings
    Object.assign(this.config.player, settings);
    
    // Emit settings update event
    this.emit('settingsUpdate', this.config.player);
    await this.saveConfig();
  }

  public getScreenConfigs() {
    return this.config.player.screens;
  }

  public async saveConfig(): Promise<void> {
    try {
      await fs.promises.writeFile(
        path.join(process.cwd(), 'config', 'config.json'),
        JSON.stringify(this.config, null, 2),
        'utf-8'
      );
      this.emit('configUpdate', this.config);
    } catch (error) {
      this.emit('error', error);
      throw error;
    }
  }

  public getScreenConfig(screen: number): ScreenConfig | undefined {
    return this.screenConfigs.get(screen);
  }

  public updateScreenConfig(screen: number, config: Partial<ScreenConfig>): void {
    const screenConfig = this.getScreenConfig(screen);
    if (!screenConfig) {
      throw new Error(`Screen ${screen} not found`);
    }
    
    // Update the config
    Object.assign(screenConfig, config);
    
    this.screenConfigs.set(screen, screenConfig);
    this.emit('screenConfigChanged', { screen, config });
  }

  public getConfig() {
    return {
      streams: this.config.player.screens,
      organizations: this.config.organizations,
      favoriteChannels: this.config.favoriteChannels,
      holodex: {
        apiKey: this.config.holodex.apiKey
      },
      twitch: {
        clientId: this.config.twitch.clientId,
        clientSecret: this.config.twitch.clientSecret,
        streamersFile: this.config.twitch.streamersFile
      }
    };
  }

  public async updateConfig(newConfig: Partial<Config>): Promise<void> {
    Object.assign(this.config, newConfig);
    await this.saveConfig();
    this.emit('configUpdate', this.getConfig());
  }

  public async updateFavorites(favorites: FavoriteChannels): Promise<void> {
    this.favoriteChannels = favorites;
    this.config.favoriteChannels = favorites;
    
    // Update services with new favorites - flatten all groups into a single array for each platform
    const flattenedHolodex = this.getFlattenedFavorites('holodex');
    const flattenedTwitch = this.getFlattenedFavorites('twitch');
    const flattenedYoutube = this.getFlattenedFavorites('youtube');
    
    this.holodexService.updateFavorites(flattenedHolodex);
    this.twitchService.updateFavorites(flattenedTwitch);
    this.youtubeService.updateFavorites(flattenedYoutube);
    
    await fs.promises.writeFile(
      path.join(process.cwd(), 'config', 'favorites.json'),
      JSON.stringify(favorites, null, 2),
      'utf-8'
    );
    
    this.emit('favoritesUpdate', favorites);
  }

  public getFavorites(): FavoriteChannels {
    return this.favoriteChannels;
  }

  public async addFavorite(platform: 'holodex' | 'twitch' | 'youtube', channelId: string, group: string = 'default'): Promise<void> {
    // Ensure the platform and group exist
    if (!this.favoriteChannels[platform]) {
      this.favoriteChannels[platform] = {};
    }
    
    if (!this.favoriteChannels[platform][group]) {
      this.favoriteChannels[platform][group] = [];
    }
    
    // Add the channel to the specified group if it doesn't already exist
    if (!this.favoriteChannels[platform][group].includes(channelId)) {
      this.favoriteChannels[platform][group].push(channelId);
      await this.updateFavorites(this.favoriteChannels);
    }
  }

  public async removeFavorite(platform: 'holodex' | 'twitch' | 'youtube', channelId: string, group: string = 'default'): Promise<void> {
    if (this.favoriteChannels[platform] && this.favoriteChannels[platform][group]) {
      const index = this.favoriteChannels[platform][group].indexOf(channelId);
      if (index !== -1) {
        this.favoriteChannels[platform][group].splice(index, 1);
        await this.updateFavorites(this.favoriteChannels);
      }
    }
  }

  private initializeQueues() {
    logger.info('Initializing queues for all screens', 'StreamManager');
    
    // Create empty queue for each screen
    this.config.player.screens.forEach(screen => {
      this.queues.set(screen.screen, []);
      logger.debug(`Created empty queue for screen ${screen.screen}`, 'StreamManager');
    });
    
    // Force update all queues after initialization, but don't await
    // This will be handled by startQueueUpdates for proper ordering
    this.updateAllQueues(true).catch(error => {
      logger.error(
        'Failed to initialize queues',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }

  /**
   * Get comprehensive information about a screen, including:
   * - Current stream
   * - Queue
   * - Configuration
   * - Status
   */
  public getScreenInfo(screen: number) {
    // Get screen configuration
    const screenConfig = this.config.player.screens.find(s => s.screen === screen);
    if (!screenConfig) {
      throw new Error(`Screen ${screen} not found`);
    }

    // Get active stream for this screen
    const activeStream = this.getActiveStreams().find(s => s.screen === screen);

    // Get queue for this screen
    const queue = this.getQueueForScreen(screen);

    return {
      config: screenConfig,
      currentStream: activeStream || null,
      queue,
      enabled: screenConfig.enabled,
      status: activeStream?.status || 'stopped',
      // Additional useful information
      volume: screenConfig.volume,
      quality: screenConfig.quality,
      windowMaximized: screenConfig.windowMaximized,
      dimensions: {
        width: screenConfig.width,
        height: screenConfig.height,
        x: screenConfig.x,
        y: screenConfig.y
      }
    };
  }

  private clearInactiveTimer(screen: number) {
    const timer = this.inactiveTimers.get(screen);
    if (timer) {
      clearTimeout(timer);
      this.inactiveTimers.delete(screen);
    }
  }

  private clearStreamRefresh(screen: number) {
    const timer = this.streamRefreshTimers.get(screen);
    if (timer) {
      clearTimeout(timer);
      this.streamRefreshTimers.delete(screen);
    }
  }

  private async startQueueUpdates() {
    // Don't set up updates if we're shutting down
    if (this.isShuttingDown) {
      return;
    }
    
    // Clear any existing interval
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    
    // Force initial update for all enabled screens in parallel
    const enabledScreens = this.config.player.screens
      .filter(s => s.enabled)
      .map(s => s.screen);
    
    logger.info(`Performing initial queue update for ${enabledScreens.length} enabled screens`, 'StreamManager');
    
    try {
      // Update each screen's queue individually first
      const updatePromises = enabledScreens.map(screen => 
        this.updateQueue(screen).catch(error => {
          logger.error(
            `Failed initial queue update for screen ${screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        })
      );
      await Promise.all(updatePromises);
      
      // Then do a full update to ensure consistency
      await this.updateAllQueues(true);
      
      logger.info('Initial queue updates completed successfully', 'StreamManager');
    } catch (error) {
      logger.error(
        'Error during initial queue updates',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
    
    // Set up interval for periodic updates
    this.updateInterval = setInterval(async () => {
      // Skip updates if we're shutting down or offline
      if (this.isShuttingDown || this.isOffline) {
        return;
      }
      await this.updateAllQueues(false);
    }, this.QUEUE_UPDATE_INTERVAL);
    
    logger.info(`Queue updates started with ${this.QUEUE_UPDATE_INTERVAL / 60000} minute interval`, 'StreamManager');
  }

  private stopQueueUpdates() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      logger.info('Queue updates stopped', 'StreamManager');
    }
  }

  handleLuaMessage(screen: number, type: string, data: unknown) {
    if (typeof data === 'object' && data !== null) {
      this.playerService.handleLuaMessage(screen, type, data as Record<string, unknown>);
    }
  }

  public handlePlaylistUpdate(screen: number, playlist: Array<{ filename: string; title?: string; current: boolean; }>): void {
    // Get or create stream instance
    let stream = this.streams.get(screen);
    
    // If no stream exists but we have playlist data, create a new stream instance
    if (!stream && playlist.length > 0) {
      const currentItem = playlist.find(item => item.current);
      if (currentItem) {
        // Get screen configuration
        const screenConfig = this.config.player.screens.find(s => s.screen === screen);
        if (!screenConfig) {
          logger.warn(`No screen configuration found for screen ${screen}`, 'StreamManager');
          return;
        }

        // Create new stream instance
        stream = {
          id: Date.now(),
          screen,
          url: currentItem.filename,
          title: currentItem.title,
          quality: screenConfig.quality || this.config.player.defaultQuality,
          status: 'playing',
          platform: currentItem.filename.includes('youtube.com') ? 'youtube' : 'twitch',
          volume: screenConfig.volume || this.config.player.defaultVolume,
          process: null // Process will be attached when available
        };
        this.streams.set(screen, stream);
        logger.info(`Created new stream instance for screen ${screen}`, 'StreamManager');
      }
    }

    if (!stream) {
      logger.warn(`No active stream found for screen ${screen} during playlist update`, 'StreamManager');
      return;
    }

    // Update the stream's playlist
    stream.playlist = playlist.map(item => ({
      id: Date.now(),
      screen,
      url: item.filename,
      title: item.title,
      quality: stream.quality,
      status: item.current ? 'playing' : 'stopped',
      platform: item.filename.includes('youtube.com') ? 'youtube' : 'twitch',
      volume: stream.volume,
      process: item.current ? stream.process : null
    }));

    // Log the update
    logger.debug(
      `Updated playlist for screen ${screen} with ${playlist.length} items`,
      'StreamManager'
    );

    // Emit playlist update event
    this.emit('playlistUpdate', screen, stream.playlist);
  }

  /**
   * Gets a list of all enabled screens
   */
  getEnabledScreens(): number[] {
    // Get all enabled screens from the config
    return this.config.streams
      .filter(stream => stream.enabled)
      .map(stream => stream.screen);
  }

  /**
   * Resets the refresh timestamps for specified screens
   * @param screens Array of screen numbers to reset
   */
  resetRefreshTimestamps(screens: number[]): void {
    logger.info(`Resetting refresh timestamps for screens: ${screens.join(', ')}`, 'StreamManager');
    
    screens.forEach(screen => {
      this.lastStreamRefresh.set(screen, 0);
    });
  }

  /**
   * Updates the queue for a specific screen, optionally forcing a refresh
   * @param screen Screen number
   * @param forceRefresh Whether to force a refresh regardless of time elapsed
   */
  async updateQueue(screen: number): Promise<void> {
    try {
      const screenConfig = this.getScreenConfig(screen);
      if (!screenConfig || !screenConfig.enabled) {
        logger.debug(`Screen ${screen} is disabled or has no config, skipping queue update`, 'StreamManager');
        return;
      }

      // Get streams from all sources
      const streams = await this.getAllStreamsForScreen(screen);
      
      // Filter out watched streams based on configuration
      const filteredStreams = this.filterUnwatchedStreams(streams, screen);

      // Sort streams
      const sortedStreams = this.sortStreams(filteredStreams, screenConfig.sorting);

      // Update queue
      this.queues.set(screen, sortedStreams);
      
      logger.info(
        `Updated queue for screen ${screen}: ${sortedStreams.length} streams (${streams.length - sortedStreams.length} filtered)`,
        'StreamManager'
      );

      // Emit queue update event
      this.emit('queueUpdate', { screen, queue: sortedStreams });
    } catch (error) {
      logger.error(
        `Failed to update queue for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private filterUnwatchedStreams(streams: StreamSource[], screen: number): StreamSource[] {
    // Get screen config
    const screenConfig = this.getScreenConfig(screen);
    if (!screenConfig) {
      logger.warn(`No config found for screen ${screen}, using default settings`, 'StreamManager');
    }

    // Check if we should skip watched streams
    // First check screen-specific setting, then global setting, default to true if neither is set
    const skipWatched = screenConfig?.skipWatchedStreams !== undefined ? 
      screenConfig.skipWatchedStreams : 
      (this.config.skipWatchedStreams !== undefined ? this.config.skipWatchedStreams : true);

    if (!skipWatched) {
      logger.info(`Watched stream skipping disabled for screen ${screen}`, 'StreamManager');
      return streams;
    }

    const unwatchedStreams = streams.filter((stream: StreamSource) => {
      const isWatched = this.isStreamWatched(stream.url);
      if (isWatched) {
        logger.debug(
          `Filtering out watched stream: ${stream.url} (${stream.title || 'No title'})`,
          'StreamManager'
        );
      }
      return !isWatched;
    });

    if (unwatchedStreams.length < streams.length) {
      logger.info(
        `Filtered out ${streams.length - unwatchedStreams.length} watched streams for screen ${screen}`,
        'StreamManager'
      );
    }

    return unwatchedStreams;
  }

  private isStreamWatched(url: string): boolean {
    // Use queueService to check watched status
    return queueService.getWatchedStreams().includes(url);
  }

  /**
   * Updates all queues for enabled screens
   * @param forceRefresh Whether to force a refresh for all screens
   */
  async updateAllQueues(forceRefresh = false): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    logger.info(`${forceRefresh ? 'Force updating' : 'Updating'} all stream queues...`, 'StreamManager');
    
    // Get all enabled screens
    const enabledScreens = this.getEnabledScreens();

    // Update queues for each screen
    for (const screen of enabledScreens) {
      await this.updateQueue(screen);
    }
  }

  /**
   * Synchronize disabled screens from config to PlayerService
   */
  private synchronizeDisabledScreens(): void {
    if (!this.config.player.screens) return;
    
    // Mark all disabled screens in the PlayerService
    for (const screenConfig of this.config.player.screens) {
      if (!screenConfig.enabled) {
        this.playerService.disableScreen(screenConfig.screen);
        logger.info(`Screen ${screenConfig.screen} marked as disabled during initialization`, 'StreamManager');
      }
    }
  }

  // Add method to force queue refresh
  public async forceQueueRefresh(): Promise<void> {
    logger.info('Forcing queue refresh for all screens', 'StreamManager');
    // Reset all refresh timestamps to force update
    this.lastStreamFetch = 0;
    for (const screen of this.getEnabledScreens()) {
      this.lastStreamRefresh.set(screen, 0);
    }
    // Clear any existing queues
    queueService.clearAllQueues();
    // Force update all queues
    await this.updateAllQueues(true);
  }

  // Add network recovery handler
  private setupNetworkRecovery(): void {
    let wasOffline = false;
    let recoveryAttempts = 0;
    let lastSuccessfulNetworkCheck = Date.now();
    let lastQueueRefreshAfterRecovery = 0;
    const RECOVERY_DELAY = 3000; // 3 seconds between recovery attempts (reduced from 5s)
    const MINIMUM_RECOVERY_INTERVAL = 120000; // Minimum 2 minutes between queue refreshes after recovery (increased from 1 min)
    const MAX_OFFLINE_TIME_BEFORE_FULL_RESET = 3600000; // 1 hour - after this time, do a full reset
    const NETWORK_CHECK_INTERVAL = 20000; // Check every 20 seconds (increased from 10s)
    
    // Use fewer, more reliable URLs
    const CHECK_URLS = [
      'https://1.1.1.1',
      'https://8.8.8.8'
    ];

    // Check network status periodically with increased interval
    setInterval(async () => {
      // Skip network checks if we're shutting down
      if (this.isShuttingDown) {
        return;
      }
      
      try {
        // Instead of sequential checks, use Promise.race to take the fastest response
        const checkPromises = CHECK_URLS.map(url => {
          return new Promise<boolean>((resolve) => {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 2000); // 2s timeout (reduced from 3s)
              
              fetch(url, { 
                signal: controller.signal,
                method: 'HEAD'  // Only request headers, not full content
              }).then(response => {
                clearTimeout(timeoutId);
                resolve(response.ok);
              }).catch(() => {
                clearTimeout(timeoutId);
                resolve(false);
              });
            } catch {
              resolve(false);
            }
          });
        });
        
        // Use any successful response
        const results = await Promise.all(checkPromises);
        const isOnline = results.some(result => result === true);

        if (isOnline) {
          // Update last successful check time
          lastSuccessfulNetworkCheck = Date.now();
        }

        if (!isOnline && !wasOffline) {
          // Just went offline
          wasOffline = true;
          recoveryAttempts = 0;
          this.isOffline = true; // Set the global offline flag
          logger.warn('Network connection lost - unable to reach any test endpoints', 'StreamManager');
        } else if (isOnline && wasOffline) {
          // Just came back online
          wasOffline = false;
          recoveryAttempts = 0;
          this.isOffline = false; // Reset the global offline flag
          
          const offlineDuration = Date.now() - lastSuccessfulNetworkCheck;
          const isLongOutage = offlineDuration > MAX_OFFLINE_TIME_BEFORE_FULL_RESET;
          
          logger.info(`Network connection restored after ${Math.round(offlineDuration/1000)} seconds, refreshing streams`, 'StreamManager');
          
          // Prevent too frequent queue refreshes after recovery
          if (Date.now() - lastQueueRefreshAfterRecovery < MINIMUM_RECOVERY_INTERVAL) {
            logger.info('Skipping queue refresh as one was performed recently', 'StreamManager');
            return;
          }
          
          lastQueueRefreshAfterRecovery = Date.now();
          
          // Execute recovery with delay to ensure network is stable
          setTimeout(async () => {
            // Don't attempt recovery if we're shutting down
            if (this.isShuttingDown) {
              return;
            }
            
            try {
              // For long outages, clear cached data to ensure fresh content
              if (isLongOutage) {
                logger.warn('Long network outage detected, clearing cached streams and queue data', 'StreamManager');
                this.cachedStreams = [];
                this.lastStreamFetch = 0;
                
                // Reset all queue processing flags that might be stuck
                this.queueProcessing.clear();
                this.queueProcessingStartTimes.clear();
                
                // Clear all timeouts
                for (const [screen, timeout] of this.queueProcessingTimeouts.entries()) {
                  clearTimeout(timeout);
                  this.queueProcessingTimeouts.delete(screen);
                }
              }
              
              // Only force refresh if all screens are empty or we had a long outage
              const activeStreams = this.getActiveStreams();
              const shouldForceRefresh = activeStreams.length === 0 || isLongOutage;
              
              if (shouldForceRefresh) {
                // Force refresh all queues and streams
                logger.info('Forcing queue refresh after network recovery', 'StreamManager');
                await this.forceQueueRefresh();
              } else {
                logger.info('Skipping force refresh as streams are still active', 'StreamManager');
              }
              
              // Check active streams and restart any that might have failed during outage
              logger.info(`Checking ${activeStreams.length} active streams after network recovery`, 'StreamManager');
              
              // For screens without active streams, try to start next in queue
              const enabledScreens = this.getEnabledScreens();
              
              // Process more screens at once, up from 2 to avoid limiting multi-screen setups
              for (const screen of enabledScreens.slice(0, 4)) {
                const hasActiveStream = activeStreams.some((s: StreamSource) => 
                  s.screen !== undefined && s.screen === screen
                );
                if (!hasActiveStream && !this.manuallyClosedScreens.has(screen)) {
                  logger.info(`No active stream on screen ${screen} after network recovery, attempting to start next stream`, 'StreamManager');
                  
                  // For long outages, reset the queue for this screen first
                  if (isLongOutage) {
                    logger.info(`Resetting queue for screen ${screen} after long outage`, 'StreamManager');
                    await this.updateQueue(screen);
                  }
                  
                  // Get the previously playing stream for this screen
                  const previousStream = this.streams.get(screen);
                  
                  // If the previously playing stream exists and isn't a dummy source, mark it as watched
                  // This prevents the stream from being reopened
                  if (previousStream && previousStream.url !== this.playerService.DUMMY_SOURCE) {
                    logger.info(`Marking previous stream as watched: ${previousStream.url}`, 'StreamManager');
                    queueService.markStreamAsWatched(previousStream.url);
                  }
                  
                  // Try to start a stream from the queue
                  await this.handleEmptyQueue(screen);
                }
              }
            } catch (error) {
              logger.error('Failed to execute network recovery actions', 'StreamManager', 
                error instanceof Error ? error : new Error(String(error))
              );
            }
          }, RECOVERY_DELAY);
        } else if (!isOnline && wasOffline) {
          // Still offline
          recoveryAttempts++;
          if (recoveryAttempts % 3 === 0) { // Log every ~60 seconds (3 * 20s interval)
            logger.warn(`Network still disconnected. Recovery will be attempted when connection is restored.`, 'StreamManager');
          }
        } else if (isOnline) {
          // Online - update the timestamp
          lastSuccessfulNetworkCheck = Date.now();
        }
      } catch (error) {
        if (!wasOffline) {
          wasOffline = true;
          recoveryAttempts = 0;
          this.isOffline = true; // Set the global offline flag
          logger.warn(
            'Network connection lost', 
            'StreamManager',
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }, NETWORK_CHECK_INTERVAL);
  }

  async refreshStreams(): Promise<void> {
    logger.info('Refreshing streams for all screens', 'StreamManager');
    for (const screen of this.screenConfigs.keys()) {
        await this.updateQueue(screen);
    }
  }

  // Add a method to periodically clean up finished streams
  private setupStreamCleanup(): void {
    setInterval(() => {
      const activeStreams = this.playerService.getActiveStreams();
      const activeScreens = new Set(activeStreams
        .filter((s: StreamSource) => s.screen !== undefined)
        .map((s: StreamSource) => s.screen));
      
      // Remove any streams that are no longer active
      for (const [screen] of this.streams.entries()) {
        if (!activeScreens.has(screen)) {
          logger.info(`Cleaning up finished stream on screen ${screen}`, 'StreamManager');
          this.streams.delete(screen);
          this.queueProcessing.delete(screen);
          this.queueProcessingStartTimes.delete(screen);
          const timeout = this.queueProcessingTimeouts.get(screen);
          if (timeout) {
            clearTimeout(timeout);
            this.queueProcessingTimeouts.delete(screen);
          }
        }
      }
    }, 5000); // Check every 5 seconds
  }

  private async getAllStreamsForScreen(screen: number): Promise<StreamSource[]> {
    const screenConfig = this.getScreenConfig(screen);
    if (!screenConfig || !screenConfig.sources?.length) {
      return [];
    }

    const streams: StreamSource[] = [];
    for (const source of screenConfig.sources) {
      if (!source.enabled) continue;

      try {
        let sourceStreams: StreamSource[] = [];
        if (source.type === 'holodex') {
          if (source.subtype === 'organization' && source.name) {
            sourceStreams = await this.holodexService.getLiveStreams({
              organization: source.name,
              limit: source.limit
            });
          } else if (source.subtype === 'favorites') {
            sourceStreams = await this.holodexService.getLiveStreams({
              channels: this.getFlattenedFavorites('holodex'),
              limit: source.limit
            });
          }
        } else if (source.type === 'twitch') {
          if (source.subtype === 'favorites') {
            sourceStreams = await this.twitchService.getStreams({
              channels: this.getFlattenedFavorites('twitch'),
              limit: source.limit
            });
          }
        }

        // Add source metadata to streams
        sourceStreams.forEach(stream => {
          stream.subtype = source.subtype;
          stream.priority = source.priority;
        });

        streams.push(...sourceStreams);
      } catch (error) {
        logger.error(
          `Failed to fetch streams for source ${source.type}/${source.subtype}`,
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }

    return streams;
  }

  /**
   * Helper method to get a flattened array of channel IDs across all groups for a platform
   * @param platform The platform to get favorites for (holodex, twitch, youtube)
   * @returns Array of channel IDs from all groups
   */
  private getFlattenedFavorites(platform: 'holodex' | 'twitch' | 'youtube'): string[] {
    if (!this.favoriteChannels || !this.favoriteChannels[platform]) {
      return [];
    }
    
    // Get all groups for this platform and flatten them into a single array
    const platformFavorites = this.favoriteChannels[platform];
    const allChannels: string[] = [];
    
    // Sort groups by priority (lower number = higher priority)
    const groupNames = Object.keys(platformFavorites);
    const sortedGroups = groupNames.sort((a, b) => {
      const priorityA = this.favoriteChannels.groups[a]?.priority || 999;
      const priorityB = this.favoriteChannels.groups[b]?.priority || 999;
      return priorityA - priorityB;
    });
    
    // Add channels from each group, maintaining priority order
    for (const groupName of sortedGroups) {
      const channelsInGroup = platformFavorites[groupName] || [];
      for (const channelId of channelsInGroup) {
        if (!allChannels.includes(channelId)) {
          allChannels.push(channelId);
        }
      }
    }
    
    return allChannels;
  }
  
  /**
   * Helper method to check if a channel is in any favorite group for a platform
   * @param platform The platform to check (holodex, twitch, youtube)
   * @param channelId The channel ID to check for
   * @returns True if the channel is in any favorite group for the platform
   */
  private isChannelInFavorites(platform: 'holodex' | 'twitch' | 'youtube', channelId: string): boolean {
    if (!this.favoriteChannels || !this.favoriteChannels[platform]) {
      return false;
    }
    
    const platformFavorites = this.favoriteChannels[platform];
    
    // Check each group for the channel ID
    for (const groupName in platformFavorites) {
      if (platformFavorites[groupName]?.includes(channelId)) {
        return true;
      }
    }
    
    return false;
  }
  
  private sortStreams(streams: StreamSource[], sorting?: { field: string; order: 'asc' | 'desc' }): StreamSource[] {
    if (!sorting) return streams;
    
    const { field, order } = sorting;
    
    return [...streams].sort((a, b) => {
      // Handle undefined values
      const aValue = a[field as keyof StreamSource];
      const bValue = b[field as keyof StreamSource];
      
      if (aValue === undefined && bValue === undefined) return 0;
      if (aValue === undefined) return order === 'asc' ? 1 : -1;
      if (bValue === undefined) return order === 'asc' ? -1 : 1;
      
      // Compare values based on their types
      if (typeof aValue === 'number' && typeof bValue === 'number') {
        return order === 'asc' ? aValue - bValue : bValue - aValue;
      }
      
      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return order === 'asc' 
          ? aValue.localeCompare(bValue) 
          : bValue.localeCompare(aValue);
      }
      
      // Default comparison for other types
      const aStr = String(aValue);
      const bStr = String(bValue);
      return order === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
    });
  }

  /**
   * Force refresh all queues and possibly restart streams on empty screens
   * This is useful for manual intervention when things aren't working correctly
   */
  public async forceRefreshAll(restartEmpty: boolean = true): Promise<void> {
    logger.info('Force refreshing all queues and possibly restarting streams', 'StreamManager');
    
    try {
      // Reset timestamps to force full refresh
      this.lastStreamFetch = 0;
      
      // Get all enabled screens
      const enabledScreens = this.getEnabledScreens();
      
      // Reset refresh timestamps for all screens
      this.resetRefreshTimestamps(enabledScreens);
      
      // Clear cache
      this.cachedStreams = [];
      
      // Update all queues in parallel
      const updatePromises = enabledScreens.map(screen => 
        this.updateQueue(screen).catch(error => {
          logger.error(
            `Failed to update queue for screen ${screen} during force refresh`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        })
      );
      
      await Promise.all(updatePromises);
      
      // Check for empty screens
      if (restartEmpty) {
        const activeStreams = this.getActiveStreams();
        const activeScreens = new Set(activeStreams.map(s => s.screen));
        
        // Find enabled screens without active streams
        const emptyScreens = enabledScreens.filter(screen => 
          !activeScreens.has(screen) && !this.manuallyClosedScreens.has(screen)
        );
        
        if (emptyScreens.length > 0) {
          logger.info(`Found ${emptyScreens.length} empty screens, starting streams: ${emptyScreens.join(', ')}`, 'StreamManager');
          
          // Start streams on empty screens in parallel
          const startPromises = emptyScreens.map(screen => 
            this.handleEmptyQueue(screen).catch(error => {
              logger.error(
                `Failed to start stream on screen ${screen} during force refresh`,
                'StreamManager',
                error instanceof Error ? error : new Error(String(error))
              );
            })
          );
          
          await Promise.all(startPromises);
        }
      }
      
      logger.info('Force refresh complete', 'StreamManager');
      return;
    } catch (error) {
      logger.error(
        'Error during force refresh',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }
}

// Create singleton instance
const config = loadAllConfigs();
// Create flattened favorites arrays for services
const flattenedHolodexFavorites: string[] = [];
if (config.favoriteChannels && config.favoriteChannels.holodex) {
  Object.values(config.favoriteChannels.holodex).forEach(channels => {
    if (Array.isArray(channels)) {
      flattenedHolodexFavorites.push(...channels);
    }
  });
}

const holodexService = new HolodexService(
  env.HOLODEX_API_KEY,
  config.filters?.filters ? config.filters.filters.map(f => typeof f === 'string' ? f : f.value) : [],
  flattenedHolodexFavorites,
  config
);
const twitchService = new TwitchService(
  env.TWITCH_CLIENT_ID,
  env.TWITCH_CLIENT_SECRET,
  config.filters?.filters ? config.filters.filters.map(f => typeof f === 'string' ? f : f.value) : []
);
// Create flattened YouTube favorites array
const flattenedYoutubeFavorites: string[] = [];
if (config.favoriteChannels && config.favoriteChannels.youtube) {
  Object.values(config.favoriteChannels.youtube).forEach(channels => {
    if (Array.isArray(channels)) {
      flattenedYoutubeFavorites.push(...channels);
    }
  });
}

const youtubeService = new YouTubeService(
  flattenedYoutubeFavorites
);
const playerService = new PlayerService(config);
const keyboardService = new KeyboardService();

export const streamManager = new StreamManager(
  config,
  holodexService,
  twitchService,
  youtubeService,
  playerService,
  keyboardService
); 