import { EventEmitter } from 'events';
import { spawn, ChildProcess, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { HolodexApiClient } from 'holodex.js';
import { Config, StreamSource, StreamError, StreamResponse } from '../types/stream.js';
import { TwitchService } from './services/twitch.js';
import { HolodexService } from './services/holodex.js';
import { YouTubeService } from './services/youtube.js';
import { PlayerService } from './services/player.js';
import { logger } from './services/logger.js';
import { queueService } from './services/queue_service.js';

const execAsync = promisify(exec);

// Stream states - simplified from original state machine
enum StreamState {
  IDLE = 'idle',           // No stream running
  STARTING = 'starting',   // Stream is being started
  PLAYING = 'playing',     // Stream is running
  STOPPING = 'stopping',   // Stream is being stopped
  DISABLED = 'disabled',   // Screen is disabled
  ERROR = 'error',         // Error state
  NETWORK_RECOVERY = 'network_recovery' // Recovering from network issues
}

// Simple mutex for locking operations on screens
class SimpleMutex {
  private locked = false;
  private waitQueue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    return new Promise<() => void>(resolve => {
      this.waitQueue.push(() => {
        this.locked = true;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      if (next) next();
    } else {
      this.locked = false;
    }
  }
}

export class StreamManager extends EventEmitter {
  // Core dependencies
  private config: Config;
  private twitchService: TwitchService;
  private holodexService: HolodexService;
  private youtubeService: YouTubeService;
  private playerService: PlayerService;
  private isShuttingDown = false;
  private holodexClient: HolodexApiClient;

  // Active streams and their states
  private streams: Map<number, ChildProcess> = new Map();
  private screenStates: Map<number, StreamState> = new Map();
  private screenMutexes: Map<number, SimpleMutex> = new Map();
  
  // Stream management
  private queues: Map<number, StreamSource[]> = new Map();
  private isOffline = false;
  private cachedStreams: StreamSource[] = [];
  private lastStreamFetch: number = 0;
  private failedStreamAttempts: Map<string, { timestamp: number, count: number }> = new Map();
  
  // Constants
  private readonly MAX_STREAM_ATTEMPTS = 3;
  private readonly STREAM_FAILURE_RESET_TIME = 3600000; // 1 hour in ms
  private readonly STREAM_CACHE_TTL = 30000; // 30 seconds
  private readonly BUILD_DIR = path.join(process.cwd(), 'build');

  constructor(
    config: Config,
    holodexService: HolodexService,
    twitchService: TwitchService,
    youtubeService: YouTubeService,
    playerService: PlayerService
  ) {
    super();
    this.config = config;
    this.holodexService = holodexService;
    this.twitchService = twitchService;
    this.youtubeService = youtubeService;
    this.playerService = playerService;
    
    // Initialize screen states and mutexes
    this.initializeScreenStates();
    
    // Setup network recovery
    this.setupNetworkRecovery();
    
    // Initialize HolodexClient directly
    this.holodexClient = new HolodexApiClient({
      apiKey: config.holodex.apiKey
    });
    
    // Ensure build directory exists
    this.ensureBuildDirectory();
    
    logger.info('StreamManager initialized with direct Holodex integration', 'StreamManager');
  }
  
  private initializeScreenStates(): void {
    this.config.streams.forEach(streamConfig => {
      const screen = streamConfig.screen;
      const initialState = streamConfig.enabled ? StreamState.IDLE : StreamState.DISABLED;
      this.screenStates.set(screen, initialState);
      this.screenMutexes.set(screen, new SimpleMutex());
    });
    logger.info('Screen states initialized', 'StreamManager');
  }
  
  private ensureBuildDirectory(): void {
    if (!fs.existsSync(this.BUILD_DIR)) {
      fs.mkdirSync(this.BUILD_DIR, { recursive: true });
    }
    logger.info(`Build directory ensured at ${this.BUILD_DIR}`, 'StreamManager');
  }
  
  private setupNetworkRecovery(): void {
    queueService.networkEmitter.on('offline', () => {
      logger.warn('Network connection lost, pausing stream operations', 'StreamManager');
      this.isOffline = true;
    });

    queueService.networkEmitter.on('online', async () => {
      if (!this.isOffline) return;
      
      logger.info('Network connection restored, resuming stream operations', 'StreamManager');
      this.isOffline = false;
      
      try {
        // Force refresh streams
        this.lastStreamFetch = 0;
        await this.forceQueueRefresh();
        
        logger.info('Stream queues refreshed after network recovery', 'StreamManager');
      } catch (error) {
        logger.error(
          'Failed to handle network recovery',
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });
  }

  // Direct fetch from Holodex using client (similar to your script)
  async fetchHolodexStreams(vtuberType = 0, limit = 50): Promise<StreamSource[]> {
    try {
      logger.info(`Fetching Holodex streams with type ${vtuberType} and limit ${limit}`, 'StreamManager');
      
      // Favorite channels (matching your approach)
      const favoriteChannels = this.getFlattenedFavorites('holodex');
      const favorites: StreamSource[] = [];
      
      // Fetch streams for favorite channels
      for (const channelId of favoriteChannels) {
        try {
          const channelVideos = await this.holodexClient.getLiveVideos({ 
            channel_id: channelId,
            status: 'live',
            limit: 1
          });
          
          if (channelVideos && channelVideos.length > 0) {
            for (const video of channelVideos) {
              favorites.push({
                url: `https://youtube.com/watch?v=${video.videoId}`,
                title: video.title,
                platform: 'youtube',
                viewerCount: video.liveViewers,
                startTime: video.actualStart ? new Date(video.actualStart).getTime() : Date.now(),
                sourceStatus: 'live',
                channelId: video.channel?.channelId,
                organization: video.channel?.organization,
                subtype: 'favorites',
                priority: 0  // Higher priority for favorites
              });
            }
          }
        } catch (error) {
          logger.error(
            `Failed to fetch streams for favorite channel ${channelId}`,
            'StreamManager',
            error instanceof Error ? error : new Error(String(error))
          );
        }
      }
      
      // Fetch live streams by organization
      let hololiveStreams: StreamSource[] = [];
      let nijisanjiStreams: StreamSource[] = [];
      let independentStreams: StreamSource[] = [];
      
      try {
        // Fetch Hololive streams
        const hololiveVideos = await this.holodexClient.getLiveVideos({ 
          org: 'Hololive', 
          status: 'live',
          limit
        });
        
        hololiveStreams = hololiveVideos.map(video => ({
          url: `https://youtube.com/watch?v=${video.videoId}`,
          title: video.title,
          platform: 'youtube',
          viewerCount: video.liveViewers,
          startTime: video.actualStart ? new Date(video.actualStart).getTime() : Date.now(),
          sourceStatus: 'live',
          channelId: video.channel?.channelId,
          organization: 'Hololive',
          priority: 1
        }));
      } catch (error) {
        logger.error(
          'Failed to fetch Hololive streams',
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
      
      try {
        // Fetch Nijisanji streams
        const nijisanjiVideos = await this.holodexClient.getLiveVideos({ 
          org: 'Nijisanji', 
          status: 'live',
          limit
        });
        
        nijisanjiStreams = nijisanjiVideos.map(video => ({
          url: `https://youtube.com/watch?v=${video.videoId}`,
          title: video.title,
          platform: 'youtube',
          viewerCount: video.liveViewers,
          startTime: video.actualStart ? new Date(video.actualStart).getTime() : Date.now(),
          sourceStatus: 'live',
          channelId: video.channel?.channelId,
          organization: 'Nijisanji',
          priority: 2
        }));
      } catch (error) {
        logger.error(
          'Failed to fetch Nijisanji streams',
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
      
      try {
        // Fetch independent VTubers
        const independentVideos = await this.holodexClient.getLiveVideos({ 
          org: 'Independents', 
          status: 'live',
          limit: 8
        });
        
        independentStreams = independentVideos.map(video => ({
          url: `https://youtube.com/watch?v=${video.videoId}`,
          title: video.title,
          platform: 'youtube',
          viewerCount: video.liveViewers,
          startTime: video.actualStart ? new Date(video.actualStart).getTime() : Date.now(),
          sourceStatus: 'live',
          channelId: video.channel?.channelId,
          organization: 'Independents',
          priority: 3
        }));
      } catch (error) {
        logger.error(
          'Failed to fetch independent streams',
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
      }
      
      // Similar to your vt selection logic
      let combinedStreams: StreamSource[] = [];
      
      // Combine streams based on type
      switch(vtuberType) {
        case 0:
          combinedStreams = [...favorites, ...hololiveStreams, ...nijisanjiStreams, ...independentStreams];
          break;
        case 1:
          combinedStreams = [...hololiveStreams, ...favorites, ...nijisanjiStreams, ...independentStreams];
          break;
        case 2:
          combinedStreams = [...favorites, ...independentStreams, ...nijisanjiStreams, ...hololiveStreams];
          break;
        case 3:
          combinedStreams = [...nijisanjiStreams, ...favorites, ...hololiveStreams, ...independentStreams];
          break;
        default:
          combinedStreams = [...favorites, ...hololiveStreams, ...nijisanjiStreams, ...independentStreams];
      }
      
      // Filter out streams based on filters (like your script)
      const filters = this.config.filters?.filters || [];
      const filteredStreams = combinedStreams.filter(stream => {
        const channelName = stream.channelId?.toLowerCase().replace(/\s/g, '');
        if (!channelName) return true;
        
        // Don't filter favorites
        if (stream.subtype === 'favorites') return true;
        
        // Check against filters
        for (const filter of filters) {
          const filterValue = typeof filter === 'string' ? filter.toLowerCase() : filter.value.toLowerCase();
          if (channelName.includes(filterValue)) {
            logger.debug(`Filtering out stream from channel ${channelName} due to filter "${filterValue}"`, 'StreamManager');
            return false;
          }
        }
        return true;
      });
      
      logger.info(`Found ${filteredStreams.length} Holodex streams after filtering`, 'StreamManager');
      return filteredStreams;
    } catch (error) {
      logger.error(
        'Failed to fetch Holodex streams',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      return [];
    }
  }
  
  // Get flattened favorites (similar to your approach)
  private getFlattenedFavorites(platform: 'holodex' | 'twitch' | 'youtube'): string[] {
    const flattened: string[] = [];
    const platformFavorites = this.config.favoriteChannels[platform];
    
    if (platformFavorites) {
      Object.values(platformFavorites).forEach(channels => {
        if (Array.isArray(channels)) {
          flattened.push(...channels);
        }
      });
    }
    
    return flattened;
  }
  
  // Direct stream starting using streamlink (inspired by your script)
  async startStreamWithStreamlink(url: string, screen: number, quality: string = 'best'): Promise<boolean> {
    return this.withLock(screen, 'startStream', async () => {
      try {
        // Check if screen is already playing
        if (this.screenStates.get(screen) === StreamState.PLAYING) {
          logger.warn(`Screen ${screen} is already playing, stopping current stream`, 'StreamManager');
          await this.stopStream(screen);
        }
        
        // Set state to starting
        this.screenStates.set(screen, StreamState.STARTING);
        logger.info(`Starting stream on screen ${screen} with URL: ${url} and quality: ${quality}`, 'StreamManager');
        
        // Get screen configuration
        const screenConfig = this.config.streams.find(s => s.screen === screen);
        if (!screenConfig) {
          throw new Error(`No configuration found for screen ${screen}`);
        }
        
        // Prepare streamlink command
        const streamlinkArgs = [
          `--player-args="--fs-screen=${screen} --no-border --keep-open=no --cache=yes --demuxer-max-bytes=250M"`,
          url,
          quality
        ];
        
        // Start streamlink process
        const process = spawn('streamlink', streamlinkArgs, {
          stdio: 'pipe',
          detached: true
        });
        
        // Store the process
        this.streams.set(screen, process);
        
        // Handle process output
        if (process.stdout) {
          process.stdout.on('data', (data: Buffer) => {
            const output = data.toString();
            logger.debug(`Streamlink stdout (screen ${screen}): ${output.trim()}`, 'StreamManager');
          });
        }
        
        if (process.stderr) {
          process.stderr.on('data', (data: Buffer) => {
            const output = data.toString();
            logger.debug(`Streamlink stderr (screen ${screen}): ${output.trim()}`, 'StreamManager');
          });
        }
        
        // Handle process exit
        process.on('exit', (code) => {
          logger.info(`Streamlink process for screen ${screen} exited with code ${code}`, 'StreamManager');
          this.handleStreamEnd(screen, url, code);
        });
        
        // Set state to playing
        this.screenStates.set(screen, StreamState.PLAYING);
        logger.info(`Stream started on screen ${screen}`, 'StreamManager');
        
        return true;
      } catch (error) {
        logger.error(
          `Failed to start stream on screen ${screen}`,
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
        
        // Set state to error
        this.screenStates.set(screen, StreamState.ERROR);
        return false;
      }
    });
  }
  
  // Handle stream end
  private handleStreamEnd(screen: number, url: string, code: number | null): void {
    // Remove from active streams
    this.streams.delete(screen);
    
    // Set state to idle
    this.screenStates.set(screen, StreamState.IDLE);
    
    // Emit error event for client notification
    this.emit('streamError', {
      screen: screen.toString(),
      url,
      error: code === 0 ? 'Stream ended' : `Stream error (code ${code})`
    });
    
    // Automatically start next stream if queue exists
    this.handleQueueEmpty(screen).catch(error => {
      logger.error(
        `Failed to handle stream end for screen ${screen}`,
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    });
  }
  
  // Stop a stream
  async stopStream(screen: number): Promise<boolean> {
    return this.withLock(screen, 'stopStream', async () => {
      const currentState = this.screenStates.get(screen);
      
      if (currentState !== StreamState.PLAYING && currentState !== StreamState.ERROR) {
        logger.warn(`Cannot stop stream on screen ${screen} in state ${currentState}`, 'StreamManager');
        return false;
      }
      
      // Set state to stopping
      this.screenStates.set(screen, StreamState.STOPPING);
      
      try {
        // Get process
        const process = this.streams.get(screen);
        
        if (process) {
          // Kill process and children
          if (process.pid) {
            try {
              await execAsync(`pkill -P ${process.pid}`);
            } catch (error) {
              // Ignore errors
            }
            
            try {
              process.kill();
            } catch (error) {
              // Ignore errors
            }
          }
          
          // Remove from active streams
          this.streams.delete(screen);
        }
        
        // Set state to idle
        this.screenStates.set(screen, StreamState.IDLE);
        logger.info(`Stream stopped on screen ${screen}`, 'StreamManager');
        
        return true;
      } catch (error) {
        logger.error(
          `Failed to stop stream on screen ${screen}`,
          'StreamManager',
          error instanceof Error ? error : new Error(String(error))
        );
        
        // Force set state to idle
        this.screenStates.set(screen, StreamState.IDLE);
        this.streams.delete(screen);
        
        return false;
      }
    });
  }
  
  // Helper to execute operations with a lock
  private async withLock<T>(screen: number, operation: string, callback: () => Promise<T>): Promise<T> {
    let mutex = this.screenMutexes.get(screen);
    
    if (!mutex) {
      mutex = new SimpleMutex();
      this.screenMutexes.set(screen, mutex);
    }
    
    const release = await mutex.acquire();
    
    try {
      logger.debug(`Acquired lock for ${operation} on screen ${screen}`, 'StreamManager');
      return await callback();
    } finally {
      release();
      logger.debug(`Released lock for ${operation} on screen ${screen}`, 'StreamManager');
    }
  }
  
  // Handle empty queue
  public async handleQueueEmpty(screen: number): Promise<void> {
    const queue = this.queues.get(screen) || [];
    
    if (queue.length > 0) {
      // Start next stream
      const nextStream = queue[0];
      queue.shift();
      this.queues.set(screen, queue);
      
      await this.startStreamWithStreamlink(nextStream.url, screen, 'best');
    } else {
      // If no streams in queue, try to get fresh streams
      const streams = await this.fetchHolodexStreams(0, 50);
      
      if (streams.length > 0) {
        // Assign stream to screen
        const nextStream = streams[0];
        await this.startStreamWithStreamlink(nextStream.url, screen, 'best');
      }
    }
  }
  
  // Refresh all queues
  public async forceQueueRefresh(): Promise<void> {
    logger.info('Force refreshing all queues', 'StreamManager');
    
    try {
      // Force new fetch
      this.lastStreamFetch = 0;
      const streams = await this.fetchHolodexStreams(0, 50);
      
      // Write to files for compatibility with existing system
      const urls = streams.map(s => s.url);
      const titles = streams.map(s => s.title || 'No title');
      
      fs.writeFileSync(path.join(this.BUILD_DIR, 'yt.txt'), urls.join('\n'));
      fs.writeFileSync(path.join(this.BUILD_DIR, 'titles.txt'), titles.join('\n'));
      
      // Update queues
      this.updateScreenQueues(streams);
      
      logger.info(`Queues refreshed with ${streams.length} streams`, 'StreamManager');
    } catch (error) {
      logger.error(
        'Failed to refresh queues',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
  
  // Update screen queues
  private updateScreenQueues(streams: StreamSource[]): void {
    // Get enabled screens
    const enabledScreens = this.config.streams
      .filter(s => s.enabled)
      .map(s => s.screen);
    
    // Reset queues
    for (const screen of enabledScreens) {
      // Filter streams for this screen based on its config
      const screenConfig = this.config.streams.find(s => s.screen === screen);
      
      if (!screenConfig) continue;
      
      // Apply screen-specific filtering
      let screenStreams = streams;
      
      // Filter by source type if specified
      if (screenConfig.sources && screenConfig.sources.length > 0) {
        const enabledSources = screenConfig.sources.filter(s => s.enabled);
        
        if (enabledSources.length > 0) {
          screenStreams = streams.filter(stream => {
            // Check if stream matches any enabled source
            return enabledSources.some(source => {
              if (source.type === 'holodex' && stream.platform === 'youtube') {
                // Match by organization
                if (source.subtype === 'organization' && source.name === stream.organization) {
                  return true;
                }
                
                // Match favorites
                if (source.subtype === 'favorites' && stream.subtype === 'favorites') {
                  return true;
                }
              }
              
              return false;
            });
          });
        }
      }
      
      // Sort by view count or start time
      if (screenConfig.sorting) {
        const { field, order } = screenConfig.sorting;
        
        screenStreams.sort((a, b) => {
          if (field === 'viewerCount') {
            const aViewers = a.viewerCount || 0;
            const bViewers = b.viewerCount || 0;
            return order === 'desc' ? bViewers - aViewers : aViewers - bViewers;
          } else if (field === 'startTime') {
            const aTime = a.startTime || 0;
            const bTime = b.startTime || 0;
            return order === 'desc' ? bTime - aTime : aTime - bTime;
          }
          return 0;
        });
      }
      
      // Apply limit
      const limit = screenConfig.sources?.reduce((acc, s) => acc + (s.limit || 0), 0) || 50;
      screenStreams = screenStreams.slice(0, limit);
      
      // Set queue
      this.queues.set(screen, screenStreams);
      logger.info(`Updated queue for screen ${screen}: ${screenStreams.length} streams`, 'StreamManager');
    }
  }
  
  // Direct play method (closest to your script)
  public async directPlay(vtuberType: number = 0, limit: number = 50, screen: number = 1, quality: string = 'best', specificUrl?: string): Promise<boolean> {
    try {
      logger.info(`Direct play request with type=${vtuberType}, limit=${limit}, screen=${screen}, quality=${quality}`, 'StreamManager');
      
      // Use specific URL if provided
      if (specificUrl) {
        return await this.startStreamWithStreamlink(specificUrl, screen, quality);
      }
      
      // Otherwise fetch streams
      const streams = await this.fetchHolodexStreams(vtuberType, limit);
      
      if (streams.length === 0) {
        logger.warn('No streams found for direct play', 'StreamManager');
        return false;
      }
      
      // Start first stream
      return await this.startStreamWithStreamlink(streams[0].url, screen, quality);
    } catch (error) {
      logger.error(
        'Failed to direct play',
        'StreamManager',
        error instanceof Error ? error : new Error(String(error))
      );
      return false;
    }
  }
  
  // Cleanup method for shutdown
  public async cleanup(): Promise<void> {
    this.isShuttingDown = true;
    logger.info('Cleaning up StreamManager resources', 'StreamManager');
    
    // Stop all streams
    const screens = [...this.streams.keys()];
    
    // Use Promise.allSettled to ensure we try to stop all streams
    await Promise.allSettled(
      screens.map(screen => this.stopStream(screen))
    );
    
    logger.info('All streams stopped during cleanup', 'StreamManager');
  }
  
  // Get active streams
  public getActiveStreams() {
    return this.playerService.getActiveStreams();
  }
}

// Create singleton instance
const config = {
  // Import your actual config - this is just a placeholder
};

export const streamManager = (() => {
  try {
    // Import dynamically
    const { loadAllConfigs } = require('../config/loader.js');
    const { env } = require('../config/env.js');
    
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
    
    return new StreamManager(
      config,
      holodexService,
      twitchService,
      youtubeService,
      playerService
    );
  } catch (error) {
    console.error('Failed to initialize StreamManager:', error);
    throw error;
  }
})();
