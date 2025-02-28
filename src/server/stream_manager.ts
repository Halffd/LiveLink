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

    logger.info('Stream manager initialized', 'StreamManager');

    this.playerService.onStreamError(async (data) => {
      if (!this.playerService.isRetrying(data.screen) && !this.isShuttingDown) {
        await this.handleStreamEnd(data.screen);
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
    logger.info(`Stream on screen ${screen} ended, finding next stream...`);
    
    // Add a small delay to prevent rapid restarts
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Try to get next stream from current queue
    const nextStream = queueService.getNextStream(screen);
    if (nextStream) {
      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
      if (!screenConfig) {
        logger.error(`Invalid screen number: ${screen}`, 'StreamManager');
        return;
      }

      // Check if this stream is already playing on a higher priority screen
      const activeStreams = this.getActiveStreams();
      const isStreamActive = activeStreams.some(s => 
        s.url === nextStream.url && s.screen < screen
      );

      if (isStreamActive) {
        logger.info(
          `Stream ${nextStream.url} is already playing on a higher priority screen, skipping`,
          'StreamManager'
        );
        // Remove this stream from the queue and try the next one
        queueService.removeFromQueue(screen, 0);
        return this.handleStreamEnd(screen);
      }

      logger.info(`Starting next stream from queue: ${nextStream.url} on screen ${screen}`, 'StreamManager');
      
      // Remove the stream from the queue before starting it
      queueService.removeFromQueue(screen, 0);
      
      // Start the stream
      await this.startStream({
        url: nextStream.url,
        screen: screen,
        quality: screenConfig.quality || this.config.player.defaultQuality,
        windowMaximized: screenConfig.windowMaximized,
        volume: screenConfig.volume
      });
      
      // Mark the stream as watched
      queueService.markStreamAsWatched(nextStream.url);
      
      return;
    }

    // If no next stream, try to fetch new streams
    await this.handleEmptyQueue(screen);
  }

  private async handleEmptyQueue(screen: number) {
    try {
      // Validate screen number
      const screenConfig = this.config.player.screens.find(s => s.screen === screen);
      if (!screenConfig) {
        logger.error(`Invalid screen number: ${screen}. Available screens: ${this.config.player.screens.map(s => s.screen).join(', ')}`, 'StreamManager');
        return;
      }

      // Find the stream configuration for this screen
      const streamConfig = this.config.streams.find(s => s.screen === screen);
      if (!streamConfig) {
        logger.error(`No stream configuration found for screen ${screen}`, 'StreamManager');
        return;
      }

      if (!streamConfig.enabled) {
        logger.warn(`Stream configuration for screen ${screen} is disabled`, 'StreamManager');
        return;
      }

      logger.info(`Handling empty queue for screen ${screen}`, 'StreamManager');

      // Add a small delay to prevent rapid fetching
      await new Promise(resolve => setTimeout(resolve, 5000));
    
      logger.info(`Attempting to fetch new streams for screen ${screen}`, 'StreamManager');
      
      // Get new streams
      const streams = await this.getLiveStreams();
      logger.info(`Fetched ${streams.length} total streams`, 'StreamManager');
      
      const availableStreams = streams.filter(stream => {
        // Filter streams for this screen
        if (stream.screen !== screen) {
          logger.debug(`Stream ${stream.url} is assigned to screen ${stream.screen}, not ${screen}`, 'StreamManager');
          return false;
        }
        
        // Check if stream is already playing on another screen
        const activeStreams = this.getActiveStreams();
        const isPlaying = activeStreams.some(s => s.url === stream.url);
        if (isPlaying) {
          logger.debug(`Stream ${stream.url} is already playing on another screen`, 'StreamManager');
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
        // Sort by priority
        availableStreams.sort((a, b) => (a.priority || 999) - (b.priority || 999));
        
        // Filter unwatched streams
        const unwatchedStreams = queueService.filterUnwatchedStreams(availableStreams);
        
        logger.info(`Found ${unwatchedStreams.length} unwatched streams for screen ${screen}`, 'StreamManager');
        
        if (unwatchedStreams.length > 0) {
          const [firstStream, ...remainingStreams] = unwatchedStreams;
          
          logger.info(`Starting stream ${firstStream.url} on screen ${screen}`, 'StreamManager');
          
          // Start first stream
          await this.startStream({
            url: firstStream.url,
            screen: screen,
            quality: screenConfig.quality || this.config.player.defaultQuality,
            windowMaximized: screenConfig.windowMaximized,
            volume: screenConfig.volume
          });
          
          // Mark the stream as watched
          queueService.markStreamAsWatched(firstStream.url);

          // Queue remaining streams
          if (remainingStreams.length > 0) {
            queueService.setQueue(screen, remainingStreams);
            logger.info(
              `Queued ${remainingStreams.length} streams for screen ${screen}. ` +
              `First in queue: ${remainingStreams[0].url} (Priority: ${remainingStreams[0].priority || 999})`,
              'StreamManager'
            );
          }
        } else {
          logger.info(`No unwatched streams available for screen ${screen}`, 'StreamManager');
          queueService.clearQueue(screen);
        }
      } else {
        logger.info(`No available streams for screen ${screen}`, 'StreamManager');
        queueService.clearQueue(screen);
      }
    } catch (error) {
      logger.error(
        `Failed to handle empty queue for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
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

      // Cleanup process
      const process = stream.process;
      if (process?.pid) {
        // Double termination pattern
        process.kill('SIGINT');
        setTimeout(() => {
          if (!process.killed) {
            process.kill('SIGKILL');
          }
        }, 1000);
      }

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
            logger.debug(`Failed to remove FIFO file ${fifoPath}`, 'PlayerService');
          }
          this.fifoPaths.delete(screen);
        }
        this.ipcPaths.delete(screen);
      }, 2000);

      this.streams.delete(screen);
      logger.info(`Stream stopped on screen ${screen}${isManualStop ? ' (manual stop)' : ''}`, 'StreamManager');
      return true;
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
                  limit: limit * 2,
                  sort: 'start_scheduled'  // Sort by scheduled start time
                });
                logger.debug(
                  'Fetched %s favorite Holodex streams for screen %s',
                  String(streams.length),
                  String(screenNumber)
                );
              } else if (source.subtype === 'organization' && source.name) {
                streams = await this.holodexService.getLiveStreams({
                  organization: source.name,
                  limit,
                  sort: 'start_scheduled'  // Sort by scheduled start time
                });
              }

              // Additional sorting for Holodex streams
              streams.sort((a, b) => {
                // First by live status (live streams first)
                if (a.sourceStatus === 'live' && b.sourceStatus !== 'live') return -1;
                if (a.sourceStatus !== 'live' && b.sourceStatus === 'live') return 1;
                
                // Then by viewer count for live streams
                if (a.sourceStatus === 'live' && b.sourceStatus === 'live') {
                  return (b.viewerCount || 0) - (a.viewerCount || 0);
                }
                
                // Then by scheduled start time
                const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
                const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
                return aTime - bTime;
              });

            } else if (source.type === 'twitch') {
              if (source.subtype === 'favorites') {
                streams = await this.twitchService.getStreams({
                  channels: this.favoriteChannels.twitch,
                  limit,
                  sort: 'viewers'  // Sort by viewer count
                });
                // Ensure favorites are always at the top
                streams.forEach(s => s.priority = (source.priority || 999) - 1);
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
              }
            }

            // Add source metadata to each stream
            const streamsWithMetadata = streams.map(stream => ({
              ...stream,
              screen: screenNumber,
              sourceName: `${source.type}:${source.subtype || 'other'}`,
              priority: stream.priority || source.priority || 999
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
      results.sort((a, b) => {
        // First by priority
        const priorityDiff = (a.priority || 999) - (b.priority || 999);
        if (priorityDiff !== 0) return priorityDiff;

        // Then by viewer count
        return (b.viewerCount || 0) - (a.viewerCount || 0);
      });

      return results;
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
    
    // Stop any active streams
    await this.stopStream(screen, true);
    
    // Disable the screen in config
    streamConfig.enabled = false;
    logger.info(`Screen ${screen} disabled`, 'StreamManager');
  }

  async enableScreen(screen: number): Promise<void> {
    const streamConfig = this.config.player.screens.find(s => s.screen === screen);
    if (!streamConfig) {
      throw new Error(`Invalid screen number: ${screen}`);
    }
    
    streamConfig.enabled = true;
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
          const activeStream = this.getActiveStreams().find(s => s.screen === screen);
          if (!activeStream) {
            await this.handleEmptyQueue(screen);
          } else {
            // If there's an active stream, just update the queue without starting new stream
            const streams = await this.getLiveStreams();
            const availableStreams = streams.filter(s => s.screen === screen);
            if (availableStreams.length > 0) {
              const unwatchedStreams = queueService.filterUnwatchedStreams(availableStreams);
              if (unwatchedStreams.length > 0) {
                queueService.setQueue(screen, unwatchedStreams);
                logger.info(
                  `Updated queue for screen ${screen} with ${unwatchedStreams.length} streams`,
                  'StreamManager'
                );
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
const playerService = new PlayerService();

export const streamManager = new StreamManager(
  config,
  holodexService,
  twitchService,
  youtubeService,
  playerService
); 