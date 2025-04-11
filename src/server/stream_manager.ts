import type { 
  StreamSource, 
  StreamOptions, 
  PlayerSettings,
  Config,
  StreamConfig,
  FavoriteChannels,
  Stream
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
import { YouTubeService } from './services/youtube.js';
import { PlayerService } from './services/player.js';
import type { TwitchAuth } from './db/database.js';
import { env } from '../config/env.js';
import { queueService } from './services/queue_service.js';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { KeyboardService, keyboardEvents } from './services/keyboard_service.js';
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
  private readonly STREAM_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes refresh interval

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
    this.favoriteChannels = {
      holodex: config.favoriteChannels.holodex || [],
      twitch: config.favoriteChannels.twitch || [],
      youtube: config.favoriteChannels.youtube || []
    };
    this.initializeQueues();
    
    // Synchronize disabled screens from config
    this.synchronizeDisabledScreens();

    logger.info('Stream manager initialized', 'StreamManager');

    // Handle stream end events
    this.playerService.onStreamError(async (data) => {
      // Don't handle retrying streams or during shutdown
      if (this.playerService.isRetrying(data.screen) || this.isShuttingDown) {
        return;
      }

      // Check if this was a normal end (code 0) or error
      if (data.code === 0) {
        // Check if the error message indicates a user-initiated exit
        const isUserExit = data.error === 'Stream ended by user' || data.error === 'Stream ended';
        
        if (isUserExit) {
          logger.info(`Stream on screen ${data.screen} was ended by user, starting next stream`, 'StreamManager');
        } else {
          logger.info(`Stream ended normally on screen ${data.screen}, starting next stream`, 'StreamManager');
        }
        
        // Always move to the next stream for normal exits or user-initiated exits
        await this.handleStreamEnd(data.screen);
      } else {
        logger.error(`Stream error on screen ${data.screen}: ${data.error}`, 'StreamManager');
        // For error cases, also try to start next stream after a delay
        setTimeout(() => {
          this.handleStreamEnd(data.screen).catch(error => {
            logger.error(
              `Failed to start next stream on screen ${data.screen}`,
              'StreamManager',
              error instanceof Error ? error : new Error(String(error))
            );
          });
        }, 1000); // Reduced from 5000ms to 1000ms
      }
    });

    // Start continuous queue updates
    this.startQueueUpdates();

    // Update cleanup handler
    this.cleanupHandler = () => {
      logger.info('Cleaning up stream processes...', 'StreamManager');
      this.isShuttingDown = true;
      this.stopQueueUpdates();
      this.keyboardService.cleanup();
      for (const [screen] of this.streams) {
        this.stopStream(screen).catch(error => {
          logger.error(
            `Failed to stop stream on screen ${screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        });
      }
    };

    // Register cleanup handlers
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

    // Handle keyboard events
    keyboardEvents.on('autostart', async (screen: number) => {
      try {
        await this.handleQueueEmpty(screen);
      } catch (error) {
        logger.error(
          `Failed to handle autostart for screen ${screen}`,
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    keyboardEvents.on('closeall', async () => {
      try {
        const activeStreams = this.getActiveStreams();
        await Promise.all(
          activeStreams.map(stream => this.stopStream(stream.screen, true))
        );
      } catch (error) {
        logger.error(
          'Failed to close all streams',
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  private async handleStreamEnd(screen: number): Promise<void> {
    try {
      // Check if we're already processing the queue for this screen
      if (this.queueProcessing.has(screen)) {
        logger.info(`Queue processing already in progress for screen ${screen}, not handling stream end`, 'StreamManager');
        return;
      }

      // Mark this screen as being processed
      this.queueProcessing.add(screen);

      // Get the current queue and log it for debugging
      const currentQueue = queueService.getQueue(screen);
      logger.info(`Current queue for screen ${screen} has ${currentQueue.length} items`, 'StreamManager');
      currentQueue.forEach((item, index) => {
        const isWatched = queueService.isStreamWatched(item.url);
        logger.info(`  Queue item ${index}: ${item.url} (watched: ${isWatched ? 'yes' : 'no'})`, 'StreamManager');
      });

      // Get next stream from queue
      const nextStream = queueService.getNextStream(screen);
      if (!nextStream) {
        logger.info(`No next stream in queue for screen ${screen}, fetching new streams`, 'StreamManager');
        this.queueProcessing.delete(screen);
        return this.handleEmptyQueue(screen);
      }

      logger.info(`Next stream in queue for screen ${screen}: ${nextStream.url}`, 'StreamManager');
      
      // Check if stream is already marked as watched
      const isWatched = queueService.isStreamWatched(nextStream.url);
      logger.info(`Stream ${nextStream.url} is${isWatched ? '' : ' not'} already marked as watched`, 'StreamManager');
      
      // If the stream is already watched and not a favorite, skip it
      const isFavorite = nextStream.priority !== undefined && nextStream.priority < 900;
      if (isWatched && !isFavorite) {
        logger.info(`Stream ${nextStream.url} is already watched and not a favorite, skipping`, 'StreamManager');
        // Remove from queue and try the next one
        queueService.removeFromQueue(screen, 0);
        this.queueProcessing.delete(screen);
        return this.handleStreamEnd(screen);
      }

      // Check if this stream is already playing on a higher priority screen
      const activeStreams = this.getActiveStreams();
      const isStreamActive = activeStreams.some(s => 
        s.url === nextStream.url && s.screen < screen
      );

      // Always play favorite streams, even if they're playing on another screen
      if (isStreamActive && !isFavorite) {
        logger.info(
          `Stream ${nextStream.url} is already playing on a higher priority screen, skipping`,
          'StreamManager'
        );
        // Remove this stream from the queue and try the next one
        queueService.removeFromQueue(screen, 0);
        this.queueProcessing.delete(screen);
        return this.handleStreamEnd(screen);
      }

      // Get screen configuration
      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
      if (!screenConfig) {
        logger.error(`Invalid screen number: ${screen}`, 'StreamManager');
        this.queueProcessing.delete(screen);
        return;
      }

      // Check if the screen was manually closed by the user
      if (this.manuallyClosedScreens.has(screen)) {
        logger.info(`Screen ${screen} was manually closed, not starting next stream`, 'StreamManager');
        this.queueProcessing.delete(screen);
        return;
      }

      // Mark as watched and remove from queue before starting the new stream
      // This prevents the same stream from being restarted if there's an error
      queueService.markStreamAsWatched(nextStream.url);
      queueService.removeFromQueue(screen, 0);
      
      // Start the stream with metadata from the queue
      logger.info(`Starting stream ${nextStream.url} on screen ${screen} with metadata: ${nextStream.title}, ${nextStream.viewerCount} viewers`, 'StreamManager');
      
      // Start the stream immediately without additional delays
      await this.startStream({
        url: nextStream.url,
        screen,
        quality: screenConfig.quality || this.config.player.defaultQuality,
        windowMaximized: screenConfig.windowMaximized,
        volume: screenConfig.volume,
        // Pass metadata from the queue
        title: nextStream.title,
        viewerCount: nextStream.viewerCount,
        startTime: nextStream.startTime
      });
      
      // Pre-fetch the next stream in the queue to prepare it
      const upcomingStream = queueService.getNextStream(screen);
      if (upcomingStream) {
        // Just log that we're preparing the next stream, but don't wait for it
        logger.info(`Preparing next stream in queue for screen ${screen}: ${upcomingStream.url}`, 'StreamManager');
      }
      
      // Clear processing flag once we've started the stream
      this.queueProcessing.delete(screen);
    } catch (error) {
      logger.error(
        `Failed to handle stream end for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      // Clear processing flag
      this.queueProcessing.delete(screen);
      // Try to handle empty queue as a fallback
      return this.handleEmptyQueue(screen);
    }
  }

  private async handleEmptyQueue(screen: number): Promise<void> {
    // Debounce queue processing - if already processing this screen's queue, return
    if (this.queueProcessing.has(screen)) {
      logger.info(`Queue processing already in progress for screen ${screen}, skipping`, 'StreamManager');
      return;
    }

    // Check if there's already an active stream on this screen
    const activeStream = this.getActiveStreams().find(s => s.screen === screen);
    if (activeStream) {
      logger.info(`Screen ${screen} already has an active stream (${activeStream.url}), not starting a new one`, 'StreamManager');
      return;
    }

    // Mark queue as being processed
    this.queueProcessing.add(screen);

    try {
      // Get screen configuration
      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
      if (!screenConfig) {
        logger.warn(`Invalid screen number: ${screen}`, 'StreamManager');
        this.queueProcessing.delete(screen);
        return;
      }

      const now = Date.now();
      const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
      const timeSinceLastRefresh = now - lastRefresh;
      
      // Check if we should refresh streams
      let allStreams = this.cachedStreams;
      if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL || allStreams.length === 0) {
        logger.info(`Time since last refresh: ${timeSinceLastRefresh}ms, fetching new streams for screen ${screen}`, 'StreamManager');
        this.lastStreamFetch = 0; // Reset cache to force fresh fetch
        allStreams = await this.getLiveStreams();
        this.lastStreamRefresh.set(screen, now);
      } else {
        logger.info(`Using cached streams for screen ${screen} (last refresh: ${timeSinceLastRefresh}ms ago)`, 'StreamManager');
      }

      // Check again if a stream was started while we were fetching
      const activeStreamAfterFetch = this.getActiveStreams().find(s => s.screen === screen);
      if (activeStreamAfterFetch) {
        logger.info(`Screen ${screen} now has an active stream (${activeStreamAfterFetch.url}), aborting queue processing`, 'StreamManager');
        this.queueProcessing.delete(screen);
        return;
      }
      
      // Filter streams for this screen
      const availableStreams = allStreams.filter(stream => {
        // Filter streams for this screen
        if (stream.screen !== screen) {
          logger.debug(`Stream ${stream.url} is assigned to screen ${stream.screen}, not ${screen}`, 'StreamManager');
          return false;
        }
        
        // Check if stream is already playing on another screen
        const activeStreams = this.getActiveStreams();
        const isPlaying = activeStreams.some(s => s.url === stream.url);
        
        // Allow high priority streams (favorites) to play on multiple screens
        if (isPlaying && (!stream.priority || stream.priority >= 900)) {
          logger.debug(`Stream ${stream.url} is already playing and is not high priority`, 'StreamManager');
          return false;
        }

        // Only include streams that are actually live
        if (stream.sourceStatus && stream.sourceStatus !== 'live') {
          logger.debug(`Stream ${stream.url} is not live (status: ${stream.sourceStatus})`, 'StreamManager');
          return false;
        }
        
        return true;
      });

      logger.info(`Found ${availableStreams.length} streams for screen ${screen}`, 'StreamManager');

      if (availableStreams.length > 0) {
        // Sort streams by priority (lower number = higher priority)
        const sortedStreams = availableStreams.sort((a, b) => {
          // First by priority (undefined priority goes last)
          const aPriority = a.priority ?? 999;
          const bPriority = b.priority ?? 999;
          if (aPriority !== bPriority) return aPriority - bPriority;
          
          // Then by viewer count for same priority
          return 0;
        });

        // Debug: Log watched status of streams
        sortedStreams.forEach(stream => {
          const isWatched = queueService.isStreamWatched(stream.url);
          logger.info(
            `Stream ${stream.url} (priority: ${stream.priority ?? 'none'}) is${isWatched ? '' : ' not'} marked as watched`,
            'StreamManager'
          );
        });

        // Filter out watched streams unless all streams have been watched
        const unwatchedStreams = queueService.filterUnwatchedStreams(sortedStreams);
        logger.info(`After filtering: ${unwatchedStreams.length} unwatched streams available`, 'StreamManager');
        
        const combinedStreams = unwatchedStreams.length > 0 ? unwatchedStreams : sortedStreams;

        if (combinedStreams.length > 0) {
          const [firstStream, ...remainingStreams] = combinedStreams;
          
          logger.info(
            `Starting stream ${firstStream.url} on screen ${screen} (Priority: ${firstStream.priority ?? 'none'}) with metadata: ${firstStream.title}, ${firstStream.viewerCount} viewers`,
            'StreamManager'
          );
          
          // Start first stream with all available metadata
          await this.startStream({
            url: firstStream.url,
            screen: screen,
            quality: screenConfig.quality || this.config.player.defaultQuality,
            windowMaximized: screenConfig.windowMaximized,
            volume: screenConfig.volume,
            title: firstStream.title,
            viewerCount: firstStream.viewerCount,
            startTime: firstStream.startTime
          });
          
          // Mark the stream as watched
          queueService.markStreamAsWatched(firstStream.url);

          // Queue remaining streams, maintaining priority order
          if (remainingStreams.length > 0) {
            queueService.setQueue(screen, remainingStreams);
            logger.info(
              `Queued ${remainingStreams.length} streams for screen ${screen}. ` +
              `First in queue: ${remainingStreams[0].url} (Priority: ${remainingStreams[0].priority ?? 'none'})`,
              'StreamManager'
            );
          }
        } else {
          logger.info(`No unwatched streams available for screen ${screen}, clearing watched history`, 'StreamManager');
          queueService.clearWatchedStreams(); // Reset watched history to start over with high priority streams
          return this.handleEmptyQueue(screen); // Retry with cleared history
        }
      } else {
        // Check if a forced fetch was performed 
        const wasRefreshForced = timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL || allStreams.length === 0;
        
        // If we just did a fresh fetch and found nothing, schedule a retry
        if (wasRefreshForced) {
          logger.info(`No available streams for screen ${screen} after forced refresh, will retry in ${this.RETRY_INTERVAL}ms`, 'StreamManager');
          queueService.clearQueue(screen);
          // Schedule a retry after the interval
          setTimeout(() => {
            if (!this.isShuttingDown) {
              this.queueProcessing.delete(screen); // Remove processing flag before retrying
              this.handleEmptyQueue(screen).catch((error: Error | unknown) => {
                logger.error(
                  `Failed to retry empty queue for screen ${screen}`,
                  'StreamManager',
                  error instanceof Error ? error : new Error(String(error))
                );
              });
            }
          }, this.RETRY_INTERVAL);
        } else {
          logger.info(`No available streams for screen ${screen} in cache, will wait for next refresh interval`, 'StreamManager');
          queueService.clearQueue(screen);
          this.queueProcessing.delete(screen);
        }
      }
    } catch (error) {
      logger.error(
        `Failed to handle empty queue for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    } finally {
      // Remove processing flag unless we scheduled a retry
      if (!this.isShuttingDown && this.queueProcessing.has(screen)) {
        this.queueProcessing.delete(screen);
      }
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
    // Find first available screen
    let screen = options.screen;
    if (!screen) {
      const activeScreens = new Set(this.streams.keys());
      for (const streamConfig of this.config.player.screens) {
        if (!activeScreens.has(streamConfig.screen)) {
          screen = streamConfig.screen;
          break;
        }
      }
    }

    if (!screen) {
      return {
        screen: options.screen || 1,
        message: 'No available screens',
        success: false
      };
    }

    const streamConfig = this.config.player.screens.find(s => s.screen === screen);
    if (!streamConfig) {
      return {
        screen,
        message: `Invalid screen number: ${screen}`,
        success: false
      };
    }

    // Try to find stream metadata from our sources
    let streamMetadata: Partial<StreamSource> = {};
    
    try {
      // Use cached streams if available, otherwise get all live streams
      const allStreams = this.cachedStreams.length > 0 && Date.now() - this.lastStreamFetch < this.STREAM_CACHE_TTL
        ? this.cachedStreams
        : await this.getLiveStreams();
        
      const matchingStream = allStreams.find(s => s.url === options.url);
      
      if (matchingStream) {
        logger.info(`Found metadata for stream ${options.url}: ${matchingStream.title}, ${matchingStream.viewerCount} viewers`, 'StreamManager');
        streamMetadata = matchingStream;
      } else {
        logger.info(`No metadata found for stream ${options.url}, using defaults`, 'StreamManager');
      }
    } catch (error) {
      logger.warn(`Error fetching stream metadata: ${error instanceof Error ? error.message : String(error)}`, 'StreamManager');
    }

    // Prepare enhanced options with metadata
    const enhancedOptions = {
      ...options,
      screen,
      quality: options.quality || streamConfig.quality,
      volume: options.volume || streamConfig.volume,
      windowMaximized: options.windowMaximized ?? streamConfig.windowMaximized,
      // Use metadata if available, otherwise use provided options or defaults
      title: options.title || streamMetadata.title,
      viewerCount: options.viewerCount || streamMetadata.viewerCount,
      startTime: options.startTime || streamMetadata.startTime || new Date().toLocaleTimeString()
    };

    logger.info(`Starting stream with enhanced metadata: ${enhancedOptions.title}, ${enhancedOptions.viewerCount} viewers, ${enhancedOptions.startTime}`, 'StreamManager');
    
    return this.playerService.startStream(enhancedOptions);
  }

  /**
   * Stops a stream on the specified screen
   */
  async stopStream(screen: number, isManualStop: boolean = false): Promise<boolean> {
    try {
      const stream = this.streams.get(screen);
      if (!stream) {
        // If no active stream, emit a basic stopped state
        this.emit('streamUpdate', {
          screen,
          url: '',
          quality: '',
          platform: 'twitch',  // Default platform
          playerStatus: 'stopped',
          volume: 0,
          process: null
        } as Stream);
        return false;
      }

      // If manual stop, mark the screen as manually closed
      if (isManualStop) {
        this.manuallyClosedScreens.add(screen);
        logger.info(`Screen ${screen} marked as manually closed`, 'StreamManager');
      }

      // Clear any pending retries
      this.streamRetries.delete(screen);
      this.clearInactiveTimer(screen);
      this.clearStreamRefresh(screen);

      // Stop the stream in the player service
      const result = await this.playerService.stopStream(screen, isManualStop);
      
      // Emit stopped state with stream info
      this.emit('streamUpdate', {
        ...stream,
        playerStatus: 'stopped',
        error: undefined,
        process: null
      } as Stream);

      // Cleanup IPC/FIFO after process death
      setTimeout(() => {
        const fifoPath = this.fifoPaths.get(screen);
        if (fifoPath) {
          try { 
            fs.unlinkSync(fifoPath); 
          } catch {
            // Ignore error, file may not exist
            logger.debug(`Failed to remove FIFO file ${fifoPath}`, 'StreamManager');
          }
          this.fifoPaths.delete(screen);
        }
        this.ipcPaths.delete(screen);
      }, 200); // Reduced from 2000ms to 500ms

      this.streams.delete(screen);
      logger.info(`Stream stopped on screen ${screen}${isManualStop ? ' (manual stop)' : ''}`, 'StreamManager');
      return result;
    } catch (error) {
      logger.error(
        'Failed to stop stream', 
        'StreamManager', 
        error instanceof Error ? error : new Error(String(error))
      );
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

    logger.info(`Fetching fresh stream data (cache expired or forced refresh)`, 'StreamManager');
    try {
      const results: Array<StreamSource & { screen?: number; sourceName?: string; priority?: number }> = [];
      const streamConfigs = this.config.streams;
      
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

          try {
            if (source.type === 'holodex') {
              if (source.subtype === 'favorites') {
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
                });
              } else if (source.subtype === 'organization' && source.name) {
                streams = await this.holodexService.getLiveStreams({
                  organization: source.name,
                  limit: limit,
                  sort: 'start_scheduled'  // Sort by scheduled start time
                });
              }
            } else if (source.type === 'twitch') {
              if (source.subtype === 'favorites') {
                streams = await this.twitchService.getStreams({
                  channels: this.favoriteChannels.twitch,
                  limit: limit
                });
                
                // For favorites, assign a higher priority based on source priority
                const basePriority = source.priority || 999;
                streams.forEach(s => {
                  s.priority = basePriority - 100; // Make favorites 100 points higher priority
                });
              } else if (source.tags?.includes('vtuber')) {
                streams = await this.twitchService.getVTuberStreams(limit);
                // Sort VTuber streams by viewer count
                streams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
              }
            } else if (source.type === 'youtube') {
              if (source.subtype === 'favorites') {
                streams = await this.youtubeService.getLiveStreams({
                  channels: this.favoriteChannels.youtube,
                  limit
                });
                
                // For favorites, assign a higher priority based on source priority
                const basePriority = source.priority || 999;
                streams.forEach(s => {
                  s.priority = basePriority - 100; // Make favorites 100 points higher priority
                });
              }
            }
            
            // Add source metadata to each stream
            const streamsWithMetadata = streams.map(stream => ({
              ...stream,
              screen: screenNumber,
              sourceName: `${source.type}:${source.subtype || 'other'}`,
              // Only set priority if not already set (favorites already have priority)
              priority: stream.priority !== undefined ? stream.priority : source.priority || 999
            }));

            results.push(...streamsWithMetadata);
          } catch (error) {
            logger.error(
              `Failed to fetch streams for ${source.type}:${source.subtype || 'other'}`,
              'StreamManager',
              error instanceof Error ? error : new Error(String(error))
            );
            continue;
          }
        }
      }
      // Final sorting of all streams
      const sortedResults = results
      .filter(stream => stream.sourceStatus === "live")
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));

      // Update cache
      this.cachedStreams = sortedResults;
      this.lastStreamFetch = now;

      return sortedResults;
    } catch (error) {
      logger.error(
        'Failed to fetch live streams',
        'StreamManager', 
        error instanceof Error ? error : new Error(String(error))
      );
      
      if (retryCount < 3) {
        logger.info(`Retrying getLiveStreams (attempt ${retryCount + 1})`, 'StreamManager');
        await new Promise(resolve => setTimeout(resolve, this.RETRY_INTERVAL));
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
    if (this.isShuttingDown) return;
    
    logger.info('Auto-starting streams...', 'StreamManager');
    
    try {
      // Get all enabled screens with autoStart enabled from streams config
      const autoStartScreens = this.config.streams
        .filter(stream => stream.enabled && stream.autoStart)
        .map(stream => stream.screen);
      
      if (autoStartScreens.length === 0) {
        logger.info('No screens configured for auto-start', 'StreamManager');
        
        // Even if no auto-start screens, ensure players are running if force_player is enabled
        await this.playerService.ensurePlayersRunning();
        return;
      }
      
      logger.info(`Auto-starting streams for screens: ${autoStartScreens.join(', ')}`, 'StreamManager');
      
      // Reset the last refresh times for all screens to ensure a fresh start
      autoStartScreens.forEach(screen => {
        // Set last refresh to 0 to force initial refresh
        this.lastStreamRefresh.set(screen, 0);
      });
      
      // Auto-start streams for each screen
      for (const screen of autoStartScreens) {
        await this.handleQueueEmpty(screen);
      }
      
      logger.info('Auto-start complete', 'StreamManager');
      
      // Ensure players are running for all enabled screens if force_player is enabled
      await this.playerService.ensurePlayersRunning();
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
    const streamConfig = this.config.player.screens.find(s => s.screen === screen);
    if (!streamConfig) {
      throw new Error(`Invalid screen number: ${screen}`);
    }
    
    streamConfig.enabled = true;
    
    // Notify the PlayerService that the screen is enabled
    this.playerService.enableScreen(screen);
    
    logger.info(`Screen ${screen} enabled`, 'StreamManager');
    
    // Start streams if auto-start is enabled
    if (this.config.player.autoStart) {
      await this.handleEmptyQueue(screen);
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
    
    // If force_player was enabled, ensure players are running
    if (settings.force_player === true) {
      logger.info('Force player enabled, ensuring all enabled screens have players running', 'StreamManager');
      await this.playerService.ensurePlayersRunning();
    }
    
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

  public getScreenConfig(screen: number): StreamConfig | undefined {
    return this.config.player.screens.find(s => s.screen === screen);
  }

  public updateScreenConfig(screen: number, config: Partial<StreamConfig>): void {
    const screenConfig = this.getScreenConfig(screen);
    if (!screenConfig) {
      throw new Error(`Screen ${screen} not found`);
    }
    
    // Update the config
    Object.assign(screenConfig, config);
    
    // If enabling a screen and force_player is set, ensure player is running
    if (config.enabled === true && this.config.player.force_player) {
      const isPlayerRunning = this.playerService.getActiveStreams().some(s => s.screen === screen);
      if (!isPlayerRunning && !this.manuallyClosedScreens.has(screen)) {
        logger.info(`Screen ${screen} enabled with force_player active, starting player`, 'StreamManager');
        // Start player with blank page
        this.playerService.startStream({
          url: 'about:blank',
          screen,
          quality: screenConfig.quality || this.config.player.defaultQuality,
          volume: screenConfig.volume !== undefined ? screenConfig.volume : this.config.player.defaultVolume,
          windowMaximized: screenConfig.windowMaximized !== undefined ? screenConfig.windowMaximized : this.config.player.windowMaximized
        }).catch(error => {
          logger.error(`Failed to start player for screen ${screen}: ${error instanceof Error ? error.message : String(error)}`, 'StreamManager');
        });
      }
    }
    
    this.emit('screenUpdate', screen, screenConfig);
    this.saveConfig();
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

    const updateQueues = async () => {
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
            logger.info(`Skipping queue update for screen ${screen} - queue is being processed`, 'StreamManager');
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
              
              // Only attempt to start new streams if it's been long enough since last refresh
              if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL) {
                logger.info(`No active stream on screen ${screen} and refresh interval elapsed, fetching new streams`, 'StreamManager');
                // Mark as processing to prevent concurrent queue processing
                this.queueProcessing.add(screen);
                try {
                  await this.handleEmptyQueue(screen);
                } finally {
                  this.queueProcessing.delete(screen);
                }
              } else {
                logger.info(`No active stream on screen ${screen}, but refresh interval not elapsed. Skipping refresh.`, 'StreamManager');
              }
            } else {
              logger.info(`Screen ${screen} was manually closed, not starting new streams`, 'StreamManager');
            }
          } else {
            // If there's an active stream, just update the queue without starting new stream
            logger.info(`Active stream on screen ${screen}, updating queue only`, 'StreamManager');
            
            // Only fetch new streams if the refresh interval has elapsed
            const now = Date.now();
            const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
            const timeSinceLastRefresh = now - lastRefresh;
            
            let streams = this.cachedStreams;
            if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL || streams.length === 0) {
              logger.info(`Refresh interval elapsed for screen ${screen}, fetching new streams for queue update`, 'StreamManager');
              streams = await this.getLiveStreams();
              this.lastStreamRefresh.set(screen, now);
            } else {
              logger.info(`Using cached streams for queue update on screen ${screen} (last refresh: ${timeSinceLastRefresh}ms ago)`, 'StreamManager');
            }
            
            const availableStreams = streams.filter(s => s.screen === screen);
            
            if (availableStreams.length > 0) {
              // Get existing queue
              const existingQueue = queueService.getQueue(screen);
              
              // Combine existing queue URLs with available streams
              const existingUrls = new Set(existingQueue.map(s => s.url));
              
              // Add new streams that aren't in the existing queue
              const newStreams = availableStreams.filter(s => !existingUrls.has(s.url));
              
              if (newStreams.length > 0) {
                // Filter unwatched from new streams only
                const unwatchedNewStreams = queueService.filterUnwatchedStreams(newStreams);
                
                if (unwatchedNewStreams.length > 0) {
                  // Add unwatched new streams to end of existing queue
                  const updatedQueue = [...existingQueue, ...unwatchedNewStreams];
                  queueService.setQueue(screen, updatedQueue);
                  logger.info(
                    `Updated queue for screen ${screen} with ${unwatchedNewStreams.length} new streams. Total queue size: ${updatedQueue.length}`,
                    'StreamManager'
                  );
                } else {
                  logger.info(`No new unwatched streams for screen ${screen}`, 'StreamManager');
                }
              } else {
                logger.info(`No new streams available for screen ${screen}`, 'StreamManager');
              }
            }
          }
        } catch (error) {
          logger.error(
            `Failed to update queue for screen ${screen}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
    };

    // Initial update
    await updateQueues();

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
  async updateQueue(screen: number, forceRefresh = false): Promise<void> {
    if (this.isShuttingDown) {
      return;
    }

    // Skip screens that are already being processed
    if (this.queueProcessing.has(screen)) {
      logger.info(`Skipping queue update for screen ${screen} - queue is being processed`, 'StreamManager');
      return;
    }

    try {
      // Check if there's an active stream on this screen
      const activeStream = this.getActiveStreams().find(s => s.screen === screen);
      
      if (forceRefresh) {
        // Force refresh - set last refresh to 0 to ensure new data is fetched
        this.lastStreamRefresh.set(screen, 0);
        logger.info(`Forcing refresh for screen ${screen}`, 'StreamManager');
        
        // If no active stream and not manually closed, try to start a new one
        if (!activeStream && !this.manuallyClosedScreens.has(screen)) {
          // Mark as processing to prevent concurrent queue processing
          this.queueProcessing.add(screen);
          try {
            await this.handleEmptyQueue(screen);
          } finally {
            this.queueProcessing.delete(screen);
          }
        } else if (activeStream) {
          // If active stream, just update the queue
          logger.info(`Active stream on screen ${screen}, updating queue only`, 'StreamManager');
          
          // Fetch fresh streams
          const streams = await this.getLiveStreams();
          this.lastStreamRefresh.set(screen, Date.now());
          
          const availableStreams = streams.filter(s => s.screen === screen);
          
          if (availableStreams.length > 0) {
            // Get existing queue
            const existingQueue = queueService.getQueue(screen);
            
            // Combine existing queue URLs with available streams
            const existingUrls = new Set(existingQueue.map(s => s.url));
            
            // Add new streams that aren't in the existing queue
            const newStreams = availableStreams.filter(s => !existingUrls.has(s.url));
            
            if (newStreams.length > 0) {
              // Filter unwatched from new streams only
              const unwatchedNewStreams = queueService.filterUnwatchedStreams(newStreams);
              
              if (unwatchedNewStreams.length > 0) {
                // Add unwatched new streams to end of existing queue
                const updatedQueue = [...existingQueue, ...unwatchedNewStreams];
                queueService.setQueue(screen, updatedQueue);
                logger.info(
                  `Updated queue for screen ${screen} with ${unwatchedNewStreams.length} new streams. Total queue size: ${updatedQueue.length}`,
                  'StreamManager'
                );
              } else {
                logger.info(`No new unwatched streams for screen ${screen}`, 'StreamManager');
              }
            } else {
              logger.info(`No new streams available for screen ${screen}`, 'StreamManager');
            }
          }
        }
      } else {
        // Non-forced update - follow normal refresh interval
        const now = Date.now();
        const lastRefresh = this.lastStreamRefresh.get(screen) || 0;
        const timeSinceLastRefresh = now - lastRefresh;
        
        if (timeSinceLastRefresh >= this.STREAM_REFRESH_INTERVAL) {
          logger.info(`Refresh interval elapsed for screen ${screen}, updating queue`, 'StreamManager');
          await this.updateQueue(screen, true);
        } else {
          logger.info(`Refresh interval not elapsed for screen ${screen}, skipping queue update`, 'StreamManager');
        }
      }
    } catch (error) {
      logger.error(
        `Failed to update queue for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
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
      await this.updateQueue(screen, forceRefresh);
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
}

// Create singleton instance
const config = loadAllConfigs();
const playerService = new PlayerService(config);
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

export const streamManager = new StreamManager(
  config,
  holodexService,
  twitchService,
  youtubeService,
  playerService
); 