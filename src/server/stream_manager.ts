import type { 
  StreamSource, 
  StreamOptions,
  PlayerSettings,
  Config,
  StreamConfig,
  FavoriteChannels,
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
import { queueService } from './services/queue_service.js';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

/**
 * Manages multiple video streams across different screens
 */
export class StreamManager extends EventEmitter {
  private streams: Map<number, StreamInstance> = new Map();
  private config: Config;
  private twitchService: TwitchService;
  private holodexService: HolodexService;
  private playerService: PlayerService;
  private cleanupHandler: (() => void) | null = null;
  private isShuttingDown = false;
  private favoriteChannels: FavoriteChannels = {
    holodex: [],
    twitch: [],
    youtube: []
  };
  private queues: Map<number, StreamSource[]> = new Map();
  private readonly RETRY_INTERVAL = 5000; // 5 seconds
  private errorCallback?: (data: StreamError) => void;

  /**
   * Creates a new StreamManager instance
   */
  constructor(
    config: Config,
    holodexService: HolodexService,
    twitchService: TwitchService,
    playerService: PlayerService
  ) {
    super(); // Initialize EventEmitter
    this.config = config;
    this.holodexService = holodexService;
    this.twitchService = twitchService;
    this.playerService = playerService;
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
    try {
      // Validate screen number
      const screenConfig = this.config.player.screens.find(s => s.id === screen);
      if (!screenConfig) {
        logger.error(`Invalid screen number: ${screen}`, 'StreamManager');
        return;
      }

      logger.info(`Attempting to fetch new streams for screen ${screen}`, 'StreamManager');
      // Emit event to trigger stream manager to fetch new streams
      this.errorCallback?.({
        screen,
        error: 'Fetching new streams',
        code: -1
      });
    } catch (error) {
      logger.error(
        'Failed to handle empty queue', 
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      // Retry after interval
      setTimeout(() => {
        this.handleEmptyQueue(screen);
      }, this.RETRY_INTERVAL);
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

    const streamConfig = this.config.player.screens.find(s => s.id === screen);
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
      for (const streamConfig of this.config.player.screens) {
        const screenNumber = streamConfig.id;
        if (!streamConfig.enabled) {
          logger.debug('Screen %s is disabled, skipping', String(screenNumber));
          continue;
        }

        // Initialize seen URLs set for this screen
        seenUrlsByScreen.set(screenNumber, new Set<string>());
        logger.debug('Processing sources for screen %s', String(screenNumber));

        // Sort sources by priority before processing
        const sortedSources = [...streamConfig.sources]
          .filter(source => source.enabled)
          .sort((a, b) => (a.priority || 999) - (b.priority || 999));

        const sourceList = sortedSources
          .map(s => `${s.type}${s.subtype ? `:${s.subtype}` : ''} (priority: ${s.priority})`)
          .join(', ');
        logger.debug('Enabled sources for screen %s: %s', String(screenNumber), sourceList);

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
                String(streams.length), String(screenNumber));
            } else if (source.subtype === 'organization' && source.name) {
              if (results.some(s => s.screen === screenNumber && s.sourceName?.includes('favorites'))) {
                logger.debug('Skipping %s streams as we already have favorite streams for screen %s', 
                  source.name, String(screenNumber));
                continue;
              }
              logger.debug('Fetching %s %s streams', String(limit), source.name);
              streams.push(...await this.holodexService.getLiveStreams({
                organization: source.name,
                limit: limit * 2 // Increase limit to get more streams
              }));
              logger.debug('Fetched %s %s streams for screen %s', 
                String(streams.length), source.name, String(screenNumber));
            }
          } else if (source.type === 'twitch') {
            if (source.subtype === 'favorites') {
              const favoriteStreams = await this.twitchService.getStreams({
                limit: limit * 2 // Increase limit to get more streams
              }, this.favoriteChannels.twitch);
              favoriteStreams.reverse();
              streams.push(...favoriteStreams);
              logger.debug('Fetched %s favorite Twitch streams for screen %s', 
                String(streams.length), String(screenNumber));
            } else if (source.tags) {
              if (results.some(s => s.screen === screenNumber && s.sourceName?.includes('favorites'))) {
                logger.debug('Skipping tagged Twitch streams as we already have favorite streams for screen %s', 
                  String(screenNumber));
                continue;
              }
              streams.push(...await this.twitchService.getStreams({
                limit: limit * 2, // Increase limit to get more streams
                tags: source.tags
              }));
              logger.debug('Fetched %s tagged Twitch streams for screen %s', 
                String(streams.length), String(screenNumber));
            }
          }

          // Filter out duplicate streams only within the same screen
          if (streams.length > 0) {
            logger.debug('Adding %s streams from %s%s to screen %s', 
              String(streams.length), 
              source.type,
              source.subtype ? `:${source.subtype}` : '',
              String(screenNumber)
            );

            const seenUrls = seenUrlsByScreen.get(screenNumber)!;
            streams
              .filter(stream => !seenUrls.has(stream.url)) // Only filter duplicates within same screen
              .forEach(stream => {
                seenUrls.add(stream.url); // Mark as seen for this screen
                results.push({
                  ...stream,
                  screen: screenNumber,
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
                String(streams.length), String(screenNumber));
              break;
            }
          }
        }

        // After collecting all streams for a screen, sort them according to config
        const screenResults = results.filter(s => s.screen === screenNumber);
        logger.info('Total streams found for screen %s: %s', 
          String(screenNumber), String(screenResults.length));

        if (screenResults.length > 0) {
          logger.info('First stream for screen %s: %s (Priority: %s)', 
            String(screenNumber), 
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
        const screenConfig = this.config.player.screens.find(s => s.id === screen);
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

  async disableScreen(screen: number): Promise<void> {
    const streamConfig = this.config.player.screens.find(s => s.id === screen);
    if (!streamConfig) {
      throw new Error(`Invalid screen number: ${screen}`);
    }
    
    // Stop any active streams
    await this.stopStream(screen);
    
    // Disable the screen in config
    streamConfig.enabled = false;
    logger.info(`Screen ${screen} disabled`, 'StreamManager');
  }

  async enableScreen(screen: number): Promise<void> {
    const streamConfig = this.config.player.screens.find(s => s.id === screen);
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

  async restartStreams(screen?: number): Promise<void> {
    if (screen) {
      // Restart specific screen
      await this.stopStream(screen);
      await this.handleEmptyQueue(screen);
    } else {
      // Restart all screens
      const activeScreens = Array.from(this.streams.keys());
      for (const screenId of activeScreens) {
        await this.stopStream(screenId);
        await this.handleEmptyQueue(screenId);
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

  getWatchedStreams(): string[] {
    return queueService.getWatchedStreams();
  }

  clearWatchedStreams(): void {
    queueService.clearWatchedStreams();
    logger.info('Cleared watched streams history', 'StreamManager');
  }

  cleanup() {
    if (this.cleanupHandler) {
      this.cleanupHandler();
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
    Object.assign(this.config.player, settings);
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
    return this.config.player.screens.find(s => s.id === screen);
  }

  public updateScreenConfig(screen: number, config: Partial<StreamConfig>): void {
    const screenConfig = this.getScreenConfig(screen);
    if (!screenConfig) {
      throw new Error(`Screen ${screen} not found`);
    }
    Object.assign(screenConfig, config);
    this.emit('screenUpdate', screen, screenConfig);
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
    
    // Save to file
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
      this.queues.set(screen.id, []);
    });
  }
}

// Create singleton instance
const config = loadAllConfigs();
const holodexService = new HolodexService(
  env.HOLODEX_API_KEY,
  config.filters?.filters || [],
  config.favoriteChannels.holodex,
  config
);
const twitchService = new TwitchService(
  env.TWITCH_CLIENT_ID,
  env.TWITCH_CLIENT_SECRET,
  config.filters?.filters || []
);
const playerService = new PlayerService();

export const streamManager = new StreamManager(
  config,
  holodexService,
  twitchService,
  playerService
); 