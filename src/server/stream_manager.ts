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
  StreamPlatform,
  StreamEnd
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
  private readonly QUEUE_UPDATE_INTERVAL = 60 * 1000; // 1 minute (reduced from 3 minutes)
  private readonly STREAM_START_TIMEOUT = 10 * 1000; // 10 seconds (reduced from 20 seconds)
  private readonly QUEUE_PROCESSING_TIMEOUT = 10 * 1000; // 10 seconds (reduced from 20 seconds)
  private readonly STREAM_REFRESH_INTERVAL = 60 * 1000; // 1 minute (reduced from 2 minutes)
  private readonly RETRY_INTERVAL = 1000; // 1 second (reduced from 2 seconds)
  private readonly STREAM_CACHE_TTL = 30000; // 30 seconds (reduced from 60 seconds)
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
  private errorCallback?: (data: StreamError) => void;
  private manuallyClosedScreens: Set<number> = new Set();
  private streamRetries: Map<number, number> = new Map();
  private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
  private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
  private fifoPaths: Map<number, string> = new Map();
  private ipcPaths: Map<number, string> = new Map();
  private cachedStreams: StreamSource[] = []; // Cache for stream metadata
  private lastStreamFetch: number = 0; // Timestamp of last stream fetch
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
    playerService: PlayerService
  ) {
    super(); // Initialize EventEmitter
    this.config = config;
    this.holodexService = holodexService;
    this.twitchService = twitchService;
    this.youtubeService = youtubeService;
    this.playerService = playerService;
    this.keyboardService = new KeyboardService();
    this.isOffline = false; // Initialize offline state
    this.favoriteChannels = config.favoriteChannels || {
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
    
    // Initialize screenConfigs before other initialization that might use it
    this.screenConfigs = new Map(config.player.screens.map(screen => [
      screen.screen, 
      {
        screen: screen.screen,
        id: screen.id,
        enabled: screen.enabled,
        volume: config.player.defaultVolume,
        quality: config.player.defaultQuality,
        windowMaximized: config.player.windowMaximized,
        maxStreams: 1
      }
    ]));
    
    // Now that screenConfigs is initialized, we can safely initialize queues
    this.initializeQueues();
    
    // Synchronize disabled screens from config
    this.synchronizeDisabledScreens();

    logger.info('Stream manager initialized', 'StreamManager');

    // Handle stream end events
    this.playerService.onStreamError(async (data: StreamError) => {
      try {
        // If screen was manually closed, ignore the error
        if (this.manuallyClosedScreens.has(data.screen)) {
          logger.info(`Screen ${data.screen} was manually closed, ignoring error`, 'StreamManager');
          // Attempt to clean up anyway, just in case
          this.queueProcessing.delete(data.screen);
          this.queueProcessingStartTimes.delete(data.screen);
          const timeout = this.queueProcessingTimeouts.get(data.screen);
          if (timeout) {
              clearTimeout(timeout);
              this.queueProcessingTimeouts.delete(data.screen);
          }
          return;
        }

        // Clear any existing timeouts for this screen
        const existingTimeout = this.queueProcessingTimeouts.get(data.screen);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          this.queueProcessingTimeouts.delete(data.screen);
        }

        // If queue is already being processed for this screen, check how long it's been processing
        if (this.queueProcessing.has(data.screen)) {
          const startTime = this.queueProcessingStartTimes.get(data.screen);
          if (startTime && Date.now() - startTime > 10000) {
            logger.warn(`Queue processing stuck for screen ${data.screen}, resetting state`, 'StreamManager');
            this.queueProcessing.delete(data.screen);
            this.queueProcessingStartTimes.delete(data.screen);
          } else {
            logger.info(`Queue already being processed for screen ${data.screen}`, 'StreamManager');
            return;
          }
        }

        // Set a timeout to clear the queue processing flag if it gets stuck
        const timeout = setTimeout(() => {
          if (this.queueProcessing.has(data.screen)) {
            logger.warn(`Queue processing flag stuck for screen ${data.screen}, clearing it`, 'StreamManager');
            this.queueProcessing.delete(data.screen);
            this.queueProcessingStartTimes.delete(data.screen);
          }
        }, 30000);

        this.queueProcessingTimeouts.set(data.screen, timeout);
        this.queueProcessing.add(data.screen);
        this.queueProcessingStartTimes.set(data.screen, Date.now());

        // Get the URL of the stream that actually failed
        const failedUrl = data.url;
        if (!failedUrl) {
            logger.error(`Stream error event for screen ${data.screen} missing URL, cannot process queue.`, 'StreamManager');
            // Clean up processing state and exit
            this.queueProcessing.delete(data.screen);
            this.queueProcessingStartTimes.delete(data.screen);
            const timeout = this.queueProcessingTimeouts.get(data.screen);
            if (timeout) {
                clearTimeout(timeout);
                this.queueProcessingTimeouts.delete(data.screen);
            }
            return;
        }

        // Get the current queue from queueService *before* modification
        let currentQueue = queueService.getQueue(data.screen);

        // Find the index of the failed stream in the *current* queue
        const failedIndex = currentQueue.findIndex((item: StreamSource) => item.url === failedUrl);

        if (failedIndex !== -1) {
          logger.info(`Removing failed stream ${failedUrl} from queue for screen ${data.screen}`, 'StreamManager');
          // Remove the stream using queueService
          queueService.removeFromQueue(data.screen, failedIndex);
          // Update the local copy of the queue *after* removal
          currentQueue = queueService.getQueue(data.screen);
        } else {
          logger.warn(`Could not find failed stream ${failedUrl} in queue for screen ${data.screen}`, 'StreamManager');
        }

        // Now, filter the *updated* queue
        const screenConfig = this.getScreenConfig(data.screen);
        const filteredQueue = screenConfig?.skipWatchedStreams
          ? currentQueue.filter((stream: StreamSource) => !this.isStreamWatched(stream.url)) // Use updated isStreamWatched
          : currentQueue;

        if (filteredQueue.length === 0) {
          logger.info(`No more streams in queue for screen ${data.screen} after removing failed stream and filtering`, 'StreamManager');
          await this.handleEmptyQueue(data.screen); // handleEmptyQueue uses queueService
          return;
        }

        // The next stream is now at index 0 of the filtered queue
        const nextStream = filteredQueue[0];
        if (nextStream) {
          logger.info(`Starting next stream in queue for screen ${data.screen}: ${nextStream.url}`, 'StreamManager');

          // Remove the *next* stream from the queue *before* attempting to start it
          const nextStreamIndex = currentQueue.findIndex((item: StreamSource) => item.url === nextStream.url);
          if (nextStreamIndex !== -1) {
             logger.debug(`Removing next stream ${nextStream.url} from queue before starting.`, 'StreamManager');
             queueService.removeFromQueue(data.screen, nextStreamIndex);
          } else {
             // This might happen if filtering removed the stream between getting currentQueue and filtering
             logger.warn(`Could not find next stream ${nextStream.url} in current queue for removal before starting. It might have been filtered.`, 'StreamManager');
          }

          // Attempt to start the stream
          await this.startStream({
            url: nextStream.url,
            screen: data.screen,
            title: nextStream.title,
            viewerCount: nextStream.viewerCount,
            startTime: nextStream.startTime
          });
        } else {
          // This case might occur if filtering removes all streams after removing the failed one
          logger.info(`No suitable streams left in queue for screen ${data.screen} after filtering`, 'StreamManager');
          await this.handleEmptyQueue(data.screen);
        }
      } catch (error) {
        logger.error(`Error handling stream error for screen ${data.screen}:`, 'StreamManager', error instanceof Error ? error : new Error(String(error)));
      } finally {
        // Always clear the processing flag and timeout
        this.queueProcessing.delete(data.screen);
        this.queueProcessingStartTimes.delete(data.screen);
        const timeout = this.queueProcessingTimeouts.get(data.screen);
        if (timeout) {
          clearTimeout(timeout);
          this.queueProcessingTimeouts.delete(data.screen);
        }
      }
    });

    // Set up stream end handler
    this.playerService.onStreamEnd(async (data: StreamEnd) => {
      try {
        // Check if we're already processing this screen
        if (this.queueProcessing.has(data.screen)) {
          logger.info(`Already processing queue for screen ${data.screen}, skipping`, 'StreamManager');
          return;
        }

        // Clear any existing timeouts for this screen
        const existingTimeout = this.queueProcessingTimeouts.get(data.screen);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          this.queueProcessingTimeouts.delete(data.screen);
        }

        // Set up a new timeout for this screen
        const timeout = setTimeout(() => {
          logger.warn(`Queue processing timeout for screen ${data.screen}, clearing state`, 'StreamManager');
          this.queueProcessing.delete(data.screen);
          this.queueProcessingStartTimes.delete(data.screen);
          this.queueProcessingTimeouts.delete(data.screen);
        }, 30000);
        this.queueProcessingTimeouts.set(data.screen, timeout);
        this.queueProcessing.add(data.screen);

        // Get current queue and filter out watched streams based on configuration
        const queue = this.queues.get(data.screen) || [];
        const filteredQueue = this.filterUnwatchedStreams(queue, data.screen);
        
        if (filteredQueue.length === 0) {
          logger.info(`No unwatched streams in queue for screen ${data.screen}, handling empty queue`, 'StreamManager');
          await this.handleEmptyQueue(data.screen);
          return;
        }

        // Get the next stream from the filtered queue
        const nextStream = filteredQueue[0];
        if (!nextStream) {
          logger.info(`No next stream in filtered queue for screen ${data.screen}`, 'StreamManager');
          await this.handleEmptyQueue(data.screen);
          return;
        }

        // Remove the current stream from the queue if it exists
        const currentStream = this.getActiveStreams().find((s: StreamSource) => 
          s.screen !== undefined && s.screen === data.screen
        );
        if (currentStream) {
          const currentIndex = queue.findIndex((item: StreamSource) => item.url === currentStream.url);
          if (currentIndex !== -1) {
            logger.info(`Removing current stream ${currentStream.url} from queue`, 'StreamManager');
            this.queues.set(data.screen, queue.filter((_, index) => index !== currentIndex));
          }
        }

        // Start the next stream
        logger.info(`Starting next stream in queue for screen ${data.screen}: ${nextStream.url}`, 'StreamManager');
        await this.startStream({
          url: nextStream.url,
          screen: data.screen,
          quality: this.config.player.defaultQuality,
          title: nextStream.title,
          viewerCount: nextStream.viewerCount,
          startTime: nextStream.startTime
        });

        // Remove the started stream from the queue
        const updatedQueue = queue.filter(item => item.url !== nextStream.url);
        this.queues.set(data.screen, updatedQueue);

      } catch (error) {
        logger.error(
          `Failed to handle stream end for screen ${data.screen}`,
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      } finally {
        // Clean up processing state
        const timeout = this.queueProcessingTimeouts.get(data.screen);
        if (timeout) {
          clearTimeout(timeout);
          this.queueProcessingTimeouts.delete(data.screen);
        }
        this.queueProcessing.delete(data.screen);
      }
    });

    this.initializeQueues();
    this.startQueueUpdates();
    this.setupNetworkRecovery();

    // Initialize stream cleanup
    this.setupStreamCleanup();
  }

  private async handleStreamEnd(screen: number): Promise<void> {
    logger.info(`Handling stream end for screen ${screen}`, 'StreamManager');

    // Guard against multiple concurrent calls for the same screen
    if (this.queueProcessing.has(screen)) {
      logger.warn(`Already processing queue for screen ${screen}, ignoring this call`, 'StreamManager');
      return;
    }

    // Mark that we're processing this screen's queue
    this.queueProcessing.add(screen);
    this.queueProcessingStartTimes.set(screen, Date.now());
    logger.debug(`Starting queue processing for screen ${screen} at ${new Date().toISOString()}`, 'StreamManager');

    try {
      // Process concurrently for faster transitions
      const stopPromise = this.playerService.stopStream(screen, true);
      
      // While stopping, prepare the next stream
      const queue = this.queues.get(screen) || [];
      logger.debug(`Current queue for screen ${screen} has ${queue.length} items`, 'StreamManager');
      
      const nextStream = queue.length > 0 ? queue[0] : null;

      // Await the stop operation
      await stopPromise;
      
      // Ensure we're no longer tracking this stream
      if (this.streams.has(screen)) {
        logger.debug(`Removing stream tracking for screen ${screen}`, 'StreamManager');
        this.streams.delete(screen);
      } else {
        logger.debug(`No stream to remove from tracking for screen ${screen}`, 'StreamManager');
      }

      if (!nextStream) {
        logger.info(`No next stream in queue for screen ${screen}, looking for new streams`, 'StreamManager');
        await this.handleEmptyQueue(screen);
        return;
      }

      // Remove the stream from queue before starting it
      queue.shift();
      this.queues.set(screen, queue);
      logger.info(`Starting next stream in queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');
      logger.debug(`Queue now has ${queue.length} items after removing next stream`, 'StreamManager');
      
      // Start the stream immediately
      logger.debug(`Calling startStream for screen ${screen} with url ${nextStream.url}`, 'StreamManager');
      await this.startStream({
        url: nextStream.url,
        screen,
        quality: 'best',
        windowMaximized: true
      });
      logger.debug(`Successfully started stream on screen ${screen}`, 'StreamManager');
    } catch (error) {
      logger.error(
        `Failed to start next stream on screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      
      // If starting the stream fails, try to update the queue immediately
      logger.debug(`Calling handleEmptyQueue after failure for screen ${screen}`, 'StreamManager');
      await this.handleEmptyQueue(screen);
    } finally {
      // Always clear the processing flags and timeouts
      logger.debug(`Clearing processing state for screen ${screen}`, 'StreamManager');
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      this.clearQueueProcessingTimeout(screen);
      logger.debug(`Finished handling stream end for screen ${screen} at ${new Date().toISOString()}`, 'StreamManager');
    }
  }

  private async handleEmptyQueue(screen: number): Promise<void> {
    try {
      // If screen was manually closed, don't update queue
       if (this.manuallyClosedScreens.has(screen)) {
        logger.info(`Screen ${screen} was manually closed, not updating queue`, 'StreamManager');
        return;
      }

      // Prevent concurrent queue processing
      if (this.queueProcessing.has(screen)) {
        logger.info(`Queue processing already in progress for screen ${screen}`, 'StreamManager');
         return;
      }

      // Set queue processing flag with a short timeout
      this.queueProcessing.add(screen);
      this.queueProcessingStartTimes.set(screen, Date.now());
      
      const timeoutId = setTimeout(() => {
        logger.warn(`Queue processing timed out for screen ${screen}`, 'StreamManager');
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
      }, 15000); // Reduced from 30s to 15s
      
      this.queueProcessingTimeouts.set(screen, timeoutId);

      try {
        // Force reset cache timestamp to get fresh data
        this.lastStreamFetch = 0;
        this.lastStreamRefresh.set(screen, 0);
        
        // Update queue to get fresh streams
        await this.updateQueue(screen);
        
        // Get updated queue
        const queue = this.queues.get(screen) || [];
        
        if (queue.length > 0) {
          // Remove the stream from queue before starting it
          const nextStream = queue[0];
          queue.shift();
          this.queues.set(screen, queue);
          
          logger.info(`Starting stream from refreshed queue on screen ${screen}: ${nextStream.url}`, 'StreamManager');
          
          await this.startStream({
            url: nextStream.url,
            screen,
            quality: 'best',
            windowMaximized: true
          });
        } else {
          logger.info(`No streams available for screen ${screen} after queue update`, 'StreamManager');
          
          // Try adding a test stream when no streams are available
          await this.addDefaultTestStream(screen);
        }
      } finally {
        // Clear processing flag and timeout
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.clearQueueProcessingTimeout(screen);
      }
    } catch (error) {
      logger.error(
        `Error handling empty queue for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      this.clearQueueProcessingTimeout(screen);
    }
  }

  // Helper method to add a default test stream if queues are empty
  private async addDefaultTestStream(screen: number): Promise<void> {
    logger.info(`Adding default test stream for screen ${screen}`, 'StreamManager');
    
    try {
      // Default test streams - try YouTube first, then Twitch
      const testStreams = [
        {
          url: "https://www.youtube.com/watch?v=jfKfPfyJRdk", // YouTube lofi beats
          title: "Default Test Stream - YouTube",
          platform: "youtube"
        },
        {
          url: "https://www.twitch.tv/twitchpresents",
          title: "Default Test Stream - Twitch",
          platform: "twitch"
        }
      ];
      
      // Try to add the first test stream
      const testStream = testStreams[0];
      const source: StreamSource = {
        url: testStream.url,
        title: testStream.title,
        platform: testStream.platform as 'youtube' | 'twitch',
        viewerCount: 100,
        thumbnail: '',
        sourceStatus: 'live',
        startTime: Date.now(),
        priority: 1,
        screen
      };
      
      await this.addToQueue(screen, source);
      
      // Try to start the stream immediately
      await this.startStream({
        url: source.url,
        screen,
        quality: 'best',
        windowMaximized: true
      });
      
      logger.info(`Added and started default test stream for screen ${screen}`, 'StreamManager');
    } catch (error) {
      logger.error(
        `Failed to add default test stream for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  private clearQueueProcessingTimeout(screen: number): void {
    const timeout = this.queueProcessingTimeouts.get(screen);
    if (timeout) {
      logger.debug(`Clearing queue processing timeout for screen ${screen}`, 'StreamManager');
      clearTimeout(timeout);
      this.queueProcessingTimeouts.delete(screen);
    } else {
      logger.debug(`No queue processing timeout to clear for screen ${screen}`, 'StreamManager');
    }
  }

  private async handleAllStreamsWatched(screen: number) {
    logger.info(`All streams watched for screen ${screen}, refetching immediately...`);
    
    // Clear watched history to allow playing again
    queueService.clearWatchedStreams();
    logger.info(`Cleared watched streams history for screen ${screen}`, 'StreamManager');
    
    // Skip the waiting period and refresh immediately
    logger.info(`Fetching new streams after all watched for screen ${screen}`, 'StreamManager');
    
    // Force reset cache timestamp to get fresh data
    this.lastStreamFetch = 0;
    this.lastStreamRefresh.set(screen, 0);
    
    // Update queue to get fresh streams
    await this.updateQueue(screen);
    
    // Process the queue immediately
    await this.handleEmptyQueue(screen);
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
    logger.info(`Stopping stream on screen ${screen}, manualStop=${isManualStop}`, 'StreamManager');
    
    const activeStream = this.streams.get(screen);
    if (activeStream) {
      logger.debug(`Active stream on screen ${screen}: ${activeStream.url}`, 'StreamManager');
    } else {
      logger.debug(`No active stream found in manager for screen ${screen}`, 'StreamManager');
    }
    
    try {
      if (isManualStop) {
        this.manuallyClosedScreens.add(screen);
        logger.info(`Screen ${screen} manually closed, added to manuallyClosedScreens`, 'StreamManager');
      }

      // Safety check - don't allow processing queue during stop
      if (this.queueProcessing.has(screen)) {
        logger.debug(`Clearing existing queue processing for screen ${screen}`, 'StreamManager');
        this.queueProcessing.delete(screen);
      }
      this.clearQueueProcessingTimeout(screen);

      // Stop the stream in player service
      logger.debug(`Calling player service to stop stream on screen ${screen}`, 'StreamManager');
      const success = await this.playerService.stopStream(screen, true, isManualStop);
      logger.debug(`Player service stopStream result: ${success} for screen ${screen}`, 'StreamManager');
      
      // Clean up all related resources
      if (success) {
        logger.debug(`Successfully stopped stream on screen ${screen}, cleaning up resources`, 'StreamManager');
        this.streams.delete(screen);
        this.clearInactiveTimer(screen);
        this.clearStreamRefresh(screen);
        
        // Also clear these timers to be safe
        const streamRefreshTimer = this.streamRefreshTimers.get(screen);
        if (streamRefreshTimer) {
          logger.debug(`Clearing stream refresh timer for screen ${screen}`, 'StreamManager');
          clearTimeout(streamRefreshTimer);
          this.streamRefreshTimers.delete(screen);
        }
        
        this.lastStreamRefresh.delete(screen);
      } else {
        logger.warn(`Failed to stop stream on screen ${screen}, forcing cleanup`, 'StreamManager');
        this.streams.delete(screen);
        this.clearInactiveTimer(screen);
        this.clearStreamRefresh(screen);
      }
      
      // Force synchronize after stopping
      logger.debug(`Synchronizing streams after stopping screen ${screen}`, 'StreamManager');
      this.synchronizeStreams();
      
      return success;
    } catch (error) {
      logger.error(`Error stopping stream on screen ${screen}`, 'StreamManager', 
        error instanceof Error ? error : new Error(String(error)));
      
      // Force cleanup anyway on error
      logger.debug(`Forcing cleanup after error for screen ${screen}`, 'StreamManager');
      this.streams.delete(screen);
      this.clearInactiveTimer(screen);
      this.clearStreamRefresh(screen);
      
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
      logger.debug(
        `Using cached streams (${this.cachedStreams.length} streams, age: ${
          now - this.lastStreamFetch
        }ms)`,
        'StreamManager'
      );
      return this.cachedStreams;
    }

    logger.info('Fetching fresh stream data...', 'StreamManager');
    
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

        // Process each source
        for (const source of sortedSources) {
          try {
            // Get streams based on source type
            let sourceStreams: StreamSource[] = [];

            if (source.type === 'holodex') {
              if (source.subtype === 'organization' && source.name) {
                sourceStreams = await this.holodexService.getLiveStreams({
                  organization: source.name as string,
                  limit: source.limit || 50
                });
              } else if (source.subtype === 'favorites') {
                sourceStreams = await this.holodexService.getLiveStreams({
                  channels: this.getFlattenedFavorites('holodex'),
                  limit: source.limit || 50
                });
              }
            } else if (source.type === 'twitch') {
              if (source.subtype === 'favorites') {
                sourceStreams = await this.twitchService.getStreams({
                  channels: this.getFlattenedFavorites('twitch'),
                  limit: source.limit || 50
                });
              }
            }

            // Filter out any streams with 'ended' status
            sourceStreams = sourceStreams.filter(stream => {
              // For ended streams, filter them out
              if (stream.sourceStatus === 'ended') {
                logger.debug(`Filtering out ended stream: ${stream.url}`, 'StreamManager');
                return false;
              }
              
              // For upcoming streams, check if they're in the past
              if (stream.sourceStatus === 'upcoming' && stream.startTime) {
                // If the start time is in the past by more than 30 minutes, filter it out
                if (stream.startTime < now - 30 * 60 * 1000) {
                  logger.debug(`Filtering out past upcoming stream: ${stream.url}`, 'StreamManager');
                  return false;
                }
              }
              
              return true;
            });

            // Add screen and priority information to all streams from this source
            sourceStreams.forEach(stream => {
              stream.screen = screenNumber;
              stream.priority = source.priority || 999;
              stream.subtype = source.subtype;
            });

            // Add the streams to our results
            results.push(...sourceStreams);
          } catch (error) {
            logger.error(
              `Error fetching streams for ${source.type}:${source.subtype}`,
              'StreamManager',
              error instanceof Error ? error : new Error(String(error))
            );
          }
        }
      }

      // Save to cache
      this.cachedStreams = results;
      this.lastStreamFetch = now;

      logger.info(`Fetched ${results.length} streams from all sources`, 'StreamManager');
      
      return results;
    } catch (error) {
      logger.error('Failed to fetch streams', 'StreamManager', 
        error instanceof Error ? error : new Error(String(error)));
      
      // If this is not a retry, try once more
      if (retryCount < 1) {
        logger.info('Retrying stream fetch...', 'StreamManager');
        return this.getLiveStreams(retryCount + 1);
      }
      
      // Return cached streams if available, otherwise empty array
      return this.cachedStreams.length > 0 ? this.cachedStreams : [];
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
      // Get all enabled screens with autoStart enabled from streams config
      const autoStartScreens = this.config.streams
        .filter(stream => stream.enabled && stream.autoStart)
        .map(stream => stream.screen);
      
      if (autoStartScreens.length === 0) {
        logger.info('No screens configured for auto-start', 'StreamManager');
        return;
      }
      
      logger.info(`Auto-starting streams for screens: ${autoStartScreens.join(', ')}`, 'StreamManager');
      
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
            
            return 0;
          });
          
          // Set up the queue first
          if (screenStreams.length > 0) {
            queueService.setQueue(screen, screenStreams);
            logger.info(`Initialized queue for screen ${screen} with ${screenStreams.length} streams`, 'StreamManager');
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
          
          return 0; //(b.viewerCount || 0) - (a.viewerCount || 0);
        });
        
        if (screenStreams.length > 0) {
          // Take the first stream to play and queue the rest
          const [firstStream, ...queueStreams] = screenStreams;
          
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
    
    // Check if stream already exists in queue
    const exists = queue.some(item => item.url === source.url);
    if (exists) {
      logger.info(`Stream ${source.url} already in queue for screen ${screen}`, 'StreamManager');
      return;
    }
    
    queue.push(source);
    this.queues.set(screen, queue);
    
    // Also update the queue service to ensure consistency
    queueService.setQueue(screen, queue);
    
    logger.info(`Added stream ${source.url} to queue for screen ${screen}`, 'StreamManager');
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
    this.config.player.screens.forEach(screen => {
      this.queues.set(screen.screen, []);
    });
    // Force update all queues after initialization
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
    if (this.updateInterval) {
      return; // Already running
    }

    const updateQueues = async (force: boolean = false) => {
      if (this.isShuttingDown) {
        return;
      }

      logger.info('Updating stream queues...', 'StreamManager');
      
      // Get all enabled screens
      const enabledScreens = this.config.streams
        .filter(stream => stream.enabled)
        .map(stream => stream.screen);

      // Update queues for each screen
      for (const screen of enabledScreens) {
        try {
          // Skip screens that are already being processed
          if (this.queueProcessing.has(screen)) {
            logger.info(`Queue processing already in progress for screen ${screen}, skipping`, 'StreamManager');
            continue;
          }

          // Check if there's an active stream on this screen
          const activeStream = this.getActiveStreams().find(s => s.screen === screen);
          
          if (!activeStream) {
            // If no active stream and screen isn't manually closed, try to start a new one
            if (!this.manuallyClosedScreens.has(screen)) {
              const now = Date.now();
              const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
              const timeSinceLastRefresh = now - lastRefresh;
              
              // Only attempt to start new streams if forced or if it's been long enough since last refresh
              if (force || timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL) {
                logger.info(`No active stream on screen ${screen}, fetching new streams`, 'StreamManager');
                // Mark as processing to prevent concurrent queue processing
                this.queueProcessing.add(screen);
                try {
                  // Reset last stream fetch to force fresh data
                  this.lastStreamFetch = 0;
                  const streams = await this.getLiveStreams();
            const availableStreams = streams.filter(s => s.screen === screen);
            
            if (availableStreams.length > 0) {
                    // Start first stream immediately
                    const firstStream = availableStreams[0];
                    await this.startStream({
                      url: firstStream.url,
                      screen,
                      quality: this.config.player.defaultQuality,
                      title: firstStream.title,
                      viewerCount: firstStream.viewerCount,
                      startTime: firstStream.startTime
                    });
                    
                    // Set remaining streams in queue
                    if (availableStreams.length > 1) {
                      queueService.setQueue(screen, availableStreams.slice(1));
                    }
                    
                    this.lastStreamRefresh.set(screen, now);
                  } else {
                    logger.info(`No available streams found for screen ${screen}`, 'StreamManager');
                  }
                } catch (error) {
                  logger.error(
                    `Failed to fetch streams for screen ${screen}`,
                    'StreamManager',
                    error instanceof Error ? error : new Error(String(error))
                  );
                } finally {
                  // Always clear the processing flag
                  this.queueProcessing.delete(screen);
                }
                } else {
                logger.info(`No active stream on screen ${screen}, but refresh interval not elapsed. Skipping refresh.`, 'StreamManager');
                }
              } else {
              logger.info(`Screen ${screen} was manually closed, not starting new streams`, 'StreamManager');
            }
          }
        } catch (error) {
          logger.error(
            `Failed to update queue for screen ${screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
          // Ensure processing flag is cleared on error
          this.queueProcessing.delete(screen);
        }
      }
    };

    // Initial update
    await updateQueues(true); // Force initial update

    // Set up interval for periodic updates
    this.updateInterval = setInterval(async () => {
      await updateQueues();
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
      if (streams.length === 0) {
        logger.info(`No streams found for screen ${screen}, queue will be empty`, 'StreamManager');
      }
      
      // Log stream status distribution
      const liveCount = streams.filter(s => s.sourceStatus === 'live').length;
      const upcomingCount = streams.filter(s => s.sourceStatus === 'upcoming').length;
      const otherCount = streams.length - liveCount - upcomingCount;
      
      logger.info(
        `Stream status breakdown for screen ${screen}: ${liveCount} live, ${upcomingCount} upcoming, ${otherCount} other`,
        'StreamManager'
      );
      
      // Filter out watched streams based on configuration
      const filteredStreams = this.filterUnwatchedStreams(streams, screen);

      // Sort streams
      const sortedStreams = this.sortStreams(filteredStreams, screenConfig.sorting);

      // Update queue
      this.queues.set(screen, sortedStreams);
      queueService.setQueue(screen, sortedStreams);
      
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

    // Early return if no enabled screens
    if (enabledScreens.length === 0) {
      logger.info('No enabled screens to update queues for', 'StreamManager');
      return;
    }

    try {
      // Use Promise.all for parallel updates to reduce total processing time
      await Promise.all(enabledScreens.map(async (screen) => {
        try {
          return this.updateQueue(screen);
        } catch (error) {
          logger.error(
            `Failed to update queue for screen ${screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }));
      logger.info('All queues updated successfully', 'StreamManager');
    } catch (error) {
      logger.error(
        'Error updating all queues',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
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
    
    // Save ALL existing streams to preserve them
    const existingStreams = new Map<number, StreamSource[]>();
    for (const [screen, queue] of this.queues.entries()) {
      if (queue.length > 0) {
        existingStreams.set(screen, [...queue]);
        logger.info(`Preserving ${queue.length} existing streams for screen ${screen}`, 'StreamManager');
      }
    }
    
    // Reset all refresh timestamps to force update
    this.lastStreamFetch = 0;
    
    // Get all enabled screens
    const enabledScreens = this.getEnabledScreens();
    
    // Clear last refresh timestamps for all screens to force fresh fetch
    for (const screen of enabledScreens) {
      this.lastStreamRefresh.set(screen, 0);
    }
    
    // Do NOT clear existing queues before fetching - we'll merge instead
    logger.info('Fetching fresh stream data for all screens', 'StreamManager');
    
    // Force update all queues
    try {
      await this.updateAllQueues(true);
      
      // After fetching new streams, restore preserved streams for each screen
      for (const [screen, preserved] of existingStreams.entries()) {
        const currentQueue = this.queues.get(screen) || [];
        
        // Avoid duplicates by creating a Set of URLs in the current queue
        const currentUrls = new Set(currentQueue.map(stream => stream.url));
        
        // Filter preserved streams to only include those not already in the queue
        const uniquePreserved = preserved.filter(stream => !currentUrls.has(stream.url));
        
        if (uniquePreserved.length > 0) {
          // Merge current queue with preserved streams
          const newQueue = [...currentQueue, ...uniquePreserved];
          
          // Update the queue
          this.queues.set(screen, newQueue);
          queueService.setQueue(screen, newQueue);
          
          logger.info(`Restored ${uniquePreserved.length} preserved streams for screen ${screen}`, 'StreamManager');
        }
      }
    } catch (error) {
      logger.error('Error during queue refresh', 'StreamManager', 
        error instanceof Error ? error : new Error(String(error)));
      
      // If fetch fails, restore all preserved streams as a fallback
      if (existingStreams.size > 0) {
        logger.info('Fetch failed - restoring preserved streams', 'StreamManager');
        for (const [screen, preserved] of existingStreams.entries()) {
          this.queues.set(screen, preserved);
          queueService.setQueue(screen, preserved);
        }
      }
    }
  }

  // Add network recovery handler
  private setupNetworkRecovery(): void {
    let wasOffline = false;
    let recoveryAttempts = 0;
    let lastSuccessfulNetworkCheck = Date.now();
    let lastQueueRefreshAfterRecovery = 0;
    const RECOVERY_DELAY = 2000; // 2 seconds between recovery attempts (reduced from 5 seconds)
    const MINIMUM_RECOVERY_INTERVAL = 20000; // 20 seconds between queue refreshes after recovery (reduced from 60 seconds)
    const MAX_OFFLINE_TIME_BEFORE_FULL_RESET = 3600000; // 1 hour - after this time, do a full reset
    
    const CHECK_URLS = [
      'https://8.8.8.8',
      'https://1.1.1.1',
      'https://google.com',
      'https://cloudflare.com'
    ];

    // Check network status periodically
    setInterval(async () => {
      try {
        // Try each URL until one succeeds
        let isOnline = false;
        for (const url of CHECK_URLS) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout
            
            const response = await fetch(url, { 
              signal: controller.signal,
              method: 'HEAD'  // Only request headers, not full content
            });
            clearTimeout(timeoutId);
            
            if (response.ok) {
              isOnline = true;
              lastSuccessfulNetworkCheck = Date.now();
              break;
            }
          } catch {
            // Continue to next URL if this one fails
            continue;
          }
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
            try {
              // First, ensure all essential properties are initialized
              if (!this.screenConfigs) {
                logger.warn('Reinitializing screenConfigs after network outage', 'StreamManager');
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
              }
              
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
              
              // Force refresh all queues and streams
              logger.info('Forcing queue refresh after network recovery', 'StreamManager');
              await this.forceQueueRefresh();
              
              // Check active streams and restart any that might have failed during outage
              const activeStreams = this.getActiveStreams();
              logger.info(`Checking ${activeStreams.length} active streams after network recovery`, 'StreamManager');
              
              // For screens without active streams, try to start next in queue
              const enabledScreens = this.getEnabledScreens();
              for (const screen of enabledScreens) {
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
                  
                  // Try to start a stream from the queue
                  await this.handleEmptyQueue(screen);
                  
                  // If queue is still empty after trying to update it, force another update
                  const queue = queueService.getQueue(screen);
                  if (queue.length === 0) {
                    logger.warn(`Queue still empty for screen ${screen} after recovery, forcing another update`, 'StreamManager');
                    await this.updateAllQueues(true);
                    await this.handleEmptyQueue(screen);
                  }
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
          if (recoveryAttempts % 6 === 0) { // Log every ~60 seconds (6 * 10s interval)
            logger.warn(`Network still disconnected. Recovery will be attempted when connection is restored.`, 'StreamManager');
          }
        } else if (isOnline && !wasOffline) {
          // Still online, periodically check if queues need refreshing
          const timeSinceLastRefresh = Date.now() - this.lastStreamFetch;
          if (timeSinceLastRefresh > this.QUEUE_UPDATE_INTERVAL) {
            logger.debug('Periodic queue refresh during stable network connection', 'StreamManager');
            this.updateAllQueues(false).catch(error => {
              logger.error('Failed to update queues during periodic check', 'StreamManager', 
                error instanceof Error ? error : new Error(String(error))
              );
            });
          }
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
    }, 5000); // Check every 5 seconds (reduced from 10 seconds)
  }

  async refreshStreams(): Promise<void> {
    logger.info('Refreshing streams for all screens', 'StreamManager');
    for (const screen of this.screenConfigs.keys()) {
        await this.updateQueue(screen);
    }
  }

  /**
   * Force refresh all streams and optionally restart them
   * @param restart Whether to restart all streams after refreshing
   */
  public async forceRefreshAll(restart: boolean = false): Promise<void> {
    logger.info(`Force refreshing all streams${restart ? ' and restarting them' : ''}`, 'StreamManager');
    
    try {
      // Force refresh all queues first
      await this.forceQueueRefresh();
      
      if (restart) {
        // Restart all streams
        await this.restartStreams();
        logger.info('All streams have been restarted successfully', 'StreamManager');
      }
    } catch (error) {
      logger.error(
        'Failed to force refresh all streams', 
        'StreamManager', 
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    }
  }

  // Add a method to periodically clean up finished streams
  private setupStreamCleanup(): void {
    // Periodically check for orphaned streams and clean them up
    const interval = setInterval(() => {
      if (this.isShuttingDown) {
        clearInterval(interval);
        return;
      }

      try {
        this.synchronizeStreams();
      } catch (error) {
        logger.error('Error in stream cleanup interval', 'StreamManager', error instanceof Error ? error : new Error(String(error)));
      }
    }, 60000); // Check every minute

    // Cleanup on shutdown
    this.cleanupHandler = () => {
      clearInterval(interval);
      this.cleanup().catch(error => {
        logger.error('Error during cleanup', 'StreamManager', error instanceof Error ? error : new Error(String(error)));
        process.exit(1);
      });
    };

    // Handle SIGINT
    process.on('SIGINT', () => {
      logger.info('Received SIGINT. Shutting down...', 'StreamManager');
      if (this.cleanupHandler) {
        this.cleanupHandler();
      }
    });
  }

  /**
   * Synchronize the stream manager's state with the player service
   * to ensure no orphaned streams or inconsistencies
   */
  private synchronizeStreams(): void {
    try {
      logger.debug(`Starting stream synchronization at ${new Date().toISOString()}`, 'StreamManager');
      
      // Get active streams from player service
      const playerStreams = this.playerService.getActiveStreams();
      const playerScreens = new Set(playerStreams.map(stream => stream.screen));
      
      // Get active streams from stream manager
      const managerScreens = new Set(this.streams.keys());
      
      // Log current state
      logger.debug(`Stream synchronization - Manager screens: [${Array.from(managerScreens).join(', ')}], Player screens: [${Array.from(playerScreens).join(', ')}]`, 'StreamManager');
      
      // More detailed logging about the actual stream instances
      if (playerStreams.length > 0) {
        const streamDetails = playerStreams.map(stream => 
          `{screen: ${stream.screen}, url: ${stream.url?.substring(0, 30)}..., status: ${stream.status}}`
        ).join(', ');
        logger.debug(`Player service has ${playerStreams.length} active streams: ${streamDetails}`, 'StreamManager');
      }
      
      if (this.streams.size > 0) {
        const managerStreamDetails = Array.from(this.streams.entries())
          .map(([screen, stream]) => `{screen: ${screen}, url: ${stream.url?.substring(0, 30)}...}`)
          .join(', ');
        logger.debug(`Stream manager has ${this.streams.size} tracked streams: ${managerStreamDetails}`, 'StreamManager');
      }
      
      // Check for streams that exist in player but not in manager
      for (const screen of playerScreens) {
        if (!managerScreens.has(screen)) {
          logger.warn(`Orphaned stream found on screen ${screen} - stopping it`, 'StreamManager');
          this.playerService.stopStream(screen, true).catch(error => {
            logger.error(`Failed to stop orphaned stream on screen ${screen}`, 'StreamManager', error instanceof Error ? error : new Error(String(error)));
          });
        }
      }
      
      // Check for streams that exist in manager but not in player
      for (const screen of managerScreens) {
        if (!playerScreens.has(screen)) {
          logger.warn(`Stream in manager but not in player for screen ${screen} - cleaning up`, 'StreamManager');
          this.streams.delete(screen);
          this.clearStreamRefresh(screen);
          this.clearInactiveTimer(screen);
        }
      }
      
      // Update the disabled screens in player service
      this.synchronizeDisabledScreens();
      
      logger.debug(`Completed stream synchronization at ${new Date().toISOString()}`, 'StreamManager');
    } catch (error) {
      logger.error('Error synchronizing streams', 'StreamManager', error instanceof Error ? error : new Error(String(error)));
    }
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

        // Filter out finished streams (keep live and upcoming)
        sourceStreams = sourceStreams.filter(stream => {
          // For YouTube/Holodex, sourceStatus could be 'live', 'upcoming', or 'ended'
          if (stream.sourceStatus === 'ended') {
            logger.debug(`Filtering out ended stream: ${stream.url}`, 'StreamManager');
            return false;
          }
          
          // For upcoming streams, check if they're in the past
          if (stream.sourceStatus === 'upcoming' && stream.startTime) {
            const now = Date.now();
            // If the start time is in the past by more than 30 minutes, filter it out
            if (stream.startTime < now - 30 * 60 * 1000) {
              logger.debug(`Filtering out past upcoming stream: ${stream.url}`, 'StreamManager');
              return false;
            }
          }
          
          return true;
        });

        // Add source metadata to streams
        sourceStreams.forEach(stream => {
          stream.subtype = source.subtype;
          stream.priority = source.priority;
          stream.screen = screen;
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

    logger.info(`Retrieved ${streams.length} total streams for screen ${screen}`, 'StreamManager');
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

export const streamManager = new StreamManager(
  config,
  holodexService,
  twitchService,
  youtubeService,
  playerService
); 