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
  private readonly QUEUE_UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes in milliseconds
  private readonly STREAM_START_TIMEOUT = 30 * 1000; // 30 seconds timeout for stream start
  private readonly QUEUE_PROCESSING_TIMEOUT = 60 * 1000; // 1 minute timeout for queue processing
  private readonly STREAM_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes refresh interval
  private favoriteChannels: FavoriteChannels = {
    holodex: [],
    twitch: [],
    youtube: []
  };
  private queues: Map<number, StreamSource[]> = new Map();
  private readonly RETRY_INTERVAL = 5000; // 5 seconds
  private errorCallback?: (data: StreamError) => void;
  private manuallyClosedScreens: Set<number> = new Set();
  private streamRetries: Map<number, number> = new Map();
  private streamRefreshTimers: Map<number, NodeJS.Timeout> = new Map();
  private inactiveTimers: Map<number, NodeJS.Timeout> = new Map();
  private fifoPaths: Map<number, string> = new Map();
  private ipcPaths: Map<number, string> = new Map();
  private cachedStreams: StreamSource[] = []; // Cache for stream metadata
  private lastStreamFetch: number = 0; // Timestamp of last stream fetch
  private readonly STREAM_CACHE_TTL = 60000; // 1 minute cache TTL
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
    this.favoriteChannels = {
      holodex: config.favoriteChannels.holodex || [],
      twitch: config.favoriteChannels.twitch || [],
      youtube: config.favoriteChannels.youtube || []
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
    try {
      // Clear any existing processing state first
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      const existingTimeout = this.queueProcessingTimeouts.get(screen);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
        this.queueProcessingTimeouts.delete(screen);
      }

      // Add a timeout to clear the queueProcessing flag after 15 seconds (reduced from 30)
      const clearQueueProcessingTimeout = setTimeout(() => {
        if (this.queueProcessing.has(screen)) {
          logger.warn(`Queue processing flag stuck for screen ${screen}, clearing it`, 'StreamManager');
          this.queueProcessing.delete(screen);
          this.queueProcessingStartTimes.delete(screen);
          const timeout = this.queueProcessingTimeouts.get(screen);
          if (timeout) {
            clearTimeout(timeout);
            this.queueProcessingTimeouts.delete(screen);
          }
        }
      }, 15000);

      // For screen 1, skip the processing check delay
      if (screen !== 1 && this.queueProcessing.has(screen)) {
        logger.info(`Queue processing already in progress for screen ${screen}, waiting...`, 'StreamManager');
        // Wait a bit and try again
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (this.queueProcessing.has(screen)) {
          logger.warn(`Queue still processing for screen ${screen} after delay, forcing reset`, 'StreamManager');
          this.queueProcessing.delete(screen);
          this.queueProcessingStartTimes.delete(screen);
          const timeout = this.queueProcessingTimeouts.get(screen);
          if (timeout) {
            clearTimeout(timeout);
            this.queueProcessingTimeouts.delete(screen);
          }
        }
      }

      // Mark this screen as being processed
      this.queueProcessing.add(screen);
      this.queueProcessingStartTimes.set(screen, Date.now());
      this.queueProcessingTimeouts.set(screen, clearQueueProcessingTimeout);

      // Get current stream info
      const currentStream = this.getActiveStreams().find((s: StreamSource) => 
        s.screen !== undefined && s.screen === screen
      );
      
      // If this is a dummy black screen, immediately try to get the next stream
      if (currentStream?.url === 'av://lavfi:color=c=black') {
        logger.info(`Detected dummy black screen on screen ${screen}, attempting to start next stream`, 'StreamManager');
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return this.handleEmptyQueue(screen);
      }

      // Get the current queue and log it for debugging
      const currentQueue = queueService.getQueue(screen);
      logger.info(`Current queue for screen ${screen} has ${currentQueue.length} items`, 'StreamManager');

      // Remove the current stream from the queue if it exists
      if (currentStream) {
        const currentIndex = currentQueue.findIndex((item: StreamSource) => item.url === currentStream.url);
        if (currentIndex !== -1) {
          logger.info(`Removing current stream ${currentStream.url} from queue`, 'StreamManager');
          queueService.removeFromQueue(screen, currentIndex);
        }
      }

      // Get next stream from queue
      const nextStream = queueService.getNextStream(screen);
      if (!nextStream) {
        logger.info(`No next stream in queue for screen ${screen}, fetching new streams`, 'StreamManager');
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return this.handleEmptyQueue(screen);
      }

      // For screen 1, skip the watched check and start immediately
      if (screen === 1) {
        logger.info(`Starting next stream ${nextStream.url} on screen 1 immediately`, 'StreamManager');
        await this.startStream({
          url: nextStream.url,
          screen,
          quality: this.getScreenConfig(screen)?.quality || 'best',
          windowMaximized: this.getScreenConfig(screen)?.windowMaximized || false,
          volume: this.getScreenConfig(screen)?.volume || 100,
          title: nextStream.title,
          viewerCount: nextStream.viewerCount,
          startTime: nextStream.startTime
        });
        return;
      }

      // For other screens, proceed with normal checks
      const isWatched = queueService.isStreamWatched(nextStream.url);
      logger.info(`Stream ${nextStream.url} is${isWatched ? '' : ' not'} already marked as watched`, 'StreamManager');
      
      // If the stream is already watched and not a favorite, skip it
      const isFavorite = nextStream.priority !== undefined && nextStream.priority < 900;

      if (isWatched && !isFavorite) {
        logger.info(`Stream ${nextStream.url} is already watched and not a favorite, skipping`, 'StreamManager');
        // Remove from queue and try the next one
        queueService.removeFromQueue(screen, 0);
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return this.handleStreamEnd(screen);
      }

      // Check if this stream is already playing on a higher priority screen
      const activeStreams = this.getActiveStreams();
      const isStreamActive = activeStreams.some((s: StreamSource) => 
        s.url === nextStream.url && s.screen !== undefined && s.screen < screen
      );

      // Always play favorite streams, even if they're playing on another screen
      if (isStreamActive && !isFavorite) {
        logger.info(
          `Stream ${nextStream.url} is already playing on a higher priority screen, skipping`,
          'StreamManager'
        );
        // Remove this stream from the queue and try the next one
        queueService.removeFromQueue(screen, 0);
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return this.handleStreamEnd(screen);
      }

      // Get screen configuration
      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
      if (!screenConfig) {
        logger.error(`Invalid screen number: ${screen}`, 'StreamManager');
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return;
      }

      // Check if the screen was manually closed by the user
      if (this.manuallyClosedScreens.has(screen)) {
        logger.info(`Screen ${screen} was manually closed, not starting next stream`, 'StreamManager');
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return;
      }

      // Check if the stream is actually live
      if (!nextStream.sourceStatus || nextStream.sourceStatus !== 'live') {
        logger.info(`Stream ${nextStream.url} is not live (status: ${nextStream.sourceStatus}), skipping`, 'StreamManager');
        // Remove from queue and try the next one
        queueService.removeFromQueue(screen, 0);
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return this.handleStreamEnd(screen);
      }

      // Mark as watched and remove from queue before starting the new stream
      queueService.markStreamAsWatched(nextStream.url);
      queueService.removeFromQueue(screen, 0);
      
      // Start the stream with metadata from the queue
      logger.info(`Starting stream ${nextStream.url} on screen ${screen} with metadata: ${nextStream.title}, ${nextStream.viewerCount} viewers`, 'StreamManager');
      
      try {
        // Start the stream with a retry mechanism
        let startAttempts = 0;
        const maxAttempts = 3;
        let streamStarted = false;

        while (!streamStarted && startAttempts < maxAttempts) {
          try {
            const result = await this.startStream({
              url: nextStream.url,
              screen,
              quality: screenConfig.quality || this.config.player.defaultQuality,
              windowMaximized: screenConfig.windowMaximized,
              volume: screenConfig.volume,
              title: nextStream.title,
              viewerCount: nextStream.viewerCount,
              startTime: nextStream.startTime
            });

            if (result.success) {
              streamStarted = true;
              logger.info(`Successfully started stream on attempt ${startAttempts + 1}`, 'StreamManager');
            } else {
              throw new Error(result.message || 'Failed to start stream');
            }
          } catch (error) {
            startAttempts++;
            if (startAttempts < maxAttempts) {
              logger.warn(`Failed to start stream, attempt ${startAttempts}/${maxAttempts}, retrying...`, 'StreamManager');
              await new Promise(resolve => setTimeout(resolve, 1000 * startAttempts));
            } else {
              throw error;
            }
          }
        }
      } catch (error) {
        logger.error(
          `Failed to start stream after multiple attempts: ${error instanceof Error ? error.message : String(error)}`,
          'StreamManager'
        );
        // Move to next stream in queue
        clearTimeout(clearQueueProcessingTimeout);
        this.queueProcessing.delete(screen);
        this.queueProcessingStartTimes.delete(screen);
        this.queueProcessingTimeouts.delete(screen);
        return this.handleStreamEnd(screen);
      }
      
      // Pre-fetch the next stream in the queue to prepare it
      const upcomingStream = queueService.getNextStream(screen);
      if (upcomingStream) {
        logger.info(`Preparing next stream in queue for screen ${screen}: ${upcomingStream.url}`, 'StreamManager');
      }
      
      // Clear processing flag and timeout
      clearTimeout(clearQueueProcessingTimeout);
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      this.queueProcessingTimeouts.delete(screen);
    } catch (error) {
      logger.error(
        `Failed to handle stream end for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      // Clear processing flag and timeout
      const timeout = this.queueProcessingTimeouts.get(screen);
      if (timeout) {
        clearTimeout(timeout);
        this.queueProcessingTimeouts.delete(screen);
      }
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      // Try to handle empty queue as a fallback
      return this.handleEmptyQueue(screen);
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

      // Update queue
      await this.updateQueue(screen);
      
      // Clear processing flag and timeout
      this.queueProcessing.delete(screen);
      this.queueProcessingStartTimes.delete(screen);
      this.clearQueueProcessingTimeout(screen);

      // Get updated queue
      const queue = this.queues.get(screen) || [];
      if (queue.length > 0) {
        await this.handleStreamEnd(screen);
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
                  if (!this.favoriteChannels?.holodex || !Array.isArray(this.favoriteChannels.holodex) || this.favoriteChannels.holodex.length === 0) {
                    logger.warn('No Holodex favorite channels configured, skipping source', 'StreamManager');
                    break;
                  }
                  
                streams = await this.holodexService.getLiveStreams({
                  channels: this.favoriteChannels.holodex,
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
                  if (!this.favoriteChannels?.twitch || !Array.isArray(this.favoriteChannels.twitch) || this.favoriteChannels.twitch.length === 0) {
                    logger.warn('No Twitch favorite channels configured, skipping source', 'StreamManager');
                    break;
                  }
                  
                streams = await this.twitchService.getStreams({
                  channels: this.favoriteChannels.twitch,
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
                  if (!this.favoriteChannels?.youtube || !Array.isArray(this.favoriteChannels.youtube) || this.favoriteChannels.youtube.length === 0) {
                    logger.warn('No YouTube favorite channels configured, skipping source', 'StreamManager');
                    break;
                  }
                  
                streams = await this.youtubeService.getLiveStreams({
                  channels: this.favoriteChannels.youtube,
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
                  if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.holodex.includes(stream.channelId)) return true;
                  if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
                  break;
                case 'twitch':
                  if (stream.platform !== 'twitch') return false;
                  if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.twitch.includes(stream.channelId)) return true;
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
                if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.holodex.includes(stream.channelId)) return true;
                if (source.subtype === 'organization' && source.name && stream.organization === source.name) return true;
                break;
              case 'twitch':
                if (stream.platform !== 'twitch') return false;
                if (source.subtype === 'favorites' && stream.channelId && this.favoriteChannels.twitch.includes(stream.channelId)) return true;
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
    
    // Update services with new favorites
    this.holodexService.updateFavorites(favorites.holodex);
    this.twitchService.updateFavorites(favorites.twitch);
    this.youtubeService.updateFavorites(favorites.youtube);
    
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

  public async addFavorite(platform: 'holodex' | 'twitch' | 'youtube', channelId: string): Promise<void> {
    if (!this.favoriteChannels[platform]) {
      this.favoriteChannels[platform] = [];
    }
    
    if (!this.favoriteChannels[platform].includes(channelId)) {
      this.favoriteChannels[platform].push(channelId);
      await this.updateFavorites(this.favoriteChannels);
    }
  }

  public async removeFavorite(platform: 'holodex' | 'twitch' | 'youtube', channelId: string): Promise<void> {
    if (this.favoriteChannels[platform]) {
      const index = this.favoriteChannels[platform].indexOf(channelId);
      if (index !== -1) {
        this.favoriteChannels[platform].splice(index, 1);
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
    const RECOVERY_DELAY = 5000; // 5 seconds between recovery attempts
    
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
          logger.warn('Network connection lost - unable to reach any test endpoints', 'StreamManager');
        } else if (isOnline && wasOffline) {
          // Just came back online
          wasOffline = false;
          recoveryAttempts = 0;
          logger.info('Network connection restored, refreshing streams', 'StreamManager');
          
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
              
              // Force refresh all queues and streams
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
          if (recoveryAttempts % 6 === 0) { // Log every ~60 seconds (6 * 10s interval)
            logger.warn(`Network still disconnected. Recovery will be attempted when connection is restored.`, 'StreamManager');
          }
        }
      } catch (error) {
        if (!wasOffline) {
          wasOffline = true;
          recoveryAttempts = 0;
          logger.warn(
            'Network connection lost', 
            'StreamManager',
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }, 10000); // Check every 10 seconds
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
              channels: this.config.favoriteChannels.holodex,
              limit: source.limit
            });
          }
        } else if (source.type === 'twitch') {
          if (source.subtype === 'favorites') {
            sourceStreams = await this.twitchService.getStreams({
              channels: this.config.favoriteChannels.twitch,
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

  private sortStreams(streams: StreamSource[], sorting?: { field: string; order: 'asc' | 'desc' }): StreamSource[] {
    if (!sorting) return streams;

    return [...streams].sort((a, b) => {
      let comparison = 0;

      // First sort by priority if available
      if (a.priority !== undefined && b.priority !== undefined) {
        comparison = a.priority - b.priority;
        if (comparison !== 0) return comparison;
      }

      // Then sort by the specified field
      switch (sorting.field) {
        case 'viewerCount': {
          comparison = (b.viewerCount || 0) - (a.viewerCount || 0);
          break;
        }
        case 'startTime': {
          const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
          const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
          comparison = aTime - bTime;
          break;
        }
        default:
          return 0;
      }

      return sorting.order === 'desc' ? comparison : -comparison;
    });
  }
}

// Create singleton instance
const config = loadAllConfigs();
const holodexService = new HolodexService(
  env.HOLODEX_API_KEY,
  config.filters?.filters ? config.filters.filters.map(f => typeof f === 'string' ? f : f.value) : [],
  config.favoriteChannels.holodex,
  config
);
const twitchService = new TwitchService(
  env.TWITCH_CLIENT_ID,
  env.TWITCH_CLIENT_SECRET,
  config.filters?.filters ? config.filters.filters.map(f => typeof f === 'string' ? f : f.value) : []
);
const youtubeService = new YouTubeService(
  config.favoriteChannels.youtube
);
const playerService = new PlayerService(config);

export const streamManager = new StreamManager(
  config,
  holodexService,
  twitchService,
  youtubeService,
  playerService
); 