import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { 
  StreamOptions, 
  StreamSource 
} from '../../types/stream.js';
import type { 
  StreamInstance, 
  StreamOutput, 
  StreamError,
  StreamResponse
} from '../../types/stream_instance.js';
import { logger } from './logger.js';
import { loadAllConfigs } from '../../config/loader.js';
import { exec } from 'child_process';

export class PlayerService {
  private streams: Map<number, StreamInstance> = new Map();
  private streamQueues: Map<number, string[]> = new Map(); // Queue of stream URLs for each screen
  private events: EventEmitter;
  private outputCallback?: (data: StreamOutput) => void;
  private errorCallback?: (data: StreamError) => void;
  private config = loadAllConfigs();
  private streamRetries: Map<number, number> = new Map();
  private watchedStreams: Set<string> = new Set();
  private readonly MAX_RETRIES = 3;

  constructor() {
    this.events = new EventEmitter();
    // Initialize empty queues for each screen
    this.config.player.screens.forEach(screen => {
      this.streamQueues.set(screen.id, []);
    });
    
    // Check if mpv is installed
    exec('which mpv', (error, stdout, stderr) => {
      if (error) {
        logger.error('MPV is not installed or not in PATH', 'PlayerService', error);
        return;
      }
      logger.debug(`MPV found at: ${stdout.trim()}`, 'PlayerService');
    });
  }

  // Add streams to a screen's queue
  setStreamQueue(screen: number, streams: StreamSource[]) {
    const urls = streams.map(s => s.url);
    this.streamQueues.set(screen, urls);
    logger.debug(`Set stream queue for screen ${screen}: ${urls.join(', ')}`, 'PlayerService');
  }

  // Get the next unwatched stream for a screen
  private getNextStream(screen: number): string | null {
    const queue = this.streamQueues.get(screen) || [];
    logger.debug(`Getting next stream from queue for screen ${screen}. Queue length: ${queue.length}`, 'PlayerService');
    
    while (queue.length > 0) {
      const nextStream = queue[0];
      if (!this.watchedStreams.has(nextStream)) {
        queue.shift(); // Remove the stream we're about to use
        logger.debug(`Found unwatched stream for screen ${screen}: ${nextStream}`, 'PlayerService');
        return nextStream;
      }
      queue.shift(); // Remove watched stream
      logger.debug(`Skipping watched stream: ${nextStream}`, 'PlayerService');
    }
    
    logger.debug(`No unwatched streams left in queue for screen ${screen}`, 'PlayerService');
    return null;
  }

  async startStream(options: StreamOptions & { screen: number }): Promise<StreamResponse> {
    try {
      // If no URL is provided, get next unwatched stream from queue
      if (!options.url) {
        const nextStream = this.getNextStream(options.screen);
        if (!nextStream) {
          logger.info(`No unwatched streams left for screen ${options.screen}`, 'PlayerService');
          return {
            screen: options.screen,
            message: 'No unwatched streams available',
            error: 'NO_STREAMS'
          };
        }
        options.url = nextStream;
      }

      // Check if stream was already watched
      if (this.watchedStreams.has(options.url)) {
        logger.info(`Stream ${options.url} was already watched, trying next stream`, 'PlayerService');
        const nextStream = this.getNextStream(options.screen);
        if (!nextStream) {
          return {
            screen: options.screen,
            message: 'All streams have been watched',
            error: 'ALL_WATCHED'
          };
        }
        options.url = nextStream;
      }

      // Add to watched streams
      this.watchedStreams.add(options.url);

      // Reset retry counter when starting a new stream intentionally
      if (!this.streamRetries.has(options.screen)) {
        this.streamRetries.set(options.screen, 0);
      }

      const screenConfig = this.config.player.screens.find(s => s.id === options.screen);
      if (!screenConfig) {
        logger.error(`No screen config found for screen ${options.screen}`, 'PlayerService');
        throw new Error(`Invalid screen configuration for screen ${options.screen}`);
      }

      logger.debug(`Screen config: ${JSON.stringify(screenConfig)}`, 'PlayerService');

      // Determine if we should use streamlink
      const isTwitchStream = options.url.includes('twitch.tv');
      const useStreamlink = this.config.player.preferStreamlink || isTwitchStream;

      let command = 'mpv';
      let args: string[] = [];

      if (useStreamlink) {
        command = 'streamlink';
        args = [
          options.url,
          options.quality || this.config.player.defaultQuality,
          '--player', 'mpv',
          '--player-args',
          `--volume=${options.volume || this.config.player.defaultVolume} --geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y} --keep-open=yes --no-terminal --msg-level=all=debug`,
          '--verbose-player',
          '--stream-sorting-excludes', '>1080p,<480p',
          '--twitch-disable-hosting',
          '--twitch-disable-ads',
          '--retry-open', '3',
          '--retry-streams', '5',
          '--stream-timeout', '120',
          '--player-no-close'
        ];
      } else {
        args = [
          options.url,
          '--msg-level=all=debug',
          `--volume=${options.volume || this.config.player.defaultVolume}`,
          `--geometry=${screenConfig.width}x${screenConfig.height}+${screenConfig.x}+${screenConfig.y}`,
          '--keep-open=yes',
          '--no-terminal',
          '--force-window=yes'
        ];
      }

      logger.debug(`Starting ${command} with args: ${args.join(' ')}`, 'PlayerService');

      const process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        detached: true
      });

      // Handle process output
      process.stdout.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          logger.debug(`[${command}-${options.screen}-stdout] ${output}`, 'PlayerService');
          this.outputCallback?.({
            screen: options.screen,
            data: output,
            type: 'stdout'
          });
        }
      });

      process.stderr.on('data', (data) => {
        const output = data.toString().trim();
        if (output) {
          logger.debug(`[${command}-${options.screen}-stderr] ${output}`, 'PlayerService');
          this.errorCallback?.({
            screen: options.screen,
            error: output
          });
        }
      });

      process.on('error', (error) => {
        logger.error(`[${command}-${options.screen}-error] ${error.message}`, 'PlayerService', error);
        this.errorCallback?.({
          screen: options.screen,
          error: error.message
        });
      });

      // Handle process exit
      process.on('exit', (code) => {
        logger.info(`[${command}-${options.screen}-exit] Process exited with code ${code}`, 'PlayerService');
        
        if (code === 0 || code === null) {
          // Normal exit - try to start next stream
          const nextStream = this.getNextStream(options.screen);
          if (nextStream) {
            logger.info(`Starting next stream on screen ${options.screen}: ${nextStream}`, 'PlayerService');
            setTimeout(() => {
              this.startStream({
                ...options,
                url: nextStream
              });
            }, 1000); // Small delay before starting next stream
          } else {
            logger.info(`No more unwatched streams for screen ${options.screen}`, 'PlayerService');
            if (this.errorCallback) {
              this.errorCallback({
                screen: options.screen,
                error: 'All streams watched',
                code: 0
              });
            }
          }
          this.streamRetries.delete(options.screen);
        } else {
          // Abnormal exit - handle retries
          const retryCount = (this.streamRetries.get(options.screen) || 0) + 1;
          if (retryCount <= this.MAX_RETRIES) {
            logger.info(`Retrying stream on screen ${options.screen} (attempt ${retryCount})`, 'PlayerService');
            this.streamRetries.set(options.screen, retryCount);
            setTimeout(() => {
              this.startStream(options);
            }, 1000);
          } else {
            logger.warn(`Max retries reached for screen ${options.screen}, trying next stream`, 'PlayerService');
            this.streamRetries.delete(options.screen);
            const nextStream = this.getNextStream(options.screen);
            if (nextStream) {
              this.startStream({
                ...options,
                url: nextStream
              });
            }
          }
        }
        
        this.streams.delete(options.screen);
      });

      const instance: StreamInstance = {
        id: options.screen,
        screen: options.screen,
        url: options.url,
        quality: options.quality || 'best',
        process: process as unknown as NodeJS.Process,
        platform: options.url.includes('youtube.com') ? 'youtube' : 'twitch'
      };

      this.streams.set(options.screen, instance);
      logger.info(`Stream started on screen ${options.screen}`, 'PlayerService');
      
      return {
        screen: options.screen,
        message: `Stream started on screen ${options.screen}`
      };

    } catch (error) {
      logger.error(
        'Failed to start stream',
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      return {
        screen: options.screen,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async stopStream(screen: number): Promise<boolean> {
    try {
      const stream = this.streams.get(screen);
      if (!stream) return false;

      const process = stream.process as unknown as ChildProcess;
      process.kill('SIGTERM');
      this.streams.delete(screen);
      logger.info(`Stream stopped on screen ${screen}`, 'PlayerService');
      return true;
    } catch (error) {
      logger.error(
        'Failed to stop stream',
        'PlayerService',
        error instanceof Error ? error : new Error(String(error))
      );
      return false;
    }
  }

  getActiveStreams() {
    return Array.from(this.streams.entries()).map(([screen, stream]) => ({
      screen,
      url: stream.url,
      quality: stream.quality,
      platform: stream.platform
    }));
  }

  onStreamOutput(callback: (data: StreamOutput) => void) {
    this.outputCallback = callback;
  }

  onStreamError(callback: (data: StreamError) => void) {
    this.errorCallback = callback;
  }

  isRetrying(screen: number): boolean {
    return this.streamRetries.has(screen);
  }

  resetRetries(screen: number): void {
    this.streamRetries.delete(screen);
  }

  clearWatchedStreams() {
    this.watchedStreams.clear();
    logger.info('Cleared watched streams history', 'PlayerService');
  }

  isStreamWatched(url: string): boolean {
    return this.watchedStreams.has(url);
  }

  getWatchedStreams(): string[] {
    return Array.from(this.watchedStreams);
  }

  // Get the current queue for a screen
  getStreamQueue(screen: number): string[] {
    return this.streamQueues.get(screen) || [];
  }

  // Clear the queue for a screen
  clearStreamQueue(screen: number) {
    this.streamQueues.set(screen, []);
    logger.info(`Cleared stream queue for screen ${screen}`, 'PlayerService');
  }

  // Clear all queues
  clearAllQueues() {
    this.streamQueues.clear();
    this.config.player.screens.forEach(screen => {
      this.streamQueues.set(screen.id, []);
    });
    logger.info('Cleared all stream queues', 'PlayerService');
  }
} 